import { CategoryIconMediaRequiredProof } from './category-icon-required-proof.js';
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
import {
  mediaDigestSchema,
  mediaAttachmentDescriptorSchema,
} from './contracts.js';
import type { MediaVariantName } from './contracts.js';
import {
  categoryIconMediaParentSchema,
  categoryIconMediaDescriptorSchema,
} from './contracts-category-icon.js';
import type {
  CategoryIconMediaParent,
  CategoryIconMediaDescriptor,
} from './contracts-category-icon.js';
import type {
  CategoryIconMediaProofRegistry,
  CategoryIconMediaReadProof,
  CategoryIconMediaReadRequest,
} from './category-icon-owner-proof.js';
import type { CategoryIconMediaDeliveryPlan } from './category-icon-delivery.js';
import type {
  CategoryIconRetirementProofRegistry,
  CategoryIconTerminalRetirement,
  CategoryIconTerminalAppearance,
} from './category-icon-retirement-proof.js';

export interface CategoryIconMediaAttachScope {
  readonly actor: string;
  readonly scopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
}
const mutationBrand: unique symbol = Symbol('category-icon-media-mutation');
export interface CategoryIconMediaMutation {
  readonly [mutationBrand]: true;
}
const acceptedBrand: unique symbol = Symbol('accepted-category-icon-media');
export interface AcceptedCategoryIconMedia {
  readonly [acceptedBrand]: true;
  readonly assetId: string;
  readonly manifestDigest: string;
}
interface MutationFacts {
  tx: PoolClient;
  epoch: object;
  actor: string;
  newAssetIds: ReadonlySet<string>;
  accepted: Set<string>;
  bound: Map<string, string>;
  retirements: readonly CategoryIconTerminalAppearance[];
  oldIntents: ReadonlyMap<string, string>;
  finished: boolean;
}
interface AcceptedFacts {
  tx: PoolClient;
  epoch: object;
  scope: CategoryIconMediaAttachScope;
  row: AssetRow;
  mutation: CategoryIconMediaMutation;
}
interface BindingRow {
  id: string;
  asset_id: string;
  resource_id: string;
  owner_kind: string;
  resource_kind: string;
  content_version: string;
  manifest_digest: string;
  slot: string;
  ordinal: number;
  detached_at: Date | null;
}
/** One bulk lock/finish capability for the whole Category command. Kept,
 * inherited, hidden, archived and dormant appearances are never rebound or
 * detached. Only a separately authorized terminal closure admits retirement. */
export class CategoryIconMediaAssetRepository extends MediaAssetRepository {
  protected override readonly proof = new CategoryIconMediaRequiredProof();
  private readonly mutations = new WeakMap<
    CategoryIconMediaMutation,
    MutationFacts
  >();
  private readonly categoryIconAccepted = new WeakMap<
    AcceptedCategoryIconMedia,
    AcceptedFacts
  >();
  private readonly completion: RequiredTransactionProof<CategoryIconMediaMutation> =
    {
      maximumFacts: 1,
      failureCode: 'MEDIA_UNAVAILABLE',
      validate: async (proofs, tx) => {
        for (const proof of proofs) {
          const facts = this.mutations.get(proof);
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
  constructor(
    private readonly categoryIconOwners: CategoryIconMediaProofRegistry,
    private readonly retirements?: CategoryIconRetirementProofRegistry,
  ) {
    super(new MediaOwnerProofRegistry([]));
  }

  /** Read-only preparation evidence from trusted Media facts; does not accept
   * client manifests or grant attach authority. Never reuse this transaction
   * for mutation: its mandatory read fact must survive any later writes. */
  async describeCategoryIconReady(
    scope: CategoryIconMediaAttachScope,
    id: string,
    tx: PoolClient,
  ): Promise<{ assetId: string; manifestDigest: string }> {
    this.managed(tx);
    this.validateScope(scope);
    mediaV2IdSchema.parse(id);
    await this.proof.capture(tx);
    await this.lockIntents([id], tx, 'read');
    const row = (
      await tx.query<AssetRow & { protocol_version: number }>(
        'SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=$1 FOR SHARE OF a NOWAIT',
        [id],
      )
    ).rows[0];
    this.requireNewScope(row, scope);
    if (
      (
        await tx.query(
          'SELECT id FROM whaleu_media.bindings WHERE asset_id=$1',
          [id],
        )
      ).rowCount !== 0
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    registerTransactionDeadline(tx, scope.expiresAt, 'MEDIA_NOT_READY');
    await this.requireCategoryIconRetention(row!, tx);
    await this.current(row!, tx);
    return Object.freeze({
      assetId: row!.id,
      manifestDigest: row!.manifest_digest,
    });
  }

  /** Owner-first authorization must be complete before calling. All old/new
   * routes are gathered before any batch -> intent -> asset -> binding locks.
   * A candidate list cannot replace the opaque retirement capability. */
  async prepareCategoryIconMutation(
    actor: string,
    newAssetIds: readonly string[],
    terminalRetirement: CategoryIconTerminalRetirement | null,
    tx: PoolClient,
  ): Promise<CategoryIconMediaMutation> {
    const epoch = this.managed(tx);
    mediaV2IdSchema.parse(actor);
    if (
      newAssetIds.length > 32 ||
      new Set(newAssetIds).size !== newAssetIds.length
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const fresh = newAssetIds.map((id) => mediaV2IdSchema.parse(id)).sort();
    let old: readonly CategoryIconTerminalAppearance[] = [];
    if (terminalRetirement) {
      if (!this.retirements) throw new ApplicationError('MEDIA_UNAVAILABLE');
      old = this.retirements.claim(terminalRetirement, actor, tx).appearances;
    }
    const oldIds = new Set(old.map((a) => a.assetId));
    if (fresh.some((id) => oldIds.has(id)))
      throw new ApplicationError('MEDIA_NOT_READY');
    const ids = [...oldIds, ...fresh].sort();
    // One shared routing/lock pass, never 32 independent replacement loops.
    await this.lockIntents(ids, tx, 'write');
    const assets = (
      await tx.query<AssetRow & { protocol_version: number }>(
        'SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=ANY($1::uuid[]) ORDER BY a.id FOR UPDATE OF a NOWAIT',
        [ids],
      )
    ).rows;
    if (
      assets.length !== ids.length ||
      assets.some(
        (row) =>
          !this.isCategoryIcon(row) ||
          row.protocol_version !== 8 ||
          (fresh.includes(row.id) && row.actor_id !== actor),
      )
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const bindings = (
      await tx.query<BindingRow>(
        'SELECT * FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
        [ids],
      )
    ).rows;
    if (bindings.length !== old.length)
      throw new ApplicationError('MEDIA_NOT_READY');
    for (const appearance of old) {
      const asset = assets.find((row) => row.id === appearance.assetId);
      const binding = bindings.find((row) => row.id === appearance.bindingId);
      if (
        !asset ||
        !binding ||
        asset.actor_id !== appearance.actorAccountId ||
        asset.manifest_digest !== appearance.manifestDigest ||
        binding.asset_id !== asset.id ||
        binding.owner_kind !== 'ratings' ||
        binding.resource_kind !== 'category_icon' ||
        binding.resource_id !== appearance.appearanceId ||
        Number(binding.content_version) !== 1 ||
        binding.slot !== 'icon' ||
        binding.ordinal !== 0 ||
        binding.manifest_digest !== appearance.manifestDigest
      )
        throw new ApplicationError('MEDIA_NOT_READY');
    }
    const proof: CategoryIconMediaMutation = Object.freeze({
      [mutationBrand]: true as const,
    });
    this.mutations.set(proof, {
      tx,
      epoch,
      actor,
      newAssetIds: new Set(fresh),
      accepted: new Set(),
      bound: new Map(),
      retirements: Object.freeze([...old]),
      oldIntents: new Map(
        assets.filter((a) => oldIds.has(a.id)).map((a) => [a.id, a.intent_id]),
      ),
      finished: false,
    });
    enableRequiredTransactionProof(tx, this.completion);
    registerRequiredTransactionFact(tx, this.completion, randomUUID(), proof);
    return proof;
  }

  async acceptCategoryIconOwned(
    scope: CategoryIconMediaAttachScope,
    id: string,
    mutation: CategoryIconMediaMutation,
    tx: PoolClient,
  ): Promise<AcceptedCategoryIconMedia> {
    const locks = this.requireMutation(mutation, tx);
    this.validateScope(scope);
    if (
      scope.actor !== locks.actor ||
      !locks.newAssetIds.has(id) ||
      locks.accepted.has(id)
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const row = (
      await tx.query<AssetRow & { protocol_version: number }>(
        'SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=$1',
        [id],
      )
    ).rows[0];
    this.requireNewScope(row, scope);
    registerTransactionDeadline(tx, scope.expiresAt, 'MEDIA_NOT_READY');
    await this.requireCategoryIconRetention(row!, tx);
    await this.current(row!, tx);
    const proof: AcceptedCategoryIconMedia = Object.freeze({
      [acceptedBrand]: true as const,
      assetId: row!.id,
      manifestDigest: row!.manifest_digest,
    });
    this.categoryIconAccepted.set(proof, {
      tx,
      epoch: locks.epoch,
      scope: Object.freeze({ ...scope }),
      row: row!,
      mutation,
    });
    locks.accepted.add(id);
    return proof;
  }

  async bindCategoryIcon(
    accepted: AcceptedCategoryIconMedia,
    parent: CategoryIconMediaParent,
    mutation: CategoryIconMediaMutation,
    tx: PoolClient,
  ): Promise<string> {
    parent = categoryIconMediaParentSchema.parse(parent);
    const locks = this.requireMutation(mutation, tx),
      facts = this.categoryIconAccepted.get(accepted);
    if (
      !facts ||
      facts.tx !== tx ||
      facts.epoch !== this.managed(tx) ||
      facts.mutation !== mutation ||
      locks.bound.has(facts.row.id) ||
      [...locks.bound.values()].includes(parent.resourceId) ||
      locks.retirements.some((a) => a.appearanceId === parent.resourceId)
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const row = facts.row;
    await this.requireCategoryIconRetention(row, tx);
    await this.current(row, tx);
    await tx.query(
      `INSERT INTO whaleu_media.scope_consumptions(actor_id,owner_kind,resource_kind,scope_resource_id,scope_revision,resource_id,content_version,attach_evidence) VALUES($1,'ratings','category_icon',$2,$3,$4,1,$5)`,
      [
        facts.scope.actor,
        facts.scope.scopeId,
        facts.scope.scopeRevision,
        parent.resourceId,
        JSON.stringify({
          version: 8,
          operation: 'select_category_icon',
          assets: [{ assetId: row.id, digest: row.manifest_digest }],
        }),
      ],
    );
    const bindingId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_media.bindings(id,asset_id,manifest_digest,owner_kind,resource_kind,resource_id,content_version,slot,ordinal,attach_evidence) VALUES($1,$2,$3,'ratings','category_icon',$4,1,'icon',0,$5)`,
      [
        bindingId,
        row.id,
        row.manifest_digest,
        parent.resourceId,
        JSON.stringify({
          version: 8,
          scopeId: facts.scope.scopeId,
          scopeRevision: facts.scope.scopeRevision,
        }),
      ],
    );
    locks.bound.set(row.id, parent.resourceId);
    return bindingId;
  }

  /** Last Media step after every owner/source/appearance/receipt write. It
   * captures the FINAL epoch without deleting any pre-existing outer proof. */
  async finishCategoryIconMutation(
    mutation: CategoryIconMediaMutation,
    tx: PoolClient,
  ): Promise<void> {
    const facts = this.requireMutation(mutation, tx);
    if (
      facts.bound.size !== facts.newAssetIds.size ||
      facts.accepted.size !== facts.newAssetIds.size
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    if (facts.retirements.length) {
      const result = await tx.query<{ asset_id: string }>(
        `UPDATE whaleu_media.bindings SET detached_at=clock_timestamp(),detach_reason='ratings-category-icon-terminal-retirement' WHERE id=ANY($1::uuid[]) AND detached_at IS NULL RETURNING asset_id`,
        [facts.retirements.map((a) => a.bindingId)],
      );
      const lifecycle = new MediaLifecycleRepository();
      for (const id of [
        ...new Set(
          result.rows.map((row) => facts.oldIntents.get(row.asset_id)!),
        ),
      ].sort())
        await lifecycle.detachedOwnerIntent(id, tx);
    }
    await this.proof.capture(tx);
    facts.finished = true;
  }
  async categoryIconDescriptor(
    proof: CategoryIconMediaReadProof,
    request: CategoryIconMediaReadRequest,
    tx: PoolClient,
  ): Promise<CategoryIconMediaDescriptor> {
    const read = this.categoryIconOwners.require(proof, request, tx);
    await this.proof.capture(tx);
    await this.lockIntents([read.assetId], tx, 'read');
    const asset = (
      await tx.query<AssetRow & { protocol_version: number }>(
        'SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=$1 FOR SHARE OF a NOWAIT',
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
        `SELECT id,asset_id,manifest_digest,ordinal FROM whaleu_media.bindings WHERE owner_kind='ratings' AND resource_kind='category_icon' AND resource_id=$1 AND content_version=1 AND slot='icon' AND detached_at IS NULL ORDER BY id FOR SHARE NOWAIT`,
        [read.parent.resourceId],
      )
    ).rows;
    const binding = bindings[0];
    if (
      !asset ||
      asset.protocol_version !== 8 ||
      asset.target_kind !== 'edit' ||
      bindings.length !== 1 ||
      !binding ||
      binding.id !== read.bindingId ||
      binding.asset_id !== read.assetId ||
      binding.manifest_digest !== read.manifestDigest ||
      binding.ordinal !== 0 ||
      asset.actor_id !== read.actorAccountId ||
      asset.manifest_digest !== read.manifestDigest ||
      asset.owner_kind !== 'ratings' ||
      asset.resource_kind !== 'category_icon' ||
      asset.purpose !== 'ratings-category-icon-image' ||
      asset.audience !== 'content-gated' ||
      asset.slot !== 'icon' ||
      asset.ordinal !== 0 ||
      Number(asset.content_version) !== 1
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const manifest = await this.current(asset, tx),
      display = manifest.variants[1];
    return categoryIconMediaDescriptorSchema.parse({
      protocol: 'ratings-category-icon-media-v1',
      kind: 'ratings-category-icon-media',
      categoryId: request.categoryId,
      contextId: request.contextId,
      contextToken: request.contextToken,
      appearanceId: request.appearanceId,
      bindingId: binding.id,
      width: display.width,
      height: display.height,
      variants: ['thumb-v1', 'display-v1'],
    });
  }
  async categoryIconDeliveryPlan(
    proof: CategoryIconMediaReadProof,
    request: CategoryIconMediaReadRequest,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<CategoryIconMediaDeliveryPlan> {
    const read = this.categoryIconOwners.require(proof, request, tx),
      descriptor = await this.categoryIconDescriptor(proof, request, tx);
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
      categoryId: read.categoryId,
      contextId: request.contextId,
      contextToken: request.contextToken,
      bindingId: read.bindingId,
      principal: read.principal,
      ownerRevision: read.ownerRevision,
      reviewRevision: read.reviewRevision,
      qualification: read.qualification,
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
  private requireMutation(
    proof: CategoryIconMediaMutation,
    tx: PoolClient,
  ): MutationFacts {
    const facts = this.mutations.get(proof);
    if (
      !facts ||
      facts.tx !== tx ||
      facts.epoch !== this.managed(tx) ||
      facts.finished
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    return facts;
  }
  private validateScope(scope: CategoryIconMediaAttachScope): void {
    mediaV2IdSchema.parse(scope.actor);
    mediaV2IdSchema.parse(scope.scopeId);
    mediaDigestSchema.parse(scope.scopeRevision);
    if (!Number.isSafeInteger(scope.expiresAt) || scope.expiresAt < 1)
      throw new ApplicationError('MEDIA_NOT_READY');
  }
  private isCategoryIcon(row: AssetRow): boolean {
    return (
      row.owner_kind === 'ratings' &&
      row.resource_kind === 'category_icon' &&
      row.purpose === 'ratings-category-icon-image' &&
      row.audience === 'content-gated' &&
      row.target_kind === 'edit' &&
      Number(row.content_version) === 1 &&
      row.slot === 'icon' &&
      row.ordinal === 0
    );
  }
  private requireNewScope(
    row: (AssetRow & { protocol_version: number }) | undefined,
    scope: CategoryIconMediaAttachScope,
  ): void {
    if (
      !row ||
      row.protocol_version !== 8 ||
      !this.isCategoryIcon(row) ||
      row.actor_id !== scope.actor ||
      row.resource_id !== scope.scopeId ||
      row.scope_revision !== scope.scopeRevision
    )
      throw new ApplicationError('MEDIA_NOT_READY');
  }
  private async requireCategoryIconRetention(
    asset: AssetRow,
    tx: PoolClient,
  ): Promise<void> {
    await this.requireRetention(asset, tx);
    const intent = (
      await tx.query<{ expires_at: Date }>(
        `SELECT expires_at FROM whaleu_media.upload_intents WHERE id=$1 AND actor_id=$2 AND protocol_version=8 AND resource_id=$3 AND scope_revision=$4`,
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
