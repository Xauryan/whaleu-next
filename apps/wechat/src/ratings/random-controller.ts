import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import {
  decodeCampusPage,
  validateCampusQuery,
  type Campus,
} from '../profile/contract';
import { ratingError } from './controller';
import { invalidRating } from './contract';
import {
  decodeRatingRandomQuery,
  decodeRatingRandomResult,
  decodeRatingRandomRoute,
  matchRatingRandomResult,
  type RatingRandomResult,
} from './random-contract';
import { ClientError } from '../api/errors';

export function ratingRandomError(error: unknown): string {
  if (error instanceof ClientError && error.kind === 'protocol')
    return communityError(error);
  const code = error instanceof ClientError ? error.details.serverCode : null;
  return (
    (
      {
        RATING_UNAVAILABLE:
          '完整候选池、目录或必要授权暂不能确认，本次随机选择不可用',
        RATING_SCORE_UNAVAILABLE:
          '候选池中存在评分统计未知的目标，当前均分门槛下无法抽取；请稍后重试或明确清空门槛',
        CONTENT_REVIEW_UNAVAILABLE:
          '候选目标的当前审核状态暂不能确认，本次随机选择不可用',
      } as Record<string, string>
    )[code ?? ''] ?? ratingError(error)
  );
}

export interface RatingRandomView extends CommunityView {
  readonly loaded: boolean;
  readonly categoryId: string | null;
  readonly campus: Campus | null;
  readonly minimumAverageInput: string;
  readonly result: RatingRandomResult | null;
  readonly pickerOpen: boolean;
  readonly campusQuery: string;
  readonly campusDistrict: string;
  readonly campuses: readonly Campus[];
  readonly campusPage: number;
  readonly hasPreviousCampuses: boolean;
  readonly hasNextCampuses: boolean;
}
export const initialRatingRandomView = (): RatingRandomView => ({
  ...initialCommunityView(),
  loaded: false,
  categoryId: null,
  campus: null,
  minimumAverageInput: '',
  result: null,
  pickerOpen: false,
  campusQuery: '',
  campusDistrict: '',
  campuses: [],
  campusPage: 1,
  hasPreviousCampuses: false,
  hasNextCampuses: false,
});

/** A fresh server draw, never a shuffle of the visible catalog or a cached pool. */
export class RatingRandomController extends CommunityController<RatingRandomView> {
  private inactive = false;
  private readonly unsubscribeScope: () => void;
  private readonly unsubscribeBrowse: () => void;
  private readonly unsubscribeTarget: () => void;
  private readonly unsubscribeCatalog: () => void;
  constructor(
    runtime: CommunityRuntime,
    render: (view: RatingRandomView) => void,
  ) {
    super(runtime, initialRatingRandomView, render);
    const invalidate = () => {
      if (this.inactive) return;
      this.stop();
      this.update({
        ...initialRatingRandomView(),
        configured: !!runtime.ratingRandom,
        hasSession: !!this.accountId(),
        status: '校区或授权状态已变化，请重新打开当前分类选择范围',
      });
    };
    this.unsubscribeScope =
      runtime.directoryScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeBrowse =
      runtime.browsingScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeCatalog =
      runtime.ratingCatalogChanges?.subscribe(() => {
        if (this.inactive || !this.accountId()) return;
        this.clearResult();
        this.update({
          status: '评分分类目录已变化，旧随机结果已清除，请重新抽取',
        });
      }) ?? (() => undefined);
    this.unsubscribeTarget =
      runtime.ratingTargetChanges?.subscribe(() => {
        if (this.inactive || !this.accountId()) return;
        // A pending draw may return any member of the complete pool. Even a
        // different deleted ID invalidates its count/probability snapshot.
        this.clearResult();
        this.update({
          status: '评分对象已变化，旧随机结果已清除，请重新抽取',
        });
      }) ?? (() => undefined);
    this.update({ configured: !!runtime.ratingRandom });
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (!this.runtime.ratingRandom || !this.accountId()) {
      this.update({
        configured: !!this.runtime.ratingRandom,
        error: this.accountId()
          ? '当前构建尚未配置随机评分服务'
          : '请先登录后使用评分',
        status: '随机选择暂不可用',
      });
      return false;
    }
    return true;
  }
  protected override onSafetyInvalidated(): void {
    this.update({
      configured: !!this.runtime.ratingRandom,
      status: '安全状态已变化，范围与结果已清除，请重新加载',
    });
  }
  load(raw: unknown): void {
    if (this.inactive) return;
    this.stop();
    this.update({
      ...initialRatingRandomView(),
      configured: !!this.runtime.ratingRandom,
      hasSession: !!this.accountId(),
    });
    try {
      const route = decodeRatingRandomRoute(raw);
      this.update({
        categoryId: route.categoryId,
        status: '当前仅全局范围，请确认条件后点击随机选一个',
      });
    } catch {
      this.update({
        error: '分类入口无效，请返回评分目录重新选择',
        status: '无法随机选择',
      });
    }
  }
  private clearResult(): void {
    this.stop();
    this.update({
      loaded: false,
      result: null,
      busy: false,
      error: '',
      status: '条件已更新，请重新抽取',
    });
  }
  setMinimumAverage(value: string): void {
    if (!this.available() || !this.view.categoryId) return;
    this.clearResult();
    this.update({ minimumAverageInput: value });
  }
  selectGlobal(): void {
    if (!this.available() || !this.view.categoryId) return;
    this.clearResult();
    this.update({
      campus: null,
      pickerOpen: false,
      campuses: [],
      campusQuery: '',
      campusDistrict: '',
      hasPreviousCampuses: false,
      hasNextCampuses: false,
      status: '当前仅全局范围，请点击随机选一个',
    });
  }
  async openCampusPicker(): Promise<void> {
    if (!this.available() || !this.view.categoryId || this.view.pickerOpen)
      return;
    this.clearResult();
    this.update({
      pickerOpen: true,
      campusQuery: '',
      campusDistrict: '',
      campuses: [],
      campusPage: 1,
    });
    await this.searchCampuses();
  }
  closeCampusPicker(): void {
    if (this.inactive) return;
    this.clearResult();
    this.update({
      pickerOpen: false,
      campuses: [],
      campusQuery: '',
      campusDistrict: '',
      hasPreviousCampuses: false,
      hasNextCampuses: false,
      status: '已关闭校区选择，请确认当前范围后抽取',
    });
  }
  setCampusSearch(
    field: 'campusQuery' | 'campusDistrict',
    value: string,
  ): void {
    if (!this.available() || !this.view.pickerOpen) return;
    this.clearResult();
    this.update({
      [field]: value,
      campuses: [],
      campusPage: 1,
      hasPreviousCampuses: false,
      hasNextCampuses: false,
    });
  }
  async searchCampuses(page = 1): Promise<void> {
    if (!this.available() || !this.view.pickerOpen) return;
    if (!this.runtime.profiles) {
      this.update({
        error: '当前构建尚未配置校区搜索服务，请关闭选择器使用仅全局范围',
      });
      return;
    }
    const query = {
      q: this.view.campusQuery.trim(),
      district: this.view.campusDistrict.trim(),
      page,
      pageSize: 20,
    };
    this.clearResult();
    this.update({
      campuses: [],
      hasPreviousCampuses: false,
      hasNextCampuses: false,
    });
    try {
      validateCampusQuery(query);
    } catch {
      this.update({ error: '校园名称与地区各最多 100 个字，不能包含控制字符' });
      return;
    }
    await this.run(
      async (cancel) => {
        const result = decodeCampusPage(
          await this.runtime.profiles!.campuses(query, cancel),
        );
        if (result.page !== page || result.pageSize !== query.pageSize)
          invalidRating();
        return result;
      },
      (result) =>
        this.update({
          campuses: result.items,
          campusPage: page,
          hasPreviousCampuses: page > 1,
          hasNextCampuses:
            page < 10000 && page * result.pageSize < result.total,
          status: result.items.length
            ? '请明确选择一个物理校区'
            : '没有找到校区，请修改搜索条件',
        }),
    );
  }
  async previousCampuses(): Promise<void> {
    if (!this.view.busy && this.view.hasPreviousCampuses)
      await this.searchCampuses(this.view.campusPage - 1);
  }
  async nextCampuses(): Promise<void> {
    if (!this.view.busy && this.view.hasNextCampuses)
      await this.searchCampuses(this.view.campusPage + 1);
  }
  chooseCampus(id: string): void {
    if (!this.available() || this.view.busy || !this.view.pickerOpen) return;
    const campus = this.view.campuses.find((item) => item.id === id);
    if (!campus?.isActive || campus.institutionId === null) return;
    this.clearResult();
    this.update({
      campus,
      pickerOpen: false,
      campuses: [],
      campusQuery: '',
      campusDistrict: '',
      hasPreviousCampuses: false,
      hasNextCampuses: false,
      status: '已选择校区所属学校的全部校区地区及全局，请点击随机选一个',
    });
  }
  async draw(): Promise<void> {
    if (
      !this.available() ||
      this.view.busy ||
      this.view.pickerOpen ||
      !this.view.categoryId
    )
      return;
    this.clearResult();
    const text = this.view.minimumAverageInput;
    if (text !== '' && !/^[1-5](?:\.\d)?$/.test(text)) {
      this.update({ error: '最低均分需为 1–5，最多一位小数；留空表示不限' });
      return;
    }
    let query;
    try {
      query = decodeRatingRandomQuery({
        categoryId: this.view.categoryId,
        ...(this.view.campus ? { campusId: this.view.campus.id } : {}),
        ...(text === '' ? {} : { minimumAverage: Number(text) }),
      });
    } catch {
      this.update({ error: '最低均分需为 1–5，最多一位小数；留空表示不限' });
      return;
    }
    await this.run(
      async (cancel) => {
        const result = decodeRatingRandomResult(
          await this.runtime.ratingRandom!.draw(query, cancel),
        );
        matchRatingRandomResult(query, result);
        return result;
      },
      (result) =>
        this.update({
          loaded: true,
          result,
          status: result.item
            ? '已从服务端完整候选池随机选出一个'
            : '当前条件下没有候选目标',
        }),
      (error) =>
        this.update({
          loaded: false,
          result: null,
          error: ratingRandomError(error),
          status: '随机选择暂不可用',
        }),
    );
  }
  targetPath(): string | null {
    const item = this.view.result?.item;
    return !this.inactive && !this.view.busy && !!this.accountId() && item
      ? `/pages/rating-detail/rating-detail?targetId=${item.target.id}${item.regionId ? `&regionId=${item.regionId}` : ''}`
      : null;
  }
  override cancel(): void {
    this.clearResult();
    this.update({
      campuses: [],
      hasPreviousCampuses: false,
      hasNextCampuses: false,
      status: '已取消本次读取，旧结果已清除',
    });
  }
  override dispose(): void {
    if (this.inactive) return;
    this.inactive = true;
    this.unsubscribeScope();
    this.unsubscribeBrowse();
    this.unsubscribeTarget();
    this.unsubscribeCatalog();
    super.dispose();
  }
}
