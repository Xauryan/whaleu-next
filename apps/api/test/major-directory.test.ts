import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  majorDepartmentIdSchema,
  majorQuerySchema,
  majorRelatedQuerySchema,
  majorSummarySchema,
  majorSchema,
  majorDetailSchema,
  majorDepartmentsSchema,
} from '../src/majors/contracts.js';

test('Major department keys retain original int32 domain, independent of Course ranges', () => {
  for (const departmentId of [-2147483648, -1, 0, 55, 89, 100, 2147483647]) {
    assert.equal(majorDepartmentIdSchema.parse(departmentId), departmentId);
    assert.equal(
      majorQuerySchema.parse({ departmentId: String(departmentId) })
        .departmentId,
      departmentId,
    );
  }
  for (const departmentId of [
    '01',
    '+1',
    '-0',
    '1.0',
    '2147483648',
    '-2147483649',
    1,
    null,
    [],
  ])
    assert.equal(majorQuerySchema.safeParse({ departmentId }).success, false);
});

test('Major combined name/college filter and pagination are bounded and strict', () => {
  assert.deepEqual(
    majorQuerySchema.parse({
      departmentId: '55',
      keyword: '  计算机  ',
      limit: '2',
    }),
    {
      departmentId: 55,
      keyword: '计算机',
      limit: 2,
    },
  );
  assert.deepEqual(majorQuerySchema.parse({}), { limit: 20 });
  assert.deepEqual(majorRelatedQuerySchema.parse({}), { limit: 5 });
  for (const value of [
    { keyword: '' },
    { keyword: '   ' },
    { keyword: 'a'.repeat(101) },
    { keyword: 'a\u0000b' },
    { keyword: 'a\nb' },
    { limit: '0' },
    { limit: '51' },
    { limit: 20 },
    { cursor: '' },
    { courseCode: 'M01' },
    { canteenIds: randomUUID() },
    { minRating: '1' },
    { actorId: randomUUID() },
    { universityId: 1 },
  ])
    assert.equal(majorQuerySchema.safeParse(value).success, false);
  for (const value of [
    { cursor: 'cursor' },
    { departmentId: '1' },
    { limit: '51' },
  ])
    assert.equal(majorRelatedQuerySchema.safeParse(value).success, false);
});

test('Major summaries express exact root count/hot text or unavailable, never score or creator claims', () => {
  const empty = { kind: 'known', rootCount: 0, hotComment: null },
    populated = {
      kind: 'known',
      rootCount: 2,
      hotComment: { id: randomUUID(), body: '  原文  ', likes: 3 },
    };
  assert.deepEqual(majorSummarySchema.parse(empty), empty);
  assert.deepEqual(majorSummarySchema.parse(populated), populated);
  assert.deepEqual(majorSummarySchema.parse({ kind: 'unavailable' }), {
    kind: 'unavailable',
  });
  for (const value of [
    { ...empty, rootCount: 1 },
    { ...populated, hotComment: { ...populated.hotComment, body: ' ' } },
    {
      ...populated,
      hotComment: { ...populated.hotComment, body: '🍱'.repeat(2001) },
    },
    { ...populated, rootCount: 0 },
    { ...empty, ratingCount: 0 },
    { ...empty, mean: null },
    { kind: 'unavailable', rootCount: 0 },
    {
      ...populated,
      hotComment: { ...populated.hotComment, actorId: randomUUID() },
    },
  ])
    assert.equal(majorSummarySchema.safeParse(value).success, false);
  const item = {
    id: randomUUID(),
    majorRevision: randomUUID(),
    catalogRevision: randomUUID(),
    campusId: randomUUID(),
    departmentId: 55,
    collegeName: '学院',
    majorName: '专业',
    summary: empty,
  };
  assert.deepEqual(majorSchema.parse(item), item);
  assert.ok(
    majorDetailSchema.safeParse({ catalogRevision: item.catalogRevision, item })
      .success,
  );
  assert.ok(
    majorDepartmentsSchema.safeParse({
      catalogRevision: item.catalogRevision,
      items: [{ departmentId: 55, name: '55系' }],
    }).success,
  );
  for (const extra of [
    { creatorId: randomUUID() },
    { creatorNotice: 'unavailable' },
    { degree: '工学学士' },
    { duration: '四年' },
    { score: 5 },
    { sourceSchoolKey: '1' },
  ])
    assert.equal(majorSchema.safeParse({ ...item, ...extra }).success, false);
});

test('Major scalar epoch captures explicitly reject missing catalog, content or Review ownership', async () => {
  const { majorCatalog, majorCatalogCaptureSql } =
    await import('../src/majors/proof.js');
  const { discussionEpoch, majorDiscussionEpochSql } =
    await import('../src/majors/discussion/proof.js');
  const source = { catalog: randomUUID() };
  const present = {
    source,
    epoch: '1',
    content: '1',
    review: '1',
    until: '2099-01-01 00:00:00+00',
  };
  const tx = (rows: unknown[]) =>
    ({ query: async () => ({ rows }) }) as unknown as import('pg').PoolClient;
  for (const key of ['source', 'epoch', 'content', 'review']) {
    await assert.rejects(
      majorCatalog(
        tx([{ ...present, [key]: null }]),
        randomUUID(),
        randomUUID(),
        false,
      ),
      { code: 'MAJOR_CATALOG_UNAVAILABLE' },
    );
  }
  await assert.rejects(
    majorCatalog(tx([]), randomUUID(), randomUUID(), false),
    { code: 'MAJOR_CATALOG_UNAVAILABLE' },
  );
  for (const rows of [
    [],
    [{ content: null, review: '1' }],
    [{ content: '1', review: null }],
  ])
    await assert.rejects(discussionEpoch(tx(rows)), {
      code: 'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
    });
  assert.deepEqual(
    await majorCatalog(tx([present]), randomUUID(), randomUUID(), false),
    present,
  );
  assert.deepEqual(await discussionEpoch(tx([present])), {
    content: '1',
    review: '1',
  });
  assert.equal(
    (majorCatalogCaptureSql.match(/major_catalog_source\(/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(
    majorCatalogCaptureSql + majorDiscussionEpochSql,
    /CROSS JOIN whaleu_(majors|community)\..*epoch/,
  );
  assert.match(
    majorCatalogCaptureSql,
    /VALUES\(a.accepted_at\),\(a.valid_until\)/,
  );
  assert.match(
    majorCatalogCaptureSql,
    /VALUES\(d.issued_at\),\(d.visibility_until\),\(p.valid_from\),\(p.valid_until\),\(s.valid_until\)/,
  );
});

test('Major batched final proof retains each ordinal, actor, source, history and publication base decision', async () => {
  const { retainDiscussion, majorDiscussionEpochSql, majorDiscussionProofSql } =
    await import('../src/majors/discussion/proof.js');
  const {
    startTransactionDeadlines,
    checkTransactionDeadlines,
    clearTransactionDeadlines,
  } = await import('../src/database/transaction-deadlines.js');
  const majorA = randomUUID(),
    majorB = randomUUID(),
    actorA = randomUUID(),
    actorB = randomUUID(),
    sessionA = randomUUID(),
    sessionB = randomUUID(),
    history = randomUUID();
  const source = {
    catalog: randomUUID(),
    revision: randomUUID(),
    owner: 'f'.repeat(64),
    population: randomUUID(),
    likes: history,
  };
  const good = [
    {
      ordinal: '1',
      major_id: majorA,
      session: true,
      access: true,
      base: true,
      source,
      history,
    },
    {
      ordinal: '2',
      major_id: majorB,
      session: true,
      access: true,
      base: true,
      source,
      history,
    },
  ];
  const scenarios: { rows: typeof good; valid: boolean; review?: string }[] = [
    { rows: good, valid: true },
    { rows: good.slice(0, 1), valid: false },
    { rows: [good[1]!, good[0]!], valid: false },
    { rows: [good[0]!, { ...good[1]!, ordinal: '1' }], valid: false },
    ...(['session', 'access', 'base'] as const).map((key) => ({
      rows: [good[0]!, { ...good[1]!, [key]: false }],
      valid: false,
    })),
    {
      rows: [good[0]!, { ...good[1]!, source: null }] as unknown as typeof good,
      valid: false,
    },
    { rows: [good[0]!, { ...good[1]!, history: randomUUID() }], valid: false },
    { rows: good, review: '2', valid: false },
  ];
  for (const scenario of scenarios) {
    let final = false,
      batches = 0;
    const tx = {
      query: async (sql: string, values?: unknown[]) => {
        if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') final = true;
        if (sql === majorDiscussionEpochSql)
          return {
            rows: [
              { content: '1', review: final ? (scenario.review ?? '1') : '1' },
            ],
          };
        if (sql === majorDiscussionProofSql) {
          batches++;
          assert.deepEqual(values, [
            [actorA, actorB],
            [sessionA, sessionB],
            [majorA, majorB],
            [false, true],
          ]);
          return { rows: scenario.rows };
        }
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
        if (sql === 'SELECT clock_timestamp() AS now')
          return { rows: [{ now: new Date() }] };
        if (sql.includes('major_discussion_access_deadline'))
          return { rows: [{ until: null }] };
        return { rows: [] };
      },
    } as unknown as import('pg').PoolClient;
    startTransactionDeadlines(tx);
    try {
      await retainDiscussion(actorA, sessionA, majorA, tx, { source, history });
      await retainDiscussion(actorB, sessionB, majorB, tx, {
        source,
        history,
        publish: true,
      });
      if (scenario.valid) await checkTransactionDeadlines(tx);
      else
        await assert.rejects(checkTransactionDeadlines(tx), {
          code: 'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
        });
      assert.equal(batches, 1);
    } finally {
      clearTransactionDeadlines(tx);
    }
  }
});
