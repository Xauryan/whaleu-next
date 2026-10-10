import { ClientError } from '../api/errors';
import type { LocalMediaFile } from '../media/contracts';
import { Cancellation, type Clock } from '../platform/contracts';
import type { AvatarGateway } from './avatar-gateway';
import {
  decodeCurrentAvatar,
  type CurrentAvatar,
  type AvatarVariant,
} from './avatar-contract';
import {
  AvatarPrincipalOwner,
  type AvatarPrincipal,
  type AvatarPrincipalContext,
} from './avatar-principal';
export interface AvatarReadTransfer {
  download(
    current: CurrentAvatar,
    variant: AvatarVariant,
    owner: object,
    principal: AvatarPrincipalContext,
    cancel: Cancellation,
  ): Promise<LocalMediaFile>;
  resolve(
    file: LocalMediaFile,
    owner: object,
    principal: AvatarPrincipal,
  ): Promise<string>;
  release(file: LocalMediaFile): Promise<void>;
}
export interface AvatarReadView {
  readonly status: 'idle' | 'loading' | 'ready' | 'none' | 'unavailable';
  readonly localSrc: string;
  readonly expanded: boolean;
}
export const initialAvatarReadView = (): AvatarReadView => ({
  status: 'idle',
  localSrc: '',
  expanded: false,
});
interface Read {
  readonly cancel: Cancellation;
  readonly principal: AvatarPrincipal;
  readonly context: AvatarPrincipalContext;
  readonly owner: object;
  file: LocalMediaFile | null;
  stopLease: () => void;
}
/** Every open/close/expiry requires fresh current metadata and controlled bytes.
 * Hiding revokes src synchronously; OS unlink remains best effort. */
export class AvatarReadController {
  private read: Read | null = null;
  private target: string | null | undefined;
  private disposed = false;
  private view = initialAvatarReadView();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly principals: AvatarPrincipalOwner,
    private readonly gateway: AvatarGateway,
    private readonly transfer: AvatarReadTransfer | undefined,
    private readonly clock: Clock,
    private readonly render: (view: AvatarReadView) => void,
  ) {
    this.unsubscribe = principals.subscribe(() => this.clear());
  }
  snapshot(): AvatarReadView {
    return this.view;
  }
  load(profileId: string | null, expanded = false): Promise<void> {
    this.target = profileId;
    return this.start(expanded);
  }
  open(): Promise<void> {
    return this.start(true);
  }
  close(): Promise<void> {
    return this.start(false);
  }
  imageFailed(): void {
    this.invalidate();
    this.publish({ ...initialAvatarReadView(), status: 'unavailable' });
  }
  clear(): void {
    this.target = undefined;
    this.invalidate();
  }
  hide(): void {
    this.clear();
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.clear();
  }
  private async start(expanded: boolean): Promise<void> {
    this.invalidate();
    if (this.disposed || this.target === undefined) return;
    const principal = this.principals.snapshot();
    const read: Read = {
      principal,
      cancel: new Cancellation(),
      owner: {},
      file: null,
      stopLease: () => undefined,
      context: {
        current: () => {
          this.principals.assertCurrent(principal);
          if (this.read !== read || read.cancel.isCancelled || this.disposed)
            throw new ClientError('cancelled', 'Avatar view superseded');
          return this.principals.snapshot();
        },
      },
    };
    this.read = read;
    this.publish({ status: 'loading', localSrc: '', expanded });
    try {
      const current = decodeCurrentAvatar(
        await this.gateway.current(this.target, read.context, read.cancel),
      );
      read.context.current();
      if (current.avatar.state !== 'available') {
        this.publish({
          status: current.avatar.state,
          localSrc: '',
          expanded: false,
        });
        return;
      }
      if (!this.transfer)
        throw new ClientError(
          'configuration',
          'Native avatar transfer unavailable',
        );
      const file = await this.transfer.download(
        current,
        expanded ? 'display-v1' : 'thumb-v1',
        read.owner,
        read.context,
        read.cancel,
      );
      try {
        read.context.current();
      } catch (error) {
        await this.transfer.release(file);
        throw error;
      }
      read.file = file;
      const localSrc = await this.transfer.resolve(
        file,
        read.owner,
        read.context.current(),
      );
      read.context.current();
      this.publish({ status: 'ready', localSrc, expanded });
      read.stopLease = this.clock.schedule(() => {
        if (this.read !== read) return;
        this.invalidate();
        this.publish({ ...initialAvatarReadView(), status: 'unavailable' });
      }, 30_000);
    } catch {
      if (this.read !== read) return;
      this.invalidate();
      this.publish({ ...initialAvatarReadView(), status: 'unavailable' });
    }
  }
  private invalidate(): void {
    const old = this.read;
    this.read = null;
    this.publish(initialAvatarReadView());
    if (old) {
      old.stopLease();
      old.cancel.cancel();
      if (old.file)
        void this.transfer?.release(old.file).catch(() => undefined);
      old.file = null;
    }
  }
  private publish(view: AvatarReadView): void {
    this.view = Object.freeze(view);
    try {
      this.render(this.view);
    } catch {
      /* A broken renderer cannot retain media authority. */
    }
  }
}
