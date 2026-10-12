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
export interface FloorSource {
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
export async function floorSource(id: string, tx: PoolClient) {
  // Source classification and its exact next history transition are captured
  // at the SAME PostgreSQL instant. A later clock must never drop an expired
  // boundary that justified a known or not-submitted result already observed.
  const row = (
    await tx.query<{ source: FloorSource | null; until: string | null }>(
      `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT whaleu_ratings.floor_source($1,instant.now) source,(SELECT min(boundary.value)::text FROM whaleu_ratings.floor_history_heads h JOIN whaleu_ratings.floor_history_assertions a ON a.id=h.assertion_id CROSS JOIN LATERAL(VALUES(a.accepted_at),(a.valid_until)) boundary(value) WHERE h.floor_id=$1 AND a.coverage='accepted_empty' AND boundary.value>instant.now) until FROM instant`,
      [id],
    )
  ).rows[0]!;
  if (!row.source) throw new ApplicationError('FLOOR_NOT_FOUND');
  registerTransactionExactDeadline(tx, row.until, 'FLOOR_HISTORY_UNAVAILABLE');
  return row.source;
}
export async function floorEpoch(tx: PoolClient) {
  const row = (
    await tx.query<{ revision: string }>(
      'SELECT revision::text FROM whaleu_ratings.floor_score_epoch WHERE singleton',
    )
  ).rows[0];
  if (!row) throw new ApplicationError('FLOOR_HISTORY_UNAVAILABLE');
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
  failureCode: 'FLOOR_HISTORY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'FLOOR_HISTORY_UNAVAILABLE', async (read) => {
      await read.query('SELECT whaleu_ratings.floor_fence()');
      for (const f of facts) {
        const row = (
          await read.query<{
            allowed: boolean;
            source: unknown;
            epoch: string;
          }>(
            `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT whaleu_ratings.window_access($1,$2,instant.now) allowed,whaleu_ratings.window_catalog_source(instant.now) source,(SELECT revision::text FROM whaleu_ratings.floor_score_epoch WHERE singleton) epoch FROM instant`,
            [f.actor, f.session],
          )
        ).rows[0]!;
        if (
          !row.allowed ||
          row.source === null ||
          ownerFingerprint(row.source) !== f.catalog ||
          row.epoch !== f.epoch
        )
          throw new ApplicationError('FLOOR_HISTORY_UNAVAILABLE');
      }
    }),
};
export async function retainFloors(
  actor: string,
  session: string,
  source: unknown,
  tx: PoolClient,
  expectedEpoch?: string,
) {
  const epoch = await floorEpoch(tx);
  if (expectedEpoch !== undefined && epoch !== expectedEpoch)
    throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
  const until = (
    await tx.query<{ until: string | null }>(
      'SELECT whaleu_ratings.window_deadline($1,$2,clock_timestamp())::text until',
      [actor, session],
    )
  ).rows[0]!.until;
  registerTransactionExactDeadline(tx, until, 'FLOOR_HISTORY_UNAVAILABLE');
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    'floor-current',
    Object.freeze({ actor, session, catalog: ownerFingerprint(source), epoch }),
  );
  return epoch;
}

// Receipt/replay/cancellation keep the current presented Identity session even
// when all catalog, phone and Safety facts have become unavailable. In particular,
// deferred cancellation work must not revoke Identity after the last early read.
interface SessionFact {
  actor: string;
  session: string;
  tokenHash: string;
  until: string;
}
const sessionProof: RequiredTransactionProof<SessionFact> = {
  maximumFacts: 1,
  failureCode: 'FLOOR_HISTORY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'FLOOR_HISTORY_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens IN SHARE MODE NOWAIT',
      );
      for (const f of facts) {
        const row = (
          await read.query<{ allowed: boolean }>(
            `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT EXISTS(SELECT 1 FROM whaleu_identity.access_tokens t JOIN whaleu_identity.sessions s ON s.id=t.session_id JOIN whaleu_identity.accounts a ON a.id=s.account_id CROSS JOIN instant WHERE t.token_hash=$1 AND s.id=$2 AND a.id=$3 AND a.status='active' AND s.revoked_at IS NULL AND t.expires_at>instant.now AND s.access_expires_at>instant.now AND s.absolute_expires_at>instant.now AND least(t.expires_at,s.access_expires_at,s.absolute_expires_at)=$4::timestamptz) allowed`,
            [f.tokenHash, f.session, f.actor, f.until],
          )
        ).rows[0]!;
        if (!row.allowed)
          throw new ApplicationError('FLOOR_HISTORY_UNAVAILABLE');
      }
    }),
};
export async function retainFloorSession(
  actor: string,
  session: string,
  tokenHash: string,
  tx: PoolClient,
) {
  const row = (
    await tx.query<{ until: string }>(
      `SELECT least(t.expires_at,s.access_expires_at,s.absolute_expires_at)::text until FROM whaleu_identity.access_tokens t JOIN whaleu_identity.sessions s ON s.id=t.session_id WHERE t.token_hash=$1 AND s.id=$2 AND s.account_id=$3`,
      [tokenHash, session, actor],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('SESSION_REVOKED');
  registerTransactionExactDeadline(tx, row.until, 'ACCESS_TOKEN_EXPIRED');
  enableRequiredTransactionProof(tx, sessionProof);
  registerRequiredTransactionFact(
    tx,
    sessionProof,
    'floor-session',
    Object.freeze({ actor, session, tokenHash, until: row.until }),
  );
}
