import type { WxApi } from '../platform/wechat';
import { isUuid } from '../profile/contract';

export const destinations = {
  home: '/pages/community-feed/community-feed',
  campus: '/pages/campus-hub/campus-hub',
  messages: '/pages/inbox/inbox',
  me: '/pages/me/me',
} as const;
export type Destination = keyof typeof destinations;
export function isDestination(value: string): value is Destination {
  return Object.prototype.hasOwnProperty.call(destinations, value);
}
export function composeRoute(spaceId: string): string {
  return isUuid(spaceId)
    ? `/pages/community-compose/community-compose?spaceId=${encodeURIComponent(spaceId)}&category=discussion`
    : '/pages/compose-entry/compose-entry';
}
/** A single-flight gate avoids double navigation while native transitions run. */
export class ShellNavigator {
  private pending = false;
  private disposed = false;
  private generation = 0;
  constructor(private readonly api: Pick<WxApi, 'reLaunch' | 'navigateTo'>) {}
  open(
    target: string,
    selected: string,
    spaceId: string,
    failed: () => void,
  ): void {
    if (this.disposed || this.pending || target === selected) return;
    if (target !== 'compose' && !isDestination(target)) return;
    const navigate =
      target === 'compose' ? this.api.navigateTo : this.api.reLaunch;
    if (!navigate) {
      failed();
      return;
    }
    this.pending = true;
    const generation = ++this.generation;
    const finish = (error: boolean) => {
      if (this.disposed || !this.pending || generation !== this.generation)
        return;
      this.pending = false;
      if (error) failed();
    };
    try {
      navigate.call(this.api, {
        url:
          target === 'compose'
            ? composeRoute(spaceId)
            : destinations[target as Destination],
        success: () => finish(false),
        fail: () => finish(true),
      });
    } catch {
      finish(true);
    }
  }
  dispose(): void {
    this.disposed = true;
    this.pending = false;
  }
}
