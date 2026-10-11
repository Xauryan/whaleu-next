import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  transactionReadEpoch,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import {
  ANNOUNCEMENT_MEDIA_PROTOCOL,
  announcementMediaStatusSchema,
  announcementMediaRecoverySchema,
  cancelAnnouncementMediaRequestSchema,
} from './contracts-announcement.js';
import { lockMediaActor, reserveMediaRequestKey } from './intent-repository.js';
import type { MediaLifecycleRepository } from './lifecycle-repository.js';
import type { MediaAssetRepository } from './asset-repository.js';
import { readMediaCleanupState } from './recovery-repository.js';
import { AnnouncementMediaRequiredProof } from './announcement-required-proof.js';
interface Fence {
  protocol_namespace: number | null;
  request_hash: string;
  intent_id: string | null;
  state: string;
  terminal_reason: string | null;
}
interface Intent {
  id: string;
  client_request_id: string;
  request_hash: string;
  state: string;
  expires_at: Date;
}
/** Original-actor receipt recovery is historical metadata, never announcement image read authority. */
export class AnnouncementMediaRecoveryRepository {
  private readonly proof = new AnnouncementMediaRequiredProof();
  constructor(
    private readonly lifecycle: MediaLifecycleRepository,
    private readonly assets: Pick<MediaAssetRepository, 'readyOwned'>,
  ) {}
  async recover(actor: string, requestId: string, tx: PoolClient) {
    mediaV2IdSchema.parse(requestId);
    const serverNow = await this.now(tx);
    const fence = (
      await tx.query<Fence>(
        'SELECT * FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2',
        [actor, requestId],
      )
    ).rows[0];
    if (fence && fence.protocol_namespace !== 12)
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    const base = {
      protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
      requestId,
      serverNow,
    };
    if (!fence) {
      if (
        (
          await tx.query(
            'SELECT 1 FROM whaleu_media.upload_intents WHERE actor_id=$1 AND client_request_id=$2',
            [actor, requestId],
          )
        ).rowCount
      )
        throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
      return announcementMediaRecoverySchema.parse({
        ...base,
        state: 'not_recorded',
        requestHash: null,
      });
    }
    await this.proof.capture(tx);
    return announcementMediaRecoverySchema.parse(
      fence.intent_id
        ? {
            ...base,
            state: 'recorded',
            requestHash: fence.request_hash,
            status: await this.status(actor, fence.intent_id, tx),
          }
        : {
            ...base,
            state: 'cancelled_before_prepare',
            requestHash: fence.request_hash,
            reason: 'cancelled',
          },
    );
  }
  async status(actor: string, id: string, tx: PoolClient) {
    const serverNow = await this.now(tx);
    const intent = (
      await tx.query<Intent>(
        `SELECT * FROM whaleu_media.upload_intents WHERE id=$1 AND actor_id=$2 AND protocol_version=12 AND owner_kind='announcements' FOR SHARE NOWAIT`,
        [mediaV2IdSchema.parse(id), actor],
      )
    ).rows[0];
    if (!intent) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const base = {
      protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
      intentId: id,
      requestId: intent.client_request_id,
      requestHash: intent.request_hash,
      serverNow,
    };
    const binding = (
      await tx.query<{
        id: string;
        asset_id: string;
        detached_at: Date | null;
      }>(
        `SELECT b.* FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE a.intent_id=$1 AND b.owner_kind='announcements' AND b.resource_kind='announcement_image'`,
        [id],
      )
    ).rows[0];
    await this.proof.capture(tx);
    if (binding)
      return announcementMediaStatusSchema.parse({
        ...base,
        status: 'bound_history',
        assetId: binding.asset_id,
        bindingId: binding.id,
        attachmentState: binding.detached_at ? 'detached' : 'active',
      });
    if (
      [
        'cancelled',
        'expired',
        'rejected',
        'cleanup_pending',
        'deleting',
        'deleted',
      ].includes(intent.state) ||
      (intent.state !== 'ready' && intent.expires_at.getTime() <= serverNow)
    ) {
      const fence = (
        await tx.query<Fence>(
          'SELECT * FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND intent_id=$2',
          [actor, id],
        )
      ).rows[0];
      return announcementMediaStatusSchema.parse({
        ...base,
        status: 'terminal',
        reason:
          fence?.terminal_reason ??
          (['cancelled', 'rejected', 'deleted'].includes(intent.state)
            ? intent.state
            : 'expired'),
        cleanup: await readMediaCleanupState(id, tx),
      });
    }
    if (intent.state === 'ready') {
      const row = (
        await tx.query<{ asset_id: string; bind_before: Date }>(
          `SELECT a.id asset_id,least(a.created_at+interval '24 hours',s.expires_at) bind_before FROM whaleu_media.assets a JOIN whaleu_announcements.media_upload_scopes s ON s.id=a.resource_id AND s.actor_id=a.actor_id AND s.scope_revision=a.scope_revision WHERE a.intent_id=$1`,
          [id],
        )
      ).rows[0];
      if (row && row.bind_before.getTime() <= serverNow)
        return announcementMediaStatusSchema.parse({
          ...base,
          status: 'terminal',
          reason: 'expired',
          cleanup: 'pending',
        });
      if (
        row &&
        (await this.assets.readyOwned(actor, id, tx)) === row.asset_id
      ) {
        registerTransactionDeadline(
          tx,
          row.bind_before.getTime(),
          'MEDIA_UNAVAILABLE',
        );
        return announcementMediaStatusSchema.parse({
          ...base,
          status: 'ready_unbound',
          assetId: row.asset_id,
          bindBefore: row.bind_before.getTime(),
          mediaProof: 'current',
        });
      }
      return announcementMediaStatusSchema.parse({
        ...base,
        status: 'unavailable',
        reason: 'MEDIA_UNAVAILABLE',
        retryable: true,
      });
    }
    const ingress = (
      await tx.query<{ writer_state: string }>(
        `SELECT g.writer_state FROM whaleu_media.upload_ingress g JOIN whaleu_media.upload_intents i ON i.id=g.intent_id AND i.generation=g.generation WHERE i.id=$1`,
        [id],
      )
    ).rows[0];
    const deadline = { operationDeadlineAt: intent.expires_at.getTime() };
    if (intent.state === 'prepared')
      return announcementMediaStatusSchema.parse(
        ingress?.writer_state === 'observed'
          ? { ...base, ...deadline, status: 'uploaded' }
          : {
              ...base,
              ...deadline,
              status: 'prepared',
              upload:
                ingress &&
                ['writing', 'retiring'].includes(ingress.writer_state)
                  ? 'in_flight'
                  : ingress?.writer_state === 'unknown'
                    ? 'reconcile_needed'
                    : 'none',
            },
      );
    return announcementMediaStatusSchema.parse({
      ...base,
      ...deadline,
      status: 'processing',
      retryAfterMs: 1000,
    });
  }
  async cancel(actor: string, id: string, tx: PoolClient) {
    await lockMediaActor(actor, tx);
    const intent = (
      await tx.query<Intent>(
        `SELECT * FROM whaleu_media.upload_intents WHERE id=$1 AND actor_id=$2 AND protocol_version=12 AND owner_kind='announcements' FOR UPDATE`,
        [mediaV2IdSchema.parse(id), actor],
      )
    ).rows[0];
    if (!intent) throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (
      !(
        await tx.query(
          `SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE a.intent_id=$1`,
          [id],
        )
      ).rowCount
    ) {
      const reason =
        intent.state === 'rejected'
          ? 'rejected'
          : intent.state === 'deleted'
            ? 'deleted'
            : intent.state === 'expired'
              ? 'expired'
              : 'cancelled';
      await this.lifecycle.cancel(actor, id, tx);
      await tx.query(
        `UPDATE whaleu_media.upload_request_fences SET state='terminal',terminal_reason=$3,updated_at=clock_timestamp() WHERE actor_id=$1 AND intent_id=$2 AND protocol_namespace=12 AND state='active'`,
        [actor, id, reason],
      );
    }
    return this.status(actor, id, tx);
  }
  async cancelRequest(
    actor: string,
    requestId: string,
    raw: unknown,
    tx: PoolClient,
  ) {
    const { requestHash } = cancelAnnouncementMediaRequestSchema.parse(raw);
    mediaV2IdSchema.parse(requestId);
    await lockMediaActor(actor, tx);
    const fence = (
      await tx.query<Fence>(
        'SELECT * FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2 FOR UPDATE',
        [actor, requestId],
      )
    ).rows[0];
    if (
      fence &&
      (fence.protocol_namespace !== 12 || fence.request_hash !== requestHash)
    )
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    if (!fence) {
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
        `INSERT INTO whaleu_media.upload_request_fences(actor_id,client_request_id,request_hash,state,terminal_reason,protocol_namespace) VALUES($1,$2,$3,'cancelled_before_prepare','cancelled',12)`,
        [actor, requestId, requestHash],
      );
    } else if (fence.intent_id) await this.cancel(actor, fence.intent_id, tx);
    return this.recover(actor, requestId, tx);
  }
  private async now(tx: PoolClient) {
    if (!transactionReadEpoch(tx))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const value = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]?.now.getTime();
    if (!value || !Number.isSafeInteger(value))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return value;
  }
}
