import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../database/transaction-deadlines.js';
import type { ExactObject } from './contracts.js';
import type { MediaIntentReceipt } from './intent-repository.js';

const MAX_ATTEMPTS = 5;
const ACTIVE = [
  'prepared',
  'upload_observed',
  'sealing',
  'processing',
  'awaiting_review',
];
interface IntentRow {
  id: string;
  state: string;
  generation: string;
  expires_at: Date;
  expired: boolean;
}
export interface MediaJobLease {
  readonly id: string;
  readonly intentId: string;
  readonly kind: 'seal' | 'process' | 'review' | 'reconcile' | 'cleanup';
  readonly generation: string;
  readonly token: string;
  readonly attempt: number;
  readonly objectAttemptId: string | null;
}
export interface MediaCleanupLease {
  readonly id: string;
  readonly token: string;
  readonly attempt: number;
  readonly object: ExactObject;
}
/** Trusted, synchronous proof verifier supplied by the storage orchestration.
 * It must bind an opaque proof to the exact locator and managed transaction,
 * prove every possible writer has stopped and cannot restart, and enroll any
 * mandatory final validation/deadline. Time elapsed or abort requested is NOT
 * quiescence. It must perform no network/storage effect or business callback. */
export interface MediaCleanupQuiescenceVerifier {
  require(proof: unknown, object: ExactObject, tx: PoolClient): void;
}
/** Database protocol only, deliberately not an activated worker or readiness issuer.
 * Caller acquires Safety first and any required owner gates BEFORE this repository.
 * No method opens storage or calls a business owner. Commit a claim before effects;
 * settle in a NEW managed transaction. Tokens are server-owned, never HTTP input.
 *
 * Recovery is limited to recorded exact versions, including planned derivatives
 * from migration 0072. Unobserved staging versions still require enumeration.
 * This class is not complete orphan recovery or a safe processor by itself.
 */
export class MediaLifecycleRepository {
  constructor(
    private readonly cleanupQuiescence?: MediaCleanupQuiescenceVerifier,
  ) {}
  async status(
    actorAccountId: string,
    intentId: string,
    tx: PoolClient,
  ): Promise<MediaIntentReceipt> {
    return this.receipt(await this.intent(actorAccountId, intentId, tx));
  }

  async finalize(
    actorAccountId: string,
    intentId: string,
    tx: PoolClient,
  ): Promise<MediaIntentReceipt> {
    const intent = await this.intent(actorAccountId, intentId, tx);
    if (!ACTIVE.includes(intent.state) || intent.expired)
      return this.receipt(intent);
    if (intent.state !== 'prepared' && intent.state !== 'upload_observed')
      return this.receipt(intent);
    registerTransactionDeadline(
      tx,
      intent.expires_at.getTime(),
      'MEDIA_UNAVAILABLE',
    );
    // Observation comes only from a trusted storage observation adapter. Client
    // finalize never supplies a locator, version, hash or scanner assertion.
    const attempt = (
      await tx.query<{ id: string }>(
        `SELECT id FROM whaleu_media.object_attempts
      WHERE intent_id=$1 AND generation=$2 AND state='observed'
      AND source_version IS NOT NULL AND sealed_version IS NOT NULL FOR UPDATE`,
        [intent.id, intent.generation],
      )
    ).rows[0];
    if (!attempt) throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (intent.state === 'prepared')
      await tx.query(
        `UPDATE whaleu_media.upload_intents
      SET state='upload_observed',updated_at=clock_timestamp() WHERE id=$1`,
        [intent.id],
      );
    await tx.query(
      `UPDATE whaleu_media.upload_intents SET state='sealing',updated_at=clock_timestamp() WHERE id=$1`,
      [intent.id],
    );
    await tx.query(
      `INSERT INTO whaleu_media.jobs(id,kind,effect_key,intent_id,object_attempt_id,expected_generation)
      VALUES($1,'seal',$2,$3,$4,$5) ON CONFLICT(effect_key) DO NOTHING`,
      [
        randomUUID(),
        `seal:${intent.id}:${intent.generation}`,
        intent.id,
        attempt.id,
        intent.generation,
      ],
    );
    return this.receipt({ ...intent, state: 'sealing' });
  }

  async cancel(
    actorAccountId: string,
    intentId: string,
    tx: PoolClient,
  ): Promise<MediaIntentReceipt> {
    const intent = await this.intent(actorAccountId, intentId, tx);
    // Any immutable binding means the owner, rather than upload cancellation,
    // owns the deletion path, including previously detached bindings.
    await this.lockUnboundAssets(intent.id, false, tx);
    if (!ACTIVE.includes(intent.state) && intent.state !== 'ready')
      return this.receipt(intent);
    await this.stageKnownCleanup(intent.id, tx);
    await this.revokeIngress(intent.id, tx);
    // Requires the S1 migration to allow terminal invalidation from every active
    // state (0070 allowed generation changes only before sealing).
    const next = intent.state === 'ready' ? 'cleanup_pending' : 'cancelled';
    await tx.query(
      `UPDATE whaleu_media.upload_intents SET state=$2,generation=generation+1,
      updated_at=clock_timestamp() WHERE id=$1`,
      [intent.id, next],
    );
    await tx.query(
      `UPDATE whaleu_media.jobs SET status='cancelled',lease_token=NULL,lease_until=NULL
      WHERE intent_id=$1 AND status IN ('pending','retryable','leased','failed')`,
      [intent.id],
    );
    await tx.query(
      `UPDATE whaleu_media.quota_reservations SET released_at=clock_timestamp()
      WHERE intent_id=$1 AND released_at IS NULL`,
      [intent.id],
    );
    return this.receipt({ ...intent, state: next });
  }

  /** Called only after the business owner atomically detached every live binding.
   * The caller has already locked the owner, then intent/assets/bindings. */
  async detachedOwnerIntent(intentId: string, tx: PoolClient): Promise<void> {
    this.managed(tx);
    const intent = (
      await tx.query<IntentRow>(
        'SELECT * FROM whaleu_media.upload_intents WHERE id=$1 FOR UPDATE',
        [intentId],
      )
    ).rows[0];
    if (!intent) throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.lockUnboundAssets(intent.id, true, tx);
    await this.stageKnownCleanup(intent.id, tx);
    await this.revokeIngress(intent.id, tx);
    if (intent.state === 'ready')
      await tx.query(
        "UPDATE whaleu_media.upload_intents SET state='cleanup_pending',generation=generation+1,updated_at=clock_timestamp() WHERE id=$1",
        [intent.id],
      );
    await tx.query(
      'UPDATE whaleu_media.quota_reservations SET released_at=clock_timestamp() WHERE intent_id=$1 AND released_at IS NULL',
      [intent.id],
    );
  }

  async claimJob(
    kind: MediaJobLease['kind'],
    tx: PoolClient,
  ): Promise<MediaJobLease | null> {
    this.managed(tx);
    // All lifecycle paths lock intent before job, avoiding cancel/settle inversion.
    const candidate = (
      await tx.query<{ id: string; expires_at: Date }>(
        `SELECT i.id,i.expires_at FROM whaleu_media.upload_intents i
      WHERE i.state IN ('sealing','processing','awaiting_review') AND i.expires_at>clock_timestamp()
      AND EXISTS(SELECT 1 FROM whaleu_media.jobs j WHERE j.intent_id=i.id AND j.kind=$1
        AND j.expected_generation=i.generation AND j.attempt<$2 AND
        ((j.status IN ('pending','retryable') AND j.next_attempt_at<=clock_timestamp()) OR
         (j.status='leased' AND j.lease_until<=clock_timestamp())))
      ORDER BY i.id FOR UPDATE OF i SKIP LOCKED LIMIT 1`,
        [kind, MAX_ATTEMPTS],
      )
    ).rows[0];
    if (!candidate) return null;
    registerTransactionDeadline(
      tx,
      candidate.expires_at.getTime(),
      'MEDIA_UNAVAILABLE',
    );
    const token = randomUUID();
    const row = (
      await tx.query<{
        id: string;
        intent_id: string;
        kind: MediaJobLease['kind'];
        expected_generation: string;
        attempt: number;
        object_attempt_id: string | null;
        lease_until: Date;
      }>(
        `UPDATE whaleu_media.jobs j
      SET status='leased',lease_token=$3,lease_until=clock_timestamp()+interval '60 seconds',attempt=attempt+1
      WHERE j.id=(SELECT id FROM whaleu_media.jobs WHERE intent_id=$1 AND kind=$2
        AND expected_generation=(SELECT generation FROM whaleu_media.upload_intents WHERE id=$1)
        AND attempt<$4 AND ((status IN ('pending','retryable') AND next_attempt_at<=clock_timestamp())
        OR (status='leased' AND lease_until<=clock_timestamp())) ORDER BY next_attempt_at,id
        FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING j.*`,
        [candidate.id, kind, token, MAX_ATTEMPTS],
      )
    ).rows[0];
    if (row)
      registerTransactionDeadline(
        tx,
        row.lease_until.getTime(),
        'MEDIA_UNAVAILABLE',
      );
    return row
      ? Object.freeze({
          id: row.id,
          intentId: row.intent_id,
          kind: row.kind,
          generation: row.expected_generation,
          token,
          attempt: row.attempt,
          objectAttemptId: row.object_attempt_id,
        })
      : null;
  }

  /** Settles queue bookkeeping only. Does not publish a manifest or advance an
   * intent. A concrete worker must persist its own validated result in the same
   * transaction and roll back if this returns false. No storage callback here. */
  async settleJob(
    lease: MediaJobLease,
    result: 'succeeded' | 'retryable' | 'failed',
    tx: PoolClient,
  ): Promise<boolean> {
    this.managed(tx);
    const intent = (
      await tx.query<IntentRow>(
        `SELECT *,expires_at<=clock_timestamp() AS expired
      FROM whaleu_media.upload_intents WHERE id=$1 FOR UPDATE`,
        [lease.intentId],
      )
    ).rows[0];
    if (
      !intent ||
      intent.generation !== lease.generation ||
      intent.expired ||
      !ACTIVE.includes(intent.state)
    )
      return false;
    registerTransactionDeadline(
      tx,
      intent.expires_at.getTime(),
      'MEDIA_UNAVAILABLE',
    );
    const settled = await tx.query<{ lease_until: Date }>(
      `WITH previous AS (
      SELECT id,lease_until FROM whaleu_media.jobs WHERE id=$1 FOR UPDATE)
      UPDATE whaleu_media.jobs j SET
      status=CASE WHEN $5='retryable' AND attempt>=$6 THEN 'failed' ELSE $5 END,
      next_attempt_at=clock_timestamp()+make_interval(secs=>least(300,power(2,least(8,attempt))::integer)),
      lease_token=NULL,lease_until=NULL
      FROM previous WHERE j.id=previous.id AND j.id=$1 AND intent_id=$2 AND expected_generation=$3 AND lease_token=$4
      AND status='leased' AND j.lease_until>clock_timestamp() RETURNING previous.lease_until`,
      [
        lease.id,
        lease.intentId,
        lease.generation,
        lease.token,
        result,
        MAX_ATTEMPTS,
      ],
    );
    const previousLease = settled.rows[0];
    if (previousLease)
      registerTransactionDeadline(
        tx,
        previousLease.lease_until.getTime(),
        'MEDIA_UNAVAILABLE',
      );
    return settled.rows.length === 1;
  }

  /** Bounded recovery pass. Expiration revokes generation before later workers
   * can settle. Caller repeats in separate transactions until no candidate.
   * Does not claim the storage effects themselves have stopped or disappeared. */
  async expireOne(tx: PoolClient): Promise<boolean> {
    this.managed(tx);
    const row = (
      await tx.query<{
        id: string;
        state: string;
      }>(`SELECT i.id,i.state FROM whaleu_media.upload_intents i
      WHERE (i.state IN ('prepared','upload_observed','sealing','processing','awaiting_review')
        AND i.expires_at<=clock_timestamp())
      OR (i.state='ready' AND (EXISTS (SELECT 1 FROM whaleu_media.assets a
        WHERE a.intent_id=i.id AND a.created_at<=clock_timestamp()-interval '24 hours')
        OR EXISTS (SELECT 1 FROM whaleu_media.assets a JOIN whaleu_community.media_drafts d
          ON d.id=a.resource_id AND d.actor_id=a.actor_id WHERE a.intent_id=i.id AND d.expires_at<=clock_timestamp()))
        AND NOT EXISTS (SELECT 1 FROM whaleu_media.bindings b
          JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE a.intent_id=i.id))
      ORDER BY i.expires_at,i.id
      FOR UPDATE OF i SKIP LOCKED LIMIT 1`)
    ).rows[0];
    if (!row) return false;
    await this.lockUnboundAssets(row.id, false, tx);
    await this.stageKnownCleanup(row.id, tx);
    await this.revokeIngress(row.id, tx);
    await tx.query(
      `UPDATE whaleu_media.upload_intents SET state=$2,generation=generation+1,
      updated_at=clock_timestamp() WHERE id=$1`,
      [row.id, row.state === 'ready' ? 'cleanup_pending' : 'expired'],
    );
    await tx.query(
      `UPDATE whaleu_media.jobs SET status='cancelled',lease_token=NULL,lease_until=NULL
      WHERE intent_id=$1 AND status IN ('pending','retryable','leased','failed')`,
      [row.id],
    );
    await tx.query(
      `UPDATE whaleu_media.quota_reservations SET released_at=clock_timestamp()
      WHERE intent_id=$1 AND released_at IS NULL`,
      [row.id],
    );
    return true;
  }

  /** A fifth crashed lease must not stay misleadingly in-flight forever. This
   * does not schedule a sixth effect; unresolved cleanup is retained for review. */
  async exhaustExpiredLeases(tx: PoolClient): Promise<void> {
    this.managed(tx);
    await tx.query(
      `UPDATE whaleu_media.jobs SET status='failed',lease_token=NULL,lease_until=NULL
      WHERE id IN (SELECT id FROM whaleu_media.jobs WHERE status='leased'
        AND lease_until<=clock_timestamp() AND attempt>=$1 ORDER BY id
        FOR UPDATE SKIP LOCKED LIMIT 100)`,
      [MAX_ATTEMPTS],
    );
    await tx.query(
      `UPDATE whaleu_media.cleanup_obligations SET state='retained',lease_token=NULL,lease_until=NULL
      WHERE id IN (SELECT id FROM whaleu_media.cleanup_obligations WHERE state='deleting'
        AND lease_until<=clock_timestamp() AND attempt>=$1 ORDER BY id
        FOR UPDATE SKIP LOCKED LIMIT 100)`,
      [MAX_ATTEMPTS],
    );
  }

  private async revokeIngress(intentId: string, tx: PoolClient): Promise<void> {
    await tx.query(
      `UPDATE whaleu_media.upload_ingress SET writer_state='retiring'
      WHERE intent_id=$1 AND writer_state='writing'`,
      [intentId],
    );
  }

  /** Durable obligation INSERT precedes any possible storage delete. Unknown
   * versions stay unresolved; absence of a row is never proof of object absence. */
  private async stageKnownCleanup(
    intentId: string,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO whaleu_media.cleanup_obligations
      (id,effect_key,object_attempt_id,provider,environment,bucket,object_key,object_version,reason,not_before)
      SELECT gen_random_uuid(),'cleanup:'||a.id||':'||o.kind,a.id,a.provider,a.environment,
        o.bucket,o.key,o.version,'intent-cancelled',clock_timestamp()+interval '2 minutes'
      FROM whaleu_media.object_attempts a CROSS JOIN LATERAL (VALUES
        ('staging',a.staging_bucket,a.staging_key,a.source_version),
        ('sealed',a.sealed_bucket,a.sealed_key,a.sealed_version)) o(kind,bucket,key,version)
      WHERE a.intent_id=$1 AND o.version IS NOT NULL
      ON CONFLICT(provider,environment,bucket,object_key,object_version) DO NOTHING`,
      [intentId],
    );
    await tx.query(
      `INSERT INTO whaleu_media.cleanup_obligations
      (id,effect_key,derived_attempt_id,provider,environment,bucket,object_key,object_version,reason,not_before)
      SELECT gen_random_uuid(),'cleanup:derived:'||d.id,d.id,d.provider,d.environment,
        d.bucket,d.object_key,d.object_version,'intent-terminal',clock_timestamp()+interval '2 minutes'
      FROM whaleu_media.derived_object_attempts d WHERE d.intent_id=$1
      ON CONFLICT(provider,environment,bucket,object_key,object_version) DO NOTHING`,
      [intentId],
    );
    await tx.query(
      `INSERT INTO whaleu_media.cleanup_obligations
      (id,effect_key,asset_id,variant_name,provider,environment,bucket,object_key,object_version,reason,not_before)
      SELECT gen_random_uuid(),'cleanup:'||v.asset_id||':'||v.variant_name,v.asset_id,v.variant_name,
        v.provider,v.environment,v.bucket,v.object_key,v.object_version,'intent-cancelled',clock_timestamp()+interval '2 minutes'
      FROM whaleu_media.variants v JOIN whaleu_media.assets a ON a.id=v.asset_id WHERE a.intent_id=$1
      ON CONFLICT(provider,environment,bucket,object_key,object_version) DO NOTHING`,
      [intentId],
    );
  }

  async claimCleanup(tx: PoolClient): Promise<MediaCleanupLease | null> {
    this.managed(tx);
    // Fence cleanup against attachment using the same intent-first order as
    // cancellation. This narrow collector intentionally handles terminal intents
    // only; retention cleanup for live assets needs a different owner protocol.
    const candidate = (
      await tx.query<{ id: string }>(
        `SELECT i.id FROM whaleu_media.upload_intents i
      WHERE i.state IN ('cancelled','expired','rejected','cleanup_pending','deleting','deleted')
      AND NOT EXISTS(SELECT 1 FROM whaleu_media.assets a JOIN whaleu_media.bindings b ON b.asset_id=a.id
        WHERE a.intent_id=i.id AND b.detached_at IS NULL)
      AND EXISTS(SELECT 1 FROM whaleu_media.cleanup_obligations c
        LEFT JOIN whaleu_media.object_attempts o ON o.id=c.object_attempt_id
        LEFT JOIN whaleu_media.assets a ON a.id=c.asset_id
        LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
        LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id
        LEFT JOIN whaleu_media.object_attempts wa ON wa.id=w.object_attempt_id
        WHERE coalesce(o.intent_id,a.intent_id,d.intent_id,wa.intent_id)=i.id AND c.attempt<$1 AND
          ((c.state IN ('pending','retryable') AND c.not_before<=clock_timestamp()) OR
           (c.state='deleting' AND c.lease_until<=clock_timestamp())))
      ORDER BY i.id FOR UPDATE OF i SKIP LOCKED LIMIT 1`,
        [MAX_ATTEMPTS],
      )
    ).rows[0];
    if (!candidate) return null;
    await this.lockUnboundAssets(candidate.id, true, tx);
    const token = randomUUID();
    const row = (
      await tx.query<{
        id: string;
        attempt: number;
        provider: string;
        environment: string;
        bucket: string;
        object_key: string;
        object_version: string;
        lease_until: Date;
      }>(
        `UPDATE whaleu_media.cleanup_obligations c
      SET state='deleting',lease_token=$1,lease_until=clock_timestamp()+interval '60 seconds',attempt=attempt+1
      WHERE id=(SELECT c.id FROM whaleu_media.cleanup_obligations c
        LEFT JOIN whaleu_media.object_attempts o ON o.id=c.object_attempt_id
        LEFT JOIN whaleu_media.assets a ON a.id=c.asset_id
        LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
        LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id
        LEFT JOIN whaleu_media.object_attempts wa ON wa.id=w.object_attempt_id
        WHERE coalesce(o.intent_id,a.intent_id,d.intent_id,wa.intent_id)=$3 AND c.attempt<$2 AND
        ((c.state IN ('pending','retryable') AND not_before<=clock_timestamp()) OR
         (c.state='deleting' AND c.lease_until<=clock_timestamp()))
        ORDER BY c.not_before,c.id FOR UPDATE OF c SKIP LOCKED LIMIT 1) RETURNING c.*`,
        [token, MAX_ATTEMPTS, candidate.id],
      )
    ).rows[0];
    if (row)
      registerTransactionDeadline(
        tx,
        row.lease_until.getTime(),
        'MEDIA_UNAVAILABLE',
      );
    return row
      ? Object.freeze({
          id: row.id,
          token,
          attempt: row.attempt,
          object: Object.freeze({
            provider: row.provider,
            environment: row.environment,
            bucket: row.bucket,
            key: row.object_key,
            version: row.object_version,
          }),
        })
      : null;
  }

  async settleCleanup(
    lease: MediaCleanupLease,
    result: 'confirmed-absent' | 'retryable',
    tx: PoolClient,
    quiescenceProof?: unknown,
  ): Promise<'deleted' | 'retained' | 'retryable' | 'stale'> {
    this.managed(tx);
    // Absence while a timed-out effect can still write is not final deletion.
    // Default closed: without an exact quiescence proof preserve an unresolved
    // retained obligation, even when the provider observed absence just now.
    let outcome: 'confirmed-absent' | 'retryable' | 'unresolved' = result;
    if (result === 'confirmed-absent') {
      if (!this.cleanupQuiescence || quiescenceProof === undefined)
        outcome = 'unresolved';
      // Verify below against the locked durable locator, never caller fields.
    }
    // A provider-local absence proof cannot account for an ingress writer in
    // another process. Lock the durable intent first and independently require
    // every recorded ingress writer to have real stopped evidence. Deadlines
    // and process heartbeats never satisfy this requirement.
    const cleanupIntent = (
      await tx.query<{ intent_id: string }>(
        `SELECT coalesce(o.intent_id,a.intent_id,d.intent_id,wa.intent_id) intent_id
       FROM whaleu_media.cleanup_obligations c
       LEFT JOIN whaleu_media.object_attempts o ON o.id=c.object_attempt_id
       LEFT JOIN whaleu_media.assets a ON a.id=c.asset_id
       LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
       LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id
       LEFT JOIN whaleu_media.object_attempts wa ON wa.id=w.object_attempt_id WHERE c.id=$1`,
        [lease.id],
      )
    ).rows[0];
    if (!cleanupIntent) return 'stale';
    const terminalIntent = (
      await tx.query<{ state: string }>(
        'SELECT state FROM whaleu_media.upload_intents WHERE id=$1 FOR UPDATE',
        [cleanupIntent.intent_id],
      )
    ).rows[0];
    const openWriters = await tx.query(
      `SELECT 1 FROM whaleu_media.upload_ingress_writers w
      JOIN whaleu_media.object_attempts a ON a.id=w.object_attempt_id
      WHERE a.intent_id=$1 AND w.state<>'retired' LIMIT 1`,
      [cleanupIntent.intent_id],
    );
    if (
      !terminalIntent ||
      ![
        'cancelled',
        'expired',
        'rejected',
        'cleanup_pending',
        'deleting',
        'deleted',
      ].includes(terminalIntent.state) ||
      openWriters.rowCount
    )
      outcome = 'unresolved';
    const settled = await tx.query<{
      lease_until: Date;
      provider: string;
      environment: string;
      bucket: string;
      object_key: string;
      object_version: string;
      settled_state: 'deleted' | 'retained' | 'retryable';
    }>(
      `WITH previous AS (
      SELECT id,lease_until,provider,environment,bucket,object_key,object_version FROM whaleu_media.cleanup_obligations WHERE id=$1 FOR UPDATE)
      UPDATE whaleu_media.cleanup_obligations c SET
      state=CASE WHEN $3='confirmed-absent' THEN 'deleted' WHEN $3='unresolved' OR attempt>=$4 THEN 'retained' ELSE 'retryable' END,
      confirmed_deleted_at=CASE WHEN $3='confirmed-absent' THEN clock_timestamp() ELSE NULL END,
      not_before=clock_timestamp()+make_interval(secs=>least(300,power(2,least(8,attempt))::integer)),
      lease_token=NULL,lease_until=NULL FROM previous WHERE c.id=previous.id AND c.id=$1 AND lease_token=$2 AND state='deleting'
      AND c.lease_until>clock_timestamp() RETURNING previous.*,c.state AS settled_state`,
      [lease.id, lease.token, outcome, MAX_ATTEMPTS],
    );
    const previousLease = settled.rows[0];
    if (previousLease) {
      if (outcome === 'confirmed-absent')
        this.cleanupQuiescence!.require(
          quiescenceProof,
          Object.freeze({
            provider: previousLease.provider,
            environment: previousLease.environment,
            bucket: previousLease.bucket,
            key: previousLease.object_key,
            version: previousLease.object_version,
          }),
          tx,
        );
      registerTransactionDeadline(
        tx,
        previousLease.lease_until.getTime(),
        'MEDIA_UNAVAILABLE',
      );
    }
    return previousLease?.settled_state ?? 'stale';
  }

  private async lockUnboundAssets(
    intentId: string,
    detachedAllowed: boolean,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      `SELECT id FROM whaleu_media.assets WHERE intent_id=$1 ORDER BY id FOR UPDATE`,
      [intentId],
    );
    const bindings = await tx.query(
      `SELECT b.id FROM whaleu_media.bindings b
      JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE a.intent_id=$1
      AND ($2=false OR b.detached_at IS NULL) ORDER BY b.id FOR SHARE OF b`,
      [intentId, detachedAllowed],
    );
    if (bindings.rows.length) throw new ApplicationError('MEDIA_UNAVAILABLE');
  }

  private managed(tx: PoolClient): void {
    if (!transactionReadEpoch(tx))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
  }
  private async intent(
    actor: string,
    id: string,
    tx: PoolClient,
  ): Promise<IntentRow> {
    this.managed(tx);
    const row = (
      await tx.query<IntentRow>(
        `SELECT *,expires_at<=clock_timestamp() AS expired
      FROM whaleu_media.upload_intents WHERE id=$1 AND actor_id=$2 FOR UPDATE`,
        [id, actor],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return row;
  }
  private receipt(row: IntentRow): MediaIntentReceipt {
    return Object.freeze({
      intentId: row.id,
      expiresAt: row.expires_at.getTime(),
      status:
        row.state === 'cancelled'
          ? 'cancelled'
          : row.state === 'rejected'
            ? 'rejected'
            : row.state === 'expired' || row.expired
              ? 'expired'
              : row.state === 'prepared'
                ? 'prepared'
                : ACTIVE.includes(row.state)
                  ? 'processing'
                  : 'unavailable',
    });
  }
}
