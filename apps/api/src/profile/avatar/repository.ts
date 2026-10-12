import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import {
  avatarCommandHash,
  avatarModerationClearDigest,
  avatarModerationClearEnvelopeSchema,
  avatarPrepareHash,
  avatarReceiptSchema,
  avatarReviewEnvelopeSchema,
  avatarSelectedSourceSchema,
  PROFILE_MEDIA_PROTOCOL,
} from './contracts.js';
import type {
  AvatarCommand,
  AvatarModerationClearEnvelope,
  AvatarPrepare,
  AvatarReceipt,
  AvatarReviewEnvelope,
  AvatarSelectedSource,
} from './contracts.js';
import { lockAvatarActor, requireAvatarCurrent } from './current-proof.js';
interface AvatarDefinitionBase {
  id: string;
  actor_id: string;
  digest: string;
}
export interface SelfSelectionAvatarDefinition extends AvatarDefinitionBase {
  authority: 'self_selection';
  source: AvatarSelectedSource;
  envelope: AvatarReviewEnvelope;
  binding_id: string | null;
}
export interface ScopedModerationClearAvatarDefinition extends AvatarDefinitionBase {
  authority: 'scoped_moderation_clear';
  source: { kind: 'clear' };
  envelope: AvatarModerationClearEnvelope;
  binding_id: null;
}
export type AvatarDefinition =
  SelfSelectionAvatarDefinition | ScopedModerationClearAvatarDefinition;
interface AvatarDefinitionRow extends AvatarDefinitionBase {
  authority: string;
  source: unknown;
  envelope: unknown;
  binding_id: string | null;
}
export interface AvatarEdit {
  id: string;
  actor_id: string;
  client_request_id: string;
  expected_revision: number;
  scope_revision: string;
  request_hash: string;
  declaration: AvatarPrepare['declaration'];
  expires_at: Date;
}
/** Stable server identity lets an exact Review be recovered with the same key. */
export function avatarAppearanceId(actor: string, commandId: string): string {
  const bytes = createHash('sha256')
    .update(`whaleu:profile-avatar:appearance:v1\n${actor}\n${commandId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
/** Moderator/request/subject are separate from the self-selection identity. */
export function avatarModerationClearAppearanceId(
  moderator: string,
  commandId: string,
  subject: string,
): string {
  const bytes = createHash('sha256')
    .update(
      `whaleu:profile-avatar-moderation-appearance:v1\n${moderator}\n${commandId}\n${subject}`,
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export class ProfileAvatarRepository {
  async current(
    actor: string,
    tx: PoolClient,
  ): Promise<AvatarDefinition | null> {
    const row = (
      await tx.query<AvatarDefinitionRow>(
        'SELECT d.* FROM whaleu_profile.avatar_current c JOIN whaleu_profile.avatar_definitions d ON d.id=c.appearance_id AND d.actor_id=c.actor_id WHERE c.actor_id=$1',
        [actor],
      )
    ).rows[0];
    if (!row) return null;
    if (row.authority === 'scoped_moderation_clear') {
      const source = avatarSelectedSourceSchema.safeParse(row.source),
        envelope = avatarModerationClearEnvelopeSchema.safeParse(row.envelope);
      if (
        !source.success ||
        source.data.kind !== 'clear' ||
        row.binding_id !== null ||
        !envelope.success ||
        envelope.data.accountId !== row.actor_id ||
        envelope.data.appearanceId !== row.id ||
        avatarModerationClearDigest(envelope.data) !== row.digest
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      // Only immutable event/transition closure establishes this authority.
      // Later grant or target changes must not restore a removed selection.
      const authorized = (
        await tx.query<{ authorized: boolean }>(
          'SELECT whaleu_profile.avatar_moderation_definition_authorized($1::uuid) AS authorized',
          [row.id],
        )
      ).rows[0]?.authorized;
      if (authorized !== true) throw new ApplicationError('MEDIA_UNAVAILABLE');
      return {
        ...row,
        authority: 'scoped_moderation_clear',
        source: source.data,
        envelope: envelope.data,
        binding_id: null,
      };
    }
    if (row.authority !== 'self_selection')
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const source = avatarSelectedSourceSchema.safeParse(row.source),
      envelope = avatarReviewEnvelopeSchema.safeParse(row.envelope);
    if (!source.success || !envelope.success)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      ...row,
      authority: 'self_selection',
      source: source.data,
      envelope: envelope.data,
    };
  }
  async revision(
    actor: string,
    tx: PoolClient,
  ): Promise<{ revision: number; profileId: string | null }> {
    return (
      (
        await tx.query<{ revision: number; profileId: string }>(
          'SELECT revision,public_id AS "profileId" FROM whaleu_profile.profiles WHERE account_id=$1',
          [actor],
        )
      ).rows[0] ?? { revision: 0, profileId: null }
    );
  }
  /** Bind the no-runtime projection to the same pointer/Profile values returned
   * to the client, after its final-proof fact has already been enrolled. */
  async requireSystemClearCurrent(
    definition: ScopedModerationClearAvatarDefinition,
    current: { revision: number; profileId: string | null },
    tx: PoolClient,
  ): Promise<void> {
    const selected = (
      await tx.query<{ current: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM whaleu_profile.avatar_current c
         JOIN whaleu_profile.profiles p ON p.account_id=c.actor_id
         WHERE c.actor_id=$1 AND c.appearance_id=$2 AND p.revision=$3
         AND p.public_id=$4::uuid) AS current`,
        [
          definition.actor_id,
          definition.id,
          current.revision,
          current.profileId,
        ],
      )
    ).rows[0]?.current;
    if (selected !== true) throw new ApplicationError('MEDIA_UNAVAILABLE');
  }
  async prepare(
    actor: string,
    input: AvatarPrepare,
    tx: PoolClient,
  ): Promise<AvatarEdit> {
    await lockAvatarActor(actor, tx);
    const hash = avatarPrepareHash(actor, input);
    const previous = (
      await tx.query<AvatarEdit>(
        'SELECT * FROM whaleu_profile.avatar_edits WHERE actor_id=$1 AND client_request_id=$2',
        [actor, input.clientRequestId],
      )
    ).rows[0];
    if (previous && previous.request_hash !== hash)
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    const revision = await this.revision(actor, tx);
    if (
      revision.revision !== input.expectedRevision ||
      revision.revision === 2147483647
    )
      throw new ApplicationError('PROFILE_REVISION_CONFLICT');
    const edit =
      previous ??
      (
        await tx.query<AvatarEdit>(
          `INSERT INTO whaleu_profile.avatar_edits(id,actor_id,client_request_id,expected_revision,scope_revision,request_hash,declaration,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,clock_timestamp()+interval '30 minutes') RETURNING *`,
          [
            randomUUID(),
            actor,
            input.clientRequestId,
            input.expectedRevision,
            String(input.expectedRevision),
            hash,
            JSON.stringify(input.declaration),
          ],
        )
      ).rows[0]!;
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]!.now.getTime();
    if (!(edit.expires_at instanceof Date) || edit.expires_at.getTime() <= now)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      edit.expires_at.getTime(),
      'MEDIA_UNAVAILABLE',
    );
    await requireAvatarCurrent(actor, tx, edit.id);
    return edit;
  }
  async edit(
    actor: string,
    editId: string,
    tx: PoolClient,
  ): Promise<AvatarEdit> {
    const row = (
      await tx.query<AvatarEdit>(
        'SELECT * FROM whaleu_profile.avatar_edits WHERE actor_id=$1 AND id=$2',
        [actor, editId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return row;
  }
  async receipt(
    actor: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<AvatarReceipt | null> {
    const row = (
      await tx.query<{ request_hash: string; resulting_revision: number }>(
        'SELECT request_hash,resulting_revision FROM whaleu_profile.avatar_command_receipts WHERE actor_id=$1 AND client_request_id=$2',
        [actor, requestId],
      )
    ).rows[0];
    return row
      ? avatarReceiptSchema.parse({
          protocol: PROFILE_MEDIA_PROTOCOL,
          clientRequestId: requestId,
          requestHash: row.request_hash,
          resultingRevision: row.resulting_revision,
          operation: 'select_avatar',
        })
      : null;
  }
  async cancellation(
    actor: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<string | null> {
    return (
      (
        await tx.query<{ request_hash: string }>(
          'SELECT request_hash FROM whaleu_profile.avatar_command_cancellations WHERE actor_id=$1 AND client_request_id=$2',
          [actor, requestId],
        )
      ).rows[0]?.request_hash ?? null
    );
  }
  async reserveCommand(actor: string, tx: PoolClient): Promise<void> {
    const row = (
      await tx.query<{ daily: number; recent: number }>(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now), bounds AS MATERIALIZED (
      SELECT date_trunc('day',now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' day_start,now-interval '1 minute' minute_start FROM instant), entries AS (
      SELECT committed_at created_at FROM whaleu_profile.avatar_command_receipts WHERE actor_id=$1
      UNION ALL SELECT created_at FROM whaleu_profile.avatar_command_cancellations WHERE actor_id=$1)
      SELECT count(*) FILTER(WHERE created_at>=day_start)::integer daily,count(*) FILTER(WHERE created_at>minute_start)::integer recent
      FROM entries CROSS JOIN bounds WHERE created_at>=least(day_start,minute_start)`,
        [actor],
      )
    ).rows[0];
    if (!row || row.daily >= 100 || row.recent >= 10)
      throw new ApplicationError('MEDIA_RATE_LIMITED');
  }
  async cancelCommand(
    actor: string,
    requestId: string,
    requestHash: string,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      'INSERT INTO whaleu_profile.avatar_command_cancellations(actor_id,client_request_id,request_hash) VALUES($1,$2,$3)',
      [actor, requestId, requestHash],
    );
  }
  async replace(definition: AvatarDefinition, tx: PoolClient): Promise<void> {
    await tx.query(
      "INSERT INTO whaleu_profile.avatar_definitions(id,actor_id,slot,source,envelope,digest,binding_id,authority) VALUES($1,$2,'avatar',$3::jsonb,$4::jsonb,$5,$6,$7)",
      [
        definition.id,
        definition.actor_id,
        JSON.stringify(definition.source),
        JSON.stringify(definition.envelope),
        definition.digest,
        definition.binding_id,
        definition.authority,
      ],
    );
    await tx.query(
      'INSERT INTO whaleu_profile.avatar_current(actor_id,appearance_id) VALUES($1,$2) ON CONFLICT(actor_id) DO UPDATE SET appearance_id=excluded.appearance_id',
      [definition.actor_id, definition.id],
    );
  }
  async commitReceipt(
    actor: string,
    command: AvatarCommand,
    appearanceId: string,
    revision: number,
    tx: PoolClient,
  ): Promise<AvatarReceipt> {
    await tx.query(
      'INSERT INTO whaleu_profile.avatar_command_receipts(actor_id,client_request_id,request_hash,resulting_revision,appearance_id) VALUES($1,$2,$3,$4,$5)',
      [
        actor,
        command.clientRequestId,
        avatarCommandHash(actor, command),
        revision,
        appearanceId,
      ],
    );
    return (await this.receipt(actor, command.clientRequestId, tx))!;
  }
}
