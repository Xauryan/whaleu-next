import {
  profileRequestMarker,
  reserveProfileRequestMarker,
} from './profile-request-marker.js';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../database/transaction-deadlines.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import {
  profileMediaStatusSchema,
  profileMediaRecoverySchema,
  profileMediaCancelSchema,
  cancelProfileMediaRequestSchema,
} from './contracts-profile.js';
import type {
  ProfileMediaStatus,
  ProfileMediaRecovery,
  ProfileMediaCancel,
} from './contracts-profile.js';
import { lockMediaActor, reserveMediaRequestKey } from './intent-repository.js';
import type { MediaLifecycleRepository } from './lifecycle-repository.js';
import type { MediaAssetRepository } from './asset-repository.js';
import { readMediaCleanupState } from './recovery-repository.js';
import { MediaRequiredProof } from './required-proof.js';

interface Intent {
  id: string;
  client_request_id: string;
  request_hash: string;
  state: string;
  expires_at: Date;
  resource_id: string;
  scope_revision: string;
}
interface Fence {
  request_hash: string;
  intent_id: string | null;
  state: string;
}
/** Owner-only historical observations. None of these results authorizes bytes. */
export class ProfileMediaRecoveryRepository {
  private readonly proof = new MediaRequiredProof();
  constructor(
    private readonly lifecycle: MediaLifecycleRepository,
    private readonly assets: Pick<MediaAssetRepository, 'readyOwned'>,
  ) {}
  async resolveProfileIntent(
    actor: string,
    editId: string,
    tx: PoolClient,
  ): Promise<string> {
    if (!transactionReadEpoch(tx))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    mediaV2IdSchema.parse(actor);
    mediaV2IdSchema.parse(editId);
    const rows = (
      await tx.query<{ id: string }>(
        `SELECT id FROM whaleu_media.upload_intents WHERE actor_id=$1 AND resource_id=$2 AND protocol_version=5 AND owner_kind='profile' AND resource_kind='avatar' AND target_kind='edit' AND slot='avatar' AND ordinal=0 LIMIT 2`,
        [actor, editId],
      )
    ).rows;
    if (rows.length !== 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return rows[0]!.id;
  }
  async recover(
    actor: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<ProfileMediaRecovery> {
    mediaV2IdSchema.parse(requestId);
    const base = {
      protocol: 'profile-media-v1',
      requestId,
      serverNow: await this.now(tx),
    };
    const marker = await profileRequestMarker(actor, requestId, tx);
    const fence = (
      await tx.query<Fence>(
        'SELECT * FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2',
        [actor, requestId],
      )
    ).rows[0];
    if ((fence && marker !== fence.request_hash) || (!fence && marker !== null))
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    if (
      !fence &&
      (
        await tx.query(
          'SELECT 1 FROM whaleu_media.upload_intents WHERE actor_id=$1 AND client_request_id=$2',
          [actor, requestId],
        )
      ).rowCount
    )
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    if (!fence)
      return profileMediaRecoverySchema.parse({
        ...base,
        state: 'not_recorded',
        requestHash: null,
      });
    if (!fence.intent_id)
      return profileMediaRecoverySchema.parse({
        ...base,
        state: 'cancelled_before_prepare',
        requestHash: fence.request_hash,
        reason: 'cancelled',
      });
    const status = await this.status(actor, fence.intent_id, tx);
    return profileMediaRecoverySchema.parse({
      ...base,
      requestHash: fence.request_hash,
      state: 'recorded',
      status,
    });
  }
  async status(
    actor: string,
    id: string,
    tx: PoolClient,
    write = false,
  ): Promise<ProfileMediaStatus> {
    const serverNow = await this.now(tx);
    const intent = (
      await tx.query<Intent>(
        `SELECT * FROM whaleu_media.upload_intents WHERE id=$1 AND actor_id=$2 AND protocol_version=5 AND owner_kind='profile' FOR ${write ? 'UPDATE' : 'SHARE'} NOWAIT`,
        [mediaV2IdSchema.parse(id), actor],
      )
    ).rows[0];
    if (!intent) throw new ApplicationError('MEDIA_UNAVAILABLE');
    await tx.query(
      `SELECT id FROM whaleu_media.assets WHERE intent_id=$1 ORDER BY id FOR ${write ? 'UPDATE' : 'SHARE'} NOWAIT`,
      [id],
    );
    const bindings = (
      await tx.query<{
        id: string;
        asset_id: string;
        resource_id: string;
        detached_at: Date | null;
      }>(
        `SELECT b.* FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE a.intent_id=$1 AND b.owner_kind='profile' AND b.resource_kind='avatar' AND b.slot='avatar' ORDER BY b.id FOR SHARE OF b NOWAIT`,
        [id],
      )
    ).rows;
    if (bindings.length > 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const base = {
      protocol: 'profile-media-v1',
      editId: intent.resource_id,
      intentId: id,
      requestId: intent.client_request_id,
      requestHash: intent.request_hash,
      serverNow,
    };
    const binding = bindings[0];
    if (binding) {
      const receipt = (
        await tx.query<{
          client_request_id: string;
          request_hash: string;
          resulting_revision: number;
        }>(
          `SELECT client_request_id,request_hash,resulting_revision FROM whaleu_profile.avatar_command_receipts WHERE actor_id=$1 AND appearance_id=$2`,
          [actor, binding.resource_id],
        )
      ).rows;
      if (receipt.length !== 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
      const command = {
        protocol: 'profile-media-v1',
        clientRequestId: receipt[0]!.client_request_id,
        requestHash: receipt[0]!.request_hash,
        resultingRevision: receipt[0]!.resulting_revision,
        operation: 'select_avatar',
      };
      await this.proof.capture(tx);
      return profileMediaStatusSchema.parse({
        ...base,
        status: 'bound_history',
        assetId: binding.asset_id,
        bindingId: binding.id,
        command,
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
      (intent.state !== 'ready' && intent.expires_at.getTime() <= serverNow)
    ) {
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
      return profileMediaStatusSchema.parse({
        ...base,
        status: 'terminal',
        reason,
        cleanup: await readMediaCleanupState(id, tx),
      });
    }
    if (intent.state === 'ready') {
      if (write)
        return profileMediaStatusSchema.parse({
          ...base,
          status: 'unavailable',
          reason: 'MEDIA_UNAVAILABLE',
          retryable: true,
        });
      // Do not acquire the Profile edit lock from Media. The immutable edit's
      // expiry is read only; readiness does not grant permission to replace it.
      const deadlines = (
        await tx.query<{ asset_id: string; retention: Date; edit: Date }>(
          `SELECT a.id asset_id,a.created_at+interval '24 hours' retention,e.expires_at edit FROM whaleu_media.assets a JOIN whaleu_profile.avatar_edits e ON e.id=a.resource_id AND e.actor_id=a.actor_id AND e.scope_revision=a.scope_revision WHERE a.intent_id=$1 AND a.owner_kind='profile'`,
          [id],
        )
      ).rows[0];
      if (deadlines) {
        const retention = deadlines.retention.getTime(),
          edit = deadlines.edit.getTime(),
          bindBefore = Math.min(retention, edit);
        if (bindBefore <= serverNow)
          return profileMediaStatusSchema.parse({
            ...base,
            status: 'terminal',
            reason: 'expired',
            cleanup: 'pending',
          });
        const ready = await this.assets.readyOwned(actor, id, tx);
        if (ready === deadlines.asset_id) {
          registerTransactionDeadline(tx, bindBefore, 'MEDIA_UNAVAILABLE');
          return profileMediaStatusSchema.parse({
            ...base,
            status: 'ready_unbound',
            editId: intent.resource_id,
            assetId: ready,
            readyRetentionUntil: retention,
            editExpiresAt: edit,
            bindBefore,
            mediaProof: 'current',
          });
        }
      }
      return profileMediaStatusSchema.parse({
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
    const operationDeadlineAt = intent.expires_at.getTime();
    if (intent.state === 'prepared')
      return profileMediaStatusSchema.parse(
        ingress?.writer_state === 'observed'
          ? {
              ...base,
              status: 'uploaded',
              editId: intent.resource_id,
              operationDeadlineAt,
            }
          : {
              ...base,
              status: 'prepared',
              editId: intent.resource_id,
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
    return profileMediaStatusSchema.parse({
      ...base,
      status: 'processing',
      editId: intent.resource_id,
      operationDeadlineAt,
      retryAfterMs: 1000,
    });
  }
  async cancelRequest(
    actor: string,
    requestId: string,
    input: unknown,
    tx: PoolClient,
  ): Promise<ProfileMediaRecovery> {
    const { requestHash } = cancelProfileMediaRequestSchema.parse(input);
    mediaV2IdSchema.parse(requestId);
    await lockMediaActor(actor, tx);
    await reserveProfileRequestMarker(actor, requestId, requestHash, tx);
    const fence = (
      await tx.query<Fence>(
        'SELECT * FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2 FOR UPDATE',
        [actor, requestId],
      )
    ).rows[0];
    if (fence && fence.request_hash !== requestHash)
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
  ): Promise<ProfileMediaCancel> {
    await lockMediaActor(actor, tx);
    const before = await this.status(actor, id, tx, true);
    if (before.status === 'bound_history')
      return profileMediaCancelSchema.parse({
        protocol: 'profile-media-v1',
        result: 'bound_history',
        status: before,
      });
    await this.lifecycle.cancel(actor, id, tx);
    const reason = before.status === 'terminal' ? before.reason : 'cancelled';
    await tx.query(
      `UPDATE whaleu_media.upload_request_fences SET state='terminal',terminal_reason=$3,updated_at=clock_timestamp() WHERE actor_id=$1 AND intent_id=$2 AND state='active'`,
      [actor, id, reason],
    );
    const status = await this.status(actor, id, tx);
    await this.proof.capture(tx);
    return profileMediaCancelSchema.parse({
      protocol: 'profile-media-v1',
      result: before.status === 'terminal' ? 'already_terminal' : 'cancelled',
      status,
    });
  }
  private async now(tx: PoolClient): Promise<number> {
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
