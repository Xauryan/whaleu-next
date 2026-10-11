import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { MediaAssetRepository } from './asset-repository.js';
import type { AssetRow } from './asset-repository.js';
import { MediaOwnerProofRegistry } from './owner-proof.js';
import { SchoolQrMediaRequiredProof } from './school-qr-required-proof.js';
import type {
  SchoolQrOwnerProofRegistry,
  SchoolQrReadProof,
  SchoolQrReadRequest,
} from './school-qr-owner-proof.js';
import type { MediaVariantName } from './contracts.js';
import type { ExactMediaDeliveryPlan } from './delivery.js';
import {
  schoolQrDescriptorSchema,
  SCHOOL_QR_MEDIA_PROTOCOL,
} from './contracts-school-qr.js';
import type { SchoolQrEntryKey } from './contracts-school-qr.js';
import { MediaLifecycleRepository } from './lifecycle-repository.js';
export interface SchoolQrMutation {
  readonly actorAccountId: string;
  readonly regionId: string;
  readonly entryKey: SchoolQrEntryKey;
  readonly expectedRevision: number;
  readonly currentBindingId: string | null;
  readonly action: 'keep' | 'remove' | 'replace';
  readonly assetId?: string;
}
export class SchoolQrMediaAssetRepository extends MediaAssetRepository {
  protected override readonly proof = new SchoolQrMediaRequiredProof();
  constructor(private readonly schoolOwners: SchoolQrOwnerProofRegistry) {
    super(new MediaOwnerProofRegistry([]));
  }
  /** Caller holds current school management + original entry CAS before Media locks.
   * Deferred typed9 triggers require the owner publication to finish atomically. */
  async mutate(
    input: SchoolQrMutation,
    tx: PoolClient,
  ): Promise<string | null> {
    this.managed(tx);
    if (input.action === 'keep') return input.currentBindingId;
    const old = input.currentBindingId
      ? (
          await tx.query<{ asset_id: string; intent_id: string }>(
            `SELECT b.asset_id,a.intent_id FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_school_configuration.qr_appearances p ON p.binding_id=b.id
   WHERE b.id=$1 AND b.owner_kind='school_configuration' AND b.resource_kind='entry_qr' AND b.detached_at IS NULL AND p.region_id=$2 AND p.entry_key=$3`,
            [input.currentBindingId, input.regionId, input.entryKey],
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
        !this.schoolAsset(row) ||
        row.protocol_version !== 9 ||
        row.actor_id !== input.actorAccountId
      )
        throw new ApplicationError('MEDIA_NOT_READY');
      const scope = (
        await tx.query<{ expires_at: Date }>(
          `SELECT expires_at FROM whaleu_school_configuration.qr_upload_scopes WHERE id=$1 AND actor_id=$2 AND scope_revision=$3 AND region_id=$4 AND entry_key=$5 AND expected_revision=$6`,
          [
            row.resource_id,
            input.actorAccountId,
            row.scope_revision,
            input.regionId,
            input.entryKey,
            input.expectedRevision,
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
        `INSERT INTO whaleu_media.scope_consumptions(actor_id,owner_kind,resource_kind,scope_resource_id,scope_revision,resource_id,content_version,attach_evidence) VALUES($1,'school_configuration','entry_qr',$2,$3,$4,1,$5::jsonb)`,
        [
          input.actorAccountId,
          row.resource_id,
          row.scope_revision,
          appearanceId,
          JSON.stringify({
            version: 9,
            assets: [{ assetId: row.id, digest: row.manifest_digest }],
          }),
        ],
      );
      await tx.query(
        `INSERT INTO whaleu_media.bindings(id,asset_id,manifest_digest,owner_kind,resource_kind,resource_id,content_version,slot,ordinal,attach_evidence) VALUES($1,$2,$3,'school_configuration','entry_qr',$4,1,'qr',0,$5::jsonb)`,
        [
          bindingId,
          row.id,
          row.manifest_digest,
          appearanceId,
          JSON.stringify({
            version: 9,
            scopeId: row.resource_id,
            scopeRevision: row.scope_revision,
          }),
        ],
      );
      await tx.query(
        `INSERT INTO whaleu_school_configuration.qr_appearances(id,region_id,entry_key,actor_id,asset_id,manifest_digest,binding_id,entry_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          appearanceId,
          input.regionId,
          input.entryKey,
          input.actorAccountId,
          row.id,
          row.manifest_digest,
          bindingId,
          input.expectedRevision + 1,
        ],
      );
    }
    if (old) {
      await tx.query(
        `INSERT INTO whaleu_school_configuration.qr_retirements(binding_id,actor_id,region_id,entry_key,entry_revision) VALUES($1,$2,$3,$4,$5)`,
        [
          input.currentBindingId,
          input.actorAccountId,
          input.regionId,
          input.entryKey,
          input.expectedRevision + 1,
        ],
      );
      await tx.query(
        `UPDATE whaleu_media.bindings SET detached_at=clock_timestamp(),detach_reason='school-configuration-qr-replaced' WHERE id=$1 AND detached_at IS NULL`,
        [input.currentBindingId],
      );
      await new MediaLifecycleRepository().detachedOwnerIntent(
        old.intent_id,
        tx,
      );
    }
    await this.proof.capture(tx);
    return bindingId;
  }
  async describe(
    proof: SchoolQrReadProof,
    request: SchoolQrReadRequest,
    tx: PoolClient,
  ) {
    const { authority, manifest } = await this.read(proof, request, tx);
    return schoolQrDescriptorSchema.parse({
      ...authority.reference,
      protocol: SCHOOL_QR_MEDIA_PROTOCOL,
      kind: 'school-configuration-qr',
      width: manifest.variants[1].width,
      height: manifest.variants[1].height,
      variants: ['thumb-v1', 'display-v1'],
    });
  }
  async plan(
    proof: SchoolQrReadProof,
    request: SchoolQrReadRequest,
    variant: MediaVariantName,
    tx: PoolClient,
  ): Promise<
    ExactMediaDeliveryPlan & {
      principal: ReturnType<SchoolQrOwnerProofRegistry['require']>['principal'];
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
        .update('whaleu-school-qr-delivery:v1\n')
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
    proof: SchoolQrReadProof,
    request: SchoolQrReadRequest,
    tx: PoolClient,
  ) {
    this.managed(tx);
    const authority = this.schoolOwners.require(proof, request, tx);
    await this.proof.capture(tx);
    await this.lockIntents([authority.assetId], tx, 'read');
    const row = (
      await tx.query<
        AssetRow & { protocol_version: number; binding_digest: string }
      >(
        `SELECT a.*,i.protocol_version,b.manifest_digest binding_digest FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id JOIN whaleu_media.bindings b ON b.asset_id=a.id
    WHERE a.id=$1 AND b.id=$2 AND b.resource_id=$3 AND b.owner_kind='school_configuration' AND b.resource_kind='entry_qr' AND b.slot='qr' AND b.ordinal=0 AND b.content_version=1 AND b.detached_at IS NULL FOR SHARE OF a,b NOWAIT`,
        [
          authority.assetId,
          authority.reference.bindingId,
          authority.appearanceId,
        ],
      )
    ).rows[0];
    if (
      !row ||
      !this.schoolAsset(row) ||
      row.protocol_version !== 9 ||
      row.manifest_digest !== authority.manifestDigest ||
      row.binding_digest !== authority.manifestDigest
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return { authority, row, manifest: await this.current(row, tx) };
  }
  private schoolAsset(row: AssetRow): boolean {
    return (
      row.owner_kind === 'school_configuration' &&
      row.resource_kind === 'entry_qr' &&
      row.target_kind === 'edit' &&
      row.content_version === '1' &&
      row.audience === 'school-config-gated' &&
      row.purpose === 'school-configuration-qr-image' &&
      row.slot === 'qr' &&
      row.ordinal === 0
    );
  }
}
