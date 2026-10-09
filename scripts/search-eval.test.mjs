import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  datasetDigest,
  evaluate,
  main,
  template,
  validateDataset,
  validateRun,
} from './search-eval.mjs';

const fixturePath = new URL(
  '../packages/fixtures/search-eval-campus-zh-v1.json',
  import.meta.url,
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
function small() {
  const dataset = {
    schemaVersion: 1,
    id: 'unit-synthetic',
    synthetic: true,
    description: 'Math-only synthetic fixture',
    documents: ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      kind: 'post',
      postId: id,
      rootCommentId: null,
      text: id,
    })),
    queries: [
      {
        id: 'q',
        text: 'test',
        tags: ['math'],
        rationale: 'Two relevant documents.',
        judgments: { a: 3, b: 1, c: 0, d: 0 },
      },
    ],
  };
  const run = template(dataset);
  run.profile = {
    ...run.profile,
    id: 'unit-only-not-model-output',
    embeddingRevision: 'test',
    normalization: 'test',
    distance: 'test',
    rerankerRevision: 'test',
    pipelineRevision: 'test',
  };
  run.results[0].hits = [
    { documentId: 'c', score: 3 },
    { documentId: 'a', score: 2 },
    { documentId: 'b', score: 1 },
  ];
  return { dataset, run };
}
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test('synthetic corpus validates, with post/comment/reply and exhaustive judgments', () => {
  validateDataset(fixture);
  assert.equal(fixture.documents.length, 36);
  assert.equal(fixture.queries.length, 12);
  assert.deepEqual([...new Set(fixture.documents.map((d) => d.kind))].sort(), [
    'comment',
    'post',
    'reply',
  ]);
  for (const tag of [
    '同义词',
    '口语',
    '否定/排除',
    '缩写',
    '精确课号',
    '精确地点',
    '混合语言',
    '同词异义',
  ])
    assert.ok(fixture.queries.some((q) => q.tags.includes(tag)));
});
test('hand-calculated Recall, full-list MRR and graded nDCG', () => {
  const { dataset, run } = small();
  const report = evaluate(dataset, run, [1, 2, 3, 100]);
  assert.equal(report.macro.mrr, 0.5);
  assert.equal(report.macro.at[1].recall, 0);
  assert.equal(report.macro.at[2].recall, 0.5);
  assert.equal(report.macro.at[3].recall, 1);
  approx(report.macro.at[2].ndcg, 7 / Math.log2(3) / (7 + 1 / Math.log2(3)));
  approx(
    report.macro.at[3].ndcg,
    (7 / Math.log2(3) + 1 / 2) / (7 + 1 / Math.log2(3)),
  );
  assert.deepEqual(report.macro.at[3], report.macro.at[100]);
});
test('ideal ranking reaches 1; reverse/no matches stays within mathematical bounds', () => {
  const { dataset, run } = small();
  run.results[0].hits = [
    { documentId: 'a', score: 2 },
    { documentId: 'b', score: 1 },
  ];
  const ideal = evaluate(dataset, run, [1, 2]);
  assert.equal(ideal.macro.mrr, 1);
  assert.equal(ideal.macro.at[1].ndcg, 1);
  assert.equal(ideal.macro.at[1].recall, 0.5);
  assert.equal(ideal.macro.at[2].recall, 1);
  assert.equal(ideal.macro.at[2].ndcg, 1);
  for (const order of [['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a'], ['d'], []]) {
    run.results[0].hits = order.map((documentId, i) => ({
      documentId,
      score: -i,
    }));
    const result = evaluate(dataset, run, [1, 2, 9]);
    for (const metrics of Object.values(result.macro.at))
      for (const value of Object.values(metrics))
        assert.ok(value >= 0 && value <= 1);
  }
  assert.equal(evaluate(dataset, run).macro.mrr, 0);
});
test('ties use binary document ID order and input order does not affect result', () => {
  const { dataset, run } = small();
  run.results[0].hits = [
    { documentId: 'b', score: -2 },
    { documentId: 'a', score: -2 },
  ];
  const report = evaluate(dataset, run);
  run.results[0].hits.reverse();
  assert.deepEqual(evaluate(dataset, run), report);
  assert.equal(report.macro.at[1].ndcg, 1);
});
test('empty relevance is null and excluded, not silently scored as perfect or zero', () => {
  const { dataset, run } = small();
  dataset.queries.push({
    ...dataset.queries[0],
    id: 'empty',
    judgments: { a: 0, b: 0, c: 0, d: 0 },
  });
  run.datasetSha256 = datasetDigest(dataset);
  run.results.push({ queryId: 'empty', hits: [{ documentId: 'a', score: 1 }] });
  let report = evaluate(dataset, run);
  assert.equal(report.macro.mrr, 0.5);
  assert.equal(report.emptyRelevantQueryCount, 1);
  assert.equal(report.perQuery[1].mrr, null);
  assert.equal(report.perQuery[1].at[1].ndcg, null);
  assert.equal(report.perQuery[1].returnedCount, 1);
  dataset.queries.shift();
  run.results.shift();
  run.datasetSha256 = datasetDigest(dataset);
  report = evaluate(dataset, run);
  assert.equal(report.macro.mrr, null);
  assert.equal(report.macro.at[1].recall, null);
  assert.equal(report.evaluatedQueryCount, 0);
});
test('macro averages queries equally, not number of relevant documents', () => {
  const { dataset, run } = small();
  dataset.queries.push({
    ...dataset.queries[0],
    id: 'q2',
    judgments: { a: 3, b: 0, c: 0, d: 0 },
  });
  run.results.push({ queryId: 'q2', hits: [{ documentId: 'a', score: 1 }] });
  run.datasetSha256 = datasetDigest(dataset);
  assert.equal(evaluate(dataset, run, [2]).macro.at[2].recall, 0.75);
});
test('k must be positive unique safe integers', () => {
  const { dataset, run } = small();
  for (const ks of [
    [],
    [0],
    [-1],
    [1.1],
    ['1'],
    [NaN],
    [Infinity],
    [1, 1],
    [Number.MAX_SAFE_INTEGER + 1],
  ])
    assert.throws(() => evaluate(dataset, run, ks), /Cutoffs/);
});
test('duplicate corpus and query IDs fail', () => {
  for (const key of ['documents', 'queries']) {
    const { dataset } = small();
    dataset[key].push(dataset[key][0]);
    assert.throws(() => validateDataset(dataset), /duplicate ID/);
  }
});
test('grades, exhaustive qrels and empty datasets are validated', () => {
  for (const value of [-1, 4, 1.2, '3', null, NaN]) {
    const { dataset } = small();
    dataset.queries[0].judgments.a = value;
    assert.throws(() => validateDataset(dataset), /Relevance/);
  }
  const { dataset } = small();
  delete dataset.queries[0].judgments.d;
  assert.throws(() => validateDataset(dataset), /entire corpus/);
  dataset.queries = [];
  assert.throws(() => validateDataset(dataset), /must contain/);
});
test('ancestry requires actual post and same-thread root comment', () => {
  const dataset = structuredClone(fixture);
  dataset.documents.find((d) => d.id === 'r03').rootCommentId = 'c04';
  assert.throws(() => validateDataset(dataset), /reply ancestry/);
  dataset.documents.find((d) => d.id === 'r03').rootCommentId = 'p03';
  assert.throws(() => validateDataset(dataset), /reply ancestry/);
});
test('duplicate/unknown hit IDs cannot inflate recall', () => {
  for (const documentId of ['a', 'unknown']) {
    const { dataset, run } = small();
    run.results[0].hits.push({ documentId, score: 1 });
    assert.throws(() => validateRun(dataset, run), /document ID/);
  }
});
test('missing, unknown and duplicate query results fail', () => {
  const { dataset, run } = small();
  run.results = [];
  assert.throws(() => validateRun(dataset, run), /Missing/);
  run.results = [{ queryId: 'unknown', hits: [] }];
  assert.throws(() => validateRun(dataset, run), /query ID/);
  dataset.queries.push({ ...dataset.queries[0], id: 'q2' });
  run.datasetSha256 = datasetDigest(dataset);
  run.results = [
    { queryId: 'q', hits: [] },
    { queryId: 'q', hits: [] },
  ];
  assert.throws(() => validateRun(dataset, run), /duplicate query/);
});
test('non-finite and non-number scores fail; finite negative scores work', () => {
  for (const score of [NaN, Infinity, -Infinity, null, '1', true]) {
    const { dataset, run } = small();
    run.results[0].hits[0].score = score;
    assert.throws(() => validateRun(dataset, run), /Invalid score/);
  }
  const { dataset, run } = small();
  run.results[0].hits[0].score = -99;
  validateRun(dataset, run);
});
test('different corpus content or labels fail digest binding; object key order is stable', () => {
  const { dataset, run } = small();
  assert.equal(datasetDigest({ a: 1, b: 2 }), datasetDigest({ b: 2, a: 1 }));
  dataset.documents[0].text = 'changed';
  assert.throws(() => validateRun(dataset, run), /digest/);
});
test('no per-query/per-hit profile or dimension overrides can be mixed into one run', () => {
  for (const target of ['result', 'hit']) {
    const { dataset, run } = small();
    (target === 'result' ? run.results[0] : run.results[0].hits[0]).dimensions =
      1024;
    assert.throws(() => validateRun(dataset, run), /fields/);
  }
  for (const dimensions of [0, -1, 0.5, '4096', NaN]) {
    const { dataset, run } = small();
    run.profile.dimensions = dimensions;
    assert.throws(() => validateRun(dataset, run), /dimensions/);
  }
});
test('CLI separates profiles and rejects reuse of a profile ID with changed dimensions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'search-eval-'));
  try {
    const { dataset, run } = small();
    const paths = ['dataset.json', 'one.json', 'two.json'].map((name) =>
      join(dir, name),
    );
    const second = structuredClone(run);
    second.profile.dimensions = 1024;
    const write = () =>
      [dataset, run, second].forEach((value, i) =>
        writeFileSync(paths[i], JSON.stringify(value)),
      );
    write();
    assert.throws(() => main(['evaluate', ...paths]), /Profile ID reused/);
    second.profile.id = 'different-dimensions';
    write();
    const reports = main(['evaluate', ...paths]);
    assert.equal(reports.length, 2);
    assert.notEqual(reports[0].profileSha256, reports[1].profileSha256);
    assert.equal(reports[0].profile.dimensions, 4096);
    assert.equal(reports[1].profile.dimensions, 1024);
    second.profile.id = run.profile.id;
    second.profile.dimensions = run.profile.dimensions;
    second.profile.queryInstruction = 'different instruction';
    write();
    assert.throws(() => main(['evaluate', ...paths]), /Profile ID reused/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('CLI errors are nonzero and template never creates fabricated model hits', () => {
  const child = spawnSync(
    process.execPath,
    [new URL('./search-eval.mjs', import.meta.url).pathname],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Usage/);
  assert.ok(template(fixture).results.every((row) => row.hits.length === 0));
});

test('unfinished template profiles cannot be mistaken for an evaluated model run', () => {
  assert.throws(() => evaluate(fixture, template(fixture)), /placeholders/);
});
test('reranker identity must be complete, or explicitly absent', () => {
  const { dataset, run } = small();
  run.profile.rerankerRevision = null;
  assert.throws(() => validateRun(dataset, run), /Reranker/);
  run.profile.rerankerModel = null;
  validateRun(dataset, run);
});
test('unknown judgments cannot replace missing corpus judgments', () => {
  const { dataset } = small();
  delete dataset.queries[0].judgments.d;
  dataset.queries[0].judgments.unknown = 3;
  assert.throws(() => validateDataset(dataset), /entire corpus/);
});
