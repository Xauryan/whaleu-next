import { ClientError, clientError } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import {
  decodeMajorDepartments,
  decodeMajorDetail,
  decodeMajorPage,
  decodeMajorQuery,
  invalidMajor,
  majorId,
  majorDepartment,
  type Major,
  type MajorDepartments,
  type MajorDetail,
  type MajorPage,
  type MajorQuery,
} from './contract';
export type MajorMode = 'directory' | 'detail';
export interface MajorDirectoryView extends CommunityView {
  readonly loaded: boolean;
  readonly items: readonly Major[];
  readonly detail: MajorDetail | null;
  readonly departments: MajorDepartments | null;
  readonly departmentNames: readonly string[];
  readonly departmentIndex: number;
  readonly searchDraft: string;
  readonly departmentDraft: number | null;
  readonly appliedFilter: string;
  readonly totalCount: number | null;
  readonly pageNumber: number;
  readonly canNext: boolean;
  readonly restartRequired: boolean;
  readonly relatedLoaded: boolean;
  readonly relatedItems: readonly Major[];
  readonly relatedError: string;
}
export const initialMajorDirectoryView = (): MajorDirectoryView => ({
  ...initialCommunityView(),
  loaded: false,
  items: [],
  detail: null,
  departments: null,
  departmentNames: ['全部院系'],
  departmentIndex: 0,
  searchDraft: '',
  departmentDraft: null,
  appliedFilter: '全部院系',
  totalCount: null,
  pageNumber: 0,
  canNext: false,
  restartRequired: false,
  relatedLoaded: false,
  relatedItems: [],
  relatedError: '',
});
export function majorDirectoryError(error: unknown): string {
  const failure = clientError(error);
  if (failure.kind === 'protocol') return communityError(failure);
  return (
    (
      {
        MAJOR_CATALOG_UNAVAILABLE: '专业目录来源暂不能确认；这不代表没有专业',
        MAJOR_NOT_FOUND: '此专业当前不可查看，请从目录重新进入',
        MAJOR_CURSOR_INVALID: '目录分页已失效，请从第一页重新核验',
        MAJOR_RESTART_REQUIRED: '目录已变化，请从第一页重新核验',
        MAJOR_REVISION_CONFLICT: '目录版本已变化，请重新核验',
        PHONE_VERIFICATION_REQUIRED: '请先验证手机号，再重新加载专业目录',
        SAFETY_ACTION_RESTRICTED: '当前账号暂不能访问专业目录，请稍后重新核验',
      } as Record<string, string>
    )[failure.details.serverCode ?? ''] ?? communityError(error)
  );
}
export class MajorDirectoryController extends CommunityController<MajorDirectoryView> {
  private selectedMajorId: string | null = null;
  private query: MajorQuery = {};
  private page: MajorPage | null = null;
  private continuation = 0;
  constructor(
    runtime: CommunityRuntime,
    private readonly mode: MajorMode,
    render: (view: MajorDirectoryView) => void,
  ) {
    super(runtime, initialMajorDirectoryView, render);
  }
  protected override resetPrivate(): void {
    this.continuation++;
    this.page = null;
    this.query = {};
  }
  private ready(): boolean {
    if (!this.available()) return false;
    if (!this.runtime.majors) {
      this.update({ error: '当前构建未配置专业目录服务' });
      return false;
    }
    return true;
  }
  async load(id: string | null = null): Promise<void> {
    if (this.view.busy) return;
    if (this.mode === 'detail' ? !majorId(id) : id !== null) {
      this.update({ error: '专业目录入口无效，请重新进入' });
      return;
    }
    this.selectedMajorId = id;
    await this.reload();
  }
  async reload(): Promise<void> {
    if (this.view.busy || !this.ready()) return;
    if (this.mode === 'detail') await this.loadDetail();
    else await this.loadPage(null);
  }
  setSearch(value: string): void {
    if (!this.view.busy) this.update({ searchDraft: value });
  }
  setDepartment(index: number): void {
    if (
      this.view.busy ||
      !Number.isInteger(index) ||
      index < 0 ||
      index > (this.view.departments?.items.length ?? 0)
    )
      return;
    const department =
      index === 0
        ? null
        : this.view.departments!.items[index - 1]!.departmentId;
    if (department !== null && !majorDepartment(department)) return;
    this.update({ departmentIndex: index, departmentDraft: department });
  }
  async search(): Promise<void> {
    if (this.view.busy || this.mode !== 'directory' || !this.ready()) return;
    try {
      const keyword = this.view.searchDraft.trim();
      this.query = decodeMajorQuery({
        ...(keyword ? { keyword } : {}),
        ...(this.view.departmentDraft !== null
          ? { departmentId: this.view.departmentDraft }
          : {}),
      });
    } catch {
      this.update({ error: '搜索词最多 100 个字符，不能包含控制字符' });
      return;
    }
    await this.loadPage(null);
  }
  async next(): Promise<void> {
    if (this.view.busy || !this.page?.nextCursor || !this.ready()) return;
    await this.loadPage(this.page.nextCursor);
  }
  private async loadPage(cursor: string | null): Promise<void> {
    const previous = this.page,
      query = this.query,
      number = cursor ? this.view.pageNumber + 1 : 1;
    this.page = null;
    this.update({
      loaded: false,
      items: [],
      totalCount: null,
      canNext: false,
      departments: null,
      departmentNames: ['全部院系'],
      departmentIndex: 0,
      restartRequired: false,
    });
    await this.run(
      async (cancel) => {
        const departments = decodeMajorDepartments(
          await this.runtime.majors!.departments(cancel),
        );
        if (cancel.isCancelled) throw new ClientError('cancelled', 'Cancelled');
        const page = decodeMajorPage(
          await this.runtime.majors!.list(query, cursor, cancel),
        );
        if (
          departments.catalogRevision !== page.catalogRevision ||
          (cursor &&
            (!previous || previous.catalogRevision !== page.catalogRevision))
        )
          throw new ClientError('business', 'Major directory changed', {
            serverCode: 'MAJOR_RESTART_REQUIRED',
          });
        if (
          (page.nextCursor !== null && page.nextCursor === cursor) ||
          page.items.some(
            (item) =>
              query.departmentId !== undefined &&
              item.departmentId !== query.departmentId,
          )
        )
          invalidMajor();
        return { departments, page };
      },
      ({ departments, page }) => {
        this.page = page;
        const index =
          this.view.departmentDraft === null
            ? 0
            : departments.items.findIndex(
                (department) =>
                  department.departmentId === this.view.departmentDraft,
              ) + 1;
        this.update({
          loaded: true,
          items: page.items,
          totalCount: page.totalCount,
          canNext: page.nextCursor !== null,
          departments,
          departmentNames: [
            '全部院系',
            ...departments.items.map((department) => department.name),
          ],
          departmentIndex: index,
          pageNumber: number,
          appliedFilter: `${query.departmentId === undefined ? '全部院系' : `${query.departmentId}系`}${query.keyword ? ` · 专业或学院：${query.keyword}` : ''}`,
          status: page.items.length
            ? '当前专业目录已核验'
            : '已确认当前条件没有专业',
        });
      },
      (error) =>
        this.update({
          pageNumber: 0,
          restartRequired: cursor !== null,
          error: majorDirectoryError(error),
          status: '当前专业目录暂不可用',
        }),
    );
  }
  private async loadDetail(): Promise<void> {
    const id = this.selectedMajorId,
      generation = this.continuation;
    if (!id) return;
    this.update({
      loaded: false,
      detail: null,
      relatedLoaded: false,
      relatedItems: [],
      relatedError: '',
    });
    let loaded = false;
    await this.run(
      async (cancel) => {
        const detail = decodeMajorDetail(
          await this.runtime.majors!.detail(id, cancel),
        );
        if (detail.item.id !== id) invalidMajor();
        return detail;
      },
      (detail) => {
        loaded = true;
        this.update({ loaded: true, detail, status: '当前专业资料已核验' });
      },
      (error) =>
        this.update({
          error: majorDirectoryError(error),
          status: '当前专业暂不可用',
        }),
    );
    if (loaded && generation === this.continuation) await this.loadRelated();
  }
  async reloadRelated(): Promise<void> {
    if (this.view.busy || !this.ready()) return;
    await this.loadRelated();
  }
  private async loadRelated(): Promise<void> {
    const detail = this.view.detail;
    if (!detail || !this.view.loaded) return;
    this.update({ relatedLoaded: false, relatedItems: [], relatedError: '' });
    await this.run(
      async (cancel) => {
        const page = decodeMajorPage(
          await this.runtime.majors!.related(detail.item.id, cancel),
        );
        if (page.catalogRevision !== detail.catalogRevision)
          throw new ClientError('business', 'Major directory changed', {
            serverCode: 'MAJOR_RESTART_REQUIRED',
          });
        if (
          page.items.some((item) => item.id === detail.item.id) ||
          page.nextCursor !== null ||
          page.continuation !== 'end'
        )
          invalidMajor();
        // Same-department first, then stable department/ID ordering, without client-side reranking.
        for (let n = 1; n < page.items.length; n++) {
          const a = page.items[n - 1]!,
            b = page.items[n]!,
            aRank = a.departmentId === detail.item.departmentId ? 0 : 1,
            bRank = b.departmentId === detail.item.departmentId ? 0 : 1;
          if (
            aRank > bRank ||
            (aRank === bRank &&
              (a.departmentId > b.departmentId ||
                (a.departmentId === b.departmentId && a.id >= b.id)))
          )
            invalidMajor();
        }
        return page;
      },
      (page) => {
        this.update({ relatedLoaded: true, relatedItems: page.items });
      },
      (error) => {
        // Related reads recheck the same source and eligibility. Any failed fresh
        // check invalidates dependent navigation rather than retaining old proof.
        this.update({
          loaded: false,
          detail: null,
          relatedError: majorDirectoryError(error),
        });
      },
    );
  }
  detailPath(id: string): string | null {
    if (
      this.view.busy ||
      !this.view.loaded ||
      ![...this.view.items, ...this.view.relatedItems].some(
        (item) => item.id === id,
      )
    )
      return null;
    return `/pages/major-detail/major-detail?majorId=${id}`;
  }
  discussionPath(): string | null {
    if (this.view.busy || !this.view.loaded || !this.view.detail) return null;
    return `/pages/major-discussion/major-discussion?majorId=${this.view.detail.item.id}`;
  }
  override cancel(): void {
    this.continuation++;
    super.cancel();
    this.page = null;
    this.update({
      loaded: false,
      items: [],
      detail: null,
      totalCount: null,
      canNext: false,
      departments: null,
      departmentNames: ['全部院系'],
      departmentIndex: 0,
      relatedLoaded: false,
      relatedItems: [],
    });
  }
}
