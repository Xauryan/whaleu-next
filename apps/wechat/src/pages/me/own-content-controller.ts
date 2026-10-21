import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { AuthorMode } from '../../community/contract';
import type { CommunityRuntime } from '../../community/runtime';
import {
  decodeOwnPublicationPage,
  validateOwnPublicationScope,
  type OwnPublicationItem,
  type OwnPublicationKind,
  type OwnPublicationsGateway,
} from '../../profile/own-publications';
import type { DiscoveryContinuation } from '../../profile/discovery-contract';
export interface OwnContentView extends CommunityView {
  readonly items: readonly OwnPublicationItem[];
  readonly loaded: boolean;
  readonly continuation: DiscoveryContinuation | null;
  readonly canLoadMore: boolean;
  readonly canPrevious: boolean;
  readonly pageNumber: number;
}
const initial = (): OwnContentView => ({
  ...initialCommunityView(),
  items: [],
  loaded: false,
  continuation: null,
  canLoadMore: false,
  canPrevious: false,
  pageNumber: 0,
});
/** Private owner history never supplies a public profile identity or share target. */
export class OwnContentController extends CommunityController<OwnContentView> {
  private nextCursor: string | null = null;
  private cursors: (string | null)[] = [null];
  private pageIndex = 0;
  constructor(
    runtime: CommunityRuntime,
    private readonly gateway: OwnPublicationsGateway | undefined,
    private readonly kind: OwnPublicationKind,
    private readonly identity: AuthorMode,
    render: (view: OwnContentView) => void,
  ) {
    super(runtime, initial, render);
  }
  protected override resetPrivate(): void {
    this.nextCursor = null;
    this.cursors = [null];
    this.pageIndex = 0;
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  async load(): Promise<void> {
    this.resetPrivate();
    await this.read(null, 0);
  }
  async more(): Promise<void> {
    if (!this.view.busy && this.view.loaded && this.nextCursor)
      await this.read(this.nextCursor, this.pageIndex + 1);
  }
  async previous(): Promise<void> {
    if (!this.view.busy && this.view.loaded && this.pageIndex > 0)
      await this.read(this.cursors[this.pageIndex - 1]!, this.pageIndex - 1);
  }
  private clear(): void {
    this.stop();
    this.nextCursor = null;
    this.update({
      items: [],
      loaded: false,
      continuation: null,
      canLoadMore: false,
      canPrevious: false,
      pageNumber: 0,
      busy: false,
    });
  }
  private async read(after: string | null, index: number): Promise<void> {
    this.clear();
    if (!this.available()) return;
    if (!this.gateway) {
      this.update({ error: '发布记录暂不可用，请稍后重试' });
      return;
    }
    await this.run(
      (cancel) => this.gateway!.read(this.kind, this.identity, after, cancel),
      (raw) => {
        const page = decodeOwnPublicationPage(raw);
        validateOwnPublicationScope(page, this.kind, this.identity);
        if (
          page.nextCursor !== null &&
          (page.nextCursor === after ||
            this.cursors.slice(0, index).includes(page.nextCursor))
        )
          throw new ClientError(
            'protocol',
            'Own publication cursor did not advance',
          );
        this.nextCursor = page.nextCursor;
        this.cursors = [...this.cursors.slice(0, index), after];
        this.pageIndex = index;
        this.update({
          items: page.items,
          loaded: true,
          continuation: page.continuation,
          canLoadMore: page.nextCursor !== null,
          canPrevious: index > 0,
          pageNumber: index + 1,
          status:
            page.continuation === 'scan_pending'
              ? '还有记录待核验'
              : '已加载当前可查看内容',
        });
      },
      () => {
        this.resetPrivate();
        this.clear();
      },
    );
  }
  override cancel(): void {
    this.resetPrivate();
    this.clear();
    this.update({ error: '', status: '已停止加载' });
  }
}
