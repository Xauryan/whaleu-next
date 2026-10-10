import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../database/transaction-deadlines.js';
import { mediaIdSchema } from './contracts.js';
import {
  ratingsDiscussionMemberStatusSchema,
  ratingsDiscussionMemberRecoverySchema,
  ratingsDiscussionCancelRequestSchema,
} from './contracts-ratings-discussion.js';
import type { RatingsDiscussionMemberStatus } from './contracts-ratings-discussion.js';
import {
  ratingsDiscussionRequestMarker,
  reserveRatingsDiscussionRequestMarker,
} from './ratings-discussion-request-marker.js';
import { lockMediaActor, reserveMediaRequestKey } from './intent-repository.js';
import { lockMediaBatchesForIntents } from './batch-locks.js';
import type { MediaLifecycleRepository } from './lifecycle-repository.js';
import type { RatingsDiscussionMediaAssetRepository } from './ratings-discussion-asset-repository.js';
import { readMediaCleanupState } from './recovery-repository.js';
import { MediaRequiredProof } from './required-proof.js';
interface Intent {
  id: string;
  client_request_id: string;
  request_hash: string;
  state: string;
  expires_at: Date;
}
interface Fence {
  request_hash: string;
  intent_id: string | null;
  state: string;
}
/** Historical original-actor recovery never grants publication or byte access. */
export class RatingsDiscussionMediaRecoveryRepository {
  private readonly proof = new MediaRequiredProof();
  constructor(
    private readonly lifecycle: MediaLifecycleRepository,
    private readonly assets: RatingsDiscussionMediaAssetRepository,
  ) {}
  async resolveMemberIntent(
    actor: string,
    memberId: string,
    tx: PoolClient,
  ): Promise<string> {
    this.managed(tx);
    const row = (
      await tx.query<{ intent_id: string }>(
        `SELECT m.intent_id FROM whaleu_media.ratings_discussion_members m JOIN whaleu_media.upload_intents i ON i.id=m.intent_id WHERE m.member_id=$1 AND m.actor_id=$2 AND i.protocol_version=7`,
        [mediaIdSchema.parse(memberId), actor],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return row.intent_id;
  }
  async identity(
    actor: string,
    intentId: string,
    tx: PoolClient,
  ): Promise<{ batchId: string; memberId: string }> {
    this.managed(tx);
    const row = (
      await tx.query<{ batch_id: string; member_id: string }>(
        'SELECT batch_id,member_id FROM whaleu_media.ratings_discussion_members WHERE intent_id=$1 AND actor_id=$2',
        [mediaIdSchema.parse(intentId), actor],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return { batchId: row.batch_id, memberId: row.member_id };
  }
  async recover(actor: string, requestId: string, tx: PoolClient) {
    this.managed(tx);
    mediaIdSchema.parse(requestId);
    await this.proof.capture(tx);
    const marker = await ratingsDiscussionRequestMarker(actor, requestId, tx),
      fence = (
        await tx.query<Fence>(
          'SELECT * FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2',
          [actor, requestId],
        )
      ).rows[0];
    if (
      (fence && marker !== fence.request_hash) ||
      (!fence && marker !== null) ||
      (!fence &&
        (
          await tx.query(
            'SELECT id FROM whaleu_media.upload_intents WHERE actor_id=$1 AND client_request_id=$2',
            [actor, requestId],
          )
        ).rowCount)
    )
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    const base = {
      protocol: 'ratings-discussion-media-v1',
      requestId,
      serverNow: await this.now(tx),
    };
    if (!fence) {
      await this.proof.capture(tx);
      return ratingsDiscussionMemberRecoverySchema.parse({
        ...base,
        state: 'not_recorded',
        requestHash: null,
      });
    }
    if (!fence.intent_id) {
      await this.proof.capture(tx);
      return ratingsDiscussionMemberRecoverySchema.parse({
        ...base,
        state: 'cancelled_before_prepare',
        requestHash: fence.request_hash,
      });
    }
    return ratingsDiscussionMemberRecoverySchema.parse({
      ...base,
      state: 'recorded',
      requestHash: fence.request_hash,
      status: await this.status(actor, fence.intent_id, tx),
    });
  }
  async status(
    actor: string,
    id: string,
    tx: PoolClient,
    write = false,
  ): Promise<RatingsDiscussionMemberStatus> {
    const now = await this.now(tx);
    if (!write) await this.proof.capture(tx);
    await lockMediaBatchesForIntents([id], tx, write);
    const intent = (
      await tx.query<Intent>(
        `SELECT * FROM whaleu_media.upload_intents WHERE id=$1 AND actor_id=$2 AND protocol_version=7 FOR ${write ? 'UPDATE' : 'SHARE'} NOWAIT`,
        [mediaIdSchema.parse(id), actor],
      )
    ).rows[0];
    const identity = await this.identity(actor, id, tx);
    if (!intent) throw new ApplicationError('MEDIA_UNAVAILABLE');
    await tx.query(
      `SELECT id FROM whaleu_media.assets WHERE intent_id=$1 ORDER BY id FOR ${write ? 'UPDATE' : 'SHARE'} NOWAIT`,
      [id],
    );
    const bindings = (
      await tx.query<{
        id: string;
        asset_id: string;
        detached_at: Date | null;
        consumed_parent: unknown;
      }>(
        `SELECT b.id,b.asset_id,b.detached_at,p.consumed_parent FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_media.ratings_discussion_members m ON m.intent_id=a.intent_id JOIN whaleu_media.ratings_discussion_batches p ON p.id=m.batch_id WHERE a.intent_id=$1 AND b.owner_kind='ratings' AND b.resource_kind IN ('rating_comment','rating_reply') ORDER BY b.id FOR SHARE OF b NOWAIT`,
        [id],
      )
    ).rows;
    if (bindings.length > 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const base = {
        protocol: 'ratings-discussion-media-v1',
        ...identity,
        intentId: id,
        requestId: intent.client_request_id,
        requestHash: intent.request_hash,
        serverNow: now,
      },
      binding = bindings[0];
    if (binding) {
      if (!write) await this.proof.capture(tx);
      return ratingsDiscussionMemberStatusSchema.parse({
        ...base,
        status: 'bound_history',
        assetId: binding.asset_id,
        bindingId: binding.id,
        parent: binding.consumed_parent,
        attachmentState: binding.detached_at ? 'detached' : 'active',
      });
    }
    if (
      [
        'cancelled',
        'expired',
        'rejected',
        'cleanup_pending',
        'deleting',
        'deleted',
      ].includes(intent.state) ||
      (intent.state !== 'ready' && intent.expires_at.getTime() <= now)
    ) {
      const fence = (
        await tx.query<{ terminal_reason: string | null }>(
          'SELECT terminal_reason FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2',
          [actor, intent.client_request_id],
        )
      ).rows[0];
      const reason =
        fence?.terminal_reason ??
        (['cancelled', 'rejected', 'deleted'].includes(intent.state)
          ? intent.state
          : 'expired');
      if (!write) await this.proof.capture(tx);
      return ratingsDiscussionMemberStatusSchema.parse({
        ...base,
        status: 'terminal',
        reason,
        cleanup: await readMediaCleanupState(id, tx),
      });
    }
    if (intent.state === 'ready' && !write) {
      const asset = (
        await tx.query<{
          id: string;
          manifest_digest: string;
          bind_before: Date;
        }>(
          `SELECT a.id,a.manifest_digest,least(a.created_at+interval '24 hours',b.expires_at) AS bind_before FROM whaleu_media.assets a JOIN whaleu_media.ratings_discussion_members m ON m.intent_id=a.intent_id JOIN whaleu_media.ratings_discussion_batches b ON b.id=m.batch_id WHERE a.intent_id=$1 AND m.state='live' AND b.state IN ('editing','sealed')`,
          [id],
        )
      ).rows[0];
      if (asset && asset.bind_before.getTime() <= now) {
        await this.proof.capture(tx);
        return ratingsDiscussionMemberStatusSchema.parse({
          ...base,
          status: 'terminal',
          reason: 'expired',
          cleanup: 'pending',
        });
      }
      if (asset && (await this.assets.readyOwned(actor, id, tx)) === asset.id) {
        registerTransactionDeadline(
          tx,
          asset.bind_before.getTime(),
          'MEDIA_UNAVAILABLE',
        );
        return ratingsDiscussionMemberStatusSchema.parse({
          ...base,
          status: 'ready_unbound',
          assetId: asset.id,
          manifestDigest: asset.manifest_digest,
          bindBefore: asset.bind_before.getTime(),
          mediaProof: 'current',
        });
      }
      await this.proof.capture(tx);
      return ratingsDiscussionMemberStatusSchema.parse({
        ...base,
        status: 'unavailable',
        reason: 'MEDIA_UNAVAILABLE',
        retryable: true,
      });
    }
    if (intent.state === 'ready')
      return ratingsDiscussionMemberStatusSchema.parse({
        ...base,
        status: 'unavailable',
        reason: 'MEDIA_UNAVAILABLE',
        retryable: true,
      });
    const ingress = (
      await tx.query<{ writer_state: string }>(
        `SELECT g.writer_state FROM whaleu_media.upload_ingress g JOIN whaleu_media.upload_intents i ON i.id=g.intent_id AND i.generation=g.generation WHERE i.id=$1`,
        [id],
      )
    ).rows[0];
    if (!write) await this.proof.capture(tx);
    if (intent.state === 'prepared')
      return ratingsDiscussionMemberStatusSchema.parse(
        ingress?.writer_state === 'observed'
          ? {
              ...base,
              status: 'uploaded',
              operationDeadlineAt: intent.expires_at.getTime(),
            }
          : {
              ...base,
              status: 'prepared',
              operationDeadlineAt: intent.expires_at.getTime(),
              upload:
                ingress &&
                ['writing', 'retiring'].includes(ingress.writer_state)
                  ? 'in_flight'
                  : ingress?.writer_state === 'unknown'
                    ? 'reconcile_needed'
                    : 'none',
            },
      );
    return ratingsDiscussionMemberStatusSchema.parse({
      ...base,
      status: 'processing',
      operationDeadlineAt: intent.expires_at.getTime(),
      retryAfterMs: 1000,
    });
  }
  async cancelRequest(
    actor: string,
    requestId: string,
    raw: unknown,
    tx: PoolClient,
  ) {
    const { requestHash } = ratingsDiscussionCancelRequestSchema.parse(raw);
    mediaIdSchema.parse(requestId);
    // Locate batch before the account reservation lock, matching ingress/cleanup.
    const hint = (
      await tx.query<Fence>(
        'SELECT * FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2',
        [actor, requestId],
      )
    ).rows[0];
    if (hint?.intent_id)
      await lockMediaBatchesForIntents([hint.intent_id], tx, true);
    await lockMediaActor(actor, tx);
    await reserveRatingsDiscussionRequestMarker(
      actor,
      requestId,
      requestHash,
      tx,
    );
    const fence = (
      await tx.query<Fence>(
        'SELECT * FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2 FOR UPDATE',
        [actor, requestId],
      )
    ).rows[0];
    if (fence && fence.request_hash !== requestHash)
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    if (!fence) {
      await reserveMediaRequestKey(actor, tx);
      await tx.query(
        `INSERT INTO whaleu_media.upload_request_fences(actor_id,client_request_id,request_hash,state,terminal_reason) VALUES($1,$2,$3,'cancelled_before_prepare','cancelled')`,
        [actor, requestId, requestHash],
      );
    } else if (fence.intent_id) await this.cancel(actor, fence.intent_id, tx);
    return this.recover(actor, requestId, tx);
  }
  async cancel(
    actor: string,
    id: string,
    tx: PoolClient,
  ): Promise<RatingsDiscussionMemberStatus> {
    await lockMediaBatchesForIntents([id], tx, true);
    await lockMediaActor(actor, tx);
    const before = await this.status(actor, id, tx, true);
    if (before.status === 'bound_history') {
      await this.proof.capture(tx);
      return before;
    }
    await this.lifecycle.cancel(actor, id, tx);
    await tx.query(
      `UPDATE whaleu_media.upload_request_fences SET state='terminal',terminal_reason=$3,updated_at=clock_timestamp() WHERE actor_id=$1 AND intent_id=$2 AND state='active'`,
      [actor, id, before.status === 'terminal' ? before.reason : 'cancelled'],
    );
    return this.status(actor, id, tx);
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
