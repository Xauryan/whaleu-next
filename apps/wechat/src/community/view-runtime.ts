import { ClientError, clientError } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import { Cancellation, type Clock } from '../platform/contracts';
import { decodeViewEpoch, VIEW_RETRY_MS, type ViewKind } from './view-contract';
import type { ViewGateway } from './view-gateway';
import type { ViewObservationSink } from './view-observer';
import { PendingViewStore } from './view-pending';

/** Best-effort bounded analytics; no error escapes into page rendering or app lifecycle. */
export class ViewRuntime implements ViewObservationSink {
  private visible = false;
  private generation = 0;
  private owner: SessionTicket;
  private synchronized = false;
  private retryEpochAt = 0;
  private authPaused = false;
  private flight:
    { cancellation: Cancellation; promise: Promise<void> } | undefined;
  private stopTimer: (() => void) | undefined;
  private stopCleanup: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: ViewGateway,
    readonly pending: PendingViewStore,
    private readonly newRequestId: () => Promise<string>,
    private readonly clock: Clock,
  ) {
    this.owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const current = sessions.snapshot();
      if (
        current.epoch === this.owner.epoch &&
        current.credentials?.accountId === this.owner.credentials?.accountId
      )
        return;
      this.invalidate();
      this.owner = current;
      this.authPaused = false;
      this.retryEpochAt = 0;
      if (this.visible) void this.run();
    });
  }
  captureOwner(): SessionTicket {
    return this.sessions.snapshot();
  }
  canPresent(owner: SessionTicket): boolean {
    try {
      this.sessions.assertCurrent(owner);
      return this.visible && !!owner.credentials;
    } catch {
      return false;
    }
  }
  canObserve(owner: SessionTicket): boolean {
    try {
      this.sessions.assertCurrent(owner);
      return (
        this.visible &&
        this.synchronized &&
        !this.authPaused &&
        !!owner.credentials &&
        !!this.pending.collecting(owner.credentials.accountId, this.clock.now())
      );
    } catch {
      return false;
    }
  }
  subscribeInvalidation(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Analytics never breaks a page. */
      }
    }
  }
  private invalidate(): void {
    this.generation += 1;
    this.synchronized = false;
    this.stopTimer?.();
    this.stopTimer = undefined;
    this.flight?.cancellation.cancel();
    this.flight = undefined;
    this.emit();
  }
  foreground(): Promise<void> {
    this.visible = true;
    this.clean();
    this.invalidate();
    this.authPaused = false;
    this.retryEpochAt = 0;
    return this.run();
  }
  hide(): void {
    this.visible = false;
    this.stopCleanup?.();
    this.stopCleanup = undefined;
    this.invalidate();
    try {
      this.pending.purge(this.clock.now());
    } catch {
      /* Storage failures are isolated. */
    }
  }
  dispose(): void {
    this.hide();
    this.unsubscribe();
    this.listeners.clear();
  }
  observe(kind: ViewKind, postId: string, owner = this.captureOwner()): void {
    try {
      if (!this.canObserve(owner)) {
        if (this.visible) void this.run();
        return;
      }
      if (
        this.pending.observe(
          owner.credentials!.accountId,
          kind,
          postId,
          this.clock.now(),
        )
      )
        void this.run();
    } catch {
      /* Drop rather than retaining an unbounded in-memory observation. */
    }
  }
  private assert(
    owner: SessionTicket,
    generation: number,
    cancellation: Cancellation,
  ): void {
    this.sessions.assertCurrent(owner);
    if (
      !this.visible ||
      generation !== this.generation ||
      cancellation.isCancelled ||
      !owner.credentials
    )
      throw new ClientError('cancelled', 'View reporting paused');
  }
  private clean(): void {
    this.stopCleanup?.();
    this.stopCleanup = undefined;
    try {
      if (!this.pending.purge(this.clock.now()) && this.synchronized) {
        this.synchronized = false;
        this.emit();
      }
    } catch {
      /* All-owner expiry is independent of authentication/network availability. */
    }
    if (this.visible)
      this.stopCleanup = this.clock.schedule(() => this.clean(), 60_000);
  }
  private schedule(): void {
    this.stopTimer?.();
    this.stopTimer = undefined;
    if (!this.visible || !this.owner.credentials || this.authPaused) return;
    const now = this.clock.now();
    const delay =
      !this.synchronized && this.retryEpochAt > now
        ? Math.min(60_000, this.retryEpochAt - now)
        : this.pending.nextDelay(this.owner.credentials.accountId, now);
    this.stopTimer = this.clock.schedule(() => {
      this.stopTimer = undefined;
      void this.run();
    }, delay);
  }
  private run(): Promise<void> {
    if (this.flight) return this.flight.promise;
    if (!this.visible || !this.owner.credentials || this.authPaused)
      return Promise.resolve();
    const owner = this.owner,
      generation = this.generation,
      cancellation = new Cancellation();
    const accountId = owner.credentials!.accountId;
    const promise = Promise.resolve()
      .then(async () => {
        this.assert(owner, generation, cancellation);
        const now = this.clock.now();
        const clockSafe = this.pending.checkClock(now);
        if (!clockSafe || !this.pending.collecting(accountId, now)) {
          if (this.synchronized) {
            this.synchronized = false;
            this.emit();
          }
        }
        if (!this.synchronized) {
          if (this.retryEpochAt > now && clockSafe) return;
          const start = this.clock.now();
          const descriptor = decodeViewEpoch(
            await this.gateway.epoch(cancellation),
          );
          this.assert(owner, generation, cancellation);
          if (
            !this.pending.synchronize(
              accountId,
              descriptor,
              start,
              this.clock.now(),
            )
          )
            return;
          this.synchronized = true;
          this.retryEpochAt = 0;
          this.emit();
        }
        if (!this.pending.purge(this.clock.now())) return;
        // One report in flight; failed batches wait while other due batches can progress.
        for (;;) {
          this.assert(owner, generation, cancellation);
          if (!this.pending.checkClock(this.clock.now())) {
            this.synchronized = false;
            this.emit();
            return;
          }
          let batch = this.pending.dueBatch(accountId, this.clock.now());
          if (!batch) {
            const due = this.pending.dueObservation(
              accountId,
              this.clock.now(),
            );
            if (!due) break;
            const batchId = await this.newRequestId();
            this.assert(owner, generation, cancellation);
            batch = this.pending.freeze(
              accountId,
              due,
              batchId,
              this.clock.now(),
            );
            if (!batch) break;
          }
          this.pending.assertOriginal(accountId, batch);
          this.assert(owner, generation, cancellation);
          try {
            const receipt = await this.gateway.report(
              batch.intent,
              cancellation,
            );
            this.assert(owner, generation, cancellation);
            if (!this.pending.settle(accountId, batch, receipt)) return;
          } catch (error) {
            this.assert(owner, generation, cancellation);
            const failure = clientError(error);
            const terminal =
              (failure.details.httpStatus === 410 &&
                failure.details.serverCode === 'VIEW_REPORTING_EPOCH_CLOSED') ||
              (failure.details.httpStatus === 409 &&
                failure.details.serverCode === 'VIEW_REPORT_CONFLICT') ||
              (failure.details.httpStatus === 400 &&
                failure.details.serverCode === 'BAD_REQUEST');
            if (terminal) {
              if (!this.pending.terminal(accountId, batch)) return;
            } else if (
              failure.kind === 'auth-required' ||
              failure.kind === 'auth-expired' ||
              failure.kind === 'stale-session' ||
              failure.details.serverCode === 'ACCOUNT_BLOCKED'
            ) {
              this.authPaused = true;
              this.synchronized = false;
              this.emit();
              return;
            } else if (!this.pending.retry(accountId, batch, this.clock.now()))
              return;
          }
        }
      })
      .catch((error) => {
        if (generation !== this.generation) return;
        const failure = clientError(error);
        if (
          failure.kind === 'auth-required' ||
          failure.kind === 'auth-expired' ||
          failure.details.serverCode === 'ACCOUNT_BLOCKED'
        )
          this.authPaused = true;
        if (!this.synchronized)
          this.retryEpochAt = this.clock.now() + VIEW_RETRY_MS;
      })
      .finally(() => {
        if (this.flight?.promise === promise) {
          this.flight = undefined;
          this.schedule();
        }
      });
    this.flight = { cancellation, promise };
    return promise;
  }
}
