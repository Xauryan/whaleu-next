import { ClientError } from '../api/errors';
import type { SessionTicket } from '../auth/session';
import type { MediaFiles } from '../platform/wechat-media';
import { isNativeTemporaryPath } from '../platform/wechat-media';
import type { LocalMediaFile } from './contracts';

interface Lease {
  readonly owner: object;
  readonly epoch: number;
  readonly accountId: string;
  readonly path: string;
  readonly bytes: number;
}
/** Process-local capability registry. Object identity is required, so serialized/forged
 * handles (including a previous boot's handle) have no authority. No persistent cache/index.
 * Failed unlinks remain revoked tombstones and consume capacity until explicit retry. */
export class MediaLocalFiles {
  private readonly leases = new Map<LocalMediaFile, Lease>();
  private readonly tombstones = new Set<string>();
  private readonly deleting = new Map<string, Promise<void>>();
  private sequence = 0;
  constructor(private readonly files: MediaFiles) {}
  get capacityAvailable(): boolean {
    return this.leases.size + this.tombstones.size < 4;
  }
  adopt(
    path: string,
    bytes: number,
    owner: object,
    ticket: SessionTicket,
  ): LocalMediaFile {
    if (
      !isNativeTemporaryPath(path) ||
      !this.capacityAvailable ||
      !ticket.credentials ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > 5 * 1024 * 1024 ||
      [...this.leases.values()].reduce((sum, file) => sum + file.bytes, 0) +
        bytes >
        10 * 1024 * 1024 ||
      [...this.leases.values()].some((file) => file.path === path) ||
      this.tombstones.has(path)
    )
      throw new ClientError('storage', 'Temporary media capacity unavailable');
    const handle = Object.freeze({ localId: `media-${++this.sequence}` });
    this.leases.set(handle, {
      path,
      bytes,
      owner,
      epoch: ticket.epoch,
      accountId: ticket.credentials.accountId,
    });
    return handle;
  }
  async resolve(
    handle: LocalMediaFile,
    owner: object,
    ticket: SessionTicket,
  ): Promise<string> {
    const lease = this.leases.get(handle);
    if (
      !lease ||
      lease.owner !== owner ||
      lease.epoch !== ticket.epoch ||
      lease.accountId !== ticket.credentials?.accountId
    )
      throw new ClientError(
        'stale-session',
        'Temporary image is no longer available',
      );
    if (
      (await this.files.stat(lease.path)) !== lease.bytes ||
      this.leases.get(handle) !== lease
    )
      throw new ClientError(
        'storage',
        'Temporary image is no longer available',
      );
    return lease.path;
  }
  release(handle: LocalMediaFile): Promise<void> {
    const lease = this.leases.get(handle);
    if (!lease) return Promise.resolve();
    this.leases.delete(handle); // Revoke before asynchronous removal.
    return this.discard(lease.path);
  }
  discard(path: string): Promise<void> {
    if (
      !isNativeTemporaryPath(path) ||
      [...this.leases.values()].some((file) => file.path === path)
    )
      return Promise.resolve();
    const pending = this.deleting.get(path);
    if (pending) return pending;
    // At most two native callbacks and four retained leases/tombstones are admitted.
    this.tombstones.add(path);
    const deletion = this.files
      .unlink(path)
      .then(
        () => {
          this.tombstones.delete(path);
        },
        () => {
          // Missing files and failures remain revoked. Do not infer absence from an opaque FS error.
        },
      )
      .finally(() => {
        this.deleting.delete(path);
      });
    this.deleting.set(path, deletion);
    return deletion;
  }
  async retryCleanup(): Promise<void> {
    await Promise.all([...this.tombstones].map((path) => this.discard(path)));
  }
}
