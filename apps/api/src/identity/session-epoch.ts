import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { MIGRATION_LOCK } from '../database/migrations.js';
import { boundedOwnerProof } from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  type RequiredTransactionProof,
} from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import {
  sessionEpochAccountBody,
  sessionEpochIssuedBody,
  sessionEpochMarkerBody,
} from './session-epoch-contract.js';

const unavailable = () => new ApplicationError('AUTH_NOT_CONFIGURED');
const revoked = () => new ApplicationError('SESSION_REVOKED');
/** pg int8 text is the authority representation, never a lossy JS Number. */
export function sessionEpoch(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw unavailable();
  return value;
}
export function requireSessionEpoch(issued: unknown, current: unknown): string {
  const epoch = sessionEpoch(issued);
  if (epoch !== sessionEpoch(current)) throw revoked();
  return epoch;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const expectedBodies = [
  sessionEpochAccountBody,
  sessionEpochIssuedBody,
  sessionEpochMarkerBody,
].map(sha);
/** Only the two named epoch columns, constraints, triggers and three functions.
 * Fixed OID lookups and bounded body hashing; no namespace-wide JSON aggregate.
 * Other owner schema remains owned by its existing qualified protocol. */
export async function inspectSessionEpochSchema(tx: PoolClient): Promise<void> {
  const rows = (
    await tx.query<{ qualified: boolean; body_hashes: string[] }>(
      `/* identity-session-epoch-schema-v1 */ WITH expected(rel,col,con,trig,fn) AS (VALUES
        ('whaleu_identity.accounts'::text,'session_revocation_epoch'::text,'session_epoch_account_nonnegative'::text,'session_epoch_account'::text,'whaleu_identity.session_epoch_account_guard()'::text),
        ('whaleu_identity.sessions','issued_revocation_epoch','session_epoch_issued_nonnegative','session_epoch_issued','whaleu_identity.session_epoch_issued_guard()'))
      SELECT
       NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace=to_regnamespace('whaleu_identity') AND p.proname LIKE 'session_epoch_%'
         AND p.oid NOT IN (to_regprocedure('whaleu_identity.session_epoch_account_guard()'),to_regprocedure('whaleu_identity.session_epoch_issued_guard()'),to_regprocedure('whaleu_identity.session_epoch_protocol()')) LIMIT 1)
       AND (SELECT count(*)=2 AND bool_and(rel.relkind='r' AND NOT rel.relispartition AND NOT rel.relhassubclass AND NOT rel.relrowsecurity AND NOT rel.relforcerowsecurity
         AND a.atttypid=20 AND a.attnotnull AND NOT a.attisdropped AND a.attgenerated='' AND a.attidentity=''
         AND c.contype='c' AND c.convalidated AND c.conenforced AND NOT c.condeferrable AND NOT c.connoinherit
         AND CASE WHEN octet_length(c.conbin::text)<=512 THEN pg_get_constraintdef(c.oid)=format('CHECK ((%I >= 0))',e.col) ELSE false END
         AND t.tgfoid=to_regprocedure(e.fn) AND t.tgtype=23 AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgnargs=0 AND t.tgqual IS NULL
         AND t.tgattr=''::int2vector AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
         AND t.tgparentid=0 AND t.tgconstraint=0 AND t.tgdeferrable=false AND t.tginitdeferred=false)
        FROM expected e JOIN pg_class rel ON rel.oid=to_regclass(e.rel) JOIN pg_attribute a ON a.attrelid=to_regclass(e.rel) AND a.attname=e.col
        JOIN pg_constraint c ON c.conrelid=a.attrelid AND c.conname=e.con
        JOIN pg_trigger t ON t.tgrelid=a.attrelid AND t.tgname=e.trig)
       AND (SELECT count(*)=3 AND bool_and(NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.proparallel='u'
        AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
        AND p.prolang=(SELECT oid FROM pg_language WHERE lanname=CASE WHEN q.ordinal=3 THEN 'sql' ELSE 'plpgsql' END)
        AND p.provolatile=CASE WHEN q.ordinal=3 THEN 'i'::"char" ELSE 'v'::"char" END
        AND p.prorettype=CASE WHEN q.ordinal=3 THEN 'jsonb'::regtype ELSE 'trigger'::regtype END)
        FROM unnest(ARRAY['whaleu_identity.session_epoch_account_guard()','whaleu_identity.session_epoch_issued_guard()','whaleu_identity.session_epoch_protocol()']) WITH ORDINALITY q(name,ordinal)
        JOIN pg_proc p ON p.oid=to_regprocedure(q.name)) AS qualified,
       ARRAY(SELECT CASE WHEN octet_length(p.prosrc)<=4096 THEN encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') ELSE NULL END
        FROM unnest(ARRAY['whaleu_identity.session_epoch_account_guard()','whaleu_identity.session_epoch_issued_guard()','whaleu_identity.session_epoch_protocol()']) WITH ORDINALITY q(name,ordinal)
        JOIN pg_proc p ON p.oid=to_regprocedure(q.name) ORDER BY q.ordinal) AS body_hashes`,
    )
  ).rows;
  if (
    rows.length !== 1 ||
    rows[0]?.qualified !== true ||
    !Array.isArray(rows[0].body_hashes) ||
    rows[0].body_hashes.length !== expectedBodies.length ||
    rows[0].body_hashes.some((hash, i) => hash !== expectedBodies[i])
  )
    throw unavailable();
}
async function schemaFence(tx: PoolClient) {
  const rows = (
    await tx.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock_shared($1, $2) AS locked',
      [...MIGRATION_LOCK],
    )
  ).rows;
  if (rows.length !== 1 || rows[0]?.locked !== true) throw unavailable();
  await inspectSessionEpochSchema(tx);
}
const schemaProof: RequiredTransactionProof<string> = {
  maximumFacts: 1,
  failureCode: 'AUTH_NOT_CONFIGURED',
  validate: (_facts, tx) =>
    boundedOwnerProof(tx, 'AUTH_NOT_CONFIGURED', schemaFence),
};
export async function retainSessionEpochSchema(tx: PoolClient): Promise<void> {
  enableRequiredTransactionProof(tx, schemaProof);
  await boundedOwnerProof(tx, 'AUTH_NOT_CONFIGURED', schemaFence);
  registerRequiredTransactionFact(tx, schemaProof, 'epoch-v1', 'epoch-v1');
}
interface SessionEpochFact {
  readonly account: string;
  readonly session: string;
  readonly epoch: string;
}
const liveProof: RequiredTransactionProof<SessionEpochFact> = {
  maximumFacts: 128,
  failureCode: 'SESSION_REVOKED',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'SESSION_REVOKED', async (read) => {
      // Deterministic account -> session order. A released savepoint lock is not
      // proof; nonblocking reacquisition happens after every deferred wait.
      const accounts = [...new Set(facts.map((f) => f.account))].sort();
      await read.query(
        'SELECT id FROM whaleu_identity.accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT',
        [accounts],
      );
      await read.query(
        'SELECT id FROM whaleu_identity.sessions WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT',
        [[...new Set(facts.map((f) => f.session))].sort()],
      );
      const rows = (
        await read.query<{ valid: boolean }>(
          `/* identity-session-epoch-final-v1 */ SELECT count(*)=cardinality($1::uuid[]) AND bool_and(
            a.status='active' AND a.lifecycle='active' AND s.revoked_at IS NULL
            AND s.issued_revocation_epoch=f.epoch AND a.session_revocation_epoch=f.epoch)
          AS valid FROM unnest($1::uuid[],$2::uuid[],$3::bigint[]) f(account,session,epoch)
          JOIN whaleu_identity.accounts a ON a.id=f.account
          JOIN whaleu_identity.sessions s ON s.id=f.session AND s.account_id=f.account`,
          [
            facts.map((f) => f.account),
            facts.map((f) => f.session),
            facts.map((f) => f.epoch),
          ],
        )
      ).rows;
      if (rows.length !== 1 || rows[0]?.valid !== true) throw revoked();
    }),
};
/** Register only successful authority. Refresh replay intentionally revokes a
 * session and commits an error receipt, so must not register this live proof. */
export function retainLiveSessionEpoch(
  tx: PoolClient,
  account: string,
  session: string,
  epoch: unknown,
): void {
  enableRequiredTransactionProof(tx, liveProof);
  const value = sessionEpoch(epoch);
  registerRequiredTransactionFact(
    tx,
    liveProof,
    `${account}:${session}:${value}`,
    Object.freeze({ account, session, epoch: value }),
  );
}
