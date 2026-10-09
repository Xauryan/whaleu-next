import { readRatingLikeStates, type RatingLikeStates } from './like-controller';
import type { RatingCommentSort } from './gateway';
import { ClientError, isRecord } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import {
  canonicalRatingText,
  decodeRatingCategoryPage,
  decodeRatingCommentPage,
  decodeRatingContext,
  decodeRatingMyScore,
  decodeRatingSummary,
  decodeRatingTarget,
  decodeRatingTargetPage,
  invalidRating,
  ratingId,
  type RatingAuthorMode,
  type RatingCategory,
  type RatingComment,
  type RatingContext,
  type RatingMyScore,
  type RatingSummary,
  type RatingTarget,
} from './contract';
import {
  ratingIntentTarget,
  decodeRatingCommandIntent,
  type RatingCommandIntent,
  type PendingRating,
  type RatingCommandReceipt,
} from './pending';
import { ratingCommandLabels as labels, runRatingCommand } from './commands';
export type RatingMode = 'catalog' | 'detail' | 'recovery';
export interface RatingRoute {
  readonly regionId?: string;
  readonly parentId?: string;
  readonly targetId?: string;
}
export function decodeRatingRoute(
  value: unknown,
  mode: RatingMode,
): RatingRoute {
  if (!isRecord(value)) invalidRating();
  const keys =
    mode === 'catalog'
      ? ['regionId', 'parentId']
      : mode === 'detail'
        ? ['regionId', 'targetId']
        : [];
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    Object.values(value).some((id) => !ratingId(id)) ||
    (mode === 'detail' && !ratingId(value.targetId))
  )
    invalidRating();
  return Object.freeze({
    ...(value.regionId ? { regionId: value.regionId as string } : {}),
    ...(value.parentId ? { parentId: value.parentId as string } : {}),
    ...(value.targetId ? { targetId: value.targetId as string } : {}),
  });
}
export interface RatingView extends CommunityView {
  readonly loaded: boolean;
  readonly regionId: string | null;
  readonly parentId: string | null;
  readonly regions: RatingContext['regions'];
  readonly regionsLoaded: boolean;
  readonly categories: readonly RatingCategory[];
  readonly targets: readonly RatingTarget[];
  readonly detail: RatingTarget | null;
  readonly myScore: RatingMyScore['myScore'];
  readonly myScoreKnown: boolean;
  readonly summary: RatingSummary | null;
  readonly comments: readonly RatingComment[];
  readonly likes: RatingLikeStates;
  readonly commentSort: 'time' | 'likes';
  readonly commentOrder: 'asc' | 'desc';
  readonly canMoreCategories: boolean;
  readonly canMoreTargets: boolean;
  readonly canMoreComments: boolean;
  readonly selectedScore: number | null;
  readonly composerOpen: boolean;
  readonly text: string;
  readonly textLength: number;
  readonly authorMode: RatingAuthorMode | null;
  readonly deleteId: string | null;
  readonly frozen: boolean;
  readonly recoveryOperation: string;
  readonly recoveryTargetId: string;
  readonly receiptStatus: string;
  readonly confirmedTargetId: string;
  readonly needsRefresh: boolean;
}
export const initialRatingView = (): RatingView => ({
  ...initialCommunityView(),
  loaded: false,
  regionId: null,
  parentId: null,
  regions: [],
  regionsLoaded: false,
  categories: [],
  targets: [],
  detail: null,
  myScore: null,
  myScoreKnown: false,
  summary: null,
  comments: [],
  likes: {},
  commentSort: 'time',
  commentOrder: 'desc',
  canMoreCategories: false,
  canMoreTargets: false,
  canMoreComments: false,
  selectedScore: null,
  composerOpen: false,
  text: '',
  textLength: 0,
  authorMode: null,
  deleteId: null,
  frozen: false,
  recoveryOperation: '',
  recoveryTargetId: '',
  receiptStatus: '',
  confirmedTargetId: '',
  needsRefresh: false,
});
export function ratingError(error: unknown): string {
  const code = error instanceof ClientError ? error.details.serverCode : null;
  return (
    (
      {
        DISCOVERY_RESTART_REQUIRED:
          '评价排序或访问状态已变化，请重新加载；旧分页已清除',
        RATING_NOT_FOUND: '评分目标或文字评价不存在，或当前不可查看',
        RATING_UNAVAILABLE: '评分目录或必要授权暂不能确认，请稍后重新加载',
        RATING_SCOPE_UNAVAILABLE:
          '此地区当前不可访问；浏览校区不会授予评分权限',
        RATING_SCORE_UNAVAILABLE:
          '评分历史尚不能确认；自己的评分和统计不能视为零',
        RATING_REVISION_CONFLICT:
          '评分或目标已被更新，请刷新后重新选择并确认；未覆盖其他设备的修改',
        CONTENT_REVIEW_UNAVAILABLE:
          '文字审核暂不可用；当前版本尚未开放审核签发，原请求仍保留',
      } as Record<string, string>
    )[code ?? ''] ?? communityError(error)
  );
}
type PageKind = 'categories' | 'targets' | 'comments';
/** Current views have an account/epoch/selection owner. Receipts settle history, never current score or text. */
export class RatingController extends CommunityController<RatingView> {
  private route: RatingRoute = {};
  private sortSelection: RatingCommentSort | undefined;
  private inactive = false;
  private sequence = 0;
  private pending: PendingRating | null = null;
  private catalogRevision: string | null = null;
  private cursors: Record<PageKind, string | null> = {
    categories: null,
    targets: null,
    comments: null,
  };
  private seen: Record<PageKind, Set<string>> = {
    categories: new Set(),
    targets: new Set(),
    comments: new Set(),
  };
  private readonly unsubscribeScope: () => void;
  private readonly unsubscribeBrowse: () => void;
  constructor(
    runtime: CommunityRuntime,
    private readonly mode: RatingMode,
    render: (view: RatingView) => void,
  ) {
    super(runtime, initialRatingView, render);
    const invalidate = (accountId?: string) => {
      if (accountId !== undefined && accountId !== this.accountId()) return;
      this.stop();
      this.resetPrivate();
      this.update({
        ...initialRatingView(),
        configured: !!runtime.ratings && !!runtime.pendingRatings,
        hasSession: !!this.accountId(),
        status: '身份或浏览校区已变化，正文、评分和分页已清除，请重新加载',
      });
    };
    this.unsubscribeScope =
      runtime.directoryScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeBrowse =
      runtime.browsingScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.update({ configured: !!runtime.ratings && !!runtime.pendingRatings });
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (
      !this.runtime.ratings ||
      !this.runtime.pendingRatings ||
      !this.accountId()
    ) {
      this.update({
        configured: !!this.runtime.ratings && !!this.runtime.pendingRatings,
        error: this.accountId()
          ? '当前构建尚未配置评分服务'
          : '请先登录后使用评分',
        status: '评分暂不可用',
      });
      return false;
    }
    return true;
  }
  protected override resetPrivate(): void {
    this.sortSelection = undefined;
    this.sequence++;
    this.pending = null;
    this.resetPaging();
  }
  protected override onSafetyInvalidated(): void {
    this.update({
      configured: !!this.runtime.ratings && !!this.runtime.pendingRatings,
      status: '安全状态已变化，旧正文和评分已清除，请重新加载',
    });
  }
  private resetPaging(): void {
    this.catalogRevision = null;
    this.cursors = { categories: null, targets: null, comments: null };
    this.seen = {
      categories: new Set(),
      targets: new Set(),
      comments: new Set(),
    };
  }
  private clearCurrent(): void {
    this.stop();
    this.resetPaging();
    this.update({
      busy: false,
      loaded: false,
      categories: [],
      targets: [],
      detail: null,
      myScore: null,
      myScoreKnown: false,
      summary: null,
      comments: [],
      likes: {},
      canMoreCategories: false,
      canMoreTargets: false,
      canMoreComments: false,
      selectedScore: null,
      composerOpen: false,
      text: '',
      textLength: 0,
      authorMode: null,
      deleteId: null,
      error: '',
    });
  }
  private same(sequence: number): boolean {
    return !this.inactive && sequence === this.sequence && !!this.accountId();
  }
  private loadJournal(): boolean {
    if (!this.available()) return false;
    try {
      this.pending = this.runtime.pendingRatings!.load(this.accountId()!);
      if (this.pending) this.showPending(this.pending);
      return true;
    } catch (error) {
      this.clearCurrent();
      this.update({
        frozen: true,
        error: ratingError(error),
        status: '无法读取原评分请求，禁止新建替代请求',
      });
      return false;
    }
  }
  private showPending(attempt: PendingRating): void {
    this.pending = attempt;
    this.update({
      frozen: true,
      recoveryOperation: labels[attempt.intent.operation],
      recoveryTargetId: ratingIntentTarget(attempt.intent),
      selectedScore: null,
      composerOpen: false,
      text: '',
      textLength: 0,
      authorMode: null,
      deleteId: null,
      status: '原请求结果待确认，仅可查询或重试原请求',
    });
  }
  async load(raw: unknown = {}): Promise<void> {
    const sequence = ++this.sequence;
    this.clearCurrent();
    this.update({
      regions: [],
      regionsLoaded: false,
      frozen: false,
      recoveryOperation: '',
      recoveryTargetId: '',
      receiptStatus: '',
      confirmedTargetId: '',
      needsRefresh: false,
    });
    try {
      this.route = decodeRatingRoute(raw, this.mode);
    } catch {
      this.route = {};
      this.update({
        error: '评分链接无效，请返回目录',
        status: '无法打开评分',
      });
      return;
    }
    this.update({
      regionId: this.route.regionId ?? null,
      parentId: this.route.parentId ?? null,
    });
    if (!this.loadJournal()) return;
    if (this.pending) await this.recover(false, false);
    if (
      !this.same(sequence) ||
      this.pending ||
      this.view.frozen ||
      this.view.needsRefresh
    )
      return;
    await this.refresh();
  }
  async reload(): Promise<void> {
    await this.load(this.route);
  }
  private async refresh(): Promise<void> {
    if (this.inactive || this.view.busy || !this.available()) return;
    this.clearCurrent();
    if (this.mode === 'recovery') {
      this.update({
        loaded: true,
        status: this.view.receiptStatus
          ? '原请求已确认；回执不代表当前目标状态'
          : '此账号没有待确认的评分请求',
      });
      return;
    }
    const regionId = this.view.regionId;
    await this.run(
      async (cancel) => {
        if (this.mode === 'catalog') {
          const parentId = this.route.parentId ?? null;
          const categories = decodeRatingCategoryPage(
            await this.runtime.ratings!.categories(
              regionId,
              parentId,
              null,
              cancel,
            ),
          );
          if (
            categories.context.regionId !== regionId ||
            categories.context.parentId !== parentId
          )
            invalidRating();
          const targets =
            parentId === null
              ? null
              : decodeRatingTargetPage(
                  await this.runtime.ratings!.targets(
                    regionId,
                    parentId,
                    null,
                    cancel,
                  ),
                );
          if (
            targets &&
            (targets.context.regionId !== regionId ||
              targets.context.categoryId !== parentId ||
              targets.context.catalogRevision !==
                categories.context.catalogRevision)
          )
            invalidRating();
          return { kind: 'catalog' as const, categories, targets };
        }
        const targetId = this.route.targetId;
        if (!targetId) invalidRating();
        const detail = decodeRatingTarget(
          await this.runtime.ratings!.detail(regionId, targetId, cancel),
        );
        if (detail.id !== targetId) invalidRating();
        let own: RatingMyScore | null = null;
        try {
          own = decodeRatingMyScore(
            await this.runtime.ratings!.myScore(regionId, targetId, cancel),
          );
        } catch (error) {
          if (
            !(error instanceof ClientError) ||
            error.kind !== 'http' ||
            error.details.httpStatus !== 503 ||
            error.details.serverCode !== 'RATING_SCORE_UNAVAILABLE'
          )
            throw error;
        }
        const summary = decodeRatingSummary(
          await this.runtime.ratings!.summary(regionId, targetId, cancel),
        );
        const comments = decodeRatingCommentPage(
          await this.runtime.ratings!.comments(
            regionId,
            targetId,
            null,
            cancel,
            20,
            this.sortSelection,
          ),
        );
        if (
          comments.context.regionId !== regionId ||
          comments.context.targetId !== targetId
        )
          invalidRating();
        const likes = await readRatingLikeStates(
          this.runtime.ratingLikes,
          regionId,
          comments.items.map((item) => ({
            targetId,
            rootId: item.id,
            replyId: null,
          })),
          cancel,
        );
        return {
          kind: 'detail' as const,
          detail,
          own,
          summary,
          comments,
          likes,
        };
      },
      (result) => {
        if (result.kind === 'catalog') {
          this.catalogRevision = result.categories.context.catalogRevision;
          this.cursors.categories = result.categories.nextCursor;
          this.cursors.targets = result.targets?.nextCursor ?? null;
          this.update({
            loaded: true,
            categories: result.categories.items,
            targets: result.targets?.items ?? [],
            canMoreCategories: !!result.categories.nextCursor,
            canMoreTargets: !!result.targets?.nextCursor,
            status: '已读取当前可见分类与直属目标；不会生成示例目录',
          });
        } else {
          this.catalogRevision = result.comments.context.catalogRevision;
          this.cursors.comments = result.comments.nextCursor;
          this.update({
            loaded: true,
            detail: result.detail,
            myScoreKnown: result.own !== null,
            myScore: result.own?.myScore ?? null,
            summary: result.summary,
            comments: result.comments.items,
            likes: result.likes,
            canMoreComments: !!result.comments.nextCursor,
            status: '已重新核验目标、自己的评分与文字评价',
          });
        }
      },
      (error) => {
        this.clearCurrent();
        this.update({
          error: ratingError(error),
          status: '当前内容不可确认，旧正文、评分和分页已清除',
        });
      },
    );
  }
  async selectSort(
    sort: 'time' | 'likes',
    order: 'asc' | 'desc',
  ): Promise<void> {
    if (
      this.mode !== 'detail' ||
      this.inactive ||
      this.view.frozen ||
      !this.available() ||
      !['time', 'likes'].includes(sort) ||
      !['asc', 'desc'].includes(order)
    )
      return;
    this.sortSelection = { sort, order };
    this.sequence++;
    this.clearCurrent();
    this.update({ commentSort: sort, commentOrder: order });
    await this.refresh();
  }
  async loadRegions(): Promise<void> {
    if (this.mode !== 'catalog' || this.view.busy || !this.available()) return;
    this.update({ regions: [], regionsLoaded: false });
    await this.run(
      (cancel) => this.runtime.ratings!.context(cancel),
      (raw) => {
        const context = decodeRatingContext(raw);
        this.update({
          regions: context.regions,
          regionsLoaded: true,
          status: '地区仅来自服务端当前授权；全局目录可独立浏览',
        });
      },
      (error) => {
        this.clearCurrent();
        this.update({
          regions: [],
          regionsLoaded: false,
          error: ratingError(error),
        });
      },
    );
  }
  async selectRegion(regionId: string | null): Promise<void> {
    if (
      this.mode !== 'catalog' ||
      this.view.busy ||
      !this.available() ||
      (regionId !== null &&
        (!ratingId(regionId) ||
          !this.view.regions.some((region) => region.id === regionId)))
    )
      return;
    await this.load(regionId ? { regionId } : {});
  }
  async more(kind: PageKind): Promise<void> {
    if (
      this.inactive ||
      this.view.busy ||
      !this.view.loaded ||
      !this.available() ||
      !['categories', 'targets', 'comments'].includes(kind)
    )
      return;
    let likes: RatingLikeStates = {};
    const cursor = this.cursors[kind],
      regionId = this.view.regionId,
      revision = this.catalogRevision;
    if (!cursor || (kind === 'comments') !== (this.mode === 'detail')) return;
    this.update({
      text: '',
      textLength: 0,
      composerOpen: false,
      authorMode: null,
      selectedScore: null,
      deleteId: null,
    });
    await this.run(
      async (cancel) => {
        if (kind === 'categories') {
          const page = decodeRatingCategoryPage(
            await this.runtime.ratings!.categories(
              regionId,
              this.route.parentId ?? null,
              cursor,
              cancel,
            ),
          );
          if (page.context.parentId !== (this.route.parentId ?? null))
            invalidRating();
          return page;
        }
        if (kind === 'targets') {
          if (!this.route.parentId) invalidRating();
          const page = decodeRatingTargetPage(
            await this.runtime.ratings!.targets(
              regionId,
              this.route.parentId,
              cursor,
              cancel,
            ),
          );
          if (page.context.categoryId !== this.route.parentId) invalidRating();
          return page;
        }
        if (!this.route.targetId) invalidRating();
        const page = decodeRatingCommentPage(
          await this.runtime.ratings!.comments(
            regionId,
            this.route.targetId,
            cursor,
            cancel,
            20,
            this.sortSelection,
          ),
        );
        if (page.context.targetId !== this.route.targetId) invalidRating();
        likes = await readRatingLikeStates(
          this.runtime.ratingLikes,
          regionId,
          page.items.map((item) => ({
            targetId: page.context.targetId,
            rootId: item.id,
            replyId: null,
          })),
          cancel,
        );
        return page;
      },
      (page) => {
        if (
          page.context.regionId !== regionId ||
          page.context.catalogRevision !== revision ||
          (page.nextCursor &&
            (page.nextCursor === cursor ||
              this.seen[kind].has(page.nextCursor)))
        )
          invalidRating();
        if (kind === 'comments')
          this.update({ likes: { ...this.view.likes, ...likes } });
        this.seen[kind].add(cursor);
        this.cursors[kind] = page.nextCursor;
        const current = this.view[kind] as readonly { readonly id: string }[];
        const items = new Map(current.map((item) => [item.id, item]));
        for (const item of page.items) items.set(item.id, item);
        this.update({
          [kind]: [...items.values()],
          [kind === 'categories'
            ? 'canMoreCategories'
            : kind === 'targets'
              ? 'canMoreTargets'
              : 'canMoreComments']: page.nextCursor !== null,
          status:
            page.continuation === 'end'
              ? '已到当前范围末尾'
              : '已加载，可继续浏览',
        });
      },
      (error) => {
        this.clearCurrent();
        this.update({
          error: ratingError(error),
          status: '分页已清除，请重新加载',
        });
      },
    );
  }
  chooseScore(value: number): void {
    if (
      !this.canWrite() ||
      !this.view.myScoreKnown ||
      !this.view.detail?.allowedActions.setScore ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > 5
    )
      return;
    this.update({
      selectedScore: value,
      composerOpen: false,
      text: '',
      textLength: 0,
      authorMode: null,
      deleteId: null,
    });
  }
  dismissScore(): void {
    this.dismiss();
  }
  openComposer(): void {
    if (!this.canWrite() || !this.view.detail?.allowedActions.createComment)
      return;
    this.update({
      composerOpen: true,
      text: '',
      textLength: 0,
      authorMode: null,
      selectedScore: null,
      deleteId: null,
    });
  }
  closeComposer(): void {
    this.dismiss();
  }
  private dismiss(): void {
    // Before persistence this cancels the UUID wait. After dispatch it only stops waiting; the journal survives.
    const wasBusy = this.view.busy;
    this.stop();
    this.sequence++;
    this.update({
      busy: false,
      selectedScore: null,
      composerOpen: false,
      text: '',
      textLength: 0,
      authorMode: null,
      deleteId: null,
    });
    if (wasBusy) {
      this.clearCurrent();
      this.update({
        status: this.view.frozen
          ? '已停止等待，原请求仍需恢复'
          : '已取消确认，未保存的输入已清空',
      });
    }
  }
  setText(value: string): void {
    if (
      this.view.composerOpen &&
      !this.view.busy &&
      !this.view.frozen &&
      !this.inactive &&
      typeof value === 'string'
    )
      this.update({
        text: value,
        textLength: [...value.replace(/\r\n/g, '\n').trim()].length,
      });
  }
  setAuthorMode(mode: RatingAuthorMode): void {
    if (
      this.view.composerOpen &&
      !this.view.busy &&
      !this.view.frozen &&
      !this.inactive &&
      this.view.detail?.allowedActions.authorModes.includes(mode)
    )
      this.update({ authorMode: mode });
  }
  private canWrite(): boolean {
    return (
      !this.inactive &&
      !this.view.busy &&
      !this.view.frozen &&
      this.view.loaded &&
      !!this.view.detail &&
      this.available()
    );
  }
  async confirmScore(): Promise<void> {
    const detail = this.view.detail,
      selected = this.view.selectedScore,
      own = this.view.myScore;
    if (
      !this.canWrite() ||
      !detail?.allowedActions.setScore ||
      !this.view.myScoreKnown ||
      selected === null
    )
      return;
    await this.start((clientRequestId) => ({
      operation: 'set_score',
      targetId: detail.id,
      payload: {
        clientRequestId,
        regionId: this.view.regionId,
        expectedTargetRevision: detail.revision,
        expectedRevision: own?.revision ?? null,
        score: selected,
      },
    }));
  }
  async publish(): Promise<void> {
    const detail = this.view.detail,
      authorMode = this.view.authorMode;
    if (
      !this.canWrite() ||
      !this.view.composerOpen ||
      !detail?.allowedActions.createComment ||
      !authorMode ||
      !detail.allowedActions.authorModes.includes(authorMode)
    )
      return;
    let body: string;
    try {
      body = canonicalRatingText(this.view.text);
    } catch {
      this.update({
        error: '请填写 1–500 个 Unicode 字符的文字，不能包含无效控制字符或图片',
      });
      return;
    }
    await this.start((clientRequestId) => ({
      operation: 'create_comment',
      targetId: detail.id,
      payload: {
        clientRequestId,
        regionId: this.view.regionId,
        expectedTargetRevision: detail.revision,
        authorMode,
        body,
        assetIds: [],
      },
    }));
  }
  confirmDelete(id: string): void {
    if (
      !this.canWrite() ||
      !this.view.comments.some(
        (comment) =>
          comment.id === id && comment.isMine && comment.allowedActions.delete,
      )
    )
      return;
    this.update({
      deleteId: id,
      composerOpen: false,
      text: '',
      textLength: 0,
      authorMode: null,
      selectedScore: null,
    });
  }
  dismissDelete(): void {
    this.dismiss();
  }
  async deleteComment(): Promise<void> {
    const detail = this.view.detail,
      comment = this.view.comments.find(
        (item) => item.id === this.view.deleteId,
      );
    if (
      !this.canWrite() ||
      !detail ||
      !comment?.isMine ||
      !comment.allowedActions.delete ||
      comment.targetId !== detail.id
    )
      return;
    await this.start((clientRequestId) => ({
      operation: 'delete_comment',
      commentId: comment.id,
      payload: {
        clientRequestId,
        regionId: this.view.regionId,
        targetId: detail.id,
        expectedTargetRevision: detail.revision,
        expectedRevision: comment.revision,
      },
    }));
  }
  async toggleLike(id: string): Promise<void> {
    const detail = this.view.detail,
      root = this.view.comments.find((item) => item.id === id),
      state = this.view.likes[id];
    if (
      !this.canWrite() ||
      !this.runtime.ratingLikes ||
      !detail ||
      !root ||
      root.targetId !== detail.id ||
      state?.status !== 'known' ||
      !state.allowedActions.setLike
    )
      return;
    await this.start((clientRequestId) => ({
      operation: 'set_comment_like',
      rootId: id,
      payload: {
        clientRequestId,
        regionId: this.view.regionId,
        targetId: detail.id,
        expectedTargetRevision: detail.revision,
        expectedRevision: root.revision,
        expectedLikeRevision: state.revision,
        liked: !state.liked,
      },
    }));
  }
  private async start(
    make: (id: string) => RatingCommandIntent,
  ): Promise<void> {
    if (!this.loadJournal() || this.pending) return;
    const accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot();
    let refresh = false;
    await this.run(
      async (cancel) => {
        const id = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const attempt = this.runtime.pendingRatings!.freeze({
          version: 2,
          accountId,
          intent: decodeRatingCommandIntent(make(id)),
        });
        this.pending = attempt;
        // Do not cancel this command while clearing the visible snapshots and private form.
        this.resetPaging();
        this.update({
          loaded: false,
          categories: [],
          targets: [],
          detail: null,
          myScore: null,
          myScoreKnown: false,
          summary: null,
          comments: [],
          likes: {},
          canMoreCategories: false,
          canMoreTargets: false,
          canMoreComments: false,
        });
        this.showPending(attempt);
        return this.dispatch(attempt, cancel);
      },
      (receipt) => {
        refresh = this.settle(receipt);
      },
      (error) => {
        this.clearCurrent();
        this.update({
          frozen: true,
          error: ratingError(error),
          status: '结果尚未确认，请查询原回执或重试同一请求',
        });
      },
    );
    if (refresh && !this.inactive && this.accountId() === accountId)
      await this.refresh();
  }
  private dispatch(
    attempt: PendingRating,
    cancel: Cancellation,
  ): Promise<RatingCommandReceipt> {
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    this.runtime.pendingRatings!.assertOriginal(attempt);
    return runRatingCommand(this.runtime, attempt, cancel, true);
  }
  async recover(retry = false, refresh = true): Promise<void> {
    if (this.view.busy || !this.loadJournal() || !this.pending) return;
    const attempt = this.pending;
    this.clearCurrent();
    this.showPending(attempt);
    let reload = false;
    await this.run(
      (cancel) =>
        retry
          ? this.dispatch(attempt, cancel)
          : runRatingCommand(this.runtime, attempt, cancel, false),
      (receipt) => {
        reload = this.settle(receipt);
      },
      (error) => {
        this.clearCurrent();
        this.update({
          frozen: true,
          error: ratingError(error),
          status: '原请求仍待确认，未查到回执不能创建替代请求',
        });
      },
    );
    if (
      reload &&
      refresh &&
      !this.inactive &&
      this.accountId() === attempt.accountId
    )
      await this.refresh();
  }
  private settle(raw: RatingCommandReceipt): boolean {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidRating();
    const receipt = this.runtime.pendingRatings!.settle(this.pending, raw);
    this.pending = this.runtime.pendingRatings!.load(this.accountId()!);
    const success = receipt.outcome !== 'rejected';
    this.update({
      frozen: false,
      recoveryOperation: '',
      recoveryTargetId: '',
      selectedScore: null,
      composerOpen: false,
      text: '',
      textLength: 0,
      authorMode: null,
      deleteId: null,
      receiptStatus: success
        ? `${labels[receipt.operation]}${receipt.outcome === 'noop' ? '未发生变更' : '已确认'}；当前状态需重新读取`
        : ratingError(
            new ClientError('business', 'Rejected', {
              serverCode: receipt.code,
            }),
          ),
      confirmedTargetId: success ? receipt.targetId : '',
      needsRefresh: !success,
      status: '原请求已确认',
      error: '',
    });
    if (this.pending) {
      this.showPending(this.pending);
      return false;
    }
    return success;
  }
  discussionPath(id: string): string | null {
    const root = this.view.comments.find((item) => item.id === id);
    return !this.inactive &&
      !this.view.busy &&
      !!this.accountId() &&
      this.view.loaded &&
      root &&
      root.targetId === this.view.detail?.id
      ? `/pages/rating-thread/rating-thread?targetId=${root.targetId}&rootId=${root.id}${this.view.regionId ? `&regionId=${this.view.regionId}` : ''}`
      : null;
  }
  categoryPath(id: string): string | null {
    return !this.inactive &&
      !this.view.busy &&
      !!this.accountId() &&
      this.view.categories.some((item) => item.id === id)
      ? `/pages/rating-catalog/rating-catalog?parentId=${id}${this.view.regionId ? `&regionId=${this.view.regionId}` : ''}`
      : null;
  }
  targetPath(id: string): string | null {
    return !this.inactive &&
      !this.view.busy &&
      !!this.accountId() &&
      this.view.targets.some((item) => item.id === id)
      ? `/pages/rating-detail/rating-detail?targetId=${id}${this.view.regionId ? `&regionId=${this.view.regionId}` : ''}`
      : null;
  }
  override cancel(): void {
    this.sequence++;
    this.clearCurrent();
    this.update({
      status: '已停止等待，正文、评分与输入已清除；已发送请求仍可能完成',
    });
  }
  override dispose(): void {
    this.inactive = true;
    this.sequence++;
    this.unsubscribeScope();
    this.unsubscribeBrowse();
    super.dispose();
  }
}
