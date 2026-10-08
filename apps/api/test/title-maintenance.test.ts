import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../src/database/database.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type { AuthorizationService } from '../src/authorization/authorization.service.js';
import {
  ApplicationError,
  TitleMaintenanceContinuationConflict,
} from '../src/http/application-error.js';
import {
  maintenanceSchema,
  maintenanceIntentHash,
  maintenanceTitleKeys,
} from '../src/experience/maintenance.contracts.js';
import type {
  MaintenanceIntent,
  MaintenanceReceipt,
} from '../src/experience/maintenance.contracts.js';
import {
  ExperienceTitleMaintenanceService,
  maintenanceTimeout,
} from '../src/experience/maintenance.service.js';
import { TitleMaintenanceRepository } from '../src/experience/maintenance.repository.js';
import type {
  MaintenanceDecision,
  MaintenanceRequestRow,
} from '../src/experience/maintenance.repository.js';
import { ExperienceRepository } from '../src/experience/repository.js';

const start = (): MaintenanceIntent => ({
  requestId: randomUUID(),
  operation: 'repair_level_titles',
});
const at = new Date('2026-10-08T00:00:00Z');
function receipt(input: MaintenanceIntent): MaintenanceReceipt {
  return {
    requestId: input.requestId,
    operation: 'repair_level_titles',
    runId: input.requestId,
    previousRequestId: null,
    visited: 1,
    updatedOwners: 0,
    grantedTitles: 0,
    skippedUnknownLevel: 1,
    skippedIneligible: 0,
    done: false,
  };
}
function row(input: MaintenanceIntent): MaintenanceRequestRow {
  return {
    actor_id: 'actor',
    request_id: input.requestId,
    intent_hash: maintenanceIntentHash(input),
    operation: 'repair_level_titles',
    run_id: input.requestId,
    previous_request_id: null,
    run_started_at: at,
    upper_account_id: 'z',
    cursor_before: null,
    cursor_after: 'a',
    receipt: receipt(input),
  };
}
function harness(
  options: {
    candidates?: string[];
    balance?: string | null;
    eligible?: boolean;
    owned?: string[];
    prior?: MaintenanceRequestRow;
    previous?: MaintenanceRequestRow;
    successor?: string;
    deny?: boolean;
    finalizeError?: boolean;
    queryError?: string;
    constraint?: string;
  } = {},
) {
  const events: string[] = [],
    saves: MaintenanceDecision[] = [],
    sql: string[] = [];
  const tx = {
    query: async (query: string) => {
      sql.push(query);
      if (options.queryError)
        throw { code: options.queryError, constraint: options.constraint };
      if (query.includes('current_setting'))
        return {
          rows: [
            { statement_timeout: '100ms', lock_timeout: '100ms', now: at },
          ],
          rowCount: 1,
        };
      if (query.includes('owners')) events.push('owner');
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => {
      const result = await fn(tx);
      events.push('finalize');
      if (options.finalizeError)
        throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
      return result;
    },
  } as DatabaseService;
  const identity = {
    session: async () => {
      events.push('session');
      return { accountId: 'actor', sessionId: 'session' };
    },
    beginTitleMaintenanceSweep: async () => {
      events.push('begin');
      return { runStartedAt: at, upperAccountId: 'z' };
    },
    titleMaintenanceCandidateWindow: async (boundary: unknown) => {
      events.push(`window:${JSON.stringify(boundary)}`);
      return options.candidates ?? ['a', 'b'];
    },
    lockTitleMaintenanceAccount: async () => {
      events.push('identity');
      return true;
    },
    canonicalWechatTitleEligibility: async () => {
      events.push('provider');
      return options.eligible ?? true;
    },
  } as unknown as IdentityService;
  const authority = {
    requireGlobalTitleMaintenance: async () => {
      events.push('authority');
      if (options.deny) throw new ApplicationError('AUTHORIZATION_REQUIRED');
      return { id: 'grant' };
    },
  } as unknown as AuthorizationService;
  const records = new ExperienceRepository();
  records.state = async () => {
    events.push('state');
    return options.balance == null
      ? null
      : {
          owner_id: 'a',
          balance: options.balance,
          revision: '12',
          last_signin_day: null,
          streak: 0,
          history_coverage: 'partial',
          entitlement_coverage: 'partial',
        };
  };
  const maintenance = new TitleMaintenanceRepository();
  maintenance.requestLock = async () => {
    events.push('request-lock');
  };
  maintenance.request = async (_actor, _request, _tx, lock) => {
    events.push(lock ? 'previous' : 'request');
    return lock ? (options.previous ?? null) : (options.prior ?? null);
  };
  maintenance.successor = async () => options.successor ?? null;
  maintenance.missingTitles = async (_owner, keys) => {
    events.push('titles');
    return keys.filter((key) => !options.owned?.includes(key));
  };
  maintenance.save = async (decision) => {
    events.push('save');
    saves.push(decision);
  };
  return {
    service: new ExperienceTitleMaintenanceService(
      database,
      identity,
      authority,
      records,
      maintenance,
    ),
    events,
    saves,
    sql,
  };
}

test('maintenance command only accepts exact start/continuation intent and normalized UUIDv4', () => {
  const requestId = randomUUID(),
    previousRequestId = randomUUID();
  assert.deepEqual(
    maintenanceSchema.parse({
      requestId: requestId.toUpperCase(),
      operation: 'repair_default_title',
    }),
    { requestId, operation: 'repair_default_title' },
  );
  assert.deepEqual(maintenanceSchema.parse({ requestId, previousRequestId }), {
    requestId,
    previousRequestId,
  });
  for (const extra of [
    { targetId: randomUUID() },
    { titleKey: 'role_admin' },
    { role: 'developer' },
    { limit: 100 },
    { cursor: 'a' },
    { grantId: randomUUID() },
    { earnedAt: at.toISOString() },
    { previousRequestId },
  ])
    assert.equal(
      maintenanceSchema.safeParse({
        requestId,
        operation: 'repair_level_titles',
        ...extra,
      }).success,
      false,
    );
  for (const bad of [
    { requestId },
    { requestId, operation: 'grant_title' },
    { requestId: 'not-a-uuid', previousRequestId },
  ])
    assert.equal(maintenanceSchema.safeParse(bad).success, false);
});
test('canonical intent distinguishes operation/continuation but excludes request ID', () => {
  const input = start();
  assert.equal(
    maintenanceIntentHash(input),
    maintenanceIntentHash({ ...input, requestId: randomUUID() }),
  );
  assert.notEqual(
    maintenanceIntentHash(input),
    maintenanceIntentHash({
      requestId: input.requestId,
      operation: 'repair_default_title',
    }),
  );
  assert.notEqual(
    maintenanceIntentHash(input),
    maintenanceIntentHash({
      requestId: input.requestId,
      previousRequestId: randomUUID(),
    }),
  );
});
test('compiled repair allowlist handles unknown, known zero, odd/even thresholds and bigint without special grants', () => {
  assert.deepEqual(maintenanceTitleKeys('repair_level_titles', null, true), []);
  assert.deepEqual(maintenanceTitleKeys('repair_level_titles', '0', true), [
    'level_1',
  ]);
  assert.deepEqual(maintenanceTitleKeys('repair_level_titles', '15', true), [
    'level_1',
  ]);
  assert.deepEqual(maintenanceTitleKeys('repair_level_titles', '40', true), [
    'level_1',
    'level_3',
  ]);
  const all = maintenanceTitleKeys(
    'repair_level_titles',
    '9223372036854775807',
    true,
  );
  assert.equal(all.length, 15);
  assert.ok(all.every((key) => key.startsWith('level_')));
  assert.deepEqual(maintenanceTitleKeys('repair_default_title', null, true), [
    'default_jingxiaoyu',
  ]);
  assert.deepEqual(
    maintenanceTitleKeys('repair_default_title', '9223372036854775807', false),
    [],
  );
});
test('one owner and exact lock sequence; unknown never creates state/history and receipt excludes identity', async () => {
  const h = harness();
  const result = await h.service.batch('token', start());
  assert.equal(result.visited, 1);
  assert.equal(result.skippedUnknownLevel, 1);
  assert.equal(result.done, false);
  assert.deepEqual(h.events.slice(0, 5), [
    'session',
    'authority',
    'request-lock',
    'request',
    'begin',
  ]);
  assert.ok(h.events.indexOf('identity') < h.events.indexOf('owner'));
  assert.ok(h.events.indexOf('owner') < h.events.indexOf('state'));
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0]?.cursorAfter, 'a');
  assert.deepEqual(h.saves[0]?.item?.grantedTitleKeys, []);
  assert.ok(
    h.sql.every(
      (query) =>
        !/baselines|account_states|appearance|records|notices/.test(query),
    ),
  );
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      'requestId',
      'operation',
      'runId',
      'previousRequestId',
      'visited',
      'updatedOwners',
      'grantedTitles',
      'skippedUnknownLevel',
      'skippedIneligible',
      'done',
    ].sort(),
  );
});
test('level repair grants all missing qualifying keys only, preserving owned higher titles and partial state', async () => {
  const h = harness({ balance: '1150', owned: ['level_1', 'level_29'] });
  const result = await h.service.batch('token', start());
  assert.equal(result.grantedTitles, 5);
  assert.equal(result.updatedOwners, 1);
  assert.deepEqual(h.saves[0]?.item?.grantedTitleKeys, [
    'level_11',
    'level_3',
    'level_5',
    'level_7',
    'level_9',
  ]);
  assert.equal(h.saves[0]?.item?.knownBalance, '1150');
  assert.equal(h.saves[0]?.item?.stateRevision, '12');
});
test('default repair independent of unknown balance and explicit ineligible skip', async () => {
  for (const eligible of [true, false]) {
    const h = harness({ eligible });
    const result = await h.service.batch('token', {
      requestId: randomUUID(),
      operation: 'repair_default_title',
    });
    assert.equal(result.grantedTitles, Number(eligible));
    assert.equal(result.skippedIneligible, Number(!eligible));
    assert.ok(h.events.indexOf('provider') < h.events.indexOf('owner'));
    assert.ok(!h.events.includes('state'));
    assert.equal(h.saves[0]?.item?.knownBalance, null);
  }
});
test('empty and last batches close the finite sweep with exact batch-local counts', async () => {
  for (const candidates of [[], ['a']]) {
    const h = harness({ candidates, balance: '0' });
    const result = await h.service.batch('token', start());
    assert.equal(result.done, true);
    assert.equal(result.visited, candidates.length);
    assert.equal(h.saves[0]?.cursorAfter, candidates[0] ?? null);
  }
});
test('same-intent replay is immutable but still session/authority authenticated; mismatched intent conflicts', async () => {
  const input = start(),
    prior = row(input),
    h = harness({ prior });
  assert.deepEqual(await h.service.batch('token', input), prior.receipt);
  assert.equal(h.saves.length, 0);
  assert.deepEqual(h.events, [
    'session',
    'authority',
    'request-lock',
    'request',
    'finalize',
  ]);
  await assert.rejects(
    h.service.batch('token', {
      requestId: input.requestId,
      operation: 'repair_default_title',
    }),
    { code: 'EXPERIENCE_MAINTENANCE_REQUEST_CONFLICT' },
  );
  await assert.rejects(
    harness({ prior, deny: true }).service.batch('token', input),
    { code: 'AUTHORIZATION_REQUIRED' },
  );
});
test('continuation takes all sweep facts from locked predecessor; actor missing predecessor fails', async () => {
  const previous = row(start()),
    h = harness({ previous, candidates: ['b'] });
  const result = await h.service.batch('token', {
    requestId: randomUUID(),
    previousRequestId: previous.request_id,
  });
  assert.equal(result.runId, previous.run_id);
  assert.equal(result.previousRequestId, previous.request_id);
  assert.equal(h.saves[0]?.cursorBefore, 'a');
  assert.equal(h.saves[0]?.cursorAfter, 'b');
  assert.ok(!h.events.includes('begin'));
  await assert.rejects(
    harness().service.batch('token', {
      requestId: randomUUID(),
      previousRequestId: previous.request_id,
    }),
    { code: 'EXPERIENCE_MAINTENANCE_REQUEST_NOT_FOUND' },
  );
});
test('consumed predecessor only exposes successor after fresh finalization; expiry hides metadata', async () => {
  const previous = row(start()),
    successor = randomUUID(),
    input = { requestId: randomUUID(), previousRequestId: previous.request_id };
  const h = harness({ previous, successor });
  await assert.rejects(
    h.service.batch('token', input),
    (error: unknown) =>
      error instanceof TitleMaintenanceContinuationConflict &&
      error.successorRequestId === successor,
  );
  assert.equal(h.events.at(-1), 'finalize');
  assert.equal(h.saves.length, 0);
  await assert.rejects(
    harness({ previous, successor, finalizeError: true }).service.batch(
      'token',
      input,
    ),
    { code: 'AUTHORIZATION_UNAVAILABLE' },
  );
});
test('GET recovery reauthorizes without executing a sweep; missing actor-bound request denied', async () => {
  const prior = row(start()),
    h = harness({ prior });
  assert.deepEqual(
    await h.service.receipt('token', prior.request_id),
    prior.receipt,
  );
  assert.deepEqual(h.events, ['session', 'authority', 'request', 'finalize']);
  await assert.rejects(
    harness({ prior, deny: true }).service.receipt('token', prior.request_id),
    { code: 'AUTHORIZATION_REQUIRED' },
  );
  await assert.rejects(harness().service.receipt('token', prior.request_id), {
    code: 'EXPERIENCE_MAINTENANCE_REQUEST_NOT_FOUND',
  });
});
test('only bounded-lock operational errors map to maintenance unavailable; proof errors remain errors', async () => {
  for (const queryError of ['55P03', '40P01', '57014'])
    await assert.rejects(
      harness({ queryError }).service.batch('token', start()),
      { code: 'EXPERIENCE_MAINTENANCE_UNAVAILABLE' },
    );
  await assert.rejects(
    harness({ queryError: '23514' }).service.batch('token', start()),
    { code: '23514' },
  );
});

test('receipt-state conflicts and missing results never bypass fresh finalization', async () => {
  const input = start(),
    prior = row(input);
  await assert.rejects(
    harness({ prior, finalizeError: true }).service.batch('token', {
      requestId: input.requestId,
      operation: 'repair_default_title',
    }),
    { code: 'AUTHORIZATION_UNAVAILABLE' },
  );
  await assert.rejects(
    harness({ finalizeError: true }).service.batch('token', {
      requestId: randomUUID(),
      previousRequestId: randomUUID(),
    }),
    { code: 'AUTHORIZATION_UNAVAILABLE' },
  );
  const previous = { ...prior, receipt: { ...prior.receipt, done: true } };
  await assert.rejects(
    harness({ previous, finalizeError: true }).service.batch('token', {
      requestId: randomUUID(),
      previousRequestId: previous.request_id,
    }),
    { code: 'AUTHORIZATION_UNAVAILABLE' },
  );
  await assert.rejects(
    harness({ finalizeError: true }).service.receipt('token', randomUUID()),
    { code: 'AUTHORIZATION_UNAVAILABLE' },
  );
});

test('repository writes normalized proof before entitlement and uses exact database repair time', async () => {
  const queries: { sql: string; args: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, args: unknown[]) => {
      queries.push({ sql, args });
      return { rows: [{ decided_at: at }], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const r = receipt(start());
  r.grantedTitles = 1;
  r.updatedOwners = 1;
  r.skippedUnknownLevel = 0;
  await new TitleMaintenanceRepository().save(
    {
      actorId: 'actor',
      sessionId: 'session',
      grantId: 'grant',
      intentHash: 'hash',
      runStartedAt: at,
      upperAccountId: 'owner',
      cursorBefore: null,
      cursorAfter: 'owner',
      receipt: r,
      item: {
        ownerId: 'owner',
        eligible: true,
        knownBalance: '0',
        stateRevision: '0',
        observedLevel: 1,
        outcome: 'repaired',
        grantedTitleKeys: ['level_1'],
      },
    },
    tx,
  );
  assert.equal(queries.length, 4);
  assert.ok(queries[0]?.sql.includes('maintenance_requests'));
  assert.ok(queries[1]?.sql.includes('maintenance_items'));
  assert.ok(queries[2]?.sql.includes('maintenance_grants'));
  assert.ok(queries[3]?.sql.includes('entitlements'));
  assert.equal(queries[1]?.args.at(-1), at);
  assert.equal(queries[3]?.args.at(-1), at);
  assert.ok(queries.every((q) => !/UPDATE|DELETE|ON CONFLICT/.test(q.sql)));
});

test('maintenance timeouts cap zero/long defaults without relaxing inherited stricter settings', () => {
  assert.equal(maintenanceTimeout('100ms', 3000), '100ms');
  assert.equal(maintenanceTimeout('2s', 3000), '2000ms');
  assert.equal(maintenanceTimeout('10s', 3000), '3000ms');
  assert.equal(maintenanceTimeout('0', 5000), '5000ms');
  assert.throws(() => maintenanceTimeout('unexpected', 3000), {
    code: 'EXPERIENCE_MAINTENANCE_UNAVAILABLE',
  });
});

test('SQL expiry fences map narrowly without disguising forged proof constraints', async () => {
  for (const [constraint, code] of [
    ['maintenance_session_expired', 'ACCESS_TOKEN_EXPIRED'],
    ['maintenance_authorization_expired', 'AUTHORIZATION_UNAVAILABLE'],
  ] as const)
    await assert.rejects(
      harness({ queryError: '23514', constraint }).service.batch(
        'token',
        start(),
      ),
      { code },
    );
  await assert.rejects(
    harness({
      queryError: '23514',
      constraint: 'maintenance_proof',
    }).service.batch('token', start()),
    { code: '23514' },
  );
  await assert.rejects(
    harness({
      queryError: '23503',
      constraint: 'maintenance_session_expired',
    }).service.batch('token', start()),
    { code: '23503' },
  );
});
