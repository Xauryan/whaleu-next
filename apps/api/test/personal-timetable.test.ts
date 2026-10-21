import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import type { DatabaseService } from '../src/database/database.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { withAccountPunishmentPolicy } from '../src/safety/account-policy/punishment-context.js';
import { observeAuthenticatedSession } from '../src/http/session-policy-context.js';
import { PersonalTimetableRepository } from '../src/personal-timetable/repository.js';
import { PersonalTimetableService } from '../src/personal-timetable/service.js';
import {
  isTimetableMonday,
  timetableCommandSchema,
  timetableReceiptSchema,
  timetableIntentHash,
  canonicalTimetableCommand,
  timetableReceipt,
} from '../src/personal-timetable/contracts.js';
import type {
  TimetableCommand,
  TimetableReceipt,
} from '../src/personal-timetable/contracts.js';
const term = {
  name: '秋季学期',
  weekOneMonday: '2026-09-07',
  weekCount: 20,
  timeZone: 'Asia/Shanghai' as const,
};
const entry = {
  name: '数学',
  teacher: '张老师',
  location: 'A101',
  note: '自带材料\n第1页\t练习',
  dayOfWeek: 1,
  startMinute: 480,
  endMinute: 530,
  weeks: [1, 3, 5],
  color: 'blue' as const,
};
const create = (): Extract<TimetableCommand, { operation: 'term.create' }> => ({
  version: 1,
  requestId: randomUUID(),
  operation: 'term.create',
  termId: randomUUID(),
  expectedRevision: 0,
  payload: term,
});
test('private timetable strict civil Monday, minute/week/text/color and union boundaries', () => {
  for (const date of ['1900-01-01', '2024-02-26', '2026-09-07', '2199-12-30'])
    assert.equal(isTimetableMonday(date), true, date);
  for (const date of [
    '2026-02-30',
    '2026-09-08',
    '2200-01-06',
    '2026-9-07',
    '2024-02-29',
  ])
    assert.equal(isTimetableMonday(date), false, date);
  const c = create();
  assert.deepEqual(timetableCommandSchema.parse(c), c);
  for (const patch of [
    { version: 2 },
    { accountId: randomUUID() },
    { requestId: 'not-uuid' },
    { expectedRevision: 1 },
    { entryId: randomUUID() },
    { payload: { ...term, name: ' padded ' } },
    { payload: { ...term, timeZone: 'UTC' } },
    { payload: { ...term, weekCount: 31 } },
  ])
    assert.equal(
      timetableCommandSchema.safeParse({ ...c, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  const e = {
    ...c,
    operation: 'entry.create',
    expectedRevision: 1,
    entryId: randomUUID(),
    payload: entry,
  };
  assert.equal(timetableCommandSchema.safeParse(e).success, true);
  for (const patch of [
    { startMinute: 530 },
    { endMinute: 1441 },
    { dayOfWeek: 0 },
    { weeks: [] },
    { weeks: [2, 1] },
    { weeks: [1, 1] },
    { weeks: [31] },
    { name: 'x'.repeat(121) },
    { teacher: ' x' },
    { location: 'x\ny' },
    { note: 'a\rb' },
    { note: '\ud800' },
    { name: '\udfff' },
    { note: 'a\u200bb' },
    { color: '#ffffff' },
  ])
    assert.equal(
      timetableCommandSchema.safeParse({
        ...e,
        payload: { ...entry, ...patch },
      }).success,
      false,
      JSON.stringify(patch),
    );
  assert.equal(
    timetableCommandSchema.safeParse({
      ...e,
      payload: { ...entry, startMinute: 0, endMinute: 1440, weeks: [1, 30] },
    }).success,
    true,
  );
  assert.equal(
    timetableCommandSchema.safeParse({
      ...c,
      operation: 'term.delete',
      expectedRevision: 1,
      payload: {},
    }).success,
    true,
  );
});
test('canonical full intent fixes ordering without normalizing; receipts never retain payload', () => {
  const c = create(),
    canonical = canonicalTimetableCommand(c);
  assert.equal(
    canonical,
    JSON.stringify({
      version: 1,
      requestId: c.requestId,
      operation: 'term.create',
      termId: c.termId,
      expectedRevision: 0,
      payload: term,
    }),
  );
  assert.equal(
    timetableIntentHash({
      ...c,
      payload: {
        timeZone: term.timeZone,
        weekCount: 20,
        weekOneMonday: term.weekOneMonday,
        name: term.name,
      },
    }),
    timetableIntentHash(c),
  );
  assert.notEqual(
    timetableIntentHash({ ...c, payload: { ...term, name: '另一学期' } }),
    timetableIntentHash(c),
  );
  const receipt = timetableReceipt(c, 'applied', 1);
  assert.equal(receipt.intentHash, timetableIntentHash(c));
  assert.ok(!JSON.stringify(receipt).includes(term.name));
  assert.equal(
    timetableReceiptSchema.safeParse({ ...receipt, resultingRevision: 2 })
      .success,
    false,
  );
  assert.equal(
    timetableReceiptSchema.safeParse({ ...receipt, payload: term }).success,
    false,
  );
  assert.equal(
    timetableReceiptSchema.safeParse({ ...receipt, outcome: 'rejected' })
      .success,
    false,
  );
});
function fixture() {
  const account = randomUUID(),
    sessionId = randomUUID(),
    receipts = new Map<string, TimetableReceipt>();
  let applied = 0,
    denied = false,
    expired = false,
    failSave = false,
    revoked = false;
  let denyAfterLock = false;
  const calls: string[] = [];
  const tx = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith('SELECT least('))
        return { rows: [{ until: '2099-01-01T00:00:00Z' }] };
      if (sql.startsWith('WITH instant'))
        return { rows: [{ now: new Date(), expired: expired ? ['1'] : [] }] };
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') return { rows: [] };
      throw new Error(`Unexpected SQL ${sql}`);
    },
  } as unknown as PoolClient;
  const db = {
    transaction: async <T>(
      run: (t: PoolClient) => Promise<T>,
      options: unknown,
    ) => {
      assert.deepEqual(options, { isolationLevel: 'read committed' });
      const saved = new Map(receipts),
        n = applied;
      startTransactionDeadlines(tx);
      try {
        return await withAccountPunishmentPolicy(
          tx,
          {
            enforce: async (_a, action) => {
              calls.push(`policy:${action}`);
              if (denied) throw new ApplicationError('SAFETY_ACCESS_SUSPENDED');
            },
          },
          async () => {
            const result = await run(tx);
            await checkTransactionDeadlines(tx);
            return result;
          },
        );
      } catch (e) {
        receipts.clear();
        for (const [k, v] of saved) receipts.set(k, v);
        applied = n;
        throw e;
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as DatabaseService;
  const identity = {
    session: async () => {
      calls.push('session');
      if (revoked) throw new ApplicationError('SESSION_REVOKED');
      const view = {
        accountId: account,
        sessionId,
        expiresAt: 4e12,
        refreshExpiresAt: 4e12,
      };
      await observeAuthenticatedSession(view, tx);
      return view;
    },
  } as unknown as IdentityService;
  const repository = {
    lock: async () => {
      calls.push('ownerlock');
      if (denyAfterLock) denied = true;
    },
    terms: async () => [],
    term: async () => null,
    entries: async () => [],
    recover: async (_a: string, id: string) => receipts.get(id) ?? null,
    previous: async (_a: string, c: TimetableCommand) => {
      const r = receipts.get(c.requestId);
      if (r && r.intentHash !== timetableIntentHash(c))
        throw new ApplicationError('TIMETABLE_REQUEST_CONFLICT');
      return r ?? null;
    },
    apply: async (_a: string, c: TimetableCommand) => {
      applied++;
      return timetableReceipt(c, 'applied', c.expectedRevision + 1);
    },
    save: async (_a: string, r: TimetableReceipt) => {
      if (failSave) throw new Error('Injected receipt persistence failure');
      receipts.set(r.requestId, r);
      return r;
    },
  } as unknown as PersonalTimetableRepository;
  const service = new PersonalTimetableService(db, identity, repository);
  return {
    service,
    receipts,
    calls,
    applied: () => applied,
    setDenied: (v: boolean) => (denied = v),
    setDenyAfterLock: () => (denyAfterLock = true),
    setExpired: (v: boolean) => (expired = v),
    setFailSave: (v: boolean) => (failSave = v),
    setRevoked: (v: boolean) => (revoked = v),
  };
}
test('exact original receipts precede eligibility, changed hash conflicts, cancellation never rolls back', async () => {
  const f = fixture(),
    c = create(),
    first = await f.service.execute('token', c);
  assert.equal(first.outcome, 'applied');
  assert.equal(f.applied(), 1);
  assert.ok(
    f.calls.indexOf('ownerlock') <
      f.calls.indexOf('policy:private_self_service'),
  );
  f.setDenied(true);
  assert.deepEqual(await f.service.execute('token', c), first);
  assert.deepEqual(await f.service.cancel('token', c.requestId, c), first);
  assert.equal(f.applied(), 1);
  await assert.rejects(
    f.service.execute('token', { ...c, payload: { ...term, name: 'changed' } }),
    (e) => (e as ApplicationError).code === 'TIMETABLE_REQUEST_CONFLICT',
  );
  assert.deepEqual(await f.service.recover('token', c.requestId), {
    status: 'settled',
    receipt: first,
  });
  const future = create();
  assert.deepEqual(await f.service.recover('token', future.requestId), {
    status: 'unknown',
    requestId: future.requestId,
  });
  const cancelled = await f.service.cancel('token', future.requestId, future);
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(cancelled.resultingRevision, null);
  f.setDenied(false);
  assert.deepEqual(await f.service.execute('token', future), cancelled);
  assert.equal(f.applied(), 1);
});
test('suspension denies fresh private data/write but permits minimal recovery; revocation never recovers', async () => {
  const f = fixture();
  f.setDenied(true);
  const c = create();
  const r = await f.service.execute('token', c);
  assert.equal(r.code, 'SAFETY_ACCESS_SUSPENDED');
  assert.equal(r.resultingRevision, null);
  assert.equal(f.applied(), 0);
  await assert.rejects(
    f.service.list('token'),
    (e) => (e as ApplicationError).code === 'SAFETY_ACCESS_SUSPENDED',
  );
  assert.equal(
    (await f.service.recover('token', c.requestId)).status,
    'settled',
  );
  f.setRevoked(true);
  await assert.rejects(
    f.service.recover('token', c.requestId),
    (e) => (e as ApplicationError).code === 'SESSION_REVOKED',
  );
});
test('receipt persistence failure and deadline after ownerlock both roll back effects and requests', async () => {
  const f = fixture(),
    c = create();
  f.setFailSave(true);
  await assert.rejects(
    f.service.execute('token', c),
    (e) => (e as ApplicationError).code === 'TIMETABLE_UNAVAILABLE',
  );
  assert.equal(f.applied(), 0);
  assert.equal(f.receipts.size, 0);
  f.setFailSave(false);
  f.setExpired(true);
  await assert.rejects(
    f.service.execute('token', c),
    (e) => (e as ApplicationError).code === 'ACCESS_TOKEN_EXPIRED',
  );
  assert.equal(f.applied(), 0);
  assert.equal(f.receipts.size, 0);
  f.setExpired(false);
  assert.equal((await f.service.execute('token', c)).outcome, 'applied');
});

test('private reads recheck punishment after ownerlock and enforce final exact expiry', async () => {
  const changed = fixture();
  changed.setDenyAfterLock();
  await assert.rejects(
    changed.service.list('token'),
    (e) => (e as ApplicationError).code === 'SAFETY_ACCESS_SUSPENDED',
  );
  assert.equal(
    changed.calls.filter((v) => v === 'policy:private_self_service').length,
    2,
  );
  const expired = fixture();
  expired.setExpired(true);
  await assert.rejects(
    expired.service.list('token'),
    (e) => (e as ApplicationError).code === 'ACCESS_TOKEN_EXPIRED',
  );
});

test('repository CAS, deleted ID reuse, quota and week failures have no write effect', async () => {
  const repository = new PersonalTimetableRepository();
  const c = create();
  const account = randomUUID();
  const current = { ...term, termId: c.termId, revision: 1 };
  repository.term = async () => current;
  repository.terms = async () => Array.from({ length: 32 }, () => current);
  repository.entries = async () => [
    { ...entry, entryId: randomUUID(), termId: c.termId, weeks: [20] },
  ];
  let existing = false;
  const queries: string[] = [];
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      queries.push(sql);
      assert.equal(values[0], account);
      assert.ok(sql.includes('account_id=$1'));
      return { rows: [], rowCount: existing ? 1 : 0 };
    },
  } as unknown as PoolClient;
  assert.equal(
    (await repository.apply(account, c, tx)).code,
    'TIMETABLE_TERM_LIMIT',
  );
  existing = true;
  assert.equal(
    (await repository.apply(account, c, tx)).code,
    'TIMETABLE_ID_REUSED',
  );
  const update: TimetableCommand = {
    ...c,
    operation: 'term.update',
    expectedRevision: 2,
    payload: term,
  };
  assert.equal(
    (await repository.apply(account, update, tx)).code,
    'TIMETABLE_REVISION_CONFLICT',
  );
  assert.equal(
    (
      await repository.apply(
        account,
        { ...update, expectedRevision: 1, payload: { ...term, weekCount: 19 } },
        tx,
      )
    ).code,
    'TIMETABLE_WEEKS_OUT_OF_RANGE',
  );
  current.revision = 2147483647;
  assert.equal(
    (
      await repository.apply(
        account,
        { ...update, expectedRevision: 2147483647 },
        tx,
      )
    ).code,
    'TIMETABLE_REVISION_CONFLICT',
  );
  assert.ok(queries.every((sql) => sql.startsWith('SELECT')));
});

test('cancelled receipt cannot assert a resulting state revision', () => {
  const command = create();
  const cancelled = timetableReceipt(command, 'cancelled', null);
  assert.equal(timetableReceiptSchema.parse(cancelled).resultingRevision, null);
  for (const resultingRevision of [1, 2, 2147483647]) {
    assert.equal(
      timetableReceiptSchema.safeParse({ ...cancelled, resultingRevision })
        .success,
      false,
    );
    assert.throws(() =>
      timetableReceipt(command, 'cancelled', resultingRevision),
    );
  }
});
