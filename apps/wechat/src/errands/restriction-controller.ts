import { ClientError, isRecord } from '../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { Authorization } from '../identity-privacy/overlay';
import type { Cancellation } from '../platform/contracts';
import {
  errandAdminAuthority,
  sameErrandAdminAuthority,
  type ErrandAdminAuthority,
} from './admin-authority';
import {
  decodeErrandAdminAuthorization,
  type ErrandAdminTotal,
} from './admin-contract';
import { errandAdminCommandError } from './admin-command-controller';
import type { ErrandAdminRuntime } from './admin-runtime';
import {
  errandRestrictionAction,
  type ErrandRestrictionAction,
} from './admin-command-contract';
import {
  decodeErrandRestrictionHistory,
  decodeErrandRestrictionPage,
  decodeErrandRestrictionQuery,
  errandRestrictionStates,
  type ErrandRestriction,
  type ErrandRestrictionEvent,
  type ErrandRestrictionQuery,
} from './restriction-contract';
import { errandId, invalidErrand } from './contract';
export interface ErrandRestrictionView extends CommunityView {
  readonly loaded: boolean;
  readonly access: 'unknown' | 'global' | 'denied';
  readonly mode: 'list' | 'history';
  readonly profileDraft: string;
  readonly actionFilter: ErrandRestrictionAction | '';
  readonly stateFilter: ErrandRestrictionQuery['state'];
  readonly items: readonly ErrandRestriction[];
  readonly restriction: ErrandRestriction | null;
  readonly events: readonly ErrandRestrictionEvent[];
  readonly recordedTotal: ErrandAdminTotal | null;
  readonly historyCoverage: 'unknown_before_boundary' | null;
  readonly continuation: 'more' | 'end' | null;
  readonly canNext: boolean;
  readonly canPrevious: boolean;
  readonly pageNumber: number;
}
export const initialErrandRestrictionView = (): ErrandRestrictionView => ({
  ...initialCommunityView(),
  loaded: false,
  access: 'unknown',
  mode: 'list',
  profileDraft: '',
  actionFilter: '',
  stateFilter: 'all',
  items: [],
  restriction: null,
  events: [],
  recordedTotal: null,
  historyCoverage: null,
  continuation: null,
  canNext: false,
  canPrevious: false,
  pageNumber: 0,
});
/** Exact local-record pages; an empty page never implies complete imported history. */
export class ErrandRestrictionController extends CommunityController<ErrandRestrictionView> {
  private inactive = false;
  private authority: ErrandAdminAuthority | null = null;
  private query: ErrandRestrictionQuery = { state: 'all' };
  private restrictionId: string | null = null;
  private nextCursor: string | null = null;
  private cursors: (string | null)[] = [null];
  private pageIndex = 0;
  private firstPageNumber = 1;
  private readonly unsubscribeScope: () => void;
  private readonly unsubscribeBrowse: () => void;
  constructor(
    private readonly adminRuntime: ErrandAdminRuntime,
    render: (view: ErrandRestrictionView) => void,
  ) {
    super(adminRuntime, initialErrandRestrictionView, render);
    const invalidate = (accountId?: string) => {
      if (accountId !== undefined && accountId !== this.accountId()) return;
      this.cancel();
      this.update({ status: '管理范围已变化，历史与列表已清除，请重新核验' });
    };
    this.unsubscribeScope =
      adminRuntime.directoryScopeChanges?.subscribe(invalidate) ??
      (() => undefined);
    this.unsubscribeBrowse =
      adminRuntime.browsingScopeChanges?.subscribe(invalidate) ??
      (() => undefined);
    this.update({ configured: !!adminRuntime.errandAdminCommands });
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (!this.adminRuntime.errandAdminCommands || !this.accountId()) {
      this.update({
        configured: !!this.adminRuntime.errandAdminCommands,
        error: !this.accountId()
          ? '请先登录后核验全局管理权限'
          : '全局限制服务尚未配置',
      });
      return false;
    }
    return true;
  }
  protected override resetPrivate(): void {
    this.authority = null;
    this.query = { state: 'all' };
    this.restrictionId = null;
    this.resetPaging();
  }
  protected override onSafetyInvalidated(): void {
    this.update({ status: '安全状态已变化，历史与列表已清除，请重新核验' });
  }
  private resetPaging(): void {
    this.nextCursor = null;
    this.cursors = [null];
    this.pageIndex = 0;
    this.firstPageNumber = 1;
  }
  private clearBody(): void {
    this.stop();
    this.nextCursor = null;
    this.update({
      busy: false,
      loaded: false,
      items: [],
      restriction: null,
      events: [],
      recordedTotal: null,
      historyCoverage: null,
      continuation: null,
      canNext: false,
      canPrevious: false,
      pageNumber: 0,
      error: '',
    });
  }
  async load(raw: unknown = {}): Promise<void> {
    this.clearBody();
    this.resetPrivate();
    this.update({
      ...initialErrandRestrictionView(),
      configured: !!this.adminRuntime.errandAdminCommands,
      hasSession: !!this.accountId(),
    });
    if (!isRecord(raw) || Object.keys(raw).length) {
      this.update({ error: '全局限制链接无效，请从管理页进入' });
      return;
    }
    await this.read(null, 0);
  }
  async reload(): Promise<void> {
    this.authority = null;
    this.resetPaging();
    await this.read(null, 0);
  }
  private async currentAuthority(cancel: Cancellation): Promise<Authorization> {
    const auth = decodeErrandAdminAuthorization(
      await this.adminRuntime.errandAdminCommands!.authorization(cancel),
    );
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Restriction read replaced');
    if (this.authority && !sameErrandAdminAuthority(this.authority, auth))
      throw new ClientError('forbidden', 'Global role changed', {
        serverCode: 'ERRAND_ADMIN_SCOPE_CHANGED',
      });
    return auth;
  }
  private async read(cursor: string | null, index: number): Promise<void> {
    const restrictionId = this.restrictionId,
      query = this.query;
    this.clearBody();
    if (!this.available()) return;
    await this.run(
      async (cancel) => {
        const auth = await this.currentAuthority(cancel);
        if (!auth.management.global) return { auth, page: null, history: null };
        if (restrictionId) {
          const history = decodeErrandRestrictionHistory(
            await this.adminRuntime.errandAdminCommands!.history(
              restrictionId,
              cursor,
              cancel,
            ),
          );
          if (
            history.restriction.restrictionId !== restrictionId ||
            history.events.length > 20 ||
            (history.nextCursor !== null && history.nextCursor === cursor)
          )
            invalidErrand();
          return { auth, page: null, history };
        }
        const page = decodeErrandRestrictionPage(
          await this.adminRuntime.errandAdminCommands!.restrictions(
            query,
            cursor,
            cancel,
          ),
        );
        if (
          page.items.length > 20 ||
          (page.nextCursor !== null && page.nextCursor === cursor) ||
          page.items.some(
            (item) =>
              (query.action !== undefined && item.action !== query.action) ||
              (query.state !== 'all' && item.state !== query.state) ||
              (query.targetProfileId !== undefined &&
                item.subject.status === 'available' &&
                item.subject.profileId !== query.targetProfileId),
          )
        )
          invalidErrand();
        return { auth, page, history: null };
      },
      ({ auth, page, history }) => {
        if (!auth.management.global) {
          this.authority = null;
          this.resetPaging();
          this.update({
            access: 'denied',
            status: '仅当前全局管理员可签发、查看历史或解除跑腿限制',
          });
          return;
        }
        this.authority = errandAdminAuthority(auth, null);
        const result = page ?? history;
        if (!result) invalidErrand();
        if (
          result.nextCursor !== null &&
          this.cursors.slice(0, index).includes(result.nextCursor)
        )
          invalidErrand();
        this.nextCursor = result.nextCursor;
        this.cursors = [...this.cursors.slice(0, index), cursor];
        this.pageIndex = index;
        if (this.cursors.length > 32) {
          this.cursors.shift();
          this.pageIndex--;
          this.firstPageNumber++;
        }
        this.update({
          access: 'global',
          loaded: true,
          mode: history ? 'history' : 'list',
          items: page?.items ?? [],
          restriction: history?.restriction ?? null,
          events: history?.events ?? [],
          recordedTotal: page?.recordedTotal ?? null,
          historyCoverage: result.historyCoverage,
          continuation: result.continuation,
          canNext: result.nextCursor !== null,
          canPrevious: this.pageIndex > 0,
          pageNumber: this.firstPageNumber + this.pageIndex,
          status: '已核验本页已记录资料；迁移边界之前的完整历史仍未知',
        });
      },
      (error) => {
        this.clearBody();
        this.authority = null;
        this.resetPaging();
        this.update({
          access: 'unknown',
          error: errandAdminCommandError(error),
          status: '无法核验历史或权限，旧内容与总数已清除',
        });
      },
    );
  }
  setProfile(value: string): void {
    if (this.inactive) return;
    this.clearBody();
    this.resetPaging();
    this.update({ profileDraft: value, status: '条件已变化，请重新查询' });
  }
  async search(): Promise<void> {
    if (this.inactive) return;
    this.clearBody();
    this.resetPaging();
    this.restrictionId = null;
    try {
      this.query = decodeErrandRestrictionQuery({
        state: this.view.stateFilter,
        ...(this.view.profileDraft.trim()
          ? { targetProfileId: this.view.profileDraft.trim() }
          : {}),
        ...(this.view.actionFilter ? { action: this.view.actionFilter } : {}),
      });
    } catch {
      this.update({ error: '请填写完整的公开资料 UUID 编号', mode: 'list' });
      return;
    }
    this.update({
      mode: 'list',
      profileDraft: this.query.targetProfileId ?? '',
    });
    await this.read(null, 0);
  }
  async chooseState(value: string): Promise<void> {
    if (this.inactive || !errandRestrictionStates.includes(value as never))
      return;
    this.update({ stateFilter: value as ErrandRestrictionQuery['state'] });
    await this.search();
  }
  async chooseAction(value: string): Promise<void> {
    if (this.inactive) return;
    try {
      this.update({
        actionFilter: value === '' ? '' : errandRestrictionAction(value),
      });
    } catch {
      return;
    }
    await this.search();
  }
  async history(id: string): Promise<void> {
    if (
      this.view.busy ||
      !this.view.loaded ||
      !this.authority ||
      !errandId(id) ||
      !this.view.items.some((item) => item.restrictionId === id)
    )
      return;
    this.restrictionId = id;
    this.resetPaging();
    await this.read(null, 0);
  }
  async backToList(): Promise<void> {
    if (!this.inactive) {
      this.restrictionId = null;
      this.resetPaging();
      this.update({ mode: 'list' });
      await this.read(null, 0);
    }
  }
  commandAuthority(): ErrandAdminAuthority | null {
    return !this.inactive &&
      !this.view.busy &&
      this.view.loaded &&
      this.view.access === 'global' &&
      !!this.accountId()
      ? this.authority
      : null;
  }
  commandRestriction(id: string): ErrandRestriction | null {
    if (!this.commandAuthority()) return null;
    const item =
      this.view.restriction?.restrictionId === id
        ? this.view.restriction
        : this.view.items.find((row) => row.restrictionId === id);
    return item?.state === 'active' ? item : null;
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
    this.resetPrivate();
    this.update({
      access: 'unknown',
      profileDraft: '',
      actionFilter: '',
      stateFilter: 'all',
      status: '已停止等待，旧管理记录已清除',
    });
  }
  override dispose(): void {
    this.inactive = true;
    this.unsubscribeScope();
    this.unsubscribeBrowse();
    super.dispose();
  }
}
