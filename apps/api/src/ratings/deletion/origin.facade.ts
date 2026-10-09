import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';

export interface RatingTargetOrigin {
  state: 'known_school' | 'schoolless' | 'unknown' | 'absent';
  sourceId: string | null;
  revision: number | null;
  campusId: string | null;
  fingerprint: string;
  deadline: number | null;
}
interface Fact {
  targetId: string;
  fingerprint: string;
}
async function capture(
  targetId: string,
  tx: PoolClient,
  lock: boolean,
): Promise<RatingTargetOrigin> {
  if (lock)
    await tx.query(
      'SELECT source_id,revision FROM whaleu_ratings.target_origin_heads WHERE target_id=$1 FOR SHARE',
      [targetId],
    );
  const row = (
    await tx.query<{
      head_revision: number;
      source_id: string | null;
      revision: number | null;
      state: 'known_school' | 'schoolless' | 'unknown';
      origin_campus_id: string | null;
      revoked: boolean;
      source_version: number;
      coverage_state: string;
      provenance_state: string;
      source_reference: string;
      policy_reference: string;
      effective_at: Date;
      precise_from: string;
      valid_until: Date | null;
      precise_until: string | null;
      expiry_kind: string;
      valid: boolean;
      future: boolean;
    }>(
      `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
    SELECT h.revision head_revision,s.id source_id,s.revision,s.state,s.origin_campus_id,s.revoked,
      s.source_version,s.coverage_state,s.provenance_state,s.source_reference,s.policy_reference,
      s.effective_at,s.effective_at::text precise_from,s.valid_until,s.valid_until::text precise_until,s.expiry_kind,
      coalesce(NOT s.revoked AND s.coverage_state='complete' AND s.provenance_state='accepted'
      AND length(btrim(s.source_reference))>0 AND length(btrim(s.policy_reference))>0
      AND isfinite(s.effective_at) AND s.effective_at<=instant.now
      AND ((s.expiry_kind='policy_exempt' AND s.valid_until IS NULL)
      OR (s.expiry_kind='at' AND isfinite(s.valid_until) AND s.valid_until>s.effective_at AND s.valid_until>instant.now)),false) valid,
      coalesce(isfinite(s.effective_at) AND s.effective_at>instant.now,false) future
    FROM whaleu_ratings.target_origin_heads h
    LEFT JOIN whaleu_ratings.target_origin_sources s ON s.id=h.source_id AND s.target_id=h.target_id AND s.revision=h.revision
    CROSS JOIN instant WHERE h.target_id=$1`,
      [targetId],
    )
  ).rows[0];
  if (!row)
    return {
      state: 'absent',
      sourceId: null,
      revision: null,
      campusId: null,
      fingerprint: ownerFingerprint([targetId, 'absent']),
      deadline: null,
    };
  if (!row.source_id || row.revision !== row.head_revision)
    throw new ApplicationError('RATING_DELETION_AUTHORITY_UNAVAILABLE');
  const state = row.valid ? row.state : 'unknown';
  return {
    state,
    sourceId: row.source_id,
    revision: row.revision,
    campusId: state === 'known_school' ? row.origin_campus_id : null,
    fingerprint: ownerFingerprint([targetId, row]),
    deadline: row.future
      ? row.effective_at.getTime()
      : row.valid
        ? (row.valid_until?.getTime() ?? null)
        : null,
  };
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 4,
  failureCode: 'RATING_DELETION_AUTHORITY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(
      tx,
      'RATING_DELETION_AUTHORITY_UNAVAILABLE',
      async (read) => {
        // The table fence covers a previously absent head as well as version/ABA changes.
        await read.query(
          'LOCK TABLE whaleu_ratings.target_origin_heads,whaleu_ratings.target_origin_sources IN SHARE MODE NOWAIT',
        );
        for (const fact of facts)
          if (
            (await capture(fact.targetId, read, false)).fingerprint !==
            fact.fingerprint
          )
            throw new ApplicationError('RATING_DELETION_AUTHORITY_UNAVAILABLE');
      },
    ),
};
/** Empty by default. Never infer original school from catalog or authors. */
@Injectable()
export class RatingTargetOriginFacade {
  async observe(targetId: string, tx: PoolClient): Promise<RatingTargetOrigin> {
    enableRequiredTransactionProof(tx, proof);
    const result = await capture(targetId, tx, true);
    registerRequiredTransactionFact(
      tx,
      proof,
      `${targetId}:${result.fingerprint}`,
      Object.freeze({ targetId, fingerprint: result.fingerprint }),
    );
    registerTransactionDeadline(
      tx,
      result.deadline,
      'RATING_DELETION_AUTHORITY_UNAVAILABLE',
    );
    return result;
  }
}
