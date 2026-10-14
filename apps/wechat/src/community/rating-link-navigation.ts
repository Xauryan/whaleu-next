import type { SessionStore } from '../auth/session';
import { DirectoryNavigator } from '../directory/navigation';
import type { WxApi } from '../platform/wechat';
import type { Post } from './contract';
import { ratingLinkNavigationPath } from './rating-link-contract';
/** Accepts only the current decoded post DTO, never arbitrary dataset URLs. */
export class RatingLinkNavigator {
  private readonly navigator: DirectoryNavigator;
  private readonly unsubscribe: () => void;
  constructor(
    native: Pick<WxApi, 'navigateTo'>,
    sessions: SessionStore,
    failure: () => void,
  ) {
    this.navigator = new DirectoryNavigator(native, failure);
    const owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const current = sessions.snapshot();
      if (
        current.epoch !== owner.epoch ||
        current.credentials?.accountId !== owner.credentials?.accountId
      )
        this.navigator.dispose();
    });
  }
  open(post: Post | null | undefined): void {
    if (post?.component.kind === 'rating_target_link')
      this.navigator.open(ratingLinkNavigationPath(post.component));
  }
  dispose(): void {
    this.navigator.dispose();
    this.unsubscribe();
  }
}
