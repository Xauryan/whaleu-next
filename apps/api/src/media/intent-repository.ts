import {
  reserveProfileRequestMarker,
  rejectProfileRequestMarker,
} from './profile-request-marker.js';
import { profileMediaRequestHash } from './contracts-profile.js';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { mediaRequestHash } from './contracts-v2.js';
import { mediaMemberRequestHash } from './contracts-v3.js';
import { mediaMemberRequestHash as discussionMemberHash } from './contracts-v4.js';
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
    const declaredSha256 =
      'sha256' in input.declaration ? input.declaration.sha256 : null;
    const v2 = declaredSha256 !== null;
    const profile = 'protocol' in input;
    const v3 = 'protocolVersion' in input;
    const protocol = profile ? 5 : v3 ? input.protocolVersion : v2 ? 2 : 1;
    const requestHash = profile
      ? profileMediaRequestHash(scope.actorAccountId, input)
      : v3
        ? (input.protocolVersion === 4
            ? discussionMemberHash
            : mediaMemberRequestHash)(
            scope.actorAccountId,
            input.batchIdentity,
            {
              clientRequestId: input.clientRequestId,
              memberId: input.memberId,
              sourceSlot: input.ordinal,
              declaration: input.declaration,
            },
          )
        : v2
          ? mediaRequestHash(scope.actorAccountId, input)
          : null;
    if (v3) {
      const batch = await tx.query(
        `SELECT id FROM whaleu_media.publication_batches WHERE id=$1 AND actor_id=$2 AND state='editing' AND server_scope_id=$3 AND scope_revision=$4 AND identity=$5::jsonb FOR UPDATE`,
        [
          input.batchId,
          scope.actorAccountId,
          scope.serverScopeId,
          scope.scopeRevision,
          JSON.stringify(input.batchIdentity),
        ],
      );
      if (batch.rowCount !== 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
    }
    // Serialize all reservation changes for this account; same-key retry neither
    // allocates another object obligation nor consumes quota a second time.
    await this.actorLock(scope.actorAccountId, tx);
    if (profile) {
      if (!requestHash) throw new ApplicationError('MEDIA_UNAVAILABLE');
      await reserveProfileRequestMarker(
        scope.actorAccountId,
        input.clientRequestId,
        requestHash,
        tx,
      );
    } else
      await rejectProfileRequestMarker(
        scope.actorAccountId,
        input.clientRequestId,
        tx,
      );
    const hash = createHash('sha256')
      .update(
        profile || v3
          ? `whaleu-media-intent:v${protocol}\n`
          : v2
            ? 'whaleu-media-intent:v2\n'
            : 'whaleu-media-intent:v1\n',
      )
      .update(
        JSON.stringify({
          actor: scope.actorAccountId,
          requestId: input.clientRequestId,
          purpose: scope.purpose,
          ...(profile
            ? { expectedRevision: input.expectedRevision }
            : { draftId: input.draftId, spaceId: input.spaceId }),
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
          ...(v2 ? { protocolVersion: protocol, sha256: declaredSha256 } : {}),
          ...(v3
            ? { batchId: input.batchId, memberId: input.memberId, requestHash }
            : {}),
        }),
      )
      .digest('hex');
    if (v2) {
      const fence = (
        await tx.query<{ request_hash: string; state: string }>(
          'SELECT request_hash,state FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2 FOR UPDATE',
          [scope.actorAccountId, input.clientRequestId],
        )
      ).rows[0];
      if (fence && fence.request_hash !== requestHash)
        throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
      if (
        fence?.state === 'cancelled_before_prepare' ||
        fence?.state === 'terminal'
      )
        throw new ApplicationError('MEDIA_REQUEST_CANCELLED');
      if (!fence) await reserveMediaRequestKey(scope.actorAccountId, tx);
    }
    const existing = (
      await tx.query<IntentRow>(
        'SELECT * FROM whaleu_media.upload_intents WHERE actor_id=$1 AND client_request_id=$2 FOR UPDATE',
        [scope.actorAccountId, input.clientRequestId],
      )
    ).rows[0];
    if (existing) {
      if (existing.canonical_intent_hash !== hash)
        throw new ApplicationError(
          v2 ? 'MEDIA_REQUEST_CONFLICT' : 'MEDIA_UNAVAILABLE',
        );
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
      (id,actor_id,client_request_id,canonical_intent_hash,purpose,audience,owner_kind,resource_kind,target_kind,resource_id,content_version,scope_revision,slot,ordinal,policy_revision,declared_bytes,declared_mime,expires_at,protocol_version,request_hash,declared_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,${scope.ownerKind === 'profile' ? '(SELECT expires_at FROM whaleu_profile.avatar_edits WHERE id=$10 AND actor_id=$2)' : "clock_timestamp()+interval '30 minutes'"},$18,$19,$20) RETURNING *`,
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
          protocol,
          requestHash,
          declaredSha256,
        ],
      )
    ).rows[0];
    if (!created) throw new ApplicationError('MEDIA_UNAVAILABLE');
    await tx.query(
      `INSERT INTO whaleu_media.quota_reservations(intent_id,actor_id,window_start,reserved_bytes) VALUES($1,$2,(clock_timestamp() AT TIME ZONE 'UTC')::date,$3)`,
      [id, scope.actorAccountId, input.declaration.bytes],
    );
    if (v2)
      await tx.query(
        `INSERT INTO whaleu_media.upload_request_fences(actor_id,client_request_id,request_hash,intent_id,state)
       VALUES($1,$2,$3,$4,'active')`,
        [scope.actorAccountId, input.clientRequestId, requestHash, id],
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
    await lockMediaActor(actor, tx);
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

/** Mutating request/reservation paths use the same actor lock. Read paths do not. */
export async function lockMediaActor(
  actor: string,
  tx: PoolClient,
): Promise<void> {
  if (!transactionReadEpoch(tx))
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `whaleu:media-reservation:v1:${actor}`,
  ]);
}
/** Includes cancelled-before-prepare keys. Retry of an existing key is free. */
export async function reserveMediaRequestKey(
  actor: string,
  tx: PoolClient,
): Promise<void> {
  const row = (
    await tx.query<{ daily: number; recent: number }>(
      `SELECT count(*)::integer daily,
       count(*) FILTER (WHERE created_at>clock_timestamp()-interval '1 minute')::integer recent
     FROM whaleu_media.upload_request_fences WHERE actor_id=$1
       AND created_at >= date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [actor],
    )
  ).rows[0];
  if (!row || row.daily >= 100 || row.recent >= 10)
    throw new ApplicationError('MEDIA_RATE_LIMITED');
}

/** Profile uses the shared reservations and exact intent foundation; its issuer
 * accepts only the independently versioned Profile prepare contract. */
export class ProfileMediaIntentRepository extends MediaIntentRepository {}
