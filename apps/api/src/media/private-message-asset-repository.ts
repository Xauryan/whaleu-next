import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { MediaAssetRepository } from './asset-repository.js';
import type { AssetRow } from './asset-repository.js';
import { MediaOwnerProofRegistry } from './owner-proof.js';
import { PrivateMessageMediaRequiredProof } from './private-message-required-proof.js';
import type {
  PrivateMessageOwnerProofRegistry,
  PrivateMessageReadProof,
  PrivateMessageReadRequest,
} from './private-message-owner-proof.js';
import type { MediaVariantName } from './contracts.js';
import type { ExactMediaDeliveryPlan } from './delivery.js';
import {
  PRIVATE_MESSAGE_MEDIA_PROTOCOL,
  privateMessageDescriptorSchema,
  privateMessageMediaFactSchema,
  privateMessageMediaBindingSchema,
} from './contracts-private-message.js';
import type {
  PrivateMessageMediaFact,
  PrivateMessageMediaBinding,
} from './contracts-private-message.js';
import { MediaLifecycleRepository } from './lifecycle-repository.js';
export class PrivateMessageMediaAssetRepository extends MediaAssetRepository {
  protected override readonly proof = new PrivateMessageMediaRequiredProof();
  constructor(
    private readonly privateMessageOwners: PrivateMessageOwnerProofRegistry,
  ) {
    super(new MediaOwnerProofRegistry([]));
  }
  async draftFacts(
    actor: string,
    conversationId: string,
    messageRequestId: string,
    contextDigest: string,
    raw: PrivateMessageMediaFact,
    tx: PoolClient,
    deferProof = false,
  ) {
    const fact = Object.freeze(privateMessageMediaFactSchema.parse(raw));
    await this.draftRow(
      actor,
      conversationId,
      messageRequestId,
      contextDigest,
      fact,
      tx,
      'read',
    );
    if (!deferProof) await this.proof.capture(tx);
    return fact;
  }
  private async draftRow(
    actor: string,
    conversationId: string,
    messageRequestId: string,
    contextDigest: string,
    fact: PrivateMessageMediaFact,
    tx: PoolClient,
    mode: 'read' | 'write',
  ) {
    this.managed(tx);
    await this.lockIntents([fact.assetId], tx, mode);
    const row = (
      await tx.query<AssetRow & { protocol_version: number }>(
        `SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=$1 FOR ${mode === 'read' ? 'SHARE' : 'UPDATE'} OF a NOWAIT`,
        [fact.assetId],
      )
    ).rows[0];
    await tx.query(
      `SELECT id FROM whaleu_media.bindings WHERE asset_id=$1 FOR ${mode === 'read' ? 'SHARE' : 'UPDATE'} NOWAIT`,
      [fact.assetId],
    );
    if (
      !row ||
      !this.privateAsset(row) ||
      row.protocol_version !== 15 ||
      row.actor_id !== actor ||
      row.manifest_digest !== fact.manifestDigest
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const scope = (
      await tx.query<{ expires_at: Date }>(
        `SELECT expires_at FROM whaleu_media.private_message_scopes WHERE id=$1 AND actor_id=$2 AND scope_revision=$3 AND conversation_id=$4 AND message_request_id=$5 AND context_digest=$6`,
        [
          row.resource_id,
          actor,
          row.scope_revision,
          conversationId,
          messageRequestId,
          contextDigest,
        ],
      )
    ).rows[0];
    if (
      !scope ||
      (
        await tx.query(
          'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
          [row.id],
        )
      ).rowCount
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    registerTransactionDeadline(
      tx,
      scope.expires_at.getTime(),
      'MEDIA_NOT_READY',
    );
    await this.requireRetention(row, tx);
    await this.current(row, tx);
    return row;
  }
  async acceptAndBind(
    messageId: string,
    actor: string,
    conversationId: string,
    messageRequestId: string,
    contextDigest: string,
    raw: PrivateMessageMediaFact,
    tx: PoolClient,
  ) {
    const fact = privateMessageMediaFactSchema.parse(raw),
      row = await this.draftRow(
        actor,
        conversationId,
        messageRequestId,
        contextDigest,
        fact,
        tx,
        'write',
      ),
      bindingId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_media.scope_consumptions(actor_id,owner_kind,resource_kind,scope_resource_id,scope_revision,resource_id,content_version,attach_evidence) VALUES($1,'messaging','private_message_image',$2,$3,$4,1,$5::jsonb)`,
      [
        actor,
        row.resource_id,
        row.scope_revision,
        messageId,
        JSON.stringify({
          version: 15,
          assets: [{ assetId: row.id, digest: row.manifest_digest }],
        }),
      ],
    );
    await tx.query(
      `INSERT INTO whaleu_media.bindings(id,asset_id,manifest_digest,owner_kind,resource_kind,resource_id,content_version,slot,ordinal,attach_evidence) VALUES($1,$2,$3,'messaging','private_message_image',$4,1,'image',0,$5::jsonb)`,
      [
        bindingId,
        row.id,
        row.manifest_digest,
        messageId,
        JSON.stringify({
          version: 15,
          scopeId: row.resource_id,
          scopeRevision: row.scope_revision,
        }),
      ],
    );
    await tx.query(
      `INSERT INTO whaleu_media.private_message_appearances(message_id,conversation_id,actor_id,message_request_id,context_digest,asset_id,manifest_digest,binding_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        messageId,
        conversationId,
        actor,
        messageRequestId,
        contextDigest,
        row.id,
        row.manifest_digest,
        bindingId,
      ],
    );
    await this.proof.capture(tx);
    return Object.freeze({ ...fact, bindingId });
  }
  /** Recall retires authority atomically. Durable exact-object cleanup is staged,
   * but physical collection requires a real retention grant and quiet deliveries. */
  async retireMessage(messageId: string, tx: PoolClient) {
    this.managed(tx);
    const appearance = (
      await tx.query<{ asset_id: string; binding_id: string }>(
        'SELECT asset_id,binding_id FROM whaleu_media.private_message_appearances WHERE message_id=$1',
        [messageId],
      )
    ).rows[0];
    if (!appearance) return;
    await this.lockIntents([appearance.asset_id], tx, 'write');
    await tx.query(
      'SELECT id FROM whaleu_media.assets WHERE id=$1 FOR UPDATE NOWAIT',
      [appearance.asset_id],
    );
    const row = (
      await tx.query<{ intent_id: string; detached_at: Date | null }>(
        `SELECT a.intent_id,b.detached_at FROM whaleu_media.private_message_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id JOIN whaleu_media.assets a ON a.id=p.asset_id WHERE p.message_id=$1 AND b.resource_id=p.message_id AND b.asset_id=p.asset_id AND b.manifest_digest=p.manifest_digest FOR UPDATE OF b NOWAIT`,
        [messageId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (row.detached_at) return;
    if (
      !(
        await tx.query(
          'SELECT 1 FROM whaleu_messaging.messages WHERE id=$1 AND recalled_at IS NOT NULL',
          [messageId],
        )
      ).rowCount
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await tx.query(
      "INSERT INTO whaleu_media.private_message_retirements(binding_id,message_id,cause) VALUES($1,$2,'recalled')",
      [appearance.binding_id, messageId],
    );
    await tx.query(
      "UPDATE whaleu_media.bindings SET detached_at=clock_timestamp(),detach_reason='private-message-recalled' WHERE id=$1 AND detached_at IS NULL",
      [appearance.binding_id],
    );
    await new MediaLifecycleRepository().detachedOwnerIntent(row.intent_id, tx);
    await this.proof.capture(tx);
  }
  async currentFacts(
    messageId: string,
    raw: PrivateMessageMediaBinding,
    tx: PoolClient,
  ) {
    this.managed(tx);
    const image = Object.freeze(privateMessageMediaBindingSchema.parse(raw));
    await this.lockIntents([image.assetId], tx, 'read');
    const row = (
      await tx.query<
        AssetRow & { protocol_version: number; conversation_id: string }
      >(
        `SELECT a.*,i.protocol_version,p.conversation_id FROM whaleu_media.private_message_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id JOIN whaleu_media.assets a ON a.id=p.asset_id JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE p.message_id=$1 AND p.asset_id=$2 AND p.manifest_digest=$3 AND p.binding_id=$4 AND b.resource_id=p.message_id AND b.owner_kind='messaging' AND b.resource_kind='private_message_image' AND b.slot='image' AND b.ordinal=0 AND b.content_version=1 AND b.asset_id=p.asset_id AND b.manifest_digest=p.manifest_digest AND a.manifest_digest=p.manifest_digest AND b.detached_at IS NULL AND NOT EXISTS(SELECT 1 FROM whaleu_media.private_message_retirements r WHERE r.binding_id=b.id) FOR SHARE OF a,b NOWAIT`,
        [messageId, image.assetId, image.manifestDigest, image.bindingId],
      )
    ).rows[0];
    if (!row || !this.privateAsset(row) || row.protocol_version !== 15)
      throw new ApplicationError('MEDIA_NOT_READY');
    // Bound history deliberately does not check the upload/scope expiry.
    const manifest = await this.current(row, tx),
      head = (
        await tx.query<{ revision: string; event_id: string }>(
          'SELECT revision::text,event_id FROM whaleu_media.asset_safety_heads WHERE asset_id=$1',
          [row.id],
        )
      ).rows[0];
    if (!head) throw new ApplicationError('MEDIA_NOT_READY');
    const safety = Object.freeze([
      { assetId: row.id, revision: head.revision, eventId: head.event_id },
    ]);
    const descriptor = privateMessageDescriptorSchema.parse({
      protocol: PRIVATE_MESSAGE_MEDIA_PROTOCOL,
      kind: 'private-message-media',
      conversationId: row.conversation_id,
      messageId,
      bindingId: image.bindingId,
      width: manifest.variants[1].width,
      height: manifest.variants[1].height,
      variants: ['thumb-v1', 'display-v1'],
    });
    await this.proof.capture(tx);
    return {
      image: Object.freeze({ ...image, descriptor }),
      safety,
      revision: createHash('sha256')
        .update('whaleu-private-message-media:v1\n')
        .update(JSON.stringify({ messageId, image, safety }))
        .digest('hex'),
      row,
      manifest,
    };
  }
  async describe(
    proof: PrivateMessageReadProof,
    request: PrivateMessageReadRequest,
    tx: PoolClient,
  ) {
    return (await this.read(proof, request, tx)).facts.image.descriptor;
  }
  async plan(
    proof: PrivateMessageReadProof,
    request: PrivateMessageReadRequest,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<
    ExactMediaDeliveryPlan & {
      accountId: string;
      sessionId: string;
      bindingId: string;
    }
  > {
    const { facts, authority } = await this.read(proof, request, tx),
      object = facts.manifest.variants.find((x) => x.name === variant);
    if (!object) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return Object.freeze({
      object: object.object,
      sha256: object.sha256,
      bytes: object.bytes,
      mime: object.mime,
      accountId: authority.accountId,
      sessionId: authority.sessionId,
      bindingId: authority.reference.bindingId,
      attachmentSetRevision: createHash('sha256')
        .update('whaleu-private-message-delivery:v1\n')
        .update(
          JSON.stringify({
            reference: authority.reference,
            ownerRevision: authority.ownerRevision,
            mediaRevision: facts.revision,
            accountId: authority.accountId,
            sessionId: authority.sessionId,
            variant,
          }),
        )
        .digest('hex'),
    });
  }
  private async read(
    proof: PrivateMessageReadProof,
    request: PrivateMessageReadRequest,
    tx: PoolClient,
  ) {
    const authority = this.privateMessageOwners.require(proof, request, tx),
      facts = await this.currentFacts(authority.messageId, authority.image, tx);
    const exact = await tx.query(
      `SELECT 1 FROM whaleu_media.private_message_appearances WHERE message_id=$1 AND conversation_id=$2 AND actor_id=$3 AND message_request_id=$4 AND context_digest=$5 AND binding_id=$6`,
      [
        authority.messageId,
        authority.conversationId,
        authority.actorAccountId,
        authority.messageRequestId,
        authority.contextDigest,
        authority.reference.bindingId,
      ],
    );
    if (exact.rowCount !== 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return { authority, facts };
  }
  private privateAsset(row: AssetRow) {
    return (
      row.owner_kind === 'messaging' &&
      row.resource_kind === 'private_message_image' &&
      row.target_kind === 'edit' &&
      row.content_version === '1' &&
      row.audience === 'conversation-private' &&
      row.purpose === 'private-message-image' &&
      row.slot === 'image' &&
      row.ordinal === 0
    );
  }
}
