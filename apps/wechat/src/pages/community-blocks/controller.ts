import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { BlockEntry } from '../../community/block-contract';
import type { CommunityRuntime } from '../../community/runtime';
export interface BlocksView extends CommunityView {
  readonly items: readonly BlockEntry[];
  readonly loaded: boolean;
  readonly canLoadMore: boolean;
}
export const initialBlocksView = (): BlocksView => ({
  ...initialCommunityView(),
  items: [],
  loaded: false,
  canLoadMore: false,
});
export class BlocksController extends CommunityController<BlocksView> {
  private nextCursor: string | null = null;
  constructor(runtime: CommunityRuntime, render: (view: BlocksView) => void) {
    super(runtime, initialBlocksView, render);
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
    this.update({ items: [], loaded: false, canLoadMore: false, busy: false });
    if (!this.available() || !this.runtime.blocks) return;
    await this.read(false);
  }
  async more(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.loaded ||
      !this.nextCursor ||
      !this.available() ||
      !this.runtime.blocks
    )
      return;
    await this.read(true);
  }
  private async read(append: boolean): Promise<void> {
    const after = append ? this.nextCursor : null;
    await this.run(
      (cancel) => this.runtime.blocks!.list(after, cancel),
      (result) => {
        if (result.nextCursor && result.nextCursor === after)
          throw new ClientError('protocol', 'Block cursor did not advance');
        this.nextCursor = result.nextCursor;
        const merged = new Map(
          (append ? this.view.items : []).map((item) => [
            item.relationshipId,
            item,
          ]),
        );
        for (const item of result.items) merged.set(item.relationshipId, item);
        this.update({
          items: [...merged.values()],
          loaded: true,
          canLoadMore: !!result.nextCursor,
          status: '仅显示你的主动屏蔽；解除不会改变对方的设置',
        });
      },
      (error) => {
        if (
          !append ||
          !['network', 'timeout', 'cancelled'].includes(error.kind)
        ) {
          this.nextCursor = null;
          this.update({ items: [], loaded: false, canLoadMore: false });
        }
      },
    );
  }
}
