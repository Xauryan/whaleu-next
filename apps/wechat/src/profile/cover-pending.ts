import { ClientError } from '../api/errors';
import { normalizeOrigin } from '../api/origin';
import type { Storage } from '../platform/contracts';
import { isUuid } from './contract';
import {
  PROFILE_COVER_PROTOCOL,
  coverCommandHash,
  coverDigest,
  coverExact,
  coverInteger,
  coverInvalid,
  coverPrepareHash,
  decodeCoverCommand,
  decodeCoverCommandRecovery,
  decodeCoverEditStatus,
  decodeCoverEditRecovery,
  decodeCoverPrepare,
  decodeCoverReceipt,
  type CoverCommand,
  type CoverCommandRecovery,
  type CoverEditRecovery,
  type CoverEditStatus,
  type CoverPrepare,
  type CoverReceipt,
} from './cover-contract';
export interface PendingCoverEdit {
  readonly prepare: CoverPrepare;
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
export interface PendingCoverCommand {
  readonly input: CoverCommand;
  readonly requestHash: string;
}
export interface PendingCover {
  readonly protocol: typeof PROFILE_COVER_PROTOCOL;
  readonly revision: number;
  readonly actorAccountId: string;
  readonly edit: PendingCoverEdit | null;
  readonly command: PendingCoverCommand | null;
}
const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const failure = (): ClientError =>
  new ClientError(
    'storage',
    'Original cover request recovery storage unavailable',
  );
export function decodePendingCover(
  value: unknown,
  actor: string,
): PendingCover {
  coverExact(value, [
    'protocol',
    'revision',
    'actorAccountId',
    'edit',
    'command',
  ]);
  if (
    !isUuid(actor) ||
    value.actorAccountId !== actor ||
    value.protocol !== PROFILE_COVER_PROTOCOL ||
    !coverInteger(value.revision)
  )
    coverInvalid();
  let edit: PendingCoverEdit | null = null;
  let command: PendingCoverCommand | null = null;
  if (value.edit !== null) {
    coverExact(value.edit, [
      'prepare',
      'requestHash',
      'editId',
      'intentId',
      'assetId',
      'phase',
    ]);
    const input = value.edit;
    const prepare = decodeCoverPrepare(input.prepare);
    if (
      !coverDigest(input.requestHash) ||
      coverPrepareHash(actor, prepare) !== input.requestHash ||
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
      coverInvalid();
    edit = Object.freeze({
      prepare,
      requestHash: input.requestHash,
      editId: input.editId,
      intentId: input.intentId,
      assetId: input.assetId,
      phase: input.phase as PendingCoverEdit['phase'],
    });
  }
  if (value.command !== null) {
    coverExact(value.command, ['input', 'requestHash']);
    const input = decodeCoverCommand(value.command.input);
    if (coverCommandHash(actor, input) !== value.command.requestHash)
      coverInvalid();
    if (
      input.source.kind === 'custom' &&
      (!edit ||
        input.source.editId !== edit.editId ||
        input.source.assetId !== edit.assetId ||
        input.expectedRevision !== edit.prepare.expectedRevision)
    )
      coverInvalid();
    if (input.source.kind !== 'custom' && edit) coverInvalid();
    command = Object.freeze({
      input,
      requestHash: value.command.requestHash as string,
    });
  }
  if (!edit && !command) coverInvalid();
  return Object.freeze({
    protocol: PROFILE_COVER_PROTOCOL,
    revision: value.revision,
    actorAccountId: actor,
    edit,
    command,
  });
}
/** Metadata only. Exact origin+actor key; never enumerate actors, expire, or clear on logout.
 * No file paths, image bytes, token, grant, local handles or user prose are persisted. */
export class PendingCoverStore {
  private readonly origin: string;
  constructor(
    private readonly storage: Storage,
    origin: string,
  ) {
    this.origin = normalizeOrigin(origin);
  }
  private key(actor: string): string {
    if (!isUuid(actor)) throw failure();
    return `whaleu.profile.cover.pending.v1:${this.origin}:${actor}`;
  }
  load(actor: string): PendingCover | null {
    try {
      const raw = this.storage.get(this.key(actor));
      return raw === null || raw === undefined
        ? null
        : decodePendingCover(raw, actor);
    } catch {
      throw failure();
    }
  }
  assertStored(expected: PendingCover): PendingCover {
    const current = this.load(expected.actorAccountId);
    if (!current || !same(current, expected)) throw failure();
    return current;
  }
  private write(
    actor: string,
    expected: PendingCover | null,
    edit: PendingCoverEdit | null,
    command: PendingCoverCommand | null,
  ): PendingCover {
    try {
      if (!same(this.load(actor), expected)) throw failure();
      const value = decodePendingCover(
        {
          protocol: PROFILE_COVER_PROTOCOL,
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
  freezeEdit(actor: string, raw: CoverPrepare): PendingCover {
    const prepare = decodeCoverPrepare(raw);
    return this.write(
      actor,
      null,
      {
        prepare,
        requestHash: coverPrepareHash(actor, prepare),
        editId: null,
        intentId: null,
        assetId: null,
        phase: 'prepare_uncertain',
      },
      null,
    );
  }
  freezeCommand(actor: string, raw: CoverCommand): PendingCover {
    const input = decodeCoverCommand(raw);
    const old = this.load(actor);
    if (old?.command || (input.source.kind !== 'custom' && old))
      throw failure();
    return this.write(actor, old, old?.edit ?? null, {
      input,
      requestHash: coverCommandHash(actor, input),
    });
  }
  phase(
    expected: PendingCover,
    phase: PendingCoverEdit['phase'],
  ): PendingCover {
    if (!expected.edit || expected.command) throw failure();
    return this.write(
      expected.actorAccountId,
      expected,
      { ...expected.edit, phase },
      null,
    );
  }
  observe(expected: PendingCover, raw: CoverEditStatus): PendingCover {
    const status = decodeCoverEditStatus(raw),
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
      coverInvalid();
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
  settleCommand(expected: PendingCover, raw: CoverReceipt): void {
    const receipt = decodeCoverReceipt(raw),
      command = expected.command;
    if (
      !command ||
      receipt.clientRequestId !== command.input.clientRequestId ||
      receipt.requestHash !== command.requestHash ||
      receipt.resultingRevision !== command.input.expectedRevision + 1
    )
      coverInvalid();
    this.remove(expected);
  }
  settlePrePrepare(expected: PendingCover, raw: CoverEditRecovery): void {
    const proof = decodeCoverEditRecovery(raw);
    if (
      !expected.edit ||
      expected.command ||
      proof.state !== 'cancelled_before_prepare' ||
      proof.requestId !== expected.edit.prepare.clientRequestId ||
      proof.requestHash !== expected.edit.requestHash ||
      expected.edit.editId !== null
    )
      coverInvalid();
    this.remove(expected);
  }
  settleEdit(expected: PendingCover, raw: CoverEditStatus): void {
    const status = decodeCoverEditStatus(raw),
      edit = expected.edit;
    if (
      !edit ||
      expected.command ||
      status.requestId !== edit.prepare.clientRequestId ||
      status.requestHash !== edit.requestHash ||
      (edit.editId !== null && status.editId !== edit.editId) ||
      (edit.intentId !== null && status.intentId !== edit.intentId) ||
      ('assetId' in status &&
        edit.assetId !== null &&
        status.assetId !== edit.assetId) ||
      (status.status !== 'terminal' && status.status !== 'bound_history')
    )
      coverInvalid();
    this.remove(expected);
  }
  /** Only a durable server cancellation fence proves a receipt-less command cannot commit. */
  settleCancelledCommand(
    expected: PendingCover,
    raw: CoverCommandRecovery,
  ): PendingCover | null {
    const proof = decodeCoverCommandRecovery(raw),
      command = expected.command;
    if (
      !command ||
      proof.state !== 'cancelled' ||
      proof.clientRequestId !== command.input.clientRequestId ||
      proof.requestHash !== command.requestHash
    )
      coverInvalid();
    if (expected.edit)
      return this.write(expected.actorAccountId, expected, expected.edit, null);
    this.remove(expected);
    return null;
  }
  private remove(expected: PendingCover): void {
    try {
      this.assertStored(expected);
      this.storage.remove(this.key(expected.actorAccountId));
      if (this.load(expected.actorAccountId)) throw failure();
    } catch {
      throw failure();
    }
  }
}
