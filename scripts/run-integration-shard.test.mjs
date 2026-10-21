import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createModulePlan, readModules } from './run-integration-module.mjs';
import {
  apiDirectory,
  admitPerFileEnvironment,
  cleanupPerFileContainers,
  inspectOwnedContainer,
  runIsolatedTests,
  createShardPlan,
  discoverFiles,
  main,
  parseArguments,
  runTests,
} from './run-integration-shard.mjs';

const fixtures = Array.from(
  { length: 100 },
  (_, index) => `test/integration/case-${index}.test.ts`,
);

function assignment(plan) {
  return new Map(
    plan.shards.flatMap((shard) =>
      shard.files.map((file) => [file, shard.index]),
    ),
  );
}

test('every real integration glob file belongs to exactly one nonempty shard', () => {
  const files = discoverFiles();
  const plan = createShardPlan(files, 4);
  assert.equal(plan.totalFiles, files.length);
  assert.equal(plan.totalShards, 4);
  assert.equal(
    plan.filesSha256,
    createHash('sha256').update(files.join('\n')).digest('hex'),
  );
  assert.ok(plan.shards.every((shard) => shard.files.length > 0));
  const assigned = plan.shards.flatMap((shard) => shard.files);
  assert.equal(new Set(assigned).size, files.length);
  assert.deepEqual(assigned.sort(), files);
});

test('assignment is deterministic and new files do not move existing files', () => {
  const original = createShardPlan(fixtures, 4);
  assert.deepEqual(createShardPlan([...fixtures].reverse(), 4), original);
  const added = 'test/integration/a-new-future-file.test.ts';
  const expanded = createShardPlan([...fixtures, added], 4);
  const before = assignment(original);
  const after = assignment(expanded);
  for (const file of fixtures) assert.equal(after.get(file), before.get(file));
  assert.ok(after.has(added));
  assert.equal(after.size, fixtures.length + 1);
  assert.notEqual(expanded.filesSha256, original.filesSha256);
});

test('discovery automatically includes new matching files and excludes other suites', () => {
  const root = mkdtempSync(join(tmpdir(), 'whaleu-shard-'));
  try {
    mkdirSync(join(root, 'test/integration'), { recursive: true });
    mkdirSync(join(root, 'test/semantic-integration'));
    writeFileSync(join(root, 'test/integration/first.test.ts'), '');
    writeFileSync(join(root, 'test/integration/helper.ts'), '');
    writeFileSync(join(root, 'test/semantic-integration/optional.test.ts'), '');
    assert.deepEqual(discoverFiles(root), ['test/integration/first.test.ts']);
    writeFileSync(join(root, 'test/integration/added.test.ts'), '');
    assert.deepEqual(discoverFiles(root), [
      'test/integration/added.test.ts',
      'test/integration/first.test.ts',
    ]);
    mkdirSync(join(root, 'test/integration/directory.test.ts'));
    assert.throws(() => discoverFiles(root), /non-file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty, duplicate, escaping and invalid plans fail rather than skip files', () => {
  for (const total of [0, -1, 1.5, NaN, Infinity, '4', 101]) {
    assert.throws(() => createShardPlan(fixtures, total));
  }
  assert.throws(() => createShardPlan([], 1));
  assert.throws(
    () => createShardPlan([...fixtures, fixtures[0]], 4),
    /Duplicate/,
  );
  for (const file of [
    '--test-skip-pattern=.*',
    '/tmp/example.test.ts',
    'test/integration/../outside.test.ts',
  ]) {
    assert.throws(() => createShardPlan([file], 1), /Unexpected/);
  }
  // Both names deliberately map to shard 1/2, so shard 2 must fail admission.
  const sameShard = fixtures
    .filter(
      (file) =>
        createHash('sha256')
          .update(file.slice('test/integration/'.length))
          .digest()
          .readUInt32BE(0) %
          2 ===
        0,
    )
    .slice(0, 2);
  assert.throws(() => createShardPlan(sameShard, 2), /Empty/);
});

test('only exact positive safe INDEX/TOTAL and supported arguments are accepted', () => {
  assert.deepEqual(parseArguments(['--shard', '2/4']), {
    index: 2,
    total: 4,
    list: false,
  });
  assert.deepEqual(parseArguments(['--shard', '4/4', '--list']), {
    index: 4,
    total: 4,
    list: true,
  });
  assert.deepEqual(parseArguments(['--verify', '4']), { total: 4, list: true });
  for (const value of [
    '0/4',
    '1/0',
    '-1/4',
    '1.5/4',
    '5/4',
    '01/4',
    '1/04',
    '1/4/5',
    '1/9007199254740992',
    'NaN/4',
    '1/4 ',
  ]) {
    assert.throws(() => parseArguments(['--shard', value]));
  }
  for (const args of [
    [],
    ['--shard'],
    ['--verify', '0'],
    ['--verify', '4', '--list'],
    ['--shard', '1/4', '--unknown'],
    ['--shard', '1/4', '--list', 'extra'],
  ]) {
    assert.throws(() => parseArguments(args));
  }
});

test('verify and list emit auditable manifests without executing tests', () => {
  const writes = [];
  const dependencies = {
    files: fixtures,
    write: (value) => writes.push(JSON.parse(value)),
    run: () => assert.fail('No test process allowed'),
  };
  assert.equal(main(['--verify', '4'], dependencies), 0);
  assert.equal(main(['--shard', '3/4', '--list'], dependencies), 0);
  assert.equal(writes[0].shards.length, 4);
  assert.deepEqual(writes[1].shards, [writes[0].shards[2]]);
  assert.equal(writes[0].filesSha256, writes[1].filesSha256);
});

test('execution forwards exactly the selected files and preserves nonzero test status', () => {
  const expected = createShardPlan(fixtures, 4).shards[1].files;
  const code = main(['--shard', '2/4'], {
    files: fixtures,
    write: () => {},
    run: (files) => {
      assert.deepEqual(files, expected);
      return 17;
    },
  });
  assert.equal(code, 17);
});

test('test command preserves serial execution, tsx, API cwd and inherited environment', () => {
  const files = createShardPlan(fixtures, 4).shards[0].files;
  assert.equal(
    runTests(files, (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [
        '--import',
        'tsx',
        '--test',
        '--test-concurrency=1',
        ...files,
      ]);
      assert.deepEqual(options, { cwd: apiDirectory, stdio: 'inherit' });
      return { status: 0, signal: null };
    }),
    0,
  );
  assert.throws(
    () => runTests([], () => assert.fail('No process allowed')),
    /empty shard/,
  );
  assert.equal(
    runTests(files, () => ({ status: 1 })),
    1,
  );
  assert.equal(
    runTests(files, () => ({ status: null, signal: 'SIGTERM' })),
    143,
  );
  assert.throws(
    () => runTests(files, () => ({ error: new Error('spawn failed') })),
    /spawn failed/,
  );
  assert.throws(
    () => runTests(files, () => ({ status: null })),
    /Missing test exit/,
  );
});

test('CLI dry-run works without tsx or a database; invalid arguments exit nonzero', () => {
  const script = new URL('./run-integration-shard.mjs', import.meta.url);
  const result = spawnSync(
    process.execPath,
    [script.pathname, '--shard', '1/4', '--list'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).shards[0].index, 1);
  for (const args of [
    ['--shard', '0/4'],
    ['--shard', '1/0'],
    ['--shard', '5/4'],
    ['--verify', '0'],
  ]) {
    const rejected = spawnSync(process.execPath, [script.pathname, ...args], {
      encoding: 'utf8',
    });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
  }
});

test('TAP diagnostics are opt-in and preserve the exact integration command and failure status', () => {
  const files = [
    'test/integration/official-account-operator-roundtrip.test.ts',
  ];
  const status = runTests(
    files,
    (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [
        '--import',
        'tsx',
        '--test',
        '--test-concurrency=1',
        '--test-reporter=tap',
        ...files,
      ]);
      assert.deepEqual(options, { cwd: apiDirectory, stdio: 'inherit' });
      return { status: 1 };
    },
    { reporter: 'tap' },
  );
  assert.equal(status, 1);
  assert.throws(
    () =>
      runTests(files, () => assert.fail('must reject'), {
        reporter: 'unknown',
      }),
    /Unsupported/,
  );
});

test('TAP reports the original failure stack before a leaked test handle can prevent final summary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'browser-tap-live-'));
  try {
    const fixture = join(directory, 'leak.mjs');
    writeFileSync(
      fixture,
      `import test from 'node:test';
setInterval(()=>{},1000);
setTimeout(()=>process.exit(97),4000);
test('failure before leaked handle',()=>{throw Error('IMMEDIATE_BROWSER_DIAGNOSTIC')});
`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', fixture],
      { encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL', env },
    );
    assert.equal(result.error?.code, 'ETIMEDOUT');
    assert.match(result.stdout, /not ok 1 - failure before leaked handle/);
    assert.match(result.stdout, /error: 'IMMEDIATE_BROWSER_DIAGNOSTIC'/);
    assert.match(result.stdout, /stack: \|-/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const isolatedEnv = {
  CI: 'true',
  NODE_ENV: 'test',
  WHALEU_TEST_MAINTENANCE: 'controlled',
  WHALEU_TEST_PG_ISOLATION: 'per-file-docker',
  TEST_DATABASE_URL:
    'postgresql://whaleu_test:local_ci_only@127.0.0.1:5432/whaleu_test',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_SHA: 'a'.repeat(40),
  CI_MODULE: 'identity-messaging',
  CI_SHARD: '1/1',
  MAIN_PG_CONTAINER: 'whaleu-main-123-2-identity-messaging-1',
};
const isolatedFiles = [
  'test/integration/a.test.ts',
  'test/integration/b.test.ts',
];

function isolationHarness(intercept = () => undefined) {
  const calls = [],
    records = [],
    containers = new Map();
  let sequence = 0,
    time = 0;
  const spawn = (executable, args, options) => {
    calls.push({ executable, args, options });
    const override = intercept(executable, args, options, containers);
    if (override !== undefined) return override;
    const ok = (stdout = '') => ({ status: 0, stdout });
    if (executable !== 'docker') {
      if (args.includes('--eval')) {
        const state = containers.get(options.env.MAIN_PG_CONTAINER);
        return ok(
          `whaleu-${state.Config.Labels['whaleu.integration.cluster']}`,
        );
      }
      return ok();
    }
    const [operation, id] = args;
    if (operation === 'create') {
      const created = (++sequence).toString(16).padStart(64, '0');
      const nonce = args[2].slice(isolatedEnv.MAIN_PG_CONTAINER.length + 1);
      containers.set(created, {
        Id: created,
        Name: `/${args[2]}`,
        Config: {
          Image: 'postgres:18.6-bookworm',
          Labels: {
            'whaleu.integration.owner': isolatedEnv.MAIN_PG_CONTAINER,
            'whaleu.integration.cluster': nonce,
          },
          Cmd: [
            'postgres',
            '-c',
            'listen_addresses=127.0.0.1',
            '-p',
            '5432',
            '-c',
            'autovacuum=off',
            '-c',
            `cluster_name=whaleu-${nonce}`,
          ],
        },
        HostConfig: { NetworkMode: 'host', Binds: null, Mounts: [] },
        Mounts: [
          { Type: 'volume', Name: created, Destination: '/var/lib/postgresql' },
        ],
        State: { Running: true, Health: { Status: 'healthy' } },
      });
      return ok(created);
    }
    if (operation === 'inspect')
      return ok(JSON.stringify([containers.get(id)]));
    if (operation === 'rm') {
      containers.delete(args.at(-1));
      return ok();
    }
    if (operation === 'ps') return ok([...containers.keys()].join('\n'));
    if (['start', 'logs'].includes(operation)) return ok();
    assert.fail(`Unexpected Docker operation ${operation}`);
  };
  return {
    calls,
    records,
    containers,
    spawn,
    options: {
      env: isolatedEnv,
      write: (line) => records.push(JSON.parse(line)),
      read: (file) => `original source: ${file}`,
      uuid: () =>
        `${String(sequence + 1).padStart(8, '0')}-1111-1111-1111-111111111111`,
      now: () => time,
      sleep: () => {
        time += 10000;
      },
    },
  };
}

test('per-file CI admission rejects any implicit, foreign, browser or production target before Docker', () => {
  assert.equal(
    admitPerFileEnvironment(isolatedEnv),
    isolatedEnv.MAIN_PG_CONTAINER,
  );
  for (const change of [
    { CI: undefined },
    { NODE_ENV: 'production' },
    { WHALEU_TEST_MAINTENANCE: 'default' },
    { WHALEU_TEST_PG_ISOLATION: '' },
    { WHALEU_TEST_PG_ISOLATION: 'shared' },
    {
      TEST_DATABASE_URL:
        'postgresql://whaleu_test:local_ci_only@example.org/whaleu_test',
    },
    {
      TEST_DATABASE_URL: `${isolatedEnv.TEST_DATABASE_URL}?options=-cautovacuum=on`,
    },
    { GITHUB_RUN_ID: '' },
    { GITHUB_RUN_ATTEMPT: '0' },
    { GITHUB_SHA: 'short' },
    { CI_MODULE: 'official-account-browser' },
    { CI_SHARD: '../1' },
    { MAIN_PG_CONTAINER: 'foreign-container' },
  ]) {
    assert.throws(() =>
      runIsolatedTests(isolatedFiles, () => assert.fail('No Docker allowed'), {
        env: { ...isolatedEnv, ...change },
      }),
    );
  }
});

test('each exact source file has its own fresh admitted container, original command, full identity and final record', () => {
  const h = isolationHarness();
  assert.equal(runIsolatedTests(isolatedFiles, h.spawn, h.options), 0);
  const children = h.calls.filter(({ args }) => args.includes('--test'));
  assert.equal(children.length, isolatedFiles.length);
  for (let index = 0; index < isolatedFiles.length; index++) {
    const child = children[index],
      id = String(index + 1).padStart(64, '0');
    assert.deepEqual(child.args, [
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=1',
      isolatedFiles[index],
    ]);
    assert.deepEqual(child.options, {
      cwd: apiDirectory,
      stdio: 'inherit',
      env: { ...isolatedEnv, MAIN_PG_CONTAINER: id },
    });
    const start = h.calls.findIndex(
      ({ args }) => args[0] === 'start' && args[1] === id,
    );
    const admission = h.calls.findIndex(
      ({ args, options }) =>
        args[0]?.endsWith('/verify-test-postgres.mjs') &&
        options.env.MAIN_PG_CONTAINER === id,
    );
    assert.ok(
      start >= 0 && admission > start && h.calls.indexOf(child) > admission,
    );
    const end = h.records.find(
      (record) =>
        record.perFilePostgres === 'end' &&
        record.file === isolatedFiles[index],
    );
    assert.equal(end.containerId, id);
    assert.equal(end.sourceSha, isolatedEnv.GITHUB_SHA);
    assert.equal(
      end.fileSourceSha256,
      createHash('sha256')
        .update(`original source: ${join(apiDirectory, isolatedFiles[index])}`)
        .digest('hex'),
    );
    assert.equal(end.status, 0);
    assert.equal(end.outcome, 'passed');
  }
  assert.equal(h.records.length, 4);
  assert.equal(h.containers.size, 0);
  const creates = h.calls.filter(({ args }) => args[0] === 'create');
  assert.equal(new Set(creates.map(({ args }) => args[2])).size, 2);
  for (const { args } of creates) {
    assert.ok(args.includes('postgres:18.6-bookworm'));
    assert.ok(args.includes('autovacuum=off'));
    assert.ok(args.includes('listen_addresses=127.0.0.1'));
    assert.ok(
      !args.includes('--mount') &&
        !args.includes('--volume') &&
        !args.includes('-v'),
    );
  }
});

test('assertion failure keeps its nonzero result and still executes every later file exactly once', () => {
  let tests = 0;
  const h = isolationHarness((_executable, args) =>
    args.includes('--test') ? { status: ++tests === 1 ? 1 : 0 } : undefined,
  );
  assert.equal(runIsolatedTests(isolatedFiles, h.spawn, h.options), 1);
  assert.equal(tests, 2);
  assert.deepEqual(
    h.records
      .filter((r) => r.perFilePostgres === 'end')
      .map((r) => [r.file, r.status, r.outcome]),
    [
      [isolatedFiles[0], 1, 'failed'],
      [isolatedFiles[1], 0, 'passed'],
    ],
  );
  assert.equal(h.calls.filter(({ args }) => args[0] === 'logs').length, 1);
  assert.equal(h.containers.size, 0);
});

test('create, start, admission, test spawn and signal failures never label unrun files passed', () => {
  for (const stage of ['create', 'start', 'admission', 'spawn', 'signal']) {
    const h = isolationHarness((executable, args) => {
      if (executable === 'docker' && args[0] === stage) return { status: 9 };
      if (
        stage === 'admission' &&
        args[0]?.endsWith('/verify-test-postgres.mjs')
      )
        return { status: 8 };
      if (args.includes('--test') && stage === 'spawn')
        return { error: new Error('spawn denied') };
      if (args.includes('--test') && stage === 'signal')
        return { status: null, signal: 'SIGTERM' };
    });
    assert.throws(() => runIsolatedTests(isolatedFiles, h.spawn, h.options));
    assert.equal(h.records.length, 2);
    assert.equal(h.records[1].outcome, 'infrastructure-failure');
    assert.equal(h.records[1].file, isolatedFiles[0]);
    assert.equal(h.records[1].status, stage === 'signal' ? 143 : null);
    assert.equal(h.containers.size, 0);
  }
});

test('readiness timeout is bounded, fails closed, cleans only owned service and stops remaining files', () => {
  const h = isolationHarness((_executable, args, _options, containers) => {
    if (args[0] === 'inspect') {
      const state = containers.get(args[1]);
      state.State.Health.Status = 'starting';
    }
  });
  assert.throws(
    () => runIsolatedTests(isolatedFiles, h.spawn, h.options),
    /did not become ready/,
  );
  assert.equal(h.calls.filter(({ args }) => args.includes('--test')).length, 0);
  assert.ok(h.calls.filter(({ args }) => args[0] === 'inspect').length < 12);
  assert.equal(h.containers.size, 0);
  assert.equal(h.records[1].outcome, 'infrastructure-failure');
});

test('failed cleanup cannot produce pass and never starts another file', () => {
  const h = isolationHarness((_executable, args) =>
    args[0] === 'rm' ? { status: 1 } : undefined,
  );
  assert.throws(
    () => runIsolatedTests(isolatedFiles, h.spawn, h.options),
    /rm failed/,
  );
  assert.equal(h.records[1].status, 0);
  assert.equal(h.records[1].outcome, 'infrastructure-failure');
  assert.equal(h.calls.filter(({ args }) => args[0] === 'create').length, 1);
  assert.equal(h.containers.size, 1);
});

test('foreign ID, owner, image, command, networking and any host mount fail ownership admission without deletion', () => {
  for (const alter of [
    (s) => {
      s.Id = 'f'.repeat(64);
    },
    (s) => {
      s.Config.Labels['whaleu.integration.owner'] = 'foreign';
    },
    (s) => {
      s.Config.Image = 'postgres:latest';
    },
    (s) => {
      s.Config.Cmd = ['postgres'];
    },
    (s) => {
      s.HostConfig.NetworkMode = 'bridge';
    },
    (s) => {
      s.HostConfig.Binds = ['/data:/var/lib/postgresql'];
    },
    (s) => {
      s.HostConfig.Mounts = [{ Type: 'volume' }];
    },
    (s) => {
      s.Mounts[0].Type = 'bind';
    },
    (s) => {
      s.Mounts[0].Name = 'shared-data';
    },
  ]) {
    const h = isolationHarness((_executable, args, _options, containers) => {
      if (args[0] === 'inspect') alter(containers.get(args[1]));
    });
    assert.throws(
      () => runIsolatedTests(isolatedFiles, h.spawn, h.options),
      /unowned or unexpected/,
    );
    assert.equal(
      h.calls.filter(({ args }) => ['start', 'rm'].includes(args[0])).length,
      0,
    );
    assert.equal(h.records[1].outcome, 'infrastructure-failure');
  }
  assert.throws(
    () =>
      inspectOwnedContainer('short', isolatedEnv.MAIN_PG_CONTAINER, () =>
        assert.fail('No inspect'),
      ),
    /Full container ID/,
  );
});

test('cancellation cleanup discovers only exact owner label and revalidates full identity before every removal', () => {
  const h = isolationHarness((_executable, args) =>
    args[0] === 'rm' ? { status: 1 } : undefined,
  );
  assert.throws(() => runIsolatedTests(isolatedFiles, h.spawn, h.options));
  const clean = [];
  const spawn = (executable, args, options) => {
    clean.push(args);
    if (args[0] === 'rm') {
      h.containers.delete(args.at(-1));
      return { status: 0 };
    }
    return h.spawn(executable, args, options);
  };
  assert.equal(cleanupPerFileContainers(isolatedEnv, spawn), 0);
  assert.deepEqual(clean[0], [
    'ps',
    '--all',
    '--quiet',
    '--no-trunc',
    '--filter',
    `label=whaleu.integration.owner=${isolatedEnv.MAIN_PG_CONTAINER}`,
  ]);
  assert.deepEqual(
    clean.map((args) => args[0]),
    ['ps', 'inspect', 'rm'],
  );
  assert.equal(h.containers.size, 0);
});

test('source hashing fails before any service mutation and rejects duplicate or escaped file inventory', () => {
  for (const files of [
    [],
    [isolatedFiles[0], isolatedFiles[0]],
    ['test/integration/../a.test.ts'],
  ])
    assert.throws(() =>
      runIsolatedTests(files, () => assert.fail('No Docker'), {
        env: isolatedEnv,
      }),
    );
  assert.throws(
    () =>
      runIsolatedTests(isolatedFiles, () => assert.fail('No Docker'), {
        env: isolatedEnv,
        read: () => {
          throw new Error('source unreadable');
        },
      }),
    /source unreadable/,
  );
});

test('cancellation cleanup refuses foreign results or an uncertain inspect without deleting anything', () => {
  for (const inspectResult of [
    {
      status: 0,
      stdout: JSON.stringify([
        {
          Id: 'a'.repeat(64),
          Config: { Labels: { 'whaleu.integration.owner': 'another-job' } },
        },
      ]),
    },
    { status: 1 },
    { error: new Error('inspect timeout') },
  ]) {
    const calls = [];
    assert.throws(() =>
      cleanupPerFileContainers(isolatedEnv, (_executable, args) => {
        calls.push(args[0]);
        if (args[0] === 'ps') return { status: 0, stdout: 'a'.repeat(64) };
        if (args[0] === 'inspect') return inspectResult;
        assert.fail('No deletion permitted');
      }),
    );
    assert.deepEqual(calls, ['ps', 'inspect']);
  }
});

test('default and browser command dispatch never invoke Docker; unknown explicit isolation fails closed', () => {
  const saved = process.env.WHALEU_TEST_PG_ISOLATION;
  try {
    delete process.env.WHALEU_TEST_PG_ISOLATION;
    for (const reporter of [undefined, 'tap']) {
      const calls = [];
      assert.equal(
        runTests(
          isolatedFiles,
          (executable, args) => {
            calls.push({ executable, args });
            assert.equal(executable, process.execPath);
            return { status: 0 };
          },
          { reporter },
        ),
        0,
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args.slice(-2), isolatedFiles);
    }
    process.env.WHALEU_TEST_PG_ISOLATION = 'unknown';
    assert.throws(
      () => runTests(isolatedFiles, () => assert.fail('No Docker')),
      /controlled CI admission/,
    );
    assert.throws(
      () =>
        runTests(isolatedFiles, () => assert.fail('No Docker'), {
          reporter: 'tap',
        }),
      /Browser reporter/,
    );
  } finally {
    if (saved === undefined) delete process.env.WHALEU_TEST_PG_ISOLATION;
    else process.env.WHALEU_TEST_PG_ISOLATION = saved;
  }
});

test('every actual ordinary matrix ID exactly matches the isolated job-owner derivation', () => {
  const plan = createModulePlan(discoverFiles(), readModules());
  const ordinary = plan.shards.filter(
    (shard) => shard.module !== 'official-account-browser',
  );
  assert.ok(ordinary.length > 0);
  for (const shard of ordinary) {
    const expected = `whaleu-main-${isolatedEnv.GITHUB_RUN_ID}-${isolatedEnv.GITHUB_RUN_ATTEMPT}-${shard.id}`;
    assert.equal(
      admitPerFileEnvironment({
        ...isolatedEnv,
        CI_MODULE: shard.module,
        CI_SHARD: shard.shard,
        MAIN_PG_CONTAINER: expected,
      }),
      expected,
    );
  }
});

test('source mutation immediately before or during a child cannot be attributed a successful source hash', () => {
  for (const stage of ['before', 'during']) {
    let changed = false;
    const h = isolationHarness((_executable, args) => {
      if (stage === 'before' && args[0]?.endsWith('/verify-test-postgres.mjs'))
        changed = true;
      if (stage === 'during' && args.includes('--test')) changed = true;
    });
    const originalRead = h.options.read;
    h.options.read = (file) =>
      `${originalRead(file)}${changed ? ' changed' : ''}`;
    assert.throws(
      () => runIsolatedTests(isolatedFiles, h.spawn, h.options),
      /Integration source changed/,
    );
    assert.equal(h.records[1].outcome, 'infrastructure-failure');
    assert.equal(h.containers.size, 0);
    assert.equal(
      h.calls.filter(({ args }) => args.includes('--test')).length,
      stage === 'before' ? 0 : 1,
    );
  }
});

test('endpoint identity probe uses the exact controlled child URL, read-only SQL and bounded timeouts around freshness admission', () => {
  const h = isolationHarness();
  assert.equal(runIsolatedTests([isolatedFiles[0]], h.spawn, h.options), 0);
  const probes = h.calls.filter(({ args }) => args.includes('--eval'));
  assert.equal(probes.length, 2);
  const create = h.calls.find(({ args }) => args[0] === 'create');
  const nonce = create.args[2].slice(isolatedEnv.MAIN_PG_CONTAINER.length + 1);
  assert.ok(create.args.includes(`whaleu.integration.cluster=${nonce}`));
  assert.deepEqual(create.args.slice(-2), [
    '-c',
    `cluster_name=whaleu-${nonce}`,
  ]);
  const admission = h.calls.find(({ args }) =>
    args[0]?.endsWith('/verify-test-postgres.mjs'),
  );
  const child = h.calls.find(({ args }) => args.includes('--test'));
  assert.ok(h.calls.indexOf(probes[0]) < h.calls.indexOf(admission));
  assert.ok(h.calls.indexOf(probes[1]) > h.calls.indexOf(admission));
  assert.ok(h.calls.indexOf(probes[1]) < h.calls.indexOf(child));
  for (const probe of probes) {
    assert.equal(probe.executable, process.execPath);
    assert.equal(probe.options.cwd, apiDirectory);
    assert.deepEqual(probe.options.env, child.options.env);
    assert.equal(probe.options.timeout, 10000);
    assert.equal(probe.options.killSignal, 'SIGKILL');
    assert.match(
      probe.args.at(-1),
      /connectionTimeoutMillis: 5000, statement_timeout: 5000/,
    );
    assert.match(
      probe.args.at(-1),
      /SELECT current_setting\('cluster_name'\) AS marker/,
    );
    assert.match(
      probe.args.at(-1),
      /connectionString: process\.env\.TEST_DATABASE_URL/,
    );
    assert.doesNotMatch(
      probe.args.at(-1),
      /local_ci_only|postgresql:\/\/|INSERT|UPDATE|CREATE|ALTER|DELETE/,
    );
    const index = h.calls.indexOf(probe);
    assert.equal(h.calls[index - 1].args[0], 'inspect');
    assert.equal(h.calls[index + 1].args[0], 'inspect');
  }
  assert.equal(h.records[1].outcome, 'passed');
});

test('healthy foreign fresh listener and initialization false positives never launch freshness admission or any fixture', () => {
  for (const probeResult of [
    { status: 0, stdout: 'whaleu-ffffffff-ffff-ffff-ffff-ffffffffffff' },
    { status: 0, stdout: '' },
    { status: 1 },
    { error: new Error('bounded SQL probe timeout') },
  ]) {
    const h = isolationHarness((_executable, args) =>
      args.includes('--eval') ? probeResult : undefined,
    );
    assert.throws(() => runIsolatedTests(isolatedFiles, h.spawn, h.options));
    assert.equal(
      h.calls.filter(({ args }) =>
        args[0]?.endsWith('/verify-test-postgres.mjs'),
      ).length,
      0,
    );
    assert.equal(
      h.calls.filter(({ args }) => args.includes('--test')).length,
      0,
    );
    assert.equal(h.records.length, 2);
    assert.equal(h.records[1].outcome, 'infrastructure-failure');
    assert.equal(h.records[1].status, null);
    const removed = h.calls.filter(({ args }) => args[0] === 'rm');
    assert.deepEqual(
      removed.map(({ args }) => args),
      [['rm', '--force', '--volumes', '1'.padStart(64, '0')]],
    );
    assert.equal(h.containers.size, 0);
  }
});

test('listener replacement during freshness admission aborts before the original test file starts', () => {
  let probes = 0;
  const h = isolationHarness((_executable, args) => {
    if (args.includes('--eval') && ++probes === 2)
      return {
        status: 0,
        stdout: 'whaleu-ffffffff-ffff-ffff-ffff-ffffffffffff',
      };
  });
  assert.throws(
    () => runIsolatedTests(isolatedFiles, h.spawn, h.options),
    /endpoint does not belong/,
  );
  assert.equal(probes, 2);
  assert.equal(
    h.calls.filter(({ args }) => args[0]?.endsWith('/verify-test-postgres.mjs'))
      .length,
    1,
  );
  assert.equal(h.calls.filter(({ args }) => args.includes('--test')).length, 0);
  assert.equal(h.records[1].outcome, 'infrastructure-failure');
  assert.equal(h.containers.size, 0);
});

test('container stopping or losing health while matching SQL marker is read still fails before admission', () => {
  for (const change of [
    (state) => {
      state.State.Running = false;
    },
    (state) => {
      state.State.Health.Status = 'starting';
    },
  ]) {
    const h = isolationHarness((_executable, args, options, containers) => {
      if (args.includes('--eval'))
        change(containers.get(options.env.MAIN_PG_CONTAINER));
    });
    assert.throws(
      () => runIsolatedTests(isolatedFiles, h.spawn, h.options),
      /not running and healthy/,
    );
    assert.equal(
      h.calls.filter(
        ({ args }) =>
          args[0]?.endsWith('/verify-test-postgres.mjs') ||
          args.includes('--test'),
      ).length,
      0,
    );
    assert.equal(h.records[1].outcome, 'infrastructure-failure');
    assert.equal(h.containers.size, 0);
  }
});

test('startup nonce label, name and exact server command cannot diverge or be replaced during probe', () => {
  for (const change of [
    (state) => {
      state.Config.Labels['whaleu.integration.cluster'] = 'not-a-uuid';
    },
    (state) => {
      state.Name = '/another-container';
    },
    (state) => {
      state.Config.Cmd.push('-c', 'cluster_name=foreign');
    },
    (state) => {
      const replaced = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      state.Config.Labels['whaleu.integration.cluster'] = replaced;
      state.Name = `/${isolatedEnv.MAIN_PG_CONTAINER}-${replaced}`;
      state.Config.Cmd[state.Config.Cmd.length - 1] =
        `cluster_name=whaleu-${replaced}`;
    },
  ]) {
    const h = isolationHarness((_executable, args, options, containers) => {
      if (args.includes('--eval')) {
        const state = containers.get(options.env.MAIN_PG_CONTAINER);
        const originalMarker = `whaleu-${state.Config.Labels['whaleu.integration.cluster']}`;
        change(state);
        return { status: 0, stdout: originalMarker };
      }
    });
    assert.throws(
      () => runIsolatedTests(isolatedFiles, h.spawn, h.options),
      /unowned or unexpected/,
    );
    assert.equal(
      h.calls.filter(
        ({ args }) =>
          args[0]?.endsWith('/verify-test-postgres.mjs') ||
          args.includes('--test') ||
          args[0] === 'rm',
      ).length,
      0,
    );
    assert.equal(h.records[1].outcome, 'infrastructure-failure');
  }
});
