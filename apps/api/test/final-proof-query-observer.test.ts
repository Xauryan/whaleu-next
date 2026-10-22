import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Pool, PoolClient } from 'pg';
import {
  inTransaction,
  type DatabaseService,
  type TransactionOptions,
} from '../src/database/database.js';
import { ApplicationError } from '../src/http/application-error.js';
import { IdentityRepository } from '../src/identity/identity.repository.js';
import { IdentityService } from '../src/identity/identity.service.js';
import {
  sessionEpochAccountBody,
  sessionEpochIssuedBody,
  sessionEpochMarkerBody,
} from '../src/identity/session-epoch-contract.js';
import { mintToken } from '../src/identity/tokens.js';
import { PostgresThrottlerStorage } from '../src/request-throttling/postgres-storage.js';
import { RatingRequestGuard } from '../src/request-throttling/rating-request.guard.js';
import { retainTargetOwnerMetadata } from '../src/ratings/management/target-deletion/proof.js';
import { observeDirectoryQueries } from './support/directory-query-observer.js';
import {
  finalProofQueryObserver,
  finalizationAfterStatement,
  isReadOnlyFinalProofSql,
} from './support/final-proof-query-observer.js';

test('actual rating guard SQL demonstrates why a request-wide finalization flag is invalid', async (t) => {
  const account = '00000000-0000-4000-8000-000000000001';
  const session = '00000000-0000-4000-8000-000000000002';
  const now = new Date();
  const later = new Date(now.getTime() + 600000);
  const sqlLog: string[] = [];
  // This is a no-PostgreSQL SQL-observer regression, not an integration result.
  // The guard, Identity authentication, 0180 final proofs, transaction wrapper,
  // throttler storage and directory observer are their real implementations.
  const client = {
    release() {},
    query: async (sql: string) => {
      sqlLog.push(sql);
      let rows: object[] = [];
      if (sql.includes("current_setting('transaction_isolation')"))
        rows = [
          {
            isolation: 'read committed',
            statement_timeout: '3s',
            lock_timeout: '1s',
          },
        ];
      else if (sql.includes('pg_try_advisory_xact_lock_shared'))
        rows = [{ locked: true }];
      else if (sql.includes('identity-session-epoch-schema-v1'))
        rows = [
          {
            qualified: true,
            body_hashes: [
              sessionEpochAccountBody,
              sessionEpochIssuedBody,
              sessionEpochMarkerBody,
            ].map((body) => createHash('sha256').update(body).digest('hex')),
          },
        ];
      else if (sql.startsWith('SELECT s.account_id,t.session_id'))
        rows = [{ account_id: account, session_id: session }];
      else if (sql.startsWith('SELECT s.*, a.status'))
        rows = [
          {
            id: session,
            account_id: account,
            status: 'active',
            lifecycle: 'active',
            access_expires_at: later,
            refresh_expires_at: later,
            absolute_expires_at: later,
            token_expires_at: later,
            revoked_at: null,
            issued_revocation_epoch: '0',
            session_revocation_epoch: '0',
            now,
          },
        ];
      else if (sql === 'SELECT clock_timestamp() AS now') rows = [{ now }];
      else if (sql.includes('identity-session-epoch-final-v1'))
        rows = [{ valid: true }];
      else if (
        sql.includes('JOIN whaleu_ratings.targets t') &&
        sql.includes('target_owner_tombstones')
      )
        rows = [{ n: 1 }];
      else if (sql.includes('SELECT total_hits,expires_at,blocked_until'))
        rows = [{ total_hits: 0, expires_at: now, blocked_until: null }];
      else
        assert.ok(
          /^(BEGIN|COMMIT|ROLLBACK|SET |INSERT INTO whaleu_runtime\.request_throttle_counters|UPDATE whaleu_runtime\.request_throttle_counters|SELECT set_config|SELECT id FROM whaleu_identity\.(accounts|sessions))/.test(
            sql,
          ),
          `Unexpected fixture SQL: ${sql}`,
        );
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pick<
    Pool,
    'connect'
  >;
  const database = {
    transaction: <T>(
      operation: (tx: PoolClient) => Promise<T>,
      options?: TransactionOptions,
    ) => inTransaction(pool, operation, options),
  } as DatabaseService;
  const app = { get: () => database } as unknown as INestApplication;
  const observer = observeDirectoryQueries(app);
  const current = finalProofQueryObserver();
  const events: { sql: string; transactionId: symbol }[] = [];
  const legacy: { sql: string; transactionId: symbol }[] = [];
  let finalized = false;
  observer.setHook(async (event) => {
    events.push(event);
    current.record(event);
    if (event.sql === 'SET CONSTRAINTS ALL IMMEDIATE') finalized = true;
    else if (finalized) legacy.push(event);
  });
  const identity = new IdentityService(
    {
      exchange: async () => {
        throw new Error('Provider must not be called');
      },
    },
    new IdentityRepository(database),
  );
  const guard = new RatingRequestGuard(
    [{ ttl: 60000, limit: 120 }],
    new PostgresThrottlerStorage(database),
    new Reflector(),
    identity,
  );
  const request = {
    headers: { authorization: `Bearer ${mintToken('access')}` },
  };
  const context = {
    getClass: () => RatingRequestGuard,
    getHandler: () => guard.canActivate,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ vary() {}, header() {} }),
    }),
  } as unknown as ExecutionContext;
  try {
    await guard.onModuleInit();
    assert.equal(await guard.canActivate(context), true);
    await database.transaction(
      async (tx) => {
        retainTargetOwnerMetadata(
          {
            id: '00000000-0000-4000-8000-000000000003',
            creator_id: account,
            revision: '00000000-0000-4000-8000-000000000004',
            active: false,
            delete_audit_id: '00000000-0000-4000-8000-000000000005',
          },
          tx,
        );
      },
      { isolationLevel: 'read committed' },
    );
    const boundaries = events.filter(
      ({ sql }) => sql === 'SET CONSTRAINTS ALL IMMEDIATE',
    );
    assert.equal(boundaries.length, 2);
    assert.notEqual(boundaries[0]!.transactionId, boundaries[1]!.transactionId);
    const rejectedByLegacy = legacy.filter(({ sql }) =>
      /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql),
    );
    assert.equal(rejectedByLegacy.length, 2);
    assert.match(
      rejectedByLegacy[0]!.sql,
      /^INSERT INTO whaleu_runtime\.request_throttle_counters/,
    );
    assert.match(
      rejectedByLegacy[1]!.sql,
      /^UPDATE whaleu_runtime\.request_throttle_counters/,
    );
    for (const event of rejectedByLegacy)
      assert.notEqual(event.transactionId, boundaries[0]!.transactionId);
    assert.ok(
      events.some(({ sql }) =>
        sql.includes('identity-session-epoch-schema-v1'),
      ),
    );
    assert.ok(
      current.statements.some(({ sql }) =>
        sql.includes('identity-session-epoch-final-v1'),
      ),
    );
    assert.ok(
      current.statements.some(
        ({ sql, transactionId }) =>
          transactionId === boundaries[1]!.transactionId &&
          sql.includes('JOIN whaleu_ratings.targets t') &&
          sql.includes('target_owner_tombstones'),
      ),
    );
    current.assertReadOnly();
    assert.equal(sqlLog.filter((sql) => sql === 'COMMIT').length, 3);
    assert.ok(
      current.statements.every(({ transactionId }) =>
        boundaries.some((event) => event.transactionId === transactionId),
      ),
    );
    t.diagnostic(
      JSON.stringify({
        evidence:
          'Real exact-source guard/storage SQL with a synthetic driver, not a cloud SQL trace',
        falselyRejected: rejectedByLegacy.map(({ sql }) => sql),
        identityFinalTransaction: 1,
        throttleMutationTransaction: 2,
      }),
    );
    await t.test(
      'the original category hook aborts authentication before its own wait',
      async () => {
        let tentative = false,
          waited = false;
        observer.setHook(async ({ sql }) => {
          if (sql.startsWith('UPDATE whaleu_ratings.target_definition_heads'))
            tentative = true;
          if (!waited && sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
            assert.ok(
              tentative,
              'The real new target definition was tentative before finalization',
            );
            waited = true;
            assert.fail(
              'An authentication boundary must never start the category wait',
            );
          }
        });
        const before = sqlLog.length;
        await assert.rejects(guard.canActivate(context), (error: unknown) => {
          assert.ok(error instanceof ApplicationError);
          assert.equal(error.code, 'RATING_UNAVAILABLE');
          return true;
        });
        assert.equal(tentative, false);
        assert.equal(waited, false);
        assert.equal(sqlLog.at(-1), 'ROLLBACK');
        assert.ok(
          !sqlLog
            .slice(before)
            .some((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql)),
        );
        t.diagnostic(
          'Original category hook throws inside identity finalization; the real guard maps it to RATING_UNAVAILABLE, with waited=false and no owner mutation.',
        );
      },
    );
  } finally {
    observer.restore();
  }
});

test('transaction-scoped finalization excludes other tentative work without losing later owner proof', () => {
  const observation = finalProofQueryObserver();
  const identity = Symbol('identity'),
    owner = Symbol('owner'),
    other = Symbol('concurrent');
  const record = (transactionId: symbol, sql: string) =>
    observation.record({ transactionId, sql });
  record(identity, 'SET CONSTRAINTS ALL IMMEDIATE');
  record(owner, 'INSERT INTO whaleu_ratings.requests VALUES (1)');
  record(identity, 'SELECT 1');
  record(other, 'DELETE FROM unrelated');
  record(identity, 'COMMIT');
  record(owner, 'SET CONSTRAINTS ALL IMMEDIATE');
  record(owner, 'SELECT t.id FROM whaleu_ratings.targets t');
  record(owner, 'COMMIT');
  assert.deepEqual(
    observation.statements.map(({ sql }) => sql),
    [
      'SELECT 1',
      'COMMIT',
      'SELECT t.id FROM whaleu_ratings.targets t',
      'COMMIT',
    ],
  );
  observation.assertReadOnly();
});

for (const sql of [
  'INSERT INTO whaleu_ratings.requests VALUES (1)',
  'UPDATE whaleu_ratings.targets SET active=false',
  'DELETE FROM whaleu_ratings.targets',
  'WITH changed AS (DELETE FROM whaleu_ratings.targets RETURNING *) SELECT * FROM changed',
  'WITH changed AS (UPDATE whaleu_ratings.targets SET active=false RETURNING *) SELECT * FROM changed',
  'WITH changed AS (INSERT INTO whaleu_ratings.requests VALUES (1) RETURNING *) SELECT * FROM changed',
  'WITH ids AS (SELECT 1) DELETE FROM whaleu_ratings.targets',
  '/* SELECT harmless */ WITH ids AS (SELECT 1) UPDATE whaleu_ratings.targets SET active=false',
  'SELECT 1; DELETE FROM whaleu_ratings.targets',
  'SELECT 1; /* comment */ CALL mutate_owner()',
  'DO $$ BEGIN DELETE FROM whaleu_ratings.targets; END $$',
  "DO 'BEGIN DELETE FROM whaleu_ratings.targets; END'",
  'CALL mutate_owner()',
  'EXECUTE prepared_mutation',
  'PREPARE x AS SELECT 1',
  'SELECT 1 INTO new_table',
  'MERGE INTO whaleu_ratings.targets USING other ON true WHEN MATCHED THEN DELETE',
  'COPY whaleu_ratings.targets FROM STDIN',
  'TRUNCATE whaleu_ratings.targets',
  'CREATE TABLE mutation AS SELECT 1',
  "SELECT nextval('mutation_sequence')",
  "SELECT setval('mutation_sequence', 2)",
  'LOCK TABLE whaleu_ratings.targets IN ROW EXCLUSIVE MODE',
  'LOCK TABLE whaleu_ratings.targets IN SHARE MODE',
  "SELECT 'unterminated",
  'SELECT 1 /* unterminated',
  "SELECT E'escaped\\'; DELETE FROM whaleu_ratings.targets; --'",
]) {
  test(`final proof rejects executable mutation/opaque SQL: ${sql}`, () => {
    assert.equal(isReadOnlyFinalProofSql(sql), false);
    const observation = finalProofQueryObserver();
    const transactionId = Symbol('owner');
    observation.record({ transactionId, sql: 'SET CONSTRAINTS ALL IMMEDIATE' });
    observation.record({ transactionId, sql });
    assert.throws(
      () => observation.assertReadOnly(),
      /Owner final proof remains read-only/,
    );
  });
}

for (const sql of [
  'SELECT 1',
  "SELECT 'DELETE', 'it''s UPDATE', \"insert\" FROM catalog",
  '/* outer /* nested DELETE */ UPDATE */ WITH x AS (SELECT 1) SELECT * FROM x',
  '-- DELETE FROM hidden\nSELECT 1',
  'SELECT id FROM whaleu_identity.accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT',
  "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
  'LOCK TABLE whaleu_ratings.targets,whaleu_ratings.target_owner_tombstones IN SHARE MODE NOWAIT',
  'WITH instant AS MATERIALIZED (SELECT clock_timestamp() now) SELECT now FROM instant',
  'SELECT 1; SELECT 2; COMMIT;',
])
  test(`final proof accepts bounded read/control SQL: ${sql}`, () => {
    assert.equal(isReadOnlyFinalProofSql(sql), true);
  });

test('an empty observation cannot falsely claim finalization', () => {
  assert.throws(
    () => finalProofQueryObserver().assertReadOnly(),
    /real transaction finalization/,
  );
});

test('a category deferred wait requires its exact tentative owner transaction, not any guard or concurrent finalization', () => {
  const phase = finalizationAfterStatement(
    'UPDATE whaleu_ratings.target_definition_heads',
  );
  const guard = Symbol('guard'),
    owner = Symbol('owner'),
    concurrent = Symbol('concurrent');
  const record = (transactionId: symbol, sql: string) =>
    phase.record({ transactionId, sql });
  assert.equal(record(guard, 'SET CONSTRAINTS ALL IMMEDIATE'), false);
  assert.equal(record(owner, 'SELECT 1'), false);
  assert.equal(record(owner, 'SET CONSTRAINTS ALL IMMEDIATE'), false);
  assert.equal(
    record(
      owner,
      'UPDATE whaleu_ratings.target_definition_heads SET content_version=$1',
    ),
    false,
  );
  assert.equal(record(concurrent, 'SET CONSTRAINTS ALL IMMEDIATE'), false);
  assert.equal(record(guard, 'SET CONSTRAINTS ALL IMMEDIATE'), false);
  assert.equal(record(owner, 'SET CONSTRAINTS ALL IMMEDIATE'), true);
  assert.throws(
    () =>
      record(
        concurrent,
        'UPDATE whaleu_ratings.target_definition_heads SET content_version=$1',
      ),
    /belongs to one transaction/,
  );
});
