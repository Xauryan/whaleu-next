import { ClientError } from '../api/errors';
import type { LocalMediaFile } from '../media/contracts';
import { Cancellation, type Clock } from '../platform/contracts';
import type { CoverGateway } from './cover-gateway';
import {
  decodeCurrentCover,
  type CurrentCover,
  type CoverVariant,
} from './cover-contract';
import {
  CoverPrincipalOwner,
  type CoverPrincipal,
  type CoverPrincipalContext,
} from './cover-principal';
export interface CoverReadTransfer {
  download(
    current: CurrentCover,
    variant: CoverVariant,
    owner: object,
    principal: CoverPrincipalContext,
    cancel: Cancellation,
  ): Promise<LocalMediaFile>;
  resolve(
    file: LocalMediaFile,
    owner: object,
    principal: CoverPrincipal,
  ): Promise<string>;
  release(file: LocalMediaFile): Promise<void>;
}
export interface CoverReadView {
  readonly status: 'idle' | 'loading' | 'ready' | 'none' | 'unavailable';
  readonly localSrc: string;
  readonly expanded: boolean;
}
export const initialCoverReadView = (): CoverReadView => ({
  status: 'idle',
  localSrc: '',
  expanded: false,
});
interface Read {
  readonly cancel: Cancellation;
  readonly principal: CoverPrincipal;
  readonly context: CoverPrincipalContext;
  readonly owner: object;
  file: LocalMediaFile | null;
  stopLease: () => void;
}
/** Every open/close/expiry requires fresh current metadata and controlled bytes.
 * Hiding revokes src synchronously; OS unlink remains best effort. */
export class CoverReadController {
  private read: Read | null = null;
  private target: string | null | undefined;
  private disposed = false;
  private view = initialCoverReadView();
  private readonly unsubscribe: () => void;
  constructor(
    private readonly principals: CoverPrincipalOwner,
    private readonly gateway: CoverGateway,
    private readonly transfer: CoverReadTransfer | undefined,
    private readonly clock: Clock,
    private readonly render: (view: CoverReadView) => void,
  ) {
    this.unsubscribe = principals.subscribe(() => this.clear());
  }
  snapshot(): CoverReadView {
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
    this.publish({ ...initialCoverReadView(), status: 'unavailable' });
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
            throw new ClientError('cancelled', 'Cover view superseded');
          return this.principals.snapshot();
        },
      },
    };
    this.read = read;
    this.publish({ status: 'loading', localSrc: '', expanded });
    try {
      const current = decodeCurrentCover(
        await this.gateway.current(this.target, read.context, read.cancel),
      );
      read.context.current();
      if (current.cover.state !== 'available') {
        this.publish({
          status: current.cover.state,
          localSrc: '',
          expanded: false,
        });
        return;
      }
      if (!this.transfer)
        throw new ClientError(
          'configuration',
          'Native cover transfer unavailable',
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
        this.publish({ ...initialCoverReadView(), status: 'unavailable' });
      }, 30_000);
    } catch {
      if (this.read !== read) return;
      this.invalidate();
      this.publish({ ...initialCoverReadView(), status: 'unavailable' });
    }
  }
  private invalidate(): void {
    const old = this.read;
    this.read = null;
    this.publish(initialCoverReadView());
    if (old) {
      old.stopLease();
      old.cancel.cancel();
      if (old.file)
        void this.transfer?.release(old.file).catch(() => undefined);
      old.file = null;
    }
  }
  private publish(view: CoverReadView): void {
    this.view = Object.freeze(view);
    try {
      this.render(this.view);
    } catch {
      /* A broken renderer cannot retain media authority. */
    }
  }
}
