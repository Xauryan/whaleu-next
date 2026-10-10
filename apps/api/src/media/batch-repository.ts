import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  transactionReadEpoch,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import type { MediaParent } from './contracts.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import type { MediaStatusV2 } from './contracts-v2.js';
import type { MediaStatusV4 } from './contracts-v4.js';
import { prepareMediaV4Schema } from './contracts-v4.js';
import { prepareMediaV3Schema } from './contracts-v3.js';
import { batchProtocol, publicationReferenceSchema } from './batch-protocol.js';
import type {
  MediaBatchIdentity,
  MediaBatchStatus,
  MediaBatchRecovery,
  MediaBatchPublicationRecovery,
  MediaMemberStatus,
  PublicationMediaContext,
  MediaBatchOrderedAsset,
  MediaBatchCommandKind,
  PrepareMediaBatchInput,
  MediaBatchPublicationCancellation,
  MediaBatchFencePublicationResult,
} from './batch-protocol.js';
import type { MediaPrepareScopes } from './prepare-scope.js';
import { lockMediaActor } from './intent-repository.js';
import type { MediaIntentRepository } from './intent-repository.js';
import type { MediaLifecycleRepository } from './lifecycle-repository.js';
import { MediaRecoveryRepository } from './recovery-repository.js';
import { MediaRequiredProof } from './required-proof.js';

export type {
  PublicationMediaContext,
  MediaBatchPublicationCancellation,
} from './batch-protocol.js';
export interface MediaBatchPublicationProofPort {
  /** Must lock the exact Community command BEFORE the batch. Absence is unknown. */
  requireNonCreatedTerminal(
    actor: string,
    reference: PublicationMediaContext,
    tx: PoolClient,
  ): Promise<void>;
  fenceNonCreated(
    actor: string,
    reference: PublicationMediaContext,
    tx: PoolClient,
  ): Promise<MediaBatchPublicationCancellation>;
}
export interface MediaBatchReadinessPort {
  readyOwned(
    actor: string,
    intentId: string,
    tx: PoolClient,
  ): Promise<string | null>;
}
export interface MediaSealedBatchEvidence {
  readonly version: 2 | 3;
  readonly batchId: string;
  readonly batchRevision: string;
  readonly attachmentPlanDigest: string;
  readonly publication: PublicationMediaContext;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly mappings: readonly (MediaBatchOrderedAsset & {
    readonly sourceSlot: number;
    readonly ordinal: number;
  })[];
}
interface Batch {
  id: string;
  protocol_version: 3 | 4;
  actor_id: string;
  client_batch_id: string;
  request_hash: string;
  identity: MediaBatchIdentity | null;
  server_scope_id: string | null;
  scope_revision: string | null;
  state:
    'fenced' | 'editing' | 'sealed' | 'cancelling' | 'terminal' | 'consumed';
  revision: string;
  ordered_member_ids: string[];
  publication: PublicationMediaContext | null;
  attachment_plan_digest: string | null;
  consumed_parent: MediaParent | null;
}
interface Member {
  batch_id: string;
  actor_id: string;
  member_id: string;
  source_slot: number;
  client_request_id: string;
  request_hash: string;
  declaration: {
    mime: 'image/jpeg' | 'image/png';
    bytes: number;
    sha256: string;
  };
  intent_id: string;
  asset_id: string | null;
  state: 'live' | 'retiring' | 'terminal' | 'bound';
}
interface Asset {
  id: string;
  intent_id: string;
  manifest_digest: string;
  ordinal: number;
}
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function conflict(): never {
  throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
}
function unavailable(): never {
  throw new ApplicationError('MEDIA_UNAVAILABLE');
}
/** No HTTP-supplied evidence is accepted. Evidence objects are identity-bound to
 * this repository and the original managed transaction/epoch. */
export class MediaBatchRepository {
  private readonly proof = new MediaRequiredProof();
  readonly recovery: MediaRecoveryRepository;
  private readonly issued = new WeakMap<
    MediaSealedBatchEvidence,
    {
      tx: PoolClient;
      epoch: object;
      actor: string;
      publication: PublicationMediaContext;
    }
  >();
  constructor(
    private readonly scopes: MediaPrepareScopes,
    private readonly intents: MediaIntentRepository,
    private readonly lifecycle: MediaLifecycleRepository,
    readiness: MediaBatchReadinessPort,
    private readonly publicationProof: MediaBatchPublicationProofPort,
    readonly protocolVersion: 3 | 4 = 3,
  ) {
    this.recovery = new MediaRecoveryRepository(
      lifecycle,
      readiness,
      protocolVersion,
    );
  }

  private get codec() {
    return batchProtocol(this.protocolVersion);
  }
  private get limit() {
    return this.protocolVersion === 4 ? 3 : 9;
  }
  private assertProtocol(batch: Batch): Batch {
    if (batch.protocol_version !== this.protocolVersion) conflict();
    if (batch.identity)
      this.codec.mediaBatchIdentitySchema.parse(batch.identity);
    return batch;
  }
  private matchesPublication(
    batch: Batch,
    reference: PublicationMediaContext,
  ): boolean {
    return (
      reference.operation ===
      (batch.identity?.version === 2
        ? `publish_${batch.identity.target.kind}`
        : 'publish_post')
    );
  }
  private async authorizeIdentity(
    actor: string,
    batch: Batch,
    tx: PoolClient,
  ): Promise<void> {
    if (!batch.identity) unavailable();
    const input = this.internalInput(batch, {
      clientRequestId: batch.client_batch_id,
      memberId: batch.client_batch_id,
      sourceSlot: 0,
      declaration: { mime: 'image/png', bytes: 1, sha256: '0'.repeat(64) },
    });
    const scope = this.scopes.require(
      await this.scopes.authorizeBatch(actor, input, tx),
      tx,
    ).scope;
    if (
      scope.serverScopeId !== batch.server_scope_id ||
      scope.scopeRevision !== batch.scope_revision
    )
      unavailable();
  }
  async prepare(
    actor: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaBatchStatus> {
    const identity = this.codec.mediaBatchIdentitySchema.parse(raw),
      hash = this.codec.mediaBatchRequestHash(actor, identity);
    this.managed(tx);
    // Key lock serializes absent-row prepare and cancel-before-prepare.
    await this.keyLock(actor, identity.batchRequestId, tx);
    const existing = await this.byRequest(
      actor,
      identity.batchRequestId,
      tx,
      true,
    );
    if (existing) {
      if (existing.request_hash !== hash) conflict();
      return this.encode(existing, tx);
    }
    const batchId = randomUUID();
    const initial = {
      protocolVersion: this.protocolVersion,
      clientRequestId: identity.batchRequestId,
      purpose:
        identity.version === 2
          ? identity.target.kind === 'comment'
            ? 'community-comment-image'
            : 'community-reply-image'
          : 'community-post-image',
      draftId: identity.draftId,
      spaceId: identity.spaceId,
      slot: 'images',
      ordinal: 0,
      declaration: { mime: 'image/png', bytes: 1, sha256: '0'.repeat(64) },
      batchId,
      batchIdentity: identity,
      memberId: identity.batchRequestId,
    };
    const scope = this.scopes.require(
      await this.scopes.authorizeBatch(
        actor,
        this.protocolVersion === 4
          ? prepareMediaV4Schema.parse(initial)
          : prepareMediaV3Schema.parse(initial),
        tx,
      ),
      tx,
    ).scope;
    await this.reserveBatch(actor, tx);
    const batch =
      (
        await tx.query<Batch>(
          `INSERT INTO whaleu_media.publication_batches
      (id,actor_id,client_batch_id,request_hash,identity,server_scope_id,scope_revision,state,protocol_version)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,'editing',$8) RETURNING *`,
          [
            batchId,
            actor,
            identity.batchRequestId,
            hash,
            JSON.stringify(identity),
            scope.serverScopeId,
            scope.scopeRevision,
            this.protocolVersion,
          ],
        )
      ).rows[0] ?? unavailable();
    return this.encode(batch, tx);
  }
  async recover(
    actor: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<MediaBatchRecovery> {
    const batch = await this.byRequest(
      actor,
      mediaV2IdSchema.parse(requestId),
      tx,
    );
    return batch
      ? {
          version: this.protocolVersion,
          state: 'recorded',
          status: await this.encode(batch, tx),
        }
      : {
          version: this.protocolVersion,
          state: 'not_recorded',
          batchRequestId: requestId,
          serverNow: await this.now(tx),
        };
  }
  async status(
    actor: string,
    batchId: string,
    tx: PoolClient,
  ): Promise<MediaBatchStatus> {
    return this.encode(await this.byId(actor, batchId, tx), tx);
  }
  async recoverPublication(
    actor: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaBatchPublicationRecovery> {
    const input = this.codec.mediaBatchRecoverPublicationSchema.parse(raw);
    // Exact asset membership is also sufficient to rediscover the original
    // editing batch in the crash gap after Community.freeze and before seal.
    // Still no inferred publication success or permission to create a new key.
    const rows = (
      await tx.query<Batch>(
        `SELECT b.* FROM whaleu_media.publication_batches b WHERE b.actor_id=$1 AND b.protocol_version=$4
      AND ((b.state IN ('sealed','consumed') AND b.publication=$2::jsonb) OR (b.state='editing' AND b.publication IS NULL))
      AND jsonb_array_length(b.ordered_member_ids)=cardinality($3::uuid[])
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(b.ordered_member_ids) WITH ORDINALITY o(member,ordinal)
        LEFT JOIN whaleu_media.publication_batch_members m ON m.batch_id=b.id AND m.member_id::text=o.member AND m.state IN ('live','bound')
        LEFT JOIN whaleu_media.assets a ON a.intent_id=m.intent_id
        WHERE a.id IS DISTINCT FROM ($3::uuid[])[o.ordinal::integer])
      ORDER BY b.id LIMIT 2 FOR SHARE OF b`,
        [
          actor,
          JSON.stringify(input.publication),
          input.assetIds,
          this.protocolVersion,
        ],
      )
    ).rows;
    if (rows.length !== 1)
      return {
        version: this.protocolVersion,
        state: 'unknown',
        serverNow: await this.now(tx),
      };
    if (
      !this.matchesPublication(rows[0]!, input.publication) ||
      ('target' in input &&
        !same(
          rows[0]?.identity && 'target' in rows[0].identity
            ? rows[0].identity.target
            : null,
          input.target,
        ))
    )
      return { version: 4, state: 'unknown', serverNow: await this.now(tx) };
    const status = await this.encode(rows[0]!, tx);
    if (
      !same(
        status.members.map((m) => m.assetId),
        input.assetIds,
      )
    )
      return {
        version: this.protocolVersion,
        state: 'unknown',
        serverNow: await this.now(tx),
      };
    return { version: this.protocolVersion, state: 'recorded', status };
  }
  async fencePublication(
    actor: string,
    id: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaBatchFencePublicationResult> {
    const input = this.codec.mediaBatchRecoverPublicationSchema.parse(raw);
    // The owner command is the first serialized object. A new fence is rolled
    // back if any following full-set check fails; metadata never cancels another
    // actor's command or an unrelated exact asset set.
    const cancellation = await this.publicationProof.fenceNonCreated(
      actor,
      input.publication,
      tx,
    );
    const batch = await this.byId(actor, id, tx, true);
    if (
      !this.matchesPublication(batch, input.publication) ||
      ('target' in input &&
        !same(
          batch.identity && 'target' in batch.identity
            ? batch.identity.target
            : null,
          input.target,
        )) ||
      !['editing', 'sealed', 'consumed'].includes(batch.state) ||
      (batch.publication && !same(batch.publication, input.publication))
    )
      conflict();
    const status = await this.encode(batch, tx);
    if (
      !same(
        status.members.map((m) => m.assetId),
        input.assetIds,
      )
    )
      conflict();
    if (
      cancellation.outcome === 'created' &&
      (status.status !== 'bound_history' ||
        status.parent.resourceId !== cancellation.resourceId)
    )
      unavailable();
    if (cancellation.outcome !== 'created' && status.status === 'bound_history')
      unavailable();
    return { version: this.protocolVersion, status, cancellation };
  }
  async prepareMember(
    actor: string,
    batchId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaMemberStatus> {
    const input = this.codec.mediaMemberPrepareSchema.parse(raw);
    // Current owner/draft authority is acquired before the batch row.
    const hint = (
      await tx.query<Batch>(
        'SELECT * FROM whaleu_media.publication_batches WHERE id=$1 AND actor_id=$2',
        [mediaV2IdSchema.parse(batchId), actor],
      )
    ).rows[0];
    if (!hint?.identity) unavailable();
    this.assertProtocol(hint);
    const original = (
      await tx.query<Member>(
        'SELECT * FROM whaleu_media.publication_batch_members WHERE batch_id=$1 AND member_id=$2',
        [batchId, input.memberId],
      )
    ).rows[0];
    if (original) {
      if (
        original.request_hash !==
        this.codec.mediaMemberRequestHash(actor, hint!.identity, input)
      )
        conflict();
      await this.byId(actor, batchId, tx);
      return this.encodeMember(original, tx);
    }
    const internal = this.internalInput(hint!, input);
    const capability = await this.scopes.authorizeBatch(actor, internal, tx);
    const batch = await this.byId(actor, batchId, tx, true);
    const hash = this.codec.mediaMemberRequestHash(
      actor,
      batch.identity,
      input,
    );
    const prior = (
      await tx.query<Member>(
        'SELECT * FROM whaleu_media.publication_batch_members WHERE batch_id=$1 AND member_id=$2',
        [batchId, input.memberId],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== hash) conflict();
      return this.encodeMember(prior, tx);
    }
    if (batch.state !== 'editing') unavailable();
    await lockMediaActor(actor, tx);
    const requestOwner = (
      await tx.query<{ batch_id: string }>(
        'SELECT batch_id FROM whaleu_media.publication_batch_members WHERE actor_id=$1 AND client_request_id=$2',
        [actor, input.clientRequestId],
      )
    ).rows[0];
    if (requestOwner) conflict();
    const members = await this.members(batch.id, tx);
    if (
      members.filter((m) => m.state === 'live').length >= this.limit ||
      members.filter((m) => m.state === 'retiring').length >= this.limit ||
      members.length >= 128 ||
      members.some(
        (m) => m.state === 'live' && m.source_slot === input.sourceSlot,
      )
    )
      unavailable();
    const revision = this.nextRevision(batch);
    const receipt = await this.intents.prepare(capability, tx);
    const member =
      (
        await tx.query<Member>(
          `INSERT INTO whaleu_media.publication_batch_members
      (batch_id,actor_id,member_id,source_slot,client_request_id,request_hash,declaration,intent_id,state,added_revision)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'live',$9) RETURNING *`,
          [
            batch.id,
            actor,
            input.memberId,
            input.sourceSlot,
            input.clientRequestId,
            hash,
            JSON.stringify(input.declaration),
            receipt.intentId,
            revision,
          ],
        )
      ).rows[0] ?? unavailable();
    await tx.query(
      'UPDATE whaleu_media.publication_batches SET ordered_member_ids=$2::jsonb,revision=$3,updated_at=clock_timestamp() WHERE id=$1',
      [
        batch.id,
        JSON.stringify([...batch.ordered_member_ids, input.memberId]),
        revision,
      ],
    );
    await this.proof.capture(tx);
    return this.encodeMember(member, tx);
  }
  async memberStatus(
    actor: string,
    intentId: string,
    tx: PoolClient,
  ): Promise<MediaMemberStatus> {
    const member =
      (
        await tx.query<Member>(
          'SELECT * FROM whaleu_media.publication_batch_members WHERE intent_id=$1 AND actor_id=$2',
          [mediaV2IdSchema.parse(intentId), actor],
        )
      ).rows[0] ?? unavailable();
    await this.byId(actor, member.batch_id, tx);
    return this.encodeMember(member, tx);
  }
  async layout(
    actor: string,
    id: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaBatchStatus> {
    const input = this.codec.mediaBatchLayoutSchema.parse(raw),
      batch = await this.byId(actor, id, tx, true);
    const replay = await this.commandReplay(batch, 'layout', input, tx);
    if (replay) return replay;
    if (batch.state !== 'editing' || batch.revision !== input.expectedRevision)
      conflict();
    await lockMediaActor(actor, tx);
    const members = await this.lockMembers(batch.id, tx, true);
    const live = members.filter((m) => m.state === 'live'),
      all = [...input.orderedMemberIds, ...input.removeMemberIds];
    if (
      all.length !== live.length ||
      new Set(all).size !== all.length ||
      live.some((m) => !all.includes(m.member_id))
    )
      conflict();
    if (
      members.filter((m) => m.state === 'retiring').length +
        input.removeMemberIds.length >
      this.limit
    )
      unavailable();
    const revision = this.nextRevision(batch);
    for (const member of live
      .filter((m) => input.removeMemberIds.includes(m.member_id))
      .sort((a, b) => a.intent_id.localeCompare(b.intent_id))) {
      const cancelled = await this.recovery.cancel(actor, member.intent_id, tx);
      if (cancelled.result === 'bound_history') unavailable();
      await tx.query(
        "UPDATE whaleu_media.publication_batch_members SET state='terminal',removed_revision=$3 WHERE batch_id=$1 AND member_id=$2",
        [id, member.member_id, revision],
      );
    }
    await tx.query(
      'UPDATE whaleu_media.publication_batches SET ordered_member_ids=$2::jsonb,revision=$3,updated_at=clock_timestamp() WHERE id=$1',
      [id, JSON.stringify(input.orderedMemberIds), revision],
    );
    const checkpoint = checkpointTransactionDeadlines(tx);
    const result = await this.encode(await this.byId(actor, id, tx, true), tx);
    return this.recordCommand(batch, 'layout', input, result, tx, checkpoint);
  }
  async seal(
    actor: string,
    id: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaBatchStatus> {
    const input = this.codec.mediaBatchSealSchema.parse(raw);
    if (this.protocolVersion === 4) {
      const hint = (
        await tx.query<Batch>(
          'SELECT * FROM whaleu_media.publication_batches WHERE id=$1 AND actor_id=$2',
          [id, actor],
        )
      ).rows[0];
      if (!hint) unavailable();
      this.assertProtocol(hint);
      await this.authorizeIdentity(actor, hint, tx);
      if (
        hint.identity?.version !== 2 ||
        input.publication.operation !== `publish_${hint.identity.target.kind}`
      )
        conflict();
    }
    const batch = await this.byId(actor, id, tx, true);
    const replay = await this.commandReplay(batch, 'seal', input, tx);
    if (replay) return replay;
    if (
      batch.state !== 'editing' ||
      batch.revision !== input.expectedRevision ||
      !same(batch.ordered_member_ids, input.orderedMemberIds)
    )
      conflict();
    const checkpoint = checkpointTransactionDeadlines(tx);
    const ready = await this.encode(batch, tx);
    if (ready.status !== 'ready_unbound' || ready.retiring.length)
      throw new ApplicationError('MEDIA_NOT_READY');
    const revision = this.nextRevision(batch),
      planDigest = this.codec.mediaAttachmentPlanDigest(
        id,
        revision,
        ready.orderedAssets,
      );
    await tx.query(
      "UPDATE whaleu_media.publication_batches SET state='sealed',revision=$2,publication=$3::jsonb,attachment_plan_digest=$4,updated_at=clock_timestamp() WHERE id=$1",
      [id, revision, JSON.stringify(input.publication), planDigest],
    );
    for (const asset of ready.orderedAssets)
      await tx.query(
        'UPDATE whaleu_media.publication_batch_members SET asset_id=$3 WHERE batch_id=$1 AND member_id=$2',
        [id, asset.memberId, asset.assetId],
      );
    const result = await this.encode(await this.byId(actor, id, tx, true), tx);
    return this.recordCommand(batch, 'seal', input, result, tx, checkpoint);
  }
  async reopen(
    actor: string,
    id: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaBatchStatus> {
    const input = this.codec.mediaBatchReopenSchema.parse(raw);
    await this.publicationProof.requireNonCreatedTerminal(
      actor,
      input.publication,
      tx,
    );
    const batch = await this.byId(actor, id, tx, true),
      replay = await this.commandReplay(batch, 'reopen', input, tx);
    if (replay) return replay;
    if (
      batch.state !== 'sealed' ||
      batch.revision !== input.expectedRevision ||
      !same(batch.publication, input.publication)
    )
      conflict();
    await tx.query(
      "UPDATE whaleu_media.publication_batches SET state='editing',revision=$2,publication=NULL,attachment_plan_digest=NULL,updated_at=clock_timestamp() WHERE id=$1",
      [id, this.nextRevision(batch)],
    );
    const checkpoint = checkpointTransactionDeadlines(tx);
    const result = await this.encode(await this.byId(actor, id, tx, true), tx);
    return this.recordCommand(batch, 'reopen', input, result, tx, checkpoint);
  }
  /** Commits a durable fence independently from cleanup. A sealed pending
   * publication remains pending until the Community owner proves rejection. */
  async beginCancel(
    actor: string,
    requestId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaBatchRecovery> {
    const input = this.codec.mediaBatchCancelSchema.parse(raw);
    mediaV2IdSchema.parse(requestId);
    await this.keyLock(actor, requestId, tx);
    let batch = await this.byRequest(actor, requestId, tx, true);
    if (!batch) {
      await this.reserveBatch(actor, tx);
      batch =
        (
          await tx.query<Batch>(
            `INSERT INTO whaleu_media.publication_batches(id,actor_id,client_batch_id,request_hash,state,protocol_version) VALUES($1,$2,$3,$4,'fenced',$5) RETURNING *`,
            [
              randomUUID(),
              actor,
              requestId,
              input.batchRequestHash,
              this.protocolVersion,
            ],
          )
        ).rows[0] ?? unavailable();
    } else {
      if (batch.request_hash !== input.batchRequestHash) conflict();
      if (batch.state === 'editing') {
        await tx.query(
          "UPDATE whaleu_media.publication_batches SET state='cancelling',updated_at=clock_timestamp() WHERE id=$1",
          [batch.id],
        );
        batch = { ...batch, state: 'cancelling' };
      }
    }
    return {
      version: this.protocolVersion,
      state: 'recorded',
      status: await this.encode(batch, tx),
    };
  }
  async finishCancellation(
    actor: string,
    id: string,
    tx: PoolClient,
  ): Promise<MediaBatchStatus> {
    const batch = await this.byId(actor, id, tx, true);
    if (batch.state !== 'cancelling') return this.encode(batch, tx);
    await lockMediaActor(actor, tx);
    const members = await this.lockMembers(batch.id, tx, true);
    const revision = this.nextRevision(batch);
    for (const member of members
      .filter((m) => m.state !== 'terminal')
      .sort((a, b) => a.intent_id.localeCompare(b.intent_id))) {
      const status = await this.recovery.cancel(actor, member.intent_id, tx);
      if (status.result === 'bound_history') unavailable();
      await tx.query(
        "UPDATE whaleu_media.publication_batch_members SET state='terminal',removed_revision=coalesce(removed_revision,$3) WHERE batch_id=$1 AND member_id=$2",
        [id, member.member_id, revision],
      );
    }
    await tx.query(
      "UPDATE whaleu_media.publication_batches SET state='terminal',revision=$2,ordered_member_ids='[]',updated_at=clock_timestamp() WHERE id=$1",
      [id, revision],
    );
    return this.encode(await this.byId(actor, id, tx, true), tx);
  }

  async peekSealed(
    actor: string,
    orderedAssetIds: readonly string[],
    context: PublicationMediaContext | undefined,
    tx: PoolClient,
  ): Promise<MediaSealedBatchEvidence | null> {
    this.managed(tx);
    if (
      !orderedAssetIds.length ||
      orderedAssetIds.length > this.limit ||
      new Set(orderedAssetIds).size !== orderedAssetIds.length
    )
      unavailable();
    // Routing read has no locks and grants no authority. Unknown IDs never prove legacy.
    const hints = (
      await tx.query<{
        id: string;
        protocol_version: number;
        batch_id: string | null;
      }>(
        `SELECT a.id,i.protocol_version,m.batch_id FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id LEFT JOIN whaleu_media.publication_batch_members m ON m.intent_id=i.id WHERE a.id=ANY($1::uuid[])`,
        [orderedAssetIds],
      )
    ).rows;
    if (hints.length !== orderedAssetIds.length) unavailable();
    if (hints.every((h) => h.protocol_version !== this.protocolVersion))
      return null;
    if (
      !context ||
      hints.some(
        (h) => h.protocol_version !== this.protocolVersion || !h.batch_id,
      ) ||
      new Set(hints.map((h) => h.batch_id)).size !== 1
    )
      unavailable();
    const publication = publicationReferenceSchema.parse(context),
      batch = await this.byId(actor, hints[0]!.batch_id!, tx, true);
    if (
      batch.state !== 'sealed' ||
      !same(batch.publication, publication) ||
      !batch.server_scope_id ||
      !batch.scope_revision ||
      !batch.attachment_plan_digest
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const members = await this.lockMembers(batch.id, tx, true);
    if (members.some((m) => m.state === 'retiring')) unavailable();
    const live = members.filter((m) => m.state === 'live');
    if (
      live.length !== orderedAssetIds.length ||
      batch.ordered_member_ids.length !== live.length ||
      new Set(batch.ordered_member_ids).size !== live.length
    )
      unavailable();
    const assets = await this.memberAssets(live, tx);
    const mappings = batch.ordered_member_ids.map((memberId, ordinal) => {
      const member =
        live.find((m) => m.member_id === memberId) ?? unavailable();
      const asset =
        assets.find((a) => a.intent_id === member.intent_id) ?? unavailable();
      if (
        asset.id !== orderedAssetIds[ordinal] ||
        member.asset_id !== asset.id ||
        asset.ordinal !== member.source_slot
      )
        unavailable();
      return Object.freeze({
        memberId,
        sourceSlot: member.source_slot,
        assetId: asset.id,
        manifestDigest: asset.manifest_digest,
        ordinal,
      });
    });
    const digest = this.codec.mediaAttachmentPlanDigest(
      batch.id,
      batch.revision,
      mappings.map(({ memberId, assetId, manifestDigest }) => ({
        memberId,
        assetId,
        manifestDigest,
      })),
    );
    if (digest !== batch.attachment_plan_digest) unavailable();
    const evidence: MediaSealedBatchEvidence = Object.freeze({
      version: this.protocolVersion === 4 ? 3 : 2,
      batchId: batch.id,
      batchRevision: batch.revision,
      publication: Object.freeze(publication),
      attachmentPlanDigest: digest,
      serverScopeId: batch.server_scope_id,
      scopeRevision: batch.scope_revision,
      mappings: Object.freeze(mappings),
    });
    this.issued.set(evidence, {
      tx,
      epoch: transactionReadEpoch(tx)!,
      actor,
      publication,
    });
    return evidence;
  }
  async consumeSealed(
    evidence: MediaSealedBatchEvidence,
    parent: MediaParent,
    bindings: readonly {
      bindingId: string;
      assetId: string;
      manifestDigest: string;
      ordinal: number;
    }[],
    tx: PoolClient,
  ): Promise<void> {
    const issued = this.issued.get(evidence);
    if (
      !issued ||
      issued.tx !== tx ||
      issued.epoch !== transactionReadEpoch(tx) ||
      parent.ownerKind !== 'community' ||
      parent.resourceKind !==
        (issued?.publication.operation === 'publish_post'
          ? 'post'
          : issued?.publication.operation === 'publish_comment'
            ? 'comment'
            : 'reply') ||
      parent.contentVersion !== 1
    )
      unavailable();
    const batch = await this.byId(issued!.actor, evidence.batchId, tx, true);
    if (
      batch.state !== 'sealed' ||
      batch.revision !== evidence.batchRevision ||
      batch.attachment_plan_digest !== evidence.attachmentPlanDigest ||
      !same(batch.publication, issued!.publication) ||
      bindings.length !== evidence.mappings.length ||
      new Set(bindings.map((b) => b.bindingId)).size !== bindings.length
    )
      unavailable();
    for (const [ordinal, mapping] of evidence.mappings.entries()) {
      const binding = bindings[ordinal];
      if (
        !binding ||
        binding.ordinal !== ordinal ||
        binding.assetId !== mapping.assetId ||
        binding.manifestDigest !== mapping.manifestDigest
      )
        unavailable();
      const matched = await tx.query(
        `SELECT 1 FROM whaleu_media.bindings WHERE id=$1 AND asset_id=$2 AND manifest_digest=$3 AND ordinal=$4 AND owner_kind='community' AND resource_kind=$6 AND resource_id=$5 AND content_version=1 AND detached_at IS NULL`,
        [
          binding!.bindingId,
          mapping.assetId,
          mapping.manifestDigest,
          ordinal,
          parent.resourceId,
          parent.resourceKind,
        ],
      );
      if (matched.rowCount !== 1) unavailable();
    }
    await tx.query(
      "UPDATE whaleu_media.publication_batch_members SET state='bound' WHERE batch_id=$1 AND state='live'",
      [batch.id],
    );
    await tx.query(
      "UPDATE whaleu_media.publication_batches SET state='consumed',consumed_parent=$2::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND state='sealed'",
      [batch.id, JSON.stringify(parent)],
    );
    this.issued.delete(evidence);
    await this.proof.capture(tx);
  }
  private async encode(
    batch: Batch,
    tx: PoolClient,
  ): Promise<MediaBatchStatus> {
    this.assertProtocol(batch);
    const all = await this.lockMembers(batch.id, tx, false);
    const active = all.filter((m) => m.state === 'live' || m.state === 'bound'),
      retiring = all.filter((m) => m.state === 'retiring');
    if (
      active.length > this.limit ||
      retiring.length > this.limit ||
      active.length !== batch.ordered_member_ids.length ||
      new Set(batch.ordered_member_ids).size !== active.length
    )
      unavailable();
    const ordered = batch.ordered_member_ids.map(
      (id) => active.find((m) => m.member_id === id) ?? unavailable(),
    );
    const members: MediaMemberStatus[] = [];
    for (const member of ordered)
      members.push(await this.encodeMember(member, tx));
    const retired: MediaMemberStatus[] = [];
    for (const member of retiring)
      retired.push(await this.encodeMember(member, tx));
    const resolved =
      this.protocolVersion === 4
        ? {
            resolvedPostId:
              batch.identity?.version === 2 &&
              batch.server_scope_id &&
              batch.scope_revision
                ? await this.scopes.resolvedDiscussionPostId(
                    batch.actor_id,
                    batch.server_scope_id,
                    batch.scope_revision,
                    batch.identity,
                    tx,
                  )
                : null,
          }
        : {};
    const base = {
      version: this.protocolVersion,
      ...resolved,
      batchRequestId: batch.client_batch_id,
      batchRequestHash: batch.request_hash,
      batchIdentity: batch.identity,
      batchId: batch.state === 'fenced' ? null : batch.id,
      revision: batch.revision,
      serverNow: await this.now(tx),
      orderedMemberIds: batch.ordered_member_ids,
      members,
      retiring: retired,
    };
    if (batch.state === 'fenced' || batch.state === 'terminal') {
      let cleanup: 'confirmed' | 'pending' | 'retained' = 'confirmed';
      // Terminal historical rows are bounded by the per-batch 128 member budget.
      for (const member of all) {
        const status = await this.recovery.status(
          batch.actor_id,
          member.intent_id,
          tx,
        );
        if (status.status !== 'terminal') unavailable();
        if (status.cleanup === 'retained') cleanup = 'retained';
        else if (status.cleanup === 'pending' && cleanup !== 'retained')
          cleanup = 'pending';
      }
      return this.codec.mediaBatchStatusSchema.parse({
        ...base,
        status: 'terminal',
        reason: 'cancelled',
        cleanup,
      });
    }
    if (batch.state === 'consumed' || batch.state === 'sealed') {
      const orderedAssets = members.map((m) => ({
        memberId: m.memberId,
        assetId: m.assetId ?? unavailable(),
        manifestDigest: m.manifestDigest ?? unavailable(),
      }));
      if (
        this.codec.mediaAttachmentPlanDigest(
          batch.id,
          batch.revision,
          orderedAssets,
        ) !== batch.attachment_plan_digest
      )
        unavailable();
      const frozen = {
        ...base,
        publication: batch.publication,
        attachmentPlanDigest: batch.attachment_plan_digest,
        orderedAssets,
      };
      if (batch.state === 'sealed')
        return this.codec.mediaBatchStatusSchema.parse({
          ...frozen,
          status: 'publication_pending',
        });
      const historical = (
        await tx.query<{
          id: string;
          asset_id: string;
          manifest_digest: string;
          ordinal: number;
          owner_kind: string;
          resource_kind: string;
          resource_id: string;
          content_version: string;
        }>(
          `SELECT b.* FROM whaleu_media.bindings b WHERE b.asset_id=ANY($1::uuid[]) ORDER BY b.ordinal LIMIT 10 FOR SHARE`,
          [orderedAssets.map((a) => a.assetId)],
        )
      ).rows;
      if (historical.length !== members.length) unavailable();
      const bindings = members.map((m, ordinal) => {
        const status = m.observation;
        const binding = historical[ordinal];
        if (
          status.status !== 'bound_history' ||
          !same(status.publication, batch.publication) ||
          !binding ||
          binding.id !== status.bindingId ||
          binding.asset_id !== m.assetId ||
          binding.manifest_digest !== m.manifestDigest ||
          binding.ordinal !== ordinal ||
          binding.owner_kind !== 'community' ||
          binding.resource_kind !== batch.consumed_parent?.resourceKind ||
          binding.resource_id !== batch.consumed_parent?.resourceId ||
          Number(binding.content_version) !== 1
        )
          unavailable();
        return {
          memberId: m.memberId,
          assetId: m.assetId,
          manifestDigest: m.manifestDigest,
          bindingId: status.bindingId,
          ordinal,
          attachmentState: status.attachmentState,
        };
      });
      return this.codec.mediaBatchStatusSchema.parse({
        ...frozen,
        status: 'bound_history',
        parent: batch.consumed_parent,
        bindings,
      });
    }
    if (batch.state === 'cancelling')
      return this.codec.mediaBatchStatusSchema.parse({
        ...base,
        status: 'cancelling',
      });
    if (
      members.length &&
      !retired.length &&
      members.every(
        (m) =>
          m.observation.status === 'ready_unbound' &&
          m.assetId &&
          m.manifestDigest,
      )
    ) {
      const ready = members
        .map((m) => m.observation)
        .filter(
          (
            s,
          ): s is Extract<
            MediaStatusV2 | MediaStatusV4,
            { status: 'ready_unbound' }
          > => s.status === 'ready_unbound',
        );
      return this.codec.mediaBatchStatusSchema.parse({
        ...base,
        status: 'ready_unbound',
        orderedAssets: members.map((m) => ({
          memberId: m.memberId,
          assetId: m.assetId,
          manifestDigest: m.manifestDigest,
        })),
        draftExpiresAt: Math.min(...ready.map((r) => r.draftExpiresAt)),
        bindBefore: Math.min(...ready.map((r) => r.bindBefore)),
      });
    }
    if (members.some((m) => m.observation.status === 'unavailable'))
      return this.codec.mediaBatchStatusSchema.parse({
        ...base,
        status: 'unavailable',
        reason: 'MEDIA_UNAVAILABLE',
        retryable: true,
      });
    return this.codec.mediaBatchStatusSchema.parse({
      ...base,
      status: members.some((m) =>
        ['prepared', 'uploaded', 'processing'].includes(m.observation.status),
      )
        ? 'preparing'
        : 'editing',
    });
  }
  private async encodeMember(
    member: Member,
    tx: PoolClient,
  ): Promise<MediaMemberStatus> {
    let observation: MediaStatusV2 | MediaStatusV4;
    try {
      observation = await this.recovery.status(
        member.actor_id,
        member.intent_id,
        tx,
      );
    } catch (error) {
      if (
        !(error instanceof ApplicationError) ||
        error.code !== 'MEDIA_UNAVAILABLE'
      )
        throw error;
      observation = {
        version: this.protocolVersion === 4 ? 4 : 2,
        intentId: member.intent_id,
        requestId: member.client_request_id,
        requestHash: member.request_hash,
        serverNow: await this.now(tx),
        status: 'unavailable',
        reason: 'MEDIA_UNAVAILABLE',
        retryable: true,
      };
    }
    const asset = (
      await tx.query<Asset>(
        'SELECT id,intent_id,manifest_digest,ordinal FROM whaleu_media.assets WHERE intent_id=$1',
        [member.intent_id],
      )
    ).rows[0];
    if (
      asset &&
      (asset.ordinal !== member.source_slot ||
        (member.asset_id && member.asset_id !== asset.id))
    )
      unavailable();
    return this.codec.mediaMemberStatusSchema.parse({
      version: this.protocolVersion,
      batchId: member.batch_id,
      memberId: member.member_id,
      sourceSlot: member.source_slot,
      requestId: member.client_request_id,
      requestHash: member.request_hash,
      intentId: member.intent_id,
      assetId: asset?.id ?? null,
      manifestDigest: asset?.manifest_digest ?? null,
      prepare: {
        clientRequestId: member.client_request_id,
        memberId: member.member_id,
        sourceSlot: member.source_slot,
        declaration: member.declaration,
      },
      observation,
    });
  }
  private internalInput(
    batch: Batch,
    member: {
      clientRequestId: string;
      memberId: string;
      sourceSlot: number;
      declaration: Member['declaration'];
    },
  ): PrepareMediaBatchInput {
    const identity = batch.identity ?? unavailable();
    const input = {
      protocolVersion: this.protocolVersion,
      batchId: batch.id,
      batchIdentity: identity,
      memberId: member.memberId,
      clientRequestId: member.clientRequestId,
      purpose:
        identity.version === 2
          ? identity.target.kind === 'comment'
            ? 'community-comment-image'
            : 'community-reply-image'
          : 'community-post-image',
      draftId: identity.draftId,
      spaceId: identity.spaceId,
      slot: 'images',
      ordinal: member.sourceSlot,
      declaration: member.declaration,
    };
    return this.protocolVersion === 4
      ? prepareMediaV4Schema.parse(input)
      : prepareMediaV3Schema.parse(input);
  }

  private async commandReplay(
    batch: Batch,
    kind: MediaBatchCommandKind,
    input: { commandId: string },
    tx: PoolClient,
  ): Promise<MediaBatchStatus | null> {
    const hash = this.codec.mediaBatchCommandHash(kind, batch.id, input);
    const row = (
      await tx.query<{ request_hash: string; result: unknown }>(
        'SELECT request_hash,result FROM whaleu_media.publication_batch_commands WHERE batch_id=$1 AND command_id=$2',
        [batch.id, input.commandId],
      )
    ).rows[0];
    if (!row) {
      const n = (
        await tx.query<{ n: number }>(
          'SELECT count(*)::integer n FROM whaleu_media.publication_batch_commands WHERE batch_id=$1',
          [batch.id],
        )
      ).rows[0]?.n;
      if (n === undefined || n >= this.codec.MEDIA_BATCH_LIMITS.commands)
        unavailable();
      return null;
    }
    if (row.request_hash !== hash) conflict();
    return this.codec.mediaBatchStatusSchema.parse(row.result);
  }
  private async recordCommand(
    batch: Batch,
    kind: MediaBatchCommandKind,
    input: { commandId: string; expectedRevision: string },
    result: MediaBatchStatus,
    tx: PoolClient,
    checkpoint: ReturnType<typeof checkpointTransactionDeadlines>,
  ): Promise<MediaBatchStatus> {
    await tx.query(
      `INSERT INTO whaleu_media.publication_batch_commands(batch_id,command_id,request_hash,kind,expected_revision,result_revision,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        batch.id,
        input.commandId,
        this.codec.mediaBatchCommandHash(kind, batch.id, input),
        kind,
        input.expectedRevision,
        result.revision,
        JSON.stringify(result),
      ],
    );
    // Command persistence is itself a Media writer. Discard only the temporary
    // pre-write observations, then revalidate the entire response set/deadlines
    // against the final epoch. Owner/session proofs from before checkpoint stay.
    restoreTransactionDeadlines(tx, checkpoint);
    const verified = await this.encode(
      await this.byId(batch.actor_id, batch.id, tx),
      tx,
    );
    if (
      verified.status !== result.status ||
      verified.members.length !== result.members.length ||
      verified.members.some(
        (m, i) =>
          m.observation.status !== result.members[i]?.observation.status ||
          m.assetId !== result.members[i]?.assetId ||
          m.manifestDigest !== result.members[i]?.manifestDigest,
      )
    )
      unavailable();
    await this.proof.capture(tx);
    return result;
  }
  private async members(id: string, tx: PoolClient): Promise<Member[]> {
    return (
      await tx.query<Member>(
        'SELECT * FROM whaleu_media.publication_batch_members WHERE batch_id=$1 ORDER BY intent_id LIMIT 129',
        [id],
      )
    ).rows;
  }
  private async lockMembers(
    id: string,
    tx: PoolClient,
    write: boolean,
  ): Promise<Member[]> {
    const members = await this.members(id, tx);
    if (members.length > 128) unavailable();
    const ids = members.map((m) => m.intent_id);
    await tx.query(
      `SELECT id FROM whaleu_media.upload_intents WHERE id=ANY($1::uuid[]) ORDER BY id FOR ${write ? 'UPDATE' : 'SHARE'}`,
      [ids],
    );
    await tx.query(
      `SELECT id FROM whaleu_media.assets WHERE intent_id=ANY($1::uuid[]) ORDER BY id FOR ${write ? 'UPDATE' : 'SHARE'}`,
      [ids],
    );
    return members;
  }
  private async memberAssets(
    members: readonly Member[],
    tx: PoolClient,
  ): Promise<Asset[]> {
    return (
      await tx.query<Asset>(
        'SELECT id,intent_id,manifest_digest,ordinal FROM whaleu_media.assets WHERE intent_id=ANY($1::uuid[]) ORDER BY id',
        [members.map((m) => m.intent_id)],
      )
    ).rows;
  }
  private async byId(
    actor: string,
    id: string,
    tx: PoolClient,
    write = false,
  ): Promise<Batch> {
    this.managed(tx);
    return this.assertProtocol(
      (
        await tx.query<Batch>(
          `SELECT * FROM whaleu_media.publication_batches WHERE id=$1 AND actor_id=$2 FOR ${write ? 'UPDATE' : 'SHARE'}`,
          [mediaV2IdSchema.parse(id), actor],
        )
      ).rows[0] ?? unavailable(),
    );
  }
  private async byRequest(
    actor: string,
    id: string,
    tx: PoolClient,
    write = false,
  ): Promise<Batch | undefined> {
    this.managed(tx);
    const row = (
      await tx.query<Batch>(
        `SELECT * FROM whaleu_media.publication_batches WHERE actor_id=$1 AND client_batch_id=$2 FOR ${write ? 'UPDATE' : 'SHARE'}`,
        [actor, id],
      )
    ).rows[0];
    return row ? this.assertProtocol(row) : undefined;
  }

  private async reserveBatch(actor: string, tx: PoolClient): Promise<void> {
    await lockMediaActor(actor, tx);
    const count = (
      await tx.query<{ n: number }>(
        "SELECT count(*)::integer n FROM whaleu_media.publication_batches WHERE actor_id=$1 AND created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
        [actor],
      )
    ).rows[0]?.n;
    if (
      count === undefined ||
      count >= this.codec.MEDIA_BATCH_LIMITS.dailyBatches
    )
      throw new ApplicationError('MEDIA_RATE_LIMITED');
  }
  private async keyLock(
    actor: string,
    id: string,
    tx: PoolClient,
  ): Promise<void> {
    this.managed(tx);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `whaleu:media-batch-request:v1:${actor}:${id}`,
    ]);
  }
  private nextRevision(batch: Batch): string {
    return (BigInt(batch.revision) + 1n).toString();
  }
  private managed(tx: PoolClient): void {
    if (!transactionReadEpoch(tx)) unavailable();
  }
  private async now(tx: PoolClient): Promise<number> {
    this.managed(tx);
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]?.now.getTime();
    if (!now || !Number.isSafeInteger(now)) unavailable();
    return now!;
  }
}
