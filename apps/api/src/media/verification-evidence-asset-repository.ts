import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { MediaAssetRepository } from './asset-repository.js';
import type { AssetRow } from './asset-repository.js';
import { MediaOwnerProofRegistry } from './owner-proof.js';
import { VerificationEvidenceMediaRequiredProof } from './verification-evidence-required-proof.js';
import type {
  VerificationEvidenceOwnerProofRegistry,
  VerificationEvidenceReadProof,
  VerificationEvidenceReadRequest,
} from './verification-evidence-owner-proof.js';
import type { MediaVariantName } from './contracts.js';
import {
  verificationEvidenceDescriptorSchema,
  VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
} from './contracts-verification-evidence.js';
import { MediaLifecycleRepository } from './lifecycle-repository.js';
export interface VerificationEvidenceFact {
  readonly bindingId: string;
  readonly assetId: string;
  readonly manifestDigest: string;
  readonly expiresAt: number;
  readonly policyRef: string;
}
export interface VerificationEvidenceRetirement {
  readonly applicationId: string;
  readonly bindingId: string;
}
export const VERIFICATION_EVIDENCE_RETIREMENT_BATCH_LIMIT = 50;
interface BindingRow {
  binding_id: string;
  application_id: string;
  revision: string;
  actor_id: string;
  asset_id: string;
  manifest_digest: string;
  evidence_expires_at: Date;
  evidence_policy_ref: string;
}
/** Private owner namespace only. No public owner binding can be accepted here. */
export class VerificationEvidenceAssetRepository extends MediaAssetRepository {
  protected override readonly proof =
    new VerificationEvidenceMediaRequiredProof();
  constructor(
    private readonly evidenceOwners: VerificationEvidenceOwnerProofRegistry,
  ) {
    super(new MediaOwnerProofRegistry([]));
  }
  async acceptAndBind(
    actor: string,
    applicationId: string,
    revision: number,
    assetId: string,
    authorityVersion: string,
    tx: PoolClient,
  ): Promise<VerificationEvidenceFact> {
    this.managed(tx);
    await this.lockIntents([assetId], tx, 'write');
    const row = (
      await tx.query<AssetRow & { protocol_version: number }>(
        'SELECT a.*,i.protocol_version FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE a.id=$1 FOR UPDATE OF a NOWAIT',
        [assetId],
      )
    ).rows[0];
    if (
      !row ||
      !this.isEvidence(row) ||
      row.protocol_version !== 13 ||
      row.actor_id !== actor
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = (
      await tx.query<{
        expires_at: Date;
        evidence_expires_at: Date;
        evidence_policy_ref: string;
      }>(
        `SELECT expires_at,evidence_expires_at,evidence_policy_ref FROM whaleu_media.verification_evidence_scopes WHERE id=$1 AND actor_id=$2 AND scope_revision=$3 AND application_id=$4 AND revision=$5 AND authority_version=$6 FOR SHARE NOWAIT`,
        [
          row.resource_id,
          actor,
          row.scope_revision,
          applicationId,
          revision,
          authorityVersion,
        ],
      )
    ).rows[0];
    if (
      !scope ||
      (
        await tx.query(
          'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
          [assetId],
        )
      ).rowCount
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      Math.min(scope.expires_at.getTime(), scope.evidence_expires_at.getTime()),
      'MEDIA_UNAVAILABLE',
    );
    await this.requireRetention(row, tx);
    await this.current(row, tx);
    const bindingId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_media.scope_consumptions(actor_id,owner_kind,resource_kind,scope_resource_id,scope_revision,resource_id,content_version,attach_evidence) VALUES($1,'verification','student_evidence',$2,$3,$4,1,$5::jsonb)`,
      [
        actor,
        row.resource_id,
        row.scope_revision,
        applicationId,
        JSON.stringify({
          version: 13,
          assets: [{ assetId: row.id, digest: row.manifest_digest }],
        }),
      ],
    );
    await tx.query(
      `INSERT INTO whaleu_media.bindings(id,asset_id,manifest_digest,owner_kind,resource_kind,resource_id,content_version,slot,ordinal,attach_evidence) VALUES($1,$2,$3,'verification','student_evidence',$4,1,'evidence',0,$5::jsonb)`,
      [
        bindingId,
        row.id,
        row.manifest_digest,
        applicationId,
        JSON.stringify({
          version: 13,
          scopeId: row.resource_id,
          scopeRevision: row.scope_revision,
        }),
      ],
    );
    await tx.query(
      `INSERT INTO whaleu_media.verification_evidence_bindings(binding_id,application_id,revision,actor_id,asset_id,manifest_digest,evidence_expires_at,evidence_policy_ref) SELECT $1,$2,$3,$4,$5,$6,s.evidence_expires_at,s.evidence_policy_ref FROM whaleu_media.verification_evidence_scopes s WHERE s.id=$7`,
      [
        bindingId,
        applicationId,
        revision,
        actor,
        row.id,
        row.manifest_digest,
        row.resource_id,
      ],
    );
    await this.proof.capture(tx);
    return Object.freeze({
      bindingId,
      assetId: row.id,
      manifestDigest: row.manifest_digest,
      expiresAt: scope.evidence_expires_at.getTime(),
      policyRef: scope.evidence_policy_ref,
    });
  }
  async requireCurrentBinding(
    applicationId: string,
    revision: number,
    bindingId: string,
    tx: PoolClient,
  ) {
    const { binding, row } = await this.currentBinding(
      applicationId,
      revision,
      bindingId,
      tx,
    );
    const manifest = await this.current(row, tx);
    await this.proof.capture(tx);
    return Object.freeze({
      ...this.fact(binding),
      descriptor: verificationEvidenceDescriptorSchema.parse({
        protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
        kind: 'verification-evidence',
        applicationId,
        revision,
        bindingId,
        width: manifest.variants[1].width,
        height: manifest.variants[1].height,
        variants: ['thumb-v1', 'display-v1'],
      }),
    });
  }
  async describe(
    proof: VerificationEvidenceReadProof,
    request: VerificationEvidenceReadRequest,
    tx: PoolClient,
  ) {
    const { authority, manifest } = await this.read(proof, request, tx);
    return verificationEvidenceDescriptorSchema.parse({
      ...authority.reference,
      protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
      kind: 'verification-evidence',
      width: manifest.variants[1].width,
      height: manifest.variants[1].height,
      variants: ['thumb-v1', 'display-v1'],
    });
  }
  async plan(
    proof: VerificationEvidenceReadProof,
    request: VerificationEvidenceReadRequest,
    variant: MediaVariantName,
    tx: PoolClient,
  ) {
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
        .update('whaleu-verification-evidence-delivery:v1\n')
        .update(
          JSON.stringify({
            reference: authority.reference,
            ownerRevision: authority.ownerRevision,
            manifestDigest: row.manifest_digest,
            head,
            variant,
            principal: authority.principal,
            expiresAt: authority.expiresAt,
            policyRef: authority.policyRef,
          }),
        )
        .digest('hex'),
    });
  }
  async retireEvidence(
    applicationId: string,
    bindingId: string,
    tx: PoolClient,
  ): Promise<void> {
    return this.retireEvidenceBatch([{ applicationId, bindingId }], tx);
  }
  /** All writes must precede the one final epoch fact. Capturing after each
   * item would invalidate earlier facts through this transaction's own writes. */
  async retireEvidenceBatch(
    references: readonly VerificationEvidenceRetirement[],
    tx: PoolClient,
  ): Promise<void> {
    if (
      !Array.isArray(references) ||
      references.length > VERIFICATION_EVIDENCE_RETIREMENT_BATCH_LIMIT ||
      new Set(references.map((item) => item.bindingId)).size !==
        references.length
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (!references.length) return;
    this.managed(tx);
    const items = references.map(({ applicationId, bindingId }) => ({
      applicationId,
      bindingId,
    }));
    for (const item of items)
      await this.retireExactEvidence(item.applicationId, item.bindingId, tx);
    await this.proof.capture(tx);
  }
  private async retireExactEvidence(
    applicationId: string,
    bindingId: string,
    tx: PoolClient,
  ): Promise<void> {
    const value = (
      await tx.query<{
        asset_id: string;
        intent_id: string;
        detached_at: Date | null;
      }>(
        `SELECT b.asset_id,a.intent_id,b.detached_at FROM whaleu_media.verification_evidence_bindings e JOIN whaleu_media.bindings b ON b.id=e.binding_id JOIN whaleu_media.assets a ON a.id=b.asset_id WHERE e.application_id=$1 AND e.binding_id=$2`,
        [applicationId, bindingId],
      )
    ).rows[0];
    if (!value) throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (value.detached_at) return;
    await this.lockIntents([value.asset_id], tx, 'write');
    await tx.query(
      'SELECT id FROM whaleu_media.bindings WHERE id=$1 FOR UPDATE NOWAIT',
      [bindingId],
    );
    await tx.query(
      'INSERT INTO whaleu_media.verification_evidence_retirements(binding_id,application_id) VALUES($1,$2)',
      [bindingId, applicationId],
    );
    await tx.query(
      `UPDATE whaleu_media.bindings SET detached_at=clock_timestamp(),detach_reason='verification-evidence-expired' WHERE id=$1 AND detached_at IS NULL`,
      [bindingId],
    );
    await new MediaLifecycleRepository().detachedOwnerIntent(
      value.intent_id,
      tx,
    );
  }
  private async read(
    proof: VerificationEvidenceReadProof,
    request: VerificationEvidenceReadRequest,
    tx: PoolClient,
  ) {
    const authority = this.evidenceOwners.require(proof, request, tx);
    const { binding, row } = await this.currentBinding(
      request.reference.applicationId,
      request.reference.revision,
      request.reference.bindingId,
      tx,
    );
    if (
      row.actor_id !== authority.actorAccountId ||
      row.id !== authority.assetId ||
      row.manifest_digest !== authority.manifestDigest ||
      binding.evidence_expires_at.getTime() !== authority.expiresAt ||
      binding.evidence_policy_ref !== authority.policyRef
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const manifest = await this.current(row, tx);
    await this.proof.capture(tx);
    return { authority, row, manifest };
  }
  private async currentBinding(
    applicationId: string,
    revision: number,
    bindingId: string,
    tx: PoolClient,
  ) {
    this.managed(tx);
    const binding = (
      await tx.query<BindingRow>(
        'SELECT * FROM whaleu_media.verification_evidence_bindings WHERE binding_id=$1 AND application_id=$2 AND revision=$3 FOR SHARE NOWAIT',
        [bindingId, applicationId, revision],
      )
    ).rows[0];
    if (!binding) throw new ApplicationError('MEDIA_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      binding.evidence_expires_at.getTime(),
      'MEDIA_UNAVAILABLE',
    );
    await this.lockIntents([binding.asset_id], tx, 'read');
    const row = (
      await tx.query<
        AssetRow & { protocol_version: number; binding_digest: string }
      >(
        `SELECT a.*,i.protocol_version,b.manifest_digest binding_digest FROM whaleu_media.assets a JOIN whaleu_media.upload_intents i ON i.id=a.intent_id JOIN whaleu_media.bindings b ON b.asset_id=a.id WHERE a.id=$1 AND b.id=$2 AND b.resource_id=$3 AND b.owner_kind='verification' AND b.resource_kind='student_evidence' AND b.slot='evidence' AND b.content_version=1 AND b.ordinal=0 AND b.detached_at IS NULL FOR SHARE OF a,b NOWAIT`,
        [binding.asset_id, bindingId, applicationId],
      )
    ).rows[0];
    if (
      !row ||
      !this.isEvidence(row) ||
      row.protocol_version !== 13 ||
      row.actor_id !== binding.actor_id ||
      row.manifest_digest !== binding.manifest_digest ||
      row.binding_digest !== binding.manifest_digest
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return { binding, row };
  }
  private fact(binding: BindingRow): VerificationEvidenceFact {
    return Object.freeze({
      bindingId: binding.binding_id,
      assetId: binding.asset_id,
      manifestDigest: binding.manifest_digest,
      expiresAt: binding.evidence_expires_at.getTime(),
      policyRef: binding.evidence_policy_ref,
    });
  }
  private isEvidence(row: AssetRow) {
    return (
      row.owner_kind === 'verification' &&
      row.resource_kind === 'student_evidence' &&
      row.target_kind === 'edit' &&
      Number(row.content_version) === 1 &&
      row.audience === 'verification-private' &&
      row.purpose === 'verification-evidence-image' &&
      row.slot === 'evidence' &&
      row.ordinal === 0
    );
  }
}
