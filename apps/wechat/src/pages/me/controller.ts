import {
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { AuthorMode, MediaView, Post } from '../../community/contract';
import type { CommunityRuntime } from '../../community/runtime';
import type {
  DiscoveryContinuation,
  DiscoveryCountStatus,
  LikedItem,
} from '../../profile/discovery-contract';
import { LikedController, type LikedView } from '../community-liked/controller';
import { SavedController, type SavedView } from '../community-saved/controller';
import {
  PublicProfileController,
  type PublicProfileView,
} from '../public-profile/controller';

import {
  OwnContentController,
  type OwnContentView,
} from './own-content-controller';
import type {
  OwnPublicationItem,
  OwnPublicationsGateway,
} from '../../profile/own-publications';
export type MeTab = 'posts' | 'replies' | 'saved' | 'liked';
export interface MeContentCard {
  readonly id: string;
  readonly text: string;
  readonly author: string;
  readonly context: string;
  readonly imageCount: number;
  readonly images: readonly MediaView[];
  readonly kind: 'post' | 'comment' | 'reply';
  readonly likeCount: number | null;
  readonly url: string;
}
export interface MeContentView extends CommunityView {
  readonly tab: MeTab;
  readonly mode: AuthorMode;
  readonly items: readonly MeContentCard[];
  readonly loaded: boolean;
  readonly noProfile: boolean;
  readonly availability:
    'unknown' | 'available' | 'unavailable' | 'hidden' | 'no_profile';
  readonly total: number | null;
  readonly totalStatus: DiscoveryCountStatus | null;
  readonly continuation: DiscoveryContinuation | null;
  readonly canLoadMore: boolean;
  readonly canPrevious: boolean;
  readonly pageNumber: number;
}
/** Searches only this volatile, already-authorized page, never private history. */
export function filterMeContent(
  items: readonly MeContentCard[],
  rawQuery: string,
): readonly MeContentCard[] {
  const query = rawQuery.slice(0, 100).trim().toLocaleLowerCase();
  return query
    ? items.filter((item) =>
        `${item.text} ${item.author} ${item.context}`
          .toLocaleLowerCase()
          .includes(query),
      )
    : items;
}
export const initialMeContentView = (
  tab: MeTab = 'posts',
  mode: AuthorMode = 'named',
): MeContentView => ({
  ...initialCommunityView(),
  tab,
  mode,
  items: [],
  loaded: false,
  noProfile: false,
  availability: 'unknown',
  total: null,
  totalStatus: null,
  continuation: null,
  canLoadMore: false,
  canPrevious: false,
  pageNumber: 0,
});

const postCard = (post: Post): MeContentCard => ({
  id: post.id,
  text: post.text,
  author: post.author.displayName,
  context: post.space.name,
  imageCount: post.images.length,
  images: post.images,
  kind: 'post',
  likeCount: post.likeCount,
  url: `/pages/community-detail/community-detail?postId=${post.id}`,
});
const likedCard = (item: LikedItem | OwnPublicationItem): MeContentCard => ({
  id: 'likeId' in item ? item.likeId : `${item.kind}-${item.targetId}`,
  text: item.preview.text,
  author: item.preview.author.displayName,
  context: item.kind === 'post' ? '主题' : '回复',
  imageCount: item.preview.images.length,
  images: item.preview.images,
  kind: item.kind,
  likeCount: null,
  url:
    item.kind === 'reply'
      ? `/pages/community-thread/community-thread?postId=${item.postId}&rootCommentId=${item.rootCommentId}&replyId=${item.targetId}`
      : `/pages/community-detail/community-detail?postId=${item.postId}${
          item.kind === 'comment' ? `&rootCommentId=${item.rootCommentId}` : ''
        }`,
});

/**
 * Personal content composes policy-aware reads. Owner history uses exact kind
 * and identity filters, never a public profile projection. Legacy named-only
 * discovery is used only when no owner gateway is configured. Saved and liked
 * content remains separate from all publications and public share identity.
 * Exactly one child is retained, so changing tabs revokes its old read window.
 */
export class MeContentController {
  private child:
    | PublicProfileController
    | SavedController
    | LikedController
    | OwnContentController
    | undefined;
  private view = initialMeContentView();
  private generation = 0;
  private disposed = false;
  constructor(
    private readonly runtime: CommunityRuntime,
    private readonly render: (view: MeContentView) => void,
    private readonly ownPublications?: OwnPublicationsGateway,
  ) {}
  snapshot(): MeContentView {
    return this.view;
  }
  async setTab(tab: string): Promise<void> {
    if (!['posts', 'replies', 'saved', 'liked'].includes(tab)) return;
    await this.select(tab as MeTab, 'named');
  }
  async setMode(mode: string): Promise<void> {
    if (
      !['named', 'anonymous'].includes(mode) ||
      !['posts', 'replies'].includes(this.view.tab)
    )
      return;
    await this.select(this.view.tab, mode as AuthorMode);
  }
  private async select(tab: MeTab, mode: AuthorMode): Promise<void> {
    if (
      this.disposed ||
      (this.child && this.view.tab === tab && this.view.mode === mode)
    )
      return;
    const generation = ++this.generation;
    this.child?.dispose();
    this.child = undefined;
    this.publish(initialMeContentView(tab, mode));
    const current = (): boolean =>
      !this.disposed && this.generation === generation;
    if (
      (tab === 'posts' && (this.ownPublications || mode === 'anonymous')) ||
      tab === 'replies'
    ) {
      this.child = new OwnContentController(
        this.runtime,
        this.ownPublications,
        tab === 'posts' ? 'topic' : 'reply',
        mode,
        (view) => {
          if (current()) this.publish(this.fromOwn(view, tab, mode));
        },
      );
    } else if (tab === 'posts')
      this.child = new PublicProfileController(this.runtime, null, (view) => {
        if (current()) this.publish(this.fromPosts(view));
      });
    else if (tab === 'saved')
      this.child = new SavedController(this.runtime, (view) => {
        if (current()) this.publish(this.fromSaved(view));
      });
    else
      this.child = new LikedController(this.runtime, (view) => {
        if (current()) this.publish(this.fromLiked(view));
      });
    await this.child.load();
  }
  async load(): Promise<void> {
    if (this.disposed) return;
    if (this.child) await this.child.load();
    else await this.setTab(this.view.tab);
  }
  async more(): Promise<void> {
    await this.child?.more();
  }
  async previous(): Promise<void> {
    if (this.child && 'previous' in this.child) await this.child.previous();
  }
  cancel(): void {
    this.child?.cancel();
  }
  dispose(): void {
    if (this.disposed) return;
    this.generation++;
    this.child?.dispose();
    this.child = undefined;
    this.publish(initialMeContentView());
    this.disposed = true;
  }
  private fromPosts(view: PublicProfileView): MeContentView {
    return {
      ...view,
      tab: 'posts',
      mode: 'named',
      availability: !view.loaded
        ? 'unknown'
        : view.noProfile
          ? 'no_profile'
          : view.profile?.status !== 'available'
            ? 'unavailable'
            : view.profile.postsHidden
              ? 'hidden'
              : 'available',
      items: view.items
        .filter(
          (post) =>
            post.author.kind === 'named' &&
            view.profile?.status === 'available' &&
            view.profile.isOwn &&
            post.author.profileId === view.profile.profileId,
        )
        .map(postCard),
    };
  }
  private fromOwn(
    view: OwnContentView,
    tab: MeTab,
    mode: AuthorMode,
  ): MeContentView {
    return {
      ...initialMeContentView(tab, mode),
      ...view,
      tab,
      mode,
      availability: view.loaded ? 'available' : 'unknown',
      items: view.items.map(likedCard),
    };
  }
  private fromSaved(view: SavedView): MeContentView {
    return {
      ...initialMeContentView('saved'),
      ...view,
      tab: 'saved',
      availability: view.loaded ? 'available' : 'unknown',
      items: view.items.map((item) => postCard(item.post)),
      total: view.loaded ? view.visibleSavedCount : null,
      totalStatus: view.loaded ? 'known' : null,
      continuation: view.loaded ? (view.canLoadMore ? 'more' : 'end') : null,
    };
  }
  private fromLiked(view: LikedView): MeContentView {
    return {
      ...initialMeContentView('liked'),
      ...view,
      tab: 'liked',
      availability: view.loaded ? 'available' : 'unknown',
      items: view.items.map(likedCard),
      total: view.visibleLikedCount,
      totalStatus: view.visibleLikedCountStatus,
    };
  }
  private publish(view: MeContentView): void {
    if (this.disposed) return;
    this.view = Object.freeze(view);
    this.render(this.view);
  }
}
