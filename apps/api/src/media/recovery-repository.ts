import { rejectProfileRequestMarker } from './profile-request-marker.js';
import type { PoolClient } from 'pg';
import { mediaStatusV4Schema, mediaCancelV4Schema } from './contracts-v4.js';
import type { MediaStatusV4, MediaCancelV4 } from './contracts-v4.js';
import { ApplicationError } from '../http/application-error.js';
import {
  transactionReadEpoch,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import { mediaIdSchema } from './contracts.js';
import {
  mediaCancelRequestSchema,
  mediaRequestRecoverySchema,
  mediaStatusV2Schema,
  mediaCancelV2Schema,
} from './contracts-v2.js';
import type {
  MediaStatusV2,
  MediaRequestRecovery,
  MediaCancelV2,
} from './contracts-v2.js';
import { lockMediaActor, reserveMediaRequestKey } from './intent-repository.js';
import type { MediaLifecycleRepository } from './lifecycle-repository.js';
import type { MediaAssetRepository } from './asset-repository.js';
import { MediaRequiredProof } from './required-proof.js';
import { lockMediaBatchesForIntents } from './batch-locks.js';

interface Intent {
  id: string;
  actor_id: string;
  client_request_id: string;
  request_hash: string;
  state: string;
  expires_at: Date;
  resource_id: string;
}
interface Fence {
  request_hash: string;
  intent_id: string | null;
  state: string;
}
export class MediaRecoveryRepository {
  private readonly proof = new MediaRequiredProof();
  constructor(
    private readonly lifecycle: MediaLifecycleRepository,
    private readonly assets: Pick<MediaAssetRepository, 'readyOwned'>,
    private readonly protocolVersion: 2 | 3 | 4 = 2,
  ) {}
  private get statusSchema() {
    return this.protocolVersion === 4
      ? mediaStatusV4Schema
      : mediaStatusV2Schema;
  }
  private get cancelSchema() {
    return this.protocolVersion === 4
      ? mediaCancelV4Schema
      : mediaCancelV2Schema;
  }
  async recover(
    actor: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<MediaRequestRecovery> {
    this.managed(tx);
    mediaIdSchema.parse(requestId);
    await rejectProfileRequestMarker(actor, requestId, tx);
    const fence = (
      await tx.query<Fence>(
        'SELECT * FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2',
        [actor, requestId],
      )
    ).rows[0];
    const base = {
      version: this.protocolVersion === 4 ? 4 : 2,
      requestId,
      serverNow: await this.now(tx),
    };
    if (!fence)
      return mediaRequestRecoverySchema.parse({
        ...base,
        state: 'not_recorded',
        requestHash: null,
      });
    if (!fence.intent_id)
      return mediaRequestRecoverySchema.parse({
        ...base,
        state: 'terminal',
        requestHash: fence.request_hash,
        reason: 'cancelled',
        status: null,
      });
    const protocol = (
      await tx.query<{ protocol_version: number }>(
        'SELECT protocol_version FROM whaleu_media.upload_intents WHERE id=$1',
        [fence.intent_id],
      )
    ).rows[0];
    if (protocol?.protocol_version !== this.protocolVersion)
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    const status = await this.status(actor, fence.intent_id, tx);
    return mediaRequestRecoverySchema.parse({
      ...base,
      requestHash: fence.request_hash,
      state:
        status.status === 'bound_history'
          ? 'bound_history'
          : status.status === 'terminal'
            ? 'terminal'
            : 'active',
      ...(status.status === 'terminal' ? { reason: status.reason } : {}),
      status,
    });
  }
  async status(
    actor: string,
    id: string,
    tx: PoolClient,
    write = false,
  ): Promise<MediaStatusV2 | MediaStatusV4> {
    this.managed(tx);
    await lockMediaBatchesForIntents([id], tx, write);
    const intent = (
      await tx.query<Intent>(
        `SELECT * FROM whaleu_media.upload_intents WHERE id=$1 AND actor_id=$2 AND protocol_version=$3 FOR ${write ? 'UPDATE' : 'SHARE'}`,
        [mediaIdSchema.parse(id), actor, this.protocolVersion],
      )
    ).rows[0];
    if (!intent) throw new ApplicationError('MEDIA_UNAVAILABLE');
    await tx.query(
      `SELECT id FROM whaleu_media.assets WHERE intent_id=$1 ORDER BY id FOR ${write ? 'UPDATE' : 'SHARE'} NOWAIT`,
      [id],
    );
    const binding = (
      await tx.query<{
        id: string;
        asset_id: string;
        resource_id: string;
        resource_kind: string;
        detached_at: Date | null;
      }>(
        `SELECT b.* FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id
       WHERE a.intent_id=$1 ORDER BY b.id FOR SHARE OF b NOWAIT`,
        [id],
      )
    ).rows[0];
    const serverNow = await this.now(tx);
    const base = {
      version: this.protocolVersion === 4 ? 4 : 2,
      intentId: id,
      requestId: intent.client_request_id,
      requestHash: intent.request_hash,
      serverNow,
    };
    // Historical ownership wins over cancellation, retention and Review outages.
    // This branch never returns dimensions, content, locators, or read authority.
    if (binding) {
      const publication = (
        await tx.query<{ client_request_id: string; payload_hash: string }>(
          `SELECT client_request_id,payload_hash FROM whaleu_community.publication_requests
         WHERE account_id=$1 AND operation=$3 AND receipt->>'outcome'='created'
         AND receipt->>'resourceId'=$2 ORDER BY client_request_id LIMIT 2`,
          [
            actor,
            binding.resource_id,
            this.protocolVersion === 4
              ? `publish_${binding.resource_kind}`
              : 'publish_post',
          ],
        )
      ).rows;
      await this.proof.capture(tx);
      return this.statusSchema.parse({
        ...base,
        status: 'bound_history',
        assetId: binding.asset_id,
        bindingId: binding.id,
        attachmentState: binding.detached_at ? 'detached' : 'active',
        publication:
          publication.length === 1
            ? {
                clientRequestId: publication[0]!.client_request_id,
                operation:
                  this.protocolVersion === 4
                    ? `publish_${binding.resource_kind}`
                    : 'publish_post',
                intentHash: publication[0]!.payload_hash,
              }
            : null,
      });
    }
    const terminal = [
      'cancelled',
      'expired',
      'rejected',
      'cleanup_pending',
      'deleting',
      'deleted',
    ].includes(intent.state);
    const operationExpired =
      intent.state !== 'ready' && intent.expires_at.getTime() <= serverNow;
    if (terminal || operationExpired) {
      const fence = (
        await tx.query<{ terminal_reason: string | null }>(
          'SELECT terminal_reason FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2',
          [actor, intent.client_request_id],
        )
      ).rows[0];
      const reason =
        fence?.terminal_reason ??
        (intent.state === 'cancelled'
          ? 'cancelled'
          : intent.state === 'rejected'
            ? 'rejected'
            : intent.state === 'deleted'
              ? 'deleted'
              : 'expired');
      return this.statusSchema.parse({
        ...base,
        status: 'terminal',
        reason,
        cleanup: await this.cleanup(id, tx),
      });
    }
    if (intent.state === 'ready') {
      // Cancellation needs lifecycle identity, not a readiness/Review proof
      // whose pre-mutation epoch would invalidate the subsequent cancellation.
      if (write)
        return this.statusSchema.parse({
          ...base,
          status: 'unavailable',
          reason: 'MEDIA_UNAVAILABLE',
          retryable: true,
        });
      const deadlines = (
        await tx.query<{ asset_id: string; retention: Date; draft: Date }>(
          `SELECT a.id asset_id,a.created_at+interval '24 hours' retention,d.expires_at draft
         FROM whaleu_media.assets a JOIN whaleu_community.media_drafts d ON d.id=a.resource_id
         AND d.actor_id=a.actor_id AND d.scope_revision=a.scope_revision WHERE a.intent_id=$1 FOR SHARE OF a,d NOWAIT`,
          [id],
        )
      ).rows[0];
      if (deadlines) {
        const retention = deadlines.retention.getTime(),
          draft = deadlines.draft.getTime();
        const bindBefore = Math.min(retention, draft);
        if (bindBefore <= serverNow)
          return this.statusSchema.parse({
            ...base,
            status: 'terminal',
            reason: 'expired',
            cleanup: 'pending',
          });
        const ready = await this.assets.readyOwned(actor, id, tx);
        if (ready === deadlines.asset_id) {
          registerTransactionDeadline(tx, bindBefore, 'MEDIA_UNAVAILABLE');
          return this.statusSchema.parse({
            ...base,
            status: 'ready_unbound',
            assetId: ready,
            readyRetentionUntil: retention,
            draftExpiresAt: draft,
            bindBefore,
            mediaProof: 'current',
          });
        }
      }
      return this.statusSchema.parse({
        ...base,
        status: 'unavailable',
        reason: 'MEDIA_UNAVAILABLE',
        retryable: true,
      });
    }
    const ingress = (
      await tx.query<{ writer_state: string }>(
        `SELECT g.writer_state FROM whaleu_media.upload_ingress g
       JOIN whaleu_media.upload_intents i ON i.id=g.intent_id AND i.generation=g.generation WHERE i.id=$1`,
        [id],
      )
    ).rows[0];
    const operationDeadlineAt = intent.expires_at.getTime();
    if (intent.state === 'prepared')
      return this.statusSchema.parse(
        ingress?.writer_state === 'observed'
          ? { ...base, status: 'uploaded', operationDeadlineAt }
          : {
              ...base,
              status: 'prepared',
              operationDeadlineAt,
              upload:
                ingress &&
                ['writing', 'retiring'].includes(ingress.writer_state)
                  ? 'in_flight'
                  : ingress?.writer_state === 'unknown'
                    ? 'reconcile_needed'
                    : 'none',
            },
      );
    return this.statusSchema.parse({
      ...base,
      status: 'processing',
      operationDeadlineAt,
      retryAfterMs: 1000,
    });
  }
  async cancelRequest(
    actor: string,
    requestId: string,
    input: unknown,
    tx: PoolClient,
  ): Promise<MediaRequestRecovery> {
    // V3 pre-prepare cancellation belongs to the durable batch request fence;
    // exposing an actor-first member fence would invert the batch lock order.
    if (this.protocolVersion !== 2)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const { requestHash } = mediaCancelRequestSchema.parse(input);
    mediaIdSchema.parse(requestId);
    await lockMediaActor(actor, tx);
    await rejectProfileRequestMarker(actor, requestId, tx);
    const fence = (
      await tx.query<Fence>(
        'SELECT * FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2 FOR UPDATE',
        [actor, requestId],
      )
    ).rows[0];
    if (fence && fence.request_hash !== requestHash)
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    if (!fence) {
      // A legacy v1 key cannot be hijacked by a guessed v2 cancellation fence.
      if (
        (
          await tx.query(
            'SELECT 1 FROM whaleu_media.upload_intents WHERE actor_id=$1 AND client_request_id=$2',
            [actor, requestId],
          )
        ).rowCount
      )
        throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
      await reserveMediaRequestKey(actor, tx);
      await tx.query(
        `INSERT INTO whaleu_media.upload_request_fences(actor_id,client_request_id,request_hash,state,terminal_reason)
        VALUES($1,$2,$3,'cancelled_before_prepare','cancelled')`,
        [actor, requestId, requestHash],
      );
    } else if (fence.intent_id) {
      const protocol = (
        await tx.query<{ protocol_version: number }>(
          'SELECT protocol_version FROM whaleu_media.upload_intents WHERE id=$1',
          [fence.intent_id],
        )
      ).rows[0];
      if (protocol?.protocol_version !== this.protocolVersion)
        throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
      await this.cancel(actor, fence.intent_id, tx);
    }
    return this.recover(actor, requestId, tx);
  }
  async cancel(
    actor: string,
    id: string,
    tx: PoolClient,
  ): Promise<MediaCancelV2 | MediaCancelV4> {
    await lockMediaBatchesForIntents([id], tx, true);
    await lockMediaActor(actor, tx);
    const before = await this.status(actor, id, tx, true);
    if (before.status === 'bound_history')
      return this.cancelSchema.parse({
        version: this.protocolVersion === 4 ? 4 : 2,
        result: 'bound_history',
        status: before,
      });
    await this.lifecycle.cancel(actor, id, tx);
    const reason = before.status === 'terminal' ? before.reason : 'cancelled';
    await tx.query(
      `UPDATE whaleu_media.upload_request_fences SET state='terminal',terminal_reason=$3,updated_at=clock_timestamp()
      WHERE actor_id=$1 AND intent_id=$2 AND state='active'`,
      [actor, id, reason],
    );
    const status = await this.status(actor, id, tx);
    return this.cancelSchema.parse({
      version: this.protocolVersion === 4 ? 4 : 2,
      result: before.status === 'terminal' ? 'already_terminal' : 'cancelled',
      status,
    });
  }
  private cleanup(
    id: string,
    tx: PoolClient,
  ): Promise<'pending' | 'retained' | 'confirmed'> {
    return readMediaCleanupState(id, tx);
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

export async function readMediaCleanupState(
  id: string,
  tx: PoolClient,
): Promise<'pending' | 'retained' | 'confirmed'> {
  const row = (
    await tx.query<{
      unresolved_writer: boolean;
      pending: boolean;
      retained: boolean;
      attempts: boolean;
      obligations: boolean;
    }>(
      `SELECT
        EXISTS(SELECT 1 FROM whaleu_media.upload_ingress_writers w JOIN whaleu_media.object_attempts a ON a.id=w.object_attempt_id WHERE a.intent_id=$1 AND w.state<>'retired') unresolved_writer,
        EXISTS(SELECT 1 FROM whaleu_media.object_attempts WHERE intent_id=$1) attempts,
        EXISTS(SELECT 1 FROM whaleu_media.cleanup_obligations c LEFT JOIN whaleu_media.object_attempts a ON a.id=c.object_attempt_id
          LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id
          LEFT JOIN whaleu_media.object_attempts wa ON wa.id=w.object_attempt_id
          LEFT JOIN whaleu_media.assets s ON s.id=c.asset_id LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
          WHERE coalesce(a.intent_id,wa.intent_id,s.intent_id,d.intent_id)=$1) obligations,
        EXISTS(SELECT 1 FROM whaleu_media.cleanup_obligations c LEFT JOIN whaleu_media.object_attempts a ON a.id=c.object_attempt_id
          LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id
          LEFT JOIN whaleu_media.object_attempts wa ON wa.id=w.object_attempt_id
          LEFT JOIN whaleu_media.assets s ON s.id=c.asset_id LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
          WHERE coalesce(a.intent_id,wa.intent_id,s.intent_id,d.intent_id)=$1 AND c.state<>'deleted') pending,
        EXISTS(SELECT 1 FROM whaleu_media.cleanup_obligations c LEFT JOIN whaleu_media.object_attempts a ON a.id=c.object_attempt_id
          LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id
          LEFT JOIN whaleu_media.object_attempts wa ON wa.id=w.object_attempt_id
          LEFT JOIN whaleu_media.assets s ON s.id=c.asset_id LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
          WHERE coalesce(a.intent_id,wa.intent_id,s.intent_id,d.intent_id)=$1 AND c.state='retained') retained`,
      [id],
    )
  ).rows[0];
  if (
    !row ||
    row.unresolved_writer ||
    row.retained ||
    (row.attempts && !row.obligations)
  )
    return 'retained';
  return row.pending ? 'pending' : 'confirmed';
}
