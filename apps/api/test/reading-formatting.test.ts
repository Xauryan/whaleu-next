import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { prepareTextSource } from '../src/community/text-source/source.js';
import {
  FORMATTER,
  jobKey,
} from '../src/community/reading-formatting/contracts.js';
import type { SourceSnapshot } from '../src/community/reading-formatting/contracts.js';
import {
  formatSource,
  decodeExactPlan,
  sourceSlices,
} from '../src/community/reading-formatting/formatter.js';
import {
  decodeCandidate,
  ReadingFormattingRuntime,
} from '../src/community/reading-formatting/runtime.js';
import { ReadingFormattingWorker } from '../src/community/reading-formatting/worker.js';
import { textSourceReadV2Schema } from '../src/community/reading-formatting/reader.js';
import { processingAccountState } from '../src/identity/processing-account-proof.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function source(
  text = ('鲸'.repeat(119) + '。').repeat(3),
  format: 'plain' | 'markdown' = 'plain',
  off = false,
  kind: SourceSnapshot['kind'] = 'post',
): SourceSnapshot {
  const descriptor =
    format === 'plain'
      ? {
          version: 1 as const,
          format,
          readingFormatting: off ? ('off' as const) : ('auto' as const),
        }
      : { version: 1 as const, format };
  const prepared = prepareTextSource(text, descriptor, kind)!;
  return {
    kind,
    id: id(1),
    sourceRevision: 1,
    sourceHash: prepared.sourceHash,
    publicationRequestId: id(2),
    text: prepared.canonicalText,
    descriptor,
  };
}
test('v2 formatter is lossless, bounded and deterministic for canonical CJK/plain input', () => {
  for (const text of [
    ('鲸'.repeat(119) + '。').repeat(3),
    ('鲸'.repeat(139) + '！').repeat(17),
    '\t' + ('鲸'.repeat(119) + '。').repeat(3) + '\n',
    ('鲸'.repeat(99) + '？').repeat(5),
  ]) {
    const s = source(text),
      outcome = formatSource(s);
    assert.equal(outcome.kind, 'plan');
    if (outcome.kind !== 'plan') continue;
    assert.equal(outcome.plan.formatter, FORMATTER);
    assert.equal(
      sourceSlices(s, JSON.stringify(outcome.plan))!.join(''),
      s.text,
    );
    assert.deepEqual(formatSource(s), outcome);
    assert.ok(outcome.plan.spans.length <= 26);
    assert.equal(
      decodeExactPlan(
        s,
        JSON.stringify({ ...outcome.plan, spans: [{ start: 0, end: 1 }] }),
      ),
      null,
    );
  }
});
test('Markdown, opt-out, missing descriptor and below-threshold source never format', () => {
  assert.equal(formatSource(source(undefined, 'markdown')).kind, 'ineligible');
  assert.equal(
    formatSource(source(undefined, 'plain', true)).kind,
    'ineligible',
  );
  for (const kind of ['post', 'comment', 'reply'] as const) {
    const n = kind === 'post' ? 300 : 200;
    assert.equal(
      formatSource(source('鲸'.repeat(n - 1), 'plain', false, kind)).kind,
      'ineligible',
    );
    assert.equal(
      formatSource(source('鲸'.repeat(n), 'plain', false, kind)).kind,
      'plan',
    );
  }
  const value = { ...source() };
  Reflect.deleteProperty(value, 'descriptor');
  assert.equal(formatSource(value).kind, 'invalid_source');
});
test('unsupported scalar or structure preserves the whole exact source', () => {
  for (const extra of [
    '👩‍💻',
    'a\u0301',
    '\u200c',
    '\u0600',
    '\ufe0f',
    '\u0903',
    '<tag>',
    'https://example.com',
    '\n# title',
    '“unclosed',
  ]) {
    const s = source(source().text + extra),
      o = formatSource(s);
    assert.equal(o.kind, 'plan');
    if (o.kind === 'plan') {
      assert.equal(o.plan.mode, 'unchanged');
      assert.deepEqual(o.plan.spans, [{ start: 0, end: s.text.length }]);
      assert.equal(sourceSlices(s, JSON.stringify(o.plan))!.join(''), s.text);
    }
  }
});
function raw(n: number) {
  const s = { ...source(), id: id(n) };
  return {
    job_key: jobKey(s, 1),
    content_kind: s.kind,
    content_id: s.id,
    source_revision: 1,
    source_hash: s.sourceHash,
    publication_request_id: s.publicationRequestId,
    formatter_version: FORMATTER,
    generation: 1,
    state: 'pending',
    claims: 0,
    lease_fence: '0',
    lease_token: null,
    lease_until: null,
    slot_id: null,
    schedule_state: 'runnable',
    probe_count: 0,
    next_probe_at: `2026-10-21 00:00:${String(n).padStart(2, '0')}+00`,
    next_attempt_at: '2026-10-21 00:00:00+00',
    row_version: '1',
    write_transaction: '1',
    scheduling_reason: null,
  };
}
test('raw scheduling identity survives malformed rich payload, not malformed cursor invariants', () => {
  const row = { ...raw(1), formatter_version: 'malformed' };
  const decoded = decodeCandidate(row);
  assert.equal(decoded.job.success, false);
  assert.equal(decoded.schedule.job_key, row.job_key);
  assert.throws(() => decodeCandidate({ ...row, row_version: 'broken' }));
});
test('worker continues past unavailable first two and never turns them into claims', async () => {
  const rows = [raw(1), raw(2), raw(3), raw(4)],
    seen: string[] = [],
    deferred: string[] = [];
  const runtime = {
    candidates: async () => rows,
    claim: async (row: ReturnType<typeof raw>) => {
      seen.push(row.job_key);
      if (seen.length <= 2) throw new Error('unavailable');
      return { key: row.job_key, source: source() };
    },
    defer: async (row: ReturnType<typeof raw>) => {
      deferred.push(row.job_key);
      return true;
    },
    complete: async () => true,
  };
  const report = await new ReadingFormattingWorker(
    runtime as unknown as ReadingFormattingRuntime,
  ).tick();
  assert.equal(report.examined, 4);
  assert.equal(report.claimed, 2);
  assert.equal(report.completed, 2);
  assert.deepEqual(
    deferred,
    rows.slice(0, 2).map((r) => r.job_key),
  );
});
test('cursor advances across eight skipped rows into healthy next page without process-local authority', async () => {
  const rows = Array.from({ length: 9 }, (_, i) => raw(i + 1)),
    cursors: unknown[] = [];
  const runtime = {
    candidates: async (cursor: unknown) => {
      cursors.push(cursor);
      return cursor ? rows.slice(8) : rows.slice(0, 8);
    },
    claim: async (row: ReturnType<typeof raw>) => {
      if (row !== rows[8]) throw new Error('lock unavailable');
      return { key: row.job_key, source: source() };
    },
    defer: async () => false,
    complete: async () => true,
  };
  const worker = new ReadingFormattingWorker(
    runtime as unknown as ReadingFormattingRuntime,
  );
  assert.equal((await worker.tick()).examined, 8);
  assert.equal((await worker.tick()).completed, 1);
  assert.deepEqual(cursors[1], {
    nextProbeAt: rows[7]!.next_probe_at,
    jobKey: rows[7]!.job_key,
  });
});
test('malformed first payload quarantines only that row, healthy second still runs', async () => {
  const rows = [{ ...raw(1), source_hash: 'invalid' }, raw(2)],
    reasons: string[] = [];
  const runtime = {
    candidates: async () => rows,
    claim: async () => ({ source: source() }),
    defer: async (_row: unknown, reason: string) => {
      reasons.push(reason);
      return true;
    },
    complete: async () => true,
  };
  const report = await new ReadingFormattingWorker(
    runtime as unknown as ReadingFormattingRuntime,
  ).tick();
  assert.equal(report.completed, 1);
  assert.deepEqual(reasons, ['invalid_payload']);
});
test('v2 protocol retains strict canonical v1 source and rejects invented offsets/extra metadata', () => {
  const s = source(),
    formatted = formatSource(s);
  assert.equal(formatted.kind, 'plan');
  if (formatted.kind !== 'plan') return;
  const v1 = {
    version: 1,
    classification: 'reviewedSource',
    kind: 'post',
    id: s.id,
    postId: s.id,
    rootCommentId: null,
    text: s.text,
    sourceRevision: 1,
    textSource: { ...s.descriptor, sourceHash: s.sourceHash },
    readingFormattingEligible: true,
    presentationStatus: 'not_configured',
  };
  const dto = {
    version: 2,
    source: v1,
    presentation: { status: 'formatted', plan: formatted.plan },
  };
  assert.equal(textSourceReadV2Schema.safeParse(dto).success, true);
  assert.equal(
    textSourceReadV2Schema.safeParse({
      ...dto,
      source: { ...v1, accountId: id(3) },
    }).success,
    false,
  );
  assert.equal(
    textSourceReadV2Schema.safeParse({
      ...dto,
      presentation: {
        status: 'formatted',
        plan: { ...formatted.plan, spans: [{ start: 0, end: 1 }] },
      },
    }).success,
    false,
  );
  assert.equal(
    textSourceReadV2Schema.safeParse({
      ...dto,
      presentation: { status: 'source', jobStatus: 'complete' },
    }).success,
    false,
  );
});
function identityFixture() {
  let accounts: unknown[] = [
    {
      id: id(1),
      status: 'active',
      lifecycle: 'active',
      lifecycle_generation: '0',
      xmin: '1',
    },
  ];
  const sqls: string[] = [];
  const tx = {
    query: async (sql: string) => {
      sqls.push(sql);
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.startsWith('SELECT id,status,lifecycle,lifecycle_generation'))
        return { rows: accounts };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return {
    tx,
    sqls,
    set: (rows: unknown[]) => {
      accounts = rows;
    },
  };
}
for (const lifecycle of ['cooling', 'erasing', 'completed'])
  test(`Identity ${lifecycle} invalidates retained active processing facts`, async () => {
    const f = identityFixture();
    assert.equal(
      (await processingAccountState([id(1)], f.tx))[0]!.lifecycle,
      'active',
    );
    f.set([
      {
        id: id(1),
        status: 'active',
        lifecycle,
        lifecycle_generation: '1',
        xmin: '2',
      },
    ]);
    await assert.rejects(checkTransactionDeadlines(f.tx));
    assert.ok(f.sqls.some((s) => s.includes('IN SHARE MODE NOWAIT')));
    clearTransactionDeadlines(f.tx);
  });
test('Identity missing/negative facts retained and managed lifetime required', async () => {
  const f = identityFixture();
  f.set([]);
  assert.equal(
    (await processingAccountState([id(1)], f.tx))[0]!.lifecycle,
    'missing',
  );
  f.set([
    {
      id: id(1),
      status: 'active',
      lifecycle: 'active',
      lifecycle_generation: '0',
      xmin: '2',
    },
  ]);
  await assert.rejects(checkTransactionDeadlines(f.tx));
  clearTransactionDeadlines(f.tx);
  await assert.rejects(processingAccountState([id(1)], f.tx));
});

test('runtime has no public permit factory or reader mutation surface', () => {
  for (const method of [
    'issue',
    'consume',
    'permit',
    'fromReader',
    'pause',
    'invalidate',
  ])
    assert.equal(
      Object.hasOwn(ReadingFormattingRuntime.prototype, method),
      false,
    );
});

test('eligibility counts canonical Unicode scalars and preserves unsupported scalar text without loss', () => {
  for (const kind of ['post', 'comment', 'reply'] as const) {
    const n = kind === 'post' ? 300 : 200;
    for (const [text, expected] of [
      ['鲸'.repeat(n - 2) + '😀', 'ineligible'],
      ['鲸'.repeat(n - 1) + '😀', 'plan'],
      ['鲸'.repeat(n - 3) + '\r\n鲸', 'ineligible'],
      ['鲸'.repeat(n - 2) + '\r\n鲸', 'plan'],
    ] as const) {
      const value = source(text, 'plain', false, kind),
        outcome = formatSource(value);
      assert.equal(outcome.kind, expected);
      if (outcome.kind === 'plan')
        assert.equal(
          sourceSlices(value, JSON.stringify(outcome.plan))!.join(''),
          value.text,
        );
    }
  }
});
