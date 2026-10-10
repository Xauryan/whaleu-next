import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationError } from '../src/http/application-error.js';
import {
  boundedScalableProfileCiSnapshot,
  observeFirstScalableProfile,
  SCALABLE_PROFILE_CI_MAX_BYTES,
  scalableProfileCiPhase,
  scalableProfileCiSafeError,
  scalableProfileCiSafeLock,
  scalableProfileCiTimeoutMs,
} from './support/scalable-profile-ci-diagnostics.js';

type Snapshot = Parameters<typeof boundedScalableProfileCiSnapshot>[0];
const empty = (): Snapshot => ({
  transactions: 1,
  request: { outcome: 'ok', elapsedMs: 100, error: null },
  observer: {
    available: true,
    error: null,
    samples: 0,
    sampleLimitReached: false,
    windowExpired: false,
    unknownBackendPid: false,
    readerLimitReached: false,
    blockerEvidence: 'unknown',
    restorationObserved: false,
  },
  recent: [],
  failures: [],
  samples: [],
});

test('scalable Profile diagnostics redact error and lock metadata', () => {
  const secret = 'synthetic-private-body-token-sql-connection-string';
  const safe = scalableProfileCiSafeError(
    Object.assign(new Error(secret), {
      code: '55P03',
      message: secret,
      detail: secret,
      hint: secret,
      query: secret,
      parameters: [secret],
    }),
  );
  assert.deepEqual(safe, {
    sqlstate: '55P03',
    exception: 'PostgresError',
    applicationCode: null,
  });
  assert.equal(
    scalableProfileCiSafeError({ code: 'ABCDE' }).sqlstate,
    'other-sqlstate',
  );
  assert.equal(scalableProfileCiSafeError({ code: secret }).sqlstate, null);
  assert.equal(
    scalableProfileCiSafeError(new ApplicationError('SAFETY_UNAVAILABLE'))
      .applicationCode,
    'SAFETY_UNAVAILABLE',
  );
  const lock = scalableProfileCiSafeLock({
    reader_pid: 123,
    blocking_pids: [456, secret, -1, 0, NaN, Infinity, 1.5, 2147483648, 789],
    pid: 456,
    relation: secret,
    mode: secret,
    locktype: secret,
    granted: false,
    query: secret,
    transactionid: secret,
    classid: secret,
    objid: secret,
    page: secret,
    tuple: secret,
  });
  assert.deepEqual(lock, {
    readerPid: 123,
    blockingPids: [456],
    pid: 456,
    relation: 'other-relation',
    mode: 'other-mode',
    locktype: 'other-locktype',
    granted: false,
  });
  assert.equal(
    scalableProfileCiSafeLock({ pid: '123', granted: 'true' }).pid,
    null,
  );
  assert.equal(scalableProfileCiSafeLock({ pid: 2147483648 }).pid, null);
  for (const relation of [
    'whaleu_safety.blocks',
    'whaleu_safety.blocks_pkey',
    'whaleu_safety.blocks_blocker_id_blocked_id_key',
    'whaleu_safety.blocks_id_blocker_id_key',
    'whaleu_safety.blocks_own_active',
    'whaleu_safety.blocks_reverse_active',
  ])
    assert.equal(scalableProfileCiSafeLock({ relation }).relation, relation);
  for (const relation of ['private.blocks', 'blocks', 'whaleu_safety.accounts'])
    assert.equal(
      scalableProfileCiSafeLock({ relation }).relation,
      'other-relation',
    );
  assert.equal(JSON.stringify({ safe, lock }).includes(secret), false);
  for (const field of [
    'message',
    'stack',
    'detail',
    'hint',
    'query',
    'parameters',
  ])
    assert.equal(Object.hasOwn(safe, field), false);
  for (const field of [
    'query',
    'transactionid',
    'classid',
    'objid',
    'page',
    'tuple',
  ])
    assert.equal(Object.hasOwn(lock, field), false);
});

test('scalable Profile diagnostics normalize bounded settings results', () => {
  for (const [value, expected] of [
    ['0', 0],
    ['1ms', 1],
    ['100ms', 100],
    ['0.5s', 500],
    ['1min', 60000],
  ] as const)
    assert.equal(scalableProfileCiTimeoutMs(value), expected);
  for (const value of [
    null,
    {},
    1,
    '-1ms',
    'Infinity',
    '2e3',
    'secret',
    '999999999999999999999ms',
  ])
    assert.equal(scalableProfileCiTimeoutMs(value), null);
});

test('scalable Profile diagnostics identify Safety and optional phases', () => {
  const state = {
    final: false,
    safety: false,
    optionalCount: false,
    optionalFinal: false,
  };
  const settings =
    "SELECT current_setting('transaction_isolation') AS isolation,\n" +
    "current_setting('statement_timeout') AS statement_timeout,\n" +
    "current_setting('lock_timeout') AS lock_timeout";
  assert.equal(scalableProfileCiPhase(settings, state), 'first-profile');
  assert.equal(
    scalableProfileCiPhase('SAVEPOINT discovery_optional_count', state),
    'optional-count-scan',
  );
  assert.equal(
    scalableProfileCiPhase('RELEASE SAVEPOINT discovery_optional_count', state),
    'optional-count-scan',
  );
  assert.equal(
    scalableProfileCiPhase('SET CONSTRAINTS ALL IMMEDIATE', state),
    'constraints',
  );
  assert.equal(scalableProfileCiPhase(settings, state), 'safety-settings');
  assert.equal(
    scalableProfileCiPhase(
      'LOCK TABLE whaleu_safety.blocks IN SHARE MODE NOWAIT',
      state,
    ),
    'safety-table-fence',
  );
  assert.equal(
    scalableProfileCiPhase(
      `SELECT r.ordinality::integer AS ordinal,
      ignored FROM ignored LEFT JOIN whaleu_safety.blocks outgoing
      ignored LEFT JOIN whaleu_safety.blocks incoming`,
      state,
    ),
    'safety-batch',
  );
  assert.equal(
    scalableProfileCiPhase('SAVEPOINT optional_final_count_proof', state),
    'optional-final-proof',
  );
  assert.equal(scalableProfileCiPhase(settings, state), 'optional-final-proof');
  assert.equal(scalableProfileCiPhase('ROLLBACK', state), 'rollback');
});

test('scalable Profile diagnostics cap JSON and preserve newest failures', () => {
  const snapshot = empty();
  snapshot.recent = Array.from({ length: 128 }, (_, index) => ({
    transaction: index + 1,
    backendPid: 123,
    phase: 'safety-settings',
    boundary: 'query',
    elapsedMs: 1.234,
    outcome: 'ok',
    error: null,
    settings: {
      source: 'existing-settings-read',
      statementMs: 100,
      lockMs: 1,
    },
  }));
  snapshot.failures = Array.from({ length: 16 }, (_, index) => ({
    transaction: index + 1,
    backendPid: 123,
    phase: 'safety-batch',
    boundary: 'query',
    elapsedMs: 1.234,
    outcome: 'error',
    error: scalableProfileCiSafeError({ code: '55P03' }),
    settings: null,
  }));
  snapshot.samples = Array.from({ length: 16 }, () => ({
    phaseAtStart: 'safety-batch',
    phaseAtEnd: 'rollback',
    elapsedMs: 2.345,
    outcome: 'ok',
    error: null,
    truncated: false,
    locks: Array.from({ length: 32 }, () =>
      scalableProfileCiSafeLock({
        reader_pid: 123,
        blocking_pids: [456],
        pid: 456,
        relation: 'whaleu_safety.blocks_blocker_id_blocked_id_key',
        mode: 'AccessExclusiveLock',
        locktype: 'relation',
        granted: true,
      }),
    ),
  }));
  assert.ok(
    Buffer.byteLength(JSON.stringify(snapshot)) > SCALABLE_PROFILE_CI_MAX_BYTES,
  );
  const result = boundedScalableProfileCiSnapshot(snapshot);
  assert.ok(
    Buffer.byteLength(JSON.stringify(result)) <= SCALABLE_PROFILE_CI_MAX_BYTES,
  );
  assert.equal(result.truncated, true);
  assert.equal(result.failures.length, 16);
  assert.deepEqual(result.failures.at(-1), snapshot.failures.at(-1));
  assert.ok(result.dropped.samples > 0);
  assert.equal(snapshot.recent.length, 128);
  assert.equal(snapshot.samples.length, 16);
  const dropped = boundedScalableProfileCiSnapshot(empty(), {
    recent: 10,
    failures: 2,
    samples: 3,
  });
  assert.equal(dropped.truncated, true);
  assert.deepEqual(dropped.dropped, { recent: 10, failures: 2, samples: 3 });
  assert.equal(
    boundedScalableProfileCiSnapshot(empty()).observer.blockerEvidence,
    'unknown',
  );
});

test('disabled Profile diagnostics do not touch dependencies or retry', async () => {
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw new Error('must not access');
      },
    },
  );
  let calls = 0;
  const actual = await observeFirstScalableProfile(
    forbidden as Parameters<typeof observeFirstScalableProfile>[0],
    forbidden as Parameters<typeof observeFirstScalableProfile>[1],
    {
      enabled: false,
      emit: () => {
        throw new Error('must not emit');
      },
    },
    async () => {
      calls++;
      return 42;
    },
  );
  assert.equal(actual, 42);
  assert.equal(calls, 1);
});
