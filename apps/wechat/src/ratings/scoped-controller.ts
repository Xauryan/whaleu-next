import { discussionMediaPath } from './discussion-media-page-controller';
import {
  RatingTargetCoverContextLease,
  matchRatingCoverScopePair,
  type RatingTargetCoverContext,
} from './target-cover-context';
import {
  RatingCoverReadController,
  type RatingCoverReadView,
} from './target-cover-read-controller';
import {
  RatingCoverUploadController,
  type RatingCoverUploadView,
} from './target-cover-upload-controller';
import {
  decodeRatingTargetCoverIntent,
  ratingTargetCoverContext,
  isRatingTargetCoverIntent,
  type RatingTargetCoverChange,
} from './target-cover-contract';
import { ratingCategoryScopedPath } from './category-scoped-route';
import { ClientError, isRecord } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation, Clock } from '../platform/contracts';
import { systemClock } from '../platform/clock';
import { decodeCampusPage, type Campus } from '../profile/contract';
import {
  canonicalRatingText,
  invalidRating,
  ratingId,
  type RatingAuthorMode,
  type RatingCategory,
  type RatingComment,
  type RatingMyScore,
  type RatingSummary,
  type RatingTarget,
} from './contract';
import type { RatingReply } from './discussion-contract';
import type { RatingLikeState } from './like-contract';
import type { RatingSubscriptionState } from './subscription-contract';
import { ratingDeletionPath } from './deletion-contract';
import { ratingTargetOwnerDeletionPath } from './target-owner-deletion-contract';
import {
  ratingCommandLabels,
  runRatingCommand,
  settleRatingCommand,
} from './commands';
import {
  isRatingScopedIntent,
  type PendingRating,
  type RatingCommandReceipt,
} from './pending';
import {
  RatingScopedContextLease,
  matchRatingScopedContextPair,
  type RatingScopedCommandPurpose,
} from './scoped-context';
import {
  decodeRatingNavigationSelector,
  ratingNavigationKey,
  decodeRatingScopedIntent,
  decodeRatingScopedLocator,
  ratingRandomSelector,
  type RatingNavigationSelector,
  type RatingScopedContext,
  type RatingScopedContextRequest,
  type RatingScopedIntent,
  type RatingScopedLocator,
  type RatingScopedCommandContext,
} from './scoped-contract';
import type {
  RatingScopedDiscussion,
  RatingScopedEditContext,
  RatingScopedNotice,
  RatingScopedNoticeKind,
  RatingScopedRandomResult,
} from './scoped-read-contract';

function publicCoverTarget(
  target: RatingTarget,
): RatingTarget & { readonly hasCover: boolean } {
  const { cover, ...body } = target as RatingTarget & { cover?: unknown };
  return { ...body, hasCover: cover !== undefined && cover !== null };
}
export type RatingScopedMode =
  | 'catalog'
  | 'detail'
  | 'thread'
  | 'random'
  | 'create'
  | 'edit'
  | 'updates'
  | 'subscriptions'
  | 'recovery';
export interface RatingScopedRoute {
  readonly mode: RatingScopedMode;
  readonly selector: RatingNavigationSelector;
  readonly categoryId?: string;
  readonly targetId?: string;
  readonly rootId?: string;
  readonly replyId?: string;
  readonly protocolGeneration?: string;
}
export function decodeRatingScopedRoute(v: unknown): RatingScopedRoute {
  if (
    !isRecord(v) ||
    Object.keys(v).some(
      (key) =>
        ![
          'mode',
          'scope',
          'campusId',
          'categoryId',
          'targetId',
          'rootId',
          'replyId',
          'protocolGeneration',
        ].includes(key),
    )
  )
    invalidRating();
  const mode = v.mode ?? 'catalog';
  if (
    ![
      'catalog',
      'detail',
      'thread',
      'random',
      'create',
      'edit',
      'updates',
      'subscriptions',
      'recovery',
    ].includes(String(mode))
  )
    invalidRating();
  const selector = decodeRatingNavigationSelector(
    v.scope === 'campus'
      ? { kind: 'campus', campusId: v.campusId }
      : { kind: 'global' },
  );
  if (
    (v.scope !== undefined && v.scope !== 'campus' && v.scope !== 'global') ||
    (selector.kind === 'global' && v.campusId !== undefined)
  )
    invalidRating();
  const ids: Record<string, string> = {};
  for (const key of [
    'categoryId',
    'targetId',
    'rootId',
    'replyId',
    'protocolGeneration',
  ])
    if (v[key] !== undefined) {
      if (!ratingId(v[key])) invalidRating();
      ids[key] = v[key];
    }
  if (
    (['detail', 'thread', 'edit'].includes(String(mode)) && !ids.targetId) ||
    (mode === 'thread' && !ids.rootId) ||
    (['random', 'create'].includes(String(mode)) && !ids.categoryId) ||
    (ids.replyId && !ids.rootId) ||
    (ids.rootId && !ids.targetId)
  )
    invalidRating();
  return Object.freeze({ mode: mode as RatingScopedMode, selector, ...ids });
}
export function ratingScopedPath(route: RatingScopedRoute): string {
  const query = {
    mode: route.mode,
    scope: route.selector.kind,
    ...(route.selector.kind === 'campus'
      ? { campusId: route.selector.campusId }
      : {}),
    ...(route.categoryId ? { categoryId: route.categoryId } : {}),
    ...(route.targetId ? { targetId: route.targetId } : {}),
    ...(route.rootId ? { rootId: route.rootId } : {}),
    ...(route.replyId ? { replyId: route.replyId } : {}),
    ...(route.protocolGeneration
      ? { protocolGeneration: route.protocolGeneration }
      : {}),
  };
  decodeRatingScopedRoute(query);
  return (
    '/pages/rating-scoped/rating-scoped?' +
    Object.entries(query)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&')
  );
}
export function ratingScopedLocatorPath(raw: RatingScopedLocator): string {
  const locator = decodeRatingScopedLocator(raw);
  return ratingScopedPath({
    mode: locator.rootId === null ? 'detail' : 'thread',
    selector: locator.selector,
    targetId: locator.targetId,
    ...(locator.rootId ? { rootId: locator.rootId } : {}),
    ...(locator.replyId ? { replyId: locator.replyId } : {}),
    protocolGeneration: locator.protocolGeneration,
  });
}
export function ratingScopedError(error: unknown): string {
  const code = error instanceof ClientError ? error.details.serverCode : null;
  return (
    (
      {
        RATING_SCOPED_CONTEXT_CHANGED:
          '范围或来源已变化，请重新加载并确认；原请求须先恢复或取消',
        RATING_SCOPE_UNAVAILABLE: '当前范围的完整来源或授权暂不能确认',
        RATING_NOT_FOUND: '当前范围没有此分类、目标或讨论，或其当前不可见',
        RATING_REVISION_CONFLICT: '内容版本已变化，请重新读取并确认',
        RATING_UNAVAILABLE: '评分服务暂不能确认完整结果，请稍后重试',
        REQUEST_NOT_FOUND: '暂未查到回执；原请求仍可能完成，请保留原请求',
        RATING_CREATION_CANCELLED: '原创建请求已明确取消',
        RATING_EDIT_CANCELLED: '原编辑请求已明确取消',
      } as Record<string, string>
    )[code ?? ''] ?? communityError(error)
  );
}
export interface RatingScopedView extends CommunityView {
  readonly coverEnabled: boolean;
  readonly cover: RatingCoverReadView;
  readonly coverThumbnails: Readonly<Record<string, RatingCoverReadView>>;
  readonly coverUpload: RatingCoverUploadView;
  readonly coverAction: 'keep' | 'clear' | 'replace';
  readonly mode: RatingScopedMode;
  readonly loaded: boolean;
  readonly scopeLabel: string;
  readonly identityCampusId: string | null;
  readonly viewCampusId: string | null;
  readonly categoryId: string | null;
  readonly categories: readonly RatingCategory[];
  readonly targets: readonly RatingTarget[];
  readonly detail: RatingTarget | null;
  readonly myScore: RatingMyScore | null;
  readonly summary: RatingSummary | null;
  readonly comments: readonly RatingComment[];
  readonly discussion: RatingScopedDiscussion | null;
  readonly replies: readonly RatingReply[];
  readonly likes: Readonly<Record<string, RatingLikeState>>;
  readonly subscriptions: Readonly<Record<string, RatingSubscriptionState>>;
  readonly canMoreCategories: boolean;
  readonly canMoreTargets: boolean;
  readonly canMoreComments: boolean;
  readonly canMoreReplies: boolean;
  readonly frozen: boolean;
  readonly recoveryOperation: string;
  readonly canCancelPending: boolean;
  readonly cancelPendingConfirmation: boolean;
  readonly needsRefresh: boolean;
  readonly receiptStatus: string;
  readonly selectedScore: number | null;
  readonly composerOpen: boolean;
  readonly text: string;
  readonly authorMode: RatingAuthorMode | null;
  readonly authorModes: readonly RatingAuthorMode[];
  readonly name: string;
  readonly description: string;
  readonly definitionConfirmation: boolean;
  readonly pickerOpen: boolean;
  readonly campusQuery: string;
  readonly campuses: readonly Campus[];
  readonly campusPage: number;
  readonly hasMoreCampuses: boolean;
  readonly minimumAverageInput: string;
  readonly randomResult: RatingScopedRandomResult | null;
  readonly notices: readonly RatingScopedNotice[];
  readonly noticeKind: RatingScopedNoticeKind;
  readonly unreadCount: number | null;
  readonly canMoreNotices: boolean;
}
export const initialRatingScopedView = (): RatingScopedView => ({
  ...initialCommunityView(),
  mode: 'catalog',
  loaded: false,
  scopeLabel: '独立全局',
  identityCampusId: null,
  viewCampusId: null,
  categoryId: null,
  categories: [],
  targets: [],
  detail: null,
  myScore: null,
  summary: null,
  comments: [],
  discussion: null,
  replies: [],
  likes: {},
  subscriptions: {},
  canMoreCategories: false,
  canMoreTargets: false,
  canMoreComments: false,
  canMoreReplies: false,
  frozen: false,
  recoveryOperation: '',
  canCancelPending: false,
  cancelPendingConfirmation: false,
  needsRefresh: false,
  receiptStatus: '',
  selectedScore: null,
  composerOpen: false,
  text: '',
  authorMode: null,
  authorModes: [],
  name: '',
  description: '',
  definitionConfirmation: false,
  coverEnabled: false,
  cover: { status: 'idle', localSrc: '', expanded: false },
  coverThumbnails: {},
  coverAction: 'clear',
  coverUpload: {
    status: 'idle',
    localSrc: '',
    progress: 0,
    pickerWaiting: false,
    message: '',
  },
  pickerOpen: false,
  campusQuery: '',
  campuses: [],
  campusPage: 1,
  hasMoreCampuses: false,
  minimumAverageInput: '',
  randomResult: null,
  notices: [],
  noticeKind: 'updates',
  unreadCount: null,
  canMoreNotices: false,
});
type PageKind = 'categories' | 'targets' | 'comments' | 'replies' | 'notices';
/** One native page, the existing domain DTOs, and one account-scoped journal. No token, request body or cursor enters page data. */
export class RatingScopedController extends CommunityController<RatingScopedView> {
  private inactive = false;
  private readonly coverClock: Clock;
  private readonly thumbnailReaders = new Map<
    string,
    RatingCoverReadController
  >();
  private readonly visibleCovers = new Set<string>();
  private thumbnailLoading = false;
  private thumbnailEpoch = 0;
  private coverPreviewOpen = false;
  private coverOpening = false;
  private coverReader: RatingCoverReadController | undefined;
  private randomCoverContext: RatingTargetCoverContext | null = null;
  private coverUploader: RatingCoverUploadController | undefined;
  private coverChange: RatingTargetCoverChange = { action: 'clear' };
  private routeInitialized = false;
  private requestedRoute: unknown = {};
  private route: RatingScopedRoute = {
    mode: 'catalog',
    selector: { kind: 'global' },
  };
  private readonly lease: RatingScopedContextLease;
  private readonly coverReadLease: RatingTargetCoverContextLease;
  private readonly coverCommandLease: RatingTargetCoverContextLease;
  private readonly commandLease: RatingScopedContextLease;
  private readonly subscriptionsToChanges: (() => void)[];
  private pending: PendingRating | null = null;
  private category: RatingCategory | null = null;
  private editing: RatingScopedEditContext | null = null;
  private replyTo: {
    readonly replyId: string;
    readonly expectedRevision: string;
  } | null = null;
  private draftGeneration = 0;
  private confirmation: {
    readonly name: string;
    readonly description: string;
  } | null = null;
  private cursors: Partial<Record<PageKind, string | null>> = {};
  private seenCursors: Partial<Record<PageKind, Set<string>>> = {};
  private sort: 'time' | 'likes' = 'time';
  private order: 'asc' | 'desc' = 'desc';
  constructor(
    runtime: CommunityRuntime,
    render: (view: RatingScopedView) => void,
    clock: Clock = systemClock,
  ) {
    super(runtime, initialRatingScopedView, render);
    this.coverClock = clock;
    this.coverReadLease = new RatingTargetCoverContextLease(
      runtime.sessions,
      () => this.invalidate(),
      clock,
    );
    this.coverCommandLease = new RatingTargetCoverContextLease(
      runtime.sessions,
      () => this.invalidate(),
      clock,
    );
    this.coverReader = new RatingCoverReadController(
      runtime.sessions,
      runtime.ratingCoverDownload,
      clock,
      (cover) => {
        this.update({ cover });
        if (!this.coverOpening && this.coverPreviewOpen && !cover.expanded) {
          this.coverPreviewOpen = false;
          void this.drainCoverThumbnails();
        }
      },
    );
    if (runtime.pendingRatings && runtime.ratingCoverMedia) {
      this.coverUploader = new RatingCoverUploadController(
        runtime.sessions,
        runtime.pendingRatings,
        runtime.ratingCoverMedia,
        runtime.ratingCoverUpload,
        (coverUpload) => this.update({ coverUpload }),
      );
    }
    this.lease = new RatingScopedContextLease(
      runtime.sessions,
      () => this.invalidate(),
      clock,
    );
    this.commandLease = new RatingScopedContextLease(
      runtime.sessions,
      () => this.invalidate(),
      clock,
    );
    const invalidate = (accountId?: string) => {
      if (accountId === undefined || accountId === this.accountId())
        this.invalidate();
    };
    this.subscriptionsToChanges = [
      runtime.directoryScopeChanges?.subscribe(invalidate),
      runtime.browsingScopeChanges?.subscribe(invalidate),
      runtime.ratingCatalogChanges?.subscribe(() => this.invalidate()),
      runtime.ratingTargetChanges?.subscribe(() => this.invalidate()),
    ].filter((v): v is () => void => !!v);
    this.update({
      configured: !!runtime.ratingScoped && !!runtime.pendingRatings,
    });
  }
  protected override available(): boolean {
    if (this.inactive || !this.accountId() || !this.runtime.pendingRatings)
      return false;
    return true;
  }
  protected override resetPrivate(): void {
    this.coverUploader?.hide();
    this.coverReader?.clear();
    this.randomCoverContext = null;
    this.clearCoverThumbnails();
    this.coverChange = { action: 'clear' };
    this.coverReadLease?.clear();
    this.coverCommandLease?.clear();
    this.lease?.clear();
    this.commandLease?.clear();
    this.pending = null;
    this.category = null;
    this.editing = null;
    this.replyTo = null;
    this.confirmation = null;
    this.cursors = {};
    this.seenCursors = {};
    this.draftGeneration++;
  }
  protected override onSafetyInvalidated(): void {
    this.invalidate();
  }
  private clearContent(): void {
    this.coverUploader?.hide();
    this.coverReader?.clear();
    this.randomCoverContext = null;
    this.clearCoverThumbnails();
    this.coverChange = { action: 'clear' };
    this.stop();
    this.lease.clear();
    this.commandLease.clear();
    this.coverReadLease.clear();
    this.coverCommandLease.clear();
    this.category = null;
    this.editing = null;
    this.replyTo = null;
    this.confirmation = null;
    this.draftGeneration++;
    this.cursors = {};
    this.seenCursors = {};
    this.update({
      loaded: false,
      coverEnabled: false,
      busy: false,
      categories: [],
      targets: [],
      detail: null,
      myScore: null,
      summary: null,
      comments: [],
      discussion: null,
      replies: [],
      likes: {},
      subscriptions: {},
      canMoreCategories: false,
      canMoreTargets: false,
      canMoreComments: false,
      canMoreReplies: false,
      selectedScore: null,
      composerOpen: false,
      text: '',
      authorMode: null,
      authorModes: [],
      name: '',
      description: '',
      definitionConfirmation: false,
      randomResult: null,
      notices: [],
      unreadCount: null,
      identityCampusId: null,
      campuses: [],
      campusQuery: '',
      pickerOpen: false,
      hasMoreCampuses: false,
      canMoreNotices: false,
      cancelPendingConfirmation: false,
    });
  }
  private invalidate(): void {
    if (this.inactive) return;
    this.clearContent();
    this.update({
      needsRefresh: true,
      status: '身份、浏览范围或来源已变化，旧内容和草稿已清除，请重新加载',
    });
  }
  private journal(): boolean {
    if (!this.available()) {
      this.update({
        hasSession: !!this.accountId(),
        error: '请先登录并确认本地恢复存储可用',
      });
      return false;
    }
    try {
      this.pending = this.runtime.pendingRatings!.load(this.accountId()!);
      if (this.pending) this.showPending(this.pending);
      return true;
    } catch (error) {
      try {
        const coverUpload = this.runtime.pendingRatings!.loadCoverUpload(
          this.accountId()!,
        );
        if (coverUpload) {
          this.update({
            frozen: true,
            coverEnabled: true,
            coverUpload: {
              status: 'pending',
              localSrc: '',
              progress: 0,
              pickerWaiting: false,
              message: '请恢复或明确取消原封面请求',
            },
            status: '原封面请求保留中，不能新建替代请求',
          });
          return false;
        }
      } catch {
        /* Corrupt or conflicting journals remain unavailable. */
      }
      this.clearContent();
      this.update({
        frozen: true,
        error: ratingScopedError(error),
        status: '原请求不可读，不能新建替代请求',
      });
      return false;
    }
  }
  private showPending(pending: PendingRating): void {
    this.pending = pending;
    this.update({
      frozen: true,
      recoveryOperation: ratingCommandLabels[pending.intent.operation],
      canCancelPending:
        (pending.version === 9 || pending.version === 11) &&
        (pending.intent.operation === 'create_target_scoped' ||
          pending.intent.operation === 'edit_target_scoped'),
      composerOpen: false,
      selectedScore: null,
      text: '',
      name: '',
      description: '',
      authorMode: null,
      definitionConfirmation: false,
      status: '原请求待确认，请查询或重试同一请求',
    });
  }
  async load(raw: unknown = {}): Promise<void> {
    if (this.inactive) return;
    this.requestedRoute = raw;
    this.routeInitialized = false;
    this.clearContent();
    this.update({
      frozen: false,
      needsRefresh: false,
      recoveryOperation: '',
      receiptStatus: '',
      campuses: [],
      pickerOpen: false,
      error: '',
    });
    // Journal discovery and historical replay deliberately precede route validation and context issuance.
    if (!this.journal()) return;
    if (this.pending) {
      await this.recover();
      return;
    }
    try {
      this.route = decodeRatingScopedRoute(raw);
      this.routeInitialized = true;
    } catch {
      this.update({ error: '评分链接无效，请返回范围目录' });
      return;
    }
    this.update({
      mode: this.route.mode,
      categoryId: this.route.categoryId ?? null,
      viewCampusId:
        this.route.selector.kind === 'campus'
          ? this.route.selector.campusId
          : null,
      scopeLabel:
        this.route.selector.kind === 'global'
          ? '独立全局'
          : this.route.mode === 'random'
            ? '所选校园的完整学校 + 独立全局'
            : '所选校园',
    });
    if (this.route.mode === 'recovery') {
      this.update({ loaded: true, status: '当前账号没有待确认评分请求' });
      return;
    }
    if (!this.runtime.ratingScoped) {
      this.update({ error: '当前构建尚未配置新评分协议' });
      return;
    }
    if (this.route.mode === 'updates') {
      await this.loadNotices();
      return;
    }
    if (this.route.mode === 'random') {
      this.update({
        loaded: true,
        status: '确认候选范围后点击随机选择；选择校园覆盖完整学校和全局',
      });
      return;
    }
    await this.readCurrent();
  }
  private queryRoute(): Record<string, string> {
    return {
      mode: this.route.mode,
      scope: this.route.selector.kind,
      ...(this.route.selector.kind === 'campus'
        ? { campusId: this.route.selector.campusId }
        : {}),
      ...(this.route.categoryId ? { categoryId: this.route.categoryId } : {}),
      ...(this.route.targetId ? { targetId: this.route.targetId } : {}),
      ...(this.route.rootId ? { rootId: this.route.rootId } : {}),
      ...(this.route.replyId ? { replyId: this.route.replyId } : {}),
      ...(this.route.protocolGeneration
        ? { protocolGeneration: this.route.protocolGeneration }
        : {}),
    };
  }
  /** Only non-secret route selectors survive native hide/show. Drafts and contexts never do. */
  snapshotRoute(): Readonly<Record<string, string>> | null {
    return this.routeInitialized ? Object.freeze(this.queryRoute()) : null;
  }
  async reload(): Promise<void> {
    await this.load(
      this.routeInitialized ? this.queryRoute() : this.requestedRoute,
    );
  }
  private commandPurpose(): RatingScopedCommandPurpose {
    return this.route.mode === 'create'
      ? 'create_target'
      : this.route.mode === 'edit'
        ? 'edit_target'
        : 'interact';
  }
  private request(): RatingScopedContextRequest {
    return {
      selector: this.route.selector,
      purpose: 'read',
      mode: 'public',
    };
  }
  private async issue(
    request: RatingScopedContextRequest,
    cancel: Cancellation,
    lease: RatingScopedContextLease = this.lease,
  ): Promise<RatingScopedContext> {
    const generation = lease.capture();
    const context = await this.runtime.ratingScoped!.context(request, cancel);
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Scoped read cancelled');
    if (
      this.route.protocolGeneration &&
      context.protocolGeneration !== this.route.protocolGeneration
    )
      throw new ClientError('business', 'Locator generation changed', {
        serverCode: 'RATING_SCOPED_CONTEXT_CHANGED',
      });
    return lease.accept(context, request, generation);
  }
  private async issueCover(
    request: RatingScopedContextRequest,
    cancel: Cancellation,
    lease = this.coverReadLease,
  ): Promise<RatingTargetCoverContext> {
    if (!this.runtime.ratingTargetCover) invalidRating();
    const generation = lease.capture();
    const context = await this.runtime.ratingTargetCover.context(
      request,
      cancel,
    );
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Ratings cover context interrupted');
    if (
      this.route.protocolGeneration &&
      context.protocolGeneration !== this.route.protocolGeneration
    )
      invalidRating();
    return lease.accept(context, request, generation);
  }
  private coverReadContext(): RatingTargetCoverContext | null {
    if (!this.runtime.ratingTargetCover) return null;
    const context = this.coverReadLease.current();
    matchRatingCoverScopePair(this.lease.current(), context);
    return context;
  }
  private assertCoverContextPair(): void {
    this.assertContextPair();
    this.coverReadContext();
    matchRatingCoverScopePair(
      this.lease.current(),
      this.coverCommandLease.current(),
    );
  }
  private assertContextPair(): void {
    matchRatingScopedContextPair(
      this.lease.current(),
      this.commandLease.current(),
      this.commandPurpose(),
    );
  }
  private assertRead(cancel: Cancellation, context: RatingScopedContext): void {
    if (
      context.purpose !== 'read' ||
      cancel.isCancelled ||
      this.inactive ||
      this.lease.current().id !== context.id
    )
      throw new ClientError('cancelled', 'Scoped page changed during read');
  }
  private async findCategory(
    context: RatingScopedContext,
    categoryId: string,
    cancel: Cancellation,
  ): Promise<RatingCategory> {
    const queue: (string | null)[] = [null],
      seen = new Set<string>();
    let count = 0;
    for (let index = 0; index < queue.length; index++) {
      let cursor: string | null = null;
      const visited = new Set<string>();
      do {
        const page = await this.runtime.ratingScoped!.categories(
          context,
          queue[index]!,
          cursor,
          cancel,
          50,
        );
        this.assertRead(cancel, context);
        for (const category of page.items) {
          if (seen.has(category.id) || ++count > 10_000) invalidRating();
          seen.add(category.id);
          if (category.id === categoryId) return category;
          if (category.level < 3) queue.push(category.id);
        }
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (visited.has(cursor)) invalidRating();
          visited.add(cursor);
        }
      } while (cursor !== null);
    }
    throw new ClientError('business', 'Category not found', {
      serverCode: 'RATING_NOT_FOUND',
    });
  }
  private async readCurrent(): Promise<void> {
    if (!this.available() || this.view.busy || !this.runtime.ratingScoped)
      return;
    await this.run(
      async (cancel) => {
        const route = this.route,
          sort = this.sort,
          order = this.order;
        const context = await this.issue(this.request(), cancel),
          gateway = this.runtime.ratingScoped!;
        const commandContext = await this.issue(
          {
            purpose: this.commandPurpose(),
            selector: route.selector,
            mode: 'public',
          },
          cancel,
          this.commandLease,
        );
        this.assertRead(cancel, context);
        this.assertContextPair();
        const coverRead = this.runtime.ratingTargetCover
          ? await this.issueCover(this.request(), cancel)
          : null;
        if (coverRead) matchRatingCoverScopePair(context, coverRead);
        const coverCommand =
          this.runtime.ratingTargetCover &&
          (route.mode === 'create' || route.mode === 'edit')
            ? await this.issueCover(
                {
                  purpose: this.commandPurpose(),
                  selector: route.selector,
                  mode: 'public',
                },
                cancel,
                this.coverCommandLease,
              )
            : null;
        if (coverCommand) matchRatingCoverScopePair(context, coverCommand);
        const common = {
          loaded: true,
          identityCampusId: context.identityCampusId,
          needsRefresh: false,
          status: '当前范围已核验',
          coverEnabled: !!coverCommand?.capabilities.includes('target_cover'),
        };
        if (route.mode === 'catalog') {
          const [categories, targets] = await Promise.all([
            gateway.categories(context, route.categoryId ?? null, null, cancel),
            route.categoryId
              ? coverRead && this.runtime.ratingTargetCover
                ? this.runtime.ratingTargetCover.targets(
                    coverRead,
                    route.categoryId,
                    null,
                    cancel,
                  )
                : gateway.targets(context, route.categoryId, null, cancel)
              : Promise.resolve(null),
          ]);
          this.assertRead(cancel, context);
          this.cursors.categories = categories.nextCursor;
          this.cursors.targets = targets?.nextCursor ?? null;
          const states = targets?.items.length
            ? await gateway.subscriptionStates(
                context,
                targets.items.map((target) => ({
                  targetId: target.id,
                  expectedTargetRevision: target.revision,
                })),
                cancel,
              )
            : null;
          return {
            ...common,
            categories: categories.items,
            targets: targets?.items.map(publicCoverTarget) ?? [],
            subscriptions: Object.fromEntries(
              states?.items.map((item) => [item.targetId, item.state]) ?? [],
            ),
            canMoreCategories: categories.nextCursor !== null,
            canMoreTargets: targets?.nextCursor != null,
          };
        }
        if (route.mode === 'subscriptions') {
          const page =
            coverRead && this.runtime.ratingTargetCover
              ? await this.runtime.ratingTargetCover.subscriptions(
                  coverRead,
                  null,
                  cancel,
                )
              : await gateway.subscriptions(context, null, cancel);
          this.assertRead(cancel, context);
          this.cursors.targets = page.nextCursor;
          const states = page.items.length
            ? await gateway.subscriptionStates(
                context,
                page.items.map((target) => ({
                  targetId: target.id,
                  expectedTargetRevision: target.revision,
                })),
                cancel,
              )
            : null;
          return {
            ...common,
            targets: page.items.map(publicCoverTarget),
            subscriptions: Object.fromEntries(
              states?.items.map((item) => [item.targetId, item.state]) ?? [],
            ),
            canMoreTargets: page.nextCursor !== null,
          };
        }
        if (route.mode === 'create') {
          this.coverChange = { action: 'clear' };
          this.update({ coverAction: 'clear' });
          const category = await this.findCategory(
            context,
            route.categoryId!,
            cancel,
          );
          this.assertRead(cancel, context);
          this.category = category;
          if (this.category.kind !== 'general') invalidRating();
          return {
            ...common,
            categories: [this.category],
            status: '请填写对象名称和描述并确认创建',
          };
        }
        if (route.mode === 'edit') {
          const editing =
            coverCommand?.capabilities.includes('target_cover') &&
            this.runtime.ratingTargetCover
              ? await this.runtime.ratingTargetCover.editContext(
                  coverCommand,
                  route.targetId!,
                  cancel,
                )
              : await gateway.editContext(
                  commandContext,
                  route.targetId!,
                  cancel,
                );
          this.coverChange = { action: 'keep' };
          this.update({ coverAction: 'keep' });
          this.assertRead(cancel, context);
          this.editing = editing;
          return {
            ...common,
            name: this.editing.name,
            description: this.editing.description,
            status: '创建者编辑资格已核验，请确认修改内容',
          };
        }
        const target =
          coverRead && this.runtime.ratingTargetCover
            ? (
                await this.runtime.ratingTargetCover.detail(
                  coverRead,
                  route.targetId!,
                  cancel,
                )
              ).target
            : await gateway.detail(context, route.targetId!, cancel);
        this.assertRead(cancel, context);
        const category = await this.findCategory(
          context,
          target.categoryId,
          cancel,
        );
        this.assertRead(cancel, context);
        this.category = category;
        const [myScore, summary, subscription] = await Promise.all([
          gateway.myScore(context, target.id, cancel),
          gateway.summary(context, target.id, cancel),
          gateway.subscription(context, target.id, cancel),
        ]);
        if (route.mode === 'thread') {
          const discussion = await gateway.discussion(
            context,
            route.rootId!,
            cancel,
          );
          if (discussion.root.targetId !== target.id) invalidRating();
          const replies = route.replyId
            ? (await gateway.position(context, route.replyId, cancel)).page
            : await gateway.replies(context, discussion.root.id, null, cancel);
          this.assertRead(cancel, context);
          if (
            replies.context.targetId !== target.id ||
            replies.context.rootId !== discussion.root.id
          )
            invalidRating();
          this.cursors.replies = replies.nextCursor;
          const entries = await Promise.all([
            gateway
              .commentLike(context, discussion.root.id, cancel)
              .then((state) => [discussion.root.id, state] as const),
            ...replies.items.map((reply) =>
              gateway
                .replyLike(context, reply.id, cancel)
                .then((state) => [reply.id, state] as const),
            ),
          ]);
          return {
            ...common,
            detail: target,
            myScore,
            summary,
            discussion,
            replies: replies.items,
            likes: Object.fromEntries(entries),
            subscriptions: { [target.id]: subscription },
            canMoreReplies: replies.nextCursor !== null,
          };
        }
        const comments = await gateway.comments(
          context,
          target.id,
          null,
          cancel,
          20,
          sort,
          order,
        );
        this.assertRead(cancel, context);
        this.cursors.comments = comments.nextCursor;
        const likes = await Promise.all(
          comments.items.map((comment) =>
            gateway
              .commentLike(context, comment.id, cancel)
              .then((state) => [comment.id, state] as const),
          ),
        );
        return {
          ...common,
          detail: target,
          myScore,
          summary,
          comments: comments.items,
          likes: Object.fromEntries(likes),
          subscriptions: { [target.id]: subscription },
          canMoreComments: comments.nextCursor !== null,
        };
      },
      (result) => {
        this.assertContextPair();
        this.update(result);
        if (this.view.detail && this.runtime.ratingTargetCover)
          void this.openCover(undefined, false);
      },
      (error) => {
        this.clearContent();
        this.update({ needsRefresh: true, error: ratingScopedError(error) });
      },
    );
  }
  async more(kind: PageKind): Promise<void> {
    if (
      !this.available() ||
      this.view.busy ||
      this.view.frozen ||
      !this.view.loaded
    )
      return;
    if (kind === 'notices') {
      await this.loadNotices(true);
      return;
    }
    const cursor = this.cursors[kind];
    if (!cursor) return;
    const previous = this.seenCursors[kind] ?? new Set<string>();
    if (previous.has(cursor)) {
      this.invalidate();
      return;
    }
    previous.add(cursor);
    this.seenCursors[kind] = previous;
    await this.run(
      async (cancel) => {
        const context = this.lease.current(),
          gateway = this.runtime.ratingScoped!;
        if (kind === 'categories') {
          const page = await gateway.categories(
            context,
            this.route.categoryId ?? null,
            cursor,
            cancel,
          );
          this.assertRead(cancel, context);
          this.cursors.categories = page.nextCursor;
          if (
            page.items.some((item) =>
              this.view.categories.some((old) => old.id === item.id),
            )
          )
            invalidRating();
          return {
            categories: [...this.view.categories, ...page.items],
            canMoreCategories: page.nextCursor !== null,
          };
        }
        if (kind === 'targets') {
          const page =
            this.route.mode === 'subscriptions'
              ? this.runtime.ratingTargetCover
                ? await this.runtime.ratingTargetCover.subscriptions(
                    this.coverReadContext()!,
                    cursor,
                    cancel,
                  )
                : await gateway.subscriptions(context, cursor, cancel)
              : this.runtime.ratingTargetCover
                ? await this.runtime.ratingTargetCover.targets(
                    this.coverReadContext()!,
                    this.route.categoryId!,
                    cursor,
                    cancel,
                  )
                : await gateway.targets(
                    context,
                    this.route.categoryId!,
                    cursor,
                    cancel,
                  );
          this.assertRead(cancel, context);
          this.cursors.targets = page.nextCursor;
          if (
            page.items.some((item) =>
              this.view.targets.some((old) => old.id === item.id),
            )
          )
            invalidRating();
          const states = page.items.length
            ? await gateway.subscriptionStates(
                context,
                page.items.map((target) => ({
                  targetId: target.id,
                  expectedTargetRevision: target.revision,
                })),
                cancel,
              )
            : null;
          return {
            targets: [
              ...this.view.targets,
              ...page.items.map(publicCoverTarget),
            ],
            subscriptions: {
              ...this.view.subscriptions,
              ...Object.fromEntries(
                states?.items.map((item) => [item.targetId, item.state]) ?? [],
              ),
            },
            canMoreTargets: page.nextCursor !== null,
          };
        }
        if (kind === 'comments') {
          const page = await gateway.comments(
            context,
            this.route.targetId!,
            cursor,
            cancel,
            20,
            this.sort,
            this.order,
          );
          this.assertRead(cancel, context);
          this.cursors.comments = page.nextCursor;
          if (
            page.items.some((item) =>
              this.view.comments.some((old) => old.id === item.id),
            )
          )
            invalidRating();
          const likes = await Promise.all(
            page.items.map((item) =>
              gateway
                .commentLike(context, item.id, cancel)
                .then((state) => [item.id, state] as const),
            ),
          );
          return {
            comments: [...this.view.comments, ...page.items],
            likes: { ...this.view.likes, ...Object.fromEntries(likes) },
            canMoreComments: page.nextCursor !== null,
          };
        }
        const page = await gateway.replies(
          context,
          this.route.rootId!,
          cursor,
          cancel,
        );
        this.assertRead(cancel, context);
        this.cursors.replies = page.nextCursor;
        if (
          page.items.some((item) =>
            this.view.replies.some((old) => old.id === item.id),
          )
        )
          invalidRating();
        const likes = await Promise.all(
          page.items.map((item) =>
            gateway
              .replyLike(context, item.id, cancel)
              .then((state) => [item.id, state] as const),
          ),
        );
        return {
          replies: [...this.view.replies, ...page.items],
          likes: { ...this.view.likes, ...Object.fromEntries(likes) },
          canMoreReplies: page.nextCursor !== null,
        };
      },
      (patch) => {
        this.assertContextPair();
        this.update(patch);
      },
      (error) => {
        this.invalidate();
        this.update({ error: ratingScopedError(error) });
      },
    );
  }
  private canDraft(): boolean {
    return (
      this.available() &&
      this.view.loaded &&
      !this.view.busy &&
      !this.view.frozen &&
      !this.view.needsRefresh
    );
  }
  chooseScore(score: number): void {
    if (
      !this.canDraft() ||
      !this.view.detail?.allowedActions.setScore ||
      this.view.summary?.status !== 'known' ||
      !this.view.myScore ||
      !Number.isInteger(score) ||
      score < 1 ||
      score > 5
    )
      return;
    this.draftGeneration++;
    this.update({ selectedScore: score });
  }
  dismissScore(): void {
    this.clearContent();
    this.update({ needsRefresh: true, status: '已关闭评分，请重新加载后确认' });
  }
  async confirmScore(): Promise<void> {
    if (
      !this.canDraft() ||
      this.view.selectedScore === null ||
      !this.view.detail ||
      !this.category ||
      !this.view.myScore
    )
      return;
    const target = this.view.detail,
      category = this.category,
      score = this.view.selectedScore,
      expectedRevision = this.view.myScore.myScore?.revision ?? null;
    await this.submit((clientRequestId, context) => ({
      protocolVersion: 2,
      operation: 'set_score_scoped',
      context,
      payload: {
        clientRequestId,
        targetId: target.id,
        expectedTargetRevision: target.revision,
        categoryId: category.id,
        expectedCategoryRevision: category.revision,
        expectedRevision,
        score,
      },
    }));
  }
  discussionImagesPath(targetId?: string): string | null {
    const id = targetId ?? this.route.targetId;
    if (!id || !ratingId(id) || this.view.frozen) return null;
    if (targetId && !this.view.targets.some((target) => target.id === targetId))
      return null;
    return discussionMediaPath(
      this.route.selector,
      id,
      !targetId && this.route.mode === 'thread' ? this.route.rootId : undefined,
      !targetId && this.route.mode === 'thread'
        ? this.route.replyId
        : undefined,
    );
  }
  discussionImageNoticePath(noticeId: string): string | null {
    if (
      !this.view.notices.some((notice) => notice.noticeId === noticeId) ||
      this.view.frozen
    )
      return null;
    const selector = this.route.selector;
    return (
      '/pages/rating-discussion-media/rating-discussion-media?' +
      Object.entries({
        scope: selector.kind,
        ...(selector.kind === 'campus' ? { campusId: selector.campusId } : {}),
        noticeId,
        noticeKind: this.view.noticeKind,
      })
        .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
        .join('&')
    );
  }
  openComposer(replyId?: string): void {
    if (!this.canDraft() || !this.view.detail) return;
    const actions =
      this.route.mode === 'thread'
        ? this.view.discussion?.allowedActions
        : this.view.detail.allowedActions;
    if (
      !actions ||
      ('createReply' in actions ? !actions.createReply : !actions.createComment)
    )
      return;
    const reply = replyId
      ? this.view.replies.find(
          (item) => item.id === replyId && item.allowedActions.reply,
        )
      : undefined;
    if (replyId && !reply) return;
    this.replyTo = reply
      ? { replyId: reply.id, expectedRevision: reply.revision }
      : null;
    this.draftGeneration++;
    this.update({
      composerOpen: true,
      text: '',
      authorMode: null,
      authorModes: actions.authorModes,
    });
  }
  closeComposer(): void {
    this.clearContent();
    this.update({ needsRefresh: true, status: '已关闭并清空草稿，请重新加载' });
  }
  setText(text: string): void {
    if (this.view.composerOpen && !this.view.frozen && !this.view.busy) {
      this.draftGeneration++;
      this.update({ text });
    }
  }
  setAuthorMode(authorMode: RatingAuthorMode): void {
    if (
      this.view.composerOpen &&
      !this.view.busy &&
      this.view.authorModes.includes(authorMode)
    ) {
      this.draftGeneration++;
      this.update({ authorMode });
    }
  }
  async publish(): Promise<void> {
    if (
      !this.canDraft() ||
      !this.view.composerOpen ||
      !this.view.authorMode ||
      !this.view.detail ||
      !this.category
    )
      return;
    let body: string;
    try {
      body = canonicalRatingText(this.view.text);
    } catch (error) {
      this.update({ error: ratingScopedError(error) });
      return;
    }
    const target = this.view.detail,
      category = this.category,
      authorMode = this.view.authorMode,
      root = this.view.discussion?.root,
      replyTo = this.replyTo;
    await this.submit((clientRequestId, context) => {
      const payload = {
        clientRequestId,
        targetId: target.id,
        expectedTargetRevision: target.revision,
        categoryId: category.id,
        expectedCategoryRevision: category.revision,
        authorMode,
        body,
        assetIds: [] as readonly [],
      };
      return root
        ? {
            protocolVersion: 2,
            operation: 'create_reply_scoped',
            context,
            payload: {
              ...payload,
              rootId: root.id,
              expectedRootRevision: root.revision,
              replyTo,
            },
          }
        : {
            protocolVersion: 2,
            operation: 'create_comment_scoped',
            context,
            payload,
          };
    });
  }
  async toggleLike(subjectId: string): Promise<void> {
    if (!this.canDraft() || !this.category || !this.view.detail) return;
    const state = this.view.likes[subjectId];
    if (!state || state.status !== 'known') return;
    const reply = this.view.replies.find((item) => item.id === subjectId),
      root = reply
        ? this.view.discussion?.root
        : (this.view.comments.find((item) => item.id === subjectId) ??
          (this.view.discussion?.root.id === subjectId
            ? this.view.discussion.root
            : undefined));
    if (
      !root ||
      state.targetId !== this.view.detail.id ||
      state.rootId !== root.id ||
      (reply && (state.replyId !== reply.id || state.rootId !== root.id)) ||
      (!reply && state.replyId !== null)
    )
      return;
    const target = this.view.detail,
      category = this.category;
    await this.submit((clientRequestId, context) => {
      const payload = {
        clientRequestId,
        targetId: target.id,
        expectedTargetRevision: target.revision,
        categoryId: category.id,
        expectedCategoryRevision: category.revision,
        rootId: root.id,
        expectedRevision: reply?.revision ?? root.revision,
        expectedLikeRevision: state.revision,
        liked: !state.liked,
      };
      return reply
        ? {
            protocolVersion: 2,
            operation: 'set_reply_like_scoped',
            context,
            payload: {
              ...payload,
              replyId: reply.id,
              expectedRootRevision: root.revision,
            },
          }
        : {
            protocolVersion: 2,
            operation: 'set_comment_like_scoped',
            context,
            payload,
          };
    });
  }
  async toggleSubscription(targetId: string): Promise<void> {
    if (!this.canDraft()) return;
    const target =
        this.view.detail?.id === targetId
          ? this.view.detail
          : this.view.targets.find((item) => item.id === targetId),
      state = this.view.subscriptions[targetId];
    if (!target || !state || state.status !== 'known') return;
    // A catalog may contain targets from many categories; the exact category is re-read before freezing.
    let category = this.category;
    if (category?.id !== target.categoryId) {
      await this.run(
        (cancel) =>
          this.findCategory(this.lease.current(), target.categoryId, cancel),
        (result) => {
          category = result;
        },
        (error) => this.update({ error: ratingScopedError(error) }),
      );
    }
    if (!category || category.id !== target.categoryId || !this.canDraft())
      return;
    const exactCategory = category;
    await this.submit((clientRequestId, context) => ({
      protocolVersion: 2,
      operation: 'set_target_subscription_scoped',
      context,
      payload: {
        clientRequestId,
        targetId: target.id,
        expectedTargetRevision: target.revision,
        categoryId: exactCategory.id,
        expectedCategoryRevision: exactCategory.revision,
        expectedSubscriptionRevision: state.revision,
        subscribed: !state.subscribed,
      },
    }));
  }
  setDefinition(field: 'name' | 'description', value: string): void {
    if (
      this.canDraft() &&
      (this.route.mode === 'create' || this.route.mode === 'edit')
    ) {
      this.draftGeneration++;
      this.confirmation = null;
      this.update({ [field]: value, definitionConfirmation: false });
    }
  }
  confirmDefinition(): void {
    if (
      !this.canDraft() ||
      (this.route.mode !== 'create' && this.route.mode !== 'edit')
    )
      return;
    try {
      this.confirmation = Object.freeze({
        name: canonicalRatingText(this.view.name, 100),
        description: canonicalRatingText(this.view.description, 500, false),
      });
      this.update({ definitionConfirmation: true });
    } catch (error) {
      this.update({ error: ratingScopedError(error) });
    }
  }
  dismissDefinition(): void {
    this.clearContent();
    this.update({ needsRefresh: true, status: '已关闭并清空草稿，请重新加载' });
  }
  async commitDefinition(): Promise<void> {
    if (
      !this.canDraft() ||
      !this.confirmation ||
      !this.view.definitionConfirmation
    )
      return;
    if (this.view.coverEnabled && this.runtime.ratingTargetCover) {
      await this.commitCoverDefinition();
      return;
    }
    const form = this.confirmation,
      category = this.category,
      editing = this.editing;
    if (this.route.mode === 'create' && category)
      await this.submit((clientRequestId, context) => ({
        protocolVersion: 2,
        operation: 'create_target_scoped',
        context,
        payload: {
          clientRequestId,
          categoryId: category.id,
          expectedCategoryRevision: category.revision,
          ...form,
          assetIds: [],
        },
      }));
    else if (this.route.mode === 'edit' && editing)
      await this.submit((clientRequestId, context) => ({
        protocolVersion: 2,
        operation: 'edit_target_scoped',
        context,
        payload: {
          clientRequestId,
          targetId: editing.targetId,
          expectedTargetRevision: editing.revision,
          expectedDefinitionRevision: editing.definitionRevision,
          expectedContentVersion: editing.contentVersion,
          categoryId: editing.categoryId,
          expectedCategoryRevision: editing.categoryRevision,
          ...form,
          assetIds: [],
        },
      }));
  }
  async openCover(targetId?: string, expanded = true): Promise<void> {
    if (
      !this.runtime.ratingTargetCover ||
      !this.coverReader ||
      !this.view.loaded ||
      this.view.frozen
    )
      return;
    const id =
      targetId ??
      this.view.detail?.id ??
      this.view.randomResult?.item?.target.id;
    if (!id || !ratingId(id)) return;
    const expected =
      this.view.detail?.id === id
        ? this.view.detail
        : (this.view.targets.find((target) => target.id === id) ??
          this.view.randomResult?.item?.target);
    if (!expected) return;
    this.coverPreviewOpen = expanded;
    if (expanded) this.clearCoverThumbnails(false);
    this.coverOpening = true;
    try {
      await this.coverReader.load(async (session, cancel) => {
        session.current();
        const context =
          this.route.mode === 'random'
            ? this.randomCoverContext
            : this.coverReadContext();
        if (!context) invalidRating();
        const result = await this.runtime.ratingTargetCover!.detail(
          context,
          id,
          cancel,
        );
        session.current();
        if (result.target.revision !== expected.revision) {
          this.invalidate();
          throw new ClientError(
            'business',
            'Target body and cover changed together',
          );
        }
        return { context, cover: result.cover };
      }, expanded);
    } finally {
      this.coverOpening = false;
      this.coverPreviewOpen = this.coverReader.snapshot().expanded;
      if (!this.coverPreviewOpen) void this.drainCoverThumbnails();
    }
  }
  closeCover(): void {
    this.coverPreviewOpen = false;
    this.coverReader?.clear();
    if (this.view.detail || this.randomCoverContext)
      void this.openCover(undefined, false);
    else void this.drainCoverThumbnails();
  }
  coverFailed(): void {
    this.coverReader?.imageFailed();
  }
  private clearCoverThumbnails(clearVisible = true): void {
    if (!this.thumbnailReaders) return; // Base-constructor reset before field initialization.
    ++this.thumbnailEpoch;
    this.thumbnailLoading = false;
    const readers = [...this.thumbnailReaders.values()];
    this.thumbnailReaders.clear();
    if (clearVisible) {
      this.visibleCovers.clear();
      this.coverPreviewOpen = false;
    }
    for (const reader of readers) reader.dispose();
    this.update({ coverThumbnails: {} });
  }
  coverVisible(targetId: string, visible: boolean): void {
    if (!ratingId(targetId) || this.inactive) return;
    if (visible && this.view.targets.some((target) => target.id === targetId))
      this.visibleCovers.add(targetId);
    else {
      this.visibleCovers.delete(targetId);
      const reader = this.thumbnailReaders.get(targetId);
      this.thumbnailReaders.delete(targetId);
      reader?.dispose();
      const views = { ...this.view.coverThumbnails };
      delete views[targetId];
      this.update({ coverThumbnails: views });
    }
    void this.drainCoverThumbnails();
  }
  coverThumbnailFailed(targetId: string): void {
    this.thumbnailReaders.get(targetId)?.imageFailed();
  }
  coverViewportUnavailable(targetId: string): void {
    const old = this.view.coverThumbnails[targetId];
    if (old?.status === 'unavailable') return;
    this.update({
      coverThumbnails: {
        ...this.view.coverThumbnails,
        [targetId]: { status: 'unavailable', localSrc: '', expanded: false },
      },
    });
  }
  private async drainCoverThumbnails(): Promise<void> {
    if (
      this.thumbnailLoading ||
      this.coverPreviewOpen ||
      this.inactive ||
      !this.view.loaded ||
      this.view.frozen ||
      !this.runtime.ratingTargetCover
    )
      return;
    const epoch = this.thumbnailEpoch;
    this.thumbnailLoading = true;
    try {
      for (const id of this.visibleCovers) {
        if (
          epoch !== this.thumbnailEpoch ||
          this.coverPreviewOpen ||
          this.inactive
        )
          return;
        let reader = this.thumbnailReaders.get(id);
        if (!reader) {
          if (this.thumbnailReaders.size >= 4) continue;
          const created: RatingCoverReadController =
            new RatingCoverReadController(
              this.runtime.sessions,
              this.runtime.ratingCoverDownload,
              this.coverClock,
              (value) => {
                if (this.thumbnailReaders.get(id) !== created) return;
                this.update({
                  coverThumbnails: {
                    ...this.view.coverThumbnails,
                    [id]: value,
                  },
                });
                if (value.status === 'idle' && !this.thumbnailLoading)
                  void this.drainCoverThumbnails();
              },
            );
          this.thumbnailReaders.set(id, created);
          reader = created;
        }
        if (reader.snapshot().status !== 'idle') continue;
        // Sequential admission shares the same 2-I/O/4-lease/10-MiB registry with
        // full preview and uploads. A failed budget/byte read is explicit unavailable.
        await reader.load(async (session, cancel) => {
          session.current();
          const context = this.coverReadContext();
          if (!context) invalidRating();
          const expected = this.view.targets.find((target) => target.id === id);
          if (!expected)
            throw new ClientError('cancelled', 'Target left the page');
          const result = await this.runtime.ratingTargetCover!.detail(
            context,
            id,
            cancel,
          );
          session.current();
          if (result.target.revision !== expected.revision) {
            this.invalidate();
            throw new ClientError(
              'business',
              'Target body and cover changed together',
            );
          }
          return { context, cover: result.cover };
        });
      }
    } finally {
      if (epoch === this.thumbnailEpoch) this.thumbnailLoading = false;
    }
  }
  async chooseCover(): Promise<void> {
    if (!this.canDraft() || !this.view.coverEnabled || !this.coverUploader)
      return;
    const category = this.category,
      editing = this.editing,
      owner = this.runtime.sessions.snapshot();
    const context = ratingTargetCoverContext(this.coverCommandLease.current());
    if (!category && !editing) return;
    this.confirmation = null;
    this.update({ definitionConfirmation: false });
    await this.coverUploader.choose(async (declaration) => {
      const clientRequestId = await this.runtime.newRequestId(),
        commandRequestId = await this.runtime.newRequestId(),
        draftRevision = await this.runtime.newRequestId();
      this.runtime.sessions.assertCurrent(owner);
      if (!this.coverCommandLease.matches(context)) invalidRating();
      return {
        protocolVersion: 3,
        context,
        clientRequestId,
        commandRequestId,
        draftRevision,
        categoryId: editing?.categoryId ?? category!.id,
        expectedCategoryRevision:
          editing?.categoryRevision ?? category!.revision,
        target: editing
          ? {
              targetId: editing.targetId,
              expectedTargetRevision: editing.revision,
              expectedDefinitionRevision: editing.definitionRevision,
              expectedContentVersion: editing.contentVersion,
            }
          : null,
        declaration,
      };
    });
    if (this.coverUploader.snapshot().status === 'ready')
      this.update({ coverAction: 'replace' });
  }
  setCoverAction(action: 'keep' | 'clear'): void {
    if (
      !this.canDraft() ||
      !this.view.coverEnabled ||
      (action === 'keep' && this.route.mode !== 'edit')
    )
      return;
    try {
      if (this.runtime.pendingRatings!.loadCoverUpload(this.accountId()!))
        throw new ClientError('business', '请先明确取消原封面请求');
      this.coverUploader?.hide();
      this.coverChange = { action };
      this.confirmation = null;
      this.update({ coverAction: action, definitionConfirmation: false });
    } catch (error) {
      this.update({ error: ratingScopedError(error) });
    }
  }
  async recoverCover(cancelOriginal = false): Promise<void> {
    if (!this.coverUploader) return;
    await this.coverUploader.recover(cancelOriginal);
    if (cancelOriginal) {
      this.update({ needsRefresh: true, status: '请重新读取当前范围后继续' });
    }
  }
  private async commitCoverDefinition(): Promise<void> {
    if (
      !this.confirmation ||
      !this.runtime.ratingTargetCover ||
      !this.runtime.pendingRatings
    )
      return;
    if (
      this.coverUploader &&
      ['selecting', 'uploading'].includes(this.coverUploader.snapshot().status)
    ) {
      this.update({ error: '请先等待当前封面选择或上传结束' });
      return;
    }
    const form = this.confirmation,
      category = this.category,
      editing = this.editing,
      draft = this.draftGeneration;
    const owner = this.runtime.sessions.snapshot(),
      accountId = this.accountId()!;
    let context: RatingScopedCommandContext;
    try {
      this.assertCoverContextPair();
      context = ratingTargetCoverContext(this.coverCommandLease.current());
    } catch (error) {
      this.update({ error: ratingScopedError(error) });
      return;
    }
    await this.run(
      async (cancel) => {
        const upload = this.runtime.pendingRatings!.loadCoverUpload(accountId);
        const clientRequestId =
          upload?.scopeInput.commandRequestId ??
          (await this.runtime.newRequestId());
        this.runtime.sessions.assertCurrent(owner);
        if (
          cancel.isCancelled ||
          draft !== this.draftGeneration ||
          form !== this.confirmation ||
          !this.coverCommandLease.matches(context)
        )
          invalidRating();
        let cover = this.coverChange;
        if (upload) {
          if (!upload.scope || upload.status?.status !== 'ready_unbound')
            throw new ClientError('business', '封面尚未准备好');
          cover = {
            action: 'replace',
            assetId: upload.status.assetId,
            uploadScopeId: upload.scope.scopeId,
          };
        }
        const intent = decodeRatingTargetCoverIntent({
          protocolVersion: 3,
          operation: editing ? 'edit_target_scoped' : 'create_target_scoped',
          context,
          payload: {
            clientRequestId,
            categoryId: editing?.categoryId ?? category!.id,
            expectedCategoryRevision:
              editing?.categoryRevision ?? category!.revision,
            ...form,
            cover,
            ...(editing
              ? {
                  targetId: editing.targetId,
                  expectedTargetRevision: editing.revision,
                  expectedDefinitionRevision: editing.definitionRevision,
                  expectedContentVersion: editing.contentVersion,
                }
              : {}),
          },
        });
        const attempt = upload
          ? this.runtime.pendingRatings!.sealCoverUpload(upload, intent)
          : this.runtime.pendingRatings!.freeze({
              version: 11,
              accountId,
              intent,
            });
        this.pending = attempt;
        this.coverUploader?.hide();
        this.confirmation = null;
        this.showPending(attempt);
        return runRatingCommand(this.runtime, attempt, cancel, true);
      },
      (receipt) => this.settle(receipt),
      (error) =>
        this.update({
          error: ratingScopedError(error),
          status: '原请求仍待确认，请勿新建替代请求',
        }),
    );
  }
  private async submit(
    make: (
      requestId: string,
      context: RatingScopedCommandContext,
    ) => RatingScopedIntent,
  ): Promise<void> {
    if (!this.canDraft() || !this.journal() || this.pending) return;
    const owner = this.runtime.sessions.snapshot(),
      accountId = this.accountId()!,
      draft = this.draftGeneration,
      readGeneration = this.lease.capture(),
      generation = this.commandLease.capture();
    const purpose = this.commandPurpose();
    let context: RatingScopedCommandContext;
    try {
      this.assertContextPair();
      context = this.commandLease.command(purpose);
    } catch (error) {
      this.invalidate();
      this.update({ error: ratingScopedError(error) });
      return;
    }
    await this.run(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (
          cancel.isCancelled ||
          !this.lease.isCurrent(readGeneration) ||
          !this.commandLease.isCurrent(generation) ||
          draft !== this.draftGeneration ||
          !this.commandLease.matches(context)
        )
          throw new ClientError(
            'cancelled',
            'Scoped draft changed before persistence',
          );
        this.assertContextPair();
        const intent = decodeRatingScopedIntent(make(clientRequestId, context));
        const attempt = this.runtime.pendingRatings!.freeze({
          version: 9,
          accountId,
          intent,
        });
        this.pending = attempt;
        this.confirmation = null;
        this.replyTo = null;
        this.showPending(attempt);
        return runRatingCommand(this.runtime, attempt, cancel, true);
      },
      (receipt) => this.settle(receipt),
      (error) => {
        this.update({
          error: ratingScopedError(error),
          status: this.pending
            ? '结果尚未确认；原编号和原始内容已保留'
            : '请求尚未发送，请重新确认',
        });
      },
    );
  }
  private settle(raw: RatingCommandReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidRating();
    const receipt = settleRatingCommand(this.runtime, this.pending, raw);
    this.pending = null;
    this.clearContent();
    const closed =
      receipt.outcome === 'closed' || receipt.outcome === 'rejected';
    this.update({
      frozen: false,
      canCancelPending: false,
      recoveryOperation: '',
      needsRefresh: true,
      receiptStatus: closed
        ? ratingScopedError(
            new ClientError('business', 'Closed', { serverCode: receipt.code }),
          )
        : `${ratingCommandLabels[receipt.operation]}已确认；请重新读取当前内容`,
      status: '原请求已确认，刷新后才能继续',
      error: '',
    });
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.journal() || !this.pending) return;
    const attempt = this.pending;
    this.clearContent();
    this.showPending(attempt);
    await this.run(
      (cancel) => runRatingCommand(this.runtime, attempt, cancel, retry),
      (receipt) => this.settle(receipt),
      (error) =>
        this.update({
          frozen: true,
          error: ratingScopedError(error),
          status: '原请求仍待确认；未查到回执不能替换原请求',
        }),
    );
  }
  requestCancelPending(): void {
    if (!this.view.busy && this.view.canCancelPending)
      this.update({ cancelPendingConfirmation: true });
  }
  dismissCancelPending(): void {
    this.update({ cancelPendingConfirmation: false });
  }
  async cancelPending(): Promise<void> {
    if (
      !this.view.busy &&
      this.view.cancelPendingConfirmation &&
      this.pending &&
      isRatingTargetCoverIntent(this.pending.intent) &&
      this.runtime.ratingTargetCover
    ) {
      const intent = this.pending.intent,
        attempt = this.pending;
      await this.run(
        async (cancel) => {
          await this.runtime.ratingTargetCover!.cancel(intent, cancel);
          return runRatingCommand(this.runtime, attempt, cancel, false);
        },
        (receipt) => this.settle(receipt),
        (error) => this.update({ error: ratingScopedError(error) }),
      );
      return;
    }
    if (
      this.view.busy ||
      !this.view.cancelPendingConfirmation ||
      !this.journal() ||
      !this.pending ||
      !isRatingScopedIntent(this.pending.intent) ||
      !this.runtime.ratingScoped
    )
      return;
    const intent = this.pending.intent;
    if (
      intent.operation !== 'create_target_scoped' &&
      intent.operation !== 'edit_target_scoped'
    )
      return;
    await this.run(
      (cancel) => this.runtime.ratingScoped!.cancel(intent, cancel),
      (receipt) => this.settle(receipt),
      (error) =>
        this.update({
          error: ratingScopedError(error),
          status: '取消结果尚未确认，请保留原请求',
        }),
    );
  }
  async selectSort(
    sort: 'time' | 'likes',
    order: 'asc' | 'desc',
  ): Promise<void> {
    if (!['time', 'likes'].includes(sort) || !['asc', 'desc'].includes(order))
      return;
    this.sort = sort;
    this.order = order;
    await this.reload();
  }
  async openCampusPicker(): Promise<void> {
    if (!this.available() || this.view.frozen) return;
    this.clearContent();
    this.update({ pickerOpen: true, campusQuery: '', campuses: [] });
    await this.searchCampuses(1);
  }
  closeCampusPicker(): void {
    this.stop();
    this.lease.clear();
    this.commandLease.clear();
    this.coverReadLease.clear();
    this.coverCommandLease.clear();
    this.draftGeneration++;
    this.update({
      busy: false,
      pickerOpen: false,
      campusQuery: '',
      campuses: [],
      hasMoreCampuses: false,
      needsRefresh: true,
    });
  }
  setCampusQuery(value: string): void {
    if (this.view.pickerOpen) {
      this.stop();
      this.update({
        busy: false,
        campusQuery: value,
        campuses: [],
        hasMoreCampuses: false,
      });
    }
  }
  async searchCampuses(page = 1): Promise<void> {
    if (
      !this.available() ||
      !this.view.pickerOpen ||
      !this.runtime.profiles ||
      !Number.isInteger(page) ||
      page < 1
    )
      return;
    const q = this.view.campusQuery.trim();
    await this.run(
      (cancel) =>
        this.runtime.profiles!.campuses(
          { page, pageSize: 20, q, district: '' },
          cancel,
        ),
      (raw) => {
        const result = decodeCampusPage(raw);
        this.update({
          campuses: result.items,
          campusPage: page,
          hasMoreCampuses: page * result.pageSize < result.total,
        });
      },
    );
  }
  async selectCampus(campusId: string | null): Promise<void> {
    if (!this.available() || this.view.frozen) return;
    if (
      campusId !== null &&
      !this.view.campuses.some(
        (campus) => campus.id === campusId && campus.isActive,
      )
    )
      return;
    this.route = {
      ...this.route,
      selector:
        campusId === null ? { kind: 'global' } : { kind: 'campus', campusId },
    };
    const { protocolGeneration: previousGeneration, ...route } = this.route;
    void previousGeneration;
    this.route = route;
    await this.reload();
  }
  setMinimumAverage(value: string): void {
    if (!this.view.busy && !this.view.frozen) {
      this.lease.clear();
      this.commandLease.clear();
      this.update({ minimumAverageInput: value, randomResult: null });
    }
  }
  async draw(): Promise<void> {
    if (
      !this.available() ||
      this.view.busy ||
      this.view.frozen ||
      this.route.mode !== 'random' ||
      !this.route.categoryId ||
      !this.runtime.ratingScoped ||
      !this.journal() ||
      this.pending
    )
      return;
    const text = this.view.minimumAverageInput.trim(),
      minimumAverage = text === '' ? null : Number(text);
    if (
      minimumAverage !== null &&
      (!/^\d(?:\.\d)?$/.test(text) || minimumAverage < 1 || minimumAverage > 5)
    ) {
      this.update({ error: '均分门槛请输入 1 至 5，最多一位小数，或清空' });
      return;
    }
    this.lease.clear();
    this.commandLease.clear();
    this.coverReadLease.clear();
    this.coverCommandLease.clear();
    this.coverReader?.clear();
    this.randomCoverContext = null;
    this.update({ randomResult: null });
    await this.run(
      async (cancel) => {
        const request: RatingScopedContextRequest = {
          purpose: 'random',
          selector: ratingRandomSelector(this.route.selector),
          mode: 'public',
        };
        if (this.runtime.ratingTargetCover) {
          const context = await this.issueCover(request, cancel);
          return this.runtime.ratingTargetCover.random(
            context,
            this.route.categoryId!,
            minimumAverage,
            cancel,
          );
        }
        const context = await this.issue(request, cancel);
        return this.runtime.ratingScoped!.random(
          context,
          this.route.categoryId!,
          minimumAverage,
          cancel,
        );
      },
      (result) => {
        // Never render a read token/context into setData. The selected read3 lease
        // stays private; every image load rechecks the selected target projection.
        const item = result.item;
        if (item && 'coverContext' in item)
          this.randomCoverContext =
            item.coverContext as RatingTargetCoverContext;
        this.update({
          randomResult: {
            context: result.context,
            candidateCount: result.candidateCount,
            item: item
              ? {
                  locator: item.locator,
                  target: item.target,
                  summary: item.summary,
                }
              : null,
          },
          status: item
            ? '已按不同目标均匀抽取'
            : '合法分类下没有满足条件的目标',
        });
        if (this.randomCoverContext) void this.openCover(undefined, false);
      },
      (error) =>
        this.update({ randomResult: null, error: ratingScopedError(error) }),
    );
  }
  async selectNoticeKind(kind: RatingScopedNoticeKind): Promise<void> {
    if (!['updates', 'like-updates', 'subscription-updates'].includes(kind))
      return;
    this.clearContent();
    this.update({ noticeKind: kind });
    await this.loadNotices();
  }
  private async loadNotices(more = false): Promise<void> {
    if (!this.available() || this.view.busy || !this.runtime.ratingScoped)
      return;
    const cursor = more ? (this.cursors.notices ?? null) : null,
      kind = this.view.noticeKind;
    if (more && !cursor) return;
    if (cursor) {
      const seen = this.seenCursors.notices ?? new Set<string>();
      if (seen.has(cursor)) {
        this.invalidate();
        return;
      }
      seen.add(cursor);
      this.seenCursors.notices = seen;
    }
    await this.run(
      (cancel) => this.runtime.ratingScoped!.updates(kind, cursor, cancel),
      (page) => {
        this.cursors.notices = page.nextCursor;
        if (
          more &&
          page.items.some((item) =>
            this.view.notices.some((old) => old.noticeId === item.noticeId),
          )
        )
          invalidRating();
        this.update({
          loaded: true,
          notices: more ? [...this.view.notices, ...page.items] : page.items,
          unreadCount: page.unreadCount,
          canMoreNotices: page.nextCursor !== null,
          status: '更新仅显示历史元数据；请明确选择范围后核验目标',
        });
      },
    );
  }
  async noticePath(noticeId: string): Promise<string | null> {
    if (
      !this.canDraft() ||
      !this.view.notices.some((notice) => notice.noticeId === noticeId) ||
      !this.runtime.ratingScoped
    )
      return null;
    let path: string | null = null;
    await this.run(
      async (cancel) => {
        this.lease.clear();
        this.commandLease.clear();
        const context = await this.issue(
            { purpose: 'read', selector: this.route.selector, mode: 'public' },
            cancel,
          ),
          result = await this.runtime.ratingScoped!.noticeTarget(
            this.view.noticeKind,
            noticeId,
            context,
            cancel,
          );
        if (result.status === 'unavailable')
          throw new ClientError(
            'business',
            'Notice unavailable in selected scope',
            { serverCode: 'RATING_NOT_FOUND' },
          );
        const resolved = await this.runtime.ratingScoped!.resolve(
          result.target,
          'read',
          cancel,
        );
        this.assertRead(cancel, context);
        const legacyNotices =
          this.view.noticeKind === 'updates'
            ? this.runtime.ratingUpdates
            : this.view.noticeKind === 'like-updates'
              ? this.runtime.ratingLikeUpdates
              : this.runtime.ratingSubscriptionUpdates;
        // Read-state remains the original notice ID and original v1 owner route.
        if (legacyNotices) await legacyNotices.markRead(noticeId, cancel);
        return ratingScopedLocatorPath(resolved.locator);
      },
      (result) => {
        path = result;
      },
      (error) => this.update({ error: ratingScopedError(error) }),
    );
    return this.inactive ? null : path;
  }
  navigationPath(mode: RatingScopedMode, id?: string): string | null {
    if (!this.canDraft()) return null;
    let context: RatingScopedContext;
    try {
      context = this.lease.current();
    } catch {
      return null;
    }
    if (context.purpose === 'random')
      return mode === 'detail' && this.view.randomResult?.item
        ? ratingScopedLocatorPath(this.view.randomResult.item.locator)
        : null;
    if (mode === 'catalog' || mode === 'create' || mode === 'random') {
      const category =
        this.view.categories.find((item) => item.id === id) ??
        (this.category?.id === id ? this.category : undefined);
      if (!category || (mode === 'create' && category.kind !== 'general'))
        return null;
      return ratingScopedPath({
        mode,
        selector: context.selector,
        categoryId: category.id,
        protocolGeneration: context.protocolGeneration,
      });
    }
    const target = id
      ? (this.view.targets.find((item) => item.id === id) ??
        (this.view.detail?.id === id ? this.view.detail : undefined))
      : this.view.detail;
    if ((mode === 'detail' || mode === 'edit') && target)
      return ratingScopedPath({
        mode,
        selector: context.selector,
        targetId: target.id,
        protocolGeneration: context.protocolGeneration,
      });
    if (mode === 'thread') {
      const root = this.view.comments.find((item) => item.id === id);
      if (!root) return null;
      return ratingScopedLocatorPath({
        selector: context.selector,
        targetId: root.targetId,
        rootId: root.id,
        replyId: null,
        protocolGeneration: context.protocolGeneration,
      });
    }
    return null;
  }
  async categoryManagementPath(): Promise<string | null> {
    if (
      !this.available() ||
      this.view.busy ||
      this.view.frozen ||
      !this.runtime.ratingCategoryScoped
    )
      return null;
    const selector = this.route.selector;
    let path: string | null = null;
    await this.run(
      (cancel) => this.runtime.ratingCategoryScoped!.context(selector, cancel),
      (context) => {
        if (
          ratingNavigationKey(context.commandContext.selector) !==
          ratingNavigationKey(selector)
        )
          invalidRating();
        if (!context.operations.length) {
          this.update({ error: '当前范围没有可用分类管理操作' });
          return;
        }
        path = ratingCategoryScopedPath({ selector, categoryId: null });
      },
      () =>
        this.update({
          error: '当前范围的管理授权或来源暂不可用；普通评分仍可独立使用',
        }),
    );
    return path;
  }
  sectionPath(mode: 'catalog' | 'updates' | 'subscriptions'): string | null {
    if (!this.available() || this.view.busy || this.view.frozen) return null;
    return ratingScopedPath({ mode, selector: this.route.selector });
  }
  randomPath(): string | null {
    return !this.inactive && !this.view.busy && this.view.randomResult?.item
      ? ratingScopedLocatorPath(this.view.randomResult.item.locator)
      : null;
  }
  cleanupPath(subjectId?: string): string | null {
    if (!this.canDraft() || !this.view.detail) return null;
    if (!subjectId) return ratingTargetOwnerDeletionPath(this.view.detail.id);
    const reply = this.view.replies.find((item) => item.id === subjectId),
      root =
        this.view.comments.find((item) => item.id === subjectId) ??
        (this.view.discussion?.root.id === subjectId
          ? this.view.discussion.root
          : undefined);
    return reply
      ? ratingDeletionPath({
          subjectKind: 'reply',
          targetId: reply.targetId,
          rootId: reply.rootId,
          subjectId: reply.id,
        })
      : root
        ? ratingDeletionPath({
            subjectKind: 'comment',
            targetId: root.targetId,
            rootId: root.id,
            subjectId: root.id,
          })
        : null;
  }
  override cancel(): void {
    this.clearContent();
    this.update({
      needsRefresh: true,
      status: '已关闭当前操作，原请求仍可在恢复入口查询',
    });
  }
  override dispose(): void {
    if (this.inactive) return;
    this.inactive = true;
    this.coverUploader?.dispose();
    this.coverReader?.dispose();
    this.clearCoverThumbnails();
    this.coverReadLease.dispose();
    this.coverCommandLease.dispose();
    this.lease.dispose();
    this.commandLease.dispose();
    this.subscriptionsToChanges.forEach((unsubscribe) => unsubscribe());
    super.dispose();
  }
}
