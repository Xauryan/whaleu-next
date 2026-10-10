import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  registerTransactionDeadline,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { MediaAssetRepository } from './asset-repository.js';
import type { AssetRow } from './asset-repository.js';
import { MediaOwnerProofRegistry } from './owner-proof.js';
import { MediaLifecycleRepository } from './lifecycle-repository.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { mediaAttachmentDescriptorSchema } from './contracts.js';
import type { MediaVariantName } from './contracts.js';
import {
  ratingsMediaParentSchema,
  ratingsMediaDescriptorSchema,
} from './contracts-ratings.js';
import type {
  RatingsMediaParent,
  RatingsMediaDescriptor,
} from './contracts-ratings.js';
import type {
  RatingsMediaProofRegistry,
  RatingsMediaReadProof,
  RatingsMediaReadRequest,
} from './ratings-owner-proof.js';
import type { RatingsMediaDeliveryPlan } from './ratings-delivery.js';

export interface RatingsMediaAttachScope {
  readonly actor: string;
  readonly scopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
}
const replacementBrand: unique symbol = Symbol('ratings-media-replacement');
export interface RatingsMediaReplacement {
  readonly [replacementBrand]: true;
}
const acceptedBrand: unique symbol = Symbol('accepted-ratings-cover');
export interface AcceptedRatingsMedia {
  readonly [acceptedBrand]: true;
  readonly assetId: string;
  readonly manifestDigest: string;
}
interface OldBinding {
  id: string;
  asset_id: string;
  intent_id: string;
}
interface ReplacementFacts {
  tx: PoolClient;
  epoch: object;
  actor: string;
  oldParent: RatingsMediaParent | null;
  old: readonly OldBinding[];
  newAssetId: string | null;
  bound: boolean;
  finished: boolean;
}
interface AcceptedFacts {
  tx: PoolClient;
  epoch: object;
  scope: RatingsMediaAttachScope;
  row: AssetRow;
  replacement: RatingsMediaReplacement;
}
/** Ratings owns the mutable pointer; Media owns only immutable exact appearances.
 * Old/new sources are gathered before taking any Media mutation lock. */
export class RatingsMediaAssetRepository extends MediaAssetRepository {
  private readonly replacements = new WeakMap<
    RatingsMediaReplacement,
    ReplacementFacts
  >();
  private readonly completion: RequiredTransactionProof<RatingsMediaReplacement> =
    {
      maximumFacts: 8,
      failureCode: 'MEDIA_UNAVAILABLE',
      validate: async (proofs, tx) => {
        for (const proof of proofs) {
          const facts = this.replacements.get(proof);
          if (
            !facts ||
            facts.tx !== tx ||
            facts.epoch !== this.managed(tx) ||
            !facts.finished
          )
            throw new ApplicationError('MEDIA_UNAVAILABLE');
        }
      },
    };
  private readonly ratingsAccepted = new WeakMap<
    AcceptedRatingsMedia,
    AcceptedFacts
  >();
  constructor(private readonly ratingsOwners: RatingsMediaProofRegistry) {
    super(new MediaOwnerProofRegistry([]));
  }
  /** Preparation-only trusted facts. This enrolls Media before returning; callers
   * must not reuse this read transaction to perform replacement writes. */
  async describeRatingsReady(
    scope: RatingsMediaAttachScope,
    id: string,
    tx: PoolClient,
  ): Promise<{ assetId: string; manifestDigest: string }> {
    this.managed(tx);
    mediaV2IdSchema.parse(id);
    await this.proof.capture(tx);
    await this.lockIntents([id], tx, 'read');
    const row = (
      await tx.query<AssetRow & { protocol_version: number }>(
        'SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=$1 FOR SHARE OF a NOWAIT',
        [id],
      )
    ).rows[0];
    if (
      !row ||
      row.protocol_version !== 6 ||
      row.actor_id !== scope.actor ||
      row.owner_kind !== 'ratings' ||
      row.resource_kind !== 'target_cover' ||
      row.purpose !== 'ratings-target-cover-image' ||
      row.audience !== 'content-gated' ||
      row.target_kind !== 'edit' ||
      row.resource_id !== scope.scopeId ||
      row.scope_revision !== scope.scopeRevision ||
      Number(row.content_version) !== 1 ||
      row.slot !== 'cover' ||
      row.ordinal !== 0 ||
      (
        await tx.query(
          'SELECT id FROM whaleu_media.bindings WHERE asset_id=$1',
          [id],
        )
      ).rowCount !== 0
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    registerTransactionDeadline(tx, scope.expiresAt, 'MEDIA_NOT_READY');
    await this.requireRatingsRetention(row, tx);
    await this.current(row, tx);
    return Object.freeze({
      assetId: row.id,
      manifestDigest: row.manifest_digest,
    });
  }
  async prepareRatingsReplacement(
    actor: string,
    oldParent: RatingsMediaParent | null,
    newAssetId: string | null,
    tx: PoolClient,
  ): Promise<RatingsMediaReplacement> {
    const epoch = this.managed(tx);
    mediaV2IdSchema.parse(actor);
    if (oldParent) oldParent = ratingsMediaParentSchema.parse(oldParent);
    if (newAssetId) mediaV2IdSchema.parse(newAssetId);
    const old = oldParent
      ? (
          await tx.query<OldBinding>(
            `SELECT b.id,b.asset_id,a.intent_id FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE b.owner_kind='ratings' AND b.resource_kind='target_cover' AND b.resource_id=$1 AND b.content_version=1 AND b.slot='cover' AND b.ordinal=0 AND b.detached_at IS NULL AND a.actor_id=$2`,
            [oldParent.resourceId, actor],
          )
        ).rows
      : [];
    if (oldParent && old.length !== 1)
      throw new ApplicationError('MEDIA_NOT_READY');
    const ids = [
      ...new Set([
        ...old.map((row) => row.asset_id),
        ...(newAssetId ? [newAssetId] : []),
      ]),
    ].sort();
    if (newAssetId && old.some((row) => row.asset_id === newAssetId))
      throw new ApplicationError('MEDIA_NOT_READY');
    await this.lockIntents(ids, tx, 'write');
    const assets = (
      await tx.query<AssetRow>(
        'SELECT * FROM whaleu_media.assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
        [ids],
      )
    ).rows;
    if (
      assets.length !== ids.length ||
      assets.some(
        (row) =>
          row.actor_id !== actor ||
          row.owner_kind !== 'ratings' ||
          row.resource_kind !== 'target_cover' ||
          row.slot !== 'cover',
      )
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const bindings = (
      await tx.query<{
        id: string;
        asset_id: string;
        detached_at: Date | null;
      }>(
        'SELECT id,asset_id,detached_at FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
        [ids],
      )
    ).rows;
    if (
      bindings.length !== old.length ||
      old.some(
        (row) =>
          !bindings.some(
            (binding) =>
              binding.id === row.id &&
              binding.asset_id === row.asset_id &&
              binding.detached_at === null,
          ),
      )
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const proof: RatingsMediaReplacement = Object.freeze({
      [replacementBrand]: true as const,
    });
    this.replacements.set(proof, {
      tx,
      epoch,
      actor,
      oldParent,
      old: Object.freeze(old),
      newAssetId,
      bound: false,
      finished: false,
    });
    enableRequiredTransactionProof(tx, this.completion);
    registerRequiredTransactionFact(tx, this.completion, randomUUID(), proof);
    return proof;
  }
  async acceptRatingsOwned(
    scope: RatingsMediaAttachScope,
    id: string,
    replacement: RatingsMediaReplacement,
    tx: PoolClient,
  ): Promise<AcceptedRatingsMedia> {
    const locks = this.requireReplacement(replacement, tx);
    if (locks.actor !== scope.actor || locks.newAssetId !== id || locks.bound)
      throw new ApplicationError('MEDIA_NOT_READY');
    const row = (
      await tx.query<AssetRow & { protocol_version: number }>(
        'SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=$1',
        [id],
      )
    ).rows[0];
    if (
      !row ||
      row.protocol_version !== 6 ||
      row.actor_id !== scope.actor ||
      row.purpose !== 'ratings-target-cover-image' ||
      row.audience !== 'content-gated' ||
      row.owner_kind !== 'ratings' ||
      row.resource_kind !== 'target_cover' ||
      row.target_kind !== 'edit' ||
      row.resource_id !== scope.scopeId ||
      row.scope_revision !== scope.scopeRevision ||
      Number(row.content_version) !== 1 ||
      row.slot !== 'cover' ||
      row.ordinal !== 0
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    registerTransactionDeadline(tx, scope.expiresAt, 'MEDIA_NOT_READY');
    await this.requireRatingsRetention(row, tx);
    await this.current(row, tx);
    const proof: AcceptedRatingsMedia = Object.freeze({
      [acceptedBrand]: true as const,
      assetId: row.id,
      manifestDigest: row.manifest_digest,
    });
    this.ratingsAccepted.set(proof, {
      tx,
      epoch: locks.epoch,
      scope: Object.freeze({ ...scope }),
      row,
      replacement,
    });
    return proof;
  }
  async bindRatings(
    accepted: AcceptedRatingsMedia,
    parent: RatingsMediaParent,
    replacement: RatingsMediaReplacement,
    tx: PoolClient,
  ): Promise<string> {
    parent = ratingsMediaParentSchema.parse(parent);
    const locks = this.requireReplacement(replacement, tx),
      facts = this.ratingsAccepted.get(accepted);
    if (
      !facts ||
      facts.tx !== tx ||
      facts.epoch !== this.managed(tx) ||
      facts.replacement !== replacement ||
      locks.bound ||
      locks.oldParent?.resourceId === parent.resourceId
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const row = facts.row;
    await this.requireRatingsRetention(row, tx);
    await this.current(row, tx);
    const evidence = {
      version: 6,
      operation: 'select_target_cover',
      assets: [{ assetId: row.id, digest: row.manifest_digest }],
    };
    await tx.query(
      `INSERT INTO whaleu_media.scope_consumptions(actor_id,owner_kind,resource_kind,scope_resource_id,scope_revision,resource_id,content_version,attach_evidence) VALUES($1,'ratings','target_cover',$2,$3,$4,1,$5)`,
      [
        facts.scope.actor,
        facts.scope.scopeId,
        facts.scope.scopeRevision,
        parent.resourceId,
        JSON.stringify(evidence),
      ],
    );
    const bindingId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_media.bindings(id,asset_id,manifest_digest,owner_kind,resource_kind,resource_id,content_version,slot,ordinal,attach_evidence) VALUES($1,$2,$3,'ratings','target_cover',$4,1,'cover',0,$5)`,
      [
        bindingId,
        row.id,
        row.manifest_digest,
        parent.resourceId,
        JSON.stringify({
          version: 6,
          scopeId: facts.scope.scopeId,
          scopeRevision: facts.scope.scopeRevision,
        }),
      ],
    );
    locks.bound = true;
    return bindingId;
  }
  /** Called after owner pointer/Review/receipt writes, and only once. It never
   * removes earlier transaction facts: pre-existing Media read facts still fail
   * if this transaction subsequently mutated their dependencies. */
  async finishRatingsReplacement(
    replacement: RatingsMediaReplacement,
    tx: PoolClient,
  ): Promise<void> {
    const facts = this.requireReplacement(replacement, tx);
    if (Boolean(facts.newAssetId) !== facts.bound)
      throw new ApplicationError('MEDIA_NOT_READY');
    if (facts.old.length) {
      const result = await tx.query(
        `UPDATE whaleu_media.bindings SET detached_at=clock_timestamp(),detach_reason='ratings-cover-replaced' WHERE id=ANY($1::uuid[]) AND detached_at IS NULL`,
        [facts.old.map((row) => row.id)],
      );
      if (result.rowCount !== facts.old.length)
        throw new ApplicationError('MEDIA_NOT_READY');
      const lifecycle = new MediaLifecycleRepository();
      for (const intent of [
        ...new Set(facts.old.map((row) => row.intent_id)),
      ].sort())
        await lifecycle.detachedOwnerIntent(intent, tx);
    }
    facts.finished = true;
    await this.proof.capture(tx);
  }
  /** Internal durable deletion enumeration only. Immutable tombstones are checked
   * before Media locks; this never calls the owner while holding asset locks. */
  async detachRatingsAppearances(
    appearanceIds: readonly string[],
    tx: PoolClient,
  ): Promise<void> {
    this.managed(tx);
    if (
      appearanceIds.length > 16 ||
      new Set(appearanceIds).size !== appearanceIds.length
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const ids = appearanceIds.map((id) => mediaV2IdSchema.parse(id)).sort();
    if (!ids.length) return;
    const appearances = (
      await tx.query<{
        id: string;
        asset_id: string;
        media_binding_id: string;
      }>(
        `SELECT p.id,p.asset_id,p.media_binding_id FROM whaleu_ratings.target_cover_appearances p
       JOIN whaleu_ratings.target_owner_tombstones t ON t.target_id=p.target_id
       WHERE p.id=ANY($1::uuid[]) ORDER BY p.id`,
        [ids],
      )
    ).rows;
    if (appearances.length !== ids.length)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const assets = appearances.map((row) => row.asset_id).sort();
    await this.lockIntents(assets, tx, 'write');
    const rows = (
      await tx.query<AssetRow>(
        'SELECT * FROM whaleu_media.assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
        [assets],
      )
    ).rows;
    if (
      rows.length !== assets.length ||
      rows.some(
        (row) =>
          row.owner_kind !== 'ratings' || row.resource_kind !== 'target_cover',
      )
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const bindings = (
      await tx.query<{
        id: string;
        asset_id: string;
        resource_id: string;
        detached_at: Date | null;
      }>(
        `SELECT id,asset_id,resource_id,detached_at FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])
       AND owner_kind='ratings' AND resource_kind='target_cover' AND slot='cover' AND ordinal=0 AND content_version=1 ORDER BY id FOR UPDATE NOWAIT`,
        [assets],
      )
    ).rows;
    if (
      bindings.length !== appearances.length ||
      appearances.some(
        (appearance) =>
          !bindings.some(
            (binding) =>
              binding.id === appearance.media_binding_id &&
              binding.asset_id === appearance.asset_id &&
              binding.resource_id === appearance.id,
          ),
      )
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const active = bindings.filter((row) => row.detached_at === null);
    if (active.length) {
      const detached = await tx.query(
        `UPDATE whaleu_media.bindings SET detached_at=clock_timestamp(),detach_reason='ratings-target-deleted' WHERE id=ANY($1::uuid[]) AND detached_at IS NULL`,
        [active.map((row) => row.id)],
      );
      if (detached.rowCount !== active.length)
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      const lifecycle = new MediaLifecycleRepository();
      for (const intent of rows
        .filter((row) => active.some((binding) => binding.asset_id === row.id))
        .map((row) => row.intent_id)
        .sort())
        await lifecycle.detachedOwnerIntent(intent, tx);
    }
    await this.proof.capture(tx);
  }
  async ratingsDescriptor(
    proof: RatingsMediaReadProof,
    request: RatingsMediaReadRequest,
    tx: PoolClient,
  ): Promise<RatingsMediaDescriptor> {
    const read = this.ratingsOwners.require(proof, request, tx);
    await this.proof.capture(tx);
    await this.lockIntents([read.assetId], tx, 'read');
    const asset = (
      await tx.query<AssetRow>(
        'SELECT * FROM whaleu_media.assets WHERE id=$1 FOR SHARE NOWAIT',
        [read.assetId],
      )
    ).rows[0];
    const bindings = (
      await tx.query<{
        id: string;
        asset_id: string;
        manifest_digest: string;
        ordinal: number;
      }>(
        `SELECT id,asset_id,manifest_digest,ordinal FROM whaleu_media.bindings WHERE owner_kind='ratings' AND resource_kind='target_cover' AND resource_id=$1 AND content_version=1 AND slot='cover' AND detached_at IS NULL ORDER BY id FOR SHARE NOWAIT`,
        [read.parent.resourceId],
      )
    ).rows;
    const binding = bindings[0];
    if (
      !asset ||
      bindings.length !== 1 ||
      !binding ||
      binding.id !== read.bindingId ||
      binding.asset_id !== read.assetId ||
      binding.manifest_digest !== read.manifestDigest ||
      binding.ordinal !== 0 ||
      asset.actor_id !== read.actorAccountId ||
      asset.manifest_digest !== read.manifestDigest ||
      asset.owner_kind !== 'ratings' ||
      asset.resource_kind !== 'target_cover' ||
      asset.purpose !== 'ratings-target-cover-image' ||
      asset.audience !== 'content-gated' ||
      asset.slot !== 'cover' ||
      asset.ordinal !== 0 ||
      Number(asset.content_version) !== 1
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const manifest = await this.current(asset, tx),
      display = manifest.variants[1];
    return ratingsMediaDescriptorSchema.parse({
      protocol: 'ratings-target-media-v1',
      kind: 'ratings-target-media',
      targetId: request.targetId,
      contextId: request.contextId,
      contextToken: request.contextToken,
      appearanceId: request.appearanceId,
      bindingId: binding.id,
      width: display.width,
      height: display.height,
      variants: ['thumb-v1', 'display-v1'],
    });
  }
  async ratingsDeliveryPlan(
    proof: RatingsMediaReadProof,
    request: RatingsMediaReadRequest,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<RatingsMediaDeliveryPlan> {
    const read = this.ratingsOwners.require(proof, request, tx),
      descriptor = await this.ratingsDescriptor(proof, request, tx);
    const asset = (
      await tx.query<AssetRow>(
        'SELECT * FROM whaleu_media.assets WHERE id=$1',
        [read.assetId],
      )
    ).rows[0];
    if (!asset) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const manifest = await this.current(asset, tx),
      object = manifest.variants.find((image) => image.name === variant),
      head = (
        await tx.query<{ revision: string }>(
          'SELECT revision::text FROM whaleu_media.asset_safety_heads WHERE asset_id=$1',
          [asset.id],
        )
      ).rows[0];
    if (!object || !head) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const legacyDescriptor = mediaAttachmentDescriptorSchema.parse({
      version: 1,
      kind: 'authenticated-media',
      assetId: asset.id,
      bindingId: descriptor.bindingId,
      width: descriptor.width,
      height: descriptor.height,
      variants: descriptor.variants,
    });
    return Object.freeze({
      parent: read.parent,
      targetId: read.targetId,
      contextId: request.contextId,
      contextToken: request.contextToken,
      bindingId: read.bindingId,
      principal: read.principal,
      ownerRevision: read.ownerRevision,
      reviewRevision: read.reviewRevision,
      variant,
      object: object.object,
      sha256: object.sha256,
      manifestDigest: asset.manifest_digest,
      safetyRevision: head.revision,
      attachmentSetRevision: await this.attachmentSetRevision(
        [legacyDescriptor],
        [{ assetId: asset.id, digest: asset.manifest_digest }],
        tx,
      ),
      bytes: object.bytes,
      mime: object.mime,
    });
  }
  private requireReplacement(
    proof: RatingsMediaReplacement,
    tx: PoolClient,
  ): ReplacementFacts {
    const facts = this.replacements.get(proof);
    if (
      !facts ||
      facts.tx !== tx ||
      facts.epoch !== this.managed(tx) ||
      facts.finished
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    return facts;
  }
  private async requireRatingsRetention(
    asset: AssetRow,
    tx: PoolClient,
  ): Promise<void> {
    await this.requireRetention(asset, tx);
    const intent = (
      await tx.query<{ expires_at: Date }>(
        `SELECT expires_at FROM whaleu_media.upload_intents WHERE id=$1 AND actor_id=$2 AND protocol_version=6 AND resource_id=$3 AND scope_revision=$4`,
        [
          asset.intent_id,
          asset.actor_id,
          asset.resource_id,
          asset.scope_revision,
        ],
      )
    ).rows[0];
    if (!intent) throw new ApplicationError('MEDIA_NOT_READY');
    registerTransactionDeadline(
      tx,
      intent.expires_at.getTime(),
      'MEDIA_NOT_READY',
    );
  }
}
