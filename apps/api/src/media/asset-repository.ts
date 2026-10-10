import { collectDiscussionAncestorMedia } from './discussion-ancestor-proof.js';
import { validateCurrentMedia } from './current-facts.js';
import { lockMediaBatchesForIntents } from './batch-locks.js';
import type {
  MediaBatchRepository,
  MediaSealedBatchEvidence,
  PublicationMediaContext,
} from './batch-repository.js';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../database/transaction-deadlines.js';
import { MediaLifecycleRepository } from './lifecycle-repository.js';
import { MediaRequiredProof } from './required-proof.js';
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

export interface AssetRow {
  created_at: Date;
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
  readonly purpose:
    | 'community-post-image'
    | 'community-comment-image'
    | 'community-reply-image';
  readonly audience: 'content-gated';
  readonly ownerKind: 'community';
  readonly resourceKind: 'post' | 'comment' | 'reply';
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
  readonly batch: MediaSealedBatchEvidence | null;
}
/** Internal shared owner. No business tables, provider effects, URLs or authorization
 * inference. Business first authorizes/locks its scope, then locks assets in UUID order. */
export class MediaAssetRepository {
  private readonly accepted = new WeakMap<AcceptedMediaAssets, AcceptedFacts>();
  protected readonly proof = new MediaRequiredProof();
  constructor(
    private readonly owners: MediaOwnerProofRegistry,
    private readonly batches?: MediaBatchRepository,
    private readonly discussionBatches?: MediaBatchRepository,
  ) {}
  async peekOwnedScope(
    actor: string,
    ids: readonly string[],
    tx: PoolClient,
  ): Promise<MediaAssetScopeReference> {
    this.managed(tx);
    if (!ids.length || ids.length > 9 || new Set(ids).size !== ids.length)
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
    publication?: PublicationMediaContext,
  ): Promise<AcceptedMediaAssets> {
    const epoch = this.managed(tx);
    if (!ids.length || ids.length > 9 || new Set(ids).size !== ids.length)
      throw new ApplicationError('MEDIA_NOT_READY');
    const repository =
      scope.resourceKind === 'post' ? this.batches : this.discussionBatches;
    if (ids.length > (scope.resourceKind === 'post' ? 9 : 3))
      throw new ApplicationError('MEDIA_NOT_READY');
    const batch = repository
      ? await repository.peekSealed(scope.actor, ids, publication, tx)
      : null;
    const protocols = (
      await tx.query<{ protocol_version: number }>(
        'SELECT i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=ANY($1::uuid[])',
        [ids],
      )
    ).rows;
    if (
      protocols.length !== ids.length ||
      (batch
        ? protocols.some(
            (row) =>
              row.protocol_version !== (scope.resourceKind === 'post' ? 3 : 4),
          )
        : ids.length !== 1 ||
          scope.resourceKind !== 'post' ||
          protocols.some((row) => row.protocol_version >= 3))
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    if (
      batch &&
      (batch.serverScopeId !== scope.scopeId ||
        batch.scopeRevision !== scope.scopeRevision)
    )
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
        row.ordinal !== (batch?.mappings[ordinal]?.sourceSlot ?? ordinal) ||
        (batch !== null &&
          (batch.mappings[ordinal]?.assetId !== row.id ||
            batch.mappings[ordinal]?.manifestDigest !== row.manifest_digest ||
            batch.mappings[ordinal]?.ordinal !== ordinal))
      )
        throw new ApplicationError('MEDIA_NOT_READY');
      await this.requireRetention(row, tx);
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
      batch,
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
        JSON.stringify(
          facts.batch
            ? {
                version: facts.batch.version,
                batchId: facts.batch.batchId,
                batchRevision: facts.batch.batchRevision,
                attachmentPlanDigest: facts.batch.attachmentPlanDigest,
                publication: facts.batch.publication,
                assets: accepted.images,
                mappings: facts.batch.mappings,
              }
            : { version: 1, assets: accepted.images },
        ),
      ],
    );
    const bindings: {
      bindingId: string;
      assetId: string;
      manifestDigest: string;
      ordinal: number;
    }[] = [];
    for (let ordinal = 0; ordinal < facts.rows.length; ordinal++) {
      const row = facts.rows[ordinal]!;
      // Recheck locked state and deadline after content Review consumption work.
      await this.requireRetention(row, tx);
      await this.current(row, tx);
      const bindingId = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_media.bindings(id,asset_id,manifest_digest,owner_kind,resource_kind,resource_id,content_version,slot,ordinal,attach_evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,'images',$8,$9)`,
        [
          bindingId,
          row.id,
          row.manifest_digest,
          parent.ownerKind,
          parent.resourceKind,
          parent.resourceId,
          parent.contentVersion,
          ordinal,
          JSON.stringify(
            facts.batch
              ? {
                  version: facts.batch.version,
                  scopeId: facts.scope.scopeId,
                  scopeRevision: facts.scope.scopeRevision,
                  batchId: facts.batch.batchId,
                  batchRevision: facts.batch.batchRevision,
                  attachmentPlanDigest: facts.batch.attachmentPlanDigest,
                  memberId: facts.batch.mappings[ordinal]!.memberId,
                  sourceSlot: facts.batch.mappings[ordinal]!.sourceSlot,
                }
              : {
                  version: 1,
                  scopeId: facts.scope.scopeId,
                  scopeRevision: facts.scope.scopeRevision,
                },
          ),
        ],
      );
      bindings.push({
        bindingId,
        assetId: row.id,
        manifestDigest: row.manifest_digest,
        ordinal,
      });
    }
    if (facts.batch) {
      const repository =
        facts.batch.version === 3 ? this.discussionBatches : this.batches;
      if (!repository) throw new ApplicationError('MEDIA_NOT_READY');
      await repository.consumeSealed(facts.batch, parent, bindings, tx);
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
    const ownerImages = this.owners.contentMedia(proof, tx, request);
    if (
      ownerImages.length !== expected.length ||
      ownerImages.some(
        (image, ordinal) =>
          image.assetId !== expected[ordinal]?.assetId ||
          image.digest !== expected[ordinal]?.digest,
      )
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
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
    await this.exactDescriptors(
      parent,
      'content-gated',
      expected,
      tx,
      !collectDiscussionAncestorMedia(tx, parent, expected),
    );
  }
  /** Delete-transition proof only: exact original set is now detached and its
   * intent has durably entered cleanup. Never produces downloadable descriptors. */
  async verifyDeletedContentBindings(
    parent: MediaParent,
    expected: readonly { assetId: string; digest: string }[],
    tx: PoolClient,
  ): Promise<void> {
    this.managed(tx);
    if (
      parent.ownerKind !== 'community' ||
      !['comment', 'reply'].includes(parent.resourceKind) ||
      !collectDiscussionAncestorMedia(tx, parent, expected)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.exactDescriptors(
      parent,
      'content-gated',
      expected,
      tx,
      false,
      true,
    );
  }
  private async exactDescriptors(
    parent: MediaParent,
    audience: string,
    expected: readonly { assetId: string; digest: string }[],
    tx: PoolClient,
    capture = true,
    detached = false,
  ): Promise<MediaAttachmentDescriptor[]> {
    if (
      !expected.length ||
      expected.length > (parent.resourceKind === 'post' ? 9 : 3) ||
      new Set(expected.map((image) => image.assetId)).size !== expected.length
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (capture) await this.proof.capture(tx);
    const bindings = (
      await tx.query<{
        id: string;
        asset_id: string;
        manifest_digest: string;
        ordinal: number;
      }>(
        `SELECT id,asset_id,manifest_digest,ordinal FROM whaleu_media.bindings
      WHERE owner_kind=$1 AND resource_kind=$2 AND resource_id=$3 AND content_version=$4 AND slot='images' AND ($5::boolean OR detached_at IS NULL) ORDER BY ordinal LIMIT 10`,
        [
          parent.ownerKind,
          parent.resourceKind,
          parent.resourceId,
          parent.contentVersion,
          detached,
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
      lockedBindings.some((b) =>
        detached ? b.detached_at === null : b.detached_at !== null,
      )
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
        asset.audience !== audience ||
        asset.manifest_digest !== approved.digest ||
        asset.owner_kind !== parent.ownerKind ||
        asset.resource_kind !== parent.resourceKind ||
        asset.purpose !== `community-${parent.resourceKind}-image` ||
        Number(asset.content_version) !== parent.contentVersion ||
        asset.slot !== 'images'
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      const manifest = await this.current(asset, tx, detached);
      if (detached) {
        for (const measured of [manifest.original, ...manifest.variants]) {
          const object = measured.object;
          const obligation = await tx.query(
            `SELECT 1 FROM whaleu_media.cleanup_obligations WHERE provider=$1 AND environment=$2 AND bucket=$3 AND object_key=$4 AND object_version=$5 AND state IN ('pending','retryable','retained')`,
            [
              object.provider,
              object.environment,
              object.bucket,
              object.key,
              object.version,
            ],
          );
          if (obligation.rowCount !== 1)
            throw new ApplicationError('MEDIA_UNAVAILABLE');
        }
      }
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
  async detachMany(
    parents: readonly MediaParent[],
    tx: PoolClient,
  ): Promise<void> {
    this.managed(tx);
    if (
      parents.length > 16 ||
      new Set(parents.map((parent) => JSON.stringify(parent))).size !==
        parents.length
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    for (const parent of parents) await this.detachCurrent(parent, tx, false);
    await this.proof.capture(tx);
  }
  async detach(parent: MediaParent, tx: PoolClient): Promise<void> {
    await this.detachCurrent(parent, tx, true);
  }
  private async detachCurrent(
    parent: MediaParent,
    tx: PoolClient,
    capture: boolean,
  ): Promise<void> {
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
    if (capture) await this.proof.capture(tx);
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
      !['post', 'comment', 'reply'].includes(row.resource_kind) ||
      Number(row.content_version) !== 1
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return {
      parent: {
        ownerKind: 'community',
        resourceKind: row.resource_kind as 'post' | 'comment' | 'reply',
        resourceId: row.resource_id,
        contentVersion: 1,
      },
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
    if (
      !descriptor ||
      descriptors.filter((item) => item.bindingId === bindingId).length !== 1
    )
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
      attachmentSetRevision: await this.attachmentSetRevision(
        descriptors,
        expected,
        tx,
      ),
      bytes: object.bytes,
      mime: object.mime,
    });
  }
  protected async attachmentSetRevision(
    descriptors: readonly MediaAttachmentDescriptor[],
    expected: readonly { assetId: string; digest: string }[],
    tx: PoolClient,
  ): Promise<string> {
    const rows = (
      await tx.query<{
        id: string;
        intent_id: string;
        policy_revision: string;
        manifest_digest: string;
        state: string;
        revision: string;
        event_id: string;
      }>(
        `SELECT a.id,a.intent_id,a.policy_revision,a.manifest_digest,i.state,h.revision::text,h.event_id
       FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id
       JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id
       WHERE a.id=ANY($1::uuid[]) ORDER BY a.id`,
        [descriptors.map((descriptor) => descriptor.assetId)],
      )
    ).rows;
    if (rows.length !== descriptors.length)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const byId = new Map(rows.map((row) => [row.id, row]));
    return createHash('sha256')
      .update('whaleu-media-attachment-set:v1\n')
      .update(
        JSON.stringify(
          descriptors.map((descriptor, ordinal) => ({
            ordinal,
            bindingId: descriptor.bindingId,
            expected: expected[ordinal],
            current: byId.get(descriptor.assetId),
          })),
        ),
      )
      .digest('hex');
  }
  protected async requireRetention(
    asset: AssetRow,
    tx: PoolClient,
  ): Promise<void> {
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]?.now.getTime();
    const deadline = asset.created_at.getTime() + 24 * 60 * 60 * 1000;
    if (now === undefined || deadline <= now)
      throw new ApplicationError('MEDIA_NOT_READY');
    registerTransactionDeadline(tx, deadline, 'MEDIA_NOT_READY');
    // Community's requireDraft separately enrolls the immutable draft deadline
    // and its final owner proof before intent/assets are locked.
  }
  protected async current(
    asset: AssetRow,
    tx: PoolClient,
    detached = false,
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
    if (intent?.state !== (detached ? 'cleanup_pending' : 'ready') || !head)
      throw new ApplicationError('MEDIA_NOT_READY');
    const event = (
      await tx.query<{
        state: string;
        manifest_digest: string;
        policy_revision: string;
        effective_at: Date;
        valid_until: Date;
        exact_time_valid: boolean;
        read_at: Date;
      }>(
        `SELECT e.*,t.read_at,
         (e.effective_at<=t.read_at AND e.valid_until>t.read_at AND e.valid_until>e.effective_at) AS exact_time_valid
         FROM whaleu_media.asset_safety_events e CROSS JOIN (SELECT clock_timestamp() AS read_at) t
         WHERE asset_id=$1 AND revision=$2 AND id=$3`,
        [asset.id, head.revision, head.event_id],
      )
    ).rows[0];
    const checked = validateCurrentMedia(
      asset,
      detached ? 'ready' : intent.state,
      event,
      event?.read_at.getTime(),
      event?.exact_time_valid === true,
    );
    if (checked.decision === 'unknown')
      throw new ApplicationError('MEDIA_NOT_READY');
    registerTransactionDeadline(tx, checked.validUntil, 'MEDIA_UNAVAILABLE');
    if (checked.decision === 'deny') throw new MediaCurrentDenied();
    return checked.manifest;
  }

  protected async lockIntents(
    ids: readonly string[],
    tx: PoolClient,
    mode: 'read' | 'write',
  ): Promise<void> {
    // Batch routing is immutable; take its shared/write serial point before
    // all intent and asset locks. Legacy assets have no batch row to acquire.
    const intents = (
      await tx.query<{ intent_id: string }>(
        'SELECT intent_id FROM whaleu_media.assets WHERE id=ANY($1::uuid[]) ORDER BY intent_id',
        [ids],
      )
    ).rows;
    await lockMediaBatchesForIntents(
      intents.map((intent) => intent.intent_id),
      tx,
      mode === 'write',
    );
    await tx.query(
      `SELECT id FROM whaleu_media.upload_intents WHERE id IN (SELECT intent_id FROM whaleu_media.assets WHERE id=ANY($1::uuid[])) ORDER BY id FOR ${mode === 'read' ? 'SHARE' : 'UPDATE'} NOWAIT`,
      [ids],
    );
  }
  protected managed(tx: PoolClient): object {
    const epoch = transactionReadEpoch(tx);
    if (!epoch) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return epoch;
  }
}
