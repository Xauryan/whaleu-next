import { sha256 } from 'js-sha256';
import type { ApiClient } from '../api/client';
import { ClientError, clientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import type { AuthService } from '../auth/auth-service';
import type { SessionStore } from '../auth/session';
import { Cancellation } from '../platform/contracts';
import type { Clock, Storage } from '../platform/contracts';
import type { WxUploadApi, UploadFiles } from '../platform/wechat-upload';
import type { WxMediaApi } from '../platform/wechat-media';
import { MediaLocalFiles } from './local-files';
import type { LocalMediaFile, MediaSession } from './contracts';
import { HttpAnnouncementMediaGateway } from './announcement-gateway';
import { AnnouncementMediaUpload } from './announcement-upload';
import {
  AnnouncementMediaDownload,
  AnnouncementMediaPrincipalOwner,
} from './announcement-download';
import type { AnnouncementMediaReadTarget } from './announcement-download';
import {
  ANNOUNCEMENT_MEDIA_PROTOCOL,
  decodeAnnouncementMediaPrepare,
  announcementMediaPrepareHash,
} from './announcement-contract';
import type {
  AnnouncementMediaPrepare,
  AnnouncementMediaStatus,
} from './announcement-contract';
import {
  announcementMediaUuid,
  announcementMediaSlot,
  announcementMediaRevision,
} from './announcement-validation';
import type { AnnouncementMediaSlot } from './announcement-validation';
export interface AnnouncementMediaUploadTarget {
  announcementId: string;
  slot: AnnouncementMediaSlot;
  revision: number;
}
export type AnnouncementMediaPreviewTarget = AnnouncementMediaReadTarget & {
  slot: AnnouncementMediaSlot;
  revision: number;
  bindingId?: string;
};
export interface AnnouncementMediaUploadView {
  status: 'idle' | 'working' | 'ready' | 'unavailable';
  message: string;
  progress: number;
}
export interface AnnouncementMediaReadView {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  src: string;
  message: string;
}
export interface AnnouncementMediaRuntimeOptions {
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
interface Pending {
  actor: string;
  input: AnnouncementMediaPrepare;
  hash: string;
}
function sameTarget(
  input: AnnouncementMediaPrepare,
  target: AnnouncementMediaUploadTarget,
) {
  return (
    input.announcementId === target.announcementId &&
    input.slot === target.slot &&
    input.revision === target.revision
  );
}
/** A bounded original-key journal contains no bytes, paths, bearer or credentials. */
class AnnouncementMediaPending {
  private readonly prefix: string;
  constructor(
    private readonly storage: Storage,
    origin: string,
  ) {
    this.prefix = `whaleu.announcement-media.v1.${sha256(normalizeOrigin(origin))}.`;
  }
  readAll(actor: string): Pending[] {
    const raw = this.storage.get(this.prefix + announcementMediaUuid(actor));
    if (raw === null || raw === undefined || raw === '') return [];
    if (!Array.isArray(raw) || raw.length > 20)
      throw new ClientError('storage', '公告图片恢复记录损坏');
    const seen = new Set<string>();
    return raw.map((entry: unknown) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !('actor' in entry) ||
        entry.actor !== actor ||
        !('input' in entry) ||
        !('hash' in entry) ||
        Object.keys(entry).length !== 3
      )
        throw new ClientError('storage', '公告图片恢复记录损坏');
      const input = decodeAnnouncementMediaPrepare(entry.input),
        hash = announcementMediaPrepareHash(actor, input),
        key = `${input.announcementId}:${input.revision}:${input.slot}`;
      if (entry.hash !== hash || seen.has(key))
        throw new ClientError('storage', '公告图片恢复记录损坏');
      seen.add(key);
      return { actor, input, hash };
    });
  }
  read(actor: string, target: AnnouncementMediaUploadTarget): Pending | null {
    return this.readAll(actor).find((v) => sameTarget(v.input, target)) ?? null;
  }
  write(value: Pending) {
    const entries = this.readAll(value.actor),
      existing = entries.find((v) => sameTarget(v.input, value.input));
    if (existing && existing.hash !== value.hash)
      throw new ClientError('storage', '请先撤回原公告图片请求');
    const next = entries.filter((v) => !sameTarget(v.input, value.input));
    if (next.length >= 20)
      throw new ClientError(
        'storage',
        '待恢复图片过多，请先恢复或撤回公告图片',
      );
    next.push(value);
    this.storage.set(
      this.prefix + announcementMediaUuid(value.actor),
      JSON.parse(JSON.stringify(next)),
    );
    if (this.read(value.actor, value.input)?.hash !== value.hash)
      throw new ClientError('storage', '无法保存公告图片恢复记录');
  }
  clear(value: Pending) {
    const entries = this.readAll(value.actor);
    if (!entries.some((v) => v.hash === value.hash)) return;
    const next = entries.filter((v) => v.hash !== value.hash);
    if (next.length)
      this.storage.set(
        this.prefix + value.actor,
        JSON.parse(JSON.stringify(next)),
      );
    else this.storage.remove(this.prefix + value.actor);
    if (this.read(value.actor, value.input)?.hash === value.hash)
      throw new ClientError('storage', '无法清除公告图片恢复记录');
  }
}
export class AnnouncementMediaUploader {
  private cancel: Cancellation | null = null;
  private selected: LocalMediaFile | null = null;
  private generation = 0;
  private disposed = false;
  private active = false;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly pending: AnnouncementMediaPending,
    private readonly gateway: HttpAnnouncementMediaGateway,
    private readonly upload: AnnouncementMediaUpload,
    private readonly clock: Clock,
    private readonly newRequestId: () => Promise<string>,
    private readonly render: (view: AnnouncementMediaUploadView) => void,
  ) {
    this.unsubscribe = sessions.subscribe(() => {
      const current = sessions.snapshot();
      if (this.ownerEpoch !== null && current.epoch !== this.ownerEpoch)
        this.clear();
    });
  }
  private ownerEpoch: number | null = null;
  pick(target: AnnouncementMediaUploadTarget): Promise<string | null> {
    return this.run(target, true);
  }
  recover(target: AnnouncementMediaUploadTarget): Promise<string | null> {
    return this.run(target, false);
  }
  private async run(
    target: AnnouncementMediaUploadTarget,
    pick: boolean,
  ): Promise<string | null> {
    if (this.active || this.disposed) return null;
    announcementMediaUuid(target.announcementId);
    announcementMediaSlot(target.slot);
    announcementMediaRevision(target.revision);
    const ticket = this.sessions.snapshot(),
      actor = ticket.credentials?.accountId;
    if (!actor) {
      this.publish({
        status: 'unavailable',
        message: '请先登录公告发布账号',
        progress: 0,
      });
      return null;
    }
    this.active = true;
    this.ownerEpoch = ticket.epoch;
    const generation = ++this.generation,
      cancel = new Cancellation();
    this.cancel = cancel;
    const session: MediaSession = {
      current: () => {
        this.sessions.assertCurrent(ticket);
        if (
          cancel.isCancelled ||
          this.disposed ||
          generation !== this.generation
        )
          throw new ClientError('cancelled', '公告图片操作已撤回');
        return this.sessions.snapshot();
      },
    };
    const show = (message: string, progress = 0) => {
      session.current();
      this.publish({ status: 'working', message, progress });
    };
    const selectOriginal = async (record: Pending) => {
      show('恢复原上传，请重新选择同一张图片');
      this.selected = await this.upload.pick(session, cancel);
      const declaration = await this.upload.inspect(
        this.selected,
        session,
        cancel,
      );
      session.current();
      const original = record.input.declaration;
      if (
        declaration.mime !== original.mime ||
        declaration.bytes !== original.bytes ||
        declaration.sha256 !== original.sha256
      )
        throw new ClientError(
          'business',
          '所选图片与原上传不一致，请选择原图；如需更换，请先撤回原请求',
        );
    };
    try {
      show('检查原上传记录');
      let record = this.pending.read(actor, target),
        status: AnnouncementMediaStatus | null = null;
      if (record) {
        const recovered = await this.gateway.recover(
          record.input.clientRequestId,
          session,
          cancel,
        );
        if (recovered.state === 'recorded') {
          if (recovered.requestHash !== record.hash)
            throw new ClientError('protocol', '公告图片原请求不匹配');
          if (['bound_history', 'terminal'].includes(recovered.status.status)) {
            this.pending.clear(record);
            record = null;
          } else status = recovered.status;
        } else if (recovered.state === 'cancelled_before_prepare') {
          this.pending.clear(record);
          record = null;
        } else {
          // An explicit user retry may repeat an unrecorded prepare only with
          // the same declaration and original key. A new picker never changes
          // the journal's identity, even after a quota or uncertain response.
          await selectOriginal(record);
          show('使用原请求恢复上传');
          status = await this.gateway.prepare(record.input, session, cancel);
        }
        if (record && !sameTarget(record.input, target))
          throw new ClientError(
            'business',
            '请先撤回之前公告或图片栏位的公告图片上传',
          );
      }
      if (!record) {
        if (!pick) {
          this.publish({
            status: 'idle',
            message: '没有待恢复的公告图片上传',
            progress: 0,
          });
          return null;
        }
        show('选择公告图片');
        this.selected = await this.upload.pick(session, cancel);
        const declaration = await this.upload.inspect(
            this.selected,
            session,
            cancel,
          ),
          clientRequestId = await this.newRequestId();
        session.current();
        const input = decodeAnnouncementMediaPrepare({
          protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
          clientRequestId,
          ...target,
          declaration,
        });
        record = {
          actor,
          input,
          hash: announcementMediaPrepareHash(actor, input),
        };
        this.pending.write(record);
        show('准备上传');
        status = await this.gateway.prepare(input, session, cancel);
      }
      if (!status) throw new ClientError('business', '公告图片需要原请求恢复');
      if (status.requestHash !== record.hash)
        throw new ClientError('protocol', '公告图片原请求不匹配');
      if (status.status === 'prepared' && status.upload === 'none') {
        if (!this.selected) await selectOriginal(record);
        if (!this.selected)
          throw new ClientError('business', '请重新选择原图片以恢复上传');
        show('上传公告图片');
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
          (progress) => show('上传公告图片', progress),
        );
        await effect.result;
        session.current();
        status = await this.gateway.finalize(status.intentId, session, cancel);
      } else if (status.status === 'uploaded')
        status = await this.gateway.finalize(status.intentId, session, cancel);
      while (status.status === 'processing' || status.status === 'prepared') {
        if (status.operationDeadlineAt <= status.serverNow)
          throw new ClientError('business', '公告图片上传已过期，请撤回后重选');
        show('等待图片处理和审核');
        await this.delay(
          status.status === 'processing' ? status.retryAfterMs : 1000,
          cancel,
        );
        session.current();
        status = await this.gateway.status(status.intentId, session, cancel);
      }
      session.current();
      if (status.status === 'ready_unbound') {
        this.publish({
          status: 'ready',
          message: '公告图片已就绪，可保存草稿',
          progress: 100,
        });
        return status.assetId;
      }
      if (status.status === 'terminal' || status.status === 'bound_history')
        this.pending.clear(record);
      throw new ClientError(
        'business',
        status.status === 'bound_history'
          ? '此公告图片已有发布记录，请刷新配置'
          : status.status === 'terminal'
            ? '公告图片未通过或已撤回，请重新选择'
            : '图片服务暂不可用，保留原请求以便恢复',
      );
    } catch (error) {
      const failure = clientError(error),
        quota =
          failure.details.httpStatus === 429 &&
          (failure.details.serverCode === 'MEDIA_RATE_LIMITED' ||
            failure.details.serverCode === 'RATE_LIMITED'),
        retry = failure.details.retryAfterSeconds;
      if (
        !cancel.isCancelled &&
        !this.disposed &&
        generation === this.generation
      )
        this.publish({
          status: 'unavailable',
          message: quota
            ? retry !== undefined
              ? `上传频率或额度受限，最早 ${retry} 秒后恢复原上传并重选同一图片；原请求已保留`
              : '上传频率或额度受限，请约 1 分钟后恢复原上传；若达到每日额度，需等下一 UTC 日。原请求已保留'
            : failure.message,
          progress: 0,
        });
      return null;
    } finally {
      this.active = false;
      if (this.cancel === cancel) this.cancel = null;
      const file = this.selected;
      this.selected = null;
      if (file) void this.upload.remove(file).catch(() => undefined);
    }
  }
  async cancelPending(target: AnnouncementMediaUploadTarget): Promise<void> {
    if (this.disposed) return;
    this.clear();
    const ticket = this.sessions.snapshot(),
      actor = ticket.credentials?.accountId;
    if (!actor) return;
    const record = this.pending.read(actor, target);
    if (!record) return;
    const generation = this.generation,
      cancel = new Cancellation();
    this.cancel = cancel;
    this.ownerEpoch = ticket.epoch;
    const session: MediaSession = {
      current: () => {
        if (
          this.disposed ||
          cancel.isCancelled ||
          generation !== this.generation
        )
          throw new ClientError('cancelled', '公告图片撤回已中断，原请求保留');
        this.sessions.assertCurrent(ticket);
        return this.sessions.snapshot();
      },
    };
    try {
      const result = await this.gateway.cancelRequest(
        record.input.clientRequestId,
        record.hash,
        session,
        cancel,
      );
      session.current();
      if (
        result.state === 'cancelled_before_prepare' ||
        (result.state === 'recorded' &&
          ['terminal', 'bound_history'].includes(result.status.status))
      )
        this.pending.clear(record);
    } finally {
      if (this.cancel === cancel) this.cancel = null;
    }
  }
  clear(): void {
    this.generation++;
    const cancel = this.cancel,
      file = this.selected;
    this.cancel = null;
    this.selected = null;
    this.ownerEpoch = null;
    cancel?.cancel();
    try {
      this.publish({ status: 'idle', message: '', progress: 0 });
    } finally {
      if (file) void this.upload.remove(file).catch(() => undefined);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.clear();
    } finally {
      this.unsubscribe();
    }
  }
  private publish(view: AnnouncementMediaUploadView): void {
    try {
      this.render(view);
    } catch {
      /* Rendering must not interrupt native cancellation or journal recovery. */
    }
  }
  private delay(ms: number, cancel: Cancellation) {
    return new Promise<void>((resolve, reject) => {
      let stop = () => undefined as void;
      const unschedule = this.clock.schedule(() => {
        stop();
        resolve();
      }, ms);
      stop = cancel.subscribe(() => {
        unschedule();
        reject(new ClientError('cancelled', '公告图片操作已撤回'));
      });
    });
  }
}
export class AnnouncementMediaReader {
  private disposed = false;
  private cancellation: Cancellation | null = null;
  private file: LocalMediaFile | null = null;
  private generation = 0;
  private readonly owner = {};
  private readonly unsubscribe: () => void;
  private stopExpiry = () => undefined as void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly principals: AnnouncementMediaPrincipalOwner,
    private readonly gateway: HttpAnnouncementMediaGateway,
    private readonly download: AnnouncementMediaDownload,
    private readonly clock: Clock,
    private readonly render: (view: AnnouncementMediaReadView) => void,
  ) {
    this.unsubscribe = principals.subscribe(() => this.clear());
  }
  async load(target: AnnouncementMediaPreviewTarget): Promise<void> {
    if (this.disposed) return;
    this.clear();
    const generation = this.generation,
      cancel = new Cancellation();
    this.cancellation = cancel;
    const principal = this.principals.snapshot(),
      session: MediaSession = {
        current: () => {
          if (
            this.disposed ||
            generation !== this.generation ||
            cancel.isCancelled
          )
            throw new ClientError('cancelled', '公告图片预览已撤回');
          this.principals.assertCurrent(principal);
          return this.sessions.snapshot();
        },
      };
    this.publish({ status: 'loading', src: '', message: '加载当前公告图片' });
    let file: LocalMediaFile | null = null;
    try {
      if (target.audience === 'management' && principal.kind !== 'session')
        throw new ClientError('auth-required', '请先登录查看公告图片');
      const descriptor = await this.gateway.descriptor(
        target,
        target.slot,
        target.revision,
        session,
        cancel,
      );
      session.current();
      if (
        target.bindingId !== undefined &&
        descriptor.bindingId !== target.bindingId
      )
        throw new ClientError('protocol', '公告图片版本已变化');
      file = await this.download.download(
        {
          descriptor,
          target: {
            announcementId: target.announcementId,
            audience: target.audience,
            campusId: target.campusId,
          },
        },
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
      this.publish({ status: 'ready', src, message: '' });
      // Local display authority is short-lived too. Never keep an old announcement image on screen
      // indefinitely after its current server configuration may have changed.
      this.stopExpiry = this.clock.schedule(() => {
        this.clear();
        this.publish({
          status: 'idle',
          src: '',
          message: '公告图片预览已关闭，请重新查看当前版本',
        });
      }, 30000);
    } catch (error) {
      if (generation === this.generation && !cancel.isCancelled)
        this.publish({
          status: 'unavailable',
          src: '',
          message: clientError(error).message,
        });
    } finally {
      if (file) void this.download.release(file).catch(() => undefined);
    }
  }
  clear(): void {
    this.generation++;
    const cancel = this.cancellation,
      file = this.file,
      stopExpiry = this.stopExpiry;
    this.cancellation = null;
    this.file = null;
    this.stopExpiry = () => undefined;
    cancel?.cancel();
    stopExpiry();
    try {
      this.publish({ status: 'idle', src: '', message: '' });
    } finally {
      if (file) void this.download.release(file).catch(() => undefined);
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.clear();
    } finally {
      this.unsubscribe();
    }
  }
  private publish(view: AnnouncementMediaReadView): void {
    try {
      this.render(view);
    } catch {
      /* A broken renderer cannot retain media authority. */
    }
  }
}
export function createAnnouncementMediaRuntime(
  options: AnnouncementMediaRuntimeOptions,
) {
  const gateway = new HttpAnnouncementMediaGateway(options.api),
    pending = new AnnouncementMediaPending(options.storage, options.origin),
    principals = new AnnouncementMediaPrincipalOwner(options.sessions);
  const upload = new AnnouncementMediaUpload(
      options.origin,
      options.wx,
      options.files,
      options.registry,
      options.sessions,
      options.clock,
    ),
    download = new AnnouncementMediaDownload(
      options.origin,
      options.wx,
      options.files,
      options.registry,
      principals,
      options.auth,
      options.clock,
    );
  const readers = new Set<AnnouncementMediaReader>(),
    uploaders = new Set<AnnouncementMediaUploader>();
  return {
    pendingTargets: (
      announcementId?: string,
    ): readonly AnnouncementMediaUploadTarget[] => {
      const actor = options.sessions.snapshot().credentials?.accountId;
      if (!actor) return [];
      return pending
        .readAll(actor)
        .filter(
          (v) =>
            announcementId === undefined ||
            v.input.announcementId === announcementId,
        )
        .map(({ input }) => ({
          announcementId: input.announcementId,
          slot: input.slot,
          revision: input.revision,
        }));
    },
    reconcile: async (announcementId: string): Promise<void> => {
      announcementMediaUuid(announcementId);
      const ticket = options.sessions.snapshot(),
        actor = ticket.credentials?.accountId;
      if (!actor) return;
      const cancel = new Cancellation(),
        session: MediaSession = {
          current: () => {
            options.sessions.assertCurrent(ticket);
            return options.sessions.snapshot();
          },
        };
      for (const record of pending
        .readAll(actor)
        .filter((v) => v.input.announcementId === announcementId)) {
        const result = await gateway.recover(
          record.input.clientRequestId,
          session,
          cancel,
        );
        session.current();
        if (result.requestHash !== null && result.requestHash !== record.hash)
          throw new ClientError('protocol', '公告图片原请求不匹配');
        if (
          result.state === 'cancelled_before_prepare' ||
          (result.state === 'recorded' &&
            ['terminal', 'bound_history'].includes(result.status.status))
        )
          pending.clear(record);
      }
    },
    createUploader: (render: (view: AnnouncementMediaUploadView) => void) => {
      const value = new AnnouncementMediaUploader(
        options.sessions,
        pending,
        gateway,
        upload,
        options.clock,
        options.newRequestId,
        render,
      );
      uploaders.add(value);
      const dispose = value.dispose.bind(value);
      value.dispose = () => {
        uploaders.delete(value);
        dispose();
      };
      return value;
    },
    createReader: (render: (view: AnnouncementMediaReadView) => void) => {
      const value = new AnnouncementMediaReader(
        options.sessions,
        principals,
        gateway,
        download,
        options.clock,
        render,
      );
      readers.add(value);
      const load = value.load.bind(value);
      value.load = (target) => {
        for (const other of readers) if (other !== value) other.clear();
        return load(target);
      };
      const dispose = value.dispose.bind(value);
      value.dispose = () => {
        readers.delete(value);
        dispose();
      };
      return value;
    },
    hide: () => {
      for (const value of readers) value.clear();
      for (const value of uploaders) value.clear();
    },
    invalidate: () => {
      for (const value of readers) value.clear();
    },
  };
}
export type AnnouncementMediaRuntime = ReturnType<
  typeof createAnnouncementMediaRuntime
>;
