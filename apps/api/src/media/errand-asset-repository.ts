import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { MediaAssetRepository } from './asset-repository.js';
import type { AssetRow } from './asset-repository.js';
import { MediaOwnerProofRegistry } from './owner-proof.js';
import { ErrandMediaRequiredProof } from './errand-required-proof.js';
import type {
  ErrandOwnerProofRegistry,
  ErrandReadProof,
  ErrandReadRequest,
} from './errand-owner-proof.js';
import type { MediaVariantName, MediaManifest } from './contracts.js';
import type { ExactMediaDeliveryPlan } from './delivery.js';
import {
  ERRAND_MEDIA_PROTOCOL,
  errandDescriptorSchema,
  errandMediaSlotSchema,
  errandMediaFactsSchema,
  errandMediaBindingsSchema,
  errandMediaAudience,
  errandMediaPurpose,
} from './contracts-errand.js';
import type {
  ErrandMediaSlot,
  ErrandMediaFact,
  ErrandMediaBinding,
} from './contracts-errand.js';
import { MediaLifecycleRepository } from './lifecycle-repository.js';
const ordered = <T extends { slot: ErrandMediaSlot }>(items: readonly T[]) =>
  [...items].sort(
    (a, b) =>
      errandMediaSlotSchema.options.indexOf(a.slot) -
      errandMediaSlotSchema.options.indexOf(b.slot),
  );
export class ErrandMediaAssetRepository extends MediaAssetRepository {
  protected override readonly proof = new ErrandMediaRequiredProof();
  constructor(private readonly errandOwners: ErrandOwnerProofRegistry) {
    super(new MediaOwnerProofRegistry([]));
  }
  async draftFacts(
    actor: string,
    draftId: string,
    draftRevision: number,
    authorityVersion: string,
    raw: readonly ErrandMediaFact[],
    tx: PoolClient,
    deferProof = false,
  ) {
    const items = ordered(errandMediaFactsSchema.parse(raw));
    await this.draftRows(
      actor,
      draftId,
      draftRevision,
      authorityVersion,
      items,
      tx,
      'read',
    );
    if (!deferProof) await this.proof.capture(tx);
    return Object.freeze(items.map((x) => Object.freeze(x)));
  }
  private async draftRows(
    actor: string,
    draftId: string,
    draftRevision: number,
    authorityVersion: string,
    items: readonly ErrandMediaFact[],
    tx: PoolClient,
    mode: 'read' | 'write',
  ) {
    this.managed(tx);
    const ids = items.map((x) => x.assetId).sort();
    await this.lockIntents(ids, tx, mode);
    const rows = (
      await tx.query<AssetRow & { protocol_version: number }>(
        `SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=ANY($1::uuid[]) ORDER BY a.id FOR ${mode === 'read' ? 'SHARE' : 'UPDATE'} OF a NOWAIT`,
        [ids],
      )
    ).rows;
    if (rows.length !== items.length)
      throw new ApplicationError('MEDIA_NOT_READY');
    await tx.query(
      `SELECT id FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[]) ORDER BY id FOR ${mode === 'read' ? 'SHARE' : 'UPDATE'} NOWAIT`,
      [ids],
    );
    for (const item of items) {
      const row = rows.find((x) => x.id === item.assetId);
      if (
        !row ||
        !this.errandAsset(row) ||
        row.protocol_version !== 14 ||
        row.actor_id !== actor ||
        row.slot !== item.slot ||
        row.manifest_digest !== item.manifestDigest
      )
        throw new ApplicationError('MEDIA_NOT_READY');
      const scope = (
        await tx.query<{ expires_at: Date }>(
          `SELECT expires_at FROM whaleu_media.errand_scopes WHERE id=$1 AND actor_id=$2 AND scope_revision=$3 AND draft_id=$4 AND draft_revision=$5 AND slot=$6 AND authority_version=$7`,
          [
            row.resource_id,
            actor,
            row.scope_revision,
            draftId,
            draftRevision,
            item.slot,
            authorityVersion,
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
    }
    return rows;
  }
  async acceptAndBindMany(
    actor: string,
    draftId: string,
    draftRevision: number,
    orderId: string,
    authorityVersion: string,
    raw: readonly ErrandMediaFact[],
    tx: PoolClient,
  ) {
    const items = ordered(errandMediaFactsSchema.parse(raw));
    const rows = await this.draftRows(
      actor,
      draftId,
      draftRevision,
      authorityVersion,
      items,
      tx,
      'write',
    );
    const result: ErrandMediaBinding[] = [];
    for (const item of items) {
      const row = rows.find((x) => x.id === item.assetId)!;
      const bindingId = randomUUID(),
        appearanceId = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_media.scope_consumptions(actor_id,owner_kind,resource_kind,scope_resource_id,scope_revision,resource_id,content_version,attach_evidence) VALUES($1,'errands','errand_image',$2,$3,$4,1,$5::jsonb)`,
        [
          actor,
          row.resource_id,
          row.scope_revision,
          appearanceId,
          JSON.stringify({
            version: 14,
            assets: [{ assetId: row.id, digest: row.manifest_digest }],
          }),
        ],
      );
      await tx.query(
        `INSERT INTO whaleu_media.bindings(id,asset_id,manifest_digest,owner_kind,resource_kind,resource_id,content_version,slot,ordinal,attach_evidence) VALUES($1,$2,$3,'errands','errand_image',$4,1,$5,0,$6::jsonb)`,
        [
          bindingId,
          row.id,
          row.manifest_digest,
          appearanceId,
          item.slot,
          JSON.stringify({
            version: 14,
            scopeId: row.resource_id,
            scopeRevision: row.scope_revision,
          }),
        ],
      );
      await tx.query(
        `INSERT INTO whaleu_media.errand_appearances(id,order_id,slot,actor_id,draft_id,draft_revision,asset_id,manifest_digest,binding_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          appearanceId,
          orderId,
          item.slot,
          actor,
          draftId,
          draftRevision,
          row.id,
          row.manifest_digest,
          bindingId,
        ],
      );
      result.push({ ...item, bindingId });
    }
    // Do not enroll an epoch until every slot's writes have finished.
    await this.proof.capture(tx);
    return Object.freeze(result.map((x) => Object.freeze(x)));
  }
  /** Retirement is authorized only by owner tombstone or exact audit subtraction;
   * cancellation/completion of an order never retires a bound asset. No Review. */
  async retireMany(
    orderId: string,
    raw: readonly ErrandMediaBinding[],
    tx: PoolClient,
  ) {
    this.managed(tx);
    const items = ordered(errandMediaBindingsSchema.parse(raw));
    const ids = items.map((x) => x.assetId).sort();
    await this.lockIntents(ids, tx, 'write');
    await tx.query(
      'SELECT id FROM whaleu_media.assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
      [ids],
    );
    await tx.query(
      'SELECT id FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
      [ids],
    );
    for (const item of items) {
      const row = (
        await tx.query<{ intent_id: string; detached_at: Date | null }>(
          `SELECT a.intent_id,b.detached_at FROM whaleu_media.errand_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id JOIN whaleu_media.assets a ON a.id=p.asset_id WHERE p.order_id=$1 AND p.slot=$2 AND p.asset_id=$3 AND p.manifest_digest=$4 AND p.binding_id=$5 AND b.resource_id=p.id AND b.owner_kind='errands' AND b.resource_kind='errand_image' AND b.asset_id=p.asset_id AND b.manifest_digest=p.manifest_digest`,
          [
            orderId,
            item.slot,
            item.assetId,
            item.manifestDigest,
            item.bindingId,
          ],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
      if (row.detached_at) continue;
      const cause = (
        await tx.query<{ cause: 'deleted' | 'audit_subtraction' }>(
          `SELECT CASE WHEN o.deleted_at IS NOT NULL THEN 'deleted' ELSE 'audit_subtraction' END cause FROM whaleu_errands.orders o WHERE o.id=$1 AND (o.deleted_at IS NOT NULL OR EXISTS(SELECT 1 FROM whaleu_errands.media_heads h JOIN whaleu_errands.media_sets s ON(s.order_id,s.revision)=(h.order_id,h.revision) JOIN whaleu_errands.media_sets prior ON(prior.order_id,prior.revision)=(s.order_id,s.prior_revision) WHERE h.order_id=o.id AND s.cause='audit_subtraction' AND s.transaction_id=pg_current_xact_id() AND EXISTS(SELECT 1 FROM jsonb_array_elements(prior.public_media||prior.private_media) v WHERE v->>'bindingId'=$2) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.public_media||s.private_media) v WHERE v->>'bindingId'=$2)))`,
          [orderId, item.bindingId],
        )
      ).rows[0];
      if (!cause) throw new ApplicationError('MEDIA_UNAVAILABLE');
      await tx.query(
        'INSERT INTO whaleu_media.errand_retirements(binding_id,order_id,cause) VALUES($1,$2,$3)',
        [item.bindingId, orderId, cause.cause],
      );
      await tx.query(
        'UPDATE whaleu_media.bindings SET detached_at=clock_timestamp(),detach_reason=$2 WHERE id=$1 AND detached_at IS NULL',
        [item.bindingId, `errand-media-${cause.cause}`],
      );
      await new MediaLifecycleRepository().detachedOwnerIntent(
        row.intent_id,
        tx,
      );
    }
    await this.proof.capture(tx);
  }
  /** expectedBindings comes from the owner, never inferred from binding rows. */
  async currentFacts(
    orderId: string,
    mediaRevision: number,
    raw: readonly ErrandMediaBinding[],
    tx: PoolClient,
  ) {
    this.managed(tx);
    if (!Number.isSafeInteger(mediaRevision) || mediaRevision < 1)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const items = ordered(errandMediaBindingsSchema.parse(raw));
    const ids = items.map((x) => x.assetId).sort();
    await this.lockIntents(ids, tx, 'read');
    const actual = (
      await tx.query<{ binding_id: string }>(
        `SELECT p.binding_id FROM whaleu_media.errand_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id WHERE p.order_id=$1 AND b.detached_at IS NULL ORDER BY p.binding_id`,
        [orderId],
      )
    ).rows;
    if (
      actual.length !== items.length ||
      actual.some((x) => !items.some((y) => y.bindingId === x.binding_id))
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const media = [];
    const safety = [];
    const internals = new Map<
      string,
      { row: AssetRow; manifest: MediaManifest }
    >();
    for (const item of items) {
      const row = (
        await tx.query<AssetRow & { protocol_version: number }>(
          `SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id JOIN whaleu_media.bindings b ON b.asset_id=a.id JOIN whaleu_media.errand_appearances p ON p.binding_id=b.id WHERE p.order_id=$1 AND p.slot=$2 AND p.asset_id=$3 AND p.manifest_digest=$4 AND p.binding_id=$5 AND b.owner_kind='errands' AND b.resource_kind='errand_image' AND b.resource_id=p.id AND b.slot=p.slot AND b.ordinal=0 AND b.content_version=1 AND b.manifest_digest=p.manifest_digest AND a.manifest_digest=p.manifest_digest AND b.detached_at IS NULL FOR SHARE OF a,b NOWAIT`,
          [
            orderId,
            item.slot,
            item.assetId,
            item.manifestDigest,
            item.bindingId,
          ],
        )
      ).rows[0];
      if (
        !row ||
        !this.errandAsset(row) ||
        row.protocol_version !== 14 ||
        row.slot !== item.slot
      )
        throw new ApplicationError('MEDIA_NOT_READY');
      const manifest = await this.current(row, tx);
      const head = (
        await tx.query<{ revision: string; event_id: string }>(
          'SELECT revision::text,event_id FROM whaleu_media.asset_safety_heads WHERE asset_id=$1',
          [row.id],
        )
      ).rows[0];
      if (!head) throw new ApplicationError('MEDIA_NOT_READY');
      safety.push({
        assetId: row.id,
        revision: head.revision,
        eventId: head.event_id,
      });
      const descriptor = errandDescriptorSchema.parse({
        protocol: ERRAND_MEDIA_PROTOCOL,
        kind: 'errand-media',
        orderId,
        revision: mediaRevision,
        slot: item.slot,
        bindingId: item.bindingId,
        width: manifest.variants[1].width,
        height: manifest.variants[1].height,
        variants: ['thumb-v1', 'display-v1'],
      });
      media.push(Object.freeze({ ...item, descriptor }));
      internals.set(item.bindingId, { row, manifest });
    }
    await this.proof.capture(tx);
    return {
      media: Object.freeze(media),
      safety: Object.freeze(safety),
      revision: createHash('sha256')
        .update('whaleu-errand-media-set:v1\n')
        .update(JSON.stringify({ orderId, mediaRevision, items, safety }))
        .digest('hex'),
      internals,
    };
  }
  async describe(
    proof: ErrandReadProof,
    request: ErrandReadRequest,
    tx: PoolClient,
  ) {
    const { facts, authority } = await this.read(proof, request, tx);
    return facts.media.find(
      (x) => x.bindingId === authority.reference.bindingId,
    )!.descriptor;
  }
  async plan(
    proof: ErrandReadProof,
    request: ErrandReadRequest,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<ExactMediaDeliveryPlan & { accountId: string }> {
    const { facts, authority } = await this.read(proof, request, tx);
    const value = facts.internals.get(authority.reference.bindingId),
      object = value?.manifest.variants.find((x) => x.name === variant);
    if (!value || !object) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return Object.freeze({
      object: object.object,
      sha256: object.sha256,
      bytes: object.bytes,
      mime: object.mime,
      accountId: authority.accountId,
      attachmentSetRevision: createHash('sha256')
        .update('whaleu-errand-delivery:v1\n')
        .update(
          JSON.stringify({
            reference: authority.reference,
            ownerRevision: authority.ownerRevision,
            mediaSetRevision: facts.revision,
            accountId: authority.accountId,
            sessionId: authority.sessionId,
            variant,
          }),
        )
        .digest('hex'),
    });
  }
  private async read(
    proof: ErrandReadProof,
    request: ErrandReadRequest,
    tx: PoolClient,
  ) {
    const authority = this.errandOwners.require(proof, request, tx);
    const facts = await this.currentFacts(
      authority.orderId,
      authority.mediaRevision,
      authority.media,
      tx,
    );
    // The publication identity is also owner-authored and immutable.
    const exact = await tx.query(
      `SELECT 1 FROM whaleu_media.errand_appearances WHERE order_id=$1 AND binding_id=ANY($2::uuid[]) AND (draft_id<>$3 OR draft_revision<>$4 OR actor_id<>$5)`,
      [
        authority.orderId,
        authority.media.map((x) => x.bindingId),
        authority.draftId,
        authority.draftRevision,
        authority.actorAccountId,
      ],
    );
    if (exact.rowCount) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return { authority, facts };
  }
  private errandAsset(row: AssetRow) {
    const slot = errandMediaSlotSchema.safeParse(row.slot);
    return (
      slot.success &&
      row.owner_kind === 'errands' &&
      row.resource_kind === 'errand_image' &&
      row.target_kind === 'edit' &&
      row.content_version === '1' &&
      row.audience === errandMediaAudience(slot.data) &&
      row.purpose === errandMediaPurpose(slot.data) &&
      row.ordinal === 0
    );
  }
}
