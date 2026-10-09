import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
export interface NativeCreationSource {
  policy_id: string;
  policy_reference: string;
  origin_id: string | null;
  origin_state: 'known_school' | 'schoolless' | 'unknown';
  origin_campus_id: string | null;
  origin_source_reference: string | null;
  origin_policy_reference: string | null;
  policy_until: Date;
  origin_until: Date | null;
  origin_activation_at: Date | null;
}
/** Reads deployment policy and exact independently-issued origin provenance.
 * This does not issue permission, infer campus, or approve content. */
@Injectable()
export class RatingNativeTargetSourceFacade {
  async resolve(
    actor: string,
    request: string,
    hash: string,
    region: string | null,
    kind: string,
    tx: PoolClient,
  ): Promise<NativeCreationSource> {
    const row = (
      await tx.query<NativeCreationSource>(
        `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now) SELECT p.id policy_id,p.policy_reference,o.id origin_id,coalesce(o.origin_state,'unknown') origin_state,o.origin_campus_id,o.source_reference origin_source_reference,o.policy_reference origin_policy_reference,p.valid_until policy_until,o.valid_until origin_until,CASE WHEN raw.effective_at>instant.now THEN raw.effective_at ELSE NULL END origin_activation_at
   FROM instant CROSS JOIN whaleu_ratings.native_create_policy_heads h JOIN whaleu_ratings.native_create_policies p ON p.id=h.policy_id
   LEFT JOIN whaleu_ratings.native_origin_evidence o ON o.policy_id=p.id AND o.account_id=$1 AND o.request_id=$2 AND o.intent_hash=$3 AND o.region_id IS NOT DISTINCT FROM p.region_id AND o.effective_at<=instant.now AND o.valid_until>instant.now
   LEFT JOIN whaleu_ratings.native_origin_evidence raw ON raw.policy_id=p.id AND raw.account_id=$1 AND raw.request_id=$2 AND raw.intent_hash=$3 AND raw.region_id IS NOT DISTINCT FROM p.region_id
   WHERE h.scope_key=coalesce($4::uuid::text,'global') AND h.generic_kind=$5
   AND p.enabled AND p.coverage='complete' AND p.provenance='accepted' AND p.effective_at<=instant.now AND p.valid_until>instant.now
   AND (NOT p.require_known_origin OR o.origin_state='known_school') FOR SHARE OF h,p`,
        [actor, request, hash, region, kind],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('RATING_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      Math.min(
        row.policy_until.getTime(),
        row.origin_until?.getTime() ?? Infinity,
        // Future optional evidence is a negative temporal observation. Floor to
        // milliseconds conservatively; the wrapper checks after every final proof.
        row.origin_activation_at?.getTime() ?? Infinity,
      ),
      'RATING_UNAVAILABLE',
    );
    return row;
  }
}
