import { majorDiscussionError } from './errors';
export { majorDiscussionError } from './errors';
import { decodeDiscussionV2Page } from './v2-contract';
import type { MajorDiscussionComposition } from './image-runtime';
import { ClientError, clientError } from '../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import { majorId } from '../majors/contract';
import {
  decodeDeleteCapability,
  type DiscussionDeleteLocator,
  decodeDiscussionIntent,
  decodeDiscussionPage,
  decodeDiscussionOwn,
  decodeDiscussionTarget,
  discussionBody,
  discussionBytes,
  invalidDiscussion,
  type DiscussionItem,
  type DiscussionOwn,
  type DiscussionPage,
  type DiscussionReceipt,
  type DiscussionSort,
  type DiscussionTarget,
} from './operation-contract';
import type { PendingMajorDiscussion, DiscussionOwnReference } from './pending';
export type DiscussionMode = 'roots' | 'thread' | 'recovery';
export interface MajorDiscussionView extends CommunityView {
  readonly deletionLocatorUnavailable: boolean;
  readonly deletionLocators: readonly DiscussionDeleteLocator[];
  readonly deleteTarget: DiscussionDeleteLocator | null;
  readonly mode: DiscussionMode;
  readonly loaded: boolean;
  readonly majorId: string;
  readonly rootId: string;
  readonly root: DiscussionItem | null;
  readonly items: readonly DiscussionItem[];
  readonly sort: DiscussionSort;
  readonly totalCount: number | null;
  readonly pageNumber: number;
  readonly canNext: boolean;
  readonly restartRequired: boolean;
  readonly body: string;
  readonly bodyBytes: number;
  readonly canPublish: boolean;
  readonly replyTarget: DiscussionItem | null;
  readonly confirming:
    'publish' | 'like' | 'unlike' | 'delete' | 'cancel' | null;
  readonly selectedComment: DiscussionItem | null;
  readonly frozen: boolean;
  readonly recoveryMajorId: string;
  readonly recoveryOperation: string;
  readonly recoveryCommentId: string;
  readonly recoveryPhase: string;
  readonly receiptMissing: boolean;
  readonly receiptStatus: string;
  readonly ownMajorDraft: string;
  readonly ownCommentDraft: string;
  readonly own: DiscussionOwn | null;
  readonly canUnlike: boolean;
  readonly focusCommentId: string;
  readonly ownReferences: readonly DiscussionOwnReference[];
}
export const initialMajorDiscussionView = (): MajorDiscussionView => ({
  ...initialCommunityView(),
  deletionLocatorUnavailable: false,
  deletionLocators: [],
  deleteTarget: null,
  mode: 'roots',
  loaded: false,
  majorId: '',
  rootId: '',
  root: null,
  items: [],
  sort: 'likes',
  totalCount: null,
  pageNumber: 0,
  canNext: false,
  restartRequired: false,
  body: '',
  bodyBytes: 0,
  canPublish: false,
  replyTarget: null,
  confirming: null,
  selectedComment: null,
  frozen: false,
  recoveryMajorId: '',
  recoveryOperation: '',
  recoveryCommentId: '',
  recoveryPhase: '',
  receiptMissing: false,
  receiptStatus: '',
  ownMajorDraft: '',
  ownCommentDraft: '',
  own: null,
  canUnlike: false,
  focusCommentId: '',
  ownReferences: [],
});

const missing = (e: unknown): boolean => {
  const f = clientError(e);
  return (
    f.kind !== 'protocol' &&
    f.details.httpStatus === 404 &&
    f.details.serverCode === 'REQUEST_NOT_FOUND'
  );
};
export class MajorDiscussionController extends CommunityController<MajorDiscussionView> {
  private imageCount = 0;
  private imageBlocked = false;
  private imagePending = false;
  private continuation = 0;
  private selectedMajorId: string | null = null;
  private selectedRootId: string | null = null;
  private snapshot: DiscussionPage | null = null;
  private pending: PendingMajorDiscussion | null = null;
  private ownLocator: { majorId: string; commentId: string } | null = null;
  private notice: { noticeId: string; target: DiscussionTarget } | null = null;
  constructor(
    runtime: CommunityRuntime,
    private readonly mode: DiscussionMode,
    render: (v: MajorDiscussionView) => void,
  ) {
    super(runtime, initialMajorDiscussionView, render);
    this.update({ mode });
  }
  protected override preserveForNativePicker(): boolean {
    return this.runtime.majorDiscussionImages?.pickerActive ?? false;
  }
  protected override resetPrivate(): void {
    this.imageCount = 0;
    this.imageBlocked = false;
    this.imagePending = false;
    this.continuation++;
    this.snapshot = null;
    this.pending = null;
    this.ownLocator = null;
  }
  private ready(): boolean {
    if (!this.available()) return false;
    if (!this.runtime.majorDiscussion || !this.runtime.pendingMajorDiscussion) {
      this.update({
        error: '当前构建未配置专业讨论服务',
        canPublish: false,
        canUnlike: false,
      });
      return false;
    }
    return true;
  }
  private clearRead(): void {
    this.snapshot = null;
    this.ownLocator = null;
    this.update({
      loaded: false,
      deleteTarget: null,
      root: null,
      items: [],
      totalCount: null,
      canNext: false,
      canPublish: false,
      confirming: null,
      selectedComment: null,
      replyTarget: null,
      own: null,
      canUnlike: false,
    });
  }
  private restore(): boolean {
    const accountId = this.accountId();
    if (!accountId || !this.runtime.pendingMajorDiscussion) return false;
    try {
      this.pending =
        this.runtime.pendingMajorDiscussion.loadForRecovery(accountId);
      const locatorState =
        this.runtime.pendingMajorDiscussion.deletionLocatorState(accountId);
      // Recovery of a valid original v1 record is independent of optional
      // locators and of any newer v2 metadata journal.
      let ownReferences: readonly DiscussionOwnReference[] = [];
      try {
        ownReferences =
          this.runtime.pendingMajorDiscussion.references(accountId);
      } catch (error) {
        if (!this.pending) throw error;
      }
      if (!this.pending)
        this.runtime.pendingMajorDiscussion.assertNewAdmission(accountId);
      this.update({
        deletionLocators: locatorState.items,
        deletionLocatorUnavailable: locatorState.unavailable,
        ownReferences,
      });
      if (this.pending) this.showPending(this.pending);
      else
        this.update({
          frozen: false,
          recoveryMajorId: '',
          recoveryOperation: '',
          recoveryCommentId: '',
          recoveryPhase: '',
          receiptMissing: false,
        });
      return true;
    } catch (e) {
      this.clearRead();
      this.update({
        frozen: true,
        body: '',
        bodyBytes: 0,
        error: majorDiscussionError(e),
        status: '原请求暂不能读取，不能创建替代请求',
      });
      return false;
    }
  }
  private showPending(p: PendingMajorDiscussion): void {
    this.pending = p;
    const i = p.intent;
    this.update({
      frozen: true,
      canPublish: false,
      canUnlike: false,
      confirming: null,
      selectedComment: null,
      replyTarget: null,
      body: '',
      bodyBytes: 0,
      recoveryMajorId: i.majorId,
      recoveryOperation: i.operation,
      recoveryCommentId:
        i.operation === 'major.discussion.like.v1' ||
        i.operation === 'major.discussion.delete.v1'
          ? i.commentId
          : i.operation === 'major.discussion.reply.v1'
            ? i.rootId
            : '',
      recoveryPhase: p.phase,
      status: '原讨论操作结果待确认',
    });
  }
  async load(
    id: string | null = null,
    rootId: string | null = null,
    notice: { noticeId: string; target: DiscussionTarget } | null = null,
  ): Promise<void> {
    if (this.view.busy) return;
    if (
      (this.mode === 'recovery'
        ? id !== null || rootId !== null || notice !== null
        : !majorId(id)) ||
      (this.mode === 'thread' ? !majorId(rootId) : rootId !== null)
    ) {
      this.update({ error: '专业讨论入口无效' });
      return;
    }
    if (this.selectedMajorId !== id || this.selectedRootId !== rootId) {
      this.continuation++;
      this.clearRead();
      this.update({ body: '', bodyBytes: 0, canPublish: false });
    }
    this.selectedMajorId = id;
    this.selectedRootId = rootId;
    this.notice = notice;
    this.update({
      mode: this.mode,
      majorId: id ?? '',
      rootId: rootId ?? '',
      ownMajorDraft: id ?? '',
      focusCommentId: notice?.target.commentId ?? '',
    });
    await this.reload();
  }
  async reload(): Promise<void> {
    if (this.view.busy || !this.ready()) return;
    const valid = this.restore();
    if (this.selectedMajorId) await this.loadPage(null);
    else if (valid)
      this.update({
        status: this.pending
          ? '原讨论操作结果待确认'
          : '当前账号没有待确认的专业讨论操作',
      });
  }
  async setSort(sort: unknown): Promise<void> {
    if (
      this.view.busy ||
      this.mode !== 'roots' ||
      (sort !== 'likes' && sort !== 'time') ||
      !this.ready()
    )
      return;
    this.update({ sort, body: '', bodyBytes: 0 });
    await this.loadPage(null);
  }
  async next(): Promise<void> {
    if (this.view.busy || !this.snapshot?.nextCursor || !this.ready()) return;
    await this.loadPage(this.snapshot.nextCursor);
  }
  private async loadPage(cursor: string | null): Promise<void> {
    const id = this.selectedMajorId;
    if (!id) return;
    const prior = this.snapshot,
      rootId = this.selectedRootId,
      sort = this.view.sort,
      pageNumber = cursor ? this.view.pageNumber + 1 : 1,
      notice = this.notice;
    this.clearRead();
    this.update({ restartRequired: false, status: '正在核验专业讨论' });
    await this.run(
      async (cancel) => {
        if (notice) {
          const t = decodeDiscussionTarget(
            await (this.runtime.majorDiscussionV2 ??
              this.runtime.majorDiscussion)!.target(notice.noticeId, cancel),
          );
          if (
            t.majorId !== id ||
            t.rootId !== rootId ||
            t.commentId !== notice.target.commentId
          )
            invalidDiscussion();
          if (cancel.isCancelled)
            throw new ClientError('cancelled', 'Cancelled');
        }
        const p = (
          this.runtime.majorDiscussionV2
            ? decodeDiscussionV2Page
            : decodeDiscussionPage
        )(
          await (this.runtime.majorDiscussionV2 ??
            this.runtime.majorDiscussion)!.list(
            id,
            rootId,
            sort,
            cursor,
            cancel,
          ),
        );
        if (
          p.majorId !== id ||
          (p.root?.id ?? null) !== rootId ||
          (cursor && p.nextCursor === cursor)
        )
          invalidDiscussion();
        if (
          cursor &&
          (!prior ||
            prior.catalogRevision !== p.catalogRevision ||
            prior.majorRevision !== p.majorRevision ||
            prior.discussionRevision !== p.discussionRevision)
        )
          throw new ClientError('business', 'Discussion changed', {
            serverCode: 'MAJOR_DISCUSSION_RESTART_REQUIRED',
          });
        return p;
      },
      (p) => {
        const storageReady = this.restore();
        this.snapshot = p;
        this.update({
          loaded: true,
          root: p.root,
          items: p.items,
          totalCount: p.totalCount,
          pageNumber,
          canNext: p.nextCursor !== null,
          canPublish:
            storageReady &&
            !this.pending &&
            this.validComposition(this.view.body),
          status: this.pending
            ? '原讨论操作结果待确认'
            : p.items.length
              ? '当前讨论已核验'
              : '当前已确认没有' + (rootId ? '回复' : '回复'),
        });
      },
      (e) => {
        this.clearRead();
        this.update({
          pageNumber: 0,
          restartRequired: cursor !== null,
          error: majorDiscussionError(e),
          status: '当前讨论暂不可用',
        });
      },
    );
  }
  setBody(body: string): void {
    if (
      this.view.busy ||
      this.view.confirming ||
      this.view.frozen ||
      !this.view.loaded ||
      !this.restore() ||
      this.pending
    )
      return;
    this.update({
      body,
      bodyBytes: discussionBytes(body),
      canPublish: this.validComposition(body),
    });
  }
  chooseReply(id: string | null): void {
    if (
      this.mode !== 'thread' ||
      this.imageCount > 0 ||
      this.imagePending ||
      this.imageBlocked ||
      this.view.busy ||
      this.view.confirming ||
      this.view.frozen ||
      !this.view.loaded
    )
      return;
    const target =
      id === null ? null : this.view.items.find((i) => i.id === id);
    if (id !== null && !target) return;
    this.update({ replyTarget: target ?? null });
  }
  private validComposition(body: string): boolean {
    return !this.imageBlocked && discussionBody(body);
  }
  setImages(count: number, blocked: boolean, pending = false): void {
    this.imageCount = count;
    this.imagePending = pending;
    this.imageBlocked = blocked;
    this.update({
      canPublish:
        this.view.loaded &&
        !this.view.frozen &&
        this.validComposition(this.view.body),
    });
  }
  composition(): MajorDiscussionComposition | null {
    const p = this.snapshot;
    if (
      !p ||
      !this.view.loaded ||
      this.view.frozen ||
      this.view.busy ||
      this.imageBlocked
    )
      return null;
    return {
      majorId: p.majorId,
      catalogRevision: p.catalogRevision,
      majorRevision: p.majorRevision,
      rootId: this.selectedRootId,
      replyToReplyId: this.view.replyTarget?.id ?? null,
    };
  }
  publication(): { context: MajorDiscussionComposition; body: string } | null {
    const context = this.composition();
    if (
      !context ||
      this.view.confirming !== 'publish' ||
      !this.validComposition(this.view.body)
    )
      return null;
    return { context, body: this.view.body };
  }
  confirmPublish(): void {
    if (
      this.view.busy ||
      this.view.confirming ||
      this.view.frozen ||
      !this.view.loaded ||
      !this.snapshot ||
      !this.view.canPublish ||
      !this.ready() ||
      !this.restore() ||
      this.pending
    )
      return;
    this.update({ confirming: 'publish', selectedComment: null });
  }
  confirmLike(id: string): void {
    if (
      this.imagePending ||
      this.imageBlocked ||
      this.view.busy ||
      this.view.confirming ||
      this.view.frozen ||
      !this.view.loaded ||
      !this.snapshot ||
      !this.ready()
    )
      return;
    const item = [
      ...(this.view.root ? [this.view.root] : []),
      ...this.view.items,
    ].find((i) => i.id === id);
    if (!item || !this.restore() || this.pending) return;
    this.update({ confirming: 'like', selectedComment: item });
  }
  confirmDelete(id: string): void {
    if (
      this.imagePending ||
      this.imageBlocked ||
      this.view.busy ||
      this.view.confirming ||
      this.view.frozen ||
      this.view.deleteTarget?.commentId !== id ||
      !this.ready() ||
      !this.restore() ||
      this.pending
    )
      return;
    this.update({ confirming: 'delete' });
  }
  async inspectDeletion(id: string, own = false): Promise<void> {
    if (
      this.imagePending ||
      this.imageBlocked ||
      this.view.busy ||
      this.view.confirming ||
      this.view.frozen ||
      !this.ready() ||
      !this.restore() ||
      this.pending
    )
      return;
    const item = [
      ...(this.view.root ? [this.view.root] : []),
      ...this.view.items,
    ].find((i) => i.id === id);
    const ref = own
      ? this.view.deletionLocators.find((i) => i.commentId === id)
      : this.view.loaded && item
        ? { majorId: item.majorId, commentId: item.id, rootId: item.rootId }
        : null;
    this.update({ deleteTarget: null });
    if (!ref) return;
    await this.run(
      async (cancel) => {
        const proof = decodeDeleteCapability(
          await this.runtime.majorDiscussion!.deleteCapability(ref, cancel),
        );
        if (
          proof.majorId !== ref.majorId ||
          proof.commentId !== ref.commentId ||
          proof.rootId !== ref.rootId
        )
          invalidDiscussion();
        return proof;
      },
      (proof) => {
        if (proof.allowed)
          this.update({
            deleteTarget: ref,
            ...(own ? { confirming: 'delete' as const } : {}),
          });
        else
          this.update({ deleteTarget: null, status: '当前没有可用的删除操作' });
      },
      (e) =>
        this.update({ deleteTarget: null, error: majorDiscussionError(e) }),
    );
  }
  closeConfirmation(): void {
    if (this.view.busy) return;
    this.update({
      confirming: null,
      selectedComment: null,
      deleteTarget: null,
    });
  }
  setOwnLocator(field: 'major' | 'comment', value: string): void {
    if (this.view.busy || this.view.confirming || this.view.frozen) return;
    this.ownLocator = null;
    this.update({
      [field === 'major' ? 'ownMajorDraft' : 'ownCommentDraft']: value,
      own: null,
      canUnlike: false,
    });
  }
  async chooseOwnReference(commentId: string): Promise<void> {
    if (this.view.busy || this.view.confirming || this.view.frozen) return;
    const ref = this.view.ownReferences.find((r) => r.commentId === commentId);
    if (!ref) return;
    this.update({
      ownMajorDraft: ref.majorId,
      ownCommentDraft: ref.commentId,
    });
    await this.lookupOwn();
  }
  async lookupOwn(): Promise<void> {
    if (this.view.busy || !this.ready() || !this.restore() || this.pending)
      return;
    const majorIdValue = this.view.ownMajorDraft,
      commentId = this.view.ownCommentDraft;
    this.ownLocator = null;
    this.update({ own: null, canUnlike: false, confirming: null });
    if (!majorId(majorIdValue) || !majorId(commentId)) {
      this.update({ error: '请输入完整有效的专业与回复编号' });
      return;
    }
    await this.run(
      async (cancel) =>
        decodeDiscussionOwn(
          await this.runtime.majorDiscussion!.own(
            majorIdValue,
            commentId,
            cancel,
          ),
        ),
      (own) => {
        if (!this.restore() || this.pending) return;
        this.ownLocator = { majorId: majorIdValue, commentId };
        this.update({
          own,
          canUnlike: own.kind === 'recorded' && own.active,
          status:
            own.kind === 'unavailable'
              ? '自己的点赞历史暂不能确认'
              : '自己的当前点赞已查询',
        });
      },
      (e) => this.update({ error: majorDiscussionError(e) }),
    );
  }
  confirmUnlike(): void {
    if (
      this.imagePending ||
      this.imageBlocked ||
      this.view.busy ||
      this.view.confirming ||
      !this.view.canUnlike ||
      !this.ownLocator ||
      !this.ready() ||
      !this.restore() ||
      this.pending
    )
      return;
    this.update({ confirming: 'unlike', selectedComment: null });
  }
  async submit(): Promise<void> {
    if (
      this.view.busy ||
      this.view.frozen ||
      this.imagePending ||
      this.imageBlocked ||
      !this.ready()
    )
      return;
    // Upgraded publication belongs exclusively to its metadata-only v2 journal.
    if (this.view.confirming === 'publish' && this.runtime.majorDiscussionV2)
      return;
    const confirming = this.view.confirming,
      snapshot = this.snapshot,
      body = this.view.body,
      reply = this.view.replyTarget,
      selected = this.view.selectedComment,
      own = this.view.own,
      locator = this.ownLocator,
      deleteTarget = this.view.deleteTarget;
    if (
      confirming !== 'publish' &&
      confirming !== 'like' &&
      confirming !== 'unlike' &&
      confirming !== 'delete'
    )
      return;
    if (
      confirming === 'delete'
        ? !deleteTarget
        : confirming === 'unlike'
          ? !locator || own?.kind !== 'recorded' || !own.active
          : !snapshot ||
            !this.view.loaded ||
            (confirming === 'publish' ? !discussionBody(body) : !selected)
    )
      return;
    if (!this.restore() || this.pending) return;
    const accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot(),
      generation = this.continuation;
    let settled = false;
    await this.run(
      async (cancel) => {
        const requestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const source = {
          clientRequestId: requestId,
          expectedCatalogRevision:
            confirming === 'unlike' && own?.kind === 'recorded'
              ? own.catalogRevision
              : (snapshot?.catalogRevision ?? ''),
          expectedMajorRevision:
            confirming === 'unlike' && own?.kind === 'recorded'
              ? own.majorRevision
              : (snapshot?.majorRevision ?? ''),
        };
        const intent = decodeDiscussionIntent(
          confirming === 'delete'
            ? {
                operation: 'major.discussion.delete.v1',
                majorId: deleteTarget!.majorId,
                commentId: deleteTarget!.commentId,
                command: {
                  clientRequestId: requestId,
                  rootId: deleteTarget!.rootId,
                },
              }
            : confirming === 'unlike'
              ? {
                  operation: 'major.discussion.like.v1',
                  majorId: locator!.majorId,
                  commentId: locator!.commentId,
                  command: {
                    ...source,
                    active: false,
                    expectedMembershipRevision:
                      own!.kind === 'recorded' ? own!.revision : null,
                  },
                }
              : confirming === 'like'
                ? {
                    operation: 'major.discussion.like.v1',
                    majorId: snapshot!.majorId,
                    commentId: selected!.id,
                    command: {
                      ...source,
                      active: !selected!.isLiked,
                      expectedMembershipRevision:
                        selected!.myMembershipRevision,
                    },
                  }
                : this.selectedRootId
                  ? {
                      operation: 'major.discussion.reply.v1',
                      majorId: snapshot!.majorId,
                      rootId: this.selectedRootId,
                      command: {
                        ...source,
                        body,
                        replyToReplyId: reply?.id ?? null,
                      },
                    }
                  : {
                      operation: 'major.discussion.root.v1',
                      majorId: snapshot!.majorId,
                      command: { ...source, body },
                    },
        );
        this.runtime.pendingMajorDiscussion!.assertNewAdmission(accountId);
        if (this.runtime.majorDiscussionImages?.pending.load(accountId))
          throw new ClientError('storage', '请先恢复或取消原图片讨论请求');
        const p = this.runtime.pendingMajorDiscussion!.freeze({
          version: 1,
          origin: this.runtime.pendingMajorDiscussion!.origin,
          accountId,
          intent,
          phase: 'submit',
        });
        this.clearRead();
        this.showPending(p);
        return this.dispatch(p, cancel);
      },
      (r) => {
        this.settle(r);
        settled = true;
      },
      (e) => {
        this.clearRead();
        this.restore();
        this.update({ error: majorDiscussionError(e) });
      },
    );
    if (settled && generation === this.continuation) {
      await this.reload();
      if (
        generation === this.continuation &&
        this.mode === 'recovery' &&
        locator
      )
        await this.lookupOwn();
    }
  }
  private assertAttempt(
    p: PendingMajorDiscussion,
    cancel: Cancellation,
    recovery = false,
  ): void {
    if (cancel.isCancelled) throw new ClientError('cancelled', 'Cancelled');
    if (p.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    if (recovery)
      this.runtime.pendingMajorDiscussion!.assertRecoveryOriginal(p);
    else this.runtime.pendingMajorDiscussion!.assertOriginal(p);
  }
  private dispatch(
    p: PendingMajorDiscussion,
    cancel: Cancellation,
  ): Promise<DiscussionReceipt> {
    this.assertAttempt(p, cancel);
    return p.phase === 'cancel'
      ? this.runtime.majorDiscussion!.cancel(p.intent, cancel)
      : this.runtime.majorDiscussion!.submit(p.intent, cancel);
  }
  async recover(retry = false, prepareCancel = false): Promise<void> {
    if (this.view.busy || !this.ready() || !this.restore() || !this.pending)
      return;
    const p = this.pending,
      generation = this.continuation;
    this.clearRead();
    this.update({ receiptMissing: false });
    let settled = false;
    await this.run(
      async (cancel) => {
        this.assertAttempt(p, cancel, true);
        try {
          return await this.runtime.majorDiscussion!.receipt(
            p.intent.command.clientRequestId,
            cancel,
            p.intent.operation,
          );
        } catch (e) {
          if (!missing(e)) throw e;
          this.assertAttempt(p, cancel);
          if (retry) return this.dispatch(p, cancel);
          throw e;
        }
      },
      (r) => {
        this.settle(r);
        settled = true;
      },
      (e) => {
        this.showPending(p);
        this.update({
          receiptMissing: missing(e),
          confirming:
            missing(e) && prepareCancel && p.phase === 'submit'
              ? 'cancel'
              : null,
          error: majorDiscussionError(e),
        });
      },
    );
    if (settled && generation === this.continuation) await this.reload();
  }
  async confirmCancellation(): Promise<void> {
    if (
      this.view.busy ||
      this.view.confirming !== 'cancel' ||
      !this.view.receiptMissing ||
      !this.pending ||
      !this.ready()
    )
      return;
    const p = this.pending,
      generation = this.continuation;
    let settled = false;
    await this.run(
      async (cancel) => {
        this.assertAttempt(p, cancel);
        const next = this.runtime.pendingMajorDiscussion!.beginCancellation(p);
        this.showPending(next);
        return this.dispatch(next, cancel);
      },
      (r) => {
        this.settle(r);
        settled = true;
      },
      (e) => {
        this.clearRead();
        this.restore();
        this.update({ receiptMissing: false, error: majorDiscussionError(e) });
      },
    );
    if (settled && generation === this.continuation) await this.reload();
  }
  private settle(receipt: DiscussionReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidDiscussion();
    const intent = this.pending.intent,
      result = this.runtime.pendingMajorDiscussion!.settle(
        this.pending,
        receipt,
      );
    const locatorState =
      this.runtime.pendingMajorDiscussion!.deletionLocatorState(
        this.pending.accountId,
      );
    this.pending = null;
    this.clearRead();
    this.update({
      deletionLocators: locatorState.items,
      deletionLocatorUnavailable: locatorState.unavailable,
      frozen: false,
      recoveryMajorId: '',
      recoveryOperation: '',
      recoveryCommentId: '',
      recoveryPhase: '',
      receiptMissing: false,
      body: '',
      bodyBytes: 0,
      ...(intent.operation === 'major.discussion.like.v1'
        ? { ownMajorDraft: intent.majorId, ownCommentDraft: intent.commentId }
        : {}),
      receiptStatus:
        result.outcome === 'rejected'
          ? result.code === 'MAJOR_DISCUSSION_CANCELLED'
            ? '服务端已确认取消原请求；延迟到达的原请求不会再写入。'
            : result.code === 'CONTENT_REJECTED'
              ? '原文未通过审核，原请求已确认未写入。'
              : '原请求已确认未写入；请重新加载当前版本后明确确认。'
          : '原请求已确认完成。这是历史回执；当前内容与点赞状态需单独重新读取。',
    });
  }
  threadPath(id: string): string | null {
    if (
      this.view.busy ||
      !this.view.loaded ||
      this.mode !== 'roots' ||
      !this.view.items.some((i) => i.id === id)
    )
      return null;
    return `/pages/major-discussion-thread/major-discussion-thread?majorId=${this.selectedMajorId}&rootId=${id}`;
  }
  override cancel(): void {
    this.continuation++;
    super.cancel();
    this.clearRead();
    this.update({ body: '', bodyBytes: 0, receiptMissing: false });
    this.restore();
  }
}
