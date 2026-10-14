import {
  assertOfficialUsernsHost,
  OFFICIAL_USERNS_RETIRE_BEFORE,
} from './official-browser-sandbox.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/ci.yml');
const setup = read('.github/actions/setup-ci/action.yml');
const packageJson = JSON.parse(read('package.json'));
const jobs = Object.fromEntries(
  [
    ...workflow
      .slice(workflow.indexOf('jobs:\n'))
      .matchAll(
        /^ {2}([a-z][a-z-]+):\n([\s\S]*?)(?=^ {2}[a-z][a-z-]+:\n|$(?![\s\S]))/gm,
      ),
  ].map((match) => [match[1], match[2]]),
);

test('independent foundation jobs preserve every operation of npm check and every scripted workspace', () => {
  assert.equal(
    packageJson.scripts.check,
    'npm run ci:check && npm run account-policy:inventory:check && npm run lint && npm run typecheck && npm run stats:test && npm run search:eval:test && npm run openapi:check && npm test && npm run build',
  );
  assert.equal(
    packageJson.scripts['ci:check'],
    'node --test scripts/run-integration-shard.test.mjs scripts/run-integration-module.test.mjs scripts/ci-native-artifact.test.mjs scripts/ci-workflow.test.mjs',
  );
  assert.ok(jobs.plan.includes(`run: ${packageJson.scripts['ci:check']}\n`));
  assert.equal(
    packageJson.scripts['account-policy:inventory:check'],
    'node scripts/check-account-policy-routes.mjs',
  );
  for (const operation of ['typecheck', 'test', 'build']) {
    assert.equal(
      packageJson.scripts[operation],
      `npm run ${operation} --workspaces --if-present`,
    );
  }
  const workspaces = packageJson.workspaces
    .flatMap((pattern) => globSync(`${pattern}/package.json`, { cwd: root }))
    .map((path) => JSON.parse(read(path)))
    .filter((workspace) =>
      ['typecheck', 'test', 'build'].some((name) => workspace.scripts?.[name]),
    );
  assert.deepEqual(workspaces.map((workspace) => workspace.name).sort(), [
    '@whaleu/api',
    '@whaleu/wechat',
  ]);
  for (const [job, name] of [
    ['api-checks', '@whaleu/api'],
    ['native-checks', '@whaleu/wechat'],
  ]) {
    for (const operation of ['typecheck', 'test', 'build'])
      assert.ok(jobs[job].includes(`run: npm run ${operation} -w ${name}\n`));
  }
  for (const command of [
    'account-policy:inventory:check',
    'lint',
    'format:check',
    'stats:test',
    'search:eval:test',
  ])
    assert.ok(jobs.foundation.includes(`run: npm run ${command}\n`));
  assert.ok(jobs['api-checks'].includes('run: npm run openapi:check\n'));
  for (const job of [
    'foundation',
    'api-checks',
    'native-checks',
    'semantic-integration',
  ])
    assert.doesNotMatch(jobs[job], /^ {4}needs:/m);
});

test('matrix is derived from exact inventory with bounded parallel independent databases', () => {
  assert.match(
    jobs.foundation,
    /node --test scripts\/verify-test-postgres\.test\.mjs/,
  );
  assert.match(jobs.plan, /run-integration-module\.mjs --matrix/);
  assert.match(jobs.plan, /run-integration-module\.mjs --verify/);
  for (const guard of [
    'run-integration-shard',
    'run-integration-module',
    'ci-native-artifact',
    'ci-workflow',
  ])
    assert.ok(jobs.plan.includes(`scripts/${guard}.test.mjs`));
  assert.match(jobs['main-integration'], /needs: \[plan, native-checks\]/);
  assert.match(
    jobs['main-integration'],
    /matrix: \$\{\{ fromJSON\(needs\.plan\.outputs\.matrix\) \}\}/,
  );
  assert.match(jobs['main-integration'], /max-parallel: 8/);
  assert.match(jobs['main-integration'], /fail-fast: false/);
  assert.match(
    jobs['main-integration'],
    /MAIN_PG_CONTAINER: .*github\.run_id.*github\.run_attempt.*matrix\.id/,
  );
  assert.match(
    jobs['main-integration'],
    /timeout 7200 node scripts\/run-integration-module\.mjs --module "\$CI_MODULE" --shard "\$CI_SHARD"/,
  );
  assert.match(jobs['main-integration'], /postgres:18\.6-bookworm/);
  assert.match(
    jobs['semantic-integration'],
    /pgvector\/pgvector:0\.8\.7-pg18-bookworm@sha256:/,
  );
  for (const job of ['main-integration', 'semantic-integration']) {
    assert.match(jobs[job], /WHALEU_TEST_MAINTENANCE: controlled/);
    assert.match(jobs[job], /node scripts\/verify-test-postgres\.mjs/);
    assert.match(jobs[job], /if: always\(\)/);
    assert.match(jobs[job], /docker rm --force --volumes/);
  }
});

test('actual database test steps explicitly retain the synthetic test-runtime boundary', () => {
  for (const [job, name] of [
    ['main-integration', 'Real PostgreSQL integration tests'],
    ['semantic-integration', 'Optional semantic PostgreSQL integration tests'],
  ]) {
    const step = jobs[job]
      .split(`      - name: ${name}\n`)[1]
      ?.split('      - name:')[0];
    assert.ok(step, `${job} test step must exist`);
    assert.match(step, /^ {8}env:\n(?: {10}[^\n]+\n)*? {10}NODE_ENV: test$/m);
    assert.match(
      step,
      /TEST_DATABASE_URL: postgresql:\/\/whaleu_test:local_ci_only@127\.0\.0\.1:/,
    );
  }
});

test('native output is built once, transferred by producer ID and verified before any test database starts', () => {
  assert.equal(
    (workflow.match(/run: npm run build -w @whaleu\/wechat/g) ?? []).length,
    1,
  );
  assert.match(
    jobs['native-checks'],
    /artifact-id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/,
  );
  assert.match(
    jobs['native-checks'],
    /native-dist-\$\{\{ github.sha \}\}-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/,
  );
  assert.match(jobs['native-checks'], /if-no-files-found: error/);
  assert.match(jobs['native-checks'], /retention-days: 1/);
  assert.match(
    jobs['main-integration'],
    /artifact-ids: \$\{\{ needs.native-checks.outputs.artifact-id \}\}/,
  );
  assert.match(
    jobs['main-integration'],
    /WHALEU_ARTIFACT_ATTEMPT: \$\{\{ needs.native-checks.outputs.artifact-attempt \}\}/,
  );
  assert.ok(
    jobs['main-integration'].indexOf('ci-native-artifact.mjs restore') <
      jobs['main-integration'].indexOf('docker run'),
  );
  assert.doesNotMatch(
    jobs['main-integration'],
    /github-token:|repository:|run-id:|npm run build/,
  );
});

test('the existing required verify gate rejects every failure, skip and cancellation', () => {
  const expected = [
    'plan',
    'foundation',
    'api-checks',
    'native-checks',
    'main-integration',
    'semantic-integration',
  ];
  assert.match(jobs.verify, /if: always\(\)/);
  const needed = jobs.verify
    .match(/needs:\s*\[([^\]]+)\]/)[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  assert.deepEqual(needed, expected);
  assert.deepEqual(Object.keys(jobs).sort(), [...expected, 'verify'].sort());
  const resultVariables = [
    ...jobs.verify.matchAll(
      / {10}([A-Z_]+): \$\{\{ needs\.([a-z-]+)\.result \}\}/g,
    ),
  ];
  assert.deepEqual(
    resultVariables.map((match) => match[2]).sort(),
    [...expected].sort(),
  );
  const commands = [
    ...jobs.verify.matchAll(/^ {10}(test "\$[A-Z_]+" = success)$/gm),
  ]
    .map((match) => match[1])
    .join('\n');
  const success = Object.fromEntries(
    resultVariables.map((match) => [match[1], 'success']),
  );
  assert.equal(
    spawnSync('bash', ['-e', '-c', commands], { env: success }).status,
    0,
  );
  for (const key of Object.keys(success))
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      assert.notEqual(
        spawnSync('bash', ['-e', '-c', commands], {
          env: { ...success, [key]: result },
        }).status,
        0,
      );
    }
});

test('CI preserves read-only permissions, pinned actions and download-only lockfile cache boundaries', () => {
  assert.match(workflow, /permissions:\n {2}contents: read\n/);
  assert.doesNotMatch(
    workflow,
    /paths:|paths-ignore:|pull_request_target:|workflow_run:|continue-on-error:|secrets\.|id-token:|contents: write|cache-mode:/,
  );
  assert.match(setup, /cache: npm/);
  assert.match(setup, /cache-dependency-path: package-lock.json/);
  assert.match(setup, /node-version: 24\.19\.0/);
  assert.match(setup, /npm@11\.9\.0 --ignore-scripts/);
  assert.match(setup, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.doesNotMatch(setup, /node_modules|restore-keys|\.npmrc|secrets\./);
  for (const match of `${workflow}\n${setup}`.matchAll(/uses: (\S+)/g))
    assert.match(
      match[1],
      /^(\.\/\.github\/actions\/setup-ci|actions\/[a-z-]+@[a-f0-9]{40})$/,
    );
});

test('official-operator browser is pinned and installed only for its owner shard', () => {
  assert.ok(
    workflow.includes("if: matrix.module == 'official-account-browser'"),
  );
  assert.ok(
    workflow.includes(
      'node node_modules/playwright-core/cli.js install --with-deps chromium',
    ),
  );
  assert.ok(workflow.includes('node scripts/verify-official-browser.mjs'));
  assert.ok(
    workflow.includes(
      "runs-on: ${{ matrix.module == 'official-account-browser' && 'ubuntu-22.04' || 'ubuntu-24.04' }}",
    ),
  );
  assert.ok(
    workflow.includes('WHALEU_OFFICIAL_BROWSER_SANDBOX: ubuntu22-userns-v1'),
  );
  assert.ok(workflow.includes('2027-03-01'));
  assert.doesNotMatch(
    workflow,
    /CHROME_DEVEL_SANDBOX|WHALEU_OFFICIAL_SANDBOX_HELPER|sysctl\s+-w|--no-sandbox|--disable-namespace-sandbox/,
  );
  assert.ok(
    workflow.includes(
      "playwright-core-1.58.2-${{ hashFiles('package-lock.json') }}",
    ),
  );
  const api = JSON.parse(read('apps/api/package.json'));
  assert.equal(api.devDependencies['playwright-core'], '1.58.2');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.packages['node_modules/playwright-core'].version, '1.58.2');
  assert.equal(
    lock.packages['node_modules/playwright-core'].integrity,
    'sha512-yZkEtftgwS8CsfYo7nm0KE8jsvm6i/PTgVtB8DL726wNf6H2IMsDuxCpJj59KDaxCtSnrWan2AeDqM7JBaultg==',
  );
});

test('temporary browser userns admission rejects wrong host, root, inherited helper and expiry', () => {
  const host = {
    platform: 'linux',
    arch: 'x64',
    osId: 'ubuntu',
    osVersion: '22.04',
    euid: 1001,
    helperConfigured: false,
    chromeHelperConfigured: false,
    now: Date.parse('2026-10-14T00:00:00Z'),
  };
  assert.doesNotThrow(() => assertOfficialUsernsHost(host));
  for (const change of [
    { platform: 'darwin' },
    { arch: 'arm64' },
    { osId: 'debian' },
    { osVersion: '24.04' },
    { euid: 0 },
    { euid: undefined },
    { helperConfigured: true },
    { chromeHelperConfigured: true },
    { now: Date.parse(OFFICIAL_USERNS_RETIRE_BEFORE) },
  ])
    assert.throws(() => assertOfficialUsernsHost({ ...host, ...change }));
  const sandbox = read('scripts/official-browser-sandbox.mjs');
  assert.ok(sandbox.includes('info.mode & 0o7777'));
  assert.ok(sandbox.includes('0o4755'));
  assert.ok(sandbox.includes('info.mode & 0o022'));
  const launcher = read('apps/api/test/support/official-account-browser.ts');
  assert.doesNotMatch(
    launcher,
    /['"]--(?:no-sandbox|disable-setuid-sandbox|disable-namespace-sandbox|disable-seccomp-filter-sandbox)['"]/,
  );
  assert.match(sandbox, /execFileSync\(\s*'\/usr\/bin\/unshare'/);
});

test('rating promotion emits operator assets before either applicable database shard', () => {
  const integration = jobs['main-integration'];
  assert.match(
    integration,
    /name: Build emitted rating-promotion operator assets\n\s+if: matrix.module == 'rating-group-promotion' \|\| matrix.module == 'official-account-browser'\n\s+run: node --max-old-space-size=3072 node_modules\/typescript\/bin\/tsc -p apps\/api\/tsconfig.build.json/,
  );
  assert.ok(
    integration.indexOf('Build emitted rating-promotion operator assets') <
      integration.indexOf('Start fresh controlled-maintenance PostgreSQL'),
  );
  const launcher = read(
    'apps/api/test/support/rating-group-operator-browser.ts',
  );
  assert.match(launcher, /verifyOfficialBrowserSandbox/);
  assert.doesNotMatch(
    launcher,
    /['"]--(?:no-sandbox|disable-setuid-sandbox|disable-namespace-sandbox|disable-seccomp-filter-sandbox)['"]/,
  );
});
