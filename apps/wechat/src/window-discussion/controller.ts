import { decodeDiscussionV2Page } from './v2-contract';
import type { WindowDiscussionComposition } from './image-runtime';
import { ClientError, clientError } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import { windowId } from '../window-ratings/contract';
import {
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
} from './contract';
import type {
  PendingWindowDiscussion,
  DiscussionOwnReference,
} from './pending';
export type DiscussionMode = 'roots' | 'thread' | 'recovery';
export interface WindowDiscussionView extends CommunityView {
  readonly mode: DiscussionMode;
  readonly loaded: boolean;
  readonly windowId: string;
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
  readonly confirming: 'publish' | 'like' | 'unlike' | 'cancel' | null;
  readonly selectedComment: DiscussionItem | null;
  readonly frozen: boolean;
  readonly recoveryWindowId: string;
  readonly recoveryOperation: string;
  readonly recoveryCommentId: string;
  readonly recoveryPhase: string;
  readonly receiptMissing: boolean;
  readonly receiptStatus: string;
  readonly ownWindowDraft: string;
  readonly ownCommentDraft: string;
  readonly own: DiscussionOwn | null;
  readonly canUnlike: boolean;
  readonly focusCommentId: string;
  readonly ownReferences: readonly DiscussionOwnReference[];
}
export const initialWindowDiscussionView = (): WindowDiscussionView => ({
  ...initialCommunityView(),
  mode: 'roots',
  loaded: false,
  windowId: '',
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
  recoveryWindowId: '',
  recoveryOperation: '',
  recoveryCommentId: '',
  recoveryPhase: '',
  receiptMissing: false,
  receiptStatus: '',
  ownWindowDraft: '',
  ownCommentDraft: '',
  own: null,
  canUnlike: false,
  focusCommentId: '',
  ownReferences: [],
});
export function windowDiscussionError(error: unknown): string {
  const f = clientError(error);
  if (f.kind === 'protocol') return communityError(f);
  return (
    (
      {
        PHONE_VERIFICATION_REQUIRED:
          '请先验证手机号；原操作回执和自己的点赞仍可独立查询',
        WINDOW_CATALOG_UNAVAILABLE: '窗口来源暂不能确认；原操作仍可独立恢复',
        WINDOW_NOT_FOUND: '窗口当前不可查看；原操作仍可独立恢复',
        WINDOW_DISCUSSION_NOT_FOUND: '这条评论当前不可查看，请重新加载',
        WINDOW_DISCUSSION_BUDGET_UNAVAILABLE:
          '完整讨论当前无法核验，暂不展示不完整的内容或数量；这不代表没有评论',
        WINDOW_DISCUSSION_NOTICE_NOT_FOUND:
          '此通知不存在或不属于当前账号，请重新核验通知列表',
        DISCOVERY_RESTART_REQUIRED:
          '讨论或通知已变化，请从第一页重新核验；旧分页已清除',
        WINDOW_DISCUSSION_HISTORY_UNAVAILABLE:
          '评论或点赞历史暂不能确认，不能当作没有评论或零个赞',
        WINDOW_DISCUSSION_MEMBERSHIP_CONFLICT:
          '自己的点赞已在别处变化，请重新查询并明确确认',
        WINDOW_REVISION_CONFLICT: '窗口目录已变化，请刷新后重新确认',
        WINDOW_DISCUSSION_CURSOR_INVALID: '分页已失效，请从第一页重新加载',
        WINDOW_DISCUSSION_RESTART_REQUIRED:
          '评论或排序已变化，请从第一页重新加载',
        WINDOW_DISCUSSION_TARGET_UNAVAILABLE:
          '这条通知的当前内容不可查看，未打开旧内容',
        REQUEST_NOT_FOUND:
          '暂未查到原回执；重试仍使用原请求，取消必须取得服务端回执',
        CONTENT_REVIEW_UNAVAILABLE:
          '当前内容审核暂不能确认；待确认的原请求仍可查询或明确取消',
        SAFETY_ACTION_RESTRICTED:
          '当前账号暂不能访问公开讨论；原回执和自己的点赞仍可独立查询',
      } as Record<string, string>
    )[f.details.serverCode ?? ''] ?? communityError(error)
  );
}
const missing = (e: unknown): boolean => {
  const f = clientError(e);
  return (
    f.kind !== 'protocol' &&
    f.details.httpStatus === 404 &&
    f.details.serverCode === 'REQUEST_NOT_FOUND'
  );
};
export class WindowDiscussionController extends CommunityController<WindowDiscussionView> {
  private imageCount = 0;
  private imageBlocked = false;
  private continuation = 0;
  private selectedWindowId: string | null = null;
  private selectedRootId: string | null = null;
  private snapshot: DiscussionPage | null = null;
  private pending: PendingWindowDiscussion | null = null;
  private ownLocator: { windowId: string; commentId: string } | null = null;
  private notice: { noticeId: string; target: DiscussionTarget } | null = null;
  constructor(
    runtime: CommunityRuntime,
    private readonly mode: DiscussionMode,
    render: (v: WindowDiscussionView) => void,
  ) {
    super(runtime, initialWindowDiscussionView, render);
    this.update({ mode });
  }
  protected override preserveForNativePicker(): boolean {
    return this.runtime.windowDiscussionImages?.pickerActive ?? false;
  }
  protected override resetPrivate(): void {
    this.imageCount = 0;
    this.imageBlocked = false;
    this.continuation++;
    this.snapshot = null;
    this.pending = null;
    this.ownLocator = null;
  }
  private ready(): boolean {
    if (!this.available()) return false;
    if (
      !this.runtime.windowDiscussion ||
      !this.runtime.pendingWindowDiscussion
    ) {
      this.update({
        error: '当前构建未配置窗口讨论服务',
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
    if (!accountId || !this.runtime.pendingWindowDiscussion) return false;
    try {
      this.update({
        ownReferences:
          this.runtime.pendingWindowDiscussion.references(accountId),
      });
      this.pending = this.runtime.pendingWindowDiscussion.load(accountId);
      if (this.pending) this.showPending(this.pending);
      else
        this.update({
          frozen: false,
          recoveryWindowId: '',
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
        error: windowDiscussionError(e),
        status: '原请求暂不能读取，不能创建替代请求',
      });
      return false;
    }
  }
  private showPending(p: PendingWindowDiscussion): void {
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
      recoveryWindowId: i.windowId,
      recoveryOperation: i.operation,
      recoveryCommentId:
        i.operation === 'window.discussion.like.v1'
          ? i.commentId
          : i.operation === 'window.discussion.reply.v1'
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
        : !windowId(id)) ||
      (this.mode === 'thread' ? !windowId(rootId) : rootId !== null)
    ) {
      this.update({ error: '窗口讨论入口无效' });
      return;
    }
    if (this.selectedWindowId !== id || this.selectedRootId !== rootId) {
      this.continuation++;
      this.clearRead();
      this.update({ body: '', bodyBytes: 0, canPublish: false });
    }
    this.selectedWindowId = id;
    this.selectedRootId = rootId;
    this.notice = notice;
    this.update({
      mode: this.mode,
      windowId: id ?? '',
      rootId: rootId ?? '',
      ownWindowDraft: id ?? '',
      focusCommentId: notice?.target.commentId ?? '',
    });
    await this.reload();
  }
  async reload(): Promise<void> {
    if (this.view.busy || !this.ready()) return;
    const valid = this.restore();
    if (this.selectedWindowId) await this.loadPage(null);
    else if (valid)
      this.update({
        status: this.pending
          ? '原讨论操作结果待确认'
          : '当前账号没有待确认的窗口讨论操作',
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
    const id = this.selectedWindowId;
    if (!id) return;
    const prior = this.snapshot,
      rootId = this.selectedRootId,
      sort = this.view.sort,
      pageNumber = cursor ? this.view.pageNumber + 1 : 1,
      notice = this.notice;
    this.clearRead();
    this.update({ restartRequired: false, status: '正在核验窗口讨论' });
    await this.run(
      async (cancel) => {
        if (notice) {
          const t = decodeDiscussionTarget(
            await (this.runtime.windowDiscussionV2 ??
              this.runtime.windowDiscussion)!.target(notice.noticeId, cancel),
          );
          if (
            t.windowId !== id ||
            t.rootId !== rootId ||
            t.commentId !== notice.target.commentId
          )
            invalidDiscussion();
          if (cancel.isCancelled)
            throw new ClientError('cancelled', 'Cancelled');
        }
        const p = (
          this.runtime.windowDiscussionV2
            ? decodeDiscussionV2Page
            : decodeDiscussionPage
        )(
          await (this.runtime.windowDiscussionV2 ??
            this.runtime.windowDiscussion)!.list(
            id,
            rootId,
            sort,
            cursor,
            cancel,
          ),
        );
        if (
          p.windowId !== id ||
          (p.root?.id ?? null) !== rootId ||
          (cursor && p.nextCursor === cursor)
        )
          invalidDiscussion();
        if (
          cursor &&
          (!prior ||
            prior.catalogRevision !== p.catalogRevision ||
            prior.windowRevision !== p.windowRevision ||
            prior.discussionRevision !== p.discussionRevision)
        )
          throw new ClientError('business', 'Discussion changed', {
            serverCode: 'WINDOW_DISCUSSION_RESTART_REQUIRED',
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
              : '当前已确认没有' + (rootId ? '回复' : '评论'),
        });
      },
      (e) => {
        this.clearRead();
        this.update({
          pageNumber: 0,
          restartRequired: cursor !== null,
          error: windowDiscussionError(e),
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
    return (
      !this.imageBlocked &&
      (discussionBody(body) || (body === '' && this.imageCount > 0))
    );
  }
  setImages(count: number, blocked: boolean): void {
    this.imageCount = count;
    this.imageBlocked = blocked;
    this.update({
      canPublish:
        this.view.loaded &&
        !this.view.frozen &&
        this.validComposition(this.view.body),
    });
  }
  composition(): WindowDiscussionComposition | null {
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
      windowId: p.windowId,
      catalogRevision: p.catalogRevision,
      windowRevision: p.windowRevision,
      rootId: this.selectedRootId,
      replyToReplyId: this.view.replyTarget?.id ?? null,
    };
  }
  publication(): { context: WindowDiscussionComposition; body: string } | null {
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
  closeConfirmation(): void {
    if (this.view.busy) return;
    this.update({ confirming: null, selectedComment: null });
  }
  setOwnLocator(field: 'window' | 'comment', value: string): void {
    if (this.view.busy || this.view.confirming || this.view.frozen) return;
    this.ownLocator = null;
    this.update({
      [field === 'window' ? 'ownWindowDraft' : 'ownCommentDraft']: value,
      own: null,
      canUnlike: false,
    });
  }
  async chooseOwnReference(commentId: string): Promise<void> {
    if (this.view.busy || this.view.confirming || this.view.frozen) return;
    const ref = this.view.ownReferences.find((r) => r.commentId === commentId);
    if (!ref) return;
    this.update({
      ownWindowDraft: ref.windowId,
      ownCommentDraft: ref.commentId,
    });
    await this.lookupOwn();
  }
  async lookupOwn(): Promise<void> {
    if (this.view.busy || !this.ready() || !this.restore() || this.pending)
      return;
    const windowIdValue = this.view.ownWindowDraft,
      commentId = this.view.ownCommentDraft;
    this.ownLocator = null;
    this.update({ own: null, canUnlike: false, confirming: null });
    if (!windowId(windowIdValue) || !windowId(commentId)) {
      this.update({ error: '请输入完整有效的窗口与评论编号' });
      return;
    }
    await this.run(
      async (cancel) =>
        decodeDiscussionOwn(
          await this.runtime.windowDiscussion!.own(
            windowIdValue,
            commentId,
            cancel,
          ),
        ),
      (own) => {
        if (!this.restore() || this.pending) return;
        this.ownLocator = { windowId: windowIdValue, commentId };
        this.update({
          own,
          canUnlike: own.kind === 'recorded' && own.active,
          status:
            own.kind === 'unavailable'
              ? '自己的点赞历史暂不能确认'
              : '自己的当前点赞已查询',
        });
      },
      (e) => this.update({ error: windowDiscussionError(e) }),
    );
  }
  confirmUnlike(): void {
    if (
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
    if (this.view.busy || this.view.frozen || !this.ready()) return;
    const confirming = this.view.confirming,
      snapshot = this.snapshot,
      body = this.view.body,
      reply = this.view.replyTarget,
      selected = this.view.selectedComment,
      own = this.view.own,
      locator = this.ownLocator;
    if (
      confirming !== 'publish' &&
      confirming !== 'like' &&
      confirming !== 'unlike'
    )
      return;
    if (
      confirming === 'unlike'
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
              : snapshot!.catalogRevision,
          expectedWindowRevision:
            confirming === 'unlike' && own?.kind === 'recorded'
              ? own.windowRevision
              : snapshot!.windowRevision,
        };
        const intent = decodeDiscussionIntent(
          confirming === 'unlike'
            ? {
                operation: 'window.discussion.like.v1',
                windowId: locator!.windowId,
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
                  operation: 'window.discussion.like.v1',
                  windowId: snapshot!.windowId,
                  commentId: selected!.id,
                  command: {
                    ...source,
                    active: !selected!.isLiked,
                    expectedMembershipRevision: selected!.myMembershipRevision,
                  },
                }
              : this.selectedRootId
                ? {
                    operation: 'window.discussion.reply.v1',
                    windowId: snapshot!.windowId,
                    rootId: this.selectedRootId,
                    command: {
                      ...source,
                      body,
                      replyToReplyId: reply?.id ?? null,
                    },
                  }
                : {
                    operation: 'window.discussion.root.v1',
                    windowId: snapshot!.windowId,
                    command: { ...source, body },
                  },
        );
        const p = this.runtime.pendingWindowDiscussion!.freeze({
          version: 1,
          origin: this.runtime.pendingWindowDiscussion!.origin,
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
        this.update({ error: windowDiscussionError(e) });
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
    p: PendingWindowDiscussion,
    cancel: Cancellation,
  ): void {
    if (cancel.isCancelled) throw new ClientError('cancelled', 'Cancelled');
    if (p.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    this.runtime.pendingWindowDiscussion!.assertOriginal(p);
  }
  private dispatch(
    p: PendingWindowDiscussion,
    cancel: Cancellation,
  ): Promise<DiscussionReceipt> {
    this.assertAttempt(p, cancel);
    return p.phase === 'cancel'
      ? this.runtime.windowDiscussion!.cancel(p.intent, cancel)
      : this.runtime.windowDiscussion!.submit(p.intent, cancel);
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
        this.assertAttempt(p, cancel);
        try {
          return await this.runtime.windowDiscussion!.receipt(
            p.intent.command.clientRequestId,
            cancel,
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
          error: windowDiscussionError(e),
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
        const next = this.runtime.pendingWindowDiscussion!.beginCancellation(p);
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
        this.update({ receiptMissing: false, error: windowDiscussionError(e) });
      },
    );
    if (settled && generation === this.continuation) await this.reload();
  }
  private settle(receipt: DiscussionReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidDiscussion();
    const intent = this.pending.intent,
      result = this.runtime.pendingWindowDiscussion!.settle(
        this.pending,
        receipt,
      );
    this.pending = null;
    this.clearRead();
    this.update({
      frozen: false,
      recoveryWindowId: '',
      recoveryOperation: '',
      recoveryCommentId: '',
      recoveryPhase: '',
      receiptMissing: false,
      body: '',
      bodyBytes: 0,
      ...(intent.operation === 'window.discussion.like.v1'
        ? { ownWindowDraft: intent.windowId, ownCommentDraft: intent.commentId }
        : {}),
      receiptStatus:
        result.outcome === 'rejected'
          ? result.code === 'WINDOW_DISCUSSION_CANCELLED'
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
    return `/pages/window-discussion-thread/window-discussion-thread?windowId=${this.selectedWindowId}&rootId=${id}`;
  }
  override cancel(): void {
    this.continuation++;
    super.cancel();
    this.clearRead();
    this.update({ body: '', bodyBytes: 0, receiptMissing: false });
    this.restore();
  }
}
