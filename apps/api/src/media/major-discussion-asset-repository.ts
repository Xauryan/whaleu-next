import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { MediaAssetRepository } from './asset-repository.js';
import type { AssetRow } from './asset-repository.js';
import { MediaOwnerProofRegistry } from './owner-proof.js';
import { MajorDiscussionMediaRequiredProof } from './major-discussion-required-proof.js';
import type {
  MajorDiscussionOwnerProofRegistry,
  MajorDiscussionReadProof,
  MajorDiscussionReadRequest,
} from './major-discussion-owner-proof.js';
import type { MediaManifest, MediaVariantName } from './contracts.js';
import type { ExactMediaDeliveryPlan } from './delivery.js';
import {
  MAJOR_DISCUSSION_MEDIA_PROTOCOL,
  majorDiscussionDescriptorSchema,
  majorDiscussionMediaFactsSchema,
  majorDiscussionMediaBindingsSchema,
  majorDiscussionMediaContextSchema,
} from './contracts-major-discussion.js';
import type {
  MajorDiscussionMediaFact,
  MajorDiscussionMediaBinding,
  MajorDiscussionMediaContext,
} from './contracts-major-discussion.js';

type SafetyFact = Readonly<{
  assetId: string;
  revision: string;
  eventId: string;
}>;
/** Independent Major owner. Shared Media only supplies static processing,
 * immutable storage, current Safety and the transaction-final epoch fence. */
export class MajorDiscussionMediaAssetRepository extends MediaAssetRepository {
  protected override readonly proof = new MajorDiscussionMediaRequiredProof();
  constructor(private readonly majorOwners: MajorDiscussionOwnerProofRegistry) {
    super(new MediaOwnerProofRegistry([]));
  }
  async draftFacts(
    actor: string,
    context: MajorDiscussionMediaContext,
    raw: readonly MajorDiscussionMediaFact[],
    tx: PoolClient,
    deferProof = false,
  ) {
    this.managed(tx);
    const scope = majorDiscussionMediaContextSchema.parse(context);
    const images = Object.freeze(
      majorDiscussionMediaFactsSchema.parse(raw).map((x) => Object.freeze(x)),
    );
    await this.lockIntents(
      images.map((x) => x.assetId),
      tx,
      'read',
    );
    const safety: SafetyFact[] = [];
    for (const [ordinal, image] of images.entries()) {
      const row = await this.draftRow(actor, scope, image, ordinal, tx, 'read');
      safety.push(await this.safetyFact(row.id, tx));
    }
    if (!deferProof) await this.proof.capture(tx);
    return Object.freeze({
      images,
      safety: Object.freeze(safety),
      revision: this.revision({ actor, context: scope, images, safety }),
    });
  }
  private async draftRow(
    actor: string,
    context: MajorDiscussionMediaContext,
    image: MajorDiscussionMediaFact,
    ordinal: number,
    tx: PoolClient,
    mode: 'read' | 'write',
  ) {
    const row = (
      await tx.query<AssetRow & { protocol_version: number }>(
        `SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=$1 FOR ${mode === 'read' ? 'SHARE' : 'UPDATE'} OF a NOWAIT`,
        [image.assetId],
      )
    ).rows[0];
    await tx.query(
      `SELECT id FROM whaleu_media.bindings WHERE asset_id=$1 FOR ${mode === 'read' ? 'SHARE' : 'UPDATE'} NOWAIT`,
      [image.assetId],
    );
    if (
      !row ||
      !this.majorAsset(row) ||
      row.protocol_version !== 17 ||
      row.actor_id !== actor ||
      row.manifest_digest !== image.manifestDigest ||
      row.ordinal !== ordinal
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const scope = (
      await tx.query<{ expires_at: Date }>(
        `SELECT expires_at FROM whaleu_media.major_discussion_scopes WHERE id=$1 AND actor_id=$2 AND scope_revision=$3 AND major_id=$4 AND publication_request_id=$5 AND context_digest=$6 AND catalog_revision=$7 AND major_revision=$8 AND root_id IS NOT DISTINCT FROM $9::uuid AND reply_to_reply_id IS NOT DISTINCT FROM $10::uuid AND ordinal=$11`,
        [
          row.resource_id,
          actor,
          row.scope_revision,
          context.majorId,
          context.publicationRequestId,
          context.contextDigest,
          context.catalogRevision,
          context.majorRevision,
          context.rootId,
          context.replyToReplyId,
          ordinal,
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
    commentId: string,
    actor: string,
    context: MajorDiscussionMediaContext,
    raw: readonly MajorDiscussionMediaFact[],
    tx: PoolClient,
  ) {
    this.managed(tx);
    const scope = majorDiscussionMediaContextSchema.parse(context);
    const images = majorDiscussionMediaFactsSchema.parse(raw);
    await this.lockIntents(
      images.map((x) => x.assetId),
      tx,
      'write',
    );
    const bindings: MajorDiscussionMediaBinding[] = [];
    for (const [ordinal, image] of images.entries()) {
      const row = await this.draftRow(
        actor,
        scope,
        image,
        ordinal,
        tx,
        'write',
      );
      const bindingId = randomUUID(),
        appearanceId = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_media.scope_consumptions(actor_id,owner_kind,resource_kind,scope_resource_id,scope_revision,resource_id,content_version,attach_evidence) VALUES($1,'majors','major_discussion_image',$2,$3,$4,1,$5::jsonb)`,
        [
          actor,
          row.resource_id,
          row.scope_revision,
          appearanceId,
          JSON.stringify({
            version: 17,
            assets: [{ assetId: row.id, digest: row.manifest_digest }],
          }),
        ],
      );
      await tx.query(
        `INSERT INTO whaleu_media.bindings(id,asset_id,manifest_digest,owner_kind,resource_kind,resource_id,content_version,slot,ordinal,attach_evidence) VALUES($1,$2,$3,'majors','major_discussion_image',$4,1,'images',$5,$6::jsonb)`,
        [
          bindingId,
          row.id,
          row.manifest_digest,
          appearanceId,
          ordinal,
          JSON.stringify({
            version: 17,
            scopeId: row.resource_id,
            scopeRevision: row.scope_revision,
          }),
        ],
      );
      await tx.query(
        `INSERT INTO whaleu_media.major_discussion_appearances(id,comment_id,major_id,actor_id,publication_request_id,context_digest,ordinal,asset_id,manifest_digest,binding_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          appearanceId,
          commentId,
          scope.majorId,
          actor,
          scope.publicationRequestId,
          scope.contextDigest,
          ordinal,
          row.id,
          row.manifest_digest,
          bindingId,
        ],
      );
      bindings.push(Object.freeze({ ...image, bindingId, ordinal }));
    }
    // Capture only after ALL own writes. No earlier epoch is discarded.
    await this.proof.capture(tx);
    return Object.freeze(bindings);
  }
  async currentFacts(
    commentId: string,
    raw: readonly MajorDiscussionMediaBinding[],
    tx: PoolClient,
  ) {
    this.managed(tx);
    const expected = majorDiscussionMediaBindingsSchema.parse(raw);
    await this.lockIntents(
      expected.map((x) => x.assetId),
      tx,
      'read',
    );
    const appearances = (
      await tx.query<{
        asset_id: string;
        manifest_digest: string;
        binding_id: string;
        ordinal: number;
      }>(
        'SELECT asset_id,manifest_digest,binding_id,ordinal FROM whaleu_media.major_discussion_appearances WHERE comment_id=$1 ORDER BY ordinal',
        [commentId],
      )
    ).rows;
    const actual = appearances.map((x) => ({
      assetId: x.asset_id,
      manifestDigest: x.manifest_digest,
      bindingId: x.binding_id,
      ordinal: x.ordinal,
    }));
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new ApplicationError('MEDIA_NOT_READY');
    // Count every binding too: a missing or extra appearance never reduces the set.
    if (
      (
        await tx.query(
          `SELECT b.id FROM whaleu_media.bindings b JOIN whaleu_media.major_discussion_appearances p ON p.id=b.resource_id WHERE b.owner_kind='majors' AND b.resource_kind='major_discussion_image' AND p.comment_id=$1`,
          [commentId],
        )
      ).rowCount !== expected.length
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const owner = (
      await tx.query<{ image_set: unknown }>(
        `SELECT image_set FROM whaleu_majors.major_discussion_comments WHERE id=$1`,
        [commentId],
      )
    ).rows[0];
    if (
      !owner ||
      JSON.stringify(majorDiscussionMediaFactsSchema.parse(owner.image_set)) !==
        JSON.stringify(
          expected.map(({ assetId, manifestDigest }) => ({
            assetId,
            manifestDigest,
          })),
        )
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const images = [],
      safety: SafetyFact[] = [],
      rows: AssetRow[] = [],
      manifests: MediaManifest[] = [];
    for (const image of expected) {
      const row = (
        await tx.query<
          AssetRow & { protocol_version: number; major_id: string }
        >(
          `SELECT a.*,i.protocol_version,p.major_id FROM whaleu_media.major_discussion_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id JOIN whaleu_media.assets a ON a.id=p.asset_id JOIN whaleu_media.upload_intents i ON i.id=a.intent_id JOIN whaleu_media.major_discussion_scopes s ON s.id=a.resource_id WHERE p.comment_id=$1 AND p.asset_id=$2 AND p.manifest_digest=$3 AND p.binding_id=$4 AND p.ordinal=$5 AND b.resource_id=p.id AND b.owner_kind='majors' AND b.resource_kind='major_discussion_image' AND b.slot='images' AND b.ordinal=p.ordinal AND b.content_version=1 AND b.asset_id=p.asset_id AND b.manifest_digest=p.manifest_digest AND a.manifest_digest=p.manifest_digest AND a.ordinal=p.ordinal AND b.detached_at IS NULL AND (s.actor_id,s.major_id,s.publication_request_id,s.context_digest,s.ordinal)=(p.actor_id,p.major_id,p.publication_request_id,p.context_digest,p.ordinal) FOR SHARE OF a,b NOWAIT`,
          [
            commentId,
            image.assetId,
            image.manifestDigest,
            image.bindingId,
            image.ordinal,
          ],
        )
      ).rows[0];
      if (!row || !this.majorAsset(row) || row.protocol_version !== 17)
        throw new ApplicationError('MEDIA_NOT_READY');
      // A bound image has no upload TTL. Source/Review denial hides, never retires.
      const manifest = await this.current(row, tx);
      safety.push(await this.safetyFact(row.id, tx));
      const descriptor = majorDiscussionDescriptorSchema.parse({
        protocol: MAJOR_DISCUSSION_MEDIA_PROTOCOL,
        kind: 'major-discussion-media',
        majorId: row.major_id,
        commentId,
        bindingId: image.bindingId,
        ordinal: image.ordinal,
        width: manifest.variants[1].width,
        height: manifest.variants[1].height,
        variants: ['thumb-v1', 'display-v1'],
      });
      images.push(Object.freeze({ ...image, descriptor }));
      rows.push(row);
      manifests.push(manifest);
    }
    await this.proof.capture(tx);
    return {
      images: Object.freeze(images),
      safety: Object.freeze(safety),
      revision: this.revision({ commentId, images: expected, safety }),
      rows,
      manifests,
    };
  }
  async describe(
    proof: MajorDiscussionReadProof,
    request: MajorDiscussionReadRequest,
    tx: PoolClient,
  ) {
    const { facts } = await this.read(proof, request, tx);
    return facts.images[request.reference.ordinal]!.descriptor;
  }
  async plan(
    proof: MajorDiscussionReadProof,
    request: MajorDiscussionReadRequest,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<
    ExactMediaDeliveryPlan & {
      accountId: string;
      sessionId: string;
      bindingId: string;
    }
  > {
    const { facts, authority } = await this.read(proof, request, tx);
    const object = facts.manifests[request.reference.ordinal]?.variants.find(
      (x) => x.name === variant,
    );
    if (!object) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return Object.freeze({
      object: object.object,
      sha256: object.sha256,
      bytes: object.bytes,
      mime: object.mime,
      accountId: authority.accountId,
      sessionId: authority.sessionId,
      bindingId: authority.reference.bindingId,
      attachmentSetRevision: this.revision({
        reference: authority.reference,
        ownerRevision: authority.ownerRevision,
        mediaRevision: facts.revision,
        accountId: authority.accountId,
        sessionId: authority.sessionId,
        variant,
      }),
    });
  }
  private async read(
    proof: MajorDiscussionReadProof,
    request: MajorDiscussionReadRequest,
    tx: PoolClient,
  ) {
    const authority = this.majorOwners.require(proof, request, tx);
    const facts = await this.currentFacts(
      authority.commentId,
      authority.images,
      tx,
    );
    const exact = await tx.query(
      `SELECT 1 FROM whaleu_media.major_discussion_appearances WHERE comment_id=$1 AND major_id=$2 AND actor_id=$3 AND publication_request_id=$4 AND context_digest=$5 AND binding_id=$6 AND ordinal=$7`,
      [
        authority.commentId,
        authority.majorId,
        authority.actorAccountId,
        authority.publicationRequestId,
        authority.contextDigest,
        authority.reference.bindingId,
        authority.reference.ordinal,
      ],
    );
    if (exact.rowCount !== 1) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return { authority, facts };
  }
  private async safetyFact(
    assetId: string,
    tx: PoolClient,
  ): Promise<SafetyFact> {
    const head = (
      await tx.query<{ revision: string; event_id: string }>(
        'SELECT revision::text,event_id FROM whaleu_media.asset_safety_heads WHERE asset_id=$1',
        [assetId],
      )
    ).rows[0];
    if (!head) throw new ApplicationError('MEDIA_NOT_READY');
    return Object.freeze({
      assetId,
      revision: head.revision,
      eventId: head.event_id,
    });
  }
  private revision(value: unknown) {
    return createHash('sha256')
      .update('whaleu-major-discussion-media-set:v1\n')
      .update(JSON.stringify(value))
      .digest('hex');
  }
  private majorAsset(row: AssetRow) {
    return (
      row.owner_kind === 'majors' &&
      row.resource_kind === 'major_discussion_image' &&
      row.target_kind === 'edit' &&
      row.content_version === '1' &&
      row.audience === 'content-gated' &&
      row.purpose === 'major-discussion-image' &&
      row.slot === 'images' &&
      row.ordinal >= 0 &&
      row.ordinal < 3
    );
  }
}
