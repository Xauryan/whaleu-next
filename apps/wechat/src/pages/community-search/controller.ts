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
  isSearchScope,
  type SearchScope,
  type SearchSelector,
  type SearchContinuation,
  type SearchIntent,
} from '../../community/search-contract';
import {
  isTradingSubtype,
  type TradingSubtype,
} from '../../community/trading-contract';
import { isUuid } from '../../profile/contract';
import type { Cancellation } from '../../platform/contracts';

export type SearchRoute =
  | (Extract<SearchSelector, { spaceId: string }> & {
      readonly campusId: string;
    })
  | (Extract<SearchSelector, { scope: SearchScope }> & {
      readonly campusId?: string;
    });
/** Routes carry only public scope selectors. Queries never enter navigation URLs. */
export function decodeSearchRoute(value: unknown): SearchRoute {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'campusId',
          'spaceId',
          'scope',
          'category',
          'tradingSubtype',
        ].includes(key),
    ) ||
    (Object.prototype.hasOwnProperty.call(value, 'campusId') &&
      !isUuid(value.campusId)) ||
    (!Object.prototype.hasOwnProperty.call(value, 'scope') &&
      !isUuid(value.campusId))
  )
    invalid();
  const { campusId, ...selector } = value;
  decodeSearchIntent({ ...selector, q: 'route' });
  return Object.freeze({
    ...selector,
    ...(campusId !== undefined ? { campusId: campusId as string } : {}),
  }) as SearchRoute;
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
  readonly selectedScope: SearchScope | 'explicit' | '';
  readonly browseNotice: string;
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
  selectedScope: '',
  browseNotice: '',
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
  private browseCancellation: Cancellation | undefined;
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
  protected override stop(): void {
    super.stop();
    this.browseCancellation?.cancel();
    this.browseCancellation = undefined;
  }
  protected override resetPrivate(): void {
    this.selected = null;
    this.submitted = null;
    this.resetPaging();
  }
  protected override onSafetyInvalidated(previous: SearchView): void {
    if (!previous.selectedScope) return;
    void this.load(
      {
        ...(previous.campusId ? { campusId: previous.campusId } : {}),
        ...(previous.selectedScope === 'explicit'
          ? { spaceId: previous.selectedSpaceId }
          : { scope: previous.selectedScope }),
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
        campusId: this.selected.campusId ?? '',
        selectedSpaceId: this.selected.spaceId ?? '',
        selectedScope: this.selected.scope ?? 'explicit',
        browseNotice: '',
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
        error: '搜索范围无效，请返回社区重新选择搜索入口',
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
      ...(this.selected.scope !== undefined
        ? { scope: this.selected.scope }
        : { spaceId: this.selected.spaceId }),
      q,
      ...(this.selected.category ? { category: this.selected.category } : {}),
      ...(this.selected.tradingSubtype
        ? { tradingSubtype: this.selected.tradingSubtype }
        : {}),
    });
  }
  async submit(): Promise<void> {
    if (
      !this.selected ||
      (this.selected.scope === undefined && !this.view.space)
    )
      return;
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
    this.clearPage();
    this.submitted = this.intent(q);
    this.update({ submittedQuery: q, inputDraft: q });
    await this.refresh();
  }
  async chooseSpace(spaceId: string): Promise<void> {
    if (!this.selected?.campusId) return;
    const space = [this.view.regional, ...this.view.globalSpaces].find(
      (item) => item?.id === spaceId && item.isActive,
    );
    if (!space) return;
    this.clearPage();
    const q = this.submitted?.q;
    this.selected = Object.freeze({
      campusId: this.selected.campusId,
      spaceId,
    });
    this.submitted = q ? this.intent(q) : null;
    this.update({
      selectedSpaceId: spaceId,
      selectedScope: 'explicit',
      browseNotice: '',
      space,
      category: 'all',
      tradingSubtype: '',
    });
    await this.refresh();
  }
  async chooseScope(scope: string): Promise<void> {
    if (!this.selected || !isSearchScope(scope)) return;
    this.clearPage();
    const q = this.submitted?.q;
    this.selected = decodeSearchRoute({
      ...(this.selected.campusId ? { campusId: this.selected.campusId } : {}),
      scope,
    });
    this.submitted = q ? this.intent(q) : null;
    this.update({
      selectedScope: scope,
      selectedSpaceId: '',
      space: null,
      category: 'all',
      tradingSubtype: '',
      scopeLoaded: true,
    });
    await this.refresh();
  }
  async setCategory(category: string): Promise<void> {
    if (
      !this.selected ||
      (category !== 'all' && !isCategory(category)) ||
      this.selected.scope === 'global' ||
      (this.selected.scope === undefined &&
        (!this.view.space ||
          (this.view.space.kind === 'global' &&
            category !== 'all' &&
            category !== 'discussion')))
    )
      return;
    this.clearPage();
    const q = this.submitted?.q;
    // A category from all communities deliberately selects cross-campus regional scope.
    this.selected = decodeSearchRoute({
      ...(this.selected.campusId ? { campusId: this.selected.campusId } : {}),
      ...(this.selected.scope === undefined
        ? { spaceId: this.selected.spaceId }
        : {
            scope:
              this.selected.scope === 'all' && category !== 'all'
                ? 'regional'
                : this.selected.scope,
          }),
      ...(category !== 'all' ? { category } : {}),
    });
    this.submitted = q ? this.intent(q) : null;
    this.update({
      selectedScope: this.selected.scope ?? 'explicit',
      category,
      tradingSubtype: '',
    });
    await this.refresh();
  }
  async setTradingSubtype(subtype: string): Promise<void> {
    if (
      !this.selected ||
      this.selected.category !== 'trading' ||
      (subtype !== '' && !isTradingSubtype(subtype))
    )
      return;
    this.clearPage();
    const q = this.submitted?.q;
    this.selected = decodeSearchRoute({
      ...(this.selected.campusId ? { campusId: this.selected.campusId } : {}),
      ...(this.selected.scope === undefined
        ? { spaceId: this.selected.spaceId }
        : { scope: this.selected.scope }),
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
    if (!selected || (selected.scope === undefined && !this.available(false)))
      return;
    if (!this.runtime.search) {
      this.update({
        configured: false,
        error: '当前构建尚未配置搜索服务',
        status: '搜索暂不可用',
      });
      return;
    }
    this.update({
      configured: true,
      status: submitted ? '正在重新核验范围并搜索' : '正在确认搜索范围',
    });
    await this.run(
      async (cancel) => {
        if (selected.scope !== undefined) {
          // Optional public browse choices are not search membership or a prerequisite.
          this.loadBrowseChoices(selected, cancel);
          const page = submitted
            ? await this.runtime.search!.search(submitted, after, cancel)
            : null;
          return { spaces: null, space: null, page };
        }
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
          ...(spaces
            ? {
                regional: spaces.regional?.isActive ? spaces.regional : null,
                globalSpaces: spaces.global.filter((item) => item.isActive),
              }
            : {}),
          space,
          scopeLoaded: true,
        });
        if ((selected.scope === undefined && !space) || !page) {
          this.resetPaging();
          this.update({
            status:
              space || selected.scope !== undefined
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
  private loadBrowseChoices(selected: SearchRoute, cancel: Cancellation): void {
    if (!selected.campusId || !this.runtime.gateway) return;
    this.browseCancellation = cancel;
    this.update({ regional: null, globalSpaces: [], browseNotice: '' });
    const gateway = this.runtime.gateway,
      campusId = selected.campusId;
    void Promise.resolve()
      .then(() => {
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Search was replaced');
        return gateway.spaces(campusId, cancel);
      })
      .then((spaces) => {
        if (cancel.isCancelled || this.selected !== selected) return;
        this.runtime.sessions.assertCurrent(this.owner);
        this.update({
          regional: spaces.regional?.isActive ? spaces.regional : null,
          globalSpaces: spaces.global.filter((item) => item.isActive),
          browseNotice: !spaces.regional?.isActive
            ? '浏览校园的地区选项当前不可用；聚合搜索仍可使用'
            : '',
        });
      })
      .catch(() => {
        if (cancel.isCancelled || this.selected !== selected) return;
        this.update({
          regional: null,
          globalSpaces: [],
          browseNotice: '浏览校园的单社区选项暂不可用；聚合搜索仍可使用',
        });
      });
  }
  override cancel(): void {
    this.resetPaging();
    this.clearPage();
    this.update({ status: '已停止搜索，可重新搜索', error: '' });
  }
}
