import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
/** One complete source at one instant. Scalar epoch reads prevent unanalysed
 * boolean-singleton tables from multiplying the estimated result cardinality.
 * All catalog entries (including inactive/off-page entries) still contribute
 * every future history, Review, policy and author-Safety boundary. */
export const majorCatalogCaptureSql = `
WITH instant AS MATERIALIZED(SELECT clock_timestamp() now),
 capture AS MATERIALIZED(
  SELECT now,whaleu_majors.major_catalog_source(now) source FROM instant
 ),
 boundaries AS (
  SELECT boundary.value FROM capture
  JOIN whaleu_majors.major_entries e ON e.catalog_id=(capture.source->>'catalog')::uuid
  JOIN whaleu_majors.major_discussion_history_heads h ON h.major_id=e.major_id
  JOIN whaleu_majors.major_discussion_history_assertions a ON a.id=h.assertion_id
  CROSS JOIN LATERAL(VALUES(a.accepted_at),(a.valid_until)) boundary(value)
  WHERE boundary.value>capture.now
  UNION ALL
  SELECT boundary.value FROM capture
  JOIN whaleu_majors.major_entries e ON e.catalog_id=(capture.source->>'catalog')::uuid
  JOIN whaleu_majors.major_discussion_comments c ON c.major_id=e.major_id
  JOIN whaleu_community.major_discussion_review_decisions d ON d.id=c.review_decision_id
  JOIN whaleu_community.major_discussion_review_policies p ON p.id=d.policy_id
  LEFT JOIN whaleu_safety.account_heads s ON s.account_id=c.actor_id
  CROSS JOIN LATERAL(VALUES(d.issued_at),(d.visibility_until),(p.valid_from),(p.valid_until),(s.valid_until)) boundary(value)
  WHERE boundary.value>capture.now
  UNION ALL
  SELECT boundary.value FROM capture
  JOIN whaleu_majors.major_entries e ON e.catalog_id=(capture.source->>'catalog')::uuid
  JOIN whaleu_majors.major_discussion_comments c ON c.major_id=e.major_id
  JOIN whaleu_community.major_discussion_media_review_decisions d ON d.id=c.media_review_decision_id
  JOIN whaleu_community.major_discussion_media_review_policies p ON p.id=d.policy_id
  LEFT JOIN whaleu_safety.account_heads s ON s.account_id=c.actor_id
  CROSS JOIN LATERAL(VALUES(d.issued_at),(d.visibility_until),(p.valid_from),(p.valid_until),(s.valid_until)) boundary(value)
  WHERE boundary.value>capture.now
  UNION ALL
  SELECT boundary.value FROM capture
  JOIN whaleu_majors.major_entries e ON e.catalog_id=(capture.source->>'catalog')::uuid
  JOIN whaleu_media.major_discussion_appearances a ON a.major_id=e.major_id
  JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.asset_id
  JOIN whaleu_media.asset_safety_events m ON m.id=h.event_id
  CROSS JOIN LATERAL(VALUES(m.effective_at),(m.valid_until)) boundary(value)
  WHERE boundary.value>capture.now
 )
 SELECT source,
  (SELECT revision::text FROM whaleu_majors.major_catalog_epoch WHERE singleton) epoch,
  (SELECT revision::text FROM whaleu_majors.major_discussion_epoch WHERE singleton) content,
  (SELECT revision::text FROM whaleu_community.major_discussion_review_epoch WHERE singleton) review,
  least(capture.now+interval '10 minutes',
   whaleu_majors.major_discussion_access_deadline($1,$2,capture.now),
   whaleu_majors.major_discussion_source_boundary(capture.now),
   (SELECT min(value) FROM boundaries))::text until
 FROM capture`;
export async function majorCatalog(
  tx: PoolClient,
  actor: string,
  session: string,
  retainDeadline = true,
) {
  const row = (
    await tx.query<{
      source: { catalog: string } | null;
      epoch: string | null;
      content: string | null;
      review: string | null;
      until: string;
    }>(majorCatalogCaptureSql, [actor, session])
  ).rows[0];
  if (!row?.source || !row.epoch || !row.content || !row.review)
    throw new ApplicationError('MAJOR_CATALOG_UNAVAILABLE');
  if (retainDeadline)
    registerTransactionExactDeadline(
      tx,
      row.until,
      'MAJOR_CATALOG_UNAVAILABLE',
    );
  return {
    ...row,
    source: row.source,
    epoch: row.epoch,
    content: row.content,
    review: row.review,
  };
}
type Fact = {
  actor: string;
  session: string;
  fingerprint: string;
  epoch: string;
  content: string;
  review: string;
};
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 1,
  failureCode: 'MAJOR_CATALOG_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'MAJOR_CATALOG_UNAVAILABLE', async (read) => {
      await read.query('SELECT whaleu_majors.major_discussion_fence()');
      for (const f of facts) {
        const row = await majorCatalog(read, f.actor, f.session, false);
        const access = (
          await read.query<{ allowed: boolean }>(
            'SELECT whaleu_majors.major_access($1,$2,clock_timestamp()) allowed',
            [f.actor, f.session],
          )
        ).rows[0]!.allowed;
        if (
          !access ||
          ownerFingerprint(row.source) !== f.fingerprint ||
          row.epoch !== f.epoch ||
          row.content !== f.content ||
          row.review !== f.review
        )
          throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      }
    }),
};
export function retainMajorCatalog(
  actor: string,
  session: string,
  capture: Awaited<ReturnType<typeof majorCatalog>>,
  tx: PoolClient,
) {
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    'major-catalog',
    Object.freeze({
      actor,
      session,
      fingerprint: ownerFingerprint(capture.source),
      epoch: capture.epoch,
      content: capture.content,
      review: capture.review,
    }),
  );
}
