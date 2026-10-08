import { ClientError, isRecord } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import { Cancellation } from '../platform/contracts';
import { cancellable } from '../platform/cancellable';
import { bounded } from '../platform/deadline';
import { systemClock } from '../platform/clock';
import {
  canonicalDirectoryQuery,
  decodeDirectoryDetail,
  directoryUuid,
  invalidDirectory,
  isDirectoryKind,
  type DirectoryCategory,
  type DirectoryDetail,
  type DirectoryEntry,
  type DirectoryKind,
  type DirectoryListIntent,
  type DirectoryPage,
} from './contract';
export interface DirectoryHubRoute {
  readonly kind: DirectoryKind;
}
export interface DirectoryListRoute extends DirectoryHubRoute {
  readonly regionId: string;
  readonly categoryId?: string;
}
export interface DirectoryDetailRoute extends DirectoryListRoute {
  readonly categoryId: string;
  readonly entryId: string;
}
export type DirectoryRoute =
  DirectoryHubRoute | DirectoryListRoute | DirectoryDetailRoute;
export type DirectoryMode = 'hub' | 'list' | 'detail';
export interface DirectoryResume {
  readonly route: DirectoryRoute;
  readonly inputDraft: string;
  readonly submittedQuery: string;
}
export interface DirectoryView extends CommunityView {
  readonly loaded: boolean;
  readonly regionId: string;
  readonly kind: DirectoryKind;
  readonly categoryId: string;
  readonly categories: readonly DirectoryCategory[];
  readonly entries: readonly DirectoryEntry[];
  readonly detail: DirectoryDetail | null;
  readonly inputDraft: string;
  readonly submittedQuery: string;
  readonly continuation: 'more' | 'end' | null;
  readonly pageNumber: number;
  readonly canNext: boolean;
  readonly canPrevious: boolean;
  readonly restartRequired: boolean;
  readonly canCopy: boolean;
  readonly copyBusy: boolean;
}
export const initialDirectoryView = (): DirectoryView => ({
  ...initialCommunityView(),
  loaded: false,
  regionId: '',
  kind: 'school',
  categoryId: '',
  categories: [],
  entries: [],
  detail: null,
  inputDraft: '',
  submittedQuery: '',
  continuation: null,
  pageNumber: 0,
  canNext: false,
  canPrevious: false,
  restartRequired: false,
  canCopy: false,
  copyBusy: false,
});
export function decodeDirectoryRoute(
  value: unknown,
  mode: DirectoryMode,
): DirectoryRoute {
  if (!isRecord(value)) invalidDirectory();
  const allowed =
    mode === 'hub'
      ? ['kind']
      : mode === 'list'
        ? ['kind', 'regionId', 'categoryId']
        : ['kind', 'regionId', 'categoryId', 'entryId'];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    invalidDirectory();
  const kind =
    mode === 'hub' && value.kind === undefined ? 'school' : value.kind;
  if (!isDirectoryKind(kind)) invalidDirectory();
  if (mode === 'hub') return Object.freeze({ kind });
  if (
    !directoryUuid(value.regionId) ||
    (value.categoryId !== undefined && !directoryUuid(value.categoryId))
  )
    invalidDirectory();
  if (mode === 'detail') {
    if (!directoryUuid(value.entryId) || !directoryUuid(value.categoryId))
      invalidDirectory();
    return Object.freeze({
      kind,
      regionId: value.regionId,
      categoryId: value.categoryId,
      entryId: value.entryId,
    });
  }
  return Object.freeze({
    kind,
    regionId: value.regionId,
    ...(value.categoryId !== undefined ? { categoryId: value.categoryId } : {}),
  });
}
/** Live read owner: only harmless navigation/search intent survives hide. Bodies and cursors never persist. */
export class DirectoryReadController extends CommunityController<DirectoryView> {
  private selected: DirectoryRoute | null = null;
  private inactive = false;
  private submittedQuery = '';
  private nextCursor: string | null = null;
  private cursors: (string | null)[] = [null];
  private index = 0;
  private actionGeneration = 0;
  private copyCancellation: Cancellation | undefined;
  private readonly unsubscribeScope: () => void;
  constructor(
    runtime: CommunityRuntime,
    private readonly mode: DirectoryMode,
    render: (view: DirectoryView) => void,
  ) {
    super(runtime, initialDirectoryView, render);
    this.unsubscribeScope =
      runtime.directoryScopeChanges?.subscribe((accountId) => {
        if (accountId !== undefined && this.accountId() !== accountId) return;
        this.clearBody();
        this.resetPaging();
        this.update({
          status: '身份校区状态已变化，请重新加载',
          error: '旧目录和联系方式已清除；浏览校园不授予目录访问权限',
        });
      }) ?? (() => undefined);
    this.update({ configured: !!runtime.directory });
  }
  protected override available(): boolean {
    if (!this.runtime.directory || !this.accountId()) {
      this.update({
        configured: !!this.runtime.directory,
        status: '目录暂不可用',
        error: !this.runtime.directory
          ? '当前构建尚未配置目录服务'
          : '请先登录后查看目录',
      });
      return false;
    }
    return true;
  }
  protected override stop(): void {
    super.stop();
    this.actionGeneration++;
    this.copyCancellation?.cancel();
    this.copyCancellation = undefined;
  }
  protected override resetPrivate(): void {
    this.submittedQuery = '';
    this.resetPaging();
  }
  protected override onSafetyInvalidated(): void {
    this.update({
      configured: !!this.runtime.directory,
      status: '安全状态已变化，请重新加载目录',
      error: '旧目录和联系方式已清除',
    });
  }
  private resetPaging(): void {
    this.nextCursor = null;
    this.cursors = [null];
    this.index = 0;
  }
  private clearBody(): void {
    this.stop();
    this.nextCursor = null;
    this.update({
      loaded: false,
      regionId: '',
      categories: [],
      entries: [],
      detail: null,
      continuation: null,
      pageNumber: 0,
      canNext: false,
      canPrevious: false,
      restartRequired: false,
      canCopy: false,
      copyBusy: false,
      busy: false,
      error: '',
    });
  }
  snapshot(): DirectoryResume | null {
    if (this.inactive || !this.selected || !this.accountId()) return null;
    return Object.freeze({
      route: this.selected,
      inputDraft: this.view.inputDraft,
      submittedQuery: this.submittedQuery,
    });
  }
  async load(
    raw: unknown = {},
    resume?: Pick<DirectoryResume, 'inputDraft' | 'submittedQuery'>,
  ): Promise<void> {
    this.clearBody();
    this.resetPrivate();
    try {
      this.selected = decodeDirectoryRoute(raw, this.mode);
      this.submittedQuery = resume?.submittedQuery
        ? canonicalDirectoryQuery(resume.submittedQuery)
        : '';
      this.update({
        kind: this.selected.kind,
        categoryId:
          'categoryId' in this.selected ? (this.selected.categoryId ?? '') : '',
        inputDraft: resume?.inputDraft ?? '',
        submittedQuery: this.submittedQuery,
      });
    } catch {
      this.selected = null;
      this.update({
        status: '目录入口无效',
        error: '请返回目录重新选择，入口不能改变身份校区',
      });
      return;
    }
    await this.read(null, 0);
  }
  setInput(value: string): void {
    if (this.mode === 'list' && typeof value === 'string')
      this.update({ inputDraft: value });
  }
  async submit(): Promise<void> {
    if (!this.selected || this.mode !== 'list') return;
    let q: string;
    try {
      q = canonicalDirectoryQuery(this.view.inputDraft);
    } catch {
      this.clearBody();
      this.resetPaging();
      this.update({
        status: '关键词尚未提交',
        error: '请输入 1–100 个字符，不支持控制字符',
      });
      return;
    }
    this.submittedQuery = q;
    this.update({ inputDraft: q, submittedQuery: q });
    await this.refresh();
  }
  async clearSearch(): Promise<void> {
    if (this.mode !== 'list' || !this.selected) return;
    this.submittedQuery = '';
    this.update({ inputDraft: '', submittedQuery: '' });
    await this.refresh();
  }
  async chooseKind(kind: unknown): Promise<void> {
    if (this.mode !== 'hub' || !isDirectoryKind(kind)) return;
    await this.load({ kind });
  }
  async refresh(): Promise<void> {
    this.resetPaging();
    await this.read(null, 0);
  }
  async next(): Promise<void> {
    if (!this.view.busy && this.view.loaded && this.nextCursor)
      await this.read(this.nextCursor, this.index + 1);
  }
  async previous(): Promise<void> {
    if (!this.view.busy && this.view.loaded && this.index > 0)
      await this.read(this.cursors[this.index - 1]!, this.index - 1);
  }
  private async read(cursor: string | null, index: number): Promise<void> {
    const selected = this.selected,
      q = this.submittedQuery;
    this.clearBody();
    if (!selected || !this.available()) return;
    const directory = this.runtime.directory!;
    this.update({ status: '正在核验当前身份校区与目录访问权限' });
    await this.run(
      async (cancel) => {
        const context = await directory.context(cancel);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Directory read replaced');
        if ('regionId' in selected && selected.regionId !== context.regionId)
          throw new ClientError('forbidden', 'Identity region changed', {
            serverCode: 'DIRECTORY_SCOPE_UNAVAILABLE',
          });
        if (this.mode === 'hub')
          return {
            context,
            page: await directory.categories(
              context.regionId,
              selected.kind,
              cursor,
              cancel,
            ),
            detail: null,
          };
        if (this.mode === 'detail') {
          const route = selected as DirectoryDetailRoute;
          const detail = await directory.detail(
            context.regionId,
            route.entryId,
            cancel,
          );
          if (
            detail.kind !== route.kind ||
            detail.categoryId !== route.categoryId
          )
            invalidDirectory();
          return { context, page: null, detail };
        }
        const route = selected as DirectoryListRoute;
        if (!route.categoryId && !q)
          return { context, page: null, detail: null };
        const intent: DirectoryListIntent = {
          regionId: context.regionId,
          kind: selected.kind,
          ...(route.categoryId ? { categoryId: route.categoryId } : {}),
          ...(q ? { q } : {}),
        };
        return {
          context,
          page: await directory.entries(intent, cursor, cancel),
          detail: null,
        };
      },
      ({ context, page, detail }) => {
        if (page) this.applyPage(page, cursor, index);
        this.update({
          regionId: context.regionId,
          detail,
          ...(this.mode === 'detail'
            ? {
                loaded: true,
                canCopy:
                  detail?.platform === 'qq' &&
                  detail.qqGroupNumber.status === 'known' &&
                  detail.qqGroupNumber.value !== null,
                status: '已核验当前可查看的目录详情',
              }
            : !page
              ? { status: '请输入名称关键词，搜索当前类型的所有分类' }
              : {}),
        });
      },
      (error) => {
        this.clearBody();
        this.resetPaging();
        const restartRequired =
          ['DISCOVERY_RESTART_REQUIRED', 'DIRECTORY_RESTART_REQUIRED'].includes(
            error.details.serverCode ?? '',
          ) ||
          (cursor !== null && error.details.serverCode === 'BAD_REQUEST');
        const messages: Record<string, string> = {
          DIRECTORY_UNAVAILABLE:
            '目录资料覆盖尚未确认，暂不能展示；这不代表目录为空',
          DIRECTORY_NOT_FOUND: '此目录条目不存在或当前不可查看',
          DIRECTORY_SCOPE_UNAVAILABLE:
            '当前身份校区不匹配，请返回目录重新加载；切换浏览校园不能授予访问权限',
        };
        this.update({
          restartRequired,
          status: restartRequired ? '目录分页已失效' : '目录暂不可用',
          error: restartRequired
            ? '排序或访问依据已变化，请主动重新加载；旧分页已清除'
            : (messages[error.details.serverCode ?? ''] ??
              communityError(error)),
        });
      },
    );
  }
  private applyPage(
    page: DirectoryPage<DirectoryCategory> | DirectoryPage<DirectoryEntry>,
    cursor: string | null,
    index: number,
  ): void {
    if (
      page.nextCursor !== null &&
      (page.nextCursor === cursor ||
        this.cursors.slice(0, index).includes(page.nextCursor))
    )
      invalidDirectory();
    this.nextCursor = page.nextCursor;
    this.cursors = [...this.cursors.slice(0, index), cursor];
    this.index = index;
    this.update({
      categories:
        this.mode === 'hub' ? (page.items as readonly DirectoryCategory[]) : [],
      entries:
        this.mode === 'list' ? (page.items as readonly DirectoryEntry[]) : [],
      loaded: true,
      continuation: page.continuation,
      pageNumber: index + 1,
      canNext: page.nextCursor !== null,
      canPrevious: index > 0,
      status:
        !page.items.length && index === 0
          ? this.submittedQuery
            ? '没有匹配的名称'
            : this.mode === 'hub'
              ? '当前类型暂无分类'
              : '当前分类暂无条目'
          : page.continuation === 'end'
            ? '已到本次浏览末尾'
            : '已加载当前页，按目录顺序展示',
    });
  }
  categoryPath(id: string): string | null {
    if (!this.currentBody() || this.mode !== 'hub') return null;
    const item = this.view.categories.find((item) => item.id === id);
    return item
      ? `/pages/directory-list/directory-list?regionId=${this.view.regionId}&kind=${item.kind}&categoryId=${item.id}`
      : null;
  }
  searchPath(): string | null {
    return this.currentBody() && this.mode === 'hub'
      ? `/pages/directory-list/directory-list?regionId=${this.view.regionId}&kind=${this.view.kind}`
      : null;
  }
  entryPath(id: string): string | null {
    if (!this.currentBody() || this.mode !== 'list') return null;
    const item = this.view.entries.find((item) => item.id === id);
    return item
      ? `/pages/directory-detail/directory-detail?regionId=${this.view.regionId}&kind=${item.kind}&categoryId=${item.categoryId}&entryId=${item.id}`
      : null;
  }
  private currentBody(): boolean {
    return (
      this.view.loaded &&
      !this.view.busy &&
      !!this.accountId() &&
      !this.view.error
    );
  }
  /** No dataset contacts: read only the current, strict, authorized detail at the explicit tap. */
  async copyQq(copy: (value: string) => Promise<void>): Promise<void> {
    if (
      !this.currentBody() ||
      this.mode !== 'detail' ||
      this.view.copyBusy ||
      !this.view.detail
    )
      return;
    const detail = decodeDirectoryDetail(this.view.detail);
    if (
      detail.platform !== 'qq' ||
      detail.qqGroupNumber.status !== 'known' ||
      detail.qqGroupNumber.value === null
    )
      return;
    const generation = this.actionGeneration,
      owner = this.owner,
      cancel = new Cancellation(),
      currentDetail = this.view.detail;
    this.copyCancellation = cancel;
    this.update({ copyBusy: true });
    const current = () =>
      !cancel.isCancelled &&
      generation === this.actionGeneration &&
      this.view.detail === currentDetail &&
      !!this.accountId();
    try {
      this.runtime.sessions.assertCurrent(owner);
      await cancellable(
        bounded(
          () => {
            this.runtime.sessions.assertCurrent(owner);
            if (!current())
              throw new ClientError('cancelled', 'Directory copy replaced');
            return copy(detail.qqGroupNumber.value as string);
          },
          5000,
          systemClock,
        ),
        cancel,
      );
      if (current()) this.update({ status: 'QQ群号已复制' });
    } catch {
      if (current()) this.update({ status: '复制未完成，请重试' });
    } finally {
      if (current()) {
        this.copyCancellation = undefined;
        this.update({ copyBusy: false });
      }
    }
  }
  override cancel(): void {
    this.clearBody();
    this.resetPaging();
    this.update({ status: '已停止读取，请主动重新加载' });
  }
  override dispose(): void {
    this.inactive = true;
    this.unsubscribeScope();
    super.dispose();
  }
}
export class DirectoryHubController extends DirectoryReadController {
  constructor(
    runtime: CommunityRuntime,
    render: (view: DirectoryView) => void,
  ) {
    super(runtime, 'hub', render);
  }
}
export class DirectoryListController extends DirectoryReadController {
  constructor(
    runtime: CommunityRuntime,
    render: (view: DirectoryView) => void,
  ) {
    super(runtime, 'list', render);
  }
}
export class DirectoryDetailController extends DirectoryReadController {
  constructor(
    runtime: CommunityRuntime,
    render: (view: DirectoryView) => void,
  ) {
    super(runtime, 'detail', render);
  }
}
