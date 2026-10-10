import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../database/transaction-deadlines.js';
import { MediaRequiredProof } from './required-proof.js';
import type { MediaPrepareScopes } from './prepare-scope.js';
import type { MediaIntentRepository } from './intent-repository.js';
import { lockMediaActor, reserveMediaRequestKey } from './intent-repository.js';
import type { MediaLifecycleRepository } from './lifecycle-repository.js';
import type {
  RatingsDiscussionMediaAssetRepository,
  RatingsDiscussionBatchRow,
} from './ratings-discussion-asset-repository.js';
import {
  ratingsDiscussionBatchIdentitySchema,
  ratingsDiscussionBatchHash,
  ratingsDiscussionMemberPrepareSchema,
  ratingsDiscussionSealSchema,
  ratingsDiscussionSealedPlanHash,
  ratingsDiscussionBatchStatusSchema,
  ratingsDiscussionBatchRecoverySchema,
  ratingsDiscussionBatchMutationSchema,
  ratingsDiscussionRemoveMemberSchema,
  ratingsDiscussionBatchCancelRequestSchema,
} from './contracts-ratings-discussion.js';
import type {
  RatingsDiscussionBatchIdentity,
  RatingsDiscussionBatchStatus,
} from './contracts-ratings-discussion.js';
import { mediaIdSchema } from './contracts.js';
interface Batch extends RatingsDiscussionBatchRow {
  revision: string;
  consumed_parent: unknown | null;
}
/** Preparation/recovery only; the original RatingScopedCommands is the sole
 * consumer. Sealing never writes a comment, reply, Review, receipt or outbox. */
export class RatingsDiscussionMediaBatchRepository {
  private readonly proof = new MediaRequiredProof();
  constructor(
    private readonly scopes: MediaPrepareScopes,
    private readonly intents: MediaIntentRepository,
    private readonly assets: RatingsDiscussionMediaAssetRepository,
    private readonly lifecycle: MediaLifecycleRepository,
  ) {}
  async prepare(
    actor: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<RatingsDiscussionBatchStatus> {
    const identity = ratingsDiscussionBatchIdentitySchema.parse(raw),
      hash = ratingsDiscussionBatchHash(actor, identity);
    const scope = await this.scopes.authorizeRatingsDiscussionBatch(
      actor,
      identity,
      tx,
    );
    const hint = (
      await tx.query<{ id: string }>(
        'SELECT id FROM whaleu_media.ratings_discussion_batches WHERE actor_id=$1 AND batch_request_id=$2',
        [actor, identity.batchRequestId],
      )
    ).rows[0];
    if (hint) await this.lock(actor, hint.id, tx, false);
    await lockMediaActor(actor, tx);
    const fence = await this.requestFence(actor, identity.batchRequestId, tx);
    if (fence && fence.identity_hash !== hash)
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    if (fence?.state === 'cancelled_before_prepare')
      throw new ApplicationError('MEDIA_REQUEST_CANCELLED');
    const old = (
      await tx.query<{ id: string; identity_hash: string }>(
        'SELECT id,identity_hash FROM whaleu_media.ratings_discussion_batches WHERE actor_id=$1 AND batch_request_id=$2 FOR UPDATE NOWAIT',
        [actor, identity.batchRequestId],
      )
    ).rows[0];
    if (old) {
      if (
        old.identity_hash !== hash ||
        !fence ||
        fence.batch_id !== old.id ||
        fence.state !== 'recorded'
      )
        throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
      return this.status(actor, old.id, tx);
    }
    if (
      (
        await tx.query(
          `SELECT id FROM whaleu_media.ratings_discussion_batches WHERE actor_id=$1 AND state IN ('editing','sealed') AND expires_at>clock_timestamp() LIMIT 4`,
          [actor],
        )
      ).rows.length >= 3
    )
      throw new ApplicationError('MEDIA_RATE_LIMITED');
    if (fence) throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.reserveRequest(actor, identity.batchRequestId, tx);
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_media.ratings_discussion_batches(id,actor_id,batch_request_id,command_request_id,identity,identity_hash,server_scope_id,scope_revision,expires_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9::double precision/1000),$10)`,
      [
        id,
        actor,
        identity.batchRequestId,
        identity.commandRequestId,
        JSON.stringify(identity),
        hash,
        scope.serverScopeId,
        scope.scopeRevision,
        scope.expiresAt,
        randomUUID(),
      ],
    );
    await tx.query(
      "INSERT INTO whaleu_media.ratings_discussion_batch_request_fences(actor_id,batch_request_id,identity_hash,batch_id,state) VALUES($1,$2,$3,$4,'recorded')",
      [actor, identity.batchRequestId, hash, id],
    );
    return this.status(actor, id, tx);
  }
  /** Nonlocking immutable lookup; must be followed by current owner authorization
   * BEFORE any batch/member/intent/asset mutation lock. */
  async identity(
    actor: string,
    batchId: string,
    tx: PoolClient,
  ): Promise<RatingsDiscussionBatchIdentity> {
    this.managed(tx);
    const row = (
      await tx.query<{ identity: unknown }>(
        'SELECT identity FROM whaleu_media.ratings_discussion_batches WHERE id=$1 AND actor_id=$2',
        [mediaIdSchema.parse(batchId), actor],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return ratingsDiscussionBatchIdentitySchema.parse(row.identity);
  }
  async prepareMember(
    actor: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<string> {
    const input = ratingsDiscussionMemberPrepareSchema.parse(raw),
      capability = await this.scopes.authorizeRatingsDiscussion(
        actor,
        input,
        tx,
      );
    const { scope } = this.scopes.require(capability, tx),
      batch = await this.lock(actor, input.batchId, tx);
    if (
      batch.identity_hash !== input.batchIdentityHash ||
      batch.server_scope_id !== scope.serverScopeId ||
      batch.scope_revision !== scope.scopeRevision ||
      batch.state !== 'editing'
    )
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    const old = (
      await tx.query<{ input: unknown; intent_id: string; state: string }>(
        'SELECT input,intent_id,state FROM whaleu_media.ratings_discussion_members WHERE batch_id=$1 AND member_id=$2',
        [batch.id, input.memberId],
      )
    ).rows[0];
    if (old) {
      if (
        JSON.stringify(
          ratingsDiscussionMemberPrepareSchema.parse(old.input),
        ) !== JSON.stringify(input)
      )
        throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
      if (old.state !== 'live')
        throw new ApplicationError('MEDIA_REQUEST_CANCELLED');
      return old.intent_id;
    }
    const usage = (
      await tx.query<{ total: number; live: number }>(
        `SELECT count(*)::integer AS total,count(*) FILTER(WHERE state='live')::integer AS live FROM whaleu_media.ratings_discussion_members WHERE batch_id=$1`,
        [batch.id],
      )
    ).rows[0];
    if (
      !usage ||
      usage.total >= 128 ||
      usage.live >= (batch.identity.target.kind === 'reply' ? 3 : 9)
    )
      throw new ApplicationError('MEDIA_RATE_LIMITED');
    const receipt = await this.intents.prepare(capability, tx);
    await tx.query(
      `INSERT INTO whaleu_media.ratings_discussion_members(batch_id,member_id,actor_id,client_request_id,source_slot,input,intent_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        batch.id,
        input.memberId,
        actor,
        input.clientRequestId,
        input.sourceSlot,
        JSON.stringify(input),
        receipt.intentId,
      ],
    );
    await tx.query(
      'UPDATE whaleu_media.ratings_discussion_batches SET revision=$2 WHERE id=$1',
      [batch.id, randomUUID()],
    );
    return receipt.intentId;
  }
  async seal(
    actor: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<RatingsDiscussionBatchStatus> {
    const input = ratingsDiscussionSealSchema.parse(raw);
    await this.scopes.authorizeRatingsDiscussionBatch(
      actor,
      await this.identity(actor, input.batchId, tx),
      tx,
    );
    const batch = await this.lock(actor, input.batchId, tx);
    if (batch.identity_hash !== input.batchIdentityHash)
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    if (batch.state === 'sealed') {
      const status = await this.status(actor, batch.id, tx);
      if (
        JSON.stringify(
          status.sealedPlan?.orderedMembers.map((x) => x.memberId),
        ) !== JSON.stringify(input.orderedMemberIds)
      )
        throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
      return status;
    }
    if (batch.state !== 'editing' || batch.revision !== input.expectedRevision)
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    const live = (
      await tx.query<{ member_id: string }>(
        `SELECT member_id FROM whaleu_media.ratings_discussion_members WHERE batch_id=$1 AND state='live' ORDER BY member_id`,
        [batch.id],
      )
    ).rows;
    if (
      live.length !== input.orderedMemberIds.length ||
      live.some((x) => !input.orderedMemberIds.includes(x.member_id))
    )
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    const { rows } = await this.assets.inspectUnboundMembers(
      batch,
      input.orderedMemberIds,
      tx,
      true,
    );
    const plan = {
      batchId: batch.id,
      batchIdentityHash: batch.identity_hash,
      orderedMembers: rows.map((row, ordinal) => ({
        ordinal,
        memberId: input.orderedMemberIds[ordinal]!,
        assetId: row.id,
        manifestDigest: row.manifest_digest,
      })),
    };
    await tx.query(
      `UPDATE whaleu_media.ratings_discussion_batches SET state='sealed',revision=$2,sealed_plan=$3,sealed_plan_digest=$4 WHERE id=$1`,
      [
        batch.id,
        randomUUID(),
        JSON.stringify(plan),
        ratingsDiscussionSealedPlanHash(plan),
      ],
    );
    return this.status(actor, batch.id, tx);
  }
  async remove(
    actor: string,
    batchId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<RatingsDiscussionBatchStatus> {
    const input = ratingsDiscussionRemoveMemberSchema.parse(raw);
    await this.scopes.authorizeRatingsDiscussionBatch(
      actor,
      await this.identity(actor, batchId, tx),
      tx,
    );
    const batch = await this.lock(actor, batchId, tx);
    if (
      batch.state !== 'editing' ||
      batch.revision !== input.expectedRevision ||
      batch.identity_hash !== input.batchIdentityHash
    )
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    const member = (
      await tx.query<{ intent_id: string }>(
        `SELECT intent_id FROM whaleu_media.ratings_discussion_members WHERE batch_id=$1 AND member_id=$2 AND state='live' FOR UPDATE NOWAIT`,
        [batchId, input.memberId],
      )
    ).rows[0];
    if (!member) throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    await this.lifecycle.cancel(actor, member.intent_id, tx);
    await tx.query(
      `UPDATE whaleu_media.ratings_discussion_members SET state='removed' WHERE batch_id=$1 AND member_id=$2`,
      [batchId, input.memberId],
    );
    await tx.query(
      'UPDATE whaleu_media.ratings_discussion_batches SET revision=$2 WHERE id=$1',
      [batchId, randomUUID()],
    );
    return this.status(actor, batchId, tx);
  }
  /** Cancellation is metadata/lifecycle only; hidden owners remain cancellable.
   * A consumed batch stays historical and cannot erase a publication. */
  async cancel(
    actor: string,
    batchId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<RatingsDiscussionBatchStatus> {
    const input = ratingsDiscussionBatchMutationSchema.parse(raw),
      batch = await this.lock(actor, batchId, tx, false);
    if (batch.identity_hash !== input.batchIdentityHash)
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    if (batch.state === 'consumed' || batch.state === 'cancelled')
      return this.status(actor, batchId, tx);
    if (batch.revision !== input.expectedRevision)
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    const members = (
      await tx.query<{ intent_id: string }>(
        'SELECT intent_id FROM whaleu_media.ratings_discussion_members WHERE batch_id=$1 ORDER BY intent_id',
        [batchId],
      )
    ).rows;
    for (const member of members)
      await this.lifecycle.cancel(actor, member.intent_id, tx);
    await tx.query(
      `UPDATE whaleu_media.ratings_discussion_batches SET state='cancelled',revision=$2 WHERE id=$1`,
      [batchId, randomUUID()],
    );
    return this.status(actor, batchId, tx);
  }
  /** The authenticated Ratings owner reserves the original claim first. No
   * current content/context or provider is needed for durable cancellation. */
  async cancelRequest(
    actor: string,
    requestId: string,
    raw: unknown,
    tx: PoolClient,
  ) {
    this.managed(tx);
    mediaIdSchema.parse(requestId);
    const { identityHash } =
      ratingsDiscussionBatchCancelRequestSchema.parse(raw);
    const hint = (
      await tx.query<{ id: string }>(
        'SELECT id FROM whaleu_media.ratings_discussion_batches WHERE actor_id=$1 AND batch_request_id=$2',
        [actor, requestId],
      )
    ).rows[0];
    if (hint) await this.lock(actor, hint.id, tx, false);
    await lockMediaActor(actor, tx);
    const fence = await this.requestFence(actor, requestId, tx);
    if (fence && fence.identity_hash !== identityHash)
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    if (!fence) {
      await this.reserveRequest(actor, requestId, tx);
      await tx.query(
        "INSERT INTO whaleu_media.ratings_discussion_batch_request_fences(actor_id,batch_request_id,identity_hash,state) VALUES($1,$2,$3,'cancelled_before_prepare')",
        [actor, requestId, identityHash],
      );
    } else if (fence.state === 'recorded' && fence.batch_id) {
      const batch = await this.lock(actor, fence.batch_id, tx, false);
      await this.cancel(
        actor,
        batch.id,
        {
          protocol: 'ratings-discussion-media-v1',
          batchIdentityHash: identityHash,
          expectedRevision: batch.revision,
        },
        tx,
      );
    }
    return this.recover(actor, requestId, tx);
  }
  async recover(actor: string, requestId: string, tx: PoolClient) {
    this.managed(tx);
    mediaIdSchema.parse(requestId);
    await this.proof.capture(tx);
    const fence = await this.requestFence(actor, requestId, tx),
      row = (
        await tx.query<{ id: string; identity_hash: string }>(
          'SELECT id,identity_hash FROM whaleu_media.ratings_discussion_batches WHERE actor_id=$1 AND batch_request_id=$2',
          [actor, requestId],
        )
      ).rows[0];
    const base = {
      protocol: 'ratings-discussion-media-v1',
      batchRequestId: requestId,
      serverNow: await this.now(tx),
    };
    if (row) {
      if (
        !fence ||
        fence.state !== 'recorded' ||
        fence.batch_id !== row.id ||
        fence.identity_hash !== row.identity_hash
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      return ratingsDiscussionBatchRecoverySchema.parse({
        ...base,
        state: 'recorded',
        status: await this.status(actor, row.id, tx),
      });
    }
    if (fence && fence.state !== 'cancelled_before_prepare')
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return ratingsDiscussionBatchRecoverySchema.parse(
      fence
        ? {
            ...base,
            state: 'cancelled_before_prepare',
            identityHash: fence.identity_hash,
          }
        : { ...base, state: 'not_recorded' },
    );
  }
  private async requestFence(actor: string, requestId: string, tx: PoolClient) {
    return (
      await tx.query<{
        identity_hash: string;
        batch_id: string | null;
        state: 'recorded' | 'cancelled_before_prepare';
      }>(
        'SELECT identity_hash,batch_id,state FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=$1 AND batch_request_id=$2',
        [actor, requestId],
      )
    ).rows[0];
  }
  private async reserveRequest(
    actor: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<void> {
    const occupied = await tx.query(
      'SELECT 1 FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2 UNION ALL SELECT 1 FROM whaleu_media.upload_intents WHERE actor_id=$1 AND client_request_id=$2 LIMIT 1',
      [actor, requestId],
    );
    if (occupied.rowCount) throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    await reserveMediaRequestKey(actor, tx);
  }
  async status(
    actor: string,
    batchId: string,
    tx: PoolClient,
  ): Promise<RatingsDiscussionBatchStatus> {
    this.managed(tx);
    const row = (
      await tx.query<Batch>(
        'SELECT * FROM whaleu_media.ratings_discussion_batches WHERE id=$1 AND actor_id=$2 FOR SHARE NOWAIT',
        [mediaIdSchema.parse(batchId), actor],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const members = (
      await tx.query<{
        member_id: string;
        client_request_id: string;
        intent_id: string;
        source_slot: number;
        state: string;
      }>(
        'SELECT member_id,client_request_id,intent_id,source_slot,state FROM whaleu_media.ratings_discussion_members WHERE batch_id=$1 ORDER BY source_slot,member_id LIMIT 129',
        [batchId],
      )
    ).rows;
    await this.proof.capture(tx);
    return ratingsDiscussionBatchStatusSchema.parse({
      protocol: 'ratings-discussion-media-v1',
      batchId: row.id,
      identity: row.identity,
      batchIdentityHash: row.identity_hash,
      revision: row.revision,
      state: row.state,
      expiresAt: row.expires_at.getTime(),
      serverNow: await this.now(tx),
      members: members.map((m) => ({
        memberId: m.member_id,
        requestId: m.client_request_id,
        intentId: m.intent_id,
        sourceSlot: m.source_slot,
        state: m.state,
      })),
      sealedPlan: row.sealed_plan,
      sealedPlanDigest: row.sealed_plan_digest,
      consumedParent: row.consumed_parent,
    });
  }
  private async lock(
    actor: string,
    id: string,
    tx: PoolClient,
    live = true,
  ): Promise<Batch> {
    this.managed(tx);
    const row = (
      await tx.query<Batch>(
        'SELECT * FROM whaleu_media.ratings_discussion_batches WHERE id=$1 AND actor_id=$2 FOR UPDATE NOWAIT',
        [mediaIdSchema.parse(id), actor],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (live)
      registerTransactionDeadline(
        tx,
        row.expires_at.getTime(),
        'MEDIA_UNAVAILABLE',
      );
    return row;
  }
  private managed(tx: PoolClient) {
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
