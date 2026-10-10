import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { MEDIA_POLICY_VERSION } from './contracts.js';
import type { MediaPrepareScope } from './prepare-scope.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';

export interface MediaIntentReceipt {
  readonly intentId: string;
  readonly expiresAt: number;
  /** No ready claim is made by this preparation-only repository. */
  readonly status:
    | 'prepared'
    | 'processing'
    | 'cancelled'
    | 'expired'
    | 'rejected'
    | 'unavailable';
}
interface IntentRow {
  id: string;
  actor_id: string;
  canonical_intent_hash: string;
  state: string;
  expires_at: Date;
  generation: string;
}
/** Transactional preparation and recovery foundation. No HTTP activation,
 * grants, processing effects or asset approval. Caller holds Safety then current
 * owner authorization; every method refuses an unmanaged transaction. */
export class MediaIntentRepository {
  constructor(private readonly scopes: MediaPrepareScopes) {}
  async prepare(
    capability: MediaPrepareScope,
    tx: PoolClient,
  ): Promise<MediaIntentReceipt> {
    const { input, scope } = this.scopes.require(capability, tx);
    // Serialize all reservation changes for this account; same-key retry neither
    // allocates another object obligation nor consumes quota a second time.
    await this.actorLock(scope.actorAccountId, tx);
    const hash = createHash('sha256')
      .update('whaleu-media-intent:v1\n')
      .update(
        JSON.stringify({
          actor: scope.actorAccountId,
          requestId: input.clientRequestId,
          purpose: scope.purpose,
          draftId: input.draftId,
          spaceId: input.spaceId,
          serverScopeId: scope.serverScopeId,
          scopeRevision: scope.scopeRevision,
          audience: scope.audience,
          ownerKind: scope.ownerKind,
          resourceKind: scope.resourceKind,
          targetKind: scope.targetKind,
          contentVersion: scope.contentVersion,
          slot: scope.slot,
          ordinal: scope.ordinal,
          mime: input.declaration.mime,
          bytes: input.declaration.bytes,
          policyVersion: MEDIA_POLICY_VERSION,
        }),
      )
      .digest('hex');
    const existing = (
      await tx.query<IntentRow>(
        'SELECT * FROM whaleu_media.upload_intents WHERE actor_id=$1 AND client_request_id=$2 FOR UPDATE',
        [scope.actorAccountId, input.clientRequestId],
      )
    ).rows[0];
    if (existing) {
      if (existing.canonical_intent_hash !== hash)
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      return this.receipt(existing, tx);
    }
    const quota = (
      await tx.query<{ active: number; bytes: string }>(
        `SELECT
      (SELECT count(*)::integer FROM whaleu_media.upload_intents WHERE actor_id=$1 AND state IN ('prepared','upload_observed','sealing','processing','awaiting_review') AND expires_at>clock_timestamp()) AS active,
      (SELECT coalesce(sum(reserved_bytes),0)::text FROM whaleu_media.quota_reservations WHERE actor_id=$1 AND window_start=(clock_timestamp() AT TIME ZONE 'UTC')::date) AS bytes`,
        [scope.actorAccountId],
      )
    ).rows[0];
    if (
      !quota ||
      quota.active >= 3 ||
      BigInt(quota.bytes) + BigInt(input.declaration.bytes) >
        100n * 1024n * 1024n
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const id = randomUUID();
    const created = (
      await tx.query<IntentRow>(
        `INSERT INTO whaleu_media.upload_intents
      (id,actor_id,client_request_id,canonical_intent_hash,purpose,audience,owner_kind,resource_kind,target_kind,resource_id,content_version,scope_revision,slot,ordinal,policy_revision,declared_bytes,declared_mime,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,clock_timestamp()+interval '30 minutes') RETURNING *`,
        [
          id,
          scope.actorAccountId,
          input.clientRequestId,
          hash,
          scope.purpose,
          scope.audience,
          scope.ownerKind,
          scope.resourceKind,
          scope.targetKind,
          scope.serverScopeId,
          scope.contentVersion,
          scope.scopeRevision,
          scope.slot,
          scope.ordinal,
          MEDIA_POLICY_VERSION,
          input.declaration.bytes,
          input.declaration.mime,
        ],
      )
    ).rows[0];
    if (!created) throw new ApplicationError('MEDIA_UNAVAILABLE');
    await tx.query(
      `INSERT INTO whaleu_media.quota_reservations(intent_id,actor_id,window_start,reserved_bytes) VALUES($1,$2,(clock_timestamp() AT TIME ZONE 'UTC')::date,$3)`,
      [id, scope.actorAccountId, input.declaration.bytes],
    );
    return this.receipt(created, tx);
  }
  async status(
    actorAccountId: string,
    intentId: string,
    tx: PoolClient,
  ): Promise<MediaIntentReceipt> {
    this.managed(tx);
    const row = (
      await tx.query<IntentRow>(
        'SELECT * FROM whaleu_media.upload_intents WHERE id=$1 AND actor_id=$2 FOR SHARE',
        [intentId, actorAccountId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return this.receipt(row, tx);
  }
  private managed(tx: PoolClient): void {
    if (!transactionReadEpoch(tx))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
  }
  private async actorLock(actor: string, tx: PoolClient): Promise<void> {
    this.managed(tx);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `whaleu:media-reservation:v1:${actor}`,
    ]);
  }
  private async receipt(
    row: IntentRow,
    tx: PoolClient,
  ): Promise<MediaIntentReceipt> {
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]?.now.getTime();
    if (now === undefined || !Number.isFinite(now))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const expiresAt = row.expires_at.getTime();
    const status: MediaIntentReceipt['status'] =
      row.state === 'cancelled'
        ? 'cancelled'
        : row.state === 'rejected'
          ? 'rejected'
          : row.state === 'expired' || expiresAt <= now
            ? 'expired'
            : row.state === 'prepared'
              ? 'prepared'
              : [
                    'upload_observed',
                    'sealing',
                    'processing',
                    'awaiting_review',
                  ].includes(row.state)
                ? 'processing'
                : 'unavailable';
    return Object.freeze({ intentId: row.id, expiresAt, status });
  }
}
