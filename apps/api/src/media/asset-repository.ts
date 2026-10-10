import { currentMediaSafety } from './current-safety.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../database/transaction-deadlines.js';
import { MediaLifecycleRepository } from './lifecycle-repository.js';
import { MediaRequiredProof } from './required-proof.js';
import { sealManifest } from './manifest.js';
import { mediaAttachmentDescriptorSchema } from './contracts.js';
import type {
  MediaAttachmentDescriptor,
  MediaManifest,
  MediaParent,
  MediaVariantName,
} from './contracts.js';
import type { MediaOwnerReadProof, OwnerReadRequest } from './owner-proof.js';
import { MediaOwnerProofRegistry } from './owner-proof.js';
import type { InternalMediaDeliveryPlan } from './delivery.js';

/** Internal known-denial discriminator; no new public authority/DTO. */
export class MediaCurrentDenied extends ApplicationError {
  constructor() {
    super('MEDIA_NOT_READY');
  }
}

interface AssetRow {
  id: string;
  intent_id: string;
  actor_id: string;
  purpose: string;
  audience: string;
  owner_kind: string;
  resource_kind: string;
  target_kind: string;
  resource_id: string;
  content_version: string;
  scope_revision: string;
  slot: string;
  ordinal: number;
  policy_revision: string;
  manifest_digest: string;
  manifest: unknown;
}
export interface MediaAssetScopeReference {
  readonly scopeId: string;
  readonly scopeRevision: string;
}
export interface ExpectedMediaAttachScope {
  readonly actor: string;
  readonly scopeId: string;
  readonly scopeRevision: string;
  readonly purpose: 'community-post-image';
  readonly audience: 'content-gated';
  readonly ownerKind: 'community';
  readonly resourceKind: 'post';
  readonly contentVersion: 1;
}
const acceptedBrand: unique symbol = Symbol('accepted-media-assets');
export interface AcceptedMediaAssets {
  readonly [acceptedBrand]: true;
  readonly images: readonly { assetId: string; digest: string }[];
}
interface AcceptedFacts {
  readonly tx: PoolClient;
  readonly epoch: object;
  readonly scope: ExpectedMediaAttachScope;
  readonly rows: readonly AssetRow[];
}
/** Internal shared owner. No business tables, provider effects, URLs or authorization
 * inference. Business first authorizes/locks its scope, then locks assets in UUID order. */
export class MediaAssetRepository {
  private readonly accepted = new WeakMap<AcceptedMediaAssets, AcceptedFacts>();
  private readonly proof = new MediaRequiredProof();
  constructor(private readonly owners: MediaOwnerProofRegistry) {}
  async peekOwnedScope(
    actor: string,
    ids: readonly string[],
    tx: PoolClient,
  ): Promise<MediaAssetScopeReference> {
    this.managed(tx);
    if (ids.length !== 1 || new Set(ids).size !== ids.length)
      throw new ApplicationError('MEDIA_NOT_READY');
    const rows = (
      await tx.query<AssetRow>(
        'SELECT * FROM whaleu_media.assets WHERE actor_id=$1 AND id=ANY($2::uuid[])',
        [actor, ids],
      )
    ).rows;
    const first = rows[0];
    if (
      !first ||
      rows.length !== ids.length ||
      first.target_kind !== 'draft' ||
      rows.some(
        (row) =>
          row.resource_id !== first.resource_id ||
          row.scope_revision !== first.scope_revision,
      )
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    return Object.freeze({
      scopeId: first.resource_id,
      scopeRevision: first.scope_revision,
    });
  }
  async acceptOwned(
    scope: ExpectedMediaAttachScope,
    ids: readonly string[],
    tx: PoolClient,
  ): Promise<AcceptedMediaAssets> {
    const epoch = this.managed(tx);
    if (ids.length !== 1 || new Set(ids).size !== ids.length)
      throw new ApplicationError('MEDIA_NOT_READY');
    const sorted = [...ids].sort();
    await this.lockIntents(sorted, tx, 'write');
    const rows = (
      await tx.query<AssetRow>(
        'SELECT * FROM whaleu_media.assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
        [sorted],
      )
    ).rows;
    if (rows.length !== ids.length)
      throw new ApplicationError('MEDIA_NOT_READY');
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered: AssetRow[] = [];
    for (let ordinal = 0; ordinal < ids.length; ordinal++) {
      const row = byId.get(ids[ordinal]!);
      if (
        !row ||
        row.actor_id !== scope.actor ||
        row.purpose !== scope.purpose ||
        row.audience !== scope.audience ||
        row.owner_kind !== scope.ownerKind ||
        row.resource_kind !== scope.resourceKind ||
        row.target_kind !== 'draft' ||
        row.resource_id !== scope.scopeId ||
        row.scope_revision !== scope.scopeRevision ||
        Number(row.content_version) !== scope.contentVersion ||
        row.slot !== 'images' ||
        row.ordinal !== ordinal
      )
        throw new ApplicationError('MEDIA_NOT_READY');
      await this.current(row, tx);
      if (
        (
          await tx.query(
            'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
            [row.id],
          )
        ).rowCount
      )
        throw new ApplicationError('MEDIA_NOT_READY');
      ordered.push(row);
    }
    const images = Object.freeze(
      ordered.map((row) =>
        Object.freeze({ assetId: row.id, digest: row.manifest_digest }),
      ),
    );
    const token: AcceptedMediaAssets = Object.freeze({
      [acceptedBrand]: true as const,
      images,
    });
    this.accepted.set(token, {
      tx,
      epoch,
      scope: Object.freeze({ ...scope }),
      rows: ordered,
    });
    return token;
  }
  async bind(
    accepted: AcceptedMediaAssets,
    parent: MediaParent,
    tx: PoolClient,
  ): Promise<void> {
    const facts = this.accepted.get(accepted);
    if (
      !facts ||
      facts.tx !== tx ||
      facts.epoch !== this.managed(tx) ||
      parent.ownerKind !== facts.scope.ownerKind ||
      parent.resourceKind !== facts.scope.resourceKind ||
      parent.contentVersion !== facts.scope.contentVersion
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    await tx.query(
      `INSERT INTO whaleu_media.scope_consumptions(actor_id,owner_kind,resource_kind,scope_resource_id,scope_revision,resource_id,content_version,attach_evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        facts.scope.actor,
        parent.ownerKind,
        parent.resourceKind,
        facts.scope.scopeId,
        facts.scope.scopeRevision,
        parent.resourceId,
        parent.contentVersion,
        JSON.stringify({ version: 1, assets: accepted.images }),
      ],
    );
    for (let ordinal = 0; ordinal < facts.rows.length; ordinal++) {
      const row = facts.rows[ordinal]!;
      // Recheck locked state and deadline after content Review consumption work.
      await this.current(row, tx);
      await tx.query(
        `INSERT INTO whaleu_media.bindings(id,asset_id,manifest_digest,owner_kind,resource_kind,resource_id,content_version,slot,ordinal,attach_evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,'images',$8,$9)`,
        [
          randomUUID(),
          row.id,
          row.manifest_digest,
          parent.ownerKind,
          parent.resourceKind,
          parent.resourceId,
          parent.contentVersion,
          ordinal,
          JSON.stringify({
            version: 1,
            scopeId: facts.scope.scopeId,
            scopeRevision: facts.scope.scopeRevision,
          }),
        ],
      );
    }
    // All expected Media writes precede this snapshot. Later Media writes fail
    // the mandatory final proof, so callers cannot silently omit revalidation.
    await this.proof.capture(tx);
  }
  async descriptors(
    proof: MediaOwnerReadProof,
    request: OwnerReadRequest,
    expected: readonly { assetId: string; digest: string }[],
    tx: PoolClient,
  ): Promise<MediaAttachmentDescriptor[]> {
    this.owners.require(proof, tx, request);
    return this.exactDescriptors(
      request.parent,
      request.audience,
      expected,
      tx,
    );
  }
  /** Internal leaf proof for the business visibility owner. Does not authorize
   * a viewer, produce a read capability, or open storage. The owner still proves
   * current content/ancestors/visibility separately before any disclosure. */
  async verifyContentBindings(
    parent: MediaParent,
    expected: readonly { assetId: string; digest: string }[],
    tx: PoolClient,
  ): Promise<void> {
    this.managed(tx);
    await this.exactDescriptors(parent, 'content-gated', expected, tx);
  }
  private async exactDescriptors(
    parent: MediaParent,
    audience: string,
    expected: readonly { assetId: string; digest: string }[],
    tx: PoolClient,
  ): Promise<MediaAttachmentDescriptor[]> {
    if (!expected.length || expected.length > 9)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.proof.capture(tx);
    const bindings = (
      await tx.query<{
        id: string;
        asset_id: string;
        manifest_digest: string;
        ordinal: number;
      }>(
        `SELECT id,asset_id,manifest_digest,ordinal FROM whaleu_media.bindings
      WHERE owner_kind=$1 AND resource_kind=$2 AND resource_id=$3 AND content_version=$4 AND slot='images' AND detached_at IS NULL ORDER BY ordinal`,
        [
          parent.ownerKind,
          parent.resourceKind,
          parent.resourceId,
          parent.contentVersion,
        ],
      )
    ).rows;
    if (bindings.length !== expected.length)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.lockIntents(
      bindings.map((b) => b.asset_id),
      tx,
      'read',
    );
    const rows = (
      await tx.query<AssetRow>(
        'SELECT * FROM whaleu_media.assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT',
        [bindings.map((b) => b.asset_id)],
      )
    ).rows;
    const lockedBindings = (
      await tx.query<{ id: string; detached_at: Date | null }>(
        'SELECT id,detached_at FROM whaleu_media.bindings WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT',
        [bindings.map((b) => b.id)],
      )
    ).rows;
    if (
      lockedBindings.length !== bindings.length ||
      lockedBindings.some((b) => b.detached_at !== null)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const byId = new Map(rows.map((row) => [row.id, row]));
    const result: MediaAttachmentDescriptor[] = [];
    for (let index = 0; index < bindings.length; index++) {
      const binding = bindings[index]!,
        asset = byId.get(binding.asset_id),
        approved = expected[index];
      if (
        !asset ||
        !approved ||
        binding.ordinal !== index ||
        binding.asset_id !== approved.assetId ||
        binding.manifest_digest !== approved.digest ||
        asset.audience !== audience
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      const manifest = await this.current(asset, tx);
      const display = manifest.variants[1];
      result.push(
        mediaAttachmentDescriptorSchema.parse({
          version: 1,
          kind: 'authenticated-media',
          assetId: asset.id,
          bindingId: binding.id,
          width: display.width,
          height: display.height,
          variants: ['thumb-v1', 'display-v1'],
        }),
      );
    }
    return result;
  }
  async detach(parent: MediaParent, tx: PoolClient): Promise<void> {
    this.managed(tx);
    const rows = (
      await tx.query<{ asset_id: string; intent_id: string }>(
        `SELECT b.asset_id,a.intent_id FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id
      WHERE b.owner_kind=$1 AND b.resource_kind=$2 AND b.resource_id=$3 AND b.content_version=$4 AND b.detached_at IS NULL`,
        [
          parent.ownerKind,
          parent.resourceKind,
          parent.resourceId,
          parent.contentVersion,
        ],
      )
    ).rows;
    if (!rows.length) return;
    await this.lockIntents(
      rows.map((r) => r.asset_id),
      tx,
      'write',
    );
    await tx.query(
      'SELECT id FROM whaleu_media.assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
      [rows.map((r) => r.asset_id)],
    );
    await tx.query(
      "UPDATE whaleu_media.bindings SET detached_at=clock_timestamp(),detach_reason='owner-deleted' WHERE asset_id=ANY($1::uuid[]) AND detached_at IS NULL",
      [rows.map((r) => r.asset_id)],
    );
    const lifecycle = new MediaLifecycleRepository();
    for (const intentId of [...new Set(rows.map((r) => r.intent_id))].sort())
      await lifecycle.detachedOwnerIntent(intentId, tx);
    await this.proof.capture(tx);
  }
  async readyOwned(
    actor: string,
    intentId: string,
    tx: PoolClient,
  ): Promise<string | null> {
    this.managed(tx);
    const row = (
      await tx.query<AssetRow>(
        'SELECT * FROM whaleu_media.assets WHERE intent_id=$1 AND actor_id=$2',
        [intentId, actor],
      )
    ).rows[0];
    if (!row) return null;
    await this.proof.capture(tx);
    await this.lockIntents([row.id], tx, 'read');
    await tx.query(
      'SELECT id FROM whaleu_media.assets WHERE id=$1 FOR SHARE NOWAIT',
      [row.id],
    );
    try {
      await this.current(row, tx);
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'MEDIA_NOT_READY')
        return null;
      throw error;
    }
    return row.id;
  }
  async bindingReference(
    bindingId: string,
    tx: PoolClient,
  ): Promise<{
    parent: MediaParent;
    images: { assetId: string; digest: string }[];
  }> {
    this.managed(tx);
    const row = (
      await tx.query<{
        owner_kind: string;
        resource_kind: string;
        resource_id: string;
        content_version: string;
        asset_id: string;
        manifest_digest: string;
      }>(
        'SELECT * FROM whaleu_media.bindings WHERE id=$1 AND detached_at IS NULL',
        [bindingId],
      )
    ).rows[0];
    if (
      !row ||
      row.owner_kind !== 'community' ||
      row.resource_kind !== 'post' ||
      Number(row.content_version) !== 1
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      parent: {
        ownerKind: 'community',
        resourceKind: 'post',
        resourceId: row.resource_id,
        contentVersion: 1,
      },
      images: [{ assetId: row.asset_id, digest: row.manifest_digest }],
    };
  }
  async deliveryPlan(
    proof: MediaOwnerReadProof,
    request: OwnerReadRequest,
    bindingId: string,
    expected: readonly { assetId: string; digest: string }[],
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<InternalMediaDeliveryPlan> {
    const descriptors = await this.descriptors(proof, request, expected, tx);
    const descriptor = descriptors.find((item) => item.bindingId === bindingId);
    if (!descriptor || descriptors.length !== 1)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const row = (
      await tx.query<AssetRow>(
        'SELECT * FROM whaleu_media.assets WHERE id=$1',
        [descriptor.assetId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const manifest = await this.current(row, tx);
    const object = manifest.variants.find((item) => item.name === variant);
    const head = (
      await tx.query<{ revision: string }>(
        'SELECT revision::text FROM whaleu_media.asset_safety_heads WHERE asset_id=$1',
        [row.id],
      )
    ).rows[0];
    if (!object || !head) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return Object.freeze({
      bindingId,
      parent: request.parent,
      viewerAccountId: request.viewerAccountId,
      variant,
      object: object.object,
      sha256: object.sha256,
      manifestDigest: row.manifest_digest,
      safetyRevision: head.revision,
      bytes: object.bytes,
      mime: object.mime,
    });
  }
  private async current(
    asset: AssetRow,
    tx: PoolClient,
  ): Promise<MediaManifest> {
    const intent = (
      await tx.query<{ state: string }>(
        'SELECT state FROM whaleu_media.upload_intents WHERE id=$1 FOR SHARE NOWAIT',
        [asset.intent_id],
      )
    ).rows[0];
    const head = (
      await tx.query<{ revision: string; event_id: string }>(
        'SELECT revision,event_id FROM whaleu_media.asset_safety_heads WHERE asset_id=$1 FOR SHARE NOWAIT',
        [asset.id],
      )
    ).rows[0];
    if (intent?.state !== 'ready' || !head)
      throw new ApplicationError('MEDIA_NOT_READY');
    const event = (
      await tx.query<{
        state: string;
        manifest_digest: string;
        policy_revision: string;
        effective_at: Date;
        valid_until: Date;
      }>(
        'SELECT * FROM whaleu_media.asset_safety_events WHERE asset_id=$1 AND revision=$2 AND id=$3',
        [asset.id, head.revision, head.event_id],
      )
    ).rows[0];
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]?.now.getTime();
    const decision = currentMediaSafety(
      event,
      asset.manifest_digest,
      asset.policy_revision,
      now,
    );
    if (decision === 'unknown' || !event)
      throw new ApplicationError('MEDIA_NOT_READY');
    const sealed = sealManifest(asset.manifest);
    if (sealed.digest !== asset.manifest_digest)
      throw new ApplicationError('MEDIA_NOT_READY');
    registerTransactionDeadline(
      tx,
      event.valid_until.getTime(),
      'MEDIA_UNAVAILABLE',
    );
    if (decision === 'deny') throw new MediaCurrentDenied();
    return sealed.manifest;
  }
  private async lockIntents(
    ids: readonly string[],
    tx: PoolClient,
    mode: 'read' | 'write',
  ): Promise<void> {
    // Readers must coexist; every mutator explicitly retains the intent-first
    // exclusive fence. An upgrade still uses NOWAIT, never waits in a cycle.
    await tx.query(
      `SELECT id FROM whaleu_media.upload_intents WHERE id IN (SELECT intent_id FROM whaleu_media.assets WHERE id=ANY($1::uuid[])) ORDER BY id FOR ${mode === 'read' ? 'SHARE' : 'UPDATE'} NOWAIT`,
      [ids],
    );
  }
  private managed(tx: PoolClient): object {
    const epoch = transactionReadEpoch(tx);
    if (!epoch) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return epoch;
  }
}
