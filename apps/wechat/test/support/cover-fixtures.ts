import type { CoverGateway } from '../../src/profile/cover-gateway';
import type { CoverUploadTransfer } from '../../src/profile/cover-transfer';
import {
  PROFILE_COVER_PROTOCOL as protocol,
  coverCommandHash,
  coverPrepareHash,
  type CoverCommand,
  type CoverCommandRecovery,
  type CoverEditRecovery,
  type CoverEditStatus,
  type CoverGrant,
  type CoverPrepare,
  type CoverReceipt,
  type CurrentCover,
} from '../../src/profile/cover-contract';
import type { MediaSession } from '../../src/media/contracts';
import type { Cancellation } from '../../src/platform/contracts';
import type { CoverPrincipalContext } from '../../src/profile/cover-principal';
export const coverIds = {
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
export const coverPrepare: CoverPrepare = {
  protocol,
  clientRequestId: coverIds.request,
  expectedRevision: 5,
  slot: 'cover',
  declaration: { mime: 'image/png', bytes: 100, sha256: 'a'.repeat(64) },
};
export const coverCurrent: CurrentCover = {
  protocol,
  profileId: coverIds.profile,
  revision: 5,
  cover: {
    state: 'available',
    appearanceId: coverIds.appearance,
    source: { kind: 'custom', bindingId: coverIds.binding },
    variants: ['thumb-v1', 'display-v1'],
    width: 80,
    height: 60,
  },
};
export const coverBase = (prepare = coverPrepare) => ({
  protocol,
  editId: coverIds.edit,
  intentId: coverIds.intent,
  requestId: prepare.clientRequestId,
  requestHash: coverPrepareHash(coverIds.actor, prepare),
  serverNow: 1000,
});
export const coverPrepared = (prepare = coverPrepare): CoverEditStatus => ({
  ...coverBase(prepare),
  status: 'prepared',
  operationDeadlineAt: 120000,
  upload: 'none',
});
export const coverReady = (prepare = coverPrepare): CoverEditStatus => ({
  ...coverBase(prepare),
  status: 'ready_unbound',
  assetId: coverIds.asset,
  readyRetentionUntil: 100000,
  editExpiresAt: 90000,
  bindBefore: 90000,
  mediaProof: 'current',
});
export const coverGrant: CoverGrant = {
  protocol,
  strategy: 'authenticated-multipart-v1',
  editId: coverIds.edit,
  intentId: coverIds.intent,
  generation: '1',
  grantId: coverIds.grant,
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
export const coverReceipt = (
  input: CoverCommand,
  actor = coverIds.actor,
): CoverReceipt => ({
  protocol,
  clientRequestId: input.clientRequestId,
  requestHash: coverCommandHash(actor, input),
  resultingRevision: input.expectedRevision + 1,
  operation: 'select_cover',
});
export class FakeCoverGateway implements CoverGateway {
  currentValue = coverCurrent;
  prepareValue = coverPrepare;
  readonly commands: CoverCommand[] = [];
  readonly commandReads: { actor: string; id: string }[] = [];
  readonly currentReads: ('guest' | string)[] = [];
  receipt: CoverReceipt | null = null;
  commandFailure: Error | null = null;
  current(
    _profile: string | null,
    principal: CoverPrincipalContext,
    _cancel: Cancellation,
  ): Promise<CurrentCover> {
    const value = principal.current();
    this.currentReads.push(
      value.kind === 'guest' ? 'guest' : value.ticket.credentials!.accountId,
    );
    return Promise.resolve(this.currentValue);
  }
  capabilitiesValue = {
    protocol,
    upload: 'available' as 'available' | 'unavailable',
  };
  capabilities(principal: CoverPrincipalContext, _cancel: Cancellation) {
    principal.current();
    return Promise.resolve(this.capabilitiesValue);
  }
  prepare(
    input: CoverPrepare,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<CoverEditStatus> {
    session.current();
    this.prepareValue = input;
    return Promise.resolve(coverPrepared(input));
  }
  recoverEdit(
    requestId: string,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<CoverEditRecovery> {
    session.current();
    const status = coverReady(this.prepareValue);
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
  ): Promise<CoverEditStatus> {
    session.current();
    return Promise.resolve(coverReady(this.prepareValue));
  }
  grant(
    _editId: string,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<CoverGrant> {
    session.current();
    return Promise.resolve(coverGrant);
  }
  finalize(
    _editId: string,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<CoverEditStatus> {
    session.current();
    return Promise.resolve(coverReady(this.prepareValue));
  }
  cancelEdit(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<CoverEditRecovery> {
    session.current();
    return Promise.resolve({
      protocol,
      requestId,
      serverNow: 1000,
      state: 'recorded',
      requestHash,
      status: {
        ...coverBase(this.prepareValue),
        status: 'terminal',
        reason: 'cancelled',
        cleanup: 'retained',
      },
    });
  }
  command(
    input: CoverCommand,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<CoverReceipt> {
    const actor = session.current().credentials!.accountId;
    this.commands.push(input);
    this.receipt = coverReceipt(input, actor);
    if (this.commandFailure) return Promise.reject(this.commandFailure);
    return Promise.resolve(this.receipt);
  }
  cancelCommand(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    _cancel: Cancellation,
  ): Promise<CoverCommandRecovery> {
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
  ): Promise<CoverCommandRecovery> {
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
export class FakeCoverUpload implements CoverUploadTransfer {
  pickerState: 'ready' | 'waiting-native' | 'unavailable' = 'ready';
  subscribePicker(_listener: () => void): () => void {
    return () => undefined;
  }
  readonly removed: string[] = [];
  readonly cleared: number[] = [];
  async pick(session: MediaSession, _cancel: Cancellation) {
    session.current();
    return { localId: 'local-cover' };
  }
  async inspect(
    _file: { localId: string },
    session: MediaSession,
    _cancel: Cancellation,
  ) {
    session.current();
    return { ...coverPrepare.declaration, width: 80, height: 60 };
  }
  async preview(
    _file: { localId: string },
    session: MediaSession,
    _cancel: Cancellation,
  ) {
    session.current();
    return 'wxfile://tmp/cover.png';
  }
  register(_grant: CoverGrant, session: MediaSession) {
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
      editId: coverIds.edit,
      intentId: coverIds.intent,
      generation: '1',
      grantId: coverIds.grant,
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
