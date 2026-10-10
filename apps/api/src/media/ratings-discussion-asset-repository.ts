import { ratingsMediaMutationActive } from './ratings-discussion-mutation-proof.js';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { MediaAssetRepository } from './asset-repository.js';
import type { AssetRow } from './asset-repository.js';
import { MediaOwnerProofRegistry } from './owner-proof.js';
import { MediaLifecycleRepository } from './lifecycle-repository.js';
import { mediaIdSchema } from './contracts.js';
import type { MediaManifest, MediaVariantName } from './contracts.js';
import {
  ratingsDiscussionMediaParentSchema,
  ratingsDiscussionMediaDescriptorSchema,
  ratingsDiscussionSealedPlanSchema,
  ratingsDiscussionSealedPlanHash,
} from './contracts-ratings-discussion.js';
import type {
  RatingsDiscussionMediaParent,
  RatingsDiscussionMediaDescriptor,
} from './contracts-ratings-discussion.js';
import type {
  RatingsDiscussionMediaProofRegistry,
  RatingsDiscussionMediaReadProof,
  RatingsDiscussionMediaReadRequest,
} from './ratings-discussion-owner-proof.js';
import type { RatingsDiscussionMediaDeliveryPlan } from './ratings-discussion-delivery.js';

export interface RatingsDiscussionSetSelection {
  readonly actor: string;
  readonly batchId: string;
  readonly batchIdentityHash: string;
  readonly sealedPlanDigest: string;
  readonly images: readonly {
    ordinal: number;
    memberId: string;
    assetId: string;
  }[];
}
export interface RatingsDiscussionAttachment {
  readonly bindingId: string;
  readonly assetId: string;
  readonly manifestDigest: string;
  readonly ordinal: number;
  readonly width: number;
  readonly height: number;
}
export interface RatingsDiscussionBatchRow {
  id: string;
  actor_id: string;
  identity_hash: string;
  server_scope_id: string;
  scope_revision: string;
  state: string;
  expires_at: Date;
  sealed_plan: unknown;
  sealed_plan_digest: string | null;
  identity: {
    target: { kind: 'root' | 'reply'; targetId: string; rootId?: string };
  };
}
interface MemberRow {
  member_id: string;
  source_slot: number;
  intent_id: string;
  state: string;
}
const brand: unique symbol = Symbol('ratings-discussion-whole-set');
export interface RatingsDiscussionWholeSet {
  readonly [brand]: true;
}
interface WholeFacts {
  tx: PoolClient;
  epoch: object;
  batch: RatingsDiscussionBatchRow;
  rows: readonly AssetRow[];
  members: readonly MemberRow[];
  selection: RatingsDiscussionSetSelection;
  accepted: boolean;
  bound: boolean;
  finished: boolean;
}
/** Media owns attachment preparation, never Ratings publication. One narrow
 * capability covers every member and cannot survive a transaction/savepoint epoch. */
export class RatingsDiscussionMediaAssetRepository extends MediaAssetRepository {
  private readonly sets = new WeakMap<RatingsDiscussionWholeSet, WholeFacts>();
  private readonly descriptions = new WeakMap<
    PoolClient,
    {
      epoch: object;
      descriptions: {
        selection: string;
        rows: string;
        adopted: RatingsDiscussionWholeSet | null;
      }[];
    }
  >();
  private readonly descriptionCompletion: RequiredTransactionProof<{
    tx: PoolClient;
    epoch: object;
    selection: string;
    rows: string;
    adopted: RatingsDiscussionWholeSet | null;
  }> = {
    maximumFacts: 8,
    failureCode: 'MEDIA_UNAVAILABLE',
    validate: async (facts, tx) => {
      for (const description of facts) {
        const set = description.adopted
          ? this.sets.get(description.adopted)
          : undefined;
        if (
          description.tx !== tx ||
          description.epoch !== this.managed(tx) ||
          !set ||
          !set.finished ||
          description.selection !== this.selectionKey(set.selection) ||
          description.rows !==
            JSON.stringify(set.rows.map((row) => [row.id, row.manifest_digest]))
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
      }
    },
  };
  private readonly completion: RequiredTransactionProof<RatingsDiscussionWholeSet> =
    {
      maximumFacts: 8,
      failureCode: 'MEDIA_UNAVAILABLE',
      validate: async (proofs, tx) => {
        for (const proof of proofs) {
          const facts = this.sets.get(proof);
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
    private readonly ratingsOwners?: RatingsDiscussionMediaProofRegistry,
    private readonly metadata?: (tx: PoolClient, value: unknown) => void,
  ) {
    super(new MediaOwnerProofRegistry([]));
  }
  private retainMetadata(tx: PoolClient, value: unknown): void {
    // The Ratings owner must pass its existing request-wide 64 MiB ledger.
    // A separate Media pool here would silently multiply the release budget.
    if (!this.metadata) throw new ApplicationError('MEDIA_UNAVAILABLE');
    this.metadata(tx, value);
  }
  override async readyOwned(
    actor: string,
    intentId: string,
    tx: PoolClient,
  ): Promise<string | null> {
    this.managed(tx);
    const row = (
      await tx.query<AssetRow & { protocol_version: number }>(
        `SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.intent_id=$1 AND a.actor_id=$2`,
        [intentId, actor],
      )
    ).rows[0];
    this.retainMetadata(tx, row ?? null);
    if (
      !row ||
      row.protocol_version !== 7 ||
      row.owner_kind !== 'ratings' ||
      !['rating_comment', 'rating_reply'].includes(row.resource_kind)
    )
      return null;
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
  async describeReadySet(
    selection: RatingsDiscussionSetSelection,
    tx: PoolClient,
  ): Promise<readonly { assetId: string; digest: string }[]> {
    const facts = await this.lockSelected(selection, tx, false);
    if (ratingsMediaMutationActive(tx)) {
      let state = this.descriptions.get(tx);
      if (!state || state.epoch !== facts.epoch) {
        state = { epoch: facts.epoch, descriptions: [] };
        this.descriptions.set(tx, state);
      }
      const description = {
        tx,
        epoch: facts.epoch,
        selection: this.selectionKey(selection),
        rows: JSON.stringify(
          facts.rows.map((row) => [row.id, row.manifest_digest]),
        ),
        adopted: null as RatingsDiscussionWholeSet | null,
      };
      state.descriptions.push(description);
      enableRequiredTransactionProof(tx, this.descriptionCompletion);
      registerRequiredTransactionFact(
        tx,
        this.descriptionCompletion,
        randomUUID(),
        description,
      );
    } else await this.proof.capture(tx);
    return Object.freeze(
      facts.rows.map((row) =>
        Object.freeze({ assetId: row.id, digest: row.manifest_digest }),
      ),
    );
  }
  async prepareWholeSet(
    selection: RatingsDiscussionSetSelection,
    tx: PoolClient,
  ): Promise<RatingsDiscussionWholeSet> {
    const facts = await this.lockSelected(selection, tx, true);
    const capability = Object.freeze({ [brand]: true as const });
    this.sets.set(capability, {
      ...facts,
      selection: Object.freeze({
        ...selection,
        images: Object.freeze(
          selection.images.map((x) => Object.freeze({ ...x })),
        ),
      }),
      accepted: false,
      bound: false,
      finished: false,
    });
    const descriptions = this.descriptions.get(tx);
    if (descriptions?.epoch === facts.epoch)
      for (const description of descriptions.descriptions) {
        if (description.selection === this.selectionKey(selection)) {
          if (
            description.adopted !== null ||
            description.rows !==
              JSON.stringify(
                facts.rows.map((row) => [row.id, row.manifest_digest]),
              )
          )
            throw new ApplicationError('MEDIA_NOT_READY');
          description.adopted = capability;
        }
      }
    enableRequiredTransactionProof(tx, this.completion);
    registerRequiredTransactionFact(
      tx,
      this.completion,
      randomUUID(),
      capability,
    );
    return capability;
  }
  async accept(
    capability: RatingsDiscussionWholeSet,
    tx: PoolClient,
  ): Promise<readonly { assetId: string; digest: string }[]> {
    const facts = this.requireSet(capability, tx);
    if (facts.accepted || facts.bound)
      throw new ApplicationError('MEDIA_NOT_READY');
    for (const row of facts.rows) {
      await this.requireRetention(row, tx);
      await this.current(row, tx);
    }
    facts.accepted = true;
    return Object.freeze(
      facts.rows.map((row) =>
        Object.freeze({ assetId: row.id, digest: row.manifest_digest }),
      ),
    );
  }
  async bindDiscussion(
    capability: RatingsDiscussionWholeSet,
    rawParent: RatingsDiscussionMediaParent,
    tx: PoolClient,
  ): Promise<readonly RatingsDiscussionAttachment[]> {
    const facts = this.requireSet(capability, tx),
      parent = ratingsDiscussionMediaParentSchema.parse(rawParent),
      b = facts.batch;
    const reply = b.identity.target.kind === 'reply';
    if (
      !facts.accepted ||
      facts.bound ||
      parent.targetId !== b.identity.target.targetId ||
      parent.resourceKind !== (reply ? 'rating_reply' : 'rating_comment') ||
      (parent.resourceKind === 'rating_reply' &&
        parent.rootId !== b.identity.target.rootId)
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    await tx.query(
      `INSERT INTO whaleu_media.scope_consumptions(actor_id,owner_kind,resource_kind,scope_resource_id,scope_revision,resource_id,content_version,attach_evidence) VALUES($1,'ratings',$2,$3,$4,$5,1,$6)`,
      [
        b.actor_id,
        parent.resourceKind,
        b.server_scope_id,
        b.scope_revision,
        parent.resourceId,
        JSON.stringify({
          version: 7,
          batchId: b.id,
          sealedPlanDigest: b.sealed_plan_digest,
          parent,
          assets: facts.rows.map((a) => ({
            assetId: a.id,
            digest: a.manifest_digest,
          })),
        }),
      ],
    );
    const result: RatingsDiscussionAttachment[] = [];
    for (const [ordinal, row] of facts.rows.entries()) {
      await this.requireRetention(row, tx);
      const manifest = await this.current(row, tx),
        bindingId = randomUUID(),
        member = facts.members[ordinal]!;
      await tx.query(
        `INSERT INTO whaleu_media.bindings(id,asset_id,manifest_digest,owner_kind,resource_kind,resource_id,content_version,slot,ordinal,attach_evidence) VALUES($1,$2,$3,'ratings',$4,$5,1,'images',$6,$7)`,
        [
          bindingId,
          row.id,
          row.manifest_digest,
          parent.resourceKind,
          parent.resourceId,
          ordinal,
          JSON.stringify({
            version: 7,
            batchId: b.id,
            memberId: member.member_id,
            sourceSlot: member.source_slot,
            sealedPlanDigest: b.sealed_plan_digest,
            scopeId: b.server_scope_id,
            scopeRevision: b.scope_revision,
          }),
        ],
      );
      result.push(
        Object.freeze({
          bindingId,
          assetId: row.id,
          manifestDigest: row.manifest_digest,
          ordinal,
          width: manifest.variants[1].width,
          height: manifest.variants[1].height,
        }),
      );
    }
    const changed = await tx.query(
      `UPDATE whaleu_media.ratings_discussion_batches SET state='consumed',consumed_parent=$2,revision=$3 WHERE id=$1 AND state='sealed'`,
      [b.id, JSON.stringify(parent), randomUUID()],
    );
    if (changed.rowCount !== 1) throw new ApplicationError('MEDIA_NOT_READY');
    const members = await tx.query(
      `UPDATE whaleu_media.ratings_discussion_members SET state='bound' WHERE batch_id=$1 AND member_id=ANY($2::uuid[]) AND state='live'`,
      [b.id, facts.members.map((m) => m.member_id)],
    );
    if (members.rowCount !== facts.members.length)
      throw new ApplicationError('MEDIA_NOT_READY');
    facts.bound = true;
    return Object.freeze(result);
  }
  /** Only after all original owner, Review, receipt and outbox writes. Earlier
   * read facts are deliberately retained and can invalidate this transaction. */
  async finish(
    capability: RatingsDiscussionWholeSet,
    tx: PoolClient,
  ): Promise<void> {
    const facts = this.requireSet(capability, tx);
    if (!facts.accepted || !facts.bound)
      throw new ApplicationError('MEDIA_NOT_READY');
    await this.proof.capture(tx);
    facts.finished = true;
  }
  /** Used by batch sealing after its lock. Does not enroll a pre-write epoch;
   * caller must capture the post-write proof after storing the whole sealed plan. */
  async inspectUnboundMembers(
    batch: RatingsDiscussionBatchRow,
    memberIds: readonly string[],
    tx: PoolClient,
    write = false,
  ): Promise<{ rows: readonly AssetRow[]; members: readonly MemberRow[] }> {
    this.managed(tx);
    const max = batch.identity.target.kind === 'reply' ? 3 : 9;
    if (
      !memberIds.length ||
      memberIds.length > max ||
      new Set(memberIds).size !== memberIds.length
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const members = (
      await tx.query<MemberRow>(
        `SELECT member_id,source_slot,intent_id,state FROM whaleu_media.ratings_discussion_members WHERE batch_id=$1 AND member_id=ANY($2::uuid[]) ORDER BY member_id FOR ${write ? 'UPDATE' : 'SHARE'} NOWAIT`,
        [batch.id, memberIds],
      )
    ).rows;
    this.retainMetadata(tx, members);
    if (
      members.length !== memberIds.length ||
      members.some((m) => m.state !== 'live')
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const intents = members.map((m) => m.intent_id).sort();
    await tx.query(
      `SELECT id FROM whaleu_media.upload_intents WHERE id=ANY($1::uuid[]) ORDER BY id FOR ${write ? 'UPDATE' : 'SHARE'} NOWAIT`,
      [intents],
    );
    const rows = (
      await tx.query<AssetRow & { protocol_version: number }>(
        `SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.intent_id=ANY($1::uuid[]) ORDER BY a.id FOR ${write ? 'UPDATE' : 'SHARE'} OF a NOWAIT`,
        [intents],
      )
    ).rows;
    this.retainMetadata(tx, rows);
    if (
      rows.length !== members.length ||
      (
        await tx.query(
          'SELECT id FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT',
          [rows.map((a) => a.id)],
        )
      ).rowCount
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const orderedMembers = memberIds.map((id) =>
      members.find((m) => m.member_id === id)!,
    );
    const ordered = orderedMembers.map((member) => {
      const row = rows.find((a) => a.intent_id === member.intent_id);
      const reply = batch.identity.target.kind === 'reply';
      if (
        !row ||
        row.protocol_version !== 7 ||
        row.actor_id !== batch.actor_id ||
        row.owner_kind !== 'ratings' ||
        row.resource_kind !== (reply ? 'rating_reply' : 'rating_comment') ||
        row.purpose !==
          (reply ? 'ratings-reply-image' : 'ratings-comment-image') ||
        row.target_kind !== 'draft' ||
        row.audience !== 'content-gated' ||
        row.resource_id !== batch.server_scope_id ||
        row.scope_revision !== batch.scope_revision ||
        row.slot !== 'images' ||
        row.ordinal !== member.source_slot ||
        Number(row.content_version) !== 1
      )
        throw new ApplicationError('MEDIA_NOT_READY');
      return row;
    });
    registerTransactionDeadline(
      tx,
      batch.expires_at.getTime(),
      'MEDIA_NOT_READY',
    );
    for (const row of ordered) {
      await this.requireRetention(row, tx);
      await this.current(row, tx);
    }
    return {
      rows: Object.freeze(ordered),
      members: Object.freeze(orderedMembers),
    };
  }
  async currentSet(
    rawParent: RatingsDiscussionMediaParent,
    expected: readonly { assetId: string; digest: string }[],
    tx: PoolClient,
    expectedActor?: string,
  ): Promise<readonly RatingsDiscussionAttachment[]> {
    const parent = ratingsDiscussionMediaParentSchema.parse(rawParent);
    if (
      !expected.length ||
      expected.length > (parent.resourceKind === 'rating_reply' ? 3 : 9) ||
      new Set(expected.map((x) => x.assetId)).size !== expected.length
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    this.managed(tx);
    await this.proof.capture(tx);
    await this.lockIntents(
      expected.map((x) => mediaIdSchema.parse(x.assetId)).sort(),
      tx,
      'read',
    );
    const rows = (
      await tx.query<AssetRow & { protocol_version: number }>(
        `SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=ANY($1::uuid[]) ORDER BY a.id FOR SHARE OF a NOWAIT`,
        [expected.map((x) => x.assetId)],
      )
    ).rows;
    const bindings = (
      await tx.query<{
        id: string;
        asset_id: string;
        manifest_digest: string;
        ordinal: number;
      }>(
        `SELECT b.id,b.asset_id,b.manifest_digest,b.ordinal FROM whaleu_media.bindings b JOIN whaleu_media.scope_consumptions c ON c.owner_kind=b.owner_kind AND c.resource_kind=b.resource_kind AND c.resource_id=b.resource_id AND c.content_version=b.content_version WHERE b.owner_kind='ratings' AND b.resource_kind=$1 AND b.resource_id=$2 AND b.content_version=1 AND b.slot='images' AND b.detached_at IS NULL AND c.attach_evidence->'parent'=$3::jsonb ORDER BY b.ordinal,b.id FOR SHARE OF b NOWAIT`,
        [parent.resourceKind, parent.resourceId, JSON.stringify(parent)],
      )
    ).rows;
    this.retainMetadata(tx, rows);
    this.retainMetadata(tx, bindings);
    if (rows.length !== expected.length || bindings.length !== expected.length)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const result: RatingsDiscussionAttachment[] = [];
    for (const [ordinal, image] of expected.entries()) {
      const binding = bindings[ordinal],
        row = rows.find((a) => a.id === image.assetId),
        reply = parent.resourceKind === 'rating_reply';
      if (
        !binding ||
        !row ||
        binding.ordinal !== ordinal ||
        binding.asset_id !== image.assetId ||
        binding.manifest_digest !== image.digest ||
        row.manifest_digest !== image.digest ||
        row.protocol_version !== 7 ||
        (expectedActor !== undefined && row.actor_id !== expectedActor) ||
        row.owner_kind !== 'ratings' ||
        row.resource_kind !== parent.resourceKind ||
        row.purpose !==
          (reply ? 'ratings-reply-image' : 'ratings-comment-image') ||
        row.audience !== 'content-gated' ||
        row.target_kind !== 'draft' ||
        row.slot !== 'images' ||
        Number(row.content_version) !== 1
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      const manifest = await this.current(row, tx);
      result.push(
        Object.freeze({
          bindingId: binding.id,
          assetId: row.id,
          manifestDigest: row.manifest_digest,
          ordinal,
          width: manifest.variants[1].width,
          height: manifest.variants[1].height,
        }),
      );
    }
    return Object.freeze(result);
  }
  async discussionDescriptors(
    proof: RatingsDiscussionMediaReadProof,
    request: RatingsDiscussionMediaReadRequest,
    tx: PoolClient,
  ): Promise<readonly RatingsDiscussionMediaDescriptor[]> {
    if (!this.ratingsOwners) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const read = this.ratingsOwners.require(proof, request, tx),
      attachments = await this.currentSet(
        read.parent,
        read.images.map((x) => ({
          assetId: x.assetId,
          digest: x.manifestDigest,
        })),
        tx,
        read.actorAccountId,
      );
    if (attachments.some((a, i) => a.bindingId !== read.images[i]?.bindingId))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return Object.freeze(
      attachments.map((a) =>
        ratingsDiscussionMediaDescriptorSchema.parse({
          protocol: 'ratings-discussion-media-v1',
          kind: 'ratings-discussion-media',
          targetId: request.targetId,
          rootId: request.rootId,
          replyId: request.replyId,
          subjectRevision: request.subjectRevision,
          contextId: request.contextId,
          contextToken: request.contextToken,
          bindingId: a.bindingId,
          ordinal: a.ordinal,
          attachmentSetDigest: request.attachmentSetDigest,
          width: a.width,
          height: a.height,
          variants: ['thumb-v1', 'display-v1'],
        }),
      ),
    );
  }
  async discussionDeliveryPlan(
    proof: RatingsDiscussionMediaReadProof,
    request: RatingsDiscussionMediaReadRequest,
    bindingId: string,
    ordinal: number,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<RatingsDiscussionMediaDeliveryPlan> {
    if (!this.ratingsOwners) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const read = this.ratingsOwners.require(proof, request, tx),
      descriptors = await this.discussionDescriptors(proof, request, tx),
      descriptor = descriptors[ordinal],
      image = read.images[ordinal];
    if (!descriptor || !image || descriptor.bindingId !== bindingId)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const rows = (
      await tx.query<AssetRow & { safety_revision: string }>(
        `SELECT a.*,h.revision::text AS safety_revision FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id WHERE a.id=ANY($1::uuid[]) ORDER BY a.id`,
        [read.images.map((x) => x.assetId)],
      )
    ).rows;
    this.retainMetadata(tx, rows);
    if (rows.length !== read.images.length)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const row = rows.find((x) => x.id === image.assetId);
    if (!row) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const manifest: MediaManifest = await this.current(row, tx),
      object = manifest.variants.find((x) => x.name === variant);
    if (!object) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return Object.freeze({
      parent: read.parent,
      principal: read.principal,
      ownerRevision: read.ownerRevision,
      reviewRevision: read.reviewRevision,
      subjectRevision: request.subjectRevision,
      contextId: request.contextId,
      contextToken: request.contextToken,
      bindingId,
      ordinal,
      variant,
      manifestDigest: row.manifest_digest,
      safetyRevision: row.safety_revision,
      object: object.object,
      sha256: object.sha256,
      bytes: object.bytes,
      mime: object.mime,
      attachmentSetRevision: createHash('sha256')
        .update(
          JSON.stringify({
            digest: read.attachmentSetDigest,
            images: read.images,
            heads: rows.map((x) => [
              x.id,
              x.manifest_digest,
              x.safety_revision,
            ]),
          }),
        )
        .digest('hex'),
    });
  }
  /** Owner first proves an immutable tombstone/enumeration obligation. Cleanup
   * needs no content read, Review or provider success. Physical cleanup is durable. */
  async detachOwnedParents(
    parents: readonly RatingsDiscussionMediaParent[],
    tx: PoolClient,
  ): Promise<void> {
    this.managed(tx);
    if (!parents.length || parents.length > 16)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const parsed = parents.map((p) =>
      ratingsDiscussionMediaParentSchema.parse(p),
    );
    // The owner-owned tombstone relation is supplied by the additive owner migration.
    const tombstones = await tx.query(
      `SELECT resource_kind,resource_id FROM whaleu_ratings.discussion_media_tombstones WHERE (resource_kind,resource_id,target_id,root_id) IN (SELECT * FROM unnest($1::text[],$2::uuid[],$3::uuid[],$4::uuid[])) ORDER BY resource_kind,resource_id FOR SHARE NOWAIT`,
      [
        parsed.map((p) => p.resourceKind),
        parsed.map((p) => p.resourceId),
        parsed.map((p) => p.targetId),
        parsed.map((p) =>
          p.resourceKind === 'rating_comment' ? p.resourceId : p.rootId,
        ),
      ],
    );
    if (tombstones.rowCount !== parsed.length)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const bindings = (
      await tx.query<{ id: string; asset_id: string; intent_id: string }>(
        `SELECT b.id,b.asset_id,a.intent_id FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE b.owner_kind='ratings' AND b.content_version=1 AND (b.resource_kind,b.resource_id) IN (SELECT * FROM unnest($1::text[],$2::uuid[])) AND b.detached_at IS NULL ORDER BY b.id`,
        [parsed.map((p) => p.resourceKind), parsed.map((p) => p.resourceId)],
      )
    ).rows;
    await this.lockIntents(bindings.map((x) => x.asset_id).sort(), tx, 'write');
    await tx.query(
      'SELECT id FROM whaleu_media.assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
      [bindings.map((x) => x.asset_id)],
    );
    await tx.query(
      'SELECT id FROM whaleu_media.bindings WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
      [bindings.map((x) => x.id)],
    );
    await tx.query(
      `UPDATE whaleu_media.bindings SET detached_at=clock_timestamp(),detach_reason='ratings-discussion-deleted' WHERE id=ANY($1::uuid[]) AND detached_at IS NULL`,
      [bindings.map((x) => x.id)],
    );
    const lifecycle = new MediaLifecycleRepository();
    for (const id of [...new Set(bindings.map((x) => x.intent_id))].sort())
      await lifecycle.detachedOwnerIntent(id, tx);
    await this.proof.capture(tx);
  }
  private async lockSelected(
    selection: RatingsDiscussionSetSelection,
    tx: PoolClient,
    write: boolean,
  ) {
    const epoch = this.managed(tx);
    mediaIdSchema.parse(selection.actor);
    mediaIdSchema.parse(selection.batchId);
    const batch = (
      await tx.query<RatingsDiscussionBatchRow>(
        `SELECT * FROM whaleu_media.ratings_discussion_batches WHERE id=$1 AND actor_id=$2 ORDER BY id FOR ${write ? 'UPDATE' : 'SHARE'} NOWAIT`,
        [selection.batchId, selection.actor],
      )
    ).rows[0];
    this.retainMetadata(tx, batch ?? null);
    if (
      !batch ||
      batch.state !== 'sealed' ||
      batch.identity_hash !== selection.batchIdentityHash ||
      batch.sealed_plan_digest !== selection.sealedPlanDigest
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const plan = ratingsDiscussionSealedPlanSchema.parse(batch.sealed_plan);
    if (
      ratingsDiscussionSealedPlanHash(plan) !== selection.sealedPlanDigest ||
      plan.batchId !== batch.id ||
      plan.batchIdentityHash !== batch.identity_hash ||
      JSON.stringify(
        plan.orderedMembers.map(({ manifestDigest: _digest, ...image }) => {
          void _digest;
          return image;
        }),
      ) !==
        JSON.stringify(
          selection.images.map((x) => ({
            ordinal: x.ordinal,
            memberId: x.memberId,
            assetId: x.assetId,
          })),
        )
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const locked = await this.inspectUnboundMembers(
      batch,
      selection.images.map((x) => x.memberId),
      tx,
      write,
    );
    if (
      locked.rows.some(
        (row, ordinal) =>
          row.id !== plan.orderedMembers[ordinal]?.assetId ||
          row.manifest_digest !== plan.orderedMembers[ordinal]?.manifestDigest,
      )
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    return { tx, epoch, batch, ...locked };
  }
  private selectionKey(selection: RatingsDiscussionSetSelection): string {
    return JSON.stringify([
      selection.actor,
      selection.batchId,
      selection.batchIdentityHash,
      selection.sealedPlanDigest,
      selection.images.map((x) => [x.ordinal, x.memberId, x.assetId]),
    ]);
  }
  private requireSet(
    capability: RatingsDiscussionWholeSet,
    tx: PoolClient,
  ): WholeFacts {
    const facts = this.sets.get(capability);
    if (
      !facts ||
      facts.tx !== tx ||
      facts.epoch !== this.managed(tx) ||
      facts.finished
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    registerTransactionDeadline(
      tx,
      facts.batch.expires_at.getTime(),
      'MEDIA_NOT_READY',
    );
    return facts;
  }
}
