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
  assert.equal(plan.totalShards, 10);
  assert.equal(plan.totalFiles, inventory.length);
  assert.equal(plan.filesSha256, createShardPlan(inventory, 4).filesSha256);
  assert.deepEqual(
    plan.shards.flatMap((shard) => shard.files).sort(),
    inventory,
  );
  assert.equal(new Set(plan.shards.map((shard) => shard.id)).size, 10);
  assert.ok(
    plan.shards.find((shard) => shard.module === 'shared-foundation').owners
      .length > 1,
  );
});

test('scoped category SQL and emitted journey retain explicit Community ownership', () => {
  const plan = createModulePlan(discoverFiles(), readModules());
  const community = plan.shards.find(
    (shard) => shard.id === 'community-media-1',
  );
  assert.ok(community);
  for (const name of [
    'category-reclassification.test.ts',
    'category-reclassification-native-roundtrip.test.ts',
  ])
    assert.ok(community.files.includes(`test/integration/${name}`));
});

test('ten-job matrix preserves the first eight jobs and Campus ninth, then appends Media runtime', () => {
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
      'media-runtime-1',
    ],
  );
  const campus = plan.shards.slice(7, 9);
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

test('Media runtime moves exactly twelve complete files and retains Community publication ownership', () => {
  const plan = createModulePlan(discoverFiles(), readModules());
  const community = plan.shards.find(
    (shard) => shard.id === 'community-media-1',
  );
  const runtime = plan.shards.find((shard) => shard.id === 'media-runtime-1');
  assert.ok(community);
  assert.ok(runtime);
  assert.deepEqual(community.owners, ['community', 'media']);
  assert.deepEqual(runtime.owners, ['media', 'community']);
  assert.equal(runtime.shard, '1/1');
  assert.deepEqual(
    runtime.files,
    [
      'media-batch-process.test.ts',
      'media-deadline-v2.test.ts',
      'media-discussion-process.test.ts',
      'media-discussion-server-process.test.ts',
      'media-foundation.test.ts',
      'media-multipart-stream.test.ts',
      'media-native-process.test.ts',
      'media-native-read.test.ts',
      'media-native-upload.test.ts',
      'media-pipeline.test.ts',
      'media-recovery-v2.test.ts',
      'media-upload-v2.test.ts',
    ].map((name) => `test/integration/${name}`),
  );
  assert.deepEqual(
    community.files.filter((file) =>
      file.startsWith('test/integration/media-'),
    ),
    [
      'media-batch-budget.test.ts',
      'media-batch-publication.test.ts',
      'media-discovery.test.ts',
      'media-discussion-cleanup.test.ts',
      'media-discussion-deletion.test.ts',
      'media-discussion-proof.test.ts',
      'media-discussion-publication.test.ts',
      'media-publication.test.ts',
    ].map((name) => `test/integration/${name}`),
  );
  assert.ok(runtime.files.every((file) => !community.files.includes(file)));
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

test('nickname moderation keeps emitted Community and Profile causal ownership explicit', () => {
  const plan = createModulePlan(discoverFiles(), readModules());
  const community = plan.shards.find(
    (shard) => shard.id === 'community-media-1',
  );
  const profile = plan.shards.find(
    (shard) => shard.id === 'identity-messaging-1',
  );
  assert.ok(
    community.files.includes(
      'test/integration/profile-moderation-native-roundtrip.test.ts',
    ),
  );
  for (const name of [
    'profile-moderation.test.ts',
    'profile-moderation-causality.test.ts',
    'profile-moderation-avatar-preservation.test.ts',
    'profile-moderation-current-proof.test.ts',
    'profile-moderation-notices.test.ts',
  ])
    assert.ok(profile.files.includes(`test/integration/${name}`));
});
