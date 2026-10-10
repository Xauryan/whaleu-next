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
  profileMediaParentSchema,
  profileMediaDescriptorSchema,
} from './contracts-profile.js';
import type {
  ProfileMediaParent,
  ProfileMediaDescriptor,
} from './contracts-profile.js';
import type {
  ProfileMediaProofRegistry,
  ProfileMediaReadProof,
  ProfileMediaReadRequest,
} from './profile-owner-proof.js';
import type { ProfileMediaDeliveryPlan } from './profile-delivery.js';

export interface ProfileMediaAttachScope {
  readonly actor: string;
  readonly scopeId: string;
  readonly scopeRevision: string;
}
const replacementBrand: unique symbol = Symbol('profile-media-replacement');
export interface ProfileMediaReplacement {
  readonly [replacementBrand]: true;
}
const acceptedBrand: unique symbol = Symbol('accepted-profile-avatar');
export interface AcceptedProfileMedia {
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
  oldParent: ProfileMediaParent | null;
  old: readonly OldBinding[];
  newAssetId: string | null;
  bound: boolean;
  finished: boolean;
}
interface AcceptedFacts {
  tx: PoolClient;
  epoch: object;
  scope: ProfileMediaAttachScope;
  row: AssetRow;
  replacement: ProfileMediaReplacement;
}
/** Profile owns the mutable pointer; Media owns only immutable exact appearances.
 * Old/new sources are gathered before taking any Media mutation lock. */
export class ProfileMediaAssetRepository extends MediaAssetRepository {
  private readonly replacements = new WeakMap<
    ProfileMediaReplacement,
    ReplacementFacts
  >();
  private readonly completion: RequiredTransactionProof<ProfileMediaReplacement> =
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
  private readonly profileAccepted = new WeakMap<
    AcceptedProfileMedia,
    AcceptedFacts
  >();
  constructor(private readonly profileOwners: ProfileMediaProofRegistry) {
    super(new MediaOwnerProofRegistry([]));
  }
  async prepareProfileReplacement(
    actor: string,
    oldParent: ProfileMediaParent | null,
    newAssetId: string | null,
    tx: PoolClient,
  ): Promise<ProfileMediaReplacement> {
    const epoch = this.managed(tx);
    mediaV2IdSchema.parse(actor);
    if (oldParent) oldParent = profileMediaParentSchema.parse(oldParent);
    if (newAssetId) mediaV2IdSchema.parse(newAssetId);
    const old = oldParent
      ? (
          await tx.query<OldBinding>(
            `SELECT b.id,b.asset_id,a.intent_id FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE b.owner_kind='profile' AND b.resource_kind='avatar' AND b.resource_id=$1 AND b.content_version=1 AND b.slot='avatar' AND b.ordinal=0 AND b.detached_at IS NULL AND a.actor_id=$2`,
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
          row.owner_kind !== 'profile' ||
          row.resource_kind !== 'avatar' ||
          row.slot !== 'avatar',
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
    const proof: ProfileMediaReplacement = Object.freeze({
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
  async acceptProfileOwned(
    scope: ProfileMediaAttachScope,
    id: string,
    replacement: ProfileMediaReplacement,
    tx: PoolClient,
  ): Promise<AcceptedProfileMedia> {
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
      row.protocol_version !== 5 ||
      row.actor_id !== scope.actor ||
      row.purpose !== 'profile-avatar-image' ||
      row.audience !== 'profile-public' ||
      row.owner_kind !== 'profile' ||
      row.resource_kind !== 'avatar' ||
      row.target_kind !== 'edit' ||
      row.resource_id !== scope.scopeId ||
      row.scope_revision !== scope.scopeRevision ||
      Number(row.content_version) !== 1 ||
      row.slot !== 'avatar' ||
      row.ordinal !== 0
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    await this.requireProfileRetention(row, tx);
    await this.current(row, tx);
    const proof: AcceptedProfileMedia = Object.freeze({
      [acceptedBrand]: true as const,
      assetId: row.id,
      manifestDigest: row.manifest_digest,
    });
    this.profileAccepted.set(proof, {
      tx,
      epoch: locks.epoch,
      scope: Object.freeze({ ...scope }),
      row,
      replacement,
    });
    return proof;
  }
  async bindProfile(
    accepted: AcceptedProfileMedia,
    parent: ProfileMediaParent,
    replacement: ProfileMediaReplacement,
    tx: PoolClient,
  ): Promise<string> {
    parent = profileMediaParentSchema.parse(parent);
    const locks = this.requireReplacement(replacement, tx),
      facts = this.profileAccepted.get(accepted);
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
    await this.requireProfileRetention(row, tx);
    await this.current(row, tx);
    const evidence = {
      version: 5,
      operation: 'select_avatar',
      assets: [{ assetId: row.id, digest: row.manifest_digest }],
    };
    await tx.query(
      `INSERT INTO whaleu_media.scope_consumptions(actor_id,owner_kind,resource_kind,scope_resource_id,scope_revision,resource_id,content_version,attach_evidence) VALUES($1,'profile','avatar',$2,$3,$4,1,$5)`,
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
      `INSERT INTO whaleu_media.bindings(id,asset_id,manifest_digest,owner_kind,resource_kind,resource_id,content_version,slot,ordinal,attach_evidence) VALUES($1,$2,$3,'profile','avatar',$4,1,'avatar',0,$5)`,
      [
        bindingId,
        row.id,
        row.manifest_digest,
        parent.resourceId,
        JSON.stringify({
          version: 5,
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
  async finishProfileReplacement(
    replacement: ProfileMediaReplacement,
    tx: PoolClient,
  ): Promise<void> {
    const facts = this.requireReplacement(replacement, tx);
    if (Boolean(facts.newAssetId) !== facts.bound)
      throw new ApplicationError('MEDIA_NOT_READY');
    if (facts.old.length) {
      const result = await tx.query(
        `UPDATE whaleu_media.bindings SET detached_at=clock_timestamp(),detach_reason='profile-avatar-replaced' WHERE id=ANY($1::uuid[]) AND detached_at IS NULL`,
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
  async profileDescriptor(
    proof: ProfileMediaReadProof,
    request: ProfileMediaReadRequest,
    tx: PoolClient,
  ): Promise<ProfileMediaDescriptor> {
    const read = this.profileOwners.require(proof, request, tx);
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
        `SELECT id,asset_id,manifest_digest,ordinal FROM whaleu_media.bindings WHERE owner_kind='profile' AND resource_kind='avatar' AND resource_id=$1 AND content_version=1 AND slot='avatar' AND detached_at IS NULL ORDER BY id FOR SHARE NOWAIT`,
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
      asset.owner_kind !== 'profile' ||
      asset.resource_kind !== 'avatar' ||
      asset.purpose !== 'profile-avatar-image' ||
      asset.audience !== 'profile-public' ||
      asset.slot !== 'avatar' ||
      asset.ordinal !== 0 ||
      Number(asset.content_version) !== 1
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const manifest = await this.current(asset, tx),
      display = manifest.variants[1];
    return profileMediaDescriptorSchema.parse({
      protocol: 'profile-media-v1',
      kind: 'profile-media',
      profileId: request.profileId,
      appearanceId: request.appearanceId,
      bindingId: binding.id,
      width: display.width,
      height: display.height,
      variants: ['thumb-v1', 'display-v1'],
    });
  }
  async profileDeliveryPlan(
    proof: ProfileMediaReadProof,
    request: ProfileMediaReadRequest,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<ProfileMediaDeliveryPlan> {
    const read = this.profileOwners.require(proof, request, tx),
      descriptor = await this.profileDescriptor(proof, request, tx);
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
      profileId: read.profileId,
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
    proof: ProfileMediaReplacement,
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
  private async requireProfileRetention(
    asset: AssetRow,
    tx: PoolClient,
  ): Promise<void> {
    await this.requireRetention(asset, tx);
    const edit = (
      await tx.query<{ expires_at: Date }>(
        `SELECT expires_at FROM whaleu_profile.avatar_edits WHERE id=$1 AND actor_id=$2 AND scope_revision=$3`,
        [asset.resource_id, asset.actor_id, asset.scope_revision],
      )
    ).rows[0];
    if (!edit) throw new ApplicationError('MEDIA_NOT_READY');
    registerTransactionDeadline(
      tx,
      edit.expires_at.getTime(),
      'MEDIA_NOT_READY',
    );
  }
}
