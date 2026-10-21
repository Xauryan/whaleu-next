import type { ApiClient } from '../api/client';
import { ClientError, clientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import type { SessionStore } from '../auth/session';
import { Cancellation, type Clock, type Storage } from '../platform/contracts';
import type { WxUploadApi, UploadFiles } from '../platform/wechat-upload';
import type { WxMediaApi } from '../platform/wechat-media';
import type { MediaLocalFiles } from '../media/local-files';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import { cancellable } from '../platform/cancellable';
import { HttpWindowDiscussionMediaGateway } from './media-gateway';
import { WindowDiscussionMediaUpload } from './media-upload';
import {
  WindowDiscussionMediaDownload,
  WindowDiscussionMediaPrincipalOwner,
} from './media-download';
import {
  WINDOW_DISCUSSION_MEDIA_PROTOCOL,
  decodeWindowDiscussionMediaPrepare,
  decodeWindowDiscussionImageReference,
  windowDiscussionMediaPrepareHash,
  type WindowDiscussionImageReference,
  type WindowDiscussionMediaStatus,
} from './media-contract';
import { HttpWindowDiscussionV2Gateway } from './v2-gateway';
import {
  PendingWindowDiscussionV2Store,
  type PendingWindowDiscussionV2,
} from './v2-pending';
import {
  computeDiscussionV2IntentHash,
  matchDiscussionV2Receipt,
  decodeDiscussionV2Intent,
  type DiscussionV2CancelTarget,
  type DiscussionV2Receipt,
} from './v2-contract';
import { windowDiscussionError } from './errors';
export interface WindowDiscussionComposition {
  readonly windowId: string;
  readonly catalogRevision: string;
  readonly windowRevision: string;
  readonly rootId: string | null;
  readonly replyToReplyId: string | null;
}
export interface WindowDiscussionImageView {
  readonly imageCount: number;
  readonly imageBusy: boolean;
  readonly imageFrozen: boolean;
  readonly imagePending: boolean;
  readonly imageStatus: string;
  readonly imageProgress: number;
  readonly imageRequestId: string;
  readonly imageRecoverable: boolean;
}
export const initialWindowDiscussionImageView =
  (): WindowDiscussionImageView => ({
    imageCount: 0,
    imageBusy: false,
    imageFrozen: false,
    imagePending: false,
    imageStatus: '',
    imageProgress: 0,
    imageRequestId: '',
    imageRecoverable: false,
  });
export interface WindowDiscussionGalleryView {
  readonly galleryOpen: boolean;
  readonly gallerySrc: string;
  readonly galleryStatus: string;
  readonly galleryIndex: number;
  readonly galleryCount: number;
}
export const initialWindowDiscussionGalleryView =
  (): WindowDiscussionGalleryView => ({
    galleryOpen: false,
    gallerySrc: '',
    galleryStatus: '',
    galleryIndex: 0,
    galleryCount: 0,
  });
export interface WindowDiscussionImageRuntimeOptions {
  api: ApiClient;
  sessions: SessionStore;
  storage: Storage;
  origin: string;
  clock: Clock;
  newRequestId: () => Promise<string>;
  wx: WxUploadApi & WxMediaApi;
  files: UploadFiles;
  registry: MediaLocalFiles;
  auth: Pick<AuthService, 'refresh'>;
}
const cancelled = () => new ClientError('cancelled', '窗口图片操作已关闭');
const notRecorded = (error: unknown) => {
  const f = clientError(error);
  return (
    f.kind !== 'protocol' &&
    f.details.httpStatus === 404 &&
    f.details.serverCode === 'REQUEST_NOT_FOUND'
  );
};
/** One owner-scoped operation at a time. Only metadata enters the journal.
 * An interrupted composition can recover/cancel its original keys, never silently
 * recreate text or promote an unrecorded upload into a new publication. */
export class WindowDiscussionImageComposer {
  private record: PendingWindowDiscussionV2 | null = null;
  private assets: { assetId: string; manifestDigest: string }[] = [];
  private active = false;
  private restoreAfterRun = false;
  private disposed = false;
  private generation = 0;
  private cancellation: Cancellation | null = null;
  private selected: LocalMediaFile | null = null;
  private picker = false;
  private pickerSuspended = false;
  private readonly foregroundListeners = new Set<() => void>();
  private ownerEpoch: number | null = null;
  private readonly unsubscribe: () => void;
  private view = initialWindowDiscussionImageView();
  constructor(
    private readonly options: WindowDiscussionImageRuntimeOptions,
    private readonly pending: PendingWindowDiscussionV2Store,
    private readonly gateway: HttpWindowDiscussionMediaGateway,
    private readonly publication: HttpWindowDiscussionV2Gateway,
    private readonly upload: WindowDiscussionMediaUpload,
    private readonly render: (view: WindowDiscussionImageView) => void,
  ) {
    this.unsubscribe = options.sessions.subscribe(() => {
      if (
        this.ownerEpoch !== null &&
        options.sessions.snapshot().epoch !== this.ownerEpoch
      )
        this.clear();
    });
  }
  get pickerActive(): boolean {
    return this.picker || this.pickerSuspended;
  }
  suspendPicker(): boolean {
    if (!this.pickerActive) return false;
    this.pickerSuspended = true;
    return true;
  }
  resumePicker(): void {
    this.pickerSuspended = false;
    for (const listener of this.foregroundListeners) listener();
    this.foregroundListeners.clear();
  }
  private foreground(cancel: Cancellation): Promise<void> {
    if (!this.pickerSuspended) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let stop = () => undefined as void;
      const timer = this.options.clock.schedule(() => {
        this.foregroundListeners.delete(done);
        stop();
        reject(cancelled());
      }, 120000);
      const done = () => {
        timer();
        stop();
        this.foregroundListeners.delete(done);
        resolve();
      };
      this.foregroundListeners.add(done);
      stop = cancel.subscribe(() => {
        timer();
        this.foregroundListeners.delete(done);
        reject(cancelled());
      });
    });
  }
  private show(patch: Partial<WindowDiscussionImageView>): void {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    try {
      this.render(this.view);
    } catch {
      /* Rendering cannot retain native authority. */
    }
  }
  restore(): void {
    if (this.disposed) return;
    if (this.active) {
      this.restoreAfterRun = true;
      return;
    }
    const owner = this.options.sessions.snapshot();
    this.ownerEpoch = owner.epoch;
    const actor = owner.credentials?.accountId;
    if (!actor) {
      this.clear();
      return;
    }
    try {
      const record = this.pending.load(actor);
      const same =
        !!record &&
        this.record?.target.clientRequestId === record.target.clientRequestId;
      this.record = record;
      if (!same) this.assets = [];
      const editable =
        !!record &&
        same &&
        record.phase === 'draft' &&
        record.uploadRecoveryKeys.length === this.assets.length;
      this.show({
        imageCount: this.assets.length,
        imagePending: !!record,
        imageFrozen: !!record && !editable,
        imageRecoverable: !!record,
        imageRequestId: record?.target.clientRequestId ?? '',
        imageStatus: record
          ? editable
            ? '图片已就绪，可继续添加或发表'
            : '原图片讨论请求待确认；请查询或取消原请求'
          : '',
      });
    } catch (error) {
      this.assets = [];
      this.show({
        imageCount: 0,
        imageFrozen: true,
        imagePending: true,
        imageRecoverable: false,
        imageStatus: windowDiscussionError(error),
      });
    }
  }
  private async run<T>(
    work: (session: MediaSession, cancel: Cancellation) => Promise<T>,
  ): Promise<T | null> {
    if (this.active || this.disposed) return null;
    const ticket = this.options.sessions.snapshot();
    if (!ticket.credentials) {
      this.show({ imageStatus: '请先登录后添加窗口图片' });
      return null;
    }
    this.ownerEpoch = ticket.epoch;
    this.active = true;
    const generation = ++this.generation,
      cancel = new Cancellation();
    this.cancellation = cancel;
    const session: MediaSession = {
      current: () => {
        this.options.sessions.assertCurrent(ticket);
        if (this.record) this.pending.assertOriginal(this.record);
        if (
          this.disposed ||
          cancel.isCancelled ||
          generation !== this.generation
        )
          throw cancelled();
        return this.options.sessions.snapshot();
      },
    };
    this.show({ imageBusy: true });
    try {
      return await work(session, cancel);
    } catch (error) {
      if (generation === this.generation && !cancel.isCancelled)
        this.show({
          imageStatus: windowDiscussionError(error),
          imageFrozen: !!this.record || clientError(error).kind === 'storage',
          imagePending: !!this.record || clientError(error).kind === 'storage',
          imageRecoverable: !!this.record,
        });
      return null;
    } finally {
      this.active = false;
      this.picker = false;
      this.pickerSuspended = false;
      if (this.cancellation === cancel) this.cancellation = null;
      const file = this.selected;
      this.selected = null;
      if (file) void this.upload.remove(file).catch(() => undefined);
      if (generation === this.generation) this.show({ imageBusy: false });
      if (this.restoreAfterRun && !this.disposed) {
        this.restoreAfterRun = false;
        this.restore();
      }
    }
  }
  private async draft(
    context: WindowDiscussionComposition,
    session: MediaSession,
  ): Promise<PendingWindowDiscussionV2> {
    const actor = session.current().credentials!.accountId;
    const saved = this.pending.load(actor);
    if (saved) {
      const t = saved.target;
      if (
        !this.record ||
        saved.target.clientRequestId !== this.record.target.clientRequestId ||
        saved.phase !== 'draft' ||
        saved.uploadRecoveryKeys.length !== this.assets.length ||
        t.windowId !== context.windowId ||
        t.expectedCatalogRevision !== context.catalogRevision ||
        t.expectedWindowRevision !== context.windowRevision ||
        ('rootId' in t ? t.rootId : null) !== context.rootId ||
        ('replyToReplyId' in t ? t.replyToReplyId : null) !==
          context.replyToReplyId
      )
        throw new ClientError('storage', '请先恢复或取消原图片讨论请求');
      this.pending.assertOriginal(saved);
      return saved;
    }
    const clientRequestId = await this.options.newRequestId();
    session.current();
    const base = {
      protocol: 'window-discussion-v2' as const,
      windowId: context.windowId,
      clientRequestId,
      expectedCatalogRevision: context.catalogRevision,
      expectedWindowRevision: context.windowRevision,
    };
    const target: DiscussionV2CancelTarget = context.rootId
      ? {
          ...base,
          operation: 'window.discussion.reply.v2',
          rootId: context.rootId,
          replyToReplyId: context.replyToReplyId,
        }
      : { ...base, operation: 'window.discussion.root.v2' };
    this.record = this.pending.freeze({
      version: 2,
      accountId: actor,
      origin: this.pending.origin,
      target,
      phase: 'draft',
      intentHash: null,
      uploadRecoveryKeys: [],
    });
    this.show({
      imagePending: true,
      imageRequestId: clientRequestId,
      imageRecoverable: true,
    });
    return this.record;
  }
  async pick(
    context: WindowDiscussionComposition,
    source: 'album' | 'camera' = 'album',
  ): Promise<void> {
    if (this.view.imageFrozen || this.assets.length >= 3) return;
    await this.run(async (session, cancel) => {
      // Read the journal before even opening the picker. Failed readback never uploads.
      const existing = this.pending.load(
        session.current().credentials!.accountId,
      );
      if (
        existing &&
        (!this.record ||
          existing.target.clientRequestId !==
            this.record.target.clientRequestId)
      )
        throw new ClientError('storage', '请先恢复或取消原图片讨论请求');
      this.show({ imageStatus: '选择 JPEG 或 PNG 图片（每张最多 5 MiB）' });
      this.picker = true;
      try {
        this.selected = await this.upload.pick(session, cancel, source);
      } finally {
        this.picker = false;
      }
      await this.foreground(cancel);
      session.current();
      const declaration = await this.upload.inspect(
        this.selected,
        session,
        cancel,
      );
      session.current();
      let record = await this.draft(context, session);
      const requestId = await this.options.newRequestId();
      session.current();
      const input = decodeWindowDiscussionMediaPrepare({
        protocol: WINDOW_DISCUSSION_MEDIA_PROTOCOL,
        clientRequestId: requestId,
        publicationRequestId: record.target.clientRequestId,
        windowId: context.windowId,
        catalogRevision: context.catalogRevision,
        windowRevision: context.windowRevision,
        rootId: context.rootId,
        replyToReplyId: context.replyToReplyId,
        ordinal: this.assets.length,
        declaration,
      });
      const hash = windowDiscussionMediaPrepareHash(record.accountId, input);
      record = this.pending.appendUpload(record, {
        requestId,
        requestHash: hash,
      });
      this.record = record;
      this.pending.assertOriginal(record);
      session.current();
      this.show({
        imageStatus: `上传第 ${this.assets.length + 1} 张图片`,
        imageFrozen: true,
        imageProgress: 0,
      });
      let status = await this.gateway.prepare(input, session, cancel);
      if (status.status === 'prepared' && status.upload === 'none') {
        this.pending.assertOriginal(record);
        const grant = await this.gateway.grant(
          status.intentId,
          session,
          cancel,
        );
        const effect = await this.upload.upload(
          grant,
          this.selected,
          session,
          cancel,
          (progress) => this.show({ imageProgress: progress }),
        );
        await effect.result;
        session.current();
        // A success response may precede native complete; shared credit and local
        // bytes remain owned until the transport's quiet fence is observed.
        await cancellable(effect.complete, cancel);
        session.current();
        status = await this.gateway.finalize(status.intentId, session, cancel);
      } else if (status.status === 'uploaded')
        status = await this.gateway.finalize(status.intentId, session, cancel);
      while (status.status === 'processing' || status.status === 'prepared') {
        if (status.operationDeadlineAt <= status.serverNow)
          throw new ClientError('business', '图片上传已过期，请取消原请求');
        this.show({ imageStatus: '正在处理并审核图片' });
        await this.delay(
          status.status === 'processing' ? status.retryAfterMs : 1000,
          cancel,
        );
        session.current();
        status = await this.gateway.status(status.intentId, session, cancel);
      }
      this.checkStatus(record, hash, requestId, status);
      session.current();
      if (status.status !== 'ready_unbound')
        throw new ClientError('business', '图片尚未就绪，请恢复或取消原请求');
      this.assets.push({
        assetId: status.assetId,
        manifestDigest: status.manifestDigest,
      });
      this.show({
        imageCount: this.assets.length,
        imageFrozen: false,
        imageProgress: 100,
        imageStatus: `${this.assets.length} / 3 张图片已就绪，顺序按添加顺序`,
      });
    });
  }
  private checkStatus(
    record: PendingWindowDiscussionV2,
    hash: string,
    requestId: string,
    status: WindowDiscussionMediaStatus,
  ): void {
    this.pending.assertOriginal(record);
    if (status.requestId !== requestId || status.requestHash !== hash)
      throw new ClientError('protocol', '窗口图片原请求不匹配');
  }
  async publish(
    context: WindowDiscussionComposition,
    body: string,
  ): Promise<DiscussionV2Receipt | null> {
    if (this.view.imageFrozen) return null;
    return this.run(async (session, cancel) => {
      let record = await this.draft(context, session);
      const t = record.target;
      const intent = decodeDiscussionV2Intent({
        operation: t.operation,
        windowId: t.windowId,
        ...('rootId' in t ? { rootId: t.rootId } : {}),
        command: {
          protocol: 'window-discussion-v2',
          clientRequestId: t.clientRequestId,
          expectedCatalogRevision: t.expectedCatalogRevision,
          expectedWindowRevision: t.expectedWindowRevision,
          body,
          images: this.assets,
          ...('replyToReplyId' in t
            ? { replyToReplyId: t.replyToReplyId }
            : {}),
        },
      });
      record = this.pending.beginSubmission(
        record,
        computeDiscussionV2IntentHash(record.accountId, intent),
      );
      this.record = record;
      this.pending.assertOriginal(record);
      session.current();
      this.show({ imageFrozen: true, imageStatus: '正在发表原图片讨论请求' });
      const receipt = await this.publication.submit(intent, cancel);
      session.current();
      await this.settleUploads(record, receipt, session, cancel);
      this.pending.settle(record, receipt);
      this.record = null;
      this.assets = [];
      this.show({
        ...initialWindowDiscussionImageView(),
        imageBusy: true,
        imageStatus:
          receipt.outcome === 'applied'
            ? '原讨论请求已确认发表；当前内容需重新核验'
            : '原请求已确认未写入',
      });
      return receipt;
    });
  }
  async recover(): Promise<DiscussionV2Receipt | null> {
    this.restore();
    if (!this.record) return null;
    return this.run(async (session, cancel) => {
      const record = this.record!;
      this.pending.assertOriginal(record);
      try {
        const receipt = await this.publication.receipt(
          record.target.clientRequestId,
          cancel,
        );
        session.current();
        matchDiscussionV2Receipt(record.target, receipt);
        await this.settleUploads(record, receipt, session, cancel);
        this.pending.settle(record, receipt);
        this.record = null;
        this.assets = [];
        this.show({
          ...initialWindowDiscussionImageView(),
          imageBusy: true,
          imageStatus: '原请求回执已确认；当前内容需重新读取',
        });
        return receipt;
      } catch (error) {
        if (!notRecorded(error)) throw error;
        for (const key of record.uploadRecoveryKeys) {
          const result = await this.gateway.recover(
            key.requestId,
            session,
            cancel,
          );
          if (
            result.state !== 'not_recorded' &&
            result.requestHash !== key.requestHash
          )
            throw new ClientError('protocol', '窗口图片原请求不匹配');
          session.current();
        }
        this.show({
          imageFrozen: true,
          imageStatus:
            '暂未记录原发表回执。原请求编号仍保留，请继续查询或明确取消；不会自动创建新请求。',
        });
        return null;
      }
    });
  }
  private async settleUploads(
    record: PendingWindowDiscussionV2,
    receipt: DiscussionV2Receipt,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<void> {
    if (receipt.outcome === 'applied') return;
    for (const key of record.uploadRecoveryKeys) {
      const result = await this.gateway.cancelRequest(
        key.requestId,
        key.requestHash,
        record.target.windowId,
        record.target.clientRequestId,
        session,
        cancel,
      );
      if (
        result.state === 'recorded' &&
        !['terminal', 'bound_history'].includes(result.status.status)
      )
        throw new ClientError(
          'business',
          '原图片清理尚待确认，请继续查询原请求',
        );
    }
  }
  async cancelOriginal(): Promise<DiscussionV2Receipt | null> {
    this.restore();
    if (!this.record) return null;
    return this.run(async (session, cancel) => {
      let record = this.record!;
      this.pending.assertOriginal(record);
      record = this.pending.beginCancellation(record);
      this.record = record;
      // The publication fence comes first, preventing any late publish from
      // binding an upload while those original upload keys are being cancelled.
      const receipt = await this.publication.cancel(
        record.target,
        cancel,
        record.intentHash,
      );
      session.current();
      for (const key of receipt.outcome === 'applied'
        ? []
        : record.uploadRecoveryKeys) {
        const r = await this.gateway.cancelRequest(
          key.requestId,
          key.requestHash,
          record.target.windowId,
          record.target.clientRequestId,
          session,
          cancel,
        );
        if (
          r.state === 'recorded' &&
          !['terminal', 'bound_history'].includes(r.status.status)
        )
          throw new ClientError(
            'business',
            '原图片取消尚待确认，请重试原取消请求',
          );
      }
      this.pending.settle(record, receipt);
      this.record = null;
      this.assets = [];
      this.show({
        ...initialWindowDiscussionImageView(),
        imageBusy: true,
        imageStatus:
          receipt.outcome === 'applied'
            ? '原请求已经发表，请重新读取当前内容'
            : '服务端已取消原请求，可以重新选择图片',
      });
      return receipt;
    });
  }
  private delay(ms: number, cancel: Cancellation): Promise<void> {
    return new Promise((resolve, reject) => {
      let stop = () => undefined as void;
      const unschedule = this.options.clock.schedule(() => {
        stop();
        resolve();
      }, ms);
      stop = cancel.subscribe(() => {
        unschedule();
        reject(cancelled());
      });
    });
  }
  clear(): void {
    this.restoreAfterRun = false;
    this.generation++;
    this.cancellation?.cancel();
    this.cancellation = null;
    this.picker = false;
    this.pickerSuspended = false;
    this.foregroundListeners.clear();
    this.assets = [];
    this.record = null;
    this.ownerEpoch = null;
    const file = this.selected;
    this.selected = null;
    if (file) void this.upload.remove(file).catch(() => undefined);
    this.show(initialWindowDiscussionImageView());
  }
  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.unsubscribe();
  }
}
/** Controlled in-page gallery. One current local handle, fresh descriptor per
 * navigation, no native previewImage and no DTO-supplied URL authority. */
export class WindowDiscussionImageGallery {
  private refs: readonly WindowDiscussionImageReference[] = [];
  private index = 0;
  private generation = 0;
  private cancellation: Cancellation | null = null;
  private file: LocalMediaFile | null = null;
  private disposed = false;
  private readonly owner = {};
  private stopExpiry = () => undefined as void;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly options: WindowDiscussionImageRuntimeOptions,
    private readonly principals: WindowDiscussionMediaPrincipalOwner,
    private readonly gateway: HttpWindowDiscussionMediaGateway,
    private readonly download: WindowDiscussionMediaDownload,
    private readonly render: (view: WindowDiscussionGalleryView) => void,
  ) {
    this.unsubscribe = principals.subscribe(() => this.clear());
  }
  private show(view: WindowDiscussionGalleryView): void {
    if (!this.disposed)
      try {
        this.render(view);
      } catch {
        /* Rendering cannot retain media authority. */
      }
  }
  async open(
    refs: readonly WindowDiscussionImageReference[],
    index = 0,
  ): Promise<void> {
    if (
      this.disposed ||
      !refs.length ||
      refs.length > 3 ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= refs.length
    )
      return;
    const current = refs.map(decodeWindowDiscussionImageReference);
    if (
      current.some(
        (ref, ordinal) =>
          ref.windowId !== current[0]!.windowId ||
          ref.commentId !== current[0]!.commentId ||
          ref.ordinal !== ordinal,
      ) ||
      new Set(current.map((ref) => ref.bindingId)).size !== current.length
    )
      throw new ClientError('protocol', '窗口讨论图片序列无效');
    this.clear();
    this.refs = Object.freeze(current);
    this.index = index;
    await this.load();
  }
  async move(delta: number): Promise<void> {
    const next = this.index + delta;
    if (
      this.disposed ||
      !Number.isInteger(next) ||
      next < 0 ||
      next >= this.refs.length
    )
      return;
    this.closeFile();
    this.index = next;
    await this.load();
  }
  private async load(): Promise<void> {
    const refs = this.refs,
      index = this.index,
      ref = refs[index];
    if (!ref) return;
    const generation = this.generation,
      cancel = new Cancellation(),
      principal = this.principals.snapshot();
    this.cancellation = cancel;
    const session: MediaSession = {
      current: () => {
        if (
          this.disposed ||
          generation !== this.generation ||
          cancel.isCancelled
        )
          throw cancelled();
        this.principals.assertCurrent(principal);
        if (principal.kind !== 'session')
          throw new ClientError('auth-required', '请先登录查看图片');
        return this.options.sessions.snapshot();
      },
    };
    this.show({
      galleryOpen: true,
      gallerySrc: '',
      galleryStatus: '正在核验当前图片',
      galleryIndex: index,
      galleryCount: refs.length,
    });
    let file: LocalMediaFile | null = null;
    try {
      session.current();
      const descriptor = await this.gateway.descriptor(ref, session, cancel);
      session.current();
      file = await this.download.download(
        descriptor,
        'display-v1',
        this.owner,
        {
          current: () => {
            session.current();
            return this.principals.snapshot();
          },
        },
        cancel,
      );
      session.current();
      const src = await this.download.resolve(file, this.owner, principal);
      session.current();
      this.file = file;
      file = null;
      this.show({
        galleryOpen: true,
        gallerySrc: src,
        galleryStatus: '',
        galleryIndex: index,
        galleryCount: refs.length,
      });
      this.stopExpiry = this.options.clock.schedule(() => this.clear(), 30000);
    } catch (error) {
      if (generation === this.generation && !cancel.isCancelled)
        this.show({
          galleryOpen: true,
          gallerySrc: '',
          galleryStatus: windowDiscussionError(error),
          galleryIndex: index,
          galleryCount: refs.length,
        });
    } finally {
      if (file) void this.download.release(file).catch(() => undefined);
    }
  }
  private closeFile(): void {
    this.generation++;
    this.cancellation?.cancel();
    this.cancellation = null;
    this.stopExpiry();
    this.stopExpiry = () => undefined;
    const file = this.file;
    this.file = null;
    if (file) void this.download.release(file).catch(() => undefined);
  }
  clear(): void {
    this.closeFile();
    this.refs = [];
    this.index = 0;
    this.show(initialWindowDiscussionGalleryView());
  }
  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.unsubscribe();
    this.disposed = true;
  }
}
export function createWindowDiscussionImageRuntime(
  options: WindowDiscussionImageRuntimeOptions,
) {
  const gateway = new HttpWindowDiscussionMediaGateway(options.api),
    publication = new HttpWindowDiscussionV2Gateway(options.api),
    pending = new PendingWindowDiscussionV2Store(
      options.storage,
      options.origin,
    ),
    principals = new WindowDiscussionMediaPrincipalOwner(options.sessions),
    upload = new WindowDiscussionMediaUpload(
      options.origin,
      options.wx,
      options.files,
      options.registry,
      options.sessions,
      options.clock,
    ),
    download = new WindowDiscussionMediaDownload(
      options.origin,
      options.wx,
      options.files,
      options.registry,
      principals,
      options.auth,
      options.clock,
    );
  const composers = new Set<WindowDiscussionImageComposer>(),
    galleries = new Set<WindowDiscussionImageGallery>();
  return {
    publication,
    pending,
    get pickerActive() {
      return [...composers].some((value) => value.pickerActive);
    },
    createComposer(render: (view: WindowDiscussionImageView) => void) {
      const value = new WindowDiscussionImageComposer(
        options,
        pending,
        gateway,
        publication,
        upload,
        render,
      );
      composers.add(value);
      const dispose = value.dispose.bind(value);
      value.dispose = () => {
        composers.delete(value);
        dispose();
      };
      return value;
    },
    createGallery(render: (view: WindowDiscussionGalleryView) => void) {
      const value = new WindowDiscussionImageGallery(
        options,
        principals,
        gateway,
        download,
        render,
      );
      galleries.add(value);
      const open = value.open.bind(value);
      value.open = (refs, index) => {
        for (const other of galleries) if (other !== value) other.clear();
        return open(refs, index);
      };
      const dispose = value.dispose.bind(value);
      value.dispose = () => {
        galleries.delete(value);
        dispose();
      };
      return value;
    },
    hide() {
      for (const value of galleries) value.clear();
      for (const value of composers) if (!value.suspendPicker()) value.clear();
    },
    invalidate() {
      for (const value of galleries) value.clear();
      for (const value of composers) value.clear();
    },
  };
}
export type WindowDiscussionImageRuntime = ReturnType<
  typeof createWindowDiscussionImageRuntime
>;
