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
import { MediaLocalFiles } from '../media/local-files';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import { HttpSchoolQrMediaGateway } from './qr-gateway';
import { SchoolQrUpload } from './qr-upload';
import { SchoolQrDownload, SchoolQrPrincipalOwner } from './qr-download';
import type { SchoolQrReadTarget } from './qr-download';
import {
  SCHOOL_QR_MEDIA_PROTOCOL,
  decodeSchoolQrPrepare,
  schoolQrPrepareHash,
} from './qr-contract';
import type { SchoolQrPrepare, SchoolQrStatus } from './qr-contract';
import { schoolUuid, schoolKey, schoolRevision } from './contract';
import type { SchoolEntryKey } from './contract';
export interface SchoolQrUploadTarget {
  regionId: string;
  entryKey: SchoolEntryKey;
  expectedRevision: number;
}
export type SchoolQrPreviewTarget = SchoolQrReadTarget & {
  entryKey: SchoolEntryKey;
  entryRevision: number;
};
export interface SchoolQrUploadView {
  status: 'idle' | 'working' | 'ready' | 'unavailable';
  message: string;
  progress: number;
}
export interface SchoolQrReadView {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  src: string;
  message: string;
}
export interface SchoolQrRuntimeOptions {
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
  input: SchoolQrPrepare;
  hash: string;
}
function sameTarget(input: SchoolQrPrepare, target: SchoolQrUploadTarget) {
  return (
    input.regionId === target.regionId &&
    input.entryKey === target.entryKey &&
    input.expectedRevision === target.expectedRevision
  );
}
/** A bounded original-key journal contains no bytes, paths, bearer or credentials. */
class SchoolQrPending {
  private readonly prefix: string;
  constructor(
    private readonly storage: Storage,
    origin: string,
  ) {
    this.prefix = `whaleu.school-qr.v1.${sha256(normalizeOrigin(origin))}.`;
  }
  read(actor: string): Pending | null {
    const raw = this.storage.get(this.prefix + schoolUuid(actor));
    if (raw === null || raw === undefined || raw === '') return null;
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('actor' in raw) ||
      raw.actor !== actor ||
      !('input' in raw) ||
      !('hash' in raw) ||
      Object.keys(raw).length !== 3
    )
      throw new ClientError('storage', '二维码上传恢复记录损坏');
    const input = decodeSchoolQrPrepare(raw.input),
      hash = schoolQrPrepareHash(actor, input);
    if (raw.hash !== hash)
      throw new ClientError('storage', '二维码上传恢复记录损坏');
    return { actor, input, hash };
  }
  write(value: Pending) {
    this.storage.set(
      this.prefix + schoolUuid(value.actor),
      JSON.parse(JSON.stringify(value)),
    );
    const saved = this.read(value.actor);
    if (!saved || saved.hash !== value.hash)
      throw new ClientError('storage', '无法保存二维码恢复记录');
  }
  clear(value: Pending) {
    if (this.read(value.actor)?.hash === value.hash) {
      this.storage.remove(this.prefix + value.actor);
      if (this.read(value.actor)?.hash === value.hash)
        throw new ClientError('storage', '无法清除二维码恢复记录');
    }
  }
}
export class SchoolQrUploader {
  private cancel: Cancellation | null = null;
  private selected: LocalMediaFile | null = null;
  private generation = 0;
  private disposed = false;
  private active = false;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly pending: SchoolQrPending,
    private readonly gateway: HttpSchoolQrMediaGateway,
    private readonly upload: SchoolQrUpload,
    private readonly clock: Clock,
    private readonly newRequestId: () => Promise<string>,
    private readonly render: (view: SchoolQrUploadView) => void,
  ) {
    this.unsubscribe = sessions.subscribe(() => {
      const current = sessions.snapshot();
      if (this.ownerEpoch !== null && current.epoch !== this.ownerEpoch)
        this.clear();
    });
  }
  private ownerEpoch: number | null = null;
  pick(target: SchoolQrUploadTarget): Promise<string | null> {
    return this.run(target, true);
  }
  recover(target: SchoolQrUploadTarget): Promise<string | null> {
    return this.run(target, false);
  }
  private async run(
    target: SchoolQrUploadTarget,
    pick: boolean,
  ): Promise<string | null> {
    if (this.active || this.disposed) return null;
    schoolUuid(target.regionId);
    schoolKey(target.entryKey);
    schoolRevision(target.expectedRevision);
    const ticket = this.sessions.snapshot(),
      actor = ticket.credentials?.accountId;
    if (!actor) {
      this.publish({
        status: 'unavailable',
        message: '请先登录管理员账号',
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
          throw new ClientError('cancelled', '二维码操作已撤回');
        return this.sessions.snapshot();
      },
    };
    const show = (message: string, progress = 0) => {
      session.current();
      this.publish({ status: 'working', message, progress });
    };
    try {
      show('检查原上传记录');
      let record = this.pending.read(actor),
        status: SchoolQrStatus | null = null;
      if (record) {
        const recovered = await this.gateway.recover(
          record.input.clientRequestId,
          session,
          cancel,
        );
        if (recovered.state === 'recorded') {
          if (recovered.requestHash !== record.hash)
            throw new ClientError('protocol', '二维码原请求不匹配');
          if (['bound_history', 'terminal'].includes(recovered.status.status)) {
            this.pending.clear(record);
            record = null;
          } else status = recovered.status;
        } else if (recovered.state === 'cancelled_before_prepare') {
          this.pending.clear(record);
          record = null;
        } else if (!pick)
          throw new ClientError(
            'business',
            '原上传尚未登记，请重新选择原图片或撤回',
          );
        else
          throw new ClientError('business', '原上传结果未确认，请先撤回后重选');
        if (record && !sameTarget(record.input, target))
          throw new ClientError(
            'business',
            '请先撤回之前学校或栏目的二维码上传',
          );
      }
      if (!record) {
        if (!pick) {
          this.publish({
            status: 'idle',
            message: '没有待恢复的二维码上传',
            progress: 0,
          });
          return null;
        }
        show('选择二维码图片');
        this.selected = await this.upload.pick(session, cancel);
        const declaration = await this.upload.inspect(
            this.selected,
            session,
            cancel,
          ),
          clientRequestId = await this.newRequestId();
        session.current();
        const input = decodeSchoolQrPrepare({
          protocol: SCHOOL_QR_MEDIA_PROTOCOL,
          clientRequestId,
          ...target,
          declaration,
        });
        record = { actor, input, hash: schoolQrPrepareHash(actor, input) };
        this.pending.write(record);
        show('准备上传');
        status = await this.gateway.prepare(input, session, cancel);
      }
      if (!status) throw new ClientError('business', '二维码需要原请求恢复');
      if (status.requestHash !== record.hash)
        throw new ClientError('protocol', '二维码原请求不匹配');
      if (status.status === 'prepared' && status.upload === 'none') {
        if (!this.selected)
          throw new ClientError('business', '原图片未保留，请撤回后重新选择');
        show('上传二维码');
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
          (progress) => show('上传二维码', progress),
        );
        await effect.result;
        session.current();
        status = await this.gateway.finalize(status.intentId, session, cancel);
      } else if (status.status === 'uploaded')
        status = await this.gateway.finalize(status.intentId, session, cancel);
      while (status.status === 'processing' || status.status === 'prepared') {
        if (status.operationDeadlineAt <= status.serverNow)
          throw new ClientError('business', '二维码上传已过期，请撤回后重选');
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
          message: '二维码已就绪，保存后发布',
          progress: 100,
        });
        return status.assetId;
      }
      if (status.status === 'terminal' || status.status === 'bound_history')
        this.pending.clear(record);
      throw new ClientError(
        'business',
        status.status === 'bound_history'
          ? '此二维码已有发布记录，请刷新配置'
          : status.status === 'terminal'
            ? '二维码未通过或已撤回，请重新选择'
            : '图片服务暂不可用，保留原请求以便恢复',
      );
    } catch (error) {
      if (
        !cancel.isCancelled &&
        !this.disposed &&
        generation === this.generation
      )
        this.publish({
          status: 'unavailable',
          message: clientError(error).message,
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
  async cancelPending(): Promise<void> {
    const ticket = this.sessions.snapshot(),
      actor = ticket.credentials?.accountId;
    if (!actor) return;
    const record = this.pending.read(actor);
    if (!record) return;
    const session: MediaSession = {
        current: () => {
          this.sessions.assertCurrent(ticket);
          return this.sessions.snapshot();
        },
      },
      cancel = new Cancellation();
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
  private publish(view: SchoolQrUploadView): void {
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
        reject(new ClientError('cancelled', '二维码操作已撤回'));
      });
    });
  }
}
export class SchoolQrReader {
  private disposed = false;
  private cancellation: Cancellation | null = null;
  private file: LocalMediaFile | null = null;
  private generation = 0;
  private readonly owner = {};
  private readonly unsubscribe: () => void;
  private stopExpiry = () => undefined as void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly principals: SchoolQrPrincipalOwner,
    private readonly gateway: HttpSchoolQrMediaGateway,
    private readonly download: SchoolQrDownload,
    private readonly clock: Clock,
    private readonly render: (view: SchoolQrReadView) => void,
  ) {
    this.unsubscribe = principals.subscribe(() => this.clear());
  }
  async load(target: SchoolQrPreviewTarget): Promise<void> {
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
            throw new ClientError('cancelled', '二维码预览已撤回');
          this.principals.assertCurrent(principal);
          return this.sessions.snapshot();
        },
      };
    this.publish({ status: 'loading', src: '', message: '加载当前二维码' });
    let file: LocalMediaFile | null = null;
    try {
      const descriptor = await this.gateway.descriptor(
        target,
        target.entryKey,
        target.entryRevision,
        session,
        cancel,
      );
      session.current();
      file = await this.download.download(
        {
          descriptor,
          target:
            'campusId' in target
              ? { campusId: target.campusId }
              : { regionId: target.regionId },
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
      // Local display authority is short-lived too. Never keep an old QR on screen
      // indefinitely after its current server configuration may have changed.
      this.stopExpiry = this.clock.schedule(() => {
        this.clear();
        this.publish({
          status: 'idle',
          src: '',
          message: '二维码预览已关闭，请重新查看当前版本',
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
  private publish(view: SchoolQrReadView): void {
    try {
      this.render(view);
    } catch {
      /* A broken renderer cannot retain media authority. */
    }
  }
}
export function createSchoolQrRuntime(options: SchoolQrRuntimeOptions) {
  const gateway = new HttpSchoolQrMediaGateway(options.api),
    pending = new SchoolQrPending(options.storage, options.origin),
    principals = new SchoolQrPrincipalOwner(options.sessions);
  const upload = new SchoolQrUpload(
      options.origin,
      options.wx,
      options.files,
      options.registry,
      options.sessions,
      options.clock,
    ),
    download = new SchoolQrDownload(
      options.origin,
      options.wx,
      options.files,
      options.registry,
      principals,
      options.auth,
      options.clock,
    );
  const readers = new Set<SchoolQrReader>(),
    uploaders = new Set<SchoolQrUploader>();
  return {
    createUploader: (render: (view: SchoolQrUploadView) => void) => {
      const value = new SchoolQrUploader(
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
    createReader: (render: (view: SchoolQrReadView) => void) => {
      const value = new SchoolQrReader(
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
export type SchoolQrRuntime = ReturnType<typeof createSchoolQrRuntime>;
