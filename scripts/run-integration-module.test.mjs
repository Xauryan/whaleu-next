import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { discoverFiles, createShardPlan } from './run-integration-shard.mjs';
import {
  createModulePlan,
  main,
  readModules,
} from './run-integration-module.mjs';

const files = [
  'test/integration/alpha.test.ts',
  'test/integration/beta.test.ts',
  'test/integration/gamma.test.ts',
];
const manifest = {
  version: 1,
  groups: [
    {
      id: 'first',
      label: 'First owner',
      owners: ['one'],
      shards: [['alpha.test.ts'], ['beta.test.ts']],
    },
    {
      id: 'shared',
      label: 'Shared contracts',
      owners: ['one', 'two'],
      shards: [['gamma.test.ts']],
    },
  ],
};
const mutate = (fn) => {
  const value = structuredClone(manifest);
  fn(value);
  return value;
};

test('real module inventory equals the old complete glob exactly once, with shared owners', () => {
  const inventory = discoverFiles();
  const plan = createModulePlan(inventory, readModules());
  assert.equal(plan.totalShards, 9);
  assert.equal(plan.totalFiles, inventory.length);
  assert.equal(plan.filesSha256, createShardPlan(inventory, 4).filesSha256);
  assert.deepEqual(
    plan.shards.flatMap((shard) => shard.files).sort(),
    inventory,
  );
  assert.equal(new Set(plan.shards.map((shard) => shard.id)).size, 9);
  assert.ok(
    plan.shards.find((shard) => shard.module === 'shared-foundation').owners
      .length > 1,
  );
});

test('nine-job matrix leaves both stable Campus shards after the other seven jobs', () => {
  const plan = createModulePlan(discoverFiles(), readModules());
  assert.deepEqual(
    plan.shards.map((shard) => shard.id),
    [
      'community-media-1',
      'ratings-discussion-1',
      'ratings-targets-effects-1',
      'ratings-catalog-1',
      'ratings-catalog-2',
      'shared-foundation-1',
      'identity-messaging-1',
      'campus-services-1',
      'campus-services-2',
    ],
  );
  const campus = plan.shards.slice(-2);
  assert.deepEqual(
    campus.map((shard) => shard.shard),
    ['1/2', '2/2'],
  );
  assert.deepEqual(campus[0].owners, campus[1].owners);
  const inventory = discoverFiles();
  for (const [offset, families] of [
    [0, /^(activity|announcement|errand|major|organization)-/],
    [1, /^(canteen|course|dish|window)-/],
  ]) {
    // Assert stable semantic ownership; selection itself uses explicit filenames.
    assert.deepEqual(
      campus[offset].files,
      inventory.filter((file) => families.test(file.split('/').at(-1))),
    );
  }
  assert.ok(
    campus[0].files.includes(
      'test/integration/major-discussion-delete.test.ts',
    ),
  );
  for (const name of [
    'window-discussion-images-native-roundtrip.test.ts',
    'window-discussion-media-upgrade.test.ts',
    'window-discussion-media.test.ts',
  ])
    assert.ok(campus[1].files.includes(`test/integration/${name}`));
});

test('mapping is deterministic and explicit; new tests, stale entries and duplicates fail closed', () => {
  assert.deepEqual(
    createModulePlan([...files].reverse(), manifest),
    createModulePlan(files, manifest),
  );
  assert.throws(
    () =>
      createModulePlan([...files, 'test/integration/new.test.ts'], manifest),
    /missing=.*new.test.ts/,
  );
  assert.throws(
    () => createModulePlan(files.slice(1), manifest),
    /unexpected=.*alpha.test.ts/,
  );
  assert.throws(
    () =>
      createModulePlan(
        files,
        mutate((m) => m.groups[1].shards[0].push('alpha.test.ts')),
      ),
    /duplicate=true/,
  );
  assert.throws(
    () => createModulePlan([...files, files[0]], manifest),
    /unique/,
  );
  assert.throws(() => createModulePlan([], manifest), /nonempty/);
});

test('invalid module identity, owner, version, traversal and empty shards cannot enter the matrix', () => {
  for (const change of [
    (m) => {
      m.version = 2;
    },
    (m) => {
      m.groups = [];
    },
    (m) => {
      m.groups[1].id = 'first';
    },
    (m) => {
      m.groups[1].id = 'bad $(command)';
    },
    (m) => {
      m.groups[1].label = '';
    },
    (m) => {
      m.groups[1].owners = [];
    },
    (m) => {
      m.groups[1].owners = [''];
    },
    (m) => {
      m.groups[1].shards = [];
    },
    (m) => {
      m.groups[1].shards = [[]];
    },
    (m) => {
      m.groups[1].shards = [['../gamma.test.ts']];
    },
    (m) => {
      m.groups[1].shards = [['--test-skip-pattern.test.ts']];
    },
  ])
    assert.throws(() => createModulePlan(files, mutate(change)));
});

test('matrix, verification and selected dry run are non-executing exact projections', () => {
  const writes = [];
  const deps = {
    files,
    manifest,
    write: (value) => writes.push(JSON.parse(value)),
    run: () => assert.fail('dry-run cannot execute'),
  };
  assert.equal(main(['--matrix'], deps), 0);
  assert.equal(main(['--verify'], deps), 0);
  assert.equal(
    main(['--module', 'first', '--shard', '2/2', '--list'], deps),
    0,
  );
  assert.deepEqual(
    writes[0].include,
    writes[1].shards.map(({ id, module, label, shard }) => ({
      id,
      module,
      label,
      shard,
    })),
  );
  assert.deepEqual(writes[2].shards, [writes[1].shards[1]]);
  assert.equal(writes[2].filesSha256, writes[1].filesSha256);
  assert.equal(writes[2].selectedFiles, 1);
});

test('execution forwards only the chosen module files and preserves failures', () => {
  assert.equal(
    main(['--module', 'first', '--shard', '2/2'], {
      files,
      manifest,
      write: () => {},
      run: (selected) => {
        assert.deepEqual(selected, [files[1]]);
        return 17;
      },
    }),
    17,
  );
  for (const args of [
    [],
    ['--verify', 'extra'],
    ['--module', 'unknown', '--shard', '1/1'],
    ['--module', 'first', '--shard', '1/1'],
    ['--module', 'first', '--verify', '2'],
    ['--module', 'first', '--shard', '0/2'],
    ['--module', 'first', '--shard', '1/2', '--skip'],
  ]) {
    assert.throws(() =>
      main(args, {
        files,
        manifest,
        write: () => {},
        run: () => assert.fail('invalid command cannot execute'),
      }),
    );
  }
});

test('all generated CLI matrix entries can list without dependencies or a database', () => {
  const script = new URL('./run-integration-module.mjs', import.meta.url)
    .pathname;
  const matrix = spawnSync(process.execPath, [script, '--matrix'], {
    encoding: 'utf8',
  });
  assert.equal(matrix.status, 0, matrix.stderr);
  const plans = [];
  for (const entry of JSON.parse(matrix.stdout).include) {
    const result = spawnSync(
      process.execPath,
      [script, '--module', entry.module, '--shard', entry.shard, '--list'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    plans.push(JSON.parse(result.stdout));
  }
  assert.equal(new Set(plans.map((plan) => plan.filesSha256)).size, 1);
  assert.deepEqual(
    plans.flatMap((plan) => plan.shards[0].files).sort(),
    discoverFiles(),
  );
});
