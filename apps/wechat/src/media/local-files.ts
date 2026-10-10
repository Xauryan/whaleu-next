import { ClientError } from '../api/errors';
import type { SessionTicket } from '../auth/session';
import type { MediaFiles } from '../platform/wechat-media';
import { isNativeTemporaryPath } from '../platform/wechat-media';
import type { LocalMediaFile } from './contracts';

export interface MediaReservation {
  readonly reservation: number;
}
export interface NativeMediaCredit {
  (): void;
  /** Only a validated uploadObserved receipt can end a server writer early.
   * The native task still owns its transfer credit until complete. */
  releaseWriter(): void;
}
interface Lease {
  readonly owner: object;
  readonly epoch: number | null;
  readonly accountId: string | null;
  readonly guestGeneration: object | null;
  readonly path: string;
  readonly bytes: number;
}
/** Process-local capability registry. Object identity is required, so serialized/forged
 * handles (including a previous boot's handle) have no authority. No persistent cache/index.
 * Failed unlinks remain revoked tombstones and consume capacity until explicit retry. */
export class MediaLocalFiles {
  private readonly leases = new Map<LocalMediaFile, Lease>();
  private readonly tombstones = new Set<string>();
  private readonly tombstoneBytes = new Map<string, number>();
  private readonly reservations = new Map<
    MediaReservation,
    { bytes: number; holds: number }
  >();
  private nativeTransfers = 0;
  private readonly uploadWriters = new Set<string>();
  private readonly deleting = new Map<string, Promise<void>>();
  private sequence = 0;
  constructor(private readonly files: MediaFiles) {}
  get capacityAvailable(): boolean {
    return this.leases.size + this.tombstones.size + this.reservations.size < 4;
  }
  private occupiedBytes(): number {
    return (
      [...this.leases.values()].reduce((sum, file) => sum + file.bytes, 0) +
      [...this.reservations.values()].reduce(
        (sum, item) => sum + item.bytes,
        0,
      ) +
      [...this.tombstoneBytes.values()].reduce((sum, bytes) => sum + bytes, 0)
    );
  }
  /** Reserve before picker/download allocates bytes. Abort does not release a
   * native hold until complete; a late callback transfers it into cleanup. */
  reserve(bytes = 5 * 1024 * 1024): MediaReservation {
    if (
      !this.capacityAvailable ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > 5 * 1024 * 1024 ||
      this.occupiedBytes() + bytes > 10 * 1024 * 1024
    )
      throw new ClientError(
        'storage',
        'Temporary media reservation unavailable',
      );
    const handle = Object.freeze({ reservation: ++this.sequence });
    this.reservations.set(handle, { bytes, holds: 1 });
    return handle;
  }
  holdReservation(handle: MediaReservation): () => void {
    const entry = this.reservations.get(handle);
    if (!entry)
      throw new ClientError('storage', 'Media reservation no longer valid');
    entry.holds++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.releaseReservation(handle);
      }
    };
  }
  releaseReservation(handle: MediaReservation): void {
    const entry = this.reservations.get(handle);
    if (entry && --entry.holds === 0) this.reservations.delete(handle);
  }
  /** The registry is shared by upload and gallery transports, including abandoned
   * native callbacks. Separate adapter instances cannot multiply this budget. */
  assertTransferCapacity(actorWriter?: string): void {
    if (
      this.nativeTransfers >= 2 ||
      (actorWriter && this.uploadWriters.has(actorWriter))
    )
      throw new ClientError(
        'configuration',
        'Native media transfer capacity unavailable',
      );
  }
  acquireTransfer(actorWriter?: string): NativeMediaCredit {
    this.assertTransferCapacity(actorWriter);
    this.nativeTransfers++;
    if (actorWriter) this.uploadWriters.add(actorWriter);
    let released = false;
    let writerReleased = false;
    const releaseWriter = () => {
      if (writerReleased) return;
      writerReleased = true;
      if (actorWriter) this.uploadWriters.delete(actorWriter);
    };
    const release = () => {
      if (released) return;
      released = true;
      this.nativeTransfers--;
      releaseWriter();
    };
    return Object.assign(release, { releaseWriter });
  }
  adopt(
    path: string,
    bytes: number,
    owner: object,
    ticket: SessionTicket,
    reservation?: MediaReservation,
  ): LocalMediaFile {
    if (!ticket.credentials)
      throw new ClientError('storage', 'Temporary media capacity unavailable');
    return this.adoptPrincipal(
      path,
      bytes,
      owner,
      {
        epoch: ticket.epoch,
        accountId: ticket.credentials.accountId,
        guestGeneration: null,
      },
      reservation,
    );
  }
  /** Profile-only guest lease. No invented account/session identity. */
  adoptGuest(
    path: string,
    bytes: number,
    owner: object,
    generation: object,
    reservation?: MediaReservation,
  ): LocalMediaFile {
    return this.adoptPrincipal(
      path,
      bytes,
      owner,
      {
        epoch: null,
        accountId: null,
        guestGeneration: generation,
      },
      reservation,
    );
  }
  private adoptPrincipal(
    path: string,
    bytes: number,
    owner: object,
    principal: Pick<Lease, 'epoch' | 'accountId' | 'guestGeneration'>,
    reservation?: MediaReservation,
  ): LocalMediaFile {
    const reserved = reservation
      ? this.reservations.get(reservation)
      : undefined;
    if (
      !isNativeTemporaryPath(path) ||
      (reservation !== undefined && !reserved) ||
      (!reserved && !this.capacityAvailable) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > 5 * 1024 * 1024 ||
      (reserved && bytes > reserved.bytes) ||
      this.occupiedBytes() - (reserved?.bytes ?? 0) + bytes >
        10 * 1024 * 1024 ||
      [...this.leases.values()].some((file) => file.path === path) ||
      this.tombstones.has(path)
    )
      throw new ClientError('storage', 'Temporary media capacity unavailable');
    if (reservation) this.reservations.delete(reservation);
    const handle = Object.freeze({ localId: `media-${++this.sequence}` });
    this.leases.set(handle, {
      path,
      bytes,
      owner,
      ...principal,
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
      lease.accountId !== ticket.credentials?.accountId ||
      lease.guestGeneration !== null
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
  async resolveGuest(
    handle: LocalMediaFile,
    owner: object,
    generation: object,
  ): Promise<string> {
    const lease = this.leases.get(handle);
    if (
      !lease ||
      lease.owner !== owner ||
      lease.guestGeneration !== generation ||
      lease.accountId !== null
    )
      throw new ClientError(
        'stale-session',
        'Guest image is no longer available',
      );
    if (
      (await this.files.stat(lease.path)) !== lease.bytes ||
      this.leases.get(handle) !== lease
    )
      throw new ClientError('storage', 'Guest image is no longer available');
    return lease.path;
  }
  release(handle: LocalMediaFile): Promise<void> {
    const lease = this.leases.get(handle);
    if (!lease) return Promise.resolve();
    this.leases.delete(handle); // Revoke before asynchronous removal.
    this.tombstoneBytes.set(lease.path, lease.bytes);
    return this.discard(lease.path);
  }
  discard(path: string, reservation?: MediaReservation): Promise<void> {
    if (
      !isNativeTemporaryPath(path) ||
      [...this.leases.values()].some((file) => file.path === path)
    )
      return Promise.resolve();
    const pending = this.deleting.get(path);
    if (pending) return pending;
    if (reservation) {
      const reserved = this.reservations.get(reservation);
      if (reserved) {
        this.tombstoneBytes.set(path, reserved.bytes);
        this.reservations.delete(reservation);
      }
    }
    // At most two native callbacks and four retained leases/tombstones are admitted.
    this.tombstones.add(path);
    const deletion = this.files
      .unlink(path)
      .then(
        () => {
          this.tombstones.delete(path);
          this.tombstoneBytes.delete(path);
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
