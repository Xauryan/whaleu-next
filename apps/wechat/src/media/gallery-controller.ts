import { ClientError } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import { Cancellation } from '../platform/contracts';
import type { MediaReadTransfer } from './authenticated-download';
import type {
  LocalMediaFile,
  MediaAttachment,
  MediaSession,
} from './contracts';
import { decodeMediaAttachment } from './decoders';

export interface GallerySlot {
  readonly index: number;
  readonly viewId: string;
  readonly status: 'loading' | 'ready' | 'unavailable';
  readonly localSrc: string;
}
export interface GalleryView {
  readonly total: number;
  readonly start: number;
  readonly slots: readonly GallerySlot[];
  readonly expanded: boolean;
  readonly selected: number;
  readonly status: 'idle' | 'loading' | 'ready' | 'unavailable';
}
export const initialGalleryView = (): GalleryView => ({
  total: 0,
  start: 0,
  slots: [],
  expanded: false,
  selected: 0,
  status: 'idle',
});
interface Generation {
  readonly ticket: SessionTicket;
  readonly cancel: Cancellation;
  readonly owner: object;
  readonly files: Map<number, LocalMediaFile>;
  readonly session: MediaSession;
}
/** Only the visible three-thumbnail window is resident. A display switch is a new
 * authenticated read, never a promotion of cached thumbnails or wx.previewImage. */
export class MediaGalleryController {
  private descriptors: readonly MediaAttachment[] = [];
  private descriptorTicket: SessionTicket | null = null;
  private generation: Generation | null = null;
  private view = initialGalleryView();
  private disposed = false;
  private releasing: Promise<void> = Promise.resolve();
  private settling: Promise<void> = Promise.resolve();
  private beforeRead: Promise<void> | undefined;
  private viewSequence = 0;
  private operation: { key: string; promise: Promise<void> } | null = null;
  private readonly unsubscribe: () => void;
  private readonly stopPrivate: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly transfer: MediaReadTransfer | undefined,
    private readonly render: (view: GalleryView) => void,
    privateViews?: PrivateViewLifecycle,
  ) {
    this.unsubscribe = sessions.subscribe(() => {
      if (!this.descriptorTicket) return;
      try {
        sessions.assertCurrent(this.descriptorTicket);
      } catch {
        this.clear();
      }
    });
    this.stopPrivate =
      privateViews?.subscribe((account) => {
        if (
          !account ||
          account === this.descriptorTicket?.credentials?.accountId
        )
          this.clear();
      }) ?? (() => undefined);
  }
  snapshot(): GalleryView {
    return this.view;
  }
  load(
    raw: readonly MediaAttachment[] | null,
    beforeRead?: Promise<void>,
  ): Promise<void> {
    this.clear();
    this.beforeRead = beforeRead;
    if (!raw || this.disposed) return Promise.resolve();
    try {
      if (raw.length < 1 || raw.length > 9)
        throw new ClientError('protocol', 'Invalid gallery');
      const descriptors = raw.map(decodeMediaAttachment);
      if (
        new Set(descriptors.map((item) => item.bindingId)).size !==
          descriptors.length ||
        new Set(descriptors.map((item) => item.assetId)).size !==
          descriptors.length
      )
        throw new ClientError('protocol', 'Duplicate gallery member');
      this.descriptors = descriptors;
      this.descriptorTicket = this.sessions.snapshot();
    } catch {
      this.publish({ ...initialGalleryView(), status: 'unavailable' });
      return Promise.resolve();
    }
    return this.window(0);
  }
  window(start: number): Promise<void> {
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      start >= this.descriptors.length
    )
      return Promise.resolve();
    return this.start(start, false);
  }
  open(index: number): Promise<void> {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= this.descriptors.length
    )
      return Promise.resolve();
    return this.start(index, true);
  }
  close(): Promise<void> {
    return this.window(Math.floor(this.view.selected / 3) * 3);
  }
  imageFailed(index: number, source: string, viewId: string): void {
    if (
      !viewId ||
      !this.view.slots.some(
        (slot) =>
          slot.index === index &&
          slot.localSrc === source &&
          slot.viewId === viewId,
      )
    )
      return;
    const generation = this.generation,
      file = generation?.files.get(index);
    generation?.files.delete(index);
    this.publish({
      ...this.view,
      slots: this.view.slots.map((slot) =>
        slot.index === index
          ? { ...slot, localSrc: '', status: 'unavailable' }
          : slot,
      ),
    });
    if (file)
      this.trackRelease(
        this.transfer?.release(file).catch(() => undefined) ??
          Promise.resolve(),
      );
  }
  retry(index: number): Promise<void> {
    const generation = this.generation;
    if (
      !generation ||
      !this.view.slots.some(
        (slot) => slot.index === index && slot.status === 'unavailable',
      )
    )
      return Promise.resolve();
    const key = `retry:${index}`;
    if (this.operation)
      return this.operation.key === key
        ? this.operation.promise
        : Promise.resolve();
    const promise = this.readSlot(
      generation,
      this.descriptors[index]!,
      index,
      this.view.expanded,
    ).catch((error: unknown) => {
      if (this.generation !== generation) return;
      if (this.authorityFailure(error)) {
        this.clear();
        this.publish({ ...initialGalleryView(), status: 'unavailable' });
      } else this.failSlot(index);
    });
    this.trackOperation(promise);
    this.operation = { key, promise };
    void promise.then(() => {
      if (this.operation?.promise === promise) this.operation = null;
    });
    return promise;
  }
  clear(): void {
    this.operation = null;
    this.descriptors = [];
    this.descriptorTicket = null;
    this.beforeRead = undefined;
    void this.invalidate();
  }
  /** Includes late outputs from the retiring generation as well as its leases. */
  clearAndWait(): Promise<void> {
    this.clear();
    return Promise.all([this.releasing, this.settling]).then(() => undefined);
  }
  hide(): void {
    this.clear();
  }
  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.stopPrivate();
    this.clear();
  }
  private start(index: number, expanded: boolean): Promise<void> {
    const key = `${expanded ? 'display' : 'window'}:${index}`;
    if (this.operation?.key === key) return this.operation.promise;
    const promise = this.run(index, expanded);
    this.trackOperation(promise);
    this.operation = { key, promise };
    void promise.then(
      () => {
        if (this.operation?.promise === promise) this.operation = null;
      },
      () => {
        if (this.operation?.promise === promise) this.operation = null;
      },
    );
    return promise;
  }
  private async run(index: number, expanded: boolean): Promise<void> {
    const descriptors = this.descriptors;
    const descriptorTicket = this.descriptorTicket;
    const beforeRead = this.beforeRead;
    // Revoke all UI sources synchronously and await releases before reserving display bytes.
    const released = this.invalidate();
    if (!descriptorTicket || this.disposed || !descriptors.length) return;
    try {
      this.sessions.assertCurrent(descriptorTicket);
    } catch {
      this.clear();
      return;
    }
    const ticket = this.sessions.snapshot();
    const generation: Generation = {
      ticket,
      owner: {},
      files: new Map(),
      cancel: new Cancellation(),
      session: {
        current: () => {
          this.sessions.assertCurrent(ticket);
          if (
            this.generation !== generation ||
            generation.cancel.isCancelled ||
            this.disposed
          )
            throw new ClientError('cancelled', 'Gallery superseded');
          return this.sessions.snapshot();
        },
      },
    };
    this.generation = generation;
    const indices = expanded
      ? [index]
      : Array.from(
          { length: Math.min(3, descriptors.length - index) },
          (_, n) => index + n,
        );
    this.publish({
      total: descriptors.length,
      start: index,
      selected: index,
      expanded,
      status: 'loading',
      slots: indices.map((n) => ({
        index: n,
        viewId: '',
        status: 'loading',
        localSrc: '',
      })),
    });
    try {
      await Promise.all([released, beforeRead]);
      generation.session.current();
      if (!ticket.credentials || !this.transfer)
        throw new ClientError('configuration', 'Gallery unavailable');
      // Sequential reads also work with the shared two-transfer budget and require
      // no unbounded queue of native operations. The UI window contains <=3 leases.
      for (const n of indices) {
        try {
          await this.readSlot(generation, descriptors[n]!, n, expanded);
        } catch (error) {
          if (this.generation !== generation) return;
          if (this.authorityFailure(error)) throw error;
          this.failSlot(n);
        }
      }
      generation.session.current();
      this.publish({
        ...this.view,
        status: this.view.slots.some((slot) => slot.status === 'ready')
          ? 'ready'
          : 'unavailable',
      });
    } catch {
      if (this.generation !== generation) return;
      this.clear();
      this.publish({ ...initialGalleryView(), status: 'unavailable' });
    }
  }
  private authorityFailure(error: unknown): boolean {
    // Only a known local/transport failure is safely isolated to one image. An
    // authority denial, malformed proof, unknown server code or unknown error
    // revokes the entire parent gallery until a fresh parent read.
    return (
      !(error instanceof ClientError) ||
      !['network', 'timeout', 'storage'].includes(error.kind) ||
      error.details.serverCode !== undefined
    );
  }
  private failSlot(index: number): void {
    const generation = this.generation,
      file = generation?.files.get(index);
    generation?.files.delete(index);
    this.publish({
      ...this.view,
      slots: this.view.slots.map((slot) =>
        slot.index === index
          ? { ...slot, localSrc: '', status: 'unavailable' }
          : slot,
      ),
    });
    if (file)
      this.trackRelease(
        this.transfer?.release(file).catch(() => undefined) ??
          Promise.resolve(),
      );
  }
  private async readSlot(
    generation: Generation,
    descriptor: MediaAttachment,
    index: number,
    expanded: boolean,
  ): Promise<void> {
    generation.session.current();
    if (!this.transfer)
      throw new ClientError('configuration', 'Gallery unavailable');
    const viewId = String(++this.viewSequence);
    this.publish({
      ...this.view,
      slots: this.view.slots.map((slot) =>
        slot.index === index
          ? { ...slot, viewId, status: 'loading', localSrc: '' }
          : slot,
      ),
    });
    const file = await this.transfer.download(
      descriptor,
      expanded ? 'display-v1' : 'thumb-v1',
      generation.owner,
      generation.session,
      generation.cancel,
    );
    try {
      generation.session.current();
    } catch (error) {
      await this.trackRelease(this.transfer.release(file));
      throw error;
    }
    generation.files.set(index, file);
    const localSrc = await this.transfer.resolve(
      file,
      generation.owner,
      generation.session.current(),
    );
    generation.session.current();
    this.publish({
      ...this.view,
      status: 'ready',
      slots: this.view.slots.map((slot) =>
        slot.index === index
          ? { index, viewId, localSrc, status: 'ready' }
          : slot,
      ),
    });
  }
  private trackOperation(operation: Promise<void>): void {
    this.settling = Promise.all([
      this.settling,
      operation.catch(() => undefined),
    ]).then(() => undefined);
  }
  private trackRelease(release: Promise<void>): Promise<void> {
    this.releasing = Promise.all([this.releasing, release]).then(
      () => undefined,
    );
    return this.releasing;
  }
  private invalidate(): Promise<void> {
    const old = this.generation;
    this.generation = null;
    let release: Promise<void> = Promise.resolve();
    try {
      this.publish(initialGalleryView());
    } finally {
      if (old) {
        old.cancel.cancel();
        const files = [...old.files.values()];
        old.files.clear();
        release = Promise.all(
          files.map((file) =>
            this.transfer?.release(file).catch(() => undefined),
          ),
        ).then(() => undefined);
      }
    }
    return this.trackRelease(release);
  }
  private publish(view: GalleryView): void {
    this.view = Object.freeze(view);
    this.render(this.view);
  }
}
