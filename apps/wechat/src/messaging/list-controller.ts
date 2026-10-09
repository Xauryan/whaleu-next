import { clientError } from '../api/errors';
import { dispatch } from './commands';
import {
  baseView,
  MessagingController,
  type BaseView,
  type Render,
} from './controller';
import { invalid, type Coverage, type ListItem } from './contract';
import { reason } from './errors';
import type { MessagingRuntime } from './runtime';
export interface ListView extends BaseView {
  readonly items: readonly (ListItem & { readonly id: string })[];
  readonly coverage: Coverage | null;
  readonly canMore: boolean;
  readonly unread: number | null;
  readonly confirmHide: string | null;
  readonly browsingOlder: boolean;
  readonly needsRestart: boolean;
}
export const initialListView = (): ListView => ({
  ...baseView(),
  items: [],
  coverage: null,
  canMore: false,
  unread: null,
  confirmHide: null,
  browsingOlder: false,
  needsRestart: false,
});
export class MessagingListController extends MessagingController<ListView> {
  private nextCursor: string | null = null;
  private currentCursor: string | null = null;
  constructor(runtime: MessagingRuntime, render: Render<ListView>) {
    super(runtime, initialListView, render);
  }
  protected override invalidated(): void {
    void this.load();
  }
  protected override clearPrivate(): void {
    this.nextCursor = null;
    this.currentCursor = null;
  }
  async load(): Promise<void> {
    if (this.view.busy) return;
    this.currentCursor = null;
    await this.read(null);
  }
  private async read(cursor: string | null): Promise<void> {
    await this.run(async (cancel, current) => {
      this.update({ confirmHide: null });
      try {
        const [page, unread] = await Promise.all([
          this.runtime.gateway!.list(cursor, cancel),
          this.runtime.gateway!.unread(cancel),
        ]);
        current();
        if (cursor !== null && page.nextCursor === cursor) invalid();
        this.currentCursor = cursor;
        this.nextCursor = page.nextCursor;
        this.update({
          items: page.items.map((item) => ({
            ...item,
            id: item.conversation.id,
          })),
          coverage: page.coverage,
          loaded: true,
          canMore: !!page.nextCursor,
          unread: unread.count,
          browsingOlder: cursor !== null,
          needsRestart: false,
          status:
            page.coverage === 'local'
              ? '仅展示已核验的本地私信范围，旧版完整历史尚未迁移'
              : '已更新当前页私信',
        });
      } catch (error) {
        current();
        this.nextCursor = null;
        const stale =
          clientError(error).details.serverCode === 'DM_CURSOR_STALE';
        this.update({
          items: [],
          unread: null,
          coverage: null,
          loaded: false,
          canMore: false,
          needsRestart: stale,
          ...(stale ? { status: reason('DM_CURSOR_STALE') } : {}),
        });
        throw error;
      }
    });
    this.schedule(() => this.poll(), 10000);
  }
  private async poll(): Promise<void> {
    if (this.view.confirmHide) {
      this.schedule(() => this.poll(), 10000);
      return;
    }
    if (this.view.needsRestart) {
      await this.run(async (cancel, current) => {
        const unread = await this.runtime.gateway!.unread(cancel);
        current();
        this.update({
          unread: unread.count,
          status: '列表已有变化，请点击刷新回到顶部；不会自动跳页',
        });
      });
      this.schedule(() => this.poll(), 10000);
      return;
    }
    // Revalidate this exact page to avoid retaining held previews. Never silently jump to page one.
    await this.read(this.currentCursor);
  }
  async more(): Promise<void> {
    if (!this.nextCursor || this.view.busy || this.view.confirmHide) return;
    await this.read(this.nextCursor);
  }
  requestHide(id: string): void {
    if (this.view.busy) return;
    const item = this.view.items.find((i) => i.conversation.id === id);
    if (item) this.update({ confirmHide: id });
  }
  dismiss(): void {
    this.update({ confirmHide: null });
  }
  async confirmHide(): Promise<void> {
    const conversationId = this.view.confirmHide;
    if (!conversationId || this.view.pending) return;
    const completed = await this.run(async (cancel, current) => {
      if (this.view.confirmHide !== conversationId) return;
      const clientRequestId = await this.runtime.newRequestId();
      current();
      if (this.view.confirmHide !== conversationId) return;
      this.update({ confirmHide: null });
      const receipt = await dispatch(
        this.runtime,
        { operation: 'hide', conversationId, clientRequestId },
        cancel,
        current,
      );
      current();
      this.update({
        status:
          receipt.outcome === 'rejected'
            ? reason(receipt.code)
            : '隐藏请求已确认，正在刷新当前列表',
      });
    });
    if (completed) await this.load();
  }
  override cancel(): void {
    this.dismiss();
    super.cancel();
  }
}
