import { ClientError } from '../api/errors';
import type { Cancellation } from '../platform/contracts';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  reasonMessage,
  type CommunityView,
} from './controller';
import type { Post } from './contract';
import {
  decodeBallotIntent,
  decodeBallotReceipt,
  decodeOwnBallot,
  decodePoll,
  type BallotReceipt,
  type Poll,
} from './poll-contract';
import type { PendingBallot } from './poll-pending';
import type { CommunityRuntime } from './runtime';
export interface PollView extends CommunityView {
  readonly active: boolean;
  readonly loaded: boolean;
  readonly poll: Poll | null;
  readonly rows: readonly {
    readonly id: string;
    readonly label: string;
    readonly selected: boolean;
    readonly count: number;
    readonly percent: number;
  }[];
  readonly selectedOptionIds: readonly string[];
  readonly revealResults: boolean;
  readonly canVote: boolean;
  readonly canSubmit: boolean;
  readonly frozen: boolean;
  readonly blocker: string;
  readonly recoveryPostId: string;
  readonly receiptStatus: string;
  readonly ownStatus: string;
}
export const initialPollView = (): PollView => ({
  ...initialCommunityView(),
  active: false,
  loaded: false,
  poll: null,
  rows: [],
  selectedOptionIds: [],
  revealResults: false,
  canVote: false,
  canSubmit: false,
  frozen: false,
  blocker: '',
  recoveryPostId: '',
  receiptStatus: '',
  ownStatus: '',
});
const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  [...a].sort().join(',') === [...b].sort().join(',');
/** Parent-visible reads are bounded; one immutable account-owned ballot survives every UI lifecycle. */
export class PollController extends CommunityController<PollView> {
  private parent: Post | null = null;
  private pending: PendingBallot | null = null;
  private expectedCreated: {
    postId: string;
    optionIds: readonly string[];
  } | null = null;
  private readonly unsubscribeVisibility: () => void;
  constructor(
    runtime: CommunityRuntime,
    private readonly postId: string,
    render: (view: PollView) => void,
  ) {
    super(runtime, initialPollView, render);
    this.unsubscribeVisibility =
      runtime.privateViews?.subscribe(() => this.dispose()) ??
      (() => undefined);
  }
  protected override resetPrivate(): void {
    this.parent = null;
    this.pending = null;
    this.expectedCreated = null;
  }
  private restorePending(): boolean {
    const accountId = this.accountId();
    if (!accountId) return false;
    try {
      this.pending = this.runtime.pendingBallots.load(accountId);
      if (this.pending) this.showPending(this.pending);
      return true;
    } catch (error) {
      this.update({
        active: true,
        frozen: true,
        canVote: false,
        canSubmit: false,
        error: communityError(error),
        blocker: '无法读取原投票记录，禁止新建请求',
      });
      return false;
    }
  }
  private showPending(attempt: PendingBallot): void {
    this.pending = attempt;
    this.update({
      active: true,
      frozen: true,
      canVote: false,
      canSubmit: false,
      recoveryPostId: attempt.postId,
      selectedOptionIds:
        attempt.postId === this.postId ? attempt.payload.optionIds : [],
      blocker:
        '原投票结果待确认。选项与请求编号保持不变，只能查询结果或重试原请求',
      status: '投票结果待确认',
    });
    this.rows();
  }
  async load(post: Post | null): Promise<void> {
    this.stop();
    this.parent =
      post?.id === this.postId && post.component.kind === 'poll' ? post : null;
    this.pending = null;
    this.update({
      active: !!this.parent,
      busy: false,
      loaded: false,
      poll: null,
      rows: [],
      selectedOptionIds: [],
      canVote: false,
      canSubmit: false,
      revealResults: false,
      frozen: false,
      recoveryPostId: '',
      blocker: '',
      error: '',
      ownStatus: '',
    });
    if (!this.restorePending() || !this.parent || !this.available()) return;
    const pollId =
      this.parent.component.kind === 'poll'
        ? this.parent.component.poll.id
        : '';
    await this.run(
      (cancel) => this.runtime.gateway!.poll(this.postId, cancel),
      (raw) => {
        const poll = decodePoll(raw);
        if (poll.postId !== this.postId || poll.id !== pollId)
          throw new ClientError('protocol', 'Poll parent mismatch');
        if (
          this.expectedCreated?.postId === this.postId &&
          (!poll.viewer.hasVoted ||
            !sameIds(
              poll.viewer.selectedOptionIds,
              this.expectedCreated.optionIds,
            ))
        )
          throw new ClientError(
            'protocol',
            'Committed ballot is not reflected by the read',
          );
        this.expectedCreated = null;
        // A different page may have frozen an intent during this read.
        if (!this.restorePending()) return;
        this.update({
          active: true,
          loaded: true,
          poll,
          selectedOptionIds: poll.viewer.hasVoted
            ? poll.viewer.selectedOptionIds
            : this.pending?.postId === this.postId
              ? this.pending.payload.optionIds
              : [],
          revealResults: poll.viewer.hasVoted || poll.expired,
          canVote: !this.pending && poll.viewer.canVote,
          blocker: this.pending
            ? this.view.blocker
            : reasonMessageForPoll(poll),
          status: this.pending
            ? '投票结果待确认'
            : poll.viewer.hasVoted
              ? '已投票，选择不可修改'
              : poll.expired
                ? '投票已结束'
                : '投票已加载',
        });
        this.rows();
      },
      () =>
        this.update({
          loaded: false,
          poll: null,
          rows: [],
          selectedOptionIds: [],
          canVote: false,
          canSubmit: false,
          revealResults: false,
        }),
    );
  }
  private rows(): void {
    const poll = this.view.poll;
    this.update({
      rows: poll
        ? poll.options.map((option) => ({
            id: option.id,
            label: option.label,
            count: option.count,
            selected: this.view.selectedOptionIds.includes(option.id),
            percent: poll.selectionCount
              ? Math.round((option.count * 1000) / poll.selectionCount) / 10
              : 0,
          }))
        : [],
      canSubmit:
        this.view.canVote &&
        !this.view.frozen &&
        this.view.selectedOptionIds.length > 0,
    });
  }
  async select(optionId: string): Promise<void> {
    if (
      this.view.busy ||
      !this.view.canVote ||
      this.view.frozen ||
      !this.view.poll ||
      !this.view.poll.options.some((option) => option.id === optionId) ||
      !this.available()
    )
      return;
    if (!this.restorePending() || this.pending) return;
    const single = this.view.poll.selectionMode === 'single';
    const selected = single
      ? [optionId]
      : this.view.selectedOptionIds.includes(optionId)
        ? this.view.selectedOptionIds.filter((id) => id !== optionId)
        : [...this.view.selectedOptionIds, optionId];
    this.update({ selectedOptionIds: selected });
    this.rows();
    if (single) await this.submit();
  }
  async submit(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.canSubmit ||
      this.view.frozen ||
      !this.view.poll ||
      !this.available()
    )
      return;
    if (!this.restorePending() || this.pending) return;
    const accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot();
    const selected = [...this.view.selectedOptionIds],
      poll = this.view.poll;
    if (
      !selected.length ||
      (poll.selectionMode === 'single' && selected.length !== 1) ||
      selected.some((id) => !poll.options.some((option) => option.id === id))
    )
      return;
    let settled = false;
    await this.run(
      async (cancel) => {
        const requestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const frozen = this.runtime.pendingBallots.freeze({
          version: 1,
          accountId,
          postId: this.postId,
          payload: decodeBallotIntent({
            clientRequestId: requestId,
            optionIds: selected,
          }),
        });
        this.showPending(frozen);
        return this.dispatch(frozen, cancel);
      },
      (receipt) => {
        this.settle(receipt);
        settled = true;
      },
      () => {
        if (this.pending) this.showPending(this.pending);
      },
    );
    if (settled && this.parent) await this.load(this.parent);
  }
  private dispatch(
    attempt: PendingBallot,
    cancel: Cancellation,
  ): Promise<BallotReceipt> {
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    if (
      JSON.stringify(this.runtime.pendingBallots.load(attempt.accountId)) !==
      JSON.stringify(attempt)
    )
      throw new ClientError('storage', 'Pending ballot changed');
    return this.runtime.gateway!.castBallot(
      attempt.postId,
      attempt.payload,
      cancel,
    );
  }
  async recover(retry = false): Promise<void> {
    if (
      this.view.busy ||
      !this.available() ||
      !this.restorePending() ||
      !this.pending
    )
      return;
    const attempt = this.pending;
    let settled = false;
    await this.run(
      (cancel) =>
        retry
          ? this.dispatch(attempt, cancel)
          : this.runtime.gateway!.ballotReceipt(
              attempt.payload.clientRequestId,
              cancel,
            ),
      (receipt) => {
        this.settle(receipt);
        settled = true;
      },
      () => this.showPending(attempt),
    );
    if (settled && this.parent) await this.load(this.parent);
  }
  private settle(raw: BallotReceipt): void {
    const attempt = this.pending;
    if (!attempt || attempt.accountId !== this.accountId())
      throw new ClientError('protocol', 'Missing original ballot');
    const receipt = decodeBallotReceipt(raw);
    this.runtime.pendingBallots.settle(attempt, receipt);
    this.pending = null;
    this.expectedCreated =
      receipt.outcome === 'created'
        ? { postId: attempt.postId, optionIds: attempt.payload.optionIds }
        : null;
    // No optimistic totals, permission or replacement choice after a terminal receipt. Read current state again.
    this.update({
      active: true,
      loaded: false,
      poll: null,
      rows: [],
      selectedOptionIds: [],
      frozen: false,
      canVote: false,
      canSubmit: false,
      revealResults: false,
      recoveryPostId: '',
      receiptStatus:
        receipt.outcome === 'created'
          ? '投票已确认，每人仅有一次且不可修改或撤回'
          : `本次投票已确认未提交：${reasonMessage(receipt.code)}`,
      status:
        receipt.outcome === 'created' ? '投票已确认' : '本次请求已确认拒绝',
      blocker: '',
      error: '',
    });
  }
  async inspectOwnBallot(): Promise<void> {
    if (
      this.view.busy ||
      !this.available() ||
      !this.restorePending() ||
      !this.pending
    )
      return;
    const target = this.pending.postId;
    await this.run(
      (cancel) => this.runtime.gateway!.ownBallot(target, cancel),
      (raw) => {
        const own = decodeOwnBallot(raw);
        if (own.postId !== target)
          throw new ClientError('protocol', 'Own ballot mismatch');
        this.update({
          ownStatus:
            '服务器确认此账号已有不可修改的投票。原请求仍需通过回执确认，不能重新选择或更换请求编号',
        });
      },
    );
  }
  override cancel(): void {
    super.cancel();
    if (this.pending) this.showPending(this.pending);
    else
      this.update({
        poll: null,
        rows: [],
        selectedOptionIds: [],
        loaded: false,
        canVote: false,
        canSubmit: false,
        revealResults: false,
      });
  }
  override dispose(): void {
    this.unsubscribeVisibility?.();
    super.dispose();
  }
}
function reasonMessageForPoll(poll: Poll): string {
  return poll.viewer.canVote ? '' : reasonMessage(poll.viewer.reason);
}
