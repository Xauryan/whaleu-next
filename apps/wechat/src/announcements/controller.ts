import { clientError, isRecord } from '../api/errors';
import type { CommunityRuntime } from '../community/runtime';
import {
  AnnouncementController,
  initialAnnouncementView,
  type AnnouncementView,
} from './lifecycle';
import {
  announcementUuid,
  invalidAnnouncement,
  type AnnouncementChanges,
  type AnnouncementDetail,
  type AnnouncementSummary,
} from './contract';
export type AnnouncementMode = 'list' | 'detail';
export interface AnnouncementRoute {
  readonly campusId: string | null;
  readonly announcementId?: string;
}
export function decodeAnnouncementRoute(
  value: unknown,
  mode: AnnouncementMode,
): AnnouncementRoute {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        !(
          mode === 'list' ? ['campusId'] : ['campusId', 'announcementId']
        ).includes(key),
    )
  )
    invalidAnnouncement();
  if (
    value.campusId !== undefined &&
    value.campusId !== null &&
    !announcementUuid(value.campusId)
  )
    invalidAnnouncement();
  if (mode === 'detail' && !announcementUuid(value.announcementId))
    invalidAnnouncement();
  return Object.freeze({
    campusId: (value.campusId ?? null) as string | null,
    ...(mode === 'detail'
      ? { announcementId: value.announcementId as string }
      : {}),
  });
}
export interface AnnouncementReadView extends AnnouncementView {
  readonly loaded: boolean;
  readonly campusId: string | null;
  readonly scopeLabel: string;
  readonly items: readonly AnnouncementSummary[];
  readonly detail: AnnouncementDetail | null;
  readonly changes: AnnouncementChanges | null;
  readonly changesNotice: string;
  readonly pageNumber: number;
  readonly canNext: boolean;
  readonly canPrevious: boolean;
  readonly restartRequired: boolean;
}
export const initialAnnouncementReadView = (): AnnouncementReadView => ({
  ...initialAnnouncementView(),
  loaded: false,
  campusId: null,
  scopeLabel: '未选择浏览校区，仅查看全体公告',
  items: [],
  detail: null,
  changes: null,
  changesNotice: '',
  pageNumber: 0,
  canNext: false,
  canPrevious: false,
  restartRequired: false,
});
export class AnnouncementReadController extends AnnouncementController<AnnouncementReadView> {
  private route: AnnouncementRoute | null = null;
  private cursors: (string | null)[] = [null];
  private nextCursor: string | null = null;
  private index = 0;
  constructor(
    runtime: CommunityRuntime,
    private readonly mode: AnnouncementMode,
    render: (value: AnnouncementReadView) => void,
  ) {
    super(runtime, initialAnnouncementReadView, render);
  }
  protected override reset(): void {
    this.route = null;
    this.resetPaging();
  }
  private resetPaging(): void {
    this.cursors = [null];
    this.nextCursor = null;
    this.index = 0;
  }
  async load(raw: unknown = {}): Promise<void> {
    this.clear();
    this.reset();
    try {
      this.route = decodeAnnouncementRoute(raw, this.mode);
    } catch {
      this.update({
        status: '公告入口无效',
        error: '请返回公告列表重新选择浏览范围',
      });
      return;
    }
    await this.read(null, 0);
  }
  async refresh(): Promise<void> {
    this.resetPaging();
    await this.read(null, 0);
  }
  async next(): Promise<void> {
    if (
      this.current() &&
      !this.view.busy &&
      this.view.loaded &&
      this.nextCursor
    )
      await this.read(this.nextCursor, this.index + 1);
  }
  async previous(): Promise<void> {
    if (this.current() && !this.view.busy && this.view.loaded && this.index > 0)
      await this.read(this.cursors[this.index - 1]!, this.index - 1);
  }
  private async read(cursor: string | null, index: number): Promise<void> {
    const route = this.route;
    this.clear('正在读取当前公告');
    if (!route || !this.available()) return;
    this.update({
      campusId: route.campusId,
      scopeLabel: route.campusId
        ? '当前浏览校区的公告与全体公告'
        : '未选择浏览校区，仅查看全体公告',
    });
    await this.run(
      async (cancel) => {
        if (this.mode === 'detail')
          return {
            detail: await this.runtime.announcements!.detail(
              route.campusId,
              route.announcementId!,
              cancel,
            ),
            page: null,
            changes: null,
          };
        const [page, changes] = await Promise.all([
          this.runtime.announcements!.list(route.campusId, cursor, cancel),
          this.runtime
            .announcements!.changes(route.campusId, null, cancel)
            .catch((error) => {
              const failure = clientError(error);
              if (failure.kind === 'network' || failure.kind === 'timeout')
                return null;
              throw failure;
            }),
        ]);
        return { page, changes, detail: null };
      },
      ({ page, detail, changes }) => {
        if (page) {
          if (
            page.nextCursor !== null &&
            (page.nextCursor === cursor ||
              this.cursors.slice(0, index).includes(page.nextCursor))
          )
            invalidAnnouncement();
          this.cursors = [...this.cursors.slice(0, index), cursor];
          this.index = index;
          this.nextCursor = page.nextCursor;
        }
        this.update({
          loaded: true,
          items: page?.items ?? [],
          detail,
          changes,
          changesNotice:
            this.mode === 'detail'
              ? ''
              : changes?.newness.status === 'available'
                ? `最近30天新公告 ${changes.newness.newCount} 条`
                : '最近30天新公告数量暂不可确认',
          pageNumber: page ? index + 1 : 0,
          canPrevious: !!page && index > 0,
          canNext: !!page?.nextCursor,
          status: detail
            ? '当前公告详情'
            : !page?.items.length
              ? index === 0
                ? '当前浏览范围暂无公告'
                : '已到本次浏览末尾'
              : page.continuation === 'end'
                ? '已到本次浏览末尾'
                : '已加载当前页',
        });
      },
      (error) => {
        this.resetPaging();
        this.update({
          loaded: false,
          items: [],
          detail: null,
          changes: null,
          changesNotice: '',
          canNext: false,
          canPrevious: false,
          restartRequired:
            error.details.serverCode === 'DISCOVERY_RESTART_REQUIRED' ||
            (cursor !== null && error.details.serverCode === 'BAD_REQUEST'),
        });
      },
    );
  }
  detailPath(id: string): string | null {
    if (
      !this.current() ||
      !this.route ||
      !this.view.loaded ||
      this.view.busy ||
      this.view.error ||
      !this.view.items.some((item) => item.id === id)
    )
      return null;
    return `/pages/announcement-detail/announcement-detail?announcementId=${id}${this.route.campusId ? '&campusId=' + this.route.campusId : ''}`;
  }
}
