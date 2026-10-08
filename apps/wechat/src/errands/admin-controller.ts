import { ClientError, isRecord } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Authorization } from '../identity-privacy/overlay';
import type { Cancellation } from '../platform/contracts';
import {
  canonicalErrandAdminKeyword,
  decodeErrandAdminAuthorization,
  decodeErrandAdminPage,
  errandAdminStatuses,
  matchErrandAdminPage,
  type ErrandAdminOrder,
  type ErrandAdminQuery,
  type ErrandAdminStatus,
  type ErrandAdminTotal,
} from './admin-contract';
import { errandId, invalidErrand } from './contract';

export interface ErrandAdminRoute {
  readonly regionId?: string;
}
export function decodeErrandAdminRoute(value: unknown): ErrandAdminRoute {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'regionId') ||
    (value.regionId !== undefined && !errandId(value.regionId))
  )
    invalidErrand();
  return Object.freeze(
    value.regionId ? { regionId: value.regionId as string } : {},
  );
}
export interface ErrandAdminView extends CommunityView {
  readonly loaded: boolean;
  readonly access: 'unknown' | 'denied' | 'fixed' | 'global';
  readonly regionId: string;
  readonly regionInput: string;
  readonly regionLabel: string;
  readonly keywordDraft: string;
  readonly keyword: string;
  readonly filter: ErrandAdminStatus;
  readonly items: readonly ErrandAdminOrder[];
  readonly total: ErrandAdminTotal | null;
  readonly legacyNumericUnavailable: boolean;
  readonly numericSearch: boolean;
  readonly continuation: 'more' | 'end' | null;
  readonly pageNumber: number;
  readonly canNext: boolean;
  readonly canPrevious: boolean;
}
export const initialErrandAdminView = (): ErrandAdminView => ({
  ...initialCommunityView(),
  loaded: false,
  access: 'unknown',
  regionId: '',
  regionInput: '',
  regionLabel: '',
  keywordDraft: '',
  keyword: '',
  filter: 'all',
  items: [],
  total: null,
  legacyNumericUnavailable: false,
  numericSearch: false,
  continuation: null,
  pageNumber: 0,
  canNext: false,
  canPrevious: false,
});
const fingerprint = (auth: Authorization): string =>
  JSON.stringify([
    auth.role,
    auth.management.global,
    [...auth.management.operatingRegionIds].sort(),
  ]);
function scopeError(): never {
  throw new ClientError('forbidden', 'Management scope changed', {
    serverCode: 'ERRAND_ADMIN_SCOPE_CHANGED',
  });
}
function adminError(error: ClientError): string {
  if (error.kind === 'protocol')
    return '管理数据格式或范围异常，已清除旧内容，请重新核验';
  const code = error.details.serverCode;
  if (
    [
      'ERRAND_ADMIN_SCOPE_CHANGED',
      'ERRAND_SCOPE_UNAVAILABLE',
      'MANAGEMENT_SCOPE_REQUIRED',
      'FORBIDDEN',
      'AUTHORIZATION_UNAVAILABLE',
      'AUTHORIZATION_REQUIRED',
    ].includes(code ?? '')
  )
    return '当前管理权限或目标地区无法确认，已清除旧内容，请重新核验';
  if (code === 'DISCOVERY_RESTART_REQUIRED')
    return '管理分页已失效，已清除旧内容，请从第一页重新核验';
  if (code === 'ERRAND_UNAVAILABLE')
    return '管理列表暂不能核验，旧内容与总数已清除，请稍后重试';
  return communityError(error);
}
/** Fresh server reads own each page. Only bounded opaque seek coordinates are retained in memory. */
export class ErrandAdminController extends CommunityController<ErrandAdminView> {
  private route: ErrandAdminRoute = {};
  private inactive = false;
  private authorizationKey: string | null = null;
  private nextCursor: string | null = null;
  private cursors: (string | null)[] = [null];
  private pageIndex = 0;
  private firstPageNumber = 1;
  private readonly unsubscribeScope: () => void;
  private readonly unsubscribeBrowse: () => void;
  constructor(
    runtime: CommunityRuntime,
    render: (view: ErrandAdminView) => void,
  ) {
    super(runtime, initialErrandAdminView, render);
    const invalidate = (accountId?: string) => {
      if (accountId !== undefined && accountId !== this.accountId()) return;
      this.stop();
      this.resetPrivate();
      this.update({
        ...initialErrandAdminView(),
        configured: !!runtime.errandAdmin,
        hasSession: !!this.accountId(),
        status: '范围已变化，旧管理内容已清除，请重新核验权限',
      });
    };
    this.unsubscribeScope =
      runtime.directoryScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeBrowse =
      runtime.browsingScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.update({ configured: !!runtime.errandAdmin });
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (!this.runtime.errandAdmin || !this.accountId()) {
      this.update({
        configured: !!this.runtime.errandAdmin,
        hasSession: !!this.accountId(),
        error: !this.accountId()
          ? '请先登录后核验跑腿管理权限'
          : '当前构建尚未配置跑腿管理服务',
        status: '管理浏览暂不可用',
      });
      return false;
    }
    return true;
  }
  private resetPaging(): void {
    this.nextCursor = null;
    this.cursors = [null];
    this.pageIndex = 0;
    this.firstPageNumber = 1;
  }
  protected override resetPrivate(): void {
    this.route = {};
    this.authorizationKey = null;
    this.resetPaging();
  }
  protected override onSafetyInvalidated(): void {
    this.update({
      configured: !!this.runtime.errandAdmin,
      status: '安全状态已变化，旧管理内容已清除，请重新核验权限',
    });
  }
  private clearBody(): void {
    this.stop();
    this.nextCursor = null;
    this.update({
      busy: false,
      loaded: false,
      items: [],
      total: null,
      continuation: null,
      canNext: false,
      canPrevious: false,
      pageNumber: 0,
      regionLabel: '',
      legacyNumericUnavailable: false,
      numericSearch: false,
      error: '',
    });
  }
  async load(raw: unknown = {}): Promise<void> {
    this.clearBody();
    this.resetPrivate();
    this.update({
      ...initialErrandAdminView(),
      configured: !!this.runtime.errandAdmin,
      hasSession: !!this.accountId(),
    });
    try {
      this.route = decodeErrandAdminRoute(raw);
    } catch {
      this.update({
        status: '无法打开管理浏览',
        error: '管理链接无效，请返回跑腿列表重新进入',
      });
      return;
    }
    this.update({ regionInput: this.route.regionId ?? '' });
    await this.read(null, 0);
  }
  async reload(): Promise<void> {
    this.authorizationKey = null;
    this.resetPaging();
    await this.read(null, 0);
  }
  private async authorization(cancel: Cancellation): Promise<Authorization> {
    const auth = decodeErrandAdminAuthorization(
      await this.runtime.errandAdmin!.authorization(cancel),
    );
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Management read replaced');
    if (
      this.authorizationKey !== null &&
      this.authorizationKey !== fingerprint(auth)
    )
      scopeError();
    return auth;
  }
  private async read(cursor: string | null, pageIndex: number): Promise<void> {
    const requestedRegion = this.route.regionId;
    const keyword = this.view.keyword,
      status = this.view.filter;
    this.clearBody();
    if (!this.available()) return;
    this.update({ status: '正在重新核验管理权限与公开订单' });
    await this.run(
      async (cancel) => {
        const auth = await this.authorization(cancel);
        const global = auth.management.global;
        if (auth.role === 'member') return { auth, page: null, regionId: '' };
        const regionId = global
          ? requestedRegion
          : auth.management.operatingRegionIds[0];
        if (!global && requestedRegion && requestedRegion !== regionId)
          scopeError();
        if (!regionId) return { auth, page: null, regionId: '' };
        const query: ErrandAdminQuery = { regionId, status, keyword };
        const page = decodeErrandAdminPage(
          await this.runtime.errandAdmin!.list(query, cursor, cancel),
        );
        matchErrandAdminPage(page, query, cursor);
        if (page.context.management !== (global ? 'global' : 'fixed'))
          invalidErrand();
        return { auth, page, regionId };
      },
      ({ auth, page, regionId }) => {
        this.authorizationKey = fingerprint(auth);
        const access =
          auth.role === 'member'
            ? 'denied'
            : auth.management.global
              ? 'global'
              : 'fixed';
        this.update({
          access,
          regionId,
          regionInput: regionId || this.view.regionInput,
        });
        if (!page) {
          this.resetPaging();
          this.update({
            status:
              access === 'denied'
                ? '当前账号没有跑腿管理权限'
                : '请明确填写需要查看的目标地区编号',
          });
          return;
        }
        if (
          page.nextCursor !== null &&
          this.cursors.slice(0, pageIndex).includes(page.nextCursor)
        )
          invalidErrand();
        this.route = { regionId };
        this.nextCursor = page.nextCursor;
        this.cursors = [...this.cursors.slice(0, pageIndex), cursor];
        this.pageIndex = pageIndex;
        if (this.cursors.length > 32) {
          this.cursors.shift();
          this.pageIndex--;
          this.firstPageNumber++;
        }
        const target = page.items[0]?.targetRegion;
        this.update({
          loaded: true,
          items: page.items,
          total: page.total,
          continuation: page.continuation,
          canNext: page.nextCursor !== null,
          canPrevious: this.pageIndex > 0,
          pageNumber: this.firstPageNumber + this.pageIndex,
          legacyNumericUnavailable: true,
          numericSearch: /^[0-9]+$/.test(keyword),
          regionLabel:
            target?.status === 'available'
              ? `${target.label}${target.active ? '' : '（已停用）'}`
              : '',
          status:
            page.continuation === 'end'
              ? '已到本次查询末尾'
              : page.items.length
                ? '已核验本页，可继续浏览'
                : '本批扫描没有匹配项，可继续查找',
        });
      },
      (error) => {
        this.clearBody();
        this.authorizationKey = null;
        this.resetPaging();
        this.update({
          access: 'unknown',
          regionId: '',
          status: '管理内容已清除，需重新核验',
          error: adminError(error),
        });
      },
    );
  }
  setKeyword(value: string): void {
    if (this.inactive) return;
    this.clearBody();
    this.resetPaging();
    this.update({
      keywordDraft: value,
      status: '关键词已变化，请提交新的查询',
    });
  }
  async search(): Promise<void> {
    if (this.inactive) return;
    this.clearBody();
    this.resetPaging();
    try {
      const keyword = canonicalErrandAdminKeyword(this.view.keywordDraft);
      this.update({ keyword, keywordDraft: keyword });
    } catch {
      this.update({
        error: '关键词最多100个字符，不支持无效字符',
        status: '查询尚未提交',
      });
      return;
    }
    await this.read(null, 0);
  }
  async chooseStatus(value: string): Promise<void> {
    if (
      this.inactive ||
      !errandAdminStatuses.includes(value as ErrandAdminStatus)
    )
      return;
    this.clearBody();
    this.resetPaging();
    this.update({ filter: value as ErrandAdminStatus });
    await this.search();
  }
  setRegion(value: string): void {
    if (this.inactive || this.view.access !== 'global') return;
    this.clearBody();
    this.resetPaging();
    this.route = {};
    this.update({
      regionInput: value,
      regionId: '',
      status: '目标地区已变化，请重新核验',
    });
  }
  async selectRegion(): Promise<void> {
    if (this.inactive || this.view.access !== 'global') return;
    this.clearBody();
    this.resetPaging();
    const regionId = this.view.regionInput.trim();
    if (!errandId(regionId)) {
      this.update({ error: '请填写有效的目标地区 UUID 编号' });
      return;
    }
    this.route = { regionId };
    this.update({ keyword: '', keywordDraft: '', filter: 'all' });
    await this.read(null, 0);
  }
  async next(): Promise<void> {
    if (!this.view.busy && this.view.loaded && this.nextCursor)
      await this.read(this.nextCursor, this.pageIndex + 1);
  }
  async previous(): Promise<void> {
    if (!this.view.busy && this.view.loaded && this.pageIndex > 0)
      await this.read(this.cursors[this.pageIndex - 1]!, this.pageIndex - 1);
  }
  override cancel(): void {
    this.clearBody();
    this.authorizationKey = null;
    this.resetPaging();
    this.update({
      access: 'unknown',
      regionId: '',
      status: '已停止等待，管理内容与总数已清除',
    });
  }
  override dispose(): void {
    this.inactive = true;
    this.unsubscribeScope();
    this.unsubscribeBrowse();
    super.dispose();
  }
}
