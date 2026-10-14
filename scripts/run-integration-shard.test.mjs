import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  apiDirectory,
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
