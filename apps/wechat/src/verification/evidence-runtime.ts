import type { ApiClient } from '../api/client';
import { ClientError, clientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import type { SessionStore } from '../auth/session';
import { Cancellation } from '../platform/contracts';
import type { Clock, Storage } from '../platform/contracts';
import type { WxUploadApi, UploadFiles } from '../platform/wechat-upload';
import type { WxMediaApi } from '../platform/wechat-media';
import { MediaLocalFiles } from '../media/local-files';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import { HttpVerificationEvidenceGateway } from './evidence-gateway';
import { VerificationEvidenceUpload } from './evidence-upload';
import {
  VerificationEvidenceDownload,
  VerificationEvidencePrincipalOwner,
} from './evidence-download';
import type { VerificationEvidenceReadTarget } from './evidence-download';
import {
  VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
  decodeVerificationEvidencePrepare,
  verificationEvidencePrepareHash,
  evidenceUploadDescriptor,
} from './evidence-contract';
import type {
  VerificationEvidenceStatus,
  VerificationEvidenceUploadDescriptor,
} from './evidence-contract';
import {
  verificationEvidenceUuid,
  verificationEvidenceRevision,
} from './evidence-validation';
import { VerificationEvidencePending } from './evidence-pending';
import type { PendingVerificationEvidence } from './evidence-pending';
export interface VerificationEvidenceUploadTarget {
  applicationId: string;
  revision: number;
}
export type VerificationEvidencePreviewTarget =
  VerificationEvidenceReadTarget & { revision: number; bindingId?: string };
export interface VerificationEvidenceUploadView {
  status: 'idle' | 'working' | 'ready' | 'unavailable';
  message: string;
  progress: number;
}
export interface VerificationEvidenceReadView {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  src: string;
  message: string;
}
export interface VerificationEvidenceRuntimeOptions {
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
const terminal = (s: VerificationEvidenceStatus) =>
  s.status === 'terminal' || s.status === 'bound_history';
async function closeOriginal(
  record: PendingVerificationEvidence,
  pending: VerificationEvidencePending,
  gateway: HttpVerificationEvidenceGateway,
  session: MediaSession,
  cancel: Cancellation,
) {
  const result = await gateway.cancelRequest(
    record.requestId,
    record.requestHash,
    session,
    cancel,
  );
  session.current();
  if (
    result.state === 'cancelled_before_prepare' ||
    (result.state === 'recorded' && terminal(result.status))
  )
    pending.clear(record);
}
export class VerificationEvidenceUploader {
  private cancellation: Cancellation | null = null;
  private selected: LocalMediaFile | null = null;
  private generation = 0;
  private active = false;
  private disposed = false;
  private ownerEpoch: number | null = null;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly pending: VerificationEvidencePending,
    private readonly gateway: HttpVerificationEvidenceGateway,
    private readonly upload: VerificationEvidenceUpload,
    private readonly newRequestId: () => Promise<string>,
    private readonly render: (view: VerificationEvidenceUploadView) => void,
  ) {
    this.unsubscribe = sessions.subscribe(() => {
      if (
        this.ownerEpoch !== null &&
        sessions.snapshot().epoch !== this.ownerEpoch
      )
        this.clear();
    });
  }
  pick(target: VerificationEvidenceUploadTarget) {
    return this.run(target, true);
  }
  recover(target: VerificationEvidenceUploadTarget) {
    return this.run(target, false);
  }
  private async run(
    target: VerificationEvidenceUploadTarget,
    pick: boolean,
  ): Promise<VerificationEvidenceUploadDescriptor | null> {
    if (this.active || this.disposed) return null;
    verificationEvidenceUuid(target.applicationId);
    verificationEvidenceRevision(target.revision);
    const ticket = this.sessions.snapshot(),
      actor = ticket.credentials?.accountId;
    if (!actor) {
      this.publish({
        status: 'unavailable',
        message: '请先登录认证申请账号',
        progress: 0,
      });
      return null;
    }
    const cancel = new Cancellation(),
      generation = ++this.generation;
    this.cancellation = cancel;
    this.ownerEpoch = ticket.epoch;
    this.active = true;
    const session: MediaSession = {
      current: () => {
        this.sessions.assertCurrent(ticket);
        if (
          cancel.isCancelled ||
          this.disposed ||
          generation !== this.generation
        )
          throw new ClientError('cancelled', '认证材料操作已关闭');
        return this.sessions.snapshot();
      },
    };
    const show = (message: string, progress = 0) => {
      session.current();
      this.publish({ status: 'working', message, progress });
    };
    try {
      // Recover the entire current account, including old applications/scopes.
      // Historical closure needs no current campus/management grant and cannot
      // silently discard a request whose network outcome remains uncertain.
      for (const old of this.pending.readAll(actor))
        if (
          old.applicationId !== target.applicationId ||
          old.revision !== target.revision
        )
          await closeOriginal(old, this.pending, this.gateway, session, cancel);
      let record = this.pending.read(actor, target),
        status: VerificationEvidenceStatus | null = null;
      if (record) {
        show('恢复原材料上传');
        const recovered = await this.gateway.recover(
          record.requestId,
          session,
          cancel,
        );
        session.current();
        if (
          recovered.requestHash !== null &&
          recovered.requestHash !== record.requestHash
        )
          throw new ClientError('protocol', '原材料请求不匹配');
        if (recovered.state === 'recorded' && !terminal(recovered.status))
          status = recovered.status;
        else if (recovered.state === 'not_recorded') {
          await closeOriginal(
            record,
            this.pending,
            this.gateway,
            session,
            cancel,
          );
          record = null;
        } else {
          this.pending.clear(record);
          record = null;
        }
      }
      if (!record) {
        if (!pick) {
          this.publish({
            status: 'idle',
            message: '没有待恢复的材料上传',
            progress: 0,
          });
          return null;
        }
        show('选择一张能判断学校归属的校园卡或录取通知书图片，可遮盖无关信息');
        this.selected = await this.upload.pick(session, cancel);
        const declaration = await this.upload.inspect(
            this.selected,
            session,
            cancel,
          ),
          clientRequestId = await this.newRequestId();
        session.current();
        const input = decodeVerificationEvidencePrepare({
          protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
          clientRequestId,
          ...target,
          declaration,
        });
        record = {
          actor,
          applicationId: target.applicationId,
          revision: target.revision,
          requestId: clientRequestId,
          requestHash: verificationEvidencePrepareHash(actor, input),
        };
        this.pending.write(record);
        show('准备私有材料上传');
        status = await this.gateway.prepare(input, session, cancel);
      }
      if (!status || status.requestHash !== record.requestHash)
        throw new ClientError('protocol', '原材料请求不匹配');
      if (status.status === 'prepared' && status.upload === 'none') {
        const grant = await this.gateway.grant(
          status.intentId,
          session,
          cancel,
        );
        if (!this.selected) {
          show('请重新选择原来同一张材料图片');
          this.selected = await this.upload.pick(session, cancel);
        }
        show('上传认证材料');
        const effect = await this.upload.upload(
          grant,
          this.selected,
          session,
          cancel,
          (p) => show('上传认证材料', p),
        );
        await effect.result;
        session.current();
        status = await this.gateway.finalize(status.intentId, session, cancel);
      } else if (status.status === 'uploaded')
        status = await this.gateway.finalize(status.intentId, session, cancel);
      session.current();
      if (status.status === 'ready_unbound') {
        this.publish({
          status: 'ready',
          message: '材料已就绪，可提交审核',
          progress: 100,
        });
        return evidenceUploadDescriptor(status.assetId);
      }
      if (terminal(status)) this.pending.clear(record);
      this.publish({
        status: 'unavailable',
        progress: 0,
        message:
          status.status === 'processing' || status.status === 'prepared'
            ? '材料处理中，请稍后恢复原上传'
            : status.status === 'terminal'
              ? '材料未通过或已过期，请重新选择'
              : status.status === 'bound_history'
                ? '此材料已用于申请，请刷新申请状态'
                : '材料暂不可用，原请求已保留',
      });
      return null;
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
      if (this.cancellation === cancel) this.cancellation = null;
      const file = this.selected;
      this.selected = null;
      if (file) void this.upload.remove(file).catch(() => undefined);
    }
  }
  async cancelPending(
    target?: VerificationEvidenceUploadTarget,
  ): Promise<void> {
    if (this.disposed) return;
    this.clear();
    const ticket = this.sessions.snapshot(),
      actor = ticket.credentials?.accountId;
    if (!actor) return;
    const generation = this.generation,
      cancel = new Cancellation();
    this.cancellation = cancel;
    this.ownerEpoch = ticket.epoch;
    const session: MediaSession = {
      current: () => {
        this.sessions.assertCurrent(ticket);
        if (
          this.disposed ||
          cancel.isCancelled ||
          this.generation !== generation
        )
          throw new ClientError('cancelled', '材料撤回已中断，原请求保留');
        return this.sessions.snapshot();
      },
    };
    try {
      for (const record of this.pending.readAll(actor))
        if (
          !target ||
          (record.applicationId === target.applicationId &&
            record.revision === target.revision)
        )
          await closeOriginal(
            record,
            this.pending,
            this.gateway,
            session,
            cancel,
          );
    } finally {
      if (this.cancellation === cancel) this.cancellation = null;
    }
  }
  clear() {
    this.generation++;
    const cancel = this.cancellation,
      file = this.selected;
    this.cancellation = null;
    this.selected = null;
    this.ownerEpoch = null;
    cancel?.cancel();
    this.publish({ status: 'idle', message: '', progress: 0 });
    if (file) void this.upload.remove(file).catch(() => undefined);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.unsubscribe();
  }
  private publish(view: VerificationEvidenceUploadView) {
    try {
      this.render(view);
    } catch {
      /* Rendering cannot hold native writer resources. */
    }
  }
}
export class VerificationEvidenceReader {
  private disposed = false;
  private cancellation: Cancellation | null = null;
  private file: LocalMediaFile | null = null;
  private generation = 0;
  private readonly owner = {};
  private readonly unsubscribe: () => void;
  private stopExpiry = () => undefined as void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly principals: VerificationEvidencePrincipalOwner,
    private readonly gateway: HttpVerificationEvidenceGateway,
    private readonly download: VerificationEvidenceDownload,
    private readonly clock: Clock,
    private readonly render: (view: VerificationEvidenceReadView) => void,
  ) {
    this.unsubscribe = principals.subscribe(() => this.clear());
  }
  async load(target: VerificationEvidencePreviewTarget): Promise<void> {
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
            throw new ClientError('cancelled', '认证材料预览已撤回');
          this.principals.assertCurrent(principal);
          return this.sessions.snapshot();
        },
      };
    this.publish({ status: 'loading', src: '', message: '加载当前认证材料' });
    let file: LocalMediaFile | null = null;
    try {
      if (principal.kind !== 'session')
        throw new ClientError('auth-required', '请先登录查看认证材料');
      const descriptor = await this.gateway.descriptor(
        target,
        target.revision,
        session,
        cancel,
      );
      session.current();
      if (
        target.bindingId !== undefined &&
        descriptor.bindingId !== target.bindingId
      )
        throw new ClientError('protocol', '认证材料版本已变化');
      file = await this.download.download(
        {
          descriptor,
          target: {
            applicationId: target.applicationId,
            reviewRegionId: target.reviewRegionId,
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
      // Local display authority is short-lived too. Never keep an old private evidence image on screen
      // indefinitely after its current server configuration may have changed.
      this.stopExpiry = this.clock.schedule(() => {
        this.clear();
        this.publish({
          status: 'idle',
          src: '',
          message: '认证材料预览已关闭，请重新查看当前版本',
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
  private publish(view: VerificationEvidenceReadView): void {
    try {
      this.render(view);
    } catch {
      /* A broken renderer cannot retain media authority. */
    }
  }
}
export function createVerificationEvidenceRuntime(
  options: VerificationEvidenceRuntimeOptions,
) {
  const gateway = new HttpVerificationEvidenceGateway(options.api),
    pending = new VerificationEvidencePending(options.storage, options.origin),
    principals = new VerificationEvidencePrincipalOwner(options.sessions);
  const upload = new VerificationEvidenceUpload(
      options.origin,
      options.wx,
      options.files,
      options.registry,
      options.sessions,
      options.clock,
    ),
    download = new VerificationEvidenceDownload(
      options.origin,
      options.wx,
      options.files,
      options.registry,
      principals,
      options.auth,
      options.clock,
    );
  const uploaders = new Set<VerificationEvidenceUploader>(),
    readers = new Set<VerificationEvidenceReader>();
  return {
    pendingTargets: (): readonly VerificationEvidenceUploadTarget[] => {
      const actor = options.sessions.snapshot().credentials?.accountId;
      return actor
        ? pending.readAll(actor).map((v) => ({
            applicationId: v.applicationId,
            revision: v.revision,
          }))
        : [];
    },
    /** Explicit recovery for all requests of the signed-in account. Set
     * cancelUnbound to close stale drafts even after campus/scope authority changed. */
    reconcile: async (cancelUnbound = false) => {
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
      for (const record of pending.readAll(actor)) {
        const result = await gateway.recover(record.requestId, session, cancel);
        session.current();
        if (
          result.requestHash !== null &&
          result.requestHash !== record.requestHash
        )
          throw new ClientError('protocol', '原材料请求不匹配');
        if (
          result.state === 'cancelled_before_prepare' ||
          (result.state === 'recorded' && terminal(result.status))
        )
          pending.clear(record);
        else if (cancelUnbound || result.state === 'not_recorded')
          await closeOriginal(record, pending, gateway, session, cancel);
      }
    },
    createUploader: (
      render: (view: VerificationEvidenceUploadView) => void,
    ) => {
      const value = new VerificationEvidenceUploader(
        options.sessions,
        pending,
        gateway,
        upload,
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
    createReader: (render: (view: VerificationEvidenceReadView) => void) => {
      const value = new VerificationEvidenceReader(
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
    clear: () => {
      for (const value of uploaders) value.clear();
      for (const value of readers) value.clear();
    },
    dispose: () => {
      for (const value of [...uploaders]) value.dispose();
      for (const value of [...readers]) value.dispose();
      principals.dispose();
    },
  };
}
