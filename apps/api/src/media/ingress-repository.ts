import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../database/transaction-deadlines.js';
import { requireCurrentMediaSession } from '../identity/current-media-session.js';
import type { CurrentMediaSession } from '../identity/current-media-session.js';
import {
  exactObjectSchema,
  MEDIA_MAX_INPUT_BYTES,
  mediaIdSchema,
} from './contracts.js';
import type { ExactObject } from './contracts.js';
import {
  mediaGrantSchema,
  mediaUploadObservedSchema,
  prepareMediaV2Schema,
} from './contracts-v2.js';
import type {
  MediaUploadGrant,
  MediaUploadObserved,
  PrepareMediaV2Input,
} from './contracts-v2.js';
import { lockMediaActor } from './intent-repository.js';
import type {
  MediaIngressClaim,
  MediaIngressPlanningPort,
} from './application-v2.js';
import type { StoredObjectMeasurement } from './storage-port.js';
import type { MediaPrepareScope } from './prepare-scope.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { MediaRequiredProof } from './required-proof.js';
import {
  prepareMediaV3Schema,
  mediaMemberRequestHash,
} from './contracts-v3.js';
import type { PrepareMediaV3Input } from './contracts-v3.js';
import { lockMediaBatchesForIntents } from './batch-locks.js';

interface Intent {
  id: string;
  actor_id: string;
  client_request_id: string;
  generation: string;
  state: string;
  expires_at: Date;
  declared_bytes: string;
  declared_mime: 'image/jpeg' | 'image/png';
  declared_sha256: string;
  resource_id: string;
  scope_revision: string;
  ordinal: number;
  request_hash: string;
}
interface Ingress {
  object_attempt_id: string;
  intent_id: string;
  generation: string;
  grant_id: string;
  grant_session_id: string;
  grant_expires_at: Date;
  writer_state: string;
  writer_token: string | null;
  writer_instance_id: string | null;
  writer_deadline: Date | null;
  transfer_attempt_count: number;
}
interface Attempt {
  id: string;
  provider: string;
  environment: string;
  staging_bucket: string;
  staging_key: string;
  source_version: string;
  sealed_bucket: string;
  sealed_key: string;
  sealed_version: string;
}
const exact = (a: Attempt, which: 'staging' | 'sealed'): ExactObject =>
  exactObjectSchema.parse({
    provider: a.provider,
    environment: a.environment,
    bucket: which === 'staging' ? a.staging_bucket : a.sealed_bucket,
    key: which === 'staging' ? a.staging_key : a.sealed_key,
    version: which === 'staging' ? a.source_version : a.sealed_version,
  });
export interface MediaIngressGrantBlocked {
  readonly blocked: 'MEDIA_UPLOAD_IN_FLIGHT' | 'MEDIA_RECONCILE_NEEDED';
}
export class MediaIngressRepository {
  private readonly proof = new MediaRequiredProof();
  constructor(
    readonly planning: MediaIngressPlanningPort,
    private readonly protocolVersion: 2 | 3 = 2,
  ) {
    mediaIdSchema.parse(planning.writerInstanceId);
  }
  /** Nonlocking routing hint only; authority is re-established by scopes and the
   * locked canonical intent is matched below before granting anything. */
  async originalInput(
    actor: string,
    id: string,
    tx: PoolClient,
  ): Promise<PrepareMediaV2Input | PrepareMediaV3Input> {
    this.managed(tx);
    const row = (
      await tx.query<Intent & { client_draft_id: string; space_id: string }>(
        `SELECT i.*,d.client_draft_id,d.space_id FROM whaleu_media.upload_intents i
       JOIN whaleu_community.media_drafts d ON d.id=i.resource_id AND d.actor_id=i.actor_id
       WHERE i.id=$1 AND i.actor_id=$2 AND i.protocol_version=$3`,
        [mediaIdSchema.parse(id), actor, this.protocolVersion],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (this.protocolVersion === 3) {
      const member = (
        await tx.query<{
          batch_id: string;
          member_id: string;
          source_slot: number;
          identity: unknown;
        }>(
          `SELECT m.batch_id,m.member_id,m.source_slot,b.identity FROM whaleu_media.publication_batch_members m JOIN whaleu_media.publication_batches b ON b.id=m.batch_id WHERE m.intent_id=$1 AND m.actor_id=$2 AND m.state='live' AND b.state='editing'`,
          [id, actor],
        )
      ).rows[0];
      if (!member) throw new ApplicationError('MEDIA_UNAVAILABLE');
      return prepareMediaV3Schema.parse({
        protocolVersion: 3,
        batchId: member.batch_id,
        batchIdentity: member.identity,
        memberId: member.member_id,
        clientRequestId: row.client_request_id,
        purpose: 'community-post-image',
        draftId: row.client_draft_id,
        spaceId: row.space_id,
        slot: 'images',
        ordinal: member.source_slot,
        declaration: {
          bytes: Number(row.declared_bytes),
          mime: row.declared_mime,
          sha256: row.declared_sha256,
        },
      });
    }
    return prepareMediaV2Schema.parse({
      clientRequestId: row.client_request_id,
      purpose: 'community-post-image',
      draftId: row.client_draft_id,
      spaceId: row.space_id,
      slot: 'images',
      ordinal: 0,
      declaration: {
        bytes: Number(row.declared_bytes),
        mime: row.declared_mime,
        sha256: row.declared_sha256,
      },
    });
  }
  async grant(
    session: CurrentMediaSession,
    id: string,
    capability: MediaPrepareScope,
    scopes: MediaPrepareScopes,
    tx: PoolClient,
  ): Promise<MediaUploadGrant | MediaIngressGrantBlocked> {
    const intent = await this.authorizedIntent(
      session,
      id,
      capability,
      scopes,
      tx,
    );
    let ingress = await this.ingress(id, intent.generation, tx);
    const now = await this.now(tx);
    if (ingress?.writer_state === 'observed')
      throw new ApplicationError('MEDIA_NOT_READY');
    if (
      ingress &&
      ['writing', 'retiring', 'unknown'].includes(ingress.writer_state)
    ) {
      if (
        ingress.grant_session_id !== session.sessionId &&
        ingress.writer_state === 'writing'
      ) {
        // Commit revocation before reporting a blocked new session. Throwing in
        // this transaction would roll the revocation back and let the old
        // session finish. The application raises the error after commit.
        await tx.query(
          `UPDATE whaleu_media.upload_ingress SET writer_state='retiring'
          WHERE object_attempt_id=$1 AND grant_id=$2 AND writer_state='writing'`,
          [ingress.object_attempt_id, ingress.grant_id],
        );
        await this.proof.capture(tx);
      }
      return {
        blocked:
          ingress.writer_state === 'unknown'
            ? 'MEDIA_RECONCILE_NEEDED'
            : 'MEDIA_UPLOAD_IN_FLIGHT',
      };
    }
    if (ingress && ingress.transfer_attempt_count >= 5)
      throw new ApplicationError('MEDIA_RECONCILE_NEEDED');
    if (
      ingress?.grant_session_id === session.sessionId &&
      ingress.writer_state === 'idle' &&
      ingress.grant_expires_at.getTime() > now
    )
      return this.encodeGrant(intent, ingress, now);
    const grantId = randomUUID();
    const expires = Math.min(now + 5 * 60_000, intent.expires_at.getTime());
    if (!ingress) {
      const attemptId = randomUUID();
      const plan = this.planning.plan(attemptId);
      const staging = exactObjectSchema.parse(plan.staging),
        sealed = exactObjectSchema.parse(plan.sealed);
      if (
        staging.provider !== sealed.provider ||
        staging.environment !== sealed.environment ||
        JSON.stringify(staging) === JSON.stringify(sealed)
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      await tx.query(
        `INSERT INTO whaleu_media.object_attempts
        (id,intent_id,generation,effect_key,provider,environment,staging_bucket,staging_key,source_version,sealed_bucket,sealed_key,sealed_version,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'planned')`,
        [
          attemptId,
          id,
          intent.generation,
          `upload:${id}:${intent.generation}`,
          staging.provider,
          staging.environment,
          staging.bucket,
          staging.key,
          staging.version,
          sealed.bucket,
          sealed.key,
          sealed.version,
        ],
      );
      ingress = (
        await tx.query<Ingress>(
          `INSERT INTO whaleu_media.upload_ingress
        (object_attempt_id,intent_id,generation,grant_id,grant_session_id,grant_expires_at)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
          [
            attemptId,
            id,
            intent.generation,
            grantId,
            session.sessionId,
            new Date(expires),
          ],
        )
      ).rows[0];
    } else {
      ingress = (
        await tx.query<Ingress>(
          `UPDATE whaleu_media.upload_ingress SET grant_id=$3,grant_session_id=$4,
        grant_expires_at=$5,writer_state='idle' WHERE object_attempt_id=$1 AND grant_id=$2
        AND writer_state IN ('idle','retired') RETURNING *`,
          [
            ingress.object_attempt_id,
            ingress.grant_id,
            grantId,
            session.sessionId,
            new Date(expires),
          ],
        )
      ).rows[0];
    }
    if (!ingress) throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.proof.capture(tx);
    return this.encodeGrant(intent, ingress, now);
  }
  async admit(
    session: CurrentMediaSession,
    id: string,
    grantId: string,
    capability: MediaPrepareScope,
    scopes: MediaPrepareScopes,
    tx: PoolClient,
  ): Promise<MediaIngressClaim> {
    const intent = await this.authorizedIntent(
      session,
      id,
      capability,
      scopes,
      tx,
    );
    const ingress = await this.ingress(id, intent.generation, tx);
    const now = await this.now(tx);
    if (
      !ingress ||
      ingress.grant_id !== mediaIdSchema.parse(grantId) ||
      ingress.grant_session_id !== session.sessionId ||
      ingress.grant_expires_at.getTime() <= now
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (ingress.writer_state !== 'idle' || ingress.transfer_attempt_count >= 5)
      throw new ApplicationError(
        ingress.writer_state === 'unknown'
          ? 'MEDIA_RECONCILE_NEEDED'
          : 'MEDIA_UPLOAD_IN_FLIGHT',
      );
    // Never release occupancy because a deadline elapsed. Unknown old instances
    // remain charged until real quiescence evidence is supplied.
    if (
      (
        await tx.query(
          `SELECT 1 FROM whaleu_media.upload_ingress_writers w
      JOIN whaleu_media.object_attempts a ON a.id=w.object_attempt_id
      JOIN whaleu_media.upload_intents i ON i.id=a.intent_id
      WHERE i.actor_id=$1 AND w.state<>'retired' LIMIT 1`,
          [session.accountId],
        )
      ).rowCount
    )
      throw new ApplicationError('MEDIA_UPLOAD_IN_FLIGHT');
    const budget = (
      await tx.query<{ bytes: string; unresolved: number }>(
        `SELECT
      coalesce(sum(w.transferred_bytes),0)::text bytes,
      count(*) FILTER (WHERE w.state<>'retired')::integer unresolved
      FROM whaleu_media.upload_ingress_writers w JOIN whaleu_media.object_attempts a ON a.id=w.object_attempt_id
      JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE i.actor_id=$1
      AND w.created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [session.accountId],
      )
    ).rows[0];
    if (
      !budget ||
      BigInt(budget.bytes) + BigInt(intent.declared_bytes) + 131072n >
        100n * 1024n * 1024n
    )
      throw new ApplicationError('MEDIA_RATE_LIMITED');
    const attempt = (
      await tx.query<Attempt>(
        'SELECT * FROM whaleu_media.object_attempts WHERE id=$1 FOR UPDATE',
        [ingress.object_attempt_id],
      )
    ).rows[0];
    if (!attempt) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const writerToken = randomUUID();
    const scratch = exactObjectSchema.parse(
      this.planning.scratch(attempt.id, writerToken),
    );
    const staging = exact(attempt, 'staging'),
      sealed = exact(attempt, 'sealed');
    if (
      scratch.provider !== staging.provider ||
      scratch.environment !== staging.environment ||
      [staging, sealed].some(
        (object) => JSON.stringify(object) === JSON.stringify(scratch),
      )
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const writerDeadline = Math.min(
      now + 120_000,
      ingress.grant_expires_at.getTime(),
      intent.expires_at.getTime(),
      session.expiresAt,
    );
    await tx.query(
      `INSERT INTO whaleu_media.upload_ingress_writers
      (writer_token,object_attempt_id,writer_instance_id,provider,environment,bucket,object_key,object_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        writerToken,
        attempt.id,
        this.planning.writerInstanceId,
        scratch.provider,
        scratch.environment,
        scratch.bucket,
        scratch.key,
        scratch.version,
      ],
    );
    await tx.query(
      `INSERT INTO whaleu_media.cleanup_obligations
      (id,effect_key,ingress_writer_id,provider,environment,bucket,object_key,object_version,reason,not_before)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ingress-scratch',clock_timestamp())`,
      [
        randomUUID(),
        `cleanup:scratch:${writerToken}`,
        writerToken,
        scratch.provider,
        scratch.environment,
        scratch.bucket,
        scratch.key,
        scratch.version,
      ],
    );
    const changed = await tx.query(
      `UPDATE whaleu_media.upload_ingress SET writer_token=$3,writer_instance_id=$4,
      writer_deadline=$5,writer_state='writing',transfer_attempt_count=transfer_attempt_count+1
      WHERE object_attempt_id=$1 AND grant_id=$2 AND writer_state='idle' AND transfer_attempt_count<5`,
      [
        attempt.id,
        grantId,
        writerToken,
        this.planning.writerInstanceId,
        new Date(writerDeadline),
      ],
    );
    if (changed.rowCount !== 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
    registerTransactionDeadline(tx, writerDeadline, 'MEDIA_UNAVAILABLE');
    await this.proof.capture(tx);
    return Object.freeze({
      actorAccountId: session.accountId,
      sessionId: session.sessionId,
      intentId: id,
      attemptId: attempt.id,
      generation: intent.generation,
      grantId,
      writerToken,
      writerInstanceId: this.planning.writerInstanceId,
      writerDeadline,
      expectedBytes: Number(intent.declared_bytes),
      expectedMime: intent.declared_mime,
      expectedSha256: intent.declared_sha256,
      staging: Object.freeze(staging),
      sealed: Object.freeze(sealed),
      scratch: Object.freeze(scratch),
    });
  }
  async observe(
    session: CurrentMediaSession,
    claim: MediaIngressClaim,
    measurement: StoredObjectMeasurement,
    capability: MediaPrepareScope,
    scopes: MediaPrepareScopes,
    tx: PoolClient,
  ): Promise<MediaUploadObserved> {
    const intent = await this.authorizedIntent(
      session,
      claim.intentId,
      capability,
      scopes,
      tx,
    );
    const ingress = await this.ingress(intent.id, intent.generation, tx);
    const now = await this.now(tx);
    if (
      !ingress ||
      !this.matches(session, claim, intent, ingress) ||
      ingress.writer_state !== 'writing' ||
      !ingress.writer_deadline ||
      ingress.writer_deadline.getTime() <= now ||
      ingress.grant_expires_at.getTime() <= now ||
      measurement.bytes !== Number(intent.declared_bytes) ||
      measurement.sha256 !== intent.declared_sha256
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const attempt = (
      await tx.query<Attempt>(
        'SELECT * FROM whaleu_media.object_attempts WHERE id=$1 FOR UPDATE',
        [claim.attemptId],
      )
    ).rows[0];
    if (
      !attempt ||
      JSON.stringify(exact(attempt, 'staging')) !==
        JSON.stringify(exactObjectSchema.parse(measurement.object))
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      Math.min(
        ingress.writer_deadline.getTime(),
        ingress.grant_expires_at.getTime(),
      ),
      'MEDIA_UNAVAILABLE',
    );
    const changed = await tx.query(
      `UPDATE whaleu_media.upload_ingress SET writer_state='observed',observed_bytes=$5,observed_sha256=$6
      WHERE object_attempt_id=$1 AND grant_id=$2 AND writer_token=$3 AND grant_session_id=$4 AND writer_state='writing'`,
      [
        claim.attemptId,
        claim.grantId,
        claim.writerToken,
        session.sessionId,
        measurement.bytes,
        measurement.sha256,
      ],
    );
    if (changed.rowCount !== 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
    await tx.query(
      "UPDATE whaleu_media.object_attempts SET state='observed' WHERE id=$1 AND state='planned'",
      [claim.attemptId],
    );
    await tx.query(
      'UPDATE whaleu_media.quota_reservations SET observed_bytes=$2 WHERE intent_id=$1',
      [intent.id, measurement.bytes],
    );
    await this.proof.capture(tx);
    return mediaUploadObservedSchema.parse({
      version: 2,
      status: 'uploadObserved',
      intentId: intent.id,
      generation: intent.generation,
      grantId: claim.grantId,
      bytes: measurement.bytes,
      sha256: measurement.sha256,
      next: 'finalize',
    });
  }
  async retire(
    claim: MediaIngressClaim,
    proof: unknown,
    transferredBytes: number,
    tx: PoolClient,
  ): Promise<boolean> {
    this.managed(tx);
    await lockMediaBatchesForIntents([claim.intentId], tx, true);
    await lockMediaActor(claim.actorAccountId, tx);
    const intent = (
      await tx.query<Intent>(
        'SELECT * FROM whaleu_media.upload_intents WHERE id=$1 AND actor_id=$2 FOR UPDATE',
        [claim.intentId, claim.actorAccountId],
      )
    ).rows[0];
    if (!intent) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const ingress = (
      await tx.query<Ingress>(
        'SELECT * FROM whaleu_media.upload_ingress WHERE object_attempt_id=$1 FOR UPDATE',
        [claim.attemptId],
      )
    ).rows[0];
    if (
      !ingress ||
      ingress.writer_token !== claim.writerToken ||
      ingress.writer_instance_id !== claim.writerInstanceId ||
      ingress.grant_id !== claim.grantId ||
      ingress.grant_session_id !== claim.sessionId
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (
      !Number.isSafeInteger(transferredBytes) ||
      transferredBytes < 0 ||
      transferredBytes > MEDIA_MAX_INPUT_BYTES + 128 * 1024
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const stopped = proof !== undefined;
    if (stopped) this.planning.requireStopped(proof, claim, tx);
    await tx.query(
      `UPDATE whaleu_media.upload_ingress_writers SET state=CASE WHEN state='retired' THEN state ELSE $3 END,
      transferred_bytes=greatest(transferred_bytes,$4) WHERE writer_token=$1 AND writer_instance_id=$2`,
      [
        claim.writerToken,
        claim.writerInstanceId,
        stopped ? 'retired' : 'unknown',
        transferredBytes,
      ],
    );
    if (
      ingress.writer_state !== 'observed' &&
      ingress.writer_state !== 'retired'
    )
      await tx.query(
        `UPDATE whaleu_media.upload_ingress SET writer_state=$3 WHERE object_attempt_id=$1 AND writer_token=$2 AND writer_state<>'observed'`,
        [claim.attemptId, claim.writerToken, stopped ? 'retired' : 'unknown'],
      );
    return (
      ingress.transfer_attempt_count >= 5 &&
      ingress.writer_state !== 'observed' &&
      intent.state === 'prepared'
    );
  }
  private matches(
    session: CurrentMediaSession,
    claim: MediaIngressClaim,
    intent: Intent,
    ingress: Ingress,
  ): boolean {
    return (
      session.accountId === claim.actorAccountId &&
      session.sessionId === claim.sessionId &&
      ingress.grant_session_id === session.sessionId &&
      ingress.grant_id === claim.grantId &&
      ingress.writer_token === claim.writerToken &&
      ingress.writer_instance_id === claim.writerInstanceId &&
      intent.generation === claim.generation &&
      ingress.object_attempt_id === claim.attemptId
    );
  }
  private async authorizedIntent(
    session: CurrentMediaSession,
    id: string,
    capability: MediaPrepareScope,
    scopes: MediaPrepareScopes,
    tx: PoolClient,
  ): Promise<Intent> {
    requireCurrentMediaSession(session, tx);
    const issued = scopes.require(capability, tx);
    if (issued.scope.actorAccountId !== session.accountId)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await lockMediaBatchesForIntents([id], tx, true);
    if (this.protocolVersion === 3) {
      const member = (
        await tx.query(
          `SELECT 1 FROM whaleu_media.publication_batch_members m JOIN whaleu_media.publication_batches b ON b.id=m.batch_id WHERE m.intent_id=$1 AND m.actor_id=$2 AND m.state='live' AND b.state='editing'`,
          [id, session.accountId],
        )
      ).rowCount;
      if (member !== 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
    }
    await lockMediaActor(session.accountId, tx);
    const row = (
      await tx.query<Intent>(
        'SELECT * FROM whaleu_media.upload_intents WHERE id=$1 AND actor_id=$2 AND protocol_version=$3 FOR UPDATE',
        [mediaIdSchema.parse(id), session.accountId, this.protocolVersion],
      )
    ).rows[0];
    const input =
      this.protocolVersion === 3
        ? prepareMediaV3Schema.parse(issued.input)
        : prepareMediaV2Schema.parse(issued.input);
    if (
      !row ||
      row.state !== 'prepared' ||
      row.expires_at.getTime() <= (await this.now(tx)) ||
      row.resource_id !== issued.scope.serverScopeId ||
      row.scope_revision !== issued.scope.scopeRevision ||
      ('protocolVersion' in input &&
        (row.ordinal !== input.ordinal ||
          row.request_hash !==
            mediaMemberRequestHash(session.accountId, input.batchIdentity, {
              clientRequestId: input.clientRequestId,
              memberId: input.memberId,
              sourceSlot: input.ordinal,
              declaration: input.declaration,
            }))) ||
      row.client_request_id !== input.clientRequestId ||
      row.declared_sha256 !== input.declaration.sha256 ||
      Number(row.declared_bytes) !== input.declaration.bytes ||
      row.declared_mime !== input.declaration.mime
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      row.expires_at.getTime(),
      'MEDIA_UNAVAILABLE',
    );
    return row;
  }
  private async ingress(
    id: string,
    generation: string,
    tx: PoolClient,
  ): Promise<Ingress | undefined> {
    return (
      await tx.query<Ingress>(
        'SELECT * FROM whaleu_media.upload_ingress WHERE intent_id=$1 AND generation=$2 FOR UPDATE',
        [id, generation],
      )
    ).rows[0];
  }
  private encodeGrant(
    intent: Intent,
    ingress: Ingress,
    now: number,
  ): MediaUploadGrant {
    return mediaGrantSchema.parse({
      version: 1,
      strategy: 'authenticated-multipart-v1',
      intentId: intent.id,
      generation: intent.generation,
      grantId: ingress.grant_id,
      method: 'POST',
      fieldName: 'file',
      maxBytes: MEDIA_MAX_INPUT_BYTES,
      expectedBytes: Number(intent.declared_bytes),
      expectedMime: intent.declared_mime,
      expectedSha256: intent.declared_sha256,
      grantExpiresAt: ingress.grant_expires_at.getTime(),
      operationDeadlineAt: intent.expires_at.getTime(),
      serverNow: now,
    });
  }
  private managed(tx: PoolClient): void {
    if (!transactionReadEpoch(tx))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
  }
  private async now(tx: PoolClient): Promise<number> {
    this.managed(tx);
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]?.now.getTime();
    if (!now || !Number.isSafeInteger(now))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return now;
  }
}
