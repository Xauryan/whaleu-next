import {
  assertOfficialUsernsHost,
  OFFICIAL_USERNS_RETIRE_BEFORE,
} from './official-browser-sandbox.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  globSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
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

function assertNativeBuildPrerequisites(job) {
  const steps = [
    ...job.matchAll(/^ {6}- [\s\S]*?(?=^ {6}- |$(?![\s\S]))/gm),
  ].map((match) => match[0]);
  const indexOfRun = (command) => {
    const matches = steps.flatMap((step, index) =>
      step.match(/^(?: {6}- | {8})run: ([^\n]+)$/m)?.[1] === command
        ? [index]
        : [],
    );
    assert.equal(matches.length, 1, `${command} must run exactly once`);
    return matches[0];
  };
  const typecheck = indexOfRun('npm run typecheck -w @whaleu/wechat');
  const build = indexOfRun('npm run build -w @whaleu/wechat');
  const tests = indexOfRun('npm run test -w @whaleu/wechat');
  assert.ok(typecheck < build, 'native typecheck must precede build');
  assert.ok(
    build < tests,
    'native build and emitted smoke checks must precede emitted-byte tests',
  );
  assert.doesNotMatch(steps[build], /^ {8}if:/m);
  assert.doesNotMatch(steps[tests], /^ {8}if:/m);
  const provenance = steps.findIndex((step) =>
    step.includes('        id: provenance\n'),
  );
  const upload = steps.findIndex((step) =>
    step.includes('        id: upload\n'),
  );
  assert.ok(
    tests < provenance && provenance < upload,
    'native tests must pass before staging and uploading immutable output',
  );
}

function assertLocalCheckPrerequisites(command) {
  const operations = command.split(' && ');
  assert.deepEqual(
    [...operations].sort(),
    [
      'npm run ci:check',
      'npm run account-policy:inventory:check',
      'npm run lint',
      'npm run typecheck',
      'npm run stats:test',
      'npm run search:eval:test',
      'npm run openapi:check',
      'npm run build',
      'npm test',
    ].sort(),
    'local check must retain every existing operation exactly once',
  );
  assert.ok(
    operations.indexOf('npm run build') < operations.indexOf('npm test'),
    'local check must build before emitted-byte tests',
  );
}

test('independent foundation jobs preserve every operation of npm check and every scripted workspace', () => {
  assert.equal(
    packageJson.scripts.check,
    'npm run ci:check && npm run account-policy:inventory:check && npm run lint && npm run typecheck && npm run stats:test && npm run search:eval:test && npm run openapi:check && npm run build && npm test',
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

test('native emitted-byte tests require the sole same-job build before tests and artifact publication', () => {
  assertNativeBuildPrerequisites(jobs['native-checks']);
  const buildStep =
    '      - name: Build native artifacts and run emitted smoke checks once\n' +
    '        run: npm run build -w @whaleu/wechat\n';
  const testStep = '      - run: npm run test -w @whaleu/wechat\n';
  const testsBeforeBuild = jobs['native-checks'].replace(
    buildStep + testStep,
    testStep + buildStep,
  );
  assert.notEqual(testsBeforeBuild, jobs['native-checks']);
  assert.throws(
    () => assertNativeBuildPrerequisites(testsBeforeBuild),
    /native build and emitted smoke checks must precede emitted-byte tests/,
  );
  const duplicateBuild = jobs['native-checks'].replace(
    buildStep,
    buildStep + buildStep,
  );
  assert.throws(
    () => assertNativeBuildPrerequisites(duplicateBuild),
    /npm run build -w @whaleu\/wechat must run exactly once/,
  );
});

test('local check builds once before emitted-byte tests without dropping operations or hiding a pretest build', () => {
  assertLocalCheckPrerequisites(packageJson.scripts.check);
  assert.equal(packageJson.scripts.pretest, undefined);
  assert.equal(
    JSON.parse(read('apps/wechat/package.json')).scripts.pretest,
    undefined,
  );
  const testsBeforeBuild = packageJson.scripts.check.replace(
    'npm run build && npm test',
    'npm test && npm run build',
  );
  assert.notEqual(testsBeforeBuild, packageJson.scripts.check);
  assert.throws(
    () => assertLocalCheckPrerequisites(testsBeforeBuild),
    /local check must build before emitted-byte tests/,
  );
  for (const invalid of [
    packageJson.scripts.check.replace('npm run lint && ', ''),
    `${packageJson.scripts.check} && npm run build`,
  ])
    assert.throws(
      () => assertLocalCheckPrerequisites(invalid),
      /local check must retain every existing operation exactly once/,
    );
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

test('browser-only deadline fails closed and kills only its own unresponsive process group', async () => {
  const step = jobs['main-integration']
    .split('      - name: Real PostgreSQL integration tests\n')[1]
    .split('      - name:')[0];
  const commands = step
    .split('        run: |\n')[1]
    .split('        env:')[0]
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
  assert.match(
    commands,
    /timeout --verbose --kill-after=10s 900s node scripts\/run-integration-module\.mjs/,
  );
  assert.match(
    commands,
    /else\n {2}export WHALEU_TEST_PG_ISOLATION=per-file-docker\n {2}timeout 7200 node scripts\/run-integration-module\.mjs/,
  );
  assert.doesNotMatch(
    commands,
    /--foreground|--preserve-status|--test-force-exit|\|\|/,
  );
  assert.match(
    jobs['main-integration'],
    /name: Remove disposable database container\n {8}if: always\(\)/,
  );

  const directory = mkdtempSync(join(tmpdir(), 'browser-deadline-'));
  const sentinel = spawn(
    process.execPath,
    ['-e', "process.on('message', () => process.send('alive'));"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  const sentinelExit = once(sentinel, 'exit');
  try {
    await once(sentinel, 'spawn');
    // The real workflow shell is exercised unchanged except for test duration.
    // This fake executable replaces Node, never the real browser E2E assertions.
    writeFileSync(
      join(directory, 'node'),
      `#!${process.execPath}
const mode = process.env.DEADLINE_TEST_MODE;
if (mode !== 'hang') process.exit(Number(mode));
const descendant = process.argv.includes('--descendant');
// Test-only fail-safe: exit 97 can never satisfy the expected KILL result.
setTimeout(() => {require('node:fs').writeSync(1, descendant ? 'FAILSAFE_DESCENDANT' : 'FAILSAFE_PARENT');process.exit(97);}, 4000);
process.on('SIGTERM', () => console.log(descendant ? 'DESCENDANT_TERM_SEEN' : 'PARENT_TERM_SEEN'));
console.log(descendant ? 'DESCENDANT_READY' : 'PARENT_READY');
if (!descendant) require('node:child_process').spawn(process.execPath, [__filename, '--descendant'], {stdio:'inherit'});
setInterval(() => {}, 1000);
`,
      { mode: 0o755 },
    );
    const shortened = commands.replace(
      '--kill-after=10s 900s',
      '--kill-after=0.2s 1s',
    );
    const run = (mode, module = 'official-account-browser') =>
      spawnSync('bash', ['-e', '-c', shortened], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          CI_MODULE: module,
          CI_SHARD: '1/1',
          DEADLINE_TEST_MODE: mode,
          LC_ALL: 'C',
        },
        encoding: 'utf8',
        timeout: 5000,
        killSignal: 'SIGKILL',
      });
    for (const module of [
      'official-account-browser',
      'rating-group-promotion',
    ]) {
      for (const status of [0, 17]) {
        const result = run(String(status), module);
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, status);
      }
    }
    const hung = run('hang');
    assert.equal(
      hung.error,
      undefined,
      'Outer watchdog must not be the terminating mechanism',
    );
    for (const role of ['PARENT', 'DESCENDANT']) {
      assert.ok(hung.stdout.includes(`${role}_READY`));
      assert.ok(hung.stdout.includes(`${role}_TERM_SEEN`));
    }
    assert.doesNotMatch(hung.stdout, /FAILSAFE_/);
    assert.match(hung.stderr, /sending signal TERM/);
    assert.match(hung.stderr, /sending signal KILL/);
    assert.ok(
      hung.status === 137 || hung.signal === 'SIGKILL',
      JSON.stringify(hung),
    );
    const alive = once(sentinel, 'message', {
      signal: AbortSignal.timeout(1000),
    });
    sentinel.send('ping');
    assert.deepEqual(await alive, ['alive', undefined]);
    assert.equal(
      sentinel.exitCode,
      null,
      'Unrelated sibling must remain running',
    );
    assert.equal(sentinel.signalCode, null);
    assert.equal(process.kill(sentinel.pid, 0), true);
  } finally {
    // Only this test's independently spawned sentinel is stopped here.
    sentinel.kill('SIGKILL');
    await sentinelExit;
    rmSync(directory, { recursive: true, force: true });
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
    'source-manual-production',
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

test('production source review owns a required strict-TLS acceptance lane', () => {
  const job = jobs['source-manual-production'];
  assert.match(job, /needs: \[api-checks\]/);
  assert.match(job, /source-manual-tls-sandbox\.sh run/);
  assert.match(
    job,
    /if: always\(\)[\s\S]*source-manual-tls-sandbox\.sh cleanup/,
  );
  const sandbox = read('scripts/source-manual-tls-sandbox.sh');
  assert.match(sandbox, /postgres:18\.6-bookworm/);
  assert.match(sandbox, /--publish 127\.0\.0\.1::5432/);
  assert.match(sandbox, /subjectAltName=DNS:localhost,IP:127\.0\.0\.1/);
  assert.match(sandbox, /export NODE_ENV=production/);
  assert.match(sandbox, /export NODE_EXTRA_CA_CERTS=/);
  assert.match(sandbox, /env -u NODE_EXTRA_CA_CERTS node/);
  assert.match(sandbox, /rejectUnauthorized:true/);
  assert.match(sandbox, /SELECT ssl,version FROM pg_stat_ssl/);
  assert.match(sandbox, /trap cleanup EXIT/);
  assert.match(sandbox, /Refusing cleanup of an unowned container/);
  assert.doesNotMatch(
    sandbox,
    /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|docker (?:system|container) prune|update-ca-certificates/,
  );
  assert.equal(
    packageJson.scripts['test:source-manual:production'],
    'npm run test:source-manual:production -w @whaleu/api',
  );
  assert.equal(
    JSON.parse(read('apps/api/package.json')).scripts[
      'test:source-manual:production'
    ],
    'node --import tsx --test --test-concurrency=1 test/production-integration/text-source-manual-production.test.ts',
  );
});

test('source review readiness cannot accept the temporary Unix-only initialization server', () => {
  const sandbox = read('scripts/source-manual-tls-sandbox.sh');
  assert.match(sandbox, /for attempt in \$\(seq 1 60\); do/);
  assert.match(
    sandbox,
    /docker exec "\$id" pg_isready -h 127\.0\.0\.1 -U whaleu_test -d whaleu_test/,
  );
  assert.match(
    sandbox,
    /\[\[ "\$attempt" -lt 60 \]\] \|\| \{ echo 'Disposable TLS database did not become ready' >&2; exit 1; \}/,
  );
  assert.ok(
    sandbox.indexOf('pg_isready -h 127.0.0.1') <
      sandbox.indexOf('SELECT ssl,version FROM pg_stat_ssl'),
  );
});

test('reading worker production acceptance requires the real build and password-backed TLS lane', () => {
  assert.deepEqual(
    globSync('apps/api/test/production-integration/*.test.ts', {
      cwd: root,
    }).sort(),
    [
      'apps/api/test/production-integration/reading-worker-process-production.test.ts',
      'apps/api/test/production-integration/text-source-manual-production.test.ts',
    ],
    'every production integration file must have an explicit serial TLS command',
  );
  const job = jobs['source-manual-production'];
  const build = job.indexOf('run: npm run build -w @whaleu/api');
  const run = job.indexOf('run: bash scripts/source-manual-tls-sandbox.sh run');
  assert.ok(build >= 0 && run > build);
  const sandbox = read('scripts/source-manual-tls-sandbox.sh');
  assert.match(sandbox, /export TEST_READING_LOGIN_AUTH=password/);
  assert.match(sandbox, /docker run --detach --network bridge --label/);
  assert.match(sandbox, /actual_owner.*docker inspect/);
  assert.match(sandbox, /actual_id.*docker inspect/);
  assert.match(
    sandbox,
    /assert.deepEqual\(Object.keys\(networks\),\['bridge'\]\)/,
  );
  assert.match(sandbox, /export TEST_READING_DOCKER_TARGET=/);
  assert.match(sandbox, /assert.equal\(url.hostname,'127\.0\.0\.1'\)/);

  assert.doesNotMatch(
    sandbox,
    /TEST_READING_LOGIN_AUTH=trust|POSTGRES_HOST_AUTH_METHOD=trust/,
  );
  assert.match(
    sandbox,
    /npm run test:source-manual:production\nnpm run test:reading-worker:production -w @whaleu\/api/,
  );
  assert.equal(
    JSON.parse(read('apps/api/package.json')).scripts[
      'test:reading-worker:production'
    ],
    'node --import tsx --test --test-concurrency=1 test/production-integration/reading-worker-process-production.test.ts',
  );
});

test('ordinary CI files use fresh-cluster lifecycle while browser setup and original outer deadlines remain intact', () => {
  const integration = jobs['main-integration'];
  const step = (name) =>
    integration.split(`      - name: ${name}\n`)[1]?.split('      - name:')[0];
  for (const name of [
    'Start fresh controlled-maintenance PostgreSQL',
    'Verify fresh controlled-maintenance service',
  ])
    assert.match(
      step(name),
      /^ {8}if: matrix.module == 'official-account-browser'$/m,
    );
  assert.match(
    step('Pull pinned per-file PostgreSQL image'),
    /^ {8}if: matrix.module != 'official-account-browser'\n {8}run: docker pull postgres:18\.6-bookworm$/m,
  );
  assert.ok(
    integration.indexOf('ci-native-artifact.mjs restore') <
      integration.indexOf('docker pull'),
  );
  assert.match(
    step('Real PostgreSQL integration tests'),
    /else\n {12}export WHALEU_TEST_PG_ISOLATION=per-file-docker\n {12}timeout 7200 node scripts\/run-integration-module\.mjs/,
  );
  assert.match(integration, /timeout-minutes: 150/);
  const cleanup = step('Remove disposable database container');
  assert.match(cleanup, /^ {8}if: always\(\)$/m);
  assert.match(
    cleanup,
    /else\n {12}export WHALEU_TEST_PG_ISOLATION=per-file-docker\n {12}node scripts\/run-integration-shard\.mjs --cleanup-per-file/,
  );
  assert.match(cleanup, /^ {10}NODE_ENV: test$/m);
  assert.match(
    cleanup,
    /^ {10}TEST_DATABASE_URL: postgresql:\/\/whaleu_test:local_ci_only@127\.0\.0\.1:5432\/whaleu_test$/m,
  );
  for (const job of ['semantic-integration', 'source-manual-production'])
    assert.doesNotMatch(jobs[job], /WHALEU_TEST_PG_ISOLATION|cleanup-per-file/);
});
