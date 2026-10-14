import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  digest,
  limits,
  type AudienceKind,
  type Program,
} from './contracts.js';
/** Internal accepted control-plane only. Not exposed through operator HTTP.
 * The same physical identity always recovers its retained stable lineage. */
export interface AcceptedReceiver {
  accountLineage: string;
  canonicalReceiver: string;
  opaqueRef: string;
  kind: AudienceKind;
  schoolScopeId: string | null;
  label: string;
  ownerEvidenceRef: string;
  purposeGrantId: string;
  consentPolicyRevision: string;
  validUntil: Date;
}
@Injectable()
export class RatingPromotionEnrollment {
  async enroll(
    programId: string,
    entries: readonly AcceptedReceiver[],
    tx: PoolClient,
  ) {
    if (entries.length > limits.enrollmentBatch)
      throw new ApplicationError('PROMOTION_QUOTA_EXCEEDED');
    const p = (
      await tx.query<Program>(
        'SELECT * FROM whaleu_ratings.promotion_programs WHERE id=$1 FOR UPDATE',
        [programId],
      )
    ).rows[0];
    if (!p) throw new ApplicationError('PROMOTION_NOT_FOUND');
    const ids: string[] = [];
    for (const entry of entries) {
      if (
        entry.accountLineage !== p.account_lineage ||
        !entry.ownerEvidenceRef ||
        !entry.canonicalReceiver.startsWith('synthetic:') ||
        !entry.opaqueRef.startsWith('synthetic:') ||
        (entry.kind === 'school_treehole') !== (entry.schoolScopeId !== null)
      )
        throw new ApplicationError('PROMOTION_INVALID_REQUEST');
      const canonicalHash = digest([
        'rating-physical-receiver-v1',
        entry.accountLineage,
        entry.canonicalReceiver,
      ]);
      await tx.query(
        `INSERT INTO whaleu_ratings.promotion_receiver_lineages(id,account_lineage,canonical_hash) VALUES($1,$2,$3) ON CONFLICT(account_lineage,canonical_hash) DO NOTHING`,
        [randomUUID(), entry.accountLineage, canonicalHash],
      );
      const line = (
        await tx.query<{ id: string; retired: boolean }>(
          `SELECT id,retired FROM whaleu_ratings.promotion_receiver_lineages WHERE account_lineage=$1 AND canonical_hash=$2 FOR UPDATE`,
          [entry.accountLineage, canonicalHash],
        )
      ).rows[0]!;
      if (line.retired) throw new ApplicationError('PROMOTION_UNAVAILABLE');
      const existing = (
        await tx.query<{ revision: string; active: boolean }>(
          `SELECT revision,active FROM whaleu_ratings.promotion_receivers WHERE id=$1`,
          [line.id],
        )
      ).rows[0];
      // Existing current aliases cannot change kind/scope or reset another enrollment.
      if (existing) {
        const same = (
          await tx.query(
            `SELECT 1 FROM whaleu_ratings.promotion_receivers WHERE id=$1 AND active AND audience_kind=$2 AND school_scope_id IS NOT DISTINCT FROM $3::uuid AND opaque_ref=$4 AND purpose_grant_id=$5 AND consent_policy_revision=$6 AND valid_until>clock_timestamp()`,
            [
              line.id,
              entry.kind,
              entry.schoolScopeId,
              entry.opaqueRef,
              entry.purposeGrantId,
              entry.consentPolicyRevision,
            ],
          )
        ).rows[0];
        if (!same) {
          const live = (
            await tx.query(
              `SELECT 1 FROM whaleu_ratings.promotion_program_members_current WHERE stable_destination_id=$1 LIMIT 1`,
              [line.id],
            )
          ).rows[0];
          if (live || existing.active)
            throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
        }
      }
      const revision = existing?.active ? existing.revision : randomUUID();
      await tx.query(
        `INSERT INTO whaleu_ratings.promotion_receivers(id,revision,account_lineage,canonical_hash,opaque_ref,audience_kind,school_scope_id,label,owner_evidence_ref,purpose_grant_id,consent_policy_revision,active,active_from,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,clock_timestamp(),$12)
     ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,opaque_ref=EXCLUDED.opaque_ref,audience_kind=EXCLUDED.audience_kind,school_scope_id=EXCLUDED.school_scope_id,label=EXCLUDED.label,owner_evidence_ref=EXCLUDED.owner_evidence_ref,purpose_grant_id=EXCLUDED.purpose_grant_id,consent_policy_revision=EXCLUDED.consent_policy_revision,active=true,active_from=clock_timestamp(),valid_until=EXCLUDED.valid_until WHERE NOT whaleu_ratings.promotion_receivers.active`,
        [
          line.id,
          revision,
          entry.accountLineage,
          canonicalHash,
          entry.opaqueRef,
          entry.kind,
          entry.schoolScopeId,
          entry.label,
          entry.ownerEvidenceRef,
          entry.purposeGrantId,
          entry.consentPolicyRevision,
          entry.validUntil,
        ],
      );
      const enrolled = (
        await tx.query(
          `SELECT 1 FROM whaleu_ratings.promotion_program_members_current WHERE program_id=$1 AND stable_destination_id=$2`,
          [p.id, line.id],
        )
      ).rows[0];
      if (!enrolled) {
        const count = (
          await tx.query<{ n: number }>(
            `SELECT count(*)::int n FROM (SELECT stable_destination_id FROM whaleu_ratings.promotion_program_members_current WHERE program_id=$1 LIMIT 10001) m`,
            [p.id],
          )
        ).rows[0]!.n;
        if (count >= limits.recipients)
          throw new ApplicationError('PROMOTION_QUOTA_EXCEEDED');
        const enrollment = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_ratings.promotion_enrollment_history(revision,program_id,stable_destination_id,registry_revision,action,evidence_ref) VALUES($1,$2,$3,$4,'enroll',$5)`,
          [enrollment, p.id, line.id, revision, entry.ownerEvidenceRef],
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.promotion_program_members_current VALUES($1,$2,$3,$4,$5,$6)`,
          [
            p.id,
            line.id,
            entry.kind,
            entry.schoolScopeId,
            enrollment,
            revision,
          ],
        );
      }
      ids.push(line.id);
    }
    return [...new Set(ids)];
  }
  async revoke(
    programId: string,
    destinationId: string,
    evidenceRef: string,
    tx: PoolClient,
  ) {
    await tx.query(
      'SELECT id FROM whaleu_ratings.promotion_programs WHERE id=$1 FOR UPDATE',
      [programId],
    );
    const m = (
      await tx.query<{ registry_revision: string }>(
        'SELECT registry_revision FROM whaleu_ratings.promotion_program_members_current WHERE program_id=$1 AND stable_destination_id=$2',
        [programId, destinationId],
      )
    ).rows[0];
    if (!m) return;
    await tx.query(
      `INSERT INTO whaleu_ratings.promotion_enrollment_history(revision,program_id,stable_destination_id,registry_revision,action,evidence_ref) VALUES($1,$2,$3,$4,'revoke',$5)`,
      [
        randomUUID(),
        programId,
        destinationId,
        m.registry_revision,
        evidenceRef,
      ],
    );
    await tx.query(
      'DELETE FROM whaleu_ratings.promotion_program_members_current WHERE program_id=$1 AND stable_destination_id=$2',
      [programId, destinationId],
    );
  }
}
