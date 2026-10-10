import { decodeAuthor, type Author } from '../community/contract';
import type { ProfileAvatarRuntime } from './avatar-runtime';
import {
  initialAvatarReadView,
  type AvatarReadController,
  type AvatarReadView,
} from './avatar-read-controller';
export interface NamedAvatarView extends AvatarReadView {
  readonly opened: boolean;
}
export const initialNamedAvatarView = (): NamedAvatarView => ({
  ...initialAvatarReadView(),
  opened: false,
});
/** One lazy named-author viewer per page, never one reader per row. Anonymous
 * authors cannot create a request, including the account owner's own persona. */
export class NamedAvatarController {
  private readonly reader: AvatarReadController | undefined;
  private opened = false;
  private pending: { profileId: string; promise: Promise<void> } | null = null;
  constructor(
    runtime: ProfileAvatarRuntime | undefined,
    private readonly render: (view: NamedAvatarView) => void,
  ) {
    this.reader = runtime?.createReader((view) =>
      this.publish({ ...view, opened: this.opened }),
    );
  }
  async open(raw: Author | undefined): Promise<void> {
    if (!raw) {
      this.clear();
      return;
    }
    let author: Author;
    try {
      author = decodeAuthor(raw);
    } catch {
      this.clear();
      return;
    }
    if (author.kind !== 'named') {
      this.clear();
      return;
    }
    if (this.pending?.profileId === author.profileId)
      return this.pending.promise;
    this.clear();
    this.opened = true;
    if (!this.reader) {
      this.publish({
        ...initialNamedAvatarView(),
        opened: true,
        status: 'unavailable',
      });
      return;
    }
    const promise = this.reader.load(author.profileId, true);
    this.pending = { profileId: author.profileId, promise };
    await promise;
    if (this.pending?.promise === promise) this.pending = null;
  }
  imageFailed(): void {
    this.reader?.imageFailed();
  }
  clear(): void {
    this.pending = null;
    this.opened = false;
    this.reader?.clear();
    this.publish(initialNamedAvatarView());
  }
  dispose(): void {
    this.clear();
    this.reader?.dispose();
  }
  private publish(view: NamedAvatarView): void {
    try {
      this.render(view);
    } catch {
      /* Media revocation must still finish. */
    }
  }
}
