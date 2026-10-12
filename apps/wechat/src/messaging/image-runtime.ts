import { ClientError, clientError } from '../api/errors';
import type { ApiClient } from '../api/client';
import type { AuthService } from '../auth/auth-service';
import type { SessionStore } from '../auth/session';
import type { Clock, Storage, Cancellation } from '../platform/contracts';
import type { WxUploadApi, UploadFiles } from '../platform/wechat-upload';
import type { WxMediaApi } from '../platform/wechat-media';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import { OwnerImageUpload } from '../media/owner-image-upload';
import { OwnerImageDownload } from '../media/owner-image-download';
import { OptionalMediaPrincipalOwner } from '../media/optional-principal';
import type { MediaLocalFiles } from '../media/local-files';
import { HttpPrivateMessageMediaGateway } from './image-gateway';
import {
  PendingPrivateMessageImages,
  type PendingImage,
} from './image-pending';
import {
  PRIVATE_MESSAGE_MEDIA_PROTOCOL,
  decodePrivateMessageMediaDescriptor,
  decodePrivateMessageMediaGrant,
  decodePrivateMessageMediaObserved,
  privateMessageMediaPrepareHash,
  type PrivateMessageMediaDescriptor,
  type PrivateMessageMediaStatus,
} from './image-contract';
import type { MessagingRuntime } from './runtime';
import type { Receipt } from './contract';
import { dispatch } from './commands';
export interface PrivateMessageImagesOptions {
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
export class PrivateMessageImages {
  readonly pending: PendingPrivateMessageImages;
  readonly gateway: HttpPrivateMessageMediaGateway;
  readonly upload: OwnerImageUpload<
    ReturnType<typeof decodePrivateMessageMediaGrant>,
    ReturnType<typeof decodePrivateMessageMediaObserved>
  >;
  private readonly principals: OptionalMediaPrincipalOwner;
  private readonly download: OwnerImageDownload<PrivateMessageMediaDescriptor>;
  constructor(private readonly options: PrivateMessageImagesOptions) {
    this.pending = new PendingPrivateMessageImages(
      options.storage,
      options.origin,
    );
    this.gateway = new HttpPrivateMessageMediaGateway(options.api);
    this.upload = new OwnerImageUpload(
      options.origin,
      options.wx,
      options.files,
      options.registry,
      options.sessions,
      options.clock,
      {
        decodeGrant: decodePrivateMessageMediaGrant,
        decodeObserved: decodePrivateMessageMediaObserved,
        path: (g) =>
          `/v3/media/private-messages/upload-intents/${g.intentId}/uploads/${g.grantId}`,
        matches: () => true,
      },
    );
    this.principals = new OptionalMediaPrincipalOwner(options.sessions);
    this.download = new OwnerImageDownload(
      options.origin,
      options.wx,
      options.files,
      options.registry,
      this.principals,
      options.auth,
      options.clock,
      {
        decode: decodePrivateMessageMediaDescriptor,
        shape: (d) => d,
        path: (d, v) =>
          `/v3/media/private-messages/conversations/${d.conversationId}/messages/${d.messageId}/bindings/${d.bindingId}/${v}`,
      },
    );
  }
  session(current: () => void): MediaSession {
    const original = this.options.sessions.snapshot();
    return {
      current: () => {
        current();
        this.options.sessions.assertCurrent(original);
        return this.options.sessions.snapshot();
      },
    };
  }
  async select(
    source: 'album' | 'camera',
    cancel: Cancellation,
    current: () => void,
  ) {
    return this.upload.pick(this.session(current), cancel, source);
  }
  async sendSelected(
    runtime: MessagingRuntime,
    conversationId: string,
    file: LocalMediaFile,
    cancel: Cancellation,
    current: () => void,
    progress: (text: string) => void,
  ): Promise<Receipt | null> {
    const session = this.session(current),
      actor = session.current().credentials?.accountId;
    if (!actor) throw new ClientError('auth-required', '请登录原账号');
    if (this.pending.load(actor) || runtime.pending.load(actor))
      throw new ClientError('business', '请先恢复或安全取消原请求');
    const declaration = await this.upload.inspect(file, session, cancel);
    current();
    const messageRequestId = await this.options.newRequestId(),
      uploadRequestId = await this.options.newRequestId();
    current();
    const input = {
      protocol: PRIVATE_MESSAGE_MEDIA_PROTOCOL,
      clientRequestId: uploadRequestId,
      conversationId,
      messageRequestId,
      declaration,
    };
    // Inspecting the local image and obtaining IDs yield to other pages. A text
    // command that became unresolved meanwhile keeps the sole command slot.
    if (runtime.pending.load(actor))
      throw new ClientError('storage', '请先恢复或安全取消原私信请求');
    const record = this.pending.freeze({
      accountId: actor,
      conversationId,
      messageRequestId,
      uploadRequestId,
      uploadHash: privateMessageMediaPrepareHash(actor, input),
    });
    progress('正在准备私密图片');
    let status = await this.gateway.prepare(input, session, cancel);
    current();
    if (status.status === 'prepared') {
      const grant = await this.gateway.grant(status.intentId, session, cancel);
      current();
      const effect = await this.upload.upload(
        grant,
        file,
        session,
        cancel,
        (n) => progress(`正在上传 ${n}%`),
      );
      await effect.result;
      await effect.complete;
      current();
      status = await this.gateway.finalize(status.intentId, session, cancel);
      current();
    }
    return this.publish(runtime, record, status, cancel, current, progress);
  }
  private async publish(
    runtime: MessagingRuntime,
    record: PendingImage,
    status: PrivateMessageMediaStatus,
    cancel: Cancellation,
    current: () => void,
    progress: (text: string) => void,
  ): Promise<Receipt | null> {
    this.assertRecord(record, this.session(current));
    this.command(runtime, record);
    this.check(record, status);
    if (status.status === 'uploaded') {
      status = await this.gateway.finalize(
        status.intentId,
        this.session(current),
        cancel,
      );
      current();
      this.check(record, status);
    }
    if (status.status === 'ready_unbound') {
      progress('图片已处理，正在等待内容审核并确认发送');
      const receipt = await dispatch(
        runtime,
        {
          operation: 'send_image',
          conversationId: record.conversationId,
          clientRequestId: record.messageRequestId,
          image: {
            assetId: status.assetId,
            manifestDigest: status.manifestDigest,
          },
        },
        cancel,
        current,
      );
      current();
      if (receipt.outcome === 'rejected') {
        // The immutable rejected command is the fence. Retire its unbound upload before freeing the journal.
        const recovery = await this.gateway.cancelRequest(
          record.uploadRequestId,
          record.uploadHash,
          record.conversationId,
          record.messageRequestId,
          this.session(current),
          cancel,
        );
        current();
        if (
          recovery.state === 'cancelled_before_prepare' ||
          (recovery.state === 'recorded' &&
            recovery.status.status === 'terminal')
        )
          this.pending.clear(record);
      } else this.pending.clear(record);
      return receipt;
    }
    progress(
      status.status === 'processing'
        ? '图片正在处理，请到恢复页继续查询'
        : status.status === 'bound_history'
          ? '原图片已绑定，正在等待原发送回执确认'
          : '原图片请求待确认，请查询或安全取消',
    );
    return null;
  }
  private assertRecord(record: PendingImage, session: MediaSession) {
    if (
      session.current().credentials?.accountId !== record.accountId ||
      JSON.stringify(this.pending.load(record.accountId)) !==
        JSON.stringify(record)
    )
      throw new ClientError('storage', '请登录原账号处理完全相同的图片请求');
  }
  private command(runtime: MessagingRuntime, record: PendingImage) {
    const pending = runtime.pending.load(record.accountId);
    if (
      pending &&
      (pending.requestId !== record.messageRequestId ||
        pending.operation !== 'send_image' ||
        (pending.intent &&
          (pending.intent.operation !== 'send_image' ||
            pending.intent.conversationId !== record.conversationId)))
    )
      throw new ClientError('storage', '原图片与私信请求不匹配');
    return pending;
  }
  private check(record: PendingImage, status: PrivateMessageMediaStatus) {
    if (
      status.requestId !== record.uploadRequestId ||
      status.requestHash !== record.uploadHash
    )
      throw new ClientError('protocol', '原图片请求不匹配');
  }
  async recover(
    runtime: MessagingRuntime,
    record: PendingImage,
    cancel: Cancellation,
    current: () => void,
    progress: (text: string) => void,
    retry = false,
  ): Promise<Receipt | null> {
    const session = this.session(current);
    this.assertRecord(record, session);
    this.command(runtime, record);
    try {
      const receipt = await runtime.gateway!.receipt(
        record.messageRequestId,
        cancel,
      );
      current();
      if (receipt.operation !== 'send_image')
        throw new ClientError('protocol', '原图片请求不匹配');
      const pending = this.command(runtime, record);
      if (pending) runtime.pending.settle(pending, receipt);
      if (receipt.outcome !== 'rejected') {
        this.pending.clear(record);
        return receipt;
      }
      return await this.cancel(runtime, record, cancel, current, receipt);
    } catch (e) {
      current();
      if (clientError(e).details.serverCode !== 'REQUEST_NOT_FOUND') throw e;
    }
    const recovery = await this.gateway.recover(
      record.uploadRequestId,
      session,
      cancel,
    );
    current();
    if (
      recovery.requestHash !== null &&
      recovery.requestHash !== record.uploadHash
    )
      throw new ClientError('protocol', '原图片请求不匹配');
    if (recovery.state === 'cancelled_before_prepare') {
      this.pending.clear(record);
      progress('原图片请求已安全取消');
      return null;
    }
    if (recovery.state !== 'recorded') {
      progress('尚未记录原上传；请安全取消，不能直接更换图片');
      return null;
    }
    if (retry)
      return this.publish(
        runtime,
        record,
        recovery.status,
        cancel,
        current,
        progress,
      );
    progress(
      recovery.status.status === 'ready_unbound'
        ? '原图片已准备好，可按原编号继续发送'
        : '原图片处理中或待确认；可以继续查询或安全取消',
    );
    return null;
  }
  async cancel(
    runtime: MessagingRuntime,
    record: PendingImage,
    cancel: Cancellation,
    current: () => void,
    receipt: Receipt | null = null,
  ): Promise<Receipt | null> {
    this.assertRecord(record, this.session(current));
    this.command(runtime, record);
    // Media owner fences the original message command under its shared send lock before cancellation.
    const result = await this.gateway.cancelRequest(
      record.uploadRequestId,
      record.uploadHash,
      record.conversationId,
      record.messageRequestId,
      this.session(current),
      cancel,
    );
    current();
    if (
      result.state === 'recorded' &&
      result.status.status === 'bound_history'
    ) {
      const committed = await runtime.gateway!.receipt(
        record.messageRequestId,
        cancel,
      );
      current();
      if (
        committed.operation !== 'send_image' ||
        committed.outcome === 'rejected' ||
        committed.conversationId !== record.conversationId
      )
        throw new ClientError('protocol', '原图片发送回执不匹配');
      const pending = this.command(runtime, record);
      if (pending) runtime.pending.settle(pending, committed);
      this.pending.clear(record);
      return committed;
    }
    if (
      result.state === 'cancelled_before_prepare' ||
      (result.state === 'recorded' && result.status.status === 'terminal')
    ) {
      const pending = this.command(runtime, record);
      if (pending) {
        const closed = await runtime.gateway!.cancel(
          pending.requestId,
          pending.operation,
          pending.intentHash,
          cancel,
        );
        current();
        runtime.pending.settle(pending, closed.receipt);
        receipt = closed.receipt;
      }
      this.pending.clear(record);
      return receipt;
    }
    throw new ClientError('business', '原图片仍需确认，不能更换编号');
  }
  async read(
    descriptor: PrivateMessageMediaDescriptor,
    owner: object,
    cancel: Cancellation,
    current: () => void,
  ) {
    const principal = this.principals.snapshot();
    if (principal.kind !== 'session')
      throw new ClientError('auth-required', '请登录查看私密图片');
    const context = {
      current: () => {
        current();
        this.principals.assertCurrent(principal);
        return this.principals.snapshot();
      },
    };
    const file = await this.download.download(
      descriptor,
      'display-v1',
      owner,
      context,
      cancel,
    );
    try {
      current();
      const path = await this.download.resolve(file, owner, context.current());
      current();
      return { file, path };
    } catch (e) {
      await this.download.release(file);
      throw e;
    }
  }
  release(file: LocalMediaFile) {
    return this.download.release(file);
  }
}
export function connectPrivateMessageImages(
  runtime: MessagingRuntime,
  options: PrivateMessageImagesOptions,
) {
  runtime.images = new PrivateMessageImages(options);
}
