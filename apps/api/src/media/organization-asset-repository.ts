import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { MediaAssetRepository } from './asset-repository.js';
import type { AssetRow } from './asset-repository.js';
import { MediaOwnerProofRegistry } from './owner-proof.js';
import { OrganizationMediaRequiredProof } from './organization-required-proof.js';
import type {
  OrganizationOwnerProofRegistry,
  OrganizationReadProof,
  OrganizationReadRequest,
} from './organization-owner-proof.js';
import type { MediaVariantName } from './contracts.js';
import type { ExactMediaDeliveryPlan } from './delivery.js';
import {
  organizationDescriptorSchema,
  organizationMediaSlotSchema,
  ORGANIZATION_MEDIA_PROTOCOL,
} from './contracts-organization.js';
import type { OrganizationMediaSlot } from './contracts-organization.js';
import { MediaLifecycleRepository } from './lifecycle-repository.js';
export interface OrganizationMutation {
  readonly actorAccountId: string;
  readonly organizationId: string;
  readonly slot: OrganizationMediaSlot;
  readonly applicationRevision: number;
  readonly currentBindingId: string | null;
  readonly action: 'keep' | 'remove' | 'replace';
  readonly assetId?: string;
  readonly authorityVersion: string;
}
export class OrganizationMediaAssetRepository extends MediaAssetRepository {
  protected override readonly proof = new OrganizationMediaRequiredProof();
  constructor(
    private readonly organizationOwners: OrganizationOwnerProofRegistry,
  ) {
    super(new MediaOwnerProofRegistry([]));
  }
  /** Caller holds current organization role + original application CAS before Media locks.
   * Deferred typed10 triggers require the owner publication to finish atomically. */
  async mutateMany(
    inputs: readonly OrganizationMutation[],
    tx: PoolClient,
  ): Promise<Partial<Record<OrganizationMediaSlot, string | null>>> {
    this.managed(tx);
    if (
      inputs.length > 13 ||
      new Set(inputs.map((v) => v.slot)).size !== inputs.length
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const oldIds = inputs.flatMap((v) =>
      v.currentBindingId ? [v.currentBindingId] : [],
    );
    const old = (
      await tx.query<{ asset_id: string }>(
        'SELECT asset_id FROM whaleu_media.bindings WHERE id=ANY($1::uuid[])',
        [oldIds],
      )
    ).rows;
    const ids = [
      ...new Set([
        ...old.map((v) => v.asset_id),
        ...inputs.flatMap((v) =>
          v.action === 'replace' && v.assetId ? [v.assetId] : [],
        ),
      ]),
    ].sort();
    await this.lockIntents(ids, tx, 'write');
    await tx.query(
      'SELECT id FROM whaleu_media.assets WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
      [ids],
    );
    await tx.query(
      'SELECT id FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
      [ids],
    );
    const result: Partial<Record<OrganizationMediaSlot, string | null>> = {};
    for (const input of inputs)
      result[input.slot] = await this.mutateSlot(input, tx);
    // One final epoch after the entire owner set. Earlier slot writes must not
    // leave stale required facts, and later external Media writes still fail.
    await this.proof.capture(tx);
    return result;
  }
  private async mutateSlot(
    input: OrganizationMutation,
    tx: PoolClient,
  ): Promise<string | null> {
    this.managed(tx);
    if (input.action === 'keep') {
      if (input.currentBindingId)
        await this.currentBinding(
          input.organizationId,
          input.slot,
          input.currentBindingId,
          tx,
          false,
        );
      return input.currentBindingId;
    }
    const old = input.currentBindingId
      ? (
          await tx.query<{ asset_id: string; intent_id: string }>(
            `SELECT b.asset_id,a.intent_id FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_organizations.media_appearances p ON p.binding_id=b.id
   WHERE b.id=$1 AND b.owner_kind='organizations' AND b.resource_kind='organization_image' AND b.detached_at IS NULL AND p.organization_id=$2 AND p.slot=$3`,
            [input.currentBindingId, input.organizationId, input.slot],
          )
        ).rows[0]
      : null;
    if (input.currentBindingId && !old)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const ids = [
      ...(old ? [old.asset_id] : []),
      ...(input.action === 'replace' && input.assetId ? [input.assetId] : []),
    ].sort();
    if (
      new Set(ids).size !== ids.length ||
      (input.action === 'replace' && !input.assetId)
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    await this.lockIntents(ids, tx, 'write');
    const rows = (
      await tx.query<AssetRow & { protocol_version: number }>(
        `SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=ANY($1::uuid[]) ORDER BY a.id FOR UPDATE OF a NOWAIT`,
        [ids],
      )
    ).rows;
    if (rows.length !== ids.length)
      throw new ApplicationError('MEDIA_NOT_READY');
    await tx.query(
      'SELECT id FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
      [ids],
    );
    let bindingId: string | null = null;
    if (input.action === 'replace') {
      const row = rows.find((r) => r.id === input.assetId);
      if (
        !row ||
        !this.organizationAsset(row) ||
        row.protocol_version !== 10 ||
        row.actor_id !== input.actorAccountId ||
        row.slot !== input.slot
      )
        throw new ApplicationError('MEDIA_NOT_READY');
      const scope = (
        await tx.query<{ expires_at: Date }>(
          `SELECT expires_at FROM whaleu_organizations.media_upload_scopes WHERE id=$1 AND actor_id=$2 AND scope_revision=$3 AND organization_id=$4 AND slot=$5 AND application_revision=$6 AND authority_version=$7`,
          [
            row.resource_id,
            input.actorAccountId,
            row.scope_revision,
            input.organizationId,
            input.slot,
            input.applicationRevision,
            input.authorityVersion,
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
      bindingId = randomUUID();
      const appearanceId = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_media.scope_consumptions(actor_id,owner_kind,resource_kind,scope_resource_id,scope_revision,resource_id,content_version,attach_evidence) VALUES($1,'organizations','organization_image',$2,$3,$4,1,$5::jsonb)`,
        [
          input.actorAccountId,
          row.resource_id,
          row.scope_revision,
          appearanceId,
          JSON.stringify({
            version: 10,
            assets: [{ assetId: row.id, digest: row.manifest_digest }],
          }),
        ],
      );
      await tx.query(
        `INSERT INTO whaleu_media.bindings(id,asset_id,manifest_digest,owner_kind,resource_kind,resource_id,content_version,slot,ordinal,attach_evidence) VALUES($1,$2,$3,'organizations','organization_image',$4,1,$6,0,$5::jsonb)`,
        [
          bindingId,
          row.id,
          row.manifest_digest,
          appearanceId,
          JSON.stringify({
            version: 10,
            scopeId: row.resource_id,
            scopeRevision: row.scope_revision,
          }),
          input.slot,
        ],
      );
      await tx.query(
        `INSERT INTO whaleu_organizations.media_appearances(id,organization_id,slot,actor_id,asset_id,manifest_digest,binding_id,application_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          appearanceId,
          input.organizationId,
          input.slot,
          input.actorAccountId,
          row.id,
          row.manifest_digest,
          bindingId,
          input.applicationRevision + 1,
        ],
      );
    }
    if (old) {
      await tx.query(
        `INSERT INTO whaleu_organizations.media_retirements(binding_id,actor_id,organization_id,slot,application_revision) VALUES($1,$2,$3,$4,$5)`,
        [
          input.currentBindingId,
          input.actorAccountId,
          input.organizationId,
          input.slot,
          input.applicationRevision + 1,
        ],
      );
      await tx.query(
        `UPDATE whaleu_media.bindings SET detached_at=clock_timestamp(),detach_reason='organization-media-replaced' WHERE id=$1 AND detached_at IS NULL`,
        [input.currentBindingId],
      );
      await new MediaLifecycleRepository().detachedOwnerIntent(
        old.intent_id,
        tx,
      );
    }
    return bindingId;
  }
  async describe(
    proof: OrganizationReadProof,
    request: OrganizationReadRequest,
    tx: PoolClient,
  ) {
    const { authority, manifest } = await this.read(proof, request, tx);
    return organizationDescriptorSchema.parse({
      ...authority.reference,
      protocol: ORGANIZATION_MEDIA_PROTOCOL,
      kind: 'organization-media',
      width: manifest.variants[1].width,
      height: manifest.variants[1].height,
      variants: ['thumb-v1', 'display-v1'],
    });
  }
  async plan(
    proof: OrganizationReadProof,
    request: OrganizationReadRequest,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<
    ExactMediaDeliveryPlan & {
      principal: ReturnType<
        OrganizationOwnerProofRegistry['require']
      >['principal'];
    }
  > {
    const { authority, row, manifest } = await this.read(proof, request, tx),
      object = manifest.variants.find((v) => v.name === variant);
    const head = (
      await tx.query(
        'SELECT revision::text,event_id FROM whaleu_media.asset_safety_heads WHERE asset_id=$1',
        [row.id],
      )
    ).rows[0];
    if (!object || !head) throw new ApplicationError('MEDIA_UNAVAILABLE');
    return Object.freeze({
      object: object.object,
      sha256: object.sha256,
      bytes: object.bytes,
      mime: object.mime,
      principal: authority.principal,
      attachmentSetRevision: createHash('sha256')
        .update('whaleu-organization-delivery:v1\n')
        .update(
          JSON.stringify({
            reference: authority.reference,
            ownerRevision: authority.ownerRevision,
            manifestDigest: row.manifest_digest,
            head,
            variant,
            principal: authority.principal,
          }),
        )
        .digest('hex'),
    });
  }
  private async read(
    proof: OrganizationReadProof,
    request: OrganizationReadRequest,
    tx: PoolClient,
  ) {
    this.managed(tx);
    const authority = this.organizationOwners.require(proof, request, tx);
    await this.proof.capture(tx);
    await this.lockIntents([authority.assetId], tx, 'read');
    const row = (
      await tx.query<
        AssetRow & { protocol_version: number; binding_digest: string }
      >(
        `SELECT a.*,i.protocol_version,b.manifest_digest binding_digest FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id JOIN whaleu_media.bindings b ON b.asset_id=a.id
    WHERE a.id=$1 AND b.id=$2 AND b.resource_id=$3 AND b.owner_kind='organizations' AND b.resource_kind='organization_image' AND b.slot=$4 AND b.ordinal=0 AND b.content_version=1 AND b.detached_at IS NULL FOR SHARE OF a,b NOWAIT`,
        [
          authority.assetId,
          authority.reference.bindingId,
          authority.appearanceId,
          authority.reference.slot,
        ],
      )
    ).rows[0];
    if (
      !row ||
      !this.organizationAsset(row) ||
      row.protocol_version !== 10 ||
      row.manifest_digest !== authority.manifestDigest ||
      row.binding_digest !== authority.manifestDigest
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return { authority, row, manifest: await this.current(row, tx) };
  }
  requireCurrentBinding(
    organizationId: string,
    slot: OrganizationMediaSlot,
    bindingId: string,
    tx: PoolClient,
  ): Promise<void> {
    return this.currentBinding(organizationId, slot, bindingId, tx, true);
  }
  private async currentBinding(
    organizationId: string,
    slot: OrganizationMediaSlot,
    bindingId: string,
    tx: PoolClient,
    capture: boolean,
  ): Promise<void> {
    this.managed(tx);
    const found = (
      await tx.query<{ asset_id: string }>(
        `SELECT b.asset_id FROM whaleu_media.bindings b JOIN whaleu_organizations.media_appearances p ON p.binding_id=b.id WHERE b.id=$1 AND p.organization_id=$2 AND p.slot=$3 AND b.detached_at IS NULL`,
        [bindingId, organizationId, slot],
      )
    ).rows[0];
    if (!found) throw new ApplicationError('MEDIA_NOT_READY');
    if (capture) await this.proof.capture(tx);
    await this.lockIntents([found.asset_id], tx, 'read');
    const row = (
      await tx.query<AssetRow & { protocol_version: number }>(
        `SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id JOIN whaleu_media.bindings b ON b.asset_id=a.id JOIN whaleu_organizations.media_appearances p ON p.binding_id=b.id WHERE b.id=$1 AND p.organization_id=$2 AND p.slot=$3 AND b.owner_kind='organizations' AND b.resource_kind='organization_image' AND b.slot=$3 AND b.resource_id=p.id AND b.manifest_digest=a.manifest_digest AND p.manifest_digest=a.manifest_digest AND b.detached_at IS NULL FOR SHARE OF a,b NOWAIT`,
        [bindingId, organizationId, slot],
      )
    ).rows[0];
    if (
      !row ||
      !this.organizationAsset(row) ||
      row.protocol_version !== 10 ||
      row.slot !== slot
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    await this.current(row, tx);
  }
  private organizationAsset(row: AssetRow): boolean {
    return (
      row.owner_kind === 'organizations' &&
      row.resource_kind === 'organization_image' &&
      row.target_kind === 'edit' &&
      row.content_version === '1' &&
      row.audience === 'organization-gated' &&
      row.purpose === 'organization-image' &&
      organizationMediaSlotSchema.safeParse(row.slot).success &&
      row.ordinal === 0
    );
  }
}
