import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  escapeXml,
  isCountedPath,
  renderSvg,
  summarize,
} from './code-stats.mjs';
import { excluded } from './code-stats.fixtures.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const example = {
  name: 'rewrite/backend-foundation',
  sha,
  code: 1200,
  files: 4,
  languages: [
    { name: 'TypeScript', code: 1180, files: 2 },
    { name: 'WXML', code: 10, files: 1 },
    { name: 'WXSS', code: 10, files: 1 },
  ],
};

test('scope includes source, tests, scripts, migrations and config', () => {
  for (const path of [
    'apps/api/src/index.ts',
    'apps/api/test/index.test.ts',
    'scripts/task.mjs',
    'apps/api/scripts/openapi.ts',
    'apps/api/migrations/001.sql',
    'apps/wechat/pages/home/index.wxml',
    'apps/wechat/pages/home/index.wxss',
    '.github/workflows/ci.yml',
    '.prettierrc.json',
    'compose.yaml',
    'package.json',
  ])
    assert.equal(isCountedPath(path), true, path);
  for (const path of excluded) assert.equal(isCountedPath(path), false, path);
});

test('totals are validated and language rows are deterministic', () => {
  assert.deepEqual(summarize({}), { code: 0, files: 0, languages: [] });
  for (const malformed of [null, [], { header: {} }, { SUM: {} }]) {
    assert.throws(() => summarize(malformed));
  }
  const report = {
    header: { cloc_version: '2.10' },
    WXML: { code: 1, comment: 1, blank: 1, nFiles: 1 },
    TypeScript: { code: 5, comment: 0, blank: 0, nFiles: 2 },
    SUM: { code: 6, nFiles: 3 },
  };
  assert.deepEqual(summarize(report), {
    code: 6,
    files: 3,
    languages: [
      { name: 'TypeScript', code: 5, files: 2 },
      { name: 'WXML', code: 1, files: 1 },
    ],
  });
  assert.throws(
    () => summarize({ ...report, SUM: { code: 7, nFiles: 3 } }),
    /totals/,
  );
  assert.throws(
    () => summarize({ ...report, WXML: { ...report.WXML, code: -1 } }),
    /Invalid/,
  );
});

test('SVG has source metadata, all languages and no executable or external resources', () => {
  const svg = renderSvg([example], 'rewrite/backend-foundation');
  assert.equal(svg, renderSvg([example], 'rewrite/backend-foundation'));
  for (const text of [
    '1,200',
    'TypeScript',
    'WXML',
    'WXSS',
    'rewrite/backend-foundation',
    sha.slice(0, 12),
  ]) {
    assert.ok(svg.includes(text), text);
  }
  assert.doesNotMatch(
    svg,
    /<(?:script|foreignObject|image|a)\b|\b(?:href|onload|onclick)\s*=|url\(|@import|<!DOCTYPE|<!ENTITY/i,
  );
  assert.throws(
    () => renderSvg([{ ...example, sha: 'not-a-sha' }], 'main'),
    /Invalid source SHA/,
  );
  assert.ok(
    !renderSvg(
      [
        {
          ...example,
          code: 0,
          languages: [{ name: 'Empty', files: 1, code: 0 }],
        },
      ],
      'empty',
    ).includes('NaN'),
  );
});

test('all dynamic text is XML escaped, including hostile language and branch names', () => {
  assert.equal(escapeXml('&<>"\'\u0000'), '&amp;&lt;&gt;&quot;&apos;');
  const hostile = '<script onload="x">&\'</script>';
  const svg = renderSvg(
    [
      {
        ...example,
        name: hostile,
        languages: [{ name: hostile, files: 1, code: 1 }],
      },
    ],
    hostile,
  );
  assert.ok(
    svg.includes(
      '&lt;script onload=&quot;x&quot;&gt;&amp;&apos;&lt;/script&gt;',
    ),
  );
  assert.doesNotMatch(svg, /<script\b/);
});

test('publishing workflow is restricted to the two approved refs with isolated permissions', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/code-stats.yml', import.meta.url),
    'utf8',
  );
  const guard =
    "github.repository == 'Xauryan/whaleu-next' &&\n      (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/rewrite/backend-foundation') &&\n      (github.event_name == 'push' || github.event_name == 'workflow_dispatch')";
  assert.equal(workflow.split(guard).length - 1, 2);
  assert.ok(workflow.includes('branches: [main, rewrite/backend-foundation]'));
  assert.ok(workflow.includes('permissions: {}'));
  assert.ok(workflow.includes('permissions:\n      contents: read'));
  assert.ok(
    workflow.includes(
      'permissions:\n      pages: write\n      id-token: write',
    ),
  );
  assert.doesNotMatch(
    workflow,
    /pull_request|contents: write|actions: write|secrets\.|git push/,
  );
  assert.ok(workflow.includes('persist-credentials: false'));
  assert.ok(
    workflow.includes(
      "git fetch --force --prune --no-tags --depth=1 origin '+refs/heads/*:refs/remotes/origin/*'",
    ),
  );
  assert.ok(
    workflow.includes(
      'STATS_DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}',
    ),
  );
  assert.ok(workflow.includes('path: ${{ runner.temp }}/code-statistics-site'));
  for (const [, action] of workflow.matchAll(/uses: (\S+)/g))
    assert.match(action, /^actions\/[a-z-]+@[a-f0-9]{40}$/);
});
