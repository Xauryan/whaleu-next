import { ClientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import type { Storage } from '../platform/contracts';
import { isUuid } from './contract';
import {
  PROFILE_MEDIA_PROTOCOL,
  avatarCommandHash,
  avatarDigest,
  avatarExact,
  avatarInteger,
  avatarInvalid,
  avatarPrepareHash,
  decodeAvatarCommand,
  decodeAvatarCommandRecovery,
  decodeAvatarEditStatus,
  decodeAvatarEditRecovery,
  decodeAvatarPrepare,
  decodeAvatarReceipt,
  type AvatarCommand,
  type AvatarCommandRecovery,
  type AvatarEditRecovery,
  type AvatarEditStatus,
  type AvatarPrepare,
  type AvatarReceipt,
} from './avatar-contract';
export interface PendingAvatarEdit {
  readonly prepare: AvatarPrepare;
  readonly requestHash: string;
  readonly editId: string | null;
  readonly intentId: string | null;
  readonly assetId: string | null;
  readonly phase:
    | 'prepare_uncertain'
    | 'upload_uncertain'
    | 'processing'
    | 'ready_hint'
    | 'cancel_uncertain';
}
export interface PendingAvatarCommand {
  readonly input: AvatarCommand;
  readonly requestHash: string;
}
export interface PendingAvatar {
  readonly protocol: typeof PROFILE_MEDIA_PROTOCOL;
  readonly revision: number;
  readonly actorAccountId: string;
  readonly edit: PendingAvatarEdit | null;
  readonly command: PendingAvatarCommand | null;
}
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const failure = (): ClientError =>
  new ClientError(
    'storage',
    'Original avatar request recovery storage unavailable',
  );
export function decodePendingAvatar(
  value: unknown,
  actor: string,
): PendingAvatar {
  avatarExact(value, [
    'protocol',
    'revision',
    'actorAccountId',
    'edit',
    'command',
  ]);
  if (
    !isUuid(actor) ||
    value.actorAccountId !== actor ||
    value.protocol !== PROFILE_MEDIA_PROTOCOL ||
    !avatarInteger(value.revision)
  )
    avatarInvalid();
  let edit: PendingAvatarEdit | null = null;
  let command: PendingAvatarCommand | null = null;
  if (value.edit !== null) {
    avatarExact(value.edit, [
      'prepare',
      'requestHash',
      'editId',
      'intentId',
      'assetId',
      'phase',
    ]);
    const input = value.edit;
    const prepare = decodeAvatarPrepare(input.prepare);
    if (
      !avatarDigest(input.requestHash) ||
      avatarPrepareHash(actor, prepare) !== input.requestHash ||
      (input.editId !== null && !isUuid(input.editId)) ||
      (input.intentId !== null && !isUuid(input.intentId)) ||
      (input.assetId !== null && !isUuid(input.assetId)) ||
      (input.editId === null) !== (input.intentId === null) ||
      (input.assetId !== null && input.editId === null) ||
      ![
        'prepare_uncertain',
        'upload_uncertain',
        'processing',
        'ready_hint',
        'cancel_uncertain',
      ].includes(input.phase as string)
    )
      avatarInvalid();
    edit = Object.freeze({
      prepare,
      requestHash: input.requestHash,
      editId: input.editId,
      intentId: input.intentId,
      assetId: input.assetId,
      phase: input.phase as PendingAvatarEdit['phase'],
    });
  }
  if (value.command !== null) {
    avatarExact(value.command, ['input', 'requestHash']);
    const input = decodeAvatarCommand(value.command.input);
    if (avatarCommandHash(actor, input) !== value.command.requestHash)
      avatarInvalid();
    if (
      input.source.kind === 'custom' &&
      (!edit ||
        input.source.editId !== edit.editId ||
        input.source.assetId !== edit.assetId ||
        input.expectedRevision !== edit.prepare.expectedRevision)
    )
      avatarInvalid();
    if (input.source.kind !== 'custom' && edit) avatarInvalid();
    command = Object.freeze({
      input,
      requestHash: value.command.requestHash as string,
    });
  }
  if (!edit && !command) avatarInvalid();
  return Object.freeze({
    protocol: PROFILE_MEDIA_PROTOCOL,
    revision: value.revision,
    actorAccountId: actor,
    edit,
    command,
  });
}
/** Metadata only. Exact origin+actor key; never enumerate actors, expire, or clear on logout.
 * No file paths, image bytes, token, grant, local handles or user prose are persisted. */
export class PendingAvatarStore {
  private readonly origin: string;
  constructor(
    private readonly storage: Storage,
    origin: string,
  ) {
    this.origin = normalizeOrigin(origin);
  }
  private key(actor: string): string {
    if (!isUuid(actor)) throw failure();
    return `whaleu.profile.avatar.pending.v1:${this.origin}:${actor}`;
  }
  load(actor: string): PendingAvatar | null {
    try {
      const raw = this.storage.get(this.key(actor));
      return raw === null || raw === undefined
        ? null
        : decodePendingAvatar(raw, actor);
    } catch {
      throw failure();
    }
  }
  assertStored(expected: PendingAvatar): PendingAvatar {
    const current = this.load(expected.actorAccountId);
    if (!current || !same(current, expected)) throw failure();
    return current;
  }
  private write(
    actor: string,
    expected: PendingAvatar | null,
    edit: PendingAvatarEdit | null,
    command: PendingAvatarCommand | null,
  ): PendingAvatar {
    try {
      if (!same(this.load(actor), expected)) throw failure();
      const value = decodePendingAvatar(
        {
          protocol: PROFILE_MEDIA_PROTOCOL,
          revision: (expected?.revision ?? 0) + 1,
          actorAccountId: actor,
          edit,
          command,
        },
        actor,
      );
      this.storage.set(this.key(actor), value);
      return this.assertStored(value);
    } catch {
      throw failure();
    }
  }
  freezeEdit(actor: string, raw: AvatarPrepare): PendingAvatar {
    const prepare = decodeAvatarPrepare(raw);
    return this.write(
      actor,
      null,
      {
        prepare,
        requestHash: avatarPrepareHash(actor, prepare),
        editId: null,
        intentId: null,
        assetId: null,
        phase: 'prepare_uncertain',
      },
      null,
    );
  }
  freezeCommand(actor: string, raw: AvatarCommand): PendingAvatar {
    const input = decodeAvatarCommand(raw);
    const old = this.load(actor);
    if (old?.command || (input.source.kind !== 'custom' && old))
      throw failure();
    return this.write(actor, old, old?.edit ?? null, {
      input,
      requestHash: avatarCommandHash(actor, input),
    });
  }
  phase(
    expected: PendingAvatar,
    phase: PendingAvatarEdit['phase'],
  ): PendingAvatar {
    if (!expected.edit || expected.command) throw failure();
    return this.write(
      expected.actorAccountId,
      expected,
      { ...expected.edit, phase },
      null,
    );
  }
  observe(expected: PendingAvatar, raw: AvatarEditStatus): PendingAvatar {
    const status = decodeAvatarEditStatus(raw),
      edit = expected.edit;
    if (
      !edit ||
      status.requestId !== edit.prepare.clientRequestId ||
      status.requestHash !== edit.requestHash ||
      (edit.editId !== null && edit.editId !== status.editId) ||
      (edit.intentId !== null && edit.intentId !== status.intentId) ||
      ('assetId' in status &&
        edit.assetId !== null &&
        edit.assetId !== status.assetId)
    )
      avatarInvalid();
    return this.write(
      expected.actorAccountId,
      expected,
      {
        ...edit,
        editId: status.editId,
        intentId: status.intentId,
        assetId: 'assetId' in status ? status.assetId : edit.assetId,
        phase:
          status.status === 'ready_unbound'
            ? 'ready_hint'
            : status.status === 'prepared'
              ? edit.phase
              : 'processing',
      },
      expected.command,
    );
  }
  settleCommand(expected: PendingAvatar, raw: AvatarReceipt): void {
    const receipt = decodeAvatarReceipt(raw),
      command = expected.command;
    if (
      !command ||
      receipt.clientRequestId !== command.input.clientRequestId ||
      receipt.requestHash !== command.requestHash ||
      receipt.resultingRevision !== command.input.expectedRevision + 1
    )
      avatarInvalid();
    this.remove(expected);
  }
  settlePrePrepare(expected: PendingAvatar, raw: AvatarEditRecovery): void {
    const proof = decodeAvatarEditRecovery(raw);
    if (
      !expected.edit ||
      expected.command ||
      proof.state !== 'cancelled_before_prepare' ||
      proof.requestId !== expected.edit.prepare.clientRequestId ||
      proof.requestHash !== expected.edit.requestHash ||
      expected.edit.editId !== null
    )
      avatarInvalid();
    this.remove(expected);
  }
  settleEdit(expected: PendingAvatar, raw: AvatarEditStatus): void {
    const status = decodeAvatarEditStatus(raw),
      edit = expected.edit;
    if (
      !edit ||
      expected.command ||
      status.requestId !== edit.prepare.clientRequestId ||
      status.requestHash !== edit.requestHash ||
      (edit.editId !== null && status.editId !== edit.editId) ||
      (status.status !== 'terminal' && status.status !== 'bound_history')
    )
      avatarInvalid();
    this.remove(expected);
  }
  /** Only a durable server cancellation fence proves a receipt-less command cannot commit. */
  settleCancelledCommand(
    expected: PendingAvatar,
    raw: AvatarCommandRecovery,
  ): PendingAvatar | null {
    const proof = decodeAvatarCommandRecovery(raw),
      command = expected.command;
    if (
      !command ||
      proof.state !== 'cancelled' ||
      proof.clientRequestId !== command.input.clientRequestId ||
      proof.requestHash !== command.requestHash
    )
      avatarInvalid();
    if (expected.edit)
      return this.write(expected.actorAccountId, expected, expected.edit, null);
    this.remove(expected);
    return null;
  }
  private remove(expected: PendingAvatar): void {
    try {
      this.assertStored(expected);
      this.storage.remove(this.key(expected.actorAccountId));
      if (this.load(expected.actorAccountId)) throw failure();
    } catch {
      throw failure();
    }
  }
}
