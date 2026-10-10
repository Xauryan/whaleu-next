import { ClientError } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import { Cancellation } from '../platform/contracts';
import {
  PendingRatingStore,
  isRatingTargetCoverIntent,
  type PendingRating,
} from './pending';
import {
  decodeRatingTargetCoverIntent,
  matchRatingTargetCoverReceipt,
  type RatingTargetCoverIntent,
  type RatingTargetCoverReceipt,
} from './target-cover-contract';
import type { RatingTargetCoverGateway } from './target-cover-gateway';
export interface RatingTargetCoverCommandView {
  readonly status: 'idle' | 'pending' | 'busy' | 'settled' | 'unavailable';
  readonly requestId: string | null;
  readonly message: string;
}
/** A single command editor/recovery window over the existing Ratings journal.
 * Frozen content is never edited or silently rebound to a new scope/account. */
export class RatingTargetCoverCommandController {
  private cancel = new Cancellation();
  private owner: SessionTicket;
  private active = false;
  private disposed = false;
  private generation = 0;
  private view: RatingTargetCoverCommandView = {
    status: 'idle',
    requestId: null,
    message: '',
  };
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly pending: PendingRatingStore,
    private readonly gateway: RatingTargetCoverGateway,
    private readonly render: (view: RatingTargetCoverCommandView) => void,
    private readonly changed?: (receipt: RatingTargetCoverReceipt) => void,
    private readonly verifyMedia?: (
      attempt: Extract<PendingRating, { version: 11 }>,
      receipt: RatingTargetCoverReceipt,
      cancel: Cancellation,
    ) => Promise<RatingTargetCoverReceipt>,
  ) {
    this.owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const now = sessions.snapshot();
      if (
        now.epoch !== this.owner.epoch ||
        now.credentials?.accountId !== this.owner.credentials?.accountId
      ) {
        this.hide();
        this.owner = now;
      }
    });
  }
  snapshot(): RatingTargetCoverCommandView {
    return this.view;
  }
  private publish(view: RatingTargetCoverCommandView): void {
    this.view = Object.freeze(view);
    this.render(this.view);
  }
  private original(): Extract<PendingRating, { version: 11 }> {
    const owner = this.sessions.snapshot();
    if (!owner.credentials)
      throw new ClientError(
        'auth-required',
        'Original Ratings account required',
      );
    const attempt = this.pending.load(owner.credentials.accountId);
    if (
      !attempt ||
      attempt.version !== 11 ||
      !isRatingTargetCoverIntent(attempt.intent)
    )
      throw new ClientError(
        'business',
        'Recover the original Ratings command first',
      );
    return attempt;
  }
  async submit(raw: RatingTargetCoverIntent): Promise<void> {
    if (this.active || this.disposed) return;
    const intent = decodeRatingTargetCoverIntent(raw),
      owner = this.sessions.snapshot();
    if (!owner.credentials)
      throw new ClientError('auth-required', 'Sign in to edit Ratings cover');
    this.pending.freeze({
      version: 11,
      accountId: owner.credentials.accountId,
      intent,
    });
    await this.run('commit');
  }
  recover(): Promise<void> {
    return this.run('receipt');
  }
  retry(): Promise<void> {
    return this.run('commit');
  }
  cancelOriginal(): Promise<void> {
    return this.run('cancel');
  }
  private async run(action: 'receipt' | 'commit' | 'cancel'): Promise<void> {
    if (this.active || this.disposed) return;
    const attempt = this.original(),
      owner = this.sessions.snapshot(),
      generation = ++this.generation;
    this.cancel.cancel();
    const cancel = (this.cancel = new Cancellation());
    this.active = true;
    this.publish({
      status: 'busy',
      requestId: attempt.intent.payload.clientRequestId,
      message: '',
    });
    const current = () => {
      this.sessions.assertCurrent(owner);
      if (cancel.isCancelled || this.disposed || generation !== this.generation)
        throw new ClientError('cancelled', 'Ratings cover view changed');
      this.pending.assertOriginal(attempt);
    };
    try {
      // Receipt first on every recovery/retry. Not-found does not mean cancelled.
      let receipt: RatingTargetCoverReceipt | undefined;
      try {
        receipt = await this.gateway.receipt(
          attempt.intent.payload.clientRequestId,
          cancel,
        );
      } catch (error) {
        current();
        if (
          action === 'receipt' ||
          !(error instanceof ClientError) ||
          error.details.serverCode !== 'REQUEST_NOT_FOUND'
        )
          throw error;
      }
      current();
      receipt ??=
        action === 'cancel'
          ? await this.gateway.cancel(attempt.intent, cancel)
          : await this.gateway.command(attempt.intent, cancel);
      current();
      matchRatingTargetCoverReceipt(attempt.intent, receipt);
      if (attempt.upload) {
        if (!this.verifyMedia)
          throw new ClientError(
            'configuration',
            'Original Ratings media verification required',
          );
        receipt = await this.verifyMedia(attempt, receipt, cancel);
        current();
        matchRatingTargetCoverReceipt(attempt.intent, receipt);
      }
      this.pending.settle(attempt, receipt);
      this.publish({
        status: 'settled',
        requestId: receipt.requestId,
        message:
          receipt.outcome === 'closed'
            ? '原请求已明确结束'
            : '正文和封面已共同保存',
      });
      this.changed?.(receipt);
    } catch {
      if (
        !cancel.isCancelled &&
        generation === this.generation &&
        !this.disposed
      ) {
        try {
          this.sessions.assertCurrent(owner);
          this.publish({
            status: 'pending',
            requestId: attempt.intent.payload.clientRequestId,
            message: '原请求结果暂不确定，请恢复或明确取消；不要重新选择图片',
          });
        } catch {
          /* Account change already revoked the view. */
        }
      }
    } finally {
      if (generation === this.generation) this.active = false;
    }
  }
  hide(): void {
    ++this.generation;
    this.cancel.cancel();
    this.active = false;
    // Only transient view state is cleared. The original actor's durable command remains.
    this.publish({ status: 'idle', requestId: null, message: '' });
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.hide();
  }
}
