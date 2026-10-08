import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import type { AuthorizationRepository } from '../src/authorization/authorization.repository.js';
import type { ActiveGrant } from '../src/authorization/contracts.js';
import { requireUnprotectedErrandTarget } from '../src/authorization/errand-target-protection.js';
import { inTransaction } from '../src/database/database.js';
import type { DatabaseService } from '../src/database/database.js';
import {
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  clearTransactionDeadlines,
  enableRequiredTransactionProof,
  registerOptionalTransactionProof,
  registerRequiredTransactionFact,
  restoreTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import { ProfileAdminParticipantFacade } from '../src/profile/admin-participant.facade.js';

const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const fence =
  'LOCK TABLE whaleu_authorization.role_grants IN SHARE MODE NOWAIT';
const clock = 'SELECT clock_timestamp() AS now';
const immediate = 'SET CONSTRAINTS ALL IMMEDIATE';
function grant(subjectId: string, patch: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    subjectId,
    role: 'developer',
    operatingRegionId: null,
    validTimes: true,
    active: false,
    activationDeadline: null,
    ...patch,
  };
}
function fixture() {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const state = {
    now: new Date(100),
    isolation: 'read committed',
    rows: [] as Record<string, unknown>[],
    finalRows: null as Record<string, unknown>[] | null,
    fenced: false,
    fail: null as RegExp | null,
    after: async (_sql: string) => {},
    statement: '9s',
    lock: '0',
  };
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, ...(values ? { values } : {}) });
      if (state.fail?.test(sql)) throw new Error('Synthetic owner failure');
      if (sql === fence) state.fenced = true;
      let rows: unknown[] = [];
      if (sql === clock) rows = [{ now: state.now }];
      else if (sql.includes("current_setting('statement_timeout')"))
        rows = [
          {
            statement_timeout: state.statement,
            lock_timeout: state.lock,
            isolation: state.isolation,
          },
        ];
      else if (sql.includes("current_setting('transaction_isolation')"))
        rows = [{ isolation: state.isolation }];
      else if (sql.includes('FROM whaleu_authorization.role_grants'))
        rows = state.fenced && state.finalRows ? state.finalRows : state.rows;
      else if (sql.includes("set_config('statement_timeout'")) {
        state.statement = String(values?.[0]);
        state.lock = String(values?.[1]);
      }
      await state.after(sql);
      return { rows };
    },
    release: () => {},
  } as unknown as PoolClient;
  const pool = { connect: async () => tx } as unknown as Pick<Pool, 'connect'>;
  return { state, calls, tx, pool };
}

test('global errand authority chooses and retains only the selected global grant', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  const account = randomUUID();
  let grants: ActiveGrant[] = [
    {
      id: randomUUID(),
      role: 'school_admin',
      operatingRegionId: randomUUID(),
      validUntil: 1,
    },
    {
      id: randomUUID(),
      role: 'super_admin',
      operatingRegionId: null,
      validUntil: 2,
    },
    {
      id: randomUUID(),
      role: 'developer',
      operatingRegionId: null,
      validUntil: 500,
    },
  ];
  const service = new AuthorizationService(
    {} as DatabaseService,
    {} as IdentityService,
    { activeGrants: async () => grants } as unknown as AuthorizationRepository,
  );
  assert.equal(
    (await service.requireGlobalErrandManagement(account, f.tx)).id,
    grants[2]!.id,
  );
  assert.deepEqual(
    [...checkpointTransactionDeadlines(f.tx)],
    [['AUTHORIZATION_UNAVAILABLE', 500]],
  );
  grants = [grants[0]!];
  await assert.rejects(
    service.requireGlobalErrandManagement(account, f.tx),
    errorIs('AUTHORIZATION_REQUIRED'),
  );
  clearTransactionDeadlines(f.tx);
});

test('target proof requires canonical server subject, managed transaction and actual read committed', async () => {
  const f = fixture(),
    subject = randomUUID();
  await assert.rejects(
    requireUnprotectedErrandTarget(subject, f.tx),
    errorIs('AUTHORIZATION_UNAVAILABLE'),
  );
  assert.equal(f.calls.length, 0);
  startTransactionDeadlines(f.tx);
  for (const id of ['not-a-uuid', subject.toUpperCase()])
    await assert.rejects(
      requireUnprotectedErrandTarget(id, f.tx),
      errorIs('AUTHORIZATION_UNAVAILABLE'),
    );
  for (const isolation of [
    'repeatable read',
    'serializable',
    'read uncommitted',
  ]) {
    f.state.isolation = isolation;
    await assert.rejects(
      requireUnprotectedErrandTarget(subject, f.tx),
      errorIs('AUTHORIZATION_UNAVAILABLE'),
    );
  }
  clearTransactionDeadlines(f.tx);
});

test('early school protection is independent of region activity and does not call Campus', async () => {
  for (const role of ['school_admin', 'super_admin', 'developer']) {
    const f = fixture(),
      subject = randomUUID();
    f.state.rows = [
      grant(subject, {
        role,
        operatingRegionId: role === 'school_admin' ? randomUUID() : null,
        active: true,
      }),
    ];
    await assert.rejects(
      inTransaction(f.pool, (tx) =>
        requireUnprotectedErrandTarget(subject, tx),
      ),
      errorIs('ERRAND_RESTRICTION_TARGET_PROTECTED'),
    );
    assert.equal(
      f.calls.some(({ sql }) => sql === fence),
      false,
    );
    assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
    const sql = f.calls.find(({ sql }) => sql.includes('role_grants'))!.sql;
    assert.match(sql, /revoked_at IS NULL/);
    assert.match(sql, /valid_from<=checked.at/);
    assert.match(sql, /expires_at>checked.at/);
    assert.match(sql, /isfinite\(g.valid_from\)/);
    assert.match(
      sql,
      /floor\(extract\(epoch FROM g.valid_from\)\*1000\)::text/,
    );
    assert.doesNotMatch(sql, /FOR SHARE|FOR UPDATE|whaleu_campus|date_trunc/);
  }
});

test('a final promotion fails retryably after all deferred work and rolls tentative effects back', async () => {
  const f = fixture(),
    subject = randomUUID();
  f.state.finalRows = [grant(subject, { active: true })];
  await assert.rejects(
    inTransaction(
      f.pool,
      async (tx) => {
        await requireUnprotectedErrandTarget(subject, tx);
        await tx.query('INSERT synthetic_tombstone_event_notice_receipt');
      },
      { isolationLevel: 'read committed' },
    ),
    errorIs('AUTHORIZATION_UNAVAILABLE'),
  );
  const sqls = f.calls.map((call) => call.sql);
  assert.equal(sqls[0], 'BEGIN ISOLATION LEVEL READ COMMITTED');
  assert.ok(sqls.indexOf(fence) > sqls.indexOf(immediate));
  assert.ok(
    sqls.indexOf(immediate) >
      sqls.indexOf('INSERT synthetic_tombstone_event_notice_receipt'),
  );
  assert.equal(sqls.at(-1), 'ROLLBACK');
  assert.ok(!sqls.includes('COMMIT'));
});

test('final proof is bounded, dedupes exact subjects, uses no late row lock and restores local settings', async () => {
  const f = fixture(),
    subject = randomUUID();
  assert.equal(
    await inTransaction(f.pool, async (tx) => {
      await requireUnprotectedErrandTarget(subject, tx);
      await requireUnprotectedErrandTarget(subject, tx);
      return 'private result';
    }),
    'private result',
  );
  assert.equal(f.calls.filter(({ sql }) => sql === fence).length, 1);
  const reads = f.calls.filter(({ sql }) =>
    sql.includes('FROM whaleu_authorization.role_grants'),
  );
  assert.equal(reads.length, 3);
  assert.deepEqual(reads.at(-1)?.values, [[subject]]);
  assert.equal(f.state.statement, '9s');
  assert.equal(f.state.lock, '0');
  const finalSql = f.calls.slice(f.calls.findIndex(({ sql }) => sql === fence));
  assert.ok(
    finalSql.every(
      ({ sql }) => !/FOR SHARE|FOR UPDATE|whaleu_campus/.test(sql),
    ),
  );
  assert.equal(finalSql.at(-1)?.sql, 'COMMIT');
});

test('malformed role shape, times, rows, subject joins and future bounds fail closed before business rejection', async () => {
  const subject = randomUUID();
  const bad = [
    { role: 'member' },
    { role: 'school_admin', operatingRegionId: null },
    { operatingRegionId: randomUUID() },
    { validTimes: false, active: true },
    { validTimes: null },
    { active: 'false' },
    { activationDeadline: 'Infinity' },
    { activationDeadline: '100.999' },
    { activationDeadline: '9007199254740992' },
    { activationDeadline: '101', active: true },
    { subjectId: randomUUID() },
    { id: 'missing' },
  ];
  for (const patch of bad) {
    const f = fixture();
    f.state.rows = [grant(subject, patch)];
    await assert.rejects(
      inTransaction(f.pool, (tx) =>
        requireUnprotectedErrandTarget(subject, tx),
      ),
      errorIs('AUTHORIZATION_UNAVAILABLE'),
    );
  }
  for (const rows of [
    [grant(subject), grant(subject)],
    Array.from({ length: 4 }, () => grant(subject)),
  ]) {
    const f = fixture();
    f.state.rows = rows;
    await assert.rejects(
      inTransaction(f.pool, (tx) =>
        requireUnprotectedErrandTarget(subject, tx),
      ),
      errorIs('AUTHORIZATION_UNAVAILABLE'),
    );
  }
});

test('earliest future deadline is registered on original managed client and checked after later required proofs', async () => {
  const f = fixture(),
    subject = randomUUID();
  f.state.rows = [
    grant(subject, { activationDeadline: '150' }),
    grant(subject, { role: 'super_admin', activationDeadline: '200' }),
  ];
  await assert.rejects(
    inTransaction(f.pool, async (tx) => {
      await requireUnprotectedErrandTarget(subject, tx);
      assert.equal(
        checkpointTransactionDeadlines(tx).size,
        0,
        'unlocked precheck does not register authoritative deadlines',
      );
      const later = {
        maximumFacts: 1,
        failureCode: 'AUTHORIZATION_UNAVAILABLE' as const,
        validate: async () => {
          f.state.now = new Date(150);
        },
      };
      enableRequiredTransactionProof(tx, later);
      registerRequiredTransactionFact(tx, later, 'later', 'later');
    }),
    errorIs('AUTHORIZATION_UNAVAILABLE'),
  );
  assert.ok(f.calls.some(({ sql }) => sql === clock));
  assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
});

test('future activation during deferred work, optional validation or immediately before wrapper clock aborts', async () => {
  for (const phase of ['deferred', 'optional', 'clock']) {
    const f = fixture(),
      subject = randomUUID();
    f.state.rows = [grant(subject, { activationDeadline: '150' })];
    f.state.after = async (sql) => {
      if (phase === 'deferred' && sql === immediate) {
        f.state.finalRows = [grant(subject, { active: true })];
      }
      if (phase === 'clock' && sql === fence) f.state.now = new Date(150);
    };
    await assert.rejects(
      inTransaction(f.pool, async (tx) => {
        await requireUnprotectedErrandTarget(subject, tx);
        if (phase === 'optional')
          registerOptionalTransactionProof(tx, {
            validate: async () => {
              f.state.now = new Date(150);
              return true;
            },
            invalidate: () => {},
          });
      }),
      errorIs('AUTHORIZATION_UNAVAILABLE'),
    );
  }
});

test('final snapshot may accept an already committed revocation rather than retaining an unlocked future deadline', async () => {
  const f = fixture(),
    subject = randomUUID();
  f.state.rows = [grant(subject, { activationDeadline: '101' })];
  f.state.finalRows = [];
  f.state.now = new Date(1000);
  await inTransaction(f.pool, (tx) =>
    requireUnprotectedErrandTarget(subject, tx),
  );
  assert.equal(f.calls.at(-1)?.sql, 'COMMIT');
});

test('final lock/read/settings failure never weakens proof or commits a receipt', async () => {
  for (const fail of [
    /LOCK TABLE/,
    /current_setting\('statement_timeout'\)/,
    /set_config/,
  ]) {
    const f = fixture(),
      subject = randomUUID();
    f.state.fail = fail;
    await assert.rejects(
      inTransaction(f.pool, async (tx) => {
        await requireUnprotectedErrandTarget(subject, tx);
        await tx.query('INSERT synthetic_receipt');
      }),
      errorIs('AUTHORIZATION_UNAVAILABLE'),
    );
    assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK');
    assert.ok(
      f.calls.filter(({ sql }) => sql.includes('LOCK TABLE')).length <= 1,
    );
  }
});

test('savepoint restoration removes unused target facts and permits later re-registration', async () => {
  const f = fixture(),
    subject = randomUUID();
  startTransactionDeadlines(f.tx);
  const checkpoint = checkpointTransactionDeadlines(f.tx);
  await requireUnprotectedErrandTarget(subject, f.tx);
  restoreTransactionDeadlines(f.tx, checkpoint);
  await checkTransactionDeadlines(f.tx);
  assert.ok(!f.calls.some(({ sql }) => sql === fence));
  await requireUnprotectedErrandTarget(subject, f.tx);
  await checkTransactionDeadlines(f.tx);
  assert.equal(f.calls.filter(({ sql }) => sql === fence).length, 1);
  clearTransactionDeadlines(f.tx);
});

test('bounded required proof rejects the seventeenth target and final changed isolation', async () => {
  const f = fixture();
  await assert.rejects(
    inTransaction(f.pool, async (tx) => {
      for (let n = 0; n < 17; n++)
        await requireUnprotectedErrandTarget(randomUUID(), tx);
    }),
    errorIs('AUTHORIZATION_UNAVAILABLE'),
  );
  const g = fixture();
  await assert.rejects(
    inTransaction(g.pool, async (tx) => {
      await requireUnprotectedErrandTarget(randomUUID(), tx);
      g.state.isolation = 'repeatable read';
    }),
    errorIs('AUTHORIZATION_UNAVAILABLE'),
  );
});

test('Profile public-reference resolver returns only stable narrow existing facts and never creates', async () => {
  const facade = new ProfileAdminParticipantFacade();
  const profileId = randomUUID(),
    accountId = randomUUID();
  const queries: string[] = [];
  let rows: unknown[] = [{ profileId, accountId, displayName: 'PublicName' }];
  const tx = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows };
    },
  } as unknown as PoolClient;
  assert.deepEqual(await facade.resolve(profileId, tx), rows[0]);
  assert.match(queries[0]!, /WHERE public_id=\$1 FOR SHARE/);
  assert.doesNotMatch(
    queries[0]!,
    /INSERT|bio|preferences|student|phone|private/,
  );
  rows = [];
  assert.equal(await facade.resolve(profileId, tx), null);
  for (const bad of [
    [{ profileId: randomUUID(), accountId, displayName: 'PublicName' }],
    [{ profileId, accountId, displayName: 'PublicName', bio: 'private' }],
    [{ profileId, accountId, displayName: '' }],
    [
      { profileId, accountId, displayName: 'PublicName' },
      { profileId, accountId, displayName: 'PublicName' },
    ],
  ]) {
    rows = bad;
    await assert.rejects(
      facade.resolve(profileId, tx),
      errorIs('ERRAND_UNAVAILABLE'),
    );
  }
});
