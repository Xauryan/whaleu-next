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
import { majorDiscussionError } from './controller';
export interface MajorDiscussionNoticesView extends CommunityView {
  readonly loaded: boolean;
  readonly items: readonly DiscussionNotice[];
  readonly unreadCount: number | null;
  readonly canNext: boolean;
  readonly pageNumber: number;
  readonly readStatus: string;
}
export const initialMajorDiscussionNoticesView =
  (): MajorDiscussionNoticesView => ({
    ...initialCommunityView(),
    loaded: false,
    items: [],
    unreadCount: null,
    canNext: false,
    pageNumber: 0,
    readStatus: '',
  });
export class MajorDiscussionNoticesController extends CommunityController<MajorDiscussionNoticesView> {
  private snapshot: DiscussionNotices | null = null;
  private continuation = 0;
  constructor(
    runtime: CommunityRuntime,
    render: (v: MajorDiscussionNoticesView) => void,
  ) {
    super(runtime, initialMajorDiscussionNoticesView, render);
  }
  protected override resetPrivate(): void {
    this.continuation++;
    this.snapshot = null;
  }
  private ready(): boolean {
    if (!this.available()) return false;
    if (!this.runtime.majorDiscussion) {
      this.update({ error: '当前构建未配置专业讨论通知' });
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
          this.runtime.majorDiscussionV2
            ? decodeDiscussionV2Notices
            : decodeDiscussionNotices
        )(
          await (this.runtime.majorDiscussionV2 ??
            this.runtime.majorDiscussion)!.notices(cursor, c),
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
      (e) => this.update({ error: majorDiscussionError(e) }),
    );
  }
  async open(id: string, navigate: (path: string) => void): Promise<void> {
    if (this.view.busy || !this.ready() || !this.view.loaded) return;
    const notice = this.view.items.find((i) => i.noticeId === id);
    if (!notice || notice.status !== 'available') return;
    await this.run(
      async (c) => {
        const t = decodeDiscussionTarget(
          await (this.runtime.majorDiscussionV2 ??
            this.runtime.majorDiscussion)!.target(id, c),
        );
        if (
          t.majorId !== notice.target.majorId ||
          t.rootId !== notice.target.rootId ||
          t.commentId !== notice.target.commentId
        )
          invalidDiscussion();
        return t;
      },
      (t) =>
        navigate(
          `/pages/major-discussion-thread/major-discussion-thread?majorId=${t.majorId}&rootId=${t.rootId}&commentId=${t.commentId}&noticeId=${id}`,
        ),
      (e) => {
        this.snapshot = null;
        this.update({
          loaded: false,
          items: [],
          unreadCount: null,
          canNext: false,
          error: majorDiscussionError(e),
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
          await (this.runtime.majorDiscussionV2 ??
            this.runtime.majorDiscussion)!.read(id, c),
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
      (e) => this.update({ error: majorDiscussionError(e) }),
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
