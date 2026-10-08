import { ClientError, clientError } from '../api/errors';
import type { IdentityRuntime } from '../auth/runtime';
import type { SessionStore, SessionTicket } from '../auth/session';
import { PrivateViewLifecycle } from '../identity-privacy/overlay';
import { cancellable } from '../platform/cancellable';
import { Cancellation, type Storage } from '../platform/contracts';
import {
  decodeExperienceSummary,
  type AppearanceIntent,
  type ExperienceIntent,
  type ExperienceOperation,
  type ExperienceReceipt,
} from './contract';
import { HttpExperienceGateway, type ExperienceGateway } from './gateway';
import { PendingExperienceStore, type PendingExperience } from './pending';
export interface ExperienceChange {
  readonly operation: ExperienceOperation;
  readonly phase: 'pending' | 'settled' | 'failed';
}
interface Flight {
  readonly owner: SessionTicket;
  readonly cancellation: Cancellation;
  readonly promise: Promise<ExperienceReceipt>;
}
/** Explicit mutation orchestration. Reading any experience endpoint never signs in. */
export class ExperienceRuntime {
  readonly privateViews = new PrivateViewLifecycle();
  private owner: SessionTicket;
  private visible = false;
  private generation = 0;
  private readonly flights = new Map<ExperienceOperation, Flight>();
  private foregroundFlight:
    | { generation: number; cancel: Cancellation; promise: Promise<void> }
    | undefined;
  private confirmedDay: string | null = null;
  private readonly listeners = new Set<(event: ExperienceChange) => void>();
  private readonly closedNotices = new Set<string>();
  private readonly unsubscribe: () => void;
  constructor(
    readonly sessions: SessionStore,
    readonly gateway: ExperienceGateway | undefined,
    readonly pending: PendingExperienceStore,
    readonly newRequestId: () => Promise<string>,
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
      this.confirmedDay = null;
      this.closedNotices.clear();
      this.privateViews.clear();
      if (this.visible && current.credentials) void this.foreground();
    });
  }
  subscribe(listener: (event: ExperienceChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(event: ExperienceChange): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* Rendering cannot affect settlement. */
      }
    }
  }
  private invalidate(): void {
    this.generation += 1;
    this.foregroundFlight?.cancel.cancel();
    this.foregroundFlight = undefined;
    for (const flight of this.flights.values()) flight.cancellation.cancel();
    this.flights.clear();
  }
  hide(): void {
    this.visible = false;
    this.invalidate();
    this.privateViews.clear();
  }
  dispose(): void {
    this.hide();
    this.unsubscribe();
    this.listeners.clear();
  }
  private assert(
    owner: SessionTicket,
    cancel: Cancellation,
    generation: number,
  ): void {
    this.sessions.assertCurrent(owner);
    if (cancel.isCancelled || generation !== this.generation)
      throw new ClientError('cancelled', 'Experience command cancelled');
    if (!owner.credentials || !this.gateway)
      throw new ClientError(
        'auth-required',
        'Experience requires an active account',
      );
  }
  /** Uses fresh serverDay only; pending journals are a manual recovery barrier across restarts and midnight. */
  foreground(): Promise<void> {
    this.visible = true;
    if (!this.gateway || !this.owner.credentials) return Promise.resolve();
    if (this.foregroundFlight?.generation === this.generation)
      return this.foregroundFlight.promise;
    const owner = this.owner,
      generation = this.generation,
      cancel = new Cancellation();
    const promise = Promise.resolve()
      .then(async () => {
        this.assert(owner, cancel, generation);
        if (this.pending.load(owner.credentials!.accountId, 'sign_in')) return;
        const state = decodeExperienceSummary(
          await cancellable(this.gateway!.summary(cancel), cancel),
        );
        this.assert(owner, cancel, generation);
        if (state.signIn.signedIn) {
          this.confirmedDay = state.serverDay;
          return;
        }
        if (state.baseline !== 'known' || this.confirmedDay === state.serverDay)
          return;
        // A manual command may have frozen its intent while the summary was in flight.
        if (this.pending.load(owner.credentials!.accountId, 'sign_in')) return;
        await this.signIn(cancel);
      })
      .catch(() => {
        /* The exact journal and the owner screen retain manual recovery; no timed auto-retry. */
      })
      .finally(() => {
        if (this.foregroundFlight?.promise === promise)
          this.foregroundFlight = undefined;
      });
    this.foregroundFlight = { generation, cancel, promise };
    return promise;
  }
  private execute(
    operation: ExperienceOperation,
    work: (
      owner: SessionTicket,
      cancel: Cancellation,
    ) => Promise<PendingExperience>,
    retry: boolean | 'lookup',
    external?: Cancellation,
  ): Promise<ExperienceReceipt> {
    const owner = this.sessions.snapshot(),
      generation = this.generation;
    const old = this.flights.get(operation);
    if (
      old &&
      old.owner.epoch === owner.epoch &&
      old.owner.credentials?.accountId === owner.credentials?.accountId
    )
      return cancellable(old.promise, external);
    const cancel = new Cancellation(),
      unsubscribe = external?.subscribe(() => cancel.cancel());
    let sent = owner;
    const promise = Promise.resolve()
      .then(async () => {
        this.assert(owner, cancel, generation);
        const attempt = await work(owner, cancel);
        this.assert(owner, cancel, generation);
        this.pending.assertOriginal(attempt);
        if (attempt.accountId !== owner.credentials!.accountId)
          throw new ClientError('stale-session', 'Experience owner changed');
        this.emit({ operation, phase: 'pending' });
        sent = this.sessions.snapshot();
        // Assert once more before the gateway captures credentials; never dispatch with a replacement login.
        this.assert(owner, cancel, generation);
        const raw = await cancellable(
          retry === 'lookup'
            ? this.gateway!.receipt(attempt.intent.requestId, cancel)
            : this.dispatch(attempt.intent, cancel),
          cancel,
        );
        this.assert(owner, cancel, generation);
        const receipt = this.pending.settle(attempt, raw);
        if (receipt.operation === 'sign_in')
          this.confirmedDay = receipt.rewardDay;
        this.emit({ operation, phase: 'settled' });
        return receipt;
      })
      .catch((error) => {
        if (generation === this.generation) {
          const failure = clientError(error);
          if (
            failure.kind === 'auth-required' ||
            (failure.kind === 'forbidden' &&
              failure.details.httpStatus === 403 &&
              failure.details.serverCode === 'ACCOUNT_BLOCKED')
          ) {
            try {
              this.sessions.logoutIfCurrent(sent);
            } catch {
              /* A later credential/session owns its own auth result. */
            }
          }
          if (generation === this.generation)
            this.emit({ operation, phase: 'failed' });
        }
        throw error;
      })
      .finally(() => {
        unsubscribe?.();
        if (this.flights.get(operation)?.promise === promise)
          this.flights.delete(operation);
      });
    this.flights.set(operation, { owner, cancellation: cancel, promise });
    return promise;
  }
  private dispatch(
    intent: ExperienceIntent,
    cancel: Cancellation,
  ): Promise<ExperienceReceipt> {
    return intent.operation === 'sign_in'
      ? this.gateway!.signIn({ requestId: intent.requestId }, cancel)
      : this.gateway!.selectAppearance(
          {
            requestId: intent.requestId,
            expectedRevision: intent.expectedRevision,
            titleKey: intent.titleKey,
            colorId: intent.colorId,
          },
          cancel,
        );
  }
  private fresh(
    operation: ExperienceOperation,
    selection: Omit<AppearanceIntent, 'requestId'> | null,
    cancel?: Cancellation,
  ): Promise<ExperienceReceipt> {
    return this.execute(
      operation,
      async (owner, inner) => {
        const accountId = owner.credentials!.accountId;
        if (this.pending.load(accountId, operation))
          throw new ClientError(
            'business',
            'Original experience request requires recovery',
            { serverCode: 'EXPERIENCE_RECOVERY_REQUIRED' },
          );
        const requestId = await cancellable(this.newRequestId(), inner);
        this.sessions.assertCurrent(owner);
        if (inner.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const intent: ExperienceIntent =
          operation === 'appearance' && selection
            ? { operation, requestId, ...selection }
            : { operation: 'sign_in', requestId };
        return this.pending.freeze({ version: 1, accountId, intent });
      },
      false,
      cancel,
    );
  }
  signIn(cancel?: Cancellation): Promise<ExperienceReceipt> {
    return this.fresh('sign_in', null, cancel);
  }
  selectAppearance(
    selection: Omit<AppearanceIntent, 'requestId'>,
    cancel?: Cancellation,
  ): Promise<ExperienceReceipt> {
    return this.fresh('appearance', selection, cancel);
  }
  recover(
    operation: ExperienceOperation,
    retry = false,
    cancel?: Cancellation,
  ): Promise<ExperienceReceipt> {
    return this.execute(
      operation,
      async (owner) => {
        const attempt = this.pending.load(
          owner.credentials!.accountId,
          operation,
        );
        if (!attempt)
          throw new ClientError(
            'storage',
            'Original experience request missing',
          );
        return attempt;
      },
      retry ? true : 'lookup',
      cancel,
    );
  }
  closeNotice(noticeId: string): void {
    this.closedNotices.add(noticeId);
  }
  isNoticeClosed(noticeId: string): boolean {
    return this.closedNotices.has(noticeId);
  }
}
export function createExperienceRuntime(
  identity: IdentityRuntime,
  storage: Storage,
  origin: string,
  newRequestId: () => Promise<string>,
): ExperienceRuntime {
  return new ExperienceRuntime(
    identity.sessions,
    identity.api ? new HttpExperienceGateway(identity.api) : undefined,
    new PendingExperienceStore(storage, origin),
    newRequestId,
  );
}
