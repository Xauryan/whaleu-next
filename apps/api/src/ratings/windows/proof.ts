import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
export interface WindowSource {
  catalog: string;
  revision: string;
  history: string | null;
}
export async function catalogSource(tx: PoolClient) {
  const row = (
    await tx.query<{ source: { catalog: string } | null }>(
      `SELECT whaleu_ratings.window_catalog_source(clock_timestamp()) source`,
    )
  ).rows[0]!;
  if (!row.source) throw new ApplicationError('WINDOW_CATALOG_UNAVAILABLE');
  return row.source;
}
export async function windowSource(id: string, tx: PoolClient) {
  // Source classification and its exact next history transition are captured
  // at the SAME PostgreSQL instant. A later clock must never drop an expired
  // boundary that justified a known or not-submitted result already observed.
  const row = (
    await tx.query<{ source: WindowSource | null; until: string | null }>(
      `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT whaleu_ratings.window_source($1,instant.now) source,(SELECT min(boundary.value)::text FROM whaleu_ratings.window_history_heads h JOIN whaleu_ratings.window_history_assertions a ON a.id=h.assertion_id CROSS JOIN LATERAL(VALUES(a.accepted_at),(a.valid_until)) boundary(value) WHERE h.window_id=$1 AND a.coverage='accepted_empty' AND boundary.value>instant.now) until FROM instant`,
      [id],
    )
  ).rows[0]!;
  if (!row.source) throw new ApplicationError('WINDOW_NOT_FOUND');
  registerTransactionExactDeadline(tx, row.until, 'WINDOW_HISTORY_UNAVAILABLE');
  return row.source;
}
export async function windowEpoch(tx: PoolClient) {
  const row = (
    await tx.query<{ revision: string }>(
      'SELECT revision::text FROM whaleu_ratings.window_score_epoch WHERE singleton',
    )
  ).rows[0];
  if (!row) throw new ApplicationError('WINDOW_HISTORY_UNAVAILABLE');
  return row.revision;
}
interface Fact {
  actor: string;
  session: string;
  catalog: string;
  epoch: string;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 1,
  failureCode: 'WINDOW_HISTORY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'WINDOW_HISTORY_UNAVAILABLE', async (read) => {
      await read.query('SELECT whaleu_ratings.window_fence()');
      for (const f of facts) {
        const row = (
          await read.query<{
            allowed: boolean;
            source: unknown;
            epoch: string;
          }>(
            `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT whaleu_ratings.window_access($1,$2,instant.now) allowed,whaleu_ratings.window_catalog_source(instant.now) source,(SELECT revision::text FROM whaleu_ratings.window_score_epoch WHERE singleton) epoch FROM instant`,
            [f.actor, f.session],
          )
        ).rows[0]!;
        if (
          !row.allowed ||
          row.source === null ||
          ownerFingerprint(row.source) !== f.catalog ||
          row.epoch !== f.epoch
        )
          throw new ApplicationError('WINDOW_HISTORY_UNAVAILABLE');
      }
    }),
};
export async function retainWindows(
  actor: string,
  session: string,
  source: unknown,
  tx: PoolClient,
  expectedEpoch?: string,
) {
  const epoch = await windowEpoch(tx);
  if (expectedEpoch !== undefined && epoch !== expectedEpoch)
    throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
  const until = (
    await tx.query<{ until: string | null }>(
      'SELECT whaleu_ratings.window_deadline($1,$2,clock_timestamp())::text until',
      [actor, session],
    )
  ).rows[0]!.until;
  registerTransactionExactDeadline(tx, until, 'WINDOW_HISTORY_UNAVAILABLE');
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    'window-current',
    Object.freeze({ actor, session, catalog: ownerFingerprint(source), epoch }),
  );
  return epoch;
}
