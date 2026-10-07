import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { CommunityRuntime } from '../../community/runtime';
import type { SavedEntry } from '../../community/saved-contract';
export interface SavedView extends CommunityView {
  readonly items: readonly SavedEntry[];
  readonly visibleSavedCount: number;
  readonly loaded: boolean;
  readonly canLoadMore: boolean;
}
export const initialSavedView = (): SavedView => ({
  ...initialCommunityView(),
  items: [],
  visibleSavedCount: 0,
  loaded: false,
  canLoadMore: false,
});
export class SavedController extends CommunityController<SavedView> {
  private nextCursor: string | null = null;
  constructor(runtime: CommunityRuntime, render: (view: SavedView) => void) {
    super(runtime, initialSavedView, render);
  }
  protected override resetPrivate(): void {
    this.nextCursor = null;
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  async load(): Promise<void> {
    this.stop();
    this.nextCursor = null;
    this.update({
      items: [],
      visibleSavedCount: 0,
      loaded: false,
      canLoadMore: false,
      busy: false,
    });
    if (!this.available()) return;
    await this.read(false);
  }
  async more(): Promise<void> {
    if (
      !this.available() ||
      this.view.busy ||
      !this.view.loaded ||
      !this.nextCursor
    )
      return;
    await this.read(true);
  }
  private async read(append: boolean): Promise<void> {
    const after = append ? this.nextCursor : null;
    await this.run(
      (cancel) => this.runtime.gateway!.saved(after, cancel),
      (result) => {
        if (result.nextCursor && result.nextCursor === after)
          throw new ClientError('protocol', 'Saved cursor did not advance');
        this.nextCursor = result.nextCursor;
        // Re-saves can move epochs between requests. Keep a single card per post; refresh restores newest order.
        const merged = new Map(
          (append ? this.view.items : []).map((item) => [item.post.id, item]),
        );
        for (const item of result.items) merged.set(item.post.id, item);
        this.update({
          items: [...merged.values()],
          visibleSavedCount: result.visibleSavedCount,
          loaded: true,
          canLoadMore: !!result.nextCursor,
          status: '已读取当前可查看的收藏；重新收藏后的新位置请刷新查看',
        });
      },
      (error) => {
        if (
          !append ||
          ['forbidden', 'auth-required', 'auth-expired'].includes(error.kind) ||
          ['COMMUNITY_UNAVAILABLE', 'COMMUNITY_SCOPE_UNAVAILABLE'].includes(
            error.details.serverCode ?? '',
          )
        ) {
          this.nextCursor = null;
          this.update({
            items: [],
            visibleSavedCount: 0,
            loaded: false,
            canLoadMore: false,
          });
        }
        // Transient append failures preserve the loaded window and cursor for an explicit retry.
      },
    );
  }
}
