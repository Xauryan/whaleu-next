import { ClientError, clientError } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import {
  courseId,
  courseScore,
  decodeCourseDetail,
  decodeCourseFirstScore,
  decodeCoursePage,
  decodeCourseQuery,
  invalidCourse,
  type Course,
  type CourseDetail,
  type CourseQuery,
  type CourseReceipt,
  type CourseScores,
} from './contract';
import type { PendingCourseRating } from './pending';

export type CourseMode = 'catalog' | 'detail';
export interface CourseRatingView extends CommunityView {
  readonly loaded: boolean;
  readonly items: readonly Course[];
  readonly detail: CourseDetail | null;
  readonly searchDraft: string;
  readonly departmentDraft: number | null;
  readonly categoryDraft: string;
  readonly sortDraft: 'rating' | 'time';
  readonly appliedFilter: string;
  readonly pageNumber: number;
  readonly canNext: boolean;
  readonly restartRequired: boolean;
  readonly gradeScore: number | null;
  readonly abilityScore: number | null;
  readonly overallScore: number | null;
  readonly canScore: boolean;
  readonly canSubmit: boolean;
  readonly confirming: boolean;
  readonly frozen: boolean;
  readonly recoveryCourseId: string;
  readonly recoveryScores: CourseScores | null;
  readonly blocker: string;
  readonly receiptStatus: string;
}
export const initialCourseRatingView = (): CourseRatingView => ({
  ...initialCommunityView(),
  loaded: false,
  items: [],
  detail: null,
  searchDraft: '',
  departmentDraft: null,
  categoryDraft: '',
  sortDraft: 'rating',
  appliedFilter: '',
  pageNumber: 0,
  canNext: false,
  restartRequired: false,
  gradeScore: null,
  abilityScore: null,
  overallScore: null,
  canScore: false,
  canSubmit: false,
  confirming: false,
  frozen: false,
  recoveryCourseId: '',
  recoveryScores: null,
  blocker: '',
  receiptStatus: '',
});
export function courseError(error: unknown): string {
  const failure = clientError(error);
  if (failure.kind === 'protocol') return communityError(failure);
  const code = failure.details.serverCode;
  const messages: Record<string, string> = {
    PHONE_VERIFICATION_REQUIRED: '请先完成手机号验证，再重新加载课程评分',
    COURSE_CATALOG_UNAVAILABLE:
      '课程目录来源尚未确认，暂不能展示课程；这不代表目录为空',
    COURSE_NOT_FOUND: '此课程当前不可查看；原评分仍可独立查询回执',
    COURSE_HISTORY_UNAVAILABLE: '历史评分尚未确认，不能当作未评分或零人评分',
    COURSE_ALREADY_RATED: '此账号已为该课程评分，首次评分不能修改或删除',
    COURSE_REVISION_CONFLICT: '课程目录已变化，请重新加载并明确确认新请求',
    COURSE_CURSOR_INVALID: '分页已经失效，请重新加载课程目录',
    COURSE_RESTART_REQUIRED: '课程目录或评分排序已变化，请从第一页重新加载',
    REQUEST_NOT_FOUND: '暂未查到原回执；原请求仍可能完成，不能创建替代请求',
    SAFETY_ACTION_RESTRICTED: '当前账号暂不能访问课程评分，请稍后重新核验',
  };
  return code && messages[code] ? messages[code]! : communityError(error);
}
/** Current reads are transient. Only the original confirmed tuple and request identity persist. */
export class CourseRatingController extends CommunityController<CourseRatingView> {
  private selectedCourseId: string | null = null;
  private pending: PendingCourseRating | null = null;
  private query: CourseQuery = { sort: 'rating' };
  private nextCursor: string | null = null;
  private catalogRevision: string | null = null;
  private scoreRevision: string | null = null;
  private expectedRecorded: CourseScores | null = null;
  private expectedOwnRecorded = false;
  constructor(
    runtime: CommunityRuntime,
    private readonly mode: CourseMode,
    render: (view: CourseRatingView) => void,
  ) {
    super(runtime, initialCourseRatingView, render);
  }
  protected override resetPrivate(): void {
    this.pending = null;
    this.nextCursor = null;
    this.catalogRevision = null;
    this.scoreRevision = null;
    this.expectedRecorded = null;
    this.expectedOwnRecorded = false;
    this.query = { sort: 'rating' };
  }
  private ready(): boolean {
    if (!this.available()) return false;
    if (!this.runtime.courseRatings || !this.runtime.pendingCourseRatings) {
      this.update({
        error: '当前构建未配置课程评分服务',
        canScore: false,
        canSubmit: false,
      });
      return false;
    }
    return true;
  }
  private restorePending(): boolean {
    const accountId = this.accountId();
    if (!accountId || !this.runtime.pendingCourseRatings) return false;
    try {
      this.pending = this.runtime.pendingCourseRatings.load(accountId);
      if (this.pending) this.showPending(this.pending);
      else
        this.update({
          frozen: false,
          recoveryCourseId: '',
          recoveryScores: null,
        });
      return true;
    } catch (error) {
      this.update({
        frozen: true,
        loaded: false,
        detail: null,
        items: [],
        canNext: false,
        gradeScore: null,
        abilityScore: null,
        overallScore: null,
        canScore: false,
        canSubmit: false,
        confirming: false,
        error: courseError(error),
        blocker: '原评分记录暂不能读取，已禁止创建新请求',
      });
      return false;
    }
  }
  private showPending(attempt: PendingCourseRating): void {
    this.pending = attempt;
    this.update({
      frozen: true,
      loaded: false,
      detail: null,
      items: [],
      canNext: false,
      gradeScore: null,
      abilityScore: null,
      overallScore: null,
      canScore: false,
      canSubmit: false,
      confirming: false,
      recoveryCourseId: attempt.courseId,
      recoveryScores: {
        gradeScore: attempt.payload.gradeScore,
        abilityScore: attempt.payload.abilityScore,
        overallScore: attempt.payload.overallScore,
      },
      blocker:
        '原评分结果待确认。三个分数、目录版本、课程版本和请求编号保持不变',
      status: '原评分结果待确认',
    });
  }
  async load(id: string | null = null): Promise<void> {
    if (this.view.busy) return;
    if (this.mode === 'detail' && !courseId(id)) {
      this.update({ error: '课程入口无效，请从目录重新进入' });
      return;
    }
    this.selectedCourseId = id;
    await this.reload();
  }
  async reload(): Promise<void> {
    if (this.view.busy || !this.ready()) return;
    // Restoration is independent of catalog visibility, phone and Safety eligibility.
    this.restorePending();
    if (this.mode === 'detail') await this.loadDetail();
    else await this.loadPage(null);
  }
  setSearch(value: string): void {
    if (this.view.busy) return;
    this.update({ searchDraft: value, restartRequired: false });
  }
  setDepartment(value: number | null): void {
    if (
      this.view.busy ||
      (value !== null &&
        !(
          Number.isInteger(value) &&
          ((value >= 1 && value <= 54) || value === 99)
        ))
    )
      return;
    this.update({
      departmentDraft: value,
      categoryDraft: '',
      restartRequired: false,
    });
  }
  setCategory(value: string): void {
    if (this.view.busy) return;
    this.update({
      categoryDraft: value,
      departmentDraft: null,
      restartRequired: false,
    });
  }
  setSort(value: unknown): void {
    if (this.view.busy || (value !== 'rating' && value !== 'time')) return;
    this.update({ sortDraft: value });
  }
  async search(): Promise<void> {
    if (this.view.busy || this.mode !== 'catalog' || !this.ready()) return;
    try {
      this.query = decodeCourseQuery({
        sort: this.view.sortDraft,
        ...(this.view.searchDraft.trim()
          ? { search: this.view.searchDraft }
          : {}),
        ...(this.view.departmentDraft === null
          ? {}
          : { department: this.view.departmentDraft }),
        ...(this.view.categoryDraft.trim()
          ? { category: this.view.categoryDraft }
          : {}),
      });
    } catch {
      this.update({
        error: '课程名称和类别最多 80 字；院系与类别只能选择一个',
      });
      return;
    }
    await this.loadPage(null);
  }
  async next(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.canNext ||
      !this.nextCursor ||
      !this.ready()
    )
      return;
    await this.loadPage(this.nextCursor);
  }
  private async loadPage(cursor: string | null): Promise<void> {
    const query = this.query,
      revision = this.catalogRevision,
      scoreRevision = this.scoreRevision;
    const pageNumber = cursor ? this.view.pageNumber + 1 : 1;
    this.nextCursor = null;
    this.update({
      loaded: false,
      items: [],
      canNext: false,
      restartRequired: false,
      status: '正在核验课程目录',
    });
    await this.run(
      async (cancel) => {
        const page = decodeCoursePage(
          await this.runtime.courseRatings!.list(query, cursor, cancel),
        );
        if (
          cursor &&
          (page.catalogRevision !== revision ||
            page.scoreRevision !== scoreRevision)
        )
          throw new ClientError('business', 'Course snapshot changed', {
            serverCode: 'COURSE_RESTART_REQUIRED',
          });
        if (cursor && page.nextCursor === cursor) invalidCourse();
        return page;
      },
      (page) => {
        this.catalogRevision = page.catalogRevision;
        this.scoreRevision = page.scoreRevision;
        this.nextCursor = page.nextCursor;
        this.update({
          loaded: true,
          items: page.items,
          pageNumber,
          canNext: page.nextCursor !== null,
          appliedFilter: [
            query.search ? `名称：${query.search}` : '全部名称',
            query.department === 99
              ? '旧分类 90–99 分组'
              : query.department
                ? `院系 ${query.department}`
                : query.category
                  ? `类别：${query.category}`
                  : '全部院系与类别',
            query.sort === 'time' ? '按时间' : '按综合评分',
          ].join(' · '),
          status: page.items.length
            ? '课程目录已加载'
            : '当前查询已确认没有课程',
        });
      },
      (error) => {
        this.catalogRevision = null;
        this.scoreRevision = null;
        this.update({
          loaded: false,
          items: [],
          canNext: false,
          pageNumber: 0,
          restartRequired: cursor !== null,
          error: courseError(error),
          status: '课程目录暂不可用',
        });
      },
    );
  }
  private async loadDetail(): Promise<void> {
    const id = this.selectedCourseId;
    if (!id) return;
    this.update({
      loaded: false,
      detail: null,
      canScore: false,
      canSubmit: false,
      confirming: false,
      gradeScore: null,
      abilityScore: null,
      overallScore: null,
      status: '正在核验课程与评分历史',
    });
    await this.run(
      async (cancel) => {
        const detail = decodeCourseDetail(
          await this.runtime.courseRatings!.detail(id, cancel),
        );
        if (
          detail.course.id !== id ||
          (this.expectedOwnRecorded && detail.myScore.kind !== 'recorded')
        )
          invalidCourse();
        if (
          this.expectedRecorded &&
          (detail.myScore.kind !== 'recorded' ||
            detail.myScore.gradeScore !== this.expectedRecorded.gradeScore ||
            detail.myScore.abilityScore !==
              this.expectedRecorded.abilityScore ||
            detail.myScore.overallScore !== this.expectedRecorded.overallScore)
        )
          invalidCourse();
        return detail;
      },
      (detail) => {
        this.expectedRecorded = null;
        this.expectedOwnRecorded = false;
        const storageReady = this.restorePending();
        const known =
          detail.myScore.kind === 'not_submitted' &&
          detail.course.summary.kind === 'known';
        const canScore = storageReady && !this.pending && known;
        this.update({
          loaded: true,
          detail,
          canScore,
          canSubmit: false,
          blocker:
            this.pending || !storageReady
              ? this.view.blocker
              : detail.myScore.kind === 'recorded'
                ? '每个账号对每门课只有一次评分，不能修改或删除'
                : !known
                  ? '自己的评分或历史总量暂不能确认，不能新建评分'
                  : '三个维度分别选择 0.5 至 5 分；综合评分独立选择',
          status: this.pending
            ? '原评分结果待确认'
            : detail.myScore.kind === 'recorded'
              ? '已评分，首次分数已锁定'
              : known
                ? '课程已加载，尚未评分'
                : '课程已加载，评分历史暂不可用',
        });
      },
      (error) =>
        this.update({
          error: courseError(error),
          loaded: false,
          detail: null,
          canScore: false,
          canSubmit: false,
          confirming: false,
          status: '课程详情暂不可用',
        }),
    );
  }
  chooseScore(axis: string, value: unknown): void {
    if (
      this.view.busy ||
      this.view.confirming ||
      !this.view.canScore ||
      this.view.frozen ||
      !['gradeScore', 'abilityScore', 'overallScore'].includes(axis) ||
      !courseScore(value)
    )
      return;
    if (!this.restorePending() || this.pending) return;
    this.update({ [axis]: value } as Partial<CourseRatingView>);
    this.update({
      canSubmit:
        courseScore(this.view.gradeScore) &&
        courseScore(this.view.abilityScore) &&
        courseScore(this.view.overallScore),
    });
  }
  confirm(): void {
    if (
      this.view.busy ||
      !this.view.canScore ||
      !this.view.canSubmit ||
      this.view.frozen ||
      !this.view.detail
    )
      return;
    if (!this.restorePending() || this.pending) return;
    this.update({ confirming: true });
  }
  closeConfirmation(): void {
    if (this.view.busy || this.view.frozen) return;
    this.update({ confirming: false });
  }
  async submit(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.confirming ||
      !this.view.canScore ||
      !this.view.canSubmit ||
      this.view.frozen ||
      !this.view.detail ||
      !this.ready()
    )
      return;
    if (!this.restorePending() || this.pending) return;
    const accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot(),
      detail = this.view.detail;
    const tuple = {
      gradeScore: this.view.gradeScore,
      abilityScore: this.view.abilityScore,
      overallScore: this.view.overallScore,
    };
    let settled = false;
    await this.run(
      async (cancel) => {
        const requestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const attempt = this.runtime.pendingCourseRatings!.freeze({
          version: 1,
          accountId,
          courseId: detail.course.id,
          payload: decodeCourseFirstScore({
            clientRequestId: requestId,
            expectedCatalogRevision: detail.catalogRevision,
            expectedCourseRevision: detail.course.revision,
            ...tuple,
          }),
        });
        this.showPending(attempt);
        return this.dispatch(attempt, cancel);
      },
      (receipt) => {
        this.settle(receipt);
        settled = true;
      },
      (error) => {
        if (this.pending) this.showPending(this.pending);
        this.update({ error: courseError(error) });
      },
    );
    if (settled) await this.reload();
  }
  private dispatch(
    attempt: PendingCourseRating,
    cancel: Cancellation,
  ): Promise<CourseReceipt> {
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    this.runtime.pendingCourseRatings!.assertOriginal(attempt);
    return this.runtime.courseRatings!.submit(
      attempt.courseId,
      attempt.payload,
      cancel,
    );
  }
  async recover(retry = false): Promise<void> {
    if (
      this.view.busy ||
      !this.ready() ||
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
          : this.runtime.courseRatings!.receipt(
              attempt.payload.clientRequestId,
              cancel,
            ),
      (receipt) => {
        this.settle(receipt);
        settled = true;
      },
      (error) => {
        this.showPending(attempt);
        this.update({ error: courseError(error) });
      },
    );
    if (settled) await this.reload();
  }
  private settle(receipt: CourseReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidCourse();
    const result = this.runtime.pendingCourseRatings!.settle(
      this.pending,
      receipt,
    );
    this.pending = null;
    this.expectedOwnRecorded =
      result.courseId === this.selectedCourseId &&
      (result.outcome === 'applied' || result.code === 'COURSE_ALREADY_RATED');
    this.expectedRecorded =
      result.outcome === 'applied' && result.courseId === this.selectedCourseId
        ? {
            gradeScore: result.gradeScore,
            abilityScore: result.abilityScore,
            overallScore: result.overallScore,
          }
        : null;
    this.update({
      frozen: false,
      recoveryCourseId: '',
      recoveryScores: null,
      canScore: false,
      canSubmit: false,
      confirming: false,
      gradeScore: null,
      abilityScore: null,
      overallScore: null,
      receiptStatus:
        result.outcome === 'applied'
          ? `原请求已确认成功：得分 ${result.gradeScore}，能力 ${result.abilityScore}，综合 ${result.overallScore}。当前展示将单独重新核验。`
          : result.code === 'COURSE_ALREADY_RATED'
            ? '原请求已确认未写入：该账号已经评过此课程。'
            : '原请求已确认未写入：目录或课程版本已变化，请刷新后重新选择并确认。',
      blocker: '',
    });
  }
  detailPath(id: string): string | null {
    return !this.view.busy &&
      this.view.loaded &&
      this.view.items.some((item) => item.id === id)
      ? `/pages/course-rating-detail/course-rating-detail?courseId=${id}`
      : null;
  }
  override cancel(): void {
    super.cancel();
    this.update({
      confirming: false,
      canScore: false,
      canSubmit: false,
      loaded: false,
      detail: null,
      items: [],
      canNext: false,
    });
    this.restorePending();
  }
}
