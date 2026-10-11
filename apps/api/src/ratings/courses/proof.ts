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
export interface CatalogRow {
  id: string;
  source_namespace: string;
  coverage: string;
  scope_policy: string;
  accepted_at: Date;
  valid_until: Date;
  state: string;
  fingerprint: unknown;
  is_current: boolean;
}
export async function readCatalog(tx: PoolClient, lock = false) {
  return (
    await tx.query<CatalogRow>(
      `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now) SELECT c.*,h.state,(c.accepted_at<=instant.now AND c.valid_until>instant.now) is_current,jsonb_build_array(to_jsonb(h),to_jsonb(c),to_jsonb(a)) fingerprint FROM whaleu_ratings.course_catalog_head h JOIN whaleu_ratings.course_catalogs c ON c.id=h.catalog_id JOIN whaleu_ratings.course_catalog_acceptances a ON a.catalog_id=c.id CROSS JOIN instant WHERE h.singleton ${lock ? 'FOR SHARE OF h,c,a' : ''}`,
    )
  ).rows[0];
}
export interface HistoryRow {
  id: string;
  coverage: 'accepted_empty' | 'unknown';
  valid_until: Date;
  accepted_at: Date;
  fingerprint: unknown;
  is_current: boolean;
}
export async function readHistory(id: string, tx: PoolClient, lock = false) {
  return (
    await tx.query<HistoryRow>(
      `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now) SELECT a.*,(a.accepted_at<=instant.now AND a.valid_until>instant.now) is_current,jsonb_build_array(to_jsonb(h),to_jsonb(a)) fingerprint FROM whaleu_ratings.course_history_heads h JOIN whaleu_ratings.course_history_assertions a ON a.id=h.assertion_id AND a.course_id=h.course_id CROSS JOIN instant WHERE h.course_id=$1 ${lock ? 'FOR SHARE OF h,a' : ''}`,
      [id],
    )
  ).rows[0];
}
export async function scoreEpoch(tx: PoolClient) {
  const row = (
    await tx.query<{ revision: string }>(
      'SELECT revision::text FROM whaleu_ratings.course_score_epoch WHERE singleton',
    )
  ).rows[0];
  if (!row) throw new ApplicationError('COURSE_HISTORY_UNAVAILABLE');
  return row.revision;
}
type Fact =
  | { kind: 'catalog'; fingerprint: string }
  | { kind: 'history'; id: string; fingerprint: string }
  | { kind: 'scores'; revision: string };
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 60,
  failureCode: 'COURSE_CATALOG_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'COURSE_CATALOG_UNAVAILABLE', async (current) => {
      await current.query(
        'LOCK TABLE whaleu_ratings.course_catalog_head,whaleu_ratings.course_catalogs,whaleu_ratings.course_catalog_acceptances,whaleu_ratings.course_entries,whaleu_ratings.course_identities,whaleu_ratings.course_history_heads,whaleu_ratings.course_history_assertions,whaleu_ratings.course_scores,whaleu_ratings.course_score_epoch IN SHARE MODE NOWAIT',
      );
      for (const fact of facts) {
        if (fact.kind === 'catalog') {
          if (
            ownerFingerprint(
              (await readCatalog(current))?.fingerprint ?? null,
            ) !== fact.fingerprint
          )
            throw new ApplicationError('COURSE_CATALOG_UNAVAILABLE');
        } else if (fact.kind === 'history') {
          if (
            ownerFingerprint(
              (await readHistory(fact.id, current))?.fingerprint ?? null,
            ) !== fact.fingerprint
          )
            throw new ApplicationError('COURSE_HISTORY_UNAVAILABLE');
        } else if ((await scoreEpoch(current)) !== fact.revision)
          throw new ApplicationError('COURSE_HISTORY_UNAVAILABLE');
      }
    }),
};
function retain(tx: PoolClient, fact: Fact) {
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    JSON.stringify(fact),
    Object.freeze(fact),
  );
}
export async function currentCatalog(tx: PoolClient) {
  const row = await readCatalog(tx, true);
  if (
    !row ||
    row.state !== 'accepted' ||
    row.coverage !== 'complete' ||
    row.scope_policy !== 'authenticated_phone' ||
    row.is_current !== true
  )
    throw new ApplicationError('COURSE_CATALOG_UNAVAILABLE');
  retain(tx, {
    kind: 'catalog',
    fingerprint: ownerFingerprint(row.fingerprint),
  });
  registerTransactionDeadline(
    tx,
    row.valid_until.getTime(),
    'COURSE_CATALOG_UNAVAILABLE',
  );
  return row;
}
export async function currentHistory(id: string, tx: PoolClient) {
  const row = await readHistory(id, tx, true);
  retain(tx, {
    kind: 'history',
    id,
    fingerprint: ownerFingerprint(row?.fingerprint ?? null),
  });
  // A missing/unknown baseline remains unknown, including when native rows exist.
  if (!row || row.coverage !== 'accepted_empty' || row.is_current !== true)
    return null;
  registerTransactionDeadline(
    tx,
    row.valid_until.getTime(),
    'COURSE_HISTORY_UNAVAILABLE',
  );
  return row;
}
export async function retainScoreEpoch(tx: PoolClient) {
  const revision = await scoreEpoch(tx);
  retain(tx, { kind: 'scores', revision });
  return revision;
}
