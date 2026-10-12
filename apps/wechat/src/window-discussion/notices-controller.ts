import { decodeDiscussionV2Notices } from './v2-contract';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import {
  decodeDiscussionNotices,
  decodeDiscussionTarget,
  decodeDiscussionRead,
  invalidDiscussion,
  type DiscussionNotice,
  type DiscussionNotices,
} from './contract';
import { windowDiscussionError } from './controller';
export interface WindowDiscussionNoticesView extends CommunityView {
  readonly loaded: boolean;
  readonly items: readonly DiscussionNotice[];
  readonly unreadCount: number | null;
  readonly canNext: boolean;
  readonly pageNumber: number;
  readonly readStatus: string;
}
export const initialWindowDiscussionNoticesView =
  (): WindowDiscussionNoticesView => ({
    ...initialCommunityView(),
    loaded: false,
    items: [],
    unreadCount: null,
    canNext: false,
    pageNumber: 0,
    readStatus: '',
  });
export class WindowDiscussionNoticesController extends CommunityController<WindowDiscussionNoticesView> {
  private snapshot: DiscussionNotices | null = null;
  private continuation = 0;
  constructor(
    runtime: CommunityRuntime,
    render: (v: WindowDiscussionNoticesView) => void,
  ) {
    super(runtime, initialWindowDiscussionNoticesView, render);
  }
  protected override resetPrivate(): void {
    this.continuation++;
    this.snapshot = null;
  }
  private ready(): boolean {
    if (!this.available()) return false;
    if (!this.runtime.windowDiscussion) {
      this.update({ error: '当前构建未配置窗口讨论通知' });
      return false;
    }
    return true;
  }
  async reload(): Promise<void> {
    if (this.view.busy || !this.ready()) return;
    await this.load(null);
  }
  async next(): Promise<void> {
    if (this.view.busy || !this.snapshot?.nextCursor || !this.ready()) return;
    await this.load(this.snapshot.nextCursor);
  }
  private async load(cursor: string | null): Promise<void> {
    const number = cursor ? this.view.pageNumber + 1 : 1;
    this.snapshot = null;
    this.update({
      loaded: false,
      items: [],
      unreadCount: null,
      canNext: false,
    });
    await this.run(
      async (c) => {
        const p = (
          this.runtime.windowDiscussionV2
            ? decodeDiscussionV2Notices
            : decodeDiscussionNotices
        )(
          await (this.runtime.windowDiscussionV2 ??
            this.runtime.windowDiscussion)!.notices(cursor, c),
        );
        if (p.nextCursor !== null && p.nextCursor === cursor)
          invalidDiscussion();
        return p;
      },
      (p) => {
        this.snapshot = p;
        this.update({
          loaded: true,
          items: p.items,
          unreadCount: p.unreadCount,
          pageNumber: number,
          canNext: p.nextCursor !== null,
          status: '当前通知已核验',
        });
      },
      (e) => this.update({ error: windowDiscussionError(e) }),
    );
  }
  async open(id: string, navigate: (path: string) => void): Promise<void> {
    if (this.view.busy || !this.ready() || !this.view.loaded) return;
    const notice = this.view.items.find((i) => i.noticeId === id);
    if (!notice || notice.status !== 'available') return;
    await this.run(
      async (c) => {
        const t = decodeDiscussionTarget(
          await (this.runtime.windowDiscussionV2 ??
            this.runtime.windowDiscussion)!.target(id, c),
        );
        if (
          t.windowId !== notice.target.windowId ||
          t.rootId !== notice.target.rootId ||
          t.commentId !== notice.target.commentId
        )
          invalidDiscussion();
        return t;
      },
      (t) =>
        navigate(
          `/pages/window-discussion-thread/window-discussion-thread?windowId=${t.windowId}&rootId=${t.rootId}&commentId=${t.commentId}&noticeId=${id}`,
        ),
      (e) => {
        this.snapshot = null;
        this.update({
          loaded: false,
          items: [],
          unreadCount: null,
          canNext: false,
          error: windowDiscussionError(e),
        });
      },
    );
  }
  async read(id: string): Promise<void> {
    if (this.view.busy || !this.ready() || !this.view.loaded) return;
    const notice = this.view.items.find((i) => i.noticeId === id);
    if (!notice || notice.readAt !== null) return;
    const generation = this.continuation;
    let acknowledged = false;
    await this.run(
      async (c) => {
        const r = decodeDiscussionRead(
          await (this.runtime.windowDiscussionV2 ??
            this.runtime.windowDiscussion)!.read(id, c),
        );
        if (r.noticeId !== id) invalidDiscussion();
        return r;
      },
      (r) => {
        this.snapshot = null;
        const items = this.view.items.map((i) =>
          i.noticeId === id ? Object.freeze({ ...i, readAt: r.readAt }) : i,
        );
        this.update({
          items,
          unreadCount: null,
          canNext: false,
          readStatus: '此通知已确认已读；当前未读数量将单独重新核验',
        });
        acknowledged = true;
      },
      (e) => this.update({ error: windowDiscussionError(e) }),
    );
    if (acknowledged && generation === this.continuation) await this.reload();
  }
  override cancel(): void {
    this.continuation++;
    super.cancel();
    this.snapshot = null;
    this.update({
      loaded: false,
      items: [],
      unreadCount: null,
      canNext: false,
    });
  }
}
