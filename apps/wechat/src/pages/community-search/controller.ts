import { ClientError, isRecord } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import {
  isCategory,
  invalid,
  type Category,
  type CommunitySpace,
  type Post,
} from '../../community/contract';
import type { CommunityRuntime } from '../../community/runtime';
import {
  canonicalSearchQuery,
  decodeSearchIntent,
  type SearchContinuation,
  type SearchIntent,
} from '../../community/search-contract';
import {
  isTradingSubtype,
  type TradingSubtype,
} from '../../community/trading-contract';
import { isUuid } from '../../profile/contract';

export interface SearchRoute {
  readonly campusId: string;
  readonly spaceId: string;
  readonly category?: Category;
  readonly tradingSubtype?: TradingSubtype;
}
/** Routes carry only public scope selectors. Queries never enter navigation URLs. */
export function decodeSearchRoute(value: unknown): SearchRoute {
  if (
    !isRecord(value) ||
    !isUuid(value.campusId) ||
    !isUuid(value.spaceId) ||
    Object.keys(value).some(
      (key) =>
        !['campusId', 'spaceId', 'category', 'tradingSubtype'].includes(key),
    ) ||
    (Object.prototype.hasOwnProperty.call(value, 'category') &&
      !isCategory(value.category)) ||
    (Object.prototype.hasOwnProperty.call(value, 'tradingSubtype') &&
      (value.category !== 'trading' || !isTradingSubtype(value.tradingSubtype)))
  )
    invalid();
  return Object.freeze({
    campusId: value.campusId,
    spaceId: value.spaceId,
    ...(value.category !== undefined
      ? { category: value.category as Category }
      : {}),
    ...(value.tradingSubtype !== undefined
      ? { tradingSubtype: value.tradingSubtype as TradingSubtype }
      : {}),
  });
}
export interface SearchResume {
  readonly route: SearchRoute;
  readonly inputDraft: string;
  readonly submittedQuery: string;
}
export interface SearchView extends CommunityView {
  readonly inputDraft: string;
  readonly submittedQuery: string;
  readonly campusId: string;
  readonly selectedSpaceId: string;
  readonly space: CommunitySpace | null;
  readonly regional: CommunitySpace | null;
  readonly globalSpaces: readonly CommunitySpace[];
  readonly category: Category | 'all';
  readonly tradingSubtype: TradingSubtype | '';
  readonly posts: readonly Post[];
  readonly continuation: SearchContinuation | null;
  readonly loaded: boolean;
  readonly scopeLoaded: boolean;
  readonly restartRequired: boolean;
  readonly canNext: boolean;
  readonly canPrevious: boolean;
  readonly pageNumber: number;
}
export const initialSearchView = (): SearchView => ({
  ...initialCommunityView(),
  inputDraft: '',
  submittedQuery: '',
  campusId: '',
  selectedSpaceId: '',
  space: null,
  regional: null,
  globalSpaces: [],
  category: 'all',
  tradingSubtype: '',
  posts: [],
  continuation: null,
  loaded: false,
  scopeLoaded: false,
  restartRequired: false,
  canNext: false,
  canPrevious: false,
  pageNumber: 0,
});
const MAX_CURSOR_TRAIL = 32;
/** Only this live page's intent/cursors are kept in memory; no body snapshots or query storage. */
export class SearchController extends CommunityController<SearchView> {
  private selected: SearchRoute | null = null;
  private submitted: SearchIntent | null = null;
  private nextCursor: string | null = null;
  private pageCursors: (string | null)[] = [null];
  private pageIndex = 0;
  private firstPageNumber = 1;
  constructor(runtime: CommunityRuntime, render: (view: SearchView) => void) {
    super(runtime, initialSearchView, render);
  }
  private resetPaging(): void {
    this.nextCursor = null;
    this.pageCursors = [null];
    this.pageIndex = 0;
    this.firstPageNumber = 1;
  }
  protected override resetPrivate(): void {
    this.selected = null;
    this.submitted = null;
    this.resetPaging();
  }
  protected override onSafetyInvalidated(previous: SearchView): void {
    if (!previous.campusId || !previous.selectedSpaceId) return;
    void this.load(
      {
        campusId: previous.campusId,
        spaceId: previous.selectedSpaceId,
        ...(previous.category !== 'all' ? { category: previous.category } : {}),
        ...(previous.tradingSubtype
          ? { tradingSubtype: previous.tradingSubtype }
          : {}),
      },
      {
        inputDraft: previous.inputDraft,
        submittedQuery: previous.submittedQuery,
      },
    );
  }
  snapshot(): SearchResume | null {
    if (!this.selected) return null;
    try {
      this.runtime.sessions.assertCurrent(this.owner);
    } catch {
      return null;
    }
    return Object.freeze({
      route: this.selected,
      inputDraft: this.view.inputDraft,
      submittedQuery: this.submitted?.q ?? '',
    });
  }
  private clearPage(): void {
    this.stop();
    this.nextCursor = null;
    this.update({
      posts: [],
      continuation: null,
      loaded: false,
      restartRequired: false,
      canNext: false,
      canPrevious: false,
      pageNumber: 0,
      busy: false,
      error: '',
    });
  }
  async load(
    route: unknown,
    resume?: Pick<SearchResume, 'inputDraft' | 'submittedQuery'>,
  ): Promise<void> {
    this.clearPage();
    this.resetPrivate();
    try {
      this.selected = decodeSearchRoute(route);
      const q = resume?.submittedQuery
        ? canonicalSearchQuery(resume.submittedQuery)
        : '';
      if (q) this.submitted = this.intent(q);
      this.update({
        campusId: this.selected.campusId,
        selectedSpaceId: this.selected.spaceId,
        category: this.selected.category ?? 'all',
        tradingSubtype: this.selected.tradingSubtype ?? '',
        inputDraft: resume?.inputDraft ?? '',
        submittedQuery: q,
        space: null,
        regional: null,
        globalSpaces: [],
        scopeLoaded: false,
      });
    } catch {
      this.resetPrivate();
      this.update({
        ...initialSearchView(),
        hasSession: !!this.owner.credentials,
        configured: !!this.runtime.gateway && !!this.runtime.search,
        error: '搜索范围无效，请返回社区选择校园与地区',
        status: '搜索范围不可用',
      });
      return;
    }
    await this.read(null, 0);
  }
  setInput(inputDraft: string): void {
    this.update({ inputDraft });
  }
  private intent(q: string): SearchIntent {
    if (!this.selected) invalid();
    return decodeSearchIntent({
      spaceId: this.selected.spaceId,
      q,
      ...(this.selected.category ? { category: this.selected.category } : {}),
      ...(this.selected.tradingSubtype
        ? { tradingSubtype: this.selected.tradingSubtype }
        : {}),
    });
  }
  async submit(): Promise<void> {
    if (!this.selected || !this.view.space) return;
    let q: string;
    try {
      q = canonicalSearchQuery(this.view.inputDraft);
    } catch {
      this.resetPaging();
      this.clearPage();
      this.update({
        status: '输入尚未提交',
        error: '请输入 1–200 个字符，不支持控制字符',
      });
      return;
    }
    this.submitted = this.intent(q);
    this.update({ submittedQuery: q, inputDraft: q });
    await this.refresh();
  }
  async chooseSpace(spaceId: string): Promise<void> {
    if (!this.selected) return;
    const space = [this.view.regional, ...this.view.globalSpaces].find(
      (item) => item?.id === spaceId && item.isActive,
    );
    if (!space) return;
    const q = this.submitted?.q;
    this.selected = Object.freeze({
      campusId: this.selected.campusId,
      spaceId,
    });
    this.submitted = q ? this.intent(q) : null;
    this.update({
      selectedSpaceId: spaceId,
      space,
      category: 'all',
      tradingSubtype: '',
    });
    await this.refresh();
  }
  async setCategory(category: string): Promise<void> {
    if (
      !this.selected ||
      !this.view.space ||
      (category !== 'all' && !isCategory(category)) ||
      (this.view.space.kind === 'global' &&
        category !== 'all' &&
        category !== 'discussion')
    )
      return;
    const q = this.submitted?.q;
    this.selected = Object.freeze({
      campusId: this.selected.campusId,
      spaceId: this.selected.spaceId,
      ...(category !== 'all' ? { category } : {}),
    });
    this.submitted = q ? this.intent(q) : null;
    this.update({ category, tradingSubtype: '' });
    await this.refresh();
  }
  async setTradingSubtype(subtype: string): Promise<void> {
    if (
      !this.selected ||
      this.selected.category !== 'trading' ||
      (subtype !== '' && !isTradingSubtype(subtype))
    )
      return;
    const q = this.submitted?.q;
    this.selected = Object.freeze({
      campusId: this.selected.campusId,
      spaceId: this.selected.spaceId,
      category: 'trading',
      ...(subtype ? { tradingSubtype: subtype } : {}),
    });
    this.submitted = q ? this.intent(q) : null;
    this.update({ tradingSubtype: subtype });
    await this.refresh();
  }
  async refresh(): Promise<void> {
    this.resetPaging();
    await this.read(null, 0);
  }
  async next(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.loaded ||
      !this.nextCursor ||
      !this.submitted
    )
      return;
    await this.read(this.nextCursor, this.pageIndex + 1);
  }
  async previous(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.loaded ||
      !this.view.canPrevious ||
      this.pageIndex < 1
    )
      return;
    await this.read(this.pageCursors[this.pageIndex - 1]!, this.pageIndex - 1);
  }
  private async read(after: string | null, pageIndex: number): Promise<void> {
    const selected = this.selected,
      submitted = this.submitted;
    this.clearPage();
    if (!selected || !this.available(false)) return;
    if (!this.runtime.search) {
      this.update({
        configured: false,
        error: '当前构建尚未配置搜索服务',
        status: '搜索暂不可用',
      });
      return;
    }
    this.update({
      status: submitted ? '正在重新核验范围并搜索' : '正在确认搜索范围',
    });
    await this.run(
      async (cancel) => {
        const spaces = await this.runtime.gateway!.spaces(
          selected.campusId,
          cancel,
        );
        const space =
          [spaces.regional, ...spaces.global].find(
            (item) => item?.id === selected.spaceId && item.isActive,
          ) ?? null;
        if (
          space?.kind === 'global' &&
          (selected.tradingSubtype ||
            (selected.category && selected.category !== 'discussion'))
        )
          throw new ClientError('protocol', 'Unsupported global search filter');
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Search was replaced');
        const page =
          space && submitted
            ? await this.runtime.search!.search(submitted, after, cancel)
            : null;
        return { spaces, space, page };
      },
      ({ spaces, space, page }) => {
        this.update({
          regional: spaces.regional?.isActive ? spaces.regional : null,
          globalSpaces: spaces.global.filter((item) => item.isActive),
          space,
          scopeLoaded: true,
        });
        if (!space || !page) {
          this.resetPaging();
          this.update({
            status: space
              ? '输入关键词开始搜索'
              : '原搜索范围当前不可用，请返回社区重新选择',
          });
          return;
        }
        if (
          page.nextCursor !== null &&
          (page.nextCursor === after ||
            this.pageCursors.slice(0, pageIndex).includes(page.nextCursor))
        )
          throw new ClientError('protocol', 'Search cursor did not advance');
        this.nextCursor = page.nextCursor;
        this.pageCursors = [...this.pageCursors.slice(0, pageIndex), after];
        this.pageIndex = pageIndex;
        if (this.pageCursors.length > MAX_CURSOR_TRAIL) {
          this.pageCursors.shift();
          this.pageIndex--;
          this.firstPageNumber++;
        }
        const pageNumber = this.firstPageNumber + this.pageIndex;
        this.update({
          posts: page.items,
          continuation: page.continuation,
          loaded: true,
          canNext: !!page.nextCursor,
          canPrevious: this.pageIndex > 0,
          pageNumber,
          status:
            page.continuation === 'scan_pending'
              ? '本批查找尚未结束，请继续查找'
              : page.continuation === 'login_required'
                ? '登录后可继续查找；登录后需重新搜索'
                : page.continuation === 'phone_verification_required'
                  ? '继续查找需要手机号验证；当前版本尚未接入验证流程'
                  : page.continuation === 'end'
                    ? pageNumber === 1 && !page.items.length
                      ? '当前范围没有可查看的匹配帖子'
                      : '已到本次搜索末尾'
                    : '已加载当前可查看的匹配帖子',
        });
      },
      (error) => {
        this.resetPaging();
        const restart =
          error.details.serverCode === 'DISCOVERY_RESTART_REQUIRED' ||
          (after !== null && error.details.serverCode === 'BAD_REQUEST');
        this.update({
          posts: [],
          continuation: null,
          loaded: false,
          canNext: false,
          canPrevious: false,
          pageNumber: 0,
          restartRequired: restart,
          ...(restart
            ? {
                status: '分页已失效，请重新搜索',
                error: '旧分页已清除，请重新搜索当前可查看的帖子',
              }
            : {}),
        });
      },
    );
  }
  override cancel(): void {
    this.resetPaging();
    this.clearPage();
    this.update({ status: '已停止搜索，可重新搜索', error: '' });
  }
}
