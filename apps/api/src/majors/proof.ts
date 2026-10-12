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
export async function majorCatalog(
  tx: PoolClient,
  actor: string,
  session: string,
  retainDeadline = true,
) {
  const row = (
    await tx.query<{
      source: { catalog: string } | null;
      epoch: string;
      content: string;
      review: string;
      until: string;
    }>(
      `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT whaleu_majors.major_catalog_source(instant.now) source,c.revision::text epoch,d.revision::text content,r.revision::text review,least(instant.now+interval '10 minutes',whaleu_majors.major_discussion_access_deadline($1,$2,instant.now),whaleu_majors.major_discussion_source_boundary(instant.now),(SELECT min(whaleu_majors.major_discussion_deadline(e.major_id,instant.now)) FROM whaleu_majors.major_entries e WHERE e.catalog_id=(whaleu_majors.major_catalog_source(instant.now)->>'catalog')::uuid))::text until FROM instant CROSS JOIN whaleu_majors.major_catalog_epoch c CROSS JOIN whaleu_majors.major_discussion_epoch d CROSS JOIN whaleu_community.major_discussion_review_epoch r WHERE c.singleton AND d.singleton AND r.singleton`,
      [actor, session],
    )
  ).rows[0];
  if (!row?.source) throw new ApplicationError('MAJOR_CATALOG_UNAVAILABLE');
  if (retainDeadline)
    registerTransactionExactDeadline(
      tx,
      row.until,
      'MAJOR_CATALOG_UNAVAILABLE',
    );
  return { ...row, source: row.source };
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
