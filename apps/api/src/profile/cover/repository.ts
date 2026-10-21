import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import {
  coverCommandHash,
  coverPrepareHash,
  coverReceiptSchema,
  coverReviewEnvelopeSchema,
  coverSelectedSourceSchema,
  PROFILE_COVER_PROTOCOL,
} from './contracts.js';
import type {
  CoverCommand,
  CoverPrepare,
  CoverReceipt,
  CoverReviewEnvelope,
  CoverSelectedSource,
} from './contracts.js';
import { lockCoverActor, requireCoverCurrent } from './current-proof.js';
interface CoverDefinitionBase {
  id: string;
  actor_id: string;
  digest: string;
}
export interface SelfSelectionCoverDefinition extends CoverDefinitionBase {
  authority: 'self_selection';
  source: CoverSelectedSource;
  envelope: CoverReviewEnvelope;
  binding_id: string | null;
}
export type CoverDefinition = SelfSelectionCoverDefinition;
interface CoverDefinitionRow extends CoverDefinitionBase {
  authority: string;
  source: unknown;
  envelope: unknown;
  binding_id: string | null;
}
export interface CoverEdit {
  id: string;
  actor_id: string;
  client_request_id: string;
  expected_revision: number;
  scope_revision: string;
  request_hash: string;
  declaration: CoverPrepare['declaration'];
  expires_at: Date;
}
/** Stable server identity lets an exact Review be recovered with the same key. */
export function coverAppearanceId(actor: string, commandId: string): string {
  const bytes = createHash('sha256')
    .update(`whaleu:profile-cover:appearance:v1\n${actor}\n${commandId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export class ProfileCoverRepository {
  async current(
    actor: string,
    tx: PoolClient,
  ): Promise<CoverDefinition | null> {
    const row = (
      await tx.query<CoverDefinitionRow>(
        'SELECT d.* FROM whaleu_profile.cover_current c JOIN whaleu_profile.cover_definitions d ON d.id=c.appearance_id AND d.actor_id=c.actor_id WHERE c.actor_id=$1',
        [actor],
      )
    ).rows[0];
    if (!row) return null;
    if (row.authority !== 'self_selection')
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const source = coverSelectedSourceSchema.safeParse(row.source),
      envelope = coverReviewEnvelopeSchema.safeParse(row.envelope);
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
          'SELECT coalesce(h.revision,0) revision,p.public_id AS "profileId" FROM whaleu_profile.profiles p LEFT JOIN whaleu_profile.cover_heads h ON h.actor_id=p.account_id WHERE p.account_id=$1',
          [actor],
        )
      ).rows[0] ?? { revision: 0, profileId: null }
    );
  }
  /** Cover CAS is independent of nickname, avatar and profile-details revisions. */
  async updateInTransaction(
    actor: string,
    expectedRevision: number,
    change: () => Promise<unknown>,
    tx: PoolClient,
  ): Promise<{ revision: number }> {
    await lockCoverActor(actor, tx);
    await tx.query(
      'INSERT INTO whaleu_profile.profiles(account_id) VALUES($1) ON CONFLICT(account_id) DO NOTHING',
      [actor],
    );
    await tx.query(
      'INSERT INTO whaleu_profile.cover_heads(actor_id,revision) VALUES($1,0) ON CONFLICT(actor_id) DO NOTHING',
      [actor],
    );
    const row = (
      await tx.query<{ revision: number }>(
        'SELECT revision FROM whaleu_profile.cover_heads WHERE actor_id=$1 FOR UPDATE',
        [actor],
      )
    ).rows[0];
    if (
      !row ||
      row.revision !== expectedRevision ||
      row.revision === 2147483647
    )
      throw new ApplicationError('PROFILE_REVISION_CONFLICT');
    await change();
    return (
      await tx.query<{ revision: number }>(
        'UPDATE whaleu_profile.cover_heads SET revision=revision+1 WHERE actor_id=$1 RETURNING revision',
        [actor],
      )
    ).rows[0]!;
  }
  async prepare(
    actor: string,
    input: CoverPrepare,
    tx: PoolClient,
  ): Promise<CoverEdit> {
    await lockCoverActor(actor, tx);
    const hash = coverPrepareHash(actor, input);
    const previous = (
      await tx.query<CoverEdit>(
        'SELECT * FROM whaleu_profile.cover_edits WHERE actor_id=$1 AND client_request_id=$2',
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
        await tx.query<CoverEdit>(
          `INSERT INTO whaleu_profile.cover_edits(id,actor_id,client_request_id,expected_revision,scope_revision,request_hash,declaration,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,clock_timestamp()+interval '30 minutes') RETURNING *`,
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
    await requireCoverCurrent(actor, tx, edit.id);
    return edit;
  }
  async edit(
    actor: string,
    editId: string,
    tx: PoolClient,
  ): Promise<CoverEdit> {
    const row = (
      await tx.query<CoverEdit>(
        'SELECT * FROM whaleu_profile.cover_edits WHERE actor_id=$1 AND id=$2',
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
  ): Promise<CoverReceipt | null> {
    const row = (
      await tx.query<{ request_hash: string; resulting_revision: number }>(
        'SELECT request_hash,resulting_revision FROM whaleu_profile.cover_command_receipts WHERE actor_id=$1 AND client_request_id=$2',
        [actor, requestId],
      )
    ).rows[0];
    return row
      ? coverReceiptSchema.parse({
          protocol: PROFILE_COVER_PROTOCOL,
          clientRequestId: requestId,
          requestHash: row.request_hash,
          resultingRevision: row.resulting_revision,
          operation: 'select_cover',
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
          'SELECT request_hash FROM whaleu_profile.cover_command_cancellations WHERE actor_id=$1 AND client_request_id=$2',
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
      SELECT committed_at created_at FROM whaleu_profile.cover_command_receipts WHERE actor_id=$1
      UNION ALL SELECT created_at FROM whaleu_profile.cover_command_cancellations WHERE actor_id=$1)
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
      'INSERT INTO whaleu_profile.cover_command_cancellations(actor_id,client_request_id,request_hash) VALUES($1,$2,$3)',
      [actor, requestId, requestHash],
    );
  }
  async replace(definition: CoverDefinition, tx: PoolClient): Promise<void> {
    await tx.query(
      "INSERT INTO whaleu_profile.cover_definitions(id,actor_id,slot,source,envelope,digest,binding_id,authority) VALUES($1,$2,'cover',$3::jsonb,$4::jsonb,$5,$6,$7)",
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
    // The actor fence serializes absence. Avoid INSERT ... ON CONFLICT here:
    // PostgreSQL executes BEFORE INSERT even on replacement, while the SQL
    // transition guard intentionally distinguishes the first selection.
    const pointer = await tx.query(
      'UPDATE whaleu_profile.cover_current SET appearance_id=$2 WHERE actor_id=$1',
      [definition.actor_id, definition.id],
    );
    if (pointer.rowCount === 0)
      await tx.query(
        'INSERT INTO whaleu_profile.cover_current(actor_id,appearance_id) VALUES($1,$2)',
        [definition.actor_id, definition.id],
      );
  }
  async commitReceipt(
    actor: string,
    command: CoverCommand,
    appearanceId: string,
    revision: number,
    tx: PoolClient,
  ): Promise<CoverReceipt> {
    await tx.query(
      'INSERT INTO whaleu_profile.cover_command_receipts(actor_id,client_request_id,request_hash,resulting_revision,appearance_id) VALUES($1,$2,$3,$4,$5)',
      [
        actor,
        command.clientRequestId,
        coverCommandHash(actor, command),
        revision,
        appearanceId,
      ],
    );
    return (await this.receipt(actor, command.clientRequestId, tx))!;
  }
}
