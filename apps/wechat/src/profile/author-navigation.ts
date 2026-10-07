import { decodeAuthor, type Author } from '../community/contract';
import type { CommunityRuntime } from '../community/runtime';
import type { WxApi } from '../platform/wechat';
/** Accept only the current canonical public author. Dataset/private-overlay identifiers are never selectors. */
export function authorProfilePath(
  raw: Author | null | undefined,
): string | null {
  if (!raw) return null;
  try {
    const author = decodeAuthor(raw);
    return author.kind === 'named'
      ? `/pages/public-profile/public-profile?profileId=${author.profileId}`
      : null;
  } catch {
    return null;
  }
}
export class AuthorNavigator {
  private navigating = false;
  private disposed = false;
  private generation = 0;
  private readonly unsubscribeSession: () => void;
  private readonly unsubscribeHide: () => void;
  constructor(
    private readonly native: Pick<WxApi, 'navigateTo'>,
    private readonly failure: () => void = () => undefined,
    runtime?: Pick<CommunityRuntime, 'sessions' | 'privateViews'>,
  ) {
    let owner = runtime?.sessions.snapshot();
    this.unsubscribeSession =
      runtime?.sessions.subscribe(() => {
        const current = runtime.sessions.snapshot();
        if (
          current.epoch !== owner?.epoch ||
          current.credentials?.accountId !== owner?.credentials?.accountId
        ) {
          owner = current;
          this.invalidate();
        }
      }) ?? (() => undefined);
    this.unsubscribeHide =
      runtime?.privateViews?.subscribe(() => this.invalidate()) ??
      (() => undefined);
  }
  private invalidate(): void {
    this.generation++;
    this.navigating = false;
  }
  open(author: Author | null | undefined): void {
    if (this.disposed || this.navigating) return;
    const url = authorProfilePath(author);
    if (!url) return;
    if (!this.native.navigateTo) {
      this.failure();
      return;
    }
    this.navigating = true;
    const generation = ++this.generation;
    const current = () => !this.disposed && generation === this.generation;
    try {
      this.native.navigateTo({
        url,
        success: () => {
          if (current()) this.navigating = false;
        },
        fail: () => {
          if (current()) {
            this.navigating = false;
            this.failure();
          }
        },
      });
    } catch {
      if (current()) {
        this.navigating = false;
        this.failure();
      }
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
    this.unsubscribeSession();
    this.unsubscribeHide();
  }
}
