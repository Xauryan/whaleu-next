import type { AvatarGateway } from '../../src/profile/avatar-gateway';
import type { AvatarUploadTransfer } from '../../src/profile/avatar-transfer';
import {
  PROFILE_MEDIA_PROTOCOL as protocol,
  avatarCommandHash,
  avatarPrepareHash,
  type AvatarCatalog,
  type AvatarCommand,
  type AvatarCommandRecovery,
  type AvatarEditRecovery,
  type AvatarEditStatus,
  type AvatarGrant,
  type AvatarPrepare,
  type AvatarReceipt,
  type CurrentAvatar,
} from '../../src/profile/avatar-contract';
import type { MediaSession } from '../../src/media/contracts';
import type { Cancellation } from '../../src/platform/contracts';
import type { AvatarPrincipalContext } from '../../src/profile/avatar-principal';
export const avatarIds = {
  actor: '12345678-1234-4123-8123-123456789abc',
  other: '12345678-1234-4123-8123-123456789abd',
  request: '22345678-1234-4123-8123-123456789abc',
  command: '32345678-1234-4123-8123-123456789abc',
  edit: '42345678-1234-4123-8123-123456789abc',
  intent: '52345678-1234-4123-8123-123456789abc',
  asset: '62345678-1234-4123-8123-123456789abc',
  binding: '72345678-1234-4123-8123-123456789abc',
  appearance: '82345678-1234-4123-8123-123456789abc',
  profile: '92345678-1234-4123-8123-123456789abc',
  grant: 'a2345678-1234-4123-8123-123456789abc',
};
export const avatarPrepare: AvatarPrepare = {
  protocol,
  clientRequestId: avatarIds.request,
  expectedRevision: 5,
  slot: 'avatar',
  declaration: { mime: 'image/png', bytes: 100, sha256: 'a'.repeat(64) },
};
export const avatarCatalog: AvatarCatalog = {
  protocol,
  availability: 'available',
  catalogVersion: 'synthetic-v1',
  items: [
    {
      itemId: 'synthetic-one',
      label: '合成默认头像一',
      contentHash: 'b'.repeat(64),
    },
  ],
};
export const avatarCurrent: CurrentAvatar = {
  protocol,
  profileId: avatarIds.profile,
  revision: 5,
  avatar: {
    state: 'available',
    appearanceId: avatarIds.appearance,
    source: { kind: 'custom', bindingId: avatarIds.binding },
    variants: ['thumb-v1', 'display-v1'],
    width: 80,
    height: 60,
  },
};
export const avatarBase = (prepare = avatarPrepare) => ({
  protocol,
  editId: avatarIds.edit,
  intentId: avatarIds.intent,
  requestId: prepare.clientRequestId,
  requestHash: avatarPrepareHash(avatarIds.actor, prepare),
  serverNow: 1000,
});
export const avatarPrepared = (prepare = avatarPrepare): AvatarEditStatus => ({
  ...avatarBase(prepare),
  status: 'prepared',
  operationDeadlineAt: 120000,
  upload: 'none',
});
export const avatarReady = (prepare = avatarPrepare): AvatarEditStatus => ({
  ...avatarBase(prepare),
  status: 'ready_unbound',
  assetId: avatarIds.asset,
  readyRetentionUntil: 100000,
  editExpiresAt: 90000,
  bindBefore: 90000,
  mediaProof: 'current',
});
export const avatarGrant: AvatarGrant = {
  protocol,
  strategy: 'authenticated-multipart-v1',
  editId: avatarIds.edit,
  intentId: avatarIds.intent,
  generation: '1',
  grantId: avatarIds.grant,
  method: 'POST',
  fieldName: 'file',
  maxBytes: 5 * 1024 * 1024,
  expectedBytes: 100,
  expectedMime: 'image/png',
  expectedSha256: 'a'.repeat(64),
  grantExpiresAt: 100000,
  operationDeadlineAt: 120000,
  serverNow: 1000,
};
export const avatarReceipt = (
  input: AvatarCommand,
  actor = avatarIds.actor,
): AvatarReceipt => ({
  protocol,
  clientRequestId: input.clientRequestId,
  requestHash: avatarCommandHash(actor, input),
  resultingRevision: input.expectedRevision + 1,
  operation: 'select_avatar',
});
export class FakeAvatarGateway implements AvatarGateway {
  currentValue = avatarCurrent;
  catalogValue = avatarCatalog;
  prepareValue = avatarPrepare;
  readonly commands: AvatarCommand[] = [];
  readonly commandReads: { actor: string; id: string }[] = [];
  readonly currentReads: ('guest' | string)[] = [];
  receipt: AvatarReceipt | null = null;
  commandFailure: Error | null = null;
  current(
    _profile: string | null,
    principal: AvatarPrincipalContext,
    _cancel: Cancellation,
  ): Promise<CurrentAvatar> {
    const value = principal.current();
    this.currentReads.push(
      value.kind === 'guest' ? 'guest' : value.ticket.credentials!.accountId,
    );
    return Promise.resolve(this.currentValue);
  }
  catalog(
    principal: AvatarPrincipalContext,
    _cancel: Cancellation,
  ): Promise<AvatarCatalog> {
    principal.current();
    return Promise.resolve(this.catalogValue);
  }
  prepare(
    input: AvatarPrepare,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<AvatarEditStatus> {
    session.current();
    this.prepareValue = input;
    return Promise.resolve(avatarPrepared(input));
  }
  recoverEdit(
    requestId: string,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<AvatarEditRecovery> {
    session.current();
    const status = avatarReady(this.prepareValue);
    return Promise.resolve({
      protocol,
      requestId,
      serverNow: status.serverNow,
      state: 'recorded',
      requestHash: status.requestHash,
      status,
    });
  }
  status(
    _editId: string,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<AvatarEditStatus> {
    session.current();
    return Promise.resolve(avatarReady(this.prepareValue));
  }
  grant(
    _editId: string,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<AvatarGrant> {
    session.current();
    return Promise.resolve(avatarGrant);
  }
  finalize(
    _editId: string,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<AvatarEditStatus> {
    session.current();
    return Promise.resolve(avatarReady(this.prepareValue));
  }
  cancelEdit(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<AvatarEditRecovery> {
    session.current();
    return Promise.resolve({
      protocol,
      requestId,
      serverNow: 1000,
      state: 'recorded',
      requestHash,
      status: {
        ...avatarBase(this.prepareValue),
        status: 'terminal',
        reason: 'cancelled',
        cleanup: 'retained',
      },
    });
  }
  command(
    input: AvatarCommand,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<AvatarReceipt> {
    const actor = session.current().credentials!.accountId;
    this.commands.push(input);
    this.receipt = avatarReceipt(input, actor);
    if (this.commandFailure) return Promise.reject(this.commandFailure);
    return Promise.resolve(this.receipt);
  }
  cancelCommand(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<AvatarCommandRecovery> {
    session.current();
    return Promise.resolve(
      this.receipt
        ? {
            protocol,
            clientRequestId: requestId,
            state: 'committed',
            receipt: this.receipt,
          }
        : {
            protocol,
            clientRequestId: requestId,
            state: 'cancelled',
            requestHash,
          },
    );
  }
  recoverCommand(
    requestId: string,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<AvatarCommandRecovery> {
    const actor = session.current().credentials!.accountId;
    this.commandReads.push({ actor, id: requestId });
    return Promise.resolve(
      this.receipt
        ? {
            protocol,
            clientRequestId: requestId,
            state: 'committed',
            receipt: this.receipt,
          }
        : { protocol, clientRequestId: requestId, state: 'not_recorded' },
    );
  }
}
export class FakeAvatarUpload implements AvatarUploadTransfer {
  readonly pickerState = 'ready' as const;
  subscribePicker(_listener: () => void): () => void {
    return () => undefined;
  }
  readonly removed: string[] = [];
  readonly cleared: number[] = [];
  async pick(session: MediaSession, _cancel: Cancellation) {
    session.current();
    return { localId: 'local-avatar' };
  }
  async inspect(
    _file: { localId: string },
    session: MediaSession,
    _cancel: Cancellation,
  ) {
    session.current();
    return { ...avatarPrepare.declaration, width: 80, height: 60 };
  }
  async preview(
    _file: { localId: string },
    session: MediaSession,
    _cancel: Cancellation,
  ) {
    session.current();
    return 'wxfile://tmp/avatar.png';
  }
  register(_grant: AvatarGrant, session: MediaSession) {
    session.current();
    return { handle: 'grant' };
  }
  async upload(
    _handle: { handle: string },
    _file: { localId: string },
    progress: (percent: number) => void,
    session: MediaSession,
    _cancel: Cancellation,
  ) {
    session.current();
    progress(100);
    return {
      protocol,
      status: 'uploadObserved' as const,
      editId: avatarIds.edit,
      intentId: avatarIds.intent,
      generation: '1',
      grantId: avatarIds.grant,
      bytes: 100,
      sha256: 'a'.repeat(64),
      next: 'finalize' as const,
    };
  }
  clearSession(ticket: { epoch: number }): void {
    this.cleared.push(ticket.epoch);
  }
  async remove(file: { localId: string }): Promise<void> {
    this.removed.push(file.localId);
  }
}
