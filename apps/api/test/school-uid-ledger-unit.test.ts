import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { SchoolUidLedger } from '../src/school-uid/ledger.js';
const account = 'account',
  institution = 'school';
function transaction(
  options: {
    uid?: string;
    highWater?: string;
    coverage?: boolean;
    kind?: string;
    admitted?: boolean;
    issuanceAvailable?: boolean;
    historyKnown?: boolean;
  } = {},
) {
  const statements: { sql: string; args: unknown[] }[] = [];
  const allocation = options.uid
    ? {
        id: 'old-allocation',
        uid: options.uid,
        institution_id: institution,
        admission_id: 'historic-admission',
      }
    : null;
  const head = allocation
    ? {
        revision: 1,
        event_id: 'old-event',
        allocation_id: allocation.id,
        institution_id: institution,
        cause_id: 'old-cause',
      }
    : null;
  const tx = {
    query: async (sql: string, args: unknown[] = []) => {
      statements.push({ sql, args });
      if (sql.startsWith('SELECT * FROM whaleu_school_uid.producing_causes'))
        return {
          rows: [
            {
              id: 'cause',
              kind: options.kind ?? 'student_approval',
              account_id: account,
              actor_account_id: 'actor',
              source_id: 'decision',
              affiliation_assertion_id: 'assertion',
              snapshot_id: 'snapshot',
              institution_id: institution,
            },
          ],
        };
      if (sql.startsWith('SELECT whaleu_school_uid.runtime_history_known'))
        return { rows: [{ known: options.historyKnown ?? true }] };
      if (sql.startsWith('SELECT revision,event_id'))
        return { rows: head ? [head] : [] };
      if (sql.startsWith('SELECT a.id,a.uid'))
        return { rows: allocation ? [allocation] : [] };
      if (sql.startsWith('SELECT id FROM whaleu_school_uid.account_coverage'))
        return { rows: options.coverage === false ? [] : [{ id: 'coverage' }] };
      if (sql.startsWith('SELECT h.institution_id,h.admission_id,h.high_water'))
        return {
          rows:
            options.admitted === false
              ? []
              : [
                  {
                    institution_id: institution,
                    admission_id: 'admission',
                    high_water: options.highWater ?? '0',
                    issuance_available: options.issuanceAvailable ?? true,
                  },
                ],
        };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  return { tx, statements };
}
test('existing same-school allocation retains exact bigint without reading future counter or inserting allocation', async () => {
  const { tx, statements } = transaction({ uid: '9223372036854775807' });
  const result = await new SchoolUidLedger().produce(
    { causeId: 'cause', eventId: 'event', coverageObservation: null },
    tx,
  );
  assert.equal(result.outcome, 'retained');
  assert.equal(result.uid, '9223372036854775807');
  assert.equal(
    statements.some((s) =>
      s.sql.includes('FROM whaleu_school_uid.admission_heads'),
    ),
    false,
  );
  assert.equal(
    statements.some((s) =>
      s.sql.startsWith('INSERT INTO whaleu_school_uid.allocations'),
    ),
    false,
  );
});
test('allocation at max fails atomically instead of becoming unavailable deferred', async () => {
  const { tx, statements } = transaction({ highWater: '9223372036854775807' });
  await assert.rejects(
    new SchoolUidLedger().produce(
      { causeId: 'cause', eventId: 'event', coverageObservation: null },
      tx,
    ),
    (e: unknown) => (e as { code: string }).code === 'SCHOOL_UID_EXHAUSTED',
  );
  assert.equal(
    statements.some((s) => s.sql.startsWith('INSERT')),
    false,
  );
});
test('allocator increments values above JS safe integer as strings only', async () => {
  const { tx, statements } = transaction({ highWater: '9007199254740992' });
  const result = await new SchoolUidLedger().produce(
    { causeId: 'cause', eventId: 'event', coverageObservation: null },
    tx,
  );
  assert.equal(result.uid, '9007199254740993');
  assert.equal(
    statements.find((s) =>
      s.sql.startsWith('INSERT INTO whaleu_school_uid.allocations'),
    )!.args[3],
    '9007199254740993',
  );
  assert.equal(
    statements.some((s) =>
      s.sql.startsWith('UPDATE whaleu_school_uid.admission_heads'),
    ),
    false,
  );
});
test('unknown inventory and unknown account history have distinct explicit approval deferrals', async () => {
  for (const options of [{ admitted: false }, { coverage: false }]) {
    const { tx, statements } = transaction(options);
    const result = await new SchoolUidLedger().produce(
      { causeId: 'cause', eventId: 'event', coverageObservation: null },
      tx,
    );
    assert.equal(result.outcome, 'deferred_unavailable');
    assert.equal(
      result.unavailableReason,
      'coverage' in options ? 'account_history_unknown' : 'inventory_unknown',
    );
    assert.equal(result.uid, null);
    assert.equal(
      statements.some((s) =>
        s.sql.startsWith('INSERT INTO whaleu_school_uid.allocations'),
      ),
      false,
    );
  }
});
test('a true correction cannot defer target allocation or manufacture an unknown floor', async () => {
  const { tx, statements } = transaction({
    kind: 'correct_school',
    admitted: false,
  });
  await assert.rejects(
    new SchoolUidLedger().produce(
      { causeId: 'cause', eventId: 'event', coverageObservation: null },
      tx,
    ),
    (e: unknown) => (e as { code: string }).code === 'SCHOOL_UID_UNAVAILABLE',
  );
  assert.equal(
    statements.some((s) => s.sql.startsWith('INSERT')),
    false,
  );
});

test('future suspension defers new approval but cannot invalidate an existing same-school number', async () => {
  const pending = transaction({ issuanceAvailable: false });
  const deferred = await new SchoolUidLedger().produce(
    { causeId: 'cause', eventId: 'event', coverageObservation: null },
    pending.tx,
  );
  assert.equal(deferred.outcome, 'deferred_unavailable');
  assert.equal(deferred.unavailableReason, 'inventory_unknown');
  assert.equal(
    pending.statements.some(({ sql }) =>
      sql.startsWith('INSERT INTO whaleu_school_uid.allocations'),
    ),
    false,
  );
  const existing = transaction({ uid: '9', issuanceAvailable: false });
  const retained = await new SchoolUidLedger().produce(
    { causeId: 'cause', eventId: 'event', coverageObservation: null },
    existing.tx,
  );
  assert.equal(retained.outcome, 'retained');
  assert.equal(retained.uid, '9');
  assert.equal(
    existing.statements.some(({ sql }) =>
      sql.includes('FROM whaleu_school_uid.admission_heads'),
    ),
    false,
  );
});

test('coverage alone cannot establish unknown current history or retire a mismatched current assignment', async () => {
  const missing = transaction({ historyKnown: false });
  const deferred = await new SchoolUidLedger().produce(
    { causeId: 'cause', eventId: 'event', coverageObservation: null },
    missing.tx,
  );
  assert.equal(deferred.unavailableReason, 'account_history_unknown');
  for (const options of [
    { uid: '9' },
    { kind: 'correct_school' },
    { kind: 'complete_uid' },
  ]) {
    const { tx, statements } = transaction({ ...options, historyKnown: false });
    await assert.rejects(
      new SchoolUidLedger().produce(
        { causeId: 'cause', eventId: 'event', coverageObservation: null },
        tx,
      ),
      (error: unknown) =>
        (error as { code: string }).code === 'SCHOOL_UID_UNAVAILABLE',
    );
    assert.equal(
      statements.some(({ sql }) => sql.startsWith('INSERT')),
      false,
    );
  }
});

test('school locks are canonical, deduplicated and bounded without inventing absent admission rows', async () => {
  const low = '00000000-0000-4000-8000-000000000001',
    high = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const { tx, statements } = transaction();
  await new SchoolUidLedger().lockInstitutions([high, low, high], tx);
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0]!.args, [[low, high]]);
  assert.match(statements[0]!.sql, /ORDER BY institution_id FOR UPDATE$/);
  for (const ids of [
    [],
    ['not-a-uuid'],
    [low, high, '00000000-0000-4000-8000-000000000002'],
  ]) {
    const rejected = transaction();
    await assert.rejects(
      new SchoolUidLedger().lockInstitutions(ids, rejected.tx),
    );
    assert.equal(rejected.statements.length, 0);
  }
});
