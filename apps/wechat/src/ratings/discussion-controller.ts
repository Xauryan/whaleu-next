import { isRatingTargetCoverIntent } from './target-cover-contract';
import { isRatingCategoryScopedIntent, isRatingScopedIntent } from './pending';
import { ratingDeletionPath } from './deletion-contract';
import { decodeRatingSubscriptionNoticeTarget } from './subscription-updates-contract';
import { readRatingLikeStates, type RatingLikeStates } from './like-controller';
import { decodeRatingLikeNoticeTarget } from './like-updates-contract';
import { ClientError, isRecord } from '../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import {
  canonicalRatingText,
  decodeRatingTarget,
  invalidRating,
  ratingId,
  type RatingAuthorMode,
  type RatingTarget,
} from './contract';
import { ratingError } from './controller';
import {
  ratingCommandLabels,
  runRatingCommand,
  settleRatingCommand,
} from './commands';
import {
  decodeRatingDiscussion,
  decodeRatingReplyPage,
  decodeRatingReplyPosition,
  type RatingDiscussionContext,
  type RatingReply,
  type RatingReplyPage,
} from './discussion-contract';
import {
  decodeRatingCommandIntent,
  isRatingSubscriptionIntent,
  isRatingCategoryCreationIntent,
  isRatingTargetCreationIntent,
  isRatingTargetOwnerEditingIntent,
  isRatingTargetOwnerDeletionIntent,
  isRatingAdminDeletionIntent,
  isRatingDeletionContextChanged,
  type RatingCommandIntent,
  type PendingRating,
  type RatingCommandReceipt,
} from './pending';
import {
  decodeRatingNoticeRead,
  decodeRatingNoticeTarget,
  type RatingNoticeLocator,
} from './updates-contract';
export interface RatingThreadRoute {
  readonly regionId?: string;
  readonly targetId: string;
  readonly rootId: string;
  readonly replyId?: string;
  readonly noticeId?: string;
  readonly likeNoticeId?: string;
  readonly subscriptionNoticeId?: string;
}
export function decodeRatingThreadRoute(value: unknown): RatingThreadRoute {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'regionId',
          'targetId',
          'rootId',
          'replyId',
          'noticeId',
          'likeNoticeId',
          'subscriptionNoticeId',
        ].includes(key),
    ) ||
    Object.values(value).some((id) => !ratingId(id)) ||
    !ratingId(value.targetId) ||
    !ratingId(value.rootId) ||
    (value.noticeId !== undefined && !ratingId(value.replyId)) ||
    [value.noticeId, value.likeNoticeId, value.subscriptionNoticeId].filter(
      (id) => id !== undefined,
    ).length > 1
  )
    invalidRating();
  return Object.freeze({
    targetId: value.targetId,
    rootId: value.rootId,
    ...(value.regionId ? { regionId: value.regionId as string } : {}),
    ...(value.replyId ? { replyId: value.replyId as string } : {}),
    ...(value.noticeId ? { noticeId: value.noticeId as string } : {}),
    ...(value.subscriptionNoticeId
      ? { subscriptionNoticeId: value.subscriptionNoticeId as string }
      : {}),
    ...(value.likeNoticeId
      ? { likeNoticeId: value.likeNoticeId as string }
      : {}),
  });
}
export function ratingThreadPath(
  target: RatingNoticeLocator,
  noticeId?: string,
): string {
  return `/pages/rating-thread/rating-thread?targetId=${target.targetId}&rootId=${target.rootId}&replyId=${target.replyId}${target.regionId ? `&regionId=${target.regionId}` : ''}${noticeId ? `&noticeId=${noticeId}` : ''}`;
}
export interface RatingThreadView extends CommunityView {
  readonly loaded: boolean;
  readonly collapsed: boolean;
  readonly detail: RatingTarget | null;
  readonly discussion: RatingDiscussionContext | null;
  readonly replies: readonly RatingReply[];
  readonly likes: RatingLikeStates;
  readonly canMore: boolean;
  readonly anchorReplyId: string;
  readonly composerOpen: boolean;
  readonly replyToId: string | null;
  readonly replyToName: string;
  readonly text: string;
  readonly textLength: number;
  readonly authorMode: RatingAuthorMode | null;
  readonly deleteId: string | null;
  readonly frozen: boolean;
  readonly recoveryOperation: string;
  readonly receiptStatus: string;
  readonly needsRefresh: boolean;
}
export const initialRatingThreadView = (): RatingThreadView => ({
  ...initialCommunityView(),
  loaded: false,
  collapsed: false,
  detail: null,
  discussion: null,
  replies: [],
  likes: {},
  canMore: false,
  anchorReplyId: '',
  composerOpen: false,
  replyToId: null,
  replyToName: '',
  text: '',
  textLength: 0,
  authorMode: null,
  deleteId: null,
  frozen: false,
  recoveryOperation: '',
  receiptStatus: '',
  needsRefresh: false,
});
/** Every transient body, quote, draft, cursor and request has the session and current route as its owner. */
export class RatingThreadController extends CommunityController<RatingThreadView> {
  private route: RatingThreadRoute | null = null;
  private pending: PendingRating | null = null;
  private cursor: string | null = null;
  private readonly seen = new Set<string>();
  private inactive = false;
  private readonly unsubscribeScope: () => void;
  private readonly unsubscribeBrowse: () => void;
  private readonly unsubscribeTarget: () => void;
  private readonly unsubscribeCatalog: () => void;
  constructor(
    runtime: CommunityRuntime,
    render: (view: RatingThreadView) => void,
  ) {
    super(runtime, initialRatingThreadView, render);
    const invalidate = (accountId?: string) => {
      if (accountId !== undefined && accountId !== this.accountId()) return;
      this.stop();
      this.resetPrivate();
      this.clearView();
      this.update({
        status: '身份或浏览校区已变化，正文、引用和输入已清除，请重新加载',
      });
    };
    this.unsubscribeScope =
      runtime.directoryScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeBrowse =
      runtime.browsingScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeCatalog =
      runtime.ratingCatalogChanges?.subscribe(() => {
        if (!this.accountId()) return;
        this.stop();
        this.clearContent();
        this.update({
          busy: false,
          needsRefresh: true,
          status: '评分分类目录已变化，评价、回复和输入已清除，请重新加载',
        });
      }) ?? (() => undefined);
    this.unsubscribeTarget =
      runtime.ratingTargetChanges?.subscribe((change) => {
        if (!this.accountId() || this.route?.targetId !== change.targetId)
          return;
        this.stop();
        this.clearContent();
        this.update({
          busy: false,
          needsRefresh: true,
          status: '评分对象已变化，评价、回复和输入已清除，请重新加载',
        });
      }) ?? (() => undefined);
    this.update({ configured: this.configured() });
  }
  private configured(): boolean {
    return (
      !!this.runtime.ratings &&
      !!this.runtime.ratingDiscussion &&
      !!this.runtime.pendingRatings
    );
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (!this.configured() || !this.accountId()) {
      this.update({
        configured: this.configured(),
        error: this.accountId()
          ? '当前构建尚未配置评分回复服务'
          : '请先登录后查看评分回复',
      });
      return false;
    }
    return true;
  }
  protected override resetPrivate(): void {
    this.pending = null;
    this.cursor = null;
    this.seen.clear();
  }
  protected override onSafetyInvalidated(): void {
    this.update({
      configured: this.configured(),
      status: '安全状态已变化，旧正文、引用和输入已清除，请重新加载',
    });
  }
  private clearView(): void {
    this.cursor = null;
    this.seen.clear();
    this.update({
      ...initialRatingThreadView(),
      hasSession: !!this.accountId(),
      configured: this.configured(),
    });
  }
  private clearContent(): void {
    this.cursor = null;
    this.seen.clear();
    this.update({
      loaded: false,
      detail: null,
      discussion: null,
      replies: [],
      likes: {},
      canMore: false,
      anchorReplyId: '',
      composerOpen: false,
      replyToId: null,
      replyToName: '',
      text: '',
      textLength: 0,
      authorMode: null,
      deleteId: null,
    });
  }
  private showPending(attempt: PendingRating): void {
    this.pending = attempt;
    this.update({
      frozen: true,
      recoveryOperation: ratingCommandLabels[attempt.intent.operation],
      status: '原请求仍待确认；只能查询或重试原请求',
    });
  }
  private loadJournal(): boolean {
    if (!this.available()) return false;
    try {
      this.pending = this.runtime.pendingRatings!.load(this.accountId()!);
      if (this.pending) this.showPending(this.pending);
      return true;
    } catch (error) {
      this.stop();
      this.clearContent();
      this.update({
        busy: false,
        frozen: true,
        error: ratingError(error),
        status: '无法读取原请求，禁止新建替代请求',
      });
      return false;
    }
  }
  async load(raw: unknown): Promise<void> {
    this.stop();
    this.resetPrivate();
    this.clearView();
    try {
      this.route = decodeRatingThreadRoute(raw);
    } catch {
      this.route = null;
    }
    if (!this.loadJournal()) return;
    if (this.pending) {
      await this.recover(false);
      return;
    }
    if (!this.route) {
      this.update({ error: '评分回复链接无效，请返回评价列表' });
      return;
    }
    await this.refresh();
  }
  currentRoute(): RatingThreadRoute | null {
    return this.route;
  }
  async reload(): Promise<void> {
    await this.load(this.route);
  }
  private validatePage(
    page: RatingReplyPage,
    discussion: RatingDiscussionContext,
  ): void {
    if (
      Object.entries(discussion.context).some(
        ([key, value]) =>
          page.context[key as keyof typeof discussion.context] !== value,
      )
    )
      invalidRating();
  }
  private async refresh(): Promise<void> {
    const route = this.route;
    if (!route || this.inactive || !this.available()) return;
    this.stop();
    this.clearContent();
    this.update({ collapsed: false });
    let loaded = false;
    await this.run(
      async (cancel) => {
        if (route.subscriptionNoticeId) {
          if (!this.runtime.ratingSubscriptionUpdates)
            throw new ClientError(
              'configuration',
              'Rating subscription updates unavailable',
            );
          const resolved = decodeRatingSubscriptionNoticeTarget(
            await this.runtime.ratingSubscriptionUpdates.target(
              route.subscriptionNoticeId,
              cancel,
            ),
          );
          if (
            resolved.noticeId !== route.subscriptionNoticeId ||
            resolved.status !== 'available' ||
            resolved.target.regionId !== (route.regionId ?? null) ||
            resolved.target.targetId !== route.targetId ||
            resolved.target.rootId !== route.rootId ||
            resolved.target.replyId !== (route.replyId ?? null)
          )
            throw new ClientError('business', 'Notice target unavailable', {
              serverCode: 'RATING_NOT_FOUND',
            });
        }
        if (route.likeNoticeId) {
          if (!this.runtime.ratingLikeUpdates)
            throw new ClientError(
              'configuration',
              'Rating like updates unavailable',
            );
          const resolved = decodeRatingLikeNoticeTarget(
            await this.runtime.ratingLikeUpdates.target(
              route.likeNoticeId,
              cancel,
            ),
          );
          if (
            resolved.noticeId !== route.likeNoticeId ||
            resolved.status !== 'available' ||
            resolved.target.regionId !== (route.regionId ?? null) ||
            resolved.target.targetId !== route.targetId ||
            resolved.target.rootId !== route.rootId ||
            resolved.target.replyId !== (route.replyId ?? null)
          )
            throw new ClientError('business', 'Notice target unavailable', {
              serverCode: 'RATING_NOT_FOUND',
            });
        }
        if (route.noticeId) {
          if (!this.runtime.ratingUpdates)
            throw new ClientError(
              'configuration',
              'Rating updates unavailable',
            );
          const resolved = decodeRatingNoticeTarget(
            await this.runtime.ratingUpdates.target(route.noticeId, cancel),
          );
          if (
            resolved.noticeId !== route.noticeId ||
            resolved.status !== 'available' ||
            resolved.target.regionId !== (route.regionId ?? null) ||
            resolved.target.targetId !== route.targetId ||
            resolved.target.rootId !== route.rootId ||
            resolved.target.replyId !== route.replyId
          )
            throw new ClientError('business', 'Notice target unavailable', {
              serverCode: 'RATING_NOT_FOUND',
            });
        }
        const detail = decodeRatingTarget(
          await this.runtime.ratings!.detail(
            route.regionId ?? null,
            route.targetId,
            cancel,
          ),
        );
        const discussion = decodeRatingDiscussion(
          await this.runtime.ratingDiscussion!.discussion(
            route.regionId ?? null,
            route.rootId,
            cancel,
          ),
        );
        if (
          detail.id !== route.targetId ||
          discussion.context.targetId !== route.targetId ||
          discussion.context.rootId !== route.rootId ||
          discussion.context.regionId !== (route.regionId ?? null)
        )
          invalidRating();
        let page: RatingReplyPage;
        if (route.replyId) {
          const position = decodeRatingReplyPosition(
            await this.runtime.ratingDiscussion!.position(
              route.regionId ?? null,
              route.replyId,
              cancel,
            ),
          );
          if (position.anchorReplyId !== route.replyId) invalidRating();
          page = position.page;
        } else
          page = decodeRatingReplyPage(
            await this.runtime.ratingDiscussion!.replies(
              route.regionId ?? null,
              route.rootId,
              null,
              cancel,
            ),
          );
        this.validatePage(page, discussion);
        const likes = await readRatingLikeStates(
          this.runtime.ratingLikes,
          route.regionId ?? null,
          [
            { targetId: route.targetId, rootId: route.rootId, replyId: null },
            ...page.items.map((item) => ({
              targetId: item.targetId,
              rootId: item.rootId,
              replyId: item.id,
            })),
          ],
          cancel,
        );
        return { detail, discussion, page, likes };
      },
      (result) => {
        this.cursor = result.page.nextCursor;
        this.update({
          loaded: true,
          detail: result.detail,
          discussion: result.discussion,
          replies: result.page.items,
          likes: result.likes,
          canMore: !!result.page.nextCursor,
          anchorReplyId: route.replyId ?? '',
          needsRefresh: false,
          status: route.replyId
            ? '已定位当前可见回复；继续读取可查看后续回复'
            : '已读取当前可见评价与回复，最早在前',
        });
        loaded = true;
      },
      (error) => {
        this.clearContent();
        this.update({
          error: ratingError(error),
          status: '当前回复内容不能确认，旧内容和分页已清除',
        });
      },
    );
    // Mark only after the receiving page's actual position read was applied. Navigation success alone never marks read.
    if (
      loaded &&
      !this.inactive &&
      this.route === route &&
      this.view.loaded &&
      (route.noticeId || route.likeNoticeId || route.subscriptionNoticeId) &&
      this.accountId()
    ) {
      await this.run(
        (cancel) =>
          route.subscriptionNoticeId
            ? this.runtime.ratingSubscriptionUpdates!.markRead(
                route.subscriptionNoticeId,
                cancel,
              )
            : route.likeNoticeId
              ? this.runtime.ratingLikeUpdates!.markRead(
                  route.likeNoticeId,
                  cancel,
                )
              : this.runtime.ratingUpdates!.markRead(route.noticeId!, cancel),
        (raw) => {
          const receipt = decodeRatingNoticeRead(raw);
          if (
            receipt.noticeId !==
            (route.subscriptionNoticeId ?? route.likeNoticeId ?? route.noticeId)
          )
            invalidRating();
          this.update({
            status: route.subscriptionNoticeId
              ? '已定位当前订阅内容，并确认这条订阅更新已读'
              : route.likeNoticeId
                ? '已定位当前被赞内容，并确认这条赞已读'
                : '已定位当前回复，并确认这条评分更新已读',
          });
        },
        (error) => {
          this.update({
            error: ratingError(error),
            status: route.subscriptionNoticeId
              ? '订阅内容已读取，但这条订阅更新的已读状态尚未确认'
              : route.likeNoticeId
                ? '被赞内容已读取，但这条赞的已读状态尚未确认'
                : '回复已读取，但这条更新的已读状态尚未确认',
          });
        },
      );
    }
  }
  collapse(): void {
    this.stop();
    this.clearContent();
    this.update({
      busy: false,
      collapsed: true,
      status: '回复已收起，正文、引用和输入已清除',
    });
  }
  async expand(): Promise<void> {
    if (!this.view.busy && !this.view.frozen && this.view.collapsed)
      await this.reload();
  }
  async first(): Promise<void> {
    if (this.view.busy || this.view.frozen || !this.route) return;
    const route: RatingThreadRoute = {
      targetId: this.route.targetId,
      rootId: this.route.rootId,
      ...(this.route.regionId ? { regionId: this.route.regionId } : {}),
    };
    await this.load(route);
  }
  async more(): Promise<void> {
    const discussion = this.view.discussion,
      cursor = this.cursor;
    if (
      !this.available() ||
      !this.view.loaded ||
      this.view.busy ||
      !discussion ||
      !cursor
    )
      return;
    this.closeForm();
    await this.run(
      async (cancel) => {
        const page = decodeRatingReplyPage(
          await this.runtime.ratingDiscussion!.replies(
            discussion.context.regionId,
            discussion.context.rootId,
            cursor,
            cancel,
          ),
        );
        this.validatePage(page, discussion);
        const likes = await readRatingLikeStates(
          this.runtime.ratingLikes,
          discussion.context.regionId,
          page.items.map((item) => ({
            targetId: item.targetId,
            rootId: item.rootId,
            replyId: item.id,
          })),
          cancel,
        );
        return { page, likes };
      },
      ({ page, likes }) => {
        this.validatePage(page, discussion);
        if (
          page.nextCursor &&
          (page.nextCursor === cursor || this.seen.has(page.nextCursor))
        )
          invalidRating();
        this.seen.add(cursor);
        this.cursor = page.nextCursor;
        const items = new Map(this.view.replies.map((item) => [item.id, item]));
        for (const item of page.items) items.set(item.id, item);
        this.update({
          replies: [...items.values()],
          likes: { ...this.view.likes, ...likes },
          canMore: !!page.nextCursor,
          status:
            page.continuation === 'end'
              ? '已到当前范围末尾'
              : '已读取当前页，可继续读取',
        });
      },
      (error) => {
        this.clearContent();
        this.update({
          error: ratingError(error),
          status: '分页已清除，请重新加载',
        });
      },
    );
  }
  private canWrite(): boolean {
    return (
      !this.inactive &&
      !this.view.busy &&
      !this.view.frozen &&
      this.view.loaded &&
      !!this.view.detail &&
      !!this.view.discussion &&
      this.available()
    );
  }
  compose(replyId: string | null = null): void {
    if (!this.canWrite() || !this.view.discussion?.allowedActions.createReply)
      return;
    const reply =
      replyId === null
        ? null
        : this.view.replies.find(
            (item) => item.id === replyId && item.allowedActions.reply,
          );
    if (replyId !== null && !reply) return;
    this.update({
      composerOpen: true,
      replyToId: replyId,
      replyToName:
        reply?.author.displayName ??
        this.view.discussion.root.author.displayName,
      text: '',
      textLength: 0,
      authorMode: null,
      deleteId: null,
    });
  }
  setText(text: string): void {
    if (
      !this.inactive &&
      !this.view.busy &&
      !this.view.frozen &&
      this.view.composerOpen &&
      typeof text === 'string'
    )
      this.update({
        text,
        textLength: [...text.replace(/\r\n/g, '\n').trim()].length,
      });
  }
  setAuthorMode(authorMode: RatingAuthorMode): void {
    if (
      !this.inactive &&
      !this.view.busy &&
      !this.view.frozen &&
      this.view.composerOpen &&
      this.view.discussion?.allowedActions.authorModes.includes(authorMode)
    )
      this.update({ authorMode });
  }
  private closeForm(): void {
    this.update({
      composerOpen: false,
      replyToId: null,
      replyToName: '',
      text: '',
      textLength: 0,
      authorMode: null,
      deleteId: null,
    });
  }
  dismiss(): void {
    const busy = this.view.busy;
    this.stop();
    this.closeForm();
    this.update({ busy: false });
    if (busy) {
      this.clearContent();
      this.update({ status: '已停止等待，原请求如已发送仍需查询回执' });
    }
  }
  async publish(): Promise<void> {
    const discussion = this.view.discussion,
      detail = this.view.detail,
      authorMode = this.view.authorMode;
    if (
      !this.canWrite() ||
      !this.view.composerOpen ||
      !discussion?.allowedActions.createReply ||
      !detail ||
      !authorMode ||
      !discussion.allowedActions.authorModes.includes(authorMode)
    )
      return;
    const reply =
      this.view.replyToId === null
        ? null
        : this.view.replies.find(
            (item) =>
              item.id === this.view.replyToId && item.allowedActions.reply,
          );
    if (this.view.replyToId !== null && !reply) return;
    let body: string;
    try {
      body = canonicalRatingText(this.view.text);
    } catch {
      this.update({
        error: '请填写 1–500 个 Unicode 字符的纯文字，不能包含无效控制字符',
      });
      return;
    }
    await this.start((clientRequestId) => ({
      operation: 'create_reply',
      rootId: discussion.context.rootId,
      payload: {
        clientRequestId,
        regionId: discussion.context.regionId,
        targetId: detail.id,
        expectedTargetRevision: detail.revision,
        expectedRootRevision: discussion.root.revision,
        replyTo: reply
          ? { replyId: reply.id, expectedRevision: reply.revision }
          : null,
        authorMode,
        body,
        assetIds: [],
      },
    }));
  }
  deletionPath(id?: string): string | null {
    if (
      this.inactive ||
      this.view.busy ||
      this.view.frozen ||
      !this.available() ||
      !this.route
    )
      return null;
    const route = this.route,
      subjectId = id ?? route.replyId ?? route.rootId;
    // A hidden-parent cleanup may use only an already-known route locator, never an enumerated history.
    const known =
      subjectId === route.rootId ||
      subjectId === route.replyId ||
      this.view.replies.some(
        (item) =>
          item.id === subjectId &&
          item.targetId === route.targetId &&
          item.rootId === route.rootId,
      );
    if (!known) return null;
    return ratingDeletionPath({
      subjectKind: subjectId === route.rootId ? 'comment' : 'reply',
      targetId: route.targetId,
      rootId: route.rootId,
      subjectId,
    });
  }
  confirmDelete(id: string): void {
    if (
      !this.canWrite() ||
      !this.view.replies.some(
        (item) => item.id === id && item.isMine && item.allowedActions.delete,
      )
    )
      return;
    this.closeForm();
    this.update({ deleteId: id });
  }
  async deleteReply(): Promise<void> {
    const discussion = this.view.discussion,
      detail = this.view.detail,
      reply = this.view.replies.find((item) => item.id === this.view.deleteId);
    if (
      !this.canWrite() ||
      !discussion ||
      !detail ||
      !reply?.isMine ||
      !reply.allowedActions.delete
    )
      return;
    await this.start((clientRequestId) => ({
      operation: 'delete_reply',
      replyId: reply.id,
      payload: {
        clientRequestId,
        regionId: discussion.context.regionId,
        targetId: detail.id,
        rootId: discussion.context.rootId,
        expectedTargetRevision: detail.revision,
        expectedRootRevision: discussion.root.revision,
        expectedRevision: reply.revision,
      },
    }));
  }
  async toggleLike(id: string): Promise<void> {
    const discussion = this.view.discussion,
      detail = this.view.detail,
      state = this.view.likes[id];
    if (
      !this.canWrite() ||
      !this.runtime.ratingLikes ||
      !discussion ||
      !detail ||
      state?.status !== 'known' ||
      !state.allowedActions.setLike
    )
      return;
    const root = discussion.root;
    const reply =
      id === root.id ? null : this.view.replies.find((item) => item.id === id);
    if (id !== root.id && !reply) return;
    await this.start((clientRequestId) => {
      const payload = {
        clientRequestId,
        regionId: discussion.context.regionId,
        targetId: detail.id,
        expectedTargetRevision: detail.revision,
        expectedRevision: reply?.revision ?? root.revision,
        expectedLikeRevision: state.revision,
        liked: !state.liked,
      };
      return reply
        ? {
            operation: 'set_reply_like',
            replyId: reply.id,
            payload: {
              ...payload,
              rootId: root.id,
              expectedRootRevision: root.revision,
            },
          }
        : { operation: 'set_comment_like', rootId: root.id, payload };
    });
  }
  private async start(
    make: (id: string) => RatingCommandIntent,
  ): Promise<void> {
    if (!this.loadJournal() || this.pending) return;
    const owner = this.runtime.sessions.snapshot(),
      accountId = this.accountId()!;
    let refresh = false;
    await this.run(
      async (cancel) => {
        const id = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const intent = decodeRatingCommandIntent(make(id));
        if (
          isRatingTargetCoverIntent(intent) ||
          isRatingScopedIntent(intent) ||
          isRatingCategoryScopedIntent(intent) ||
          isRatingTargetOwnerEditingIntent(intent) ||
          isRatingTargetOwnerDeletionIntent(intent) ||
          isRatingCategoryCreationIntent(intent) ||
          isRatingTargetCreationIntent(intent) ||
          isRatingSubscriptionIntent(intent) ||
          isRatingAdminDeletionIntent(intent)
        )
          invalidRating();
        const attempt = this.runtime.pendingRatings!.freeze({
          version: 2,
          accountId,
          intent,
        });
        this.clearContent();
        this.showPending(attempt);
        return runRatingCommand(this.runtime, attempt, cancel, true);
      },
      (receipt) => {
        refresh = this.settle(receipt);
      },
      (error) => {
        this.clearContent();
        this.update({
          frozen: true,
          error: ratingError(error),
          status: '原请求结果未确认，请查询回执或重试同一请求',
        });
      },
    );
    if (refresh && !this.inactive && this.accountId() === accountId)
      await this.refresh();
  }
  private settle(raw: RatingCommandReceipt): boolean {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidRating();
    const result = settleRatingCommand(this.runtime, this.pending, raw);
    this.pending = this.runtime.pendingRatings!.load(this.accountId()!);
    const success =
      result.outcome !== 'rejected' && result.outcome !== 'closed';
    this.update({
      frozen: false,
      recoveryOperation: '',
      needsRefresh: !success,
      receiptStatus: success
        ? `${ratingCommandLabels[result.operation]}${result.outcome === 'noop' ? '未发生变更' : '已提交'}；当前内容需重新读取`
        : ratingError(
            new ClientError('business', 'Rejected', {
              serverCode: result.code,
            }),
          ),
      error: '',
    });
    if (this.pending) {
      this.showPending(this.pending);
      return false;
    }
    if (
      this.route &&
      success &&
      (result.operation === 'delete_reply' ||
        result.operation === 'create_reply')
    ) {
      const route: RatingThreadRoute = {
        targetId: this.route.targetId,
        rootId: this.route.rootId,
        ...(this.route.regionId ? { regionId: this.route.regionId } : {}),
      };
      this.route =
        result.operation === 'create_reply' &&
        result.targetId === route.targetId &&
        result.rootId === route.rootId
          ? { ...route, replyId: result.replyId }
          : route;
    }
    return success;
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.loadJournal() || !this.pending) return;
    const attempt = this.pending;
    this.stop();
    this.clearContent();
    this.showPending(attempt);
    let refresh = false;
    await this.run(
      (cancel) => runRatingCommand(this.runtime, attempt, cancel, retry),
      (result) => {
        refresh = this.settle(result);
      },
      (error) => {
        if (
          retry &&
          isRatingAdminDeletionIntent(attempt.intent) &&
          isRatingDeletionContextChanged(error)
        ) {
          if (!this.loadJournal()) return;
          if (!this.pending) {
            this.update({
              frozen: false,
              needsRefresh: true,
              recoveryOperation: '',
              error: ratingError(error),
              status: '原请求未提交，请重新打开删除选项并核验后确认',
            });
            return;
          }
        }

        this.update({
          frozen: true,
          error: ratingError(error),
          status: '原请求仍待确认，未查到回执不能新建替代请求',
        });
      },
    );
    if (refresh && !this.inactive && this.accountId() === attempt.accountId)
      await this.refresh();
  }
  override cancel(): void {
    this.stop();
    this.clearContent();
    this.update({
      busy: false,
      status: '已停止等待，正文、引用和输入已清除；原请求仍可能完成',
    });
  }
  override dispose(): void {
    this.inactive = true;
    this.unsubscribeScope();
    this.unsubscribeBrowse();
    this.unsubscribeTarget();
    this.unsubscribeCatalog();
    super.dispose();
  }
}
