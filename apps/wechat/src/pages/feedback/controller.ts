import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type {
  CommunitySpace,
  Continuation,
  Post,
} from '../../community/contract';
import type { CommunityRuntime } from '../../community/runtime';
export interface FeedbackView extends CommunityView {
  readonly space: CommunitySpace | null;
  readonly posts: readonly Post[];
  readonly loaded: boolean;
  readonly continuation: Continuation;
  readonly canLoadMore: boolean;
}
export const initialFeedbackView = (): FeedbackView => ({
  ...initialCommunityView(),
  space: null,
  posts: [],
  loaded: false,
  continuation: 'end',
  canLoadMore: false,
});
export class FeedbackController extends CommunityController<FeedbackView> {
  private cursor: string | null = null;
  constructor(runtime: CommunityRuntime, render: (view: FeedbackView) => void) {
    super(runtime, initialFeedbackView, render);
  }
  protected override resetPrivate(): void {
    this.cursor = null;
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  async load(): Promise<void> {
    await this.read(false);
  }
  async more(): Promise<void> {
    if (this.view.canLoadMore && !this.view.busy) await this.read(true);
  }
  private async read(more: boolean): Promise<void> {
    if (!this.available(false) || !this.runtime.gateway?.feedbackTopic) return;
    const cursor = more ? this.cursor : null;
    if (!more) {
      this.cursor = null;
      this.update({
        space: null,
        posts: [],
        loaded: false,
        canLoadMore: false,
      });
    }
    await this.run(
      async (cancel) => {
        const { space } = await this.runtime.gateway!.feedbackTopic!(cancel);
        if (more && this.view.space?.id !== space.id)
          throw new ClientError('protocol', 'Feedback topic changed');
        const feed = await this.runtime.gateway!.feed(
          {
            spaceId: space.id,
            category: 'feedback',
            ...(cursor ? { cursor } : {}),
          },
          cancel,
        );
        if (
          feed.items.some(
            (post) =>
              post.category !== 'feedback' ||
              post.space.id !== space.id ||
              !post.feedback,
          )
        )
          throw new ClientError('protocol', 'Feedback source mismatch');
        return { space, feed };
      },
      ({ space, feed }) => {
        this.cursor = feed.nextCursor;
        const seen = new Set(this.view.posts.map((p) => p.id));
        this.update({
          space,
          posts: more
            ? [...this.view.posts, ...feed.items.filter((p) => !seen.has(p.id))]
            : feed.items,
          loaded: true,
          canLoadMore: !!this.cursor,
          continuation: feed.continuation,
          status: '全站公开意见建议，不按浏览学校筛选',
        });
      },
      () => {
        this.cursor = null;
        this.update({
          space: null,
          posts: [],
          loaded: false,
          canLoadMore: false,
        });
      },
    );
  }
}
