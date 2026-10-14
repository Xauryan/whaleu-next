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
  assert.equal(plan.totalShards, 11);
  assert.equal(plan.totalFiles, inventory.length);
  assert.equal(plan.filesSha256, createShardPlan(inventory, 4).filesSha256);
  assert.deepEqual(
    plan.shards.flatMap((shard) => shard.files).sort(),
    inventory,
  );
  assert.equal(new Set(plan.shards.map((shard) => shard.id)).size, 11);
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

test('eleven-job matrix preserves the first eight jobs and inserts administration ninth', () => {
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
      'community-administration-1',
      'campus-services-2',
      'media-runtime-1',
    ],
  );
  const campus = ['campus-services-1', 'campus-services-2'].map((id) =>
    plan.shards.find((shard) => shard.id === id),
  );
  assert.deepEqual(
    campus.map((shard) => shard.shard),
    ['1/2', '2/2'],
  );
  assert.deepEqual(campus[0].owners, campus[1].owners);
  const inventory = discoverFiles();
  for (const [offset, families] of [
    [0, /^(activity|announcement|errand|major|organization)-/],
    [1, /^(campus-tools(?:-|\.test\.ts$)|(?:canteen|course|dish|window)-)/],
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

test('scoped avatar clear keeps all eight causal and emitted specs explicitly owned', () => {
  const plan = createModulePlan(discoverFiles(), readModules());
  const community = plan.shards.find(
    (shard) => shard.id === 'community-media-1',
  );
  const profile = plan.shards.find(
    (shard) => shard.id === 'identity-messaging-1',
  );
  const native =
    'test/integration/profile-avatar-moderation-native-roundtrip.test.ts';
  const causal = [
    'profile-avatar-moderation-authority.test.ts',
    'profile-avatar-moderation-causality.test.ts',
    'profile-avatar-moderation-concurrency.test.ts',
    'profile-avatar-moderation-current-proof.test.ts',
    'profile-avatar-moderation-delivery.test.ts',
    'profile-avatar-moderation-notices.test.ts',
    'profile-avatar-moderation.test.ts',
  ].map((name) => `test/integration/${name}`);
  assert.ok(community.files.includes(native));
  for (const file of causal) assert.ok(profile.files.includes(file));
  assert.deepEqual(
    plan.shards
      .flatMap((shard) => shard.files)
      .filter((file) =>
        file.startsWith('test/integration/profile-avatar-moderation'),
      )
      .sort(),
    [...causal, native].sort(),
  );
});

test('Community administration owns exactly twenty-nine removal, account moderation and historical-retention specs', () => {
  const plan = createModulePlan(discoverFiles(), readModules());
  const administration = plan.shards.find(
    (shard) => shard.id === 'community-administration-1',
  );
  const community = plan.shards.find(
    (shard) => shard.id === 'community-media-1',
  );
  assert.deepEqual(administration.owners, ['community', 'media']);
  assert.equal(administration.shard, '1/1');
  assert.deepEqual(administration.files, [
    'test/integration/account-appeals.test.ts',
    'test/integration/account-moderation-expiry.test.ts',
    'test/integration/account-moderation-migration.test.ts',
    'test/integration/account-moderation-native-roundtrip.test.ts',
    'test/integration/account-policy-consumers.test.ts',
    'test/integration/account-policy-detached-major-media.test.ts',
    'test/integration/account-policy-media-delivery.test.ts',
    'test/integration/account-policy-source-compatibility.test.ts',
    'test/integration/account-punishment-causal.test.ts',
    'test/integration/admin-discussion-removal-authority.test.ts',
    'test/integration/admin-discussion-removal-category.test.ts',
    'test/integration/admin-discussion-removal-causality.test.ts',
    'test/integration/admin-discussion-removal-concurrency.test.ts',
    'test/integration/admin-discussion-removal-current-proof.test.ts',
    'test/integration/admin-discussion-removal-delivery.test.ts',
    'test/integration/admin-discussion-removal-inventory.test.ts',
    'test/integration/admin-discussion-removal-native-roundtrip.test.ts',
    'test/integration/admin-discussion-removal-upgrade.test.ts',
    'test/integration/admin-discussion-removal.test.ts',
    'test/integration/admin-post-removal-authority.test.ts',
    'test/integration/admin-post-removal-causality.test.ts',
    'test/integration/admin-post-removal-concurrency.test.ts',
    'test/integration/admin-post-removal-current-proof.test.ts',
    'test/integration/admin-post-removal-delivery.test.ts',
    'test/integration/admin-post-removal-native-roundtrip.test.ts',
    'test/integration/admin-post-removal-notices.test.ts',
    'test/integration/admin-post-removal.test.ts',
    'test/integration/historical-account-punishment-policy.test.ts',
    'test/integration/historical-command-session-retention.test.ts',
    'test/integration/profile-self-edit-causality.test.ts',
  ]);
  assert.ok(
    administration.files.every((file) => !community.files.includes(file)),
  );
  assert.deepEqual(
    plan.shards
      .flatMap((shard) => shard.files)
      .filter(
        (file) =>
          /\/admin-(discussion|post)-removal/.test(file) ||
          [
            'test/integration/account-appeals.test.ts',
            'test/integration/account-moderation-expiry.test.ts',
            'test/integration/account-moderation-migration.test.ts',
            'test/integration/account-moderation-native-roundtrip.test.ts',
            'test/integration/account-policy-consumers.test.ts',
            'test/integration/account-policy-detached-major-media.test.ts',
            'test/integration/account-policy-media-delivery.test.ts',
            'test/integration/account-policy-source-compatibility.test.ts',
            'test/integration/account-punishment-causal.test.ts',
            'test/integration/historical-account-punishment-policy.test.ts',
            'test/integration/profile-self-edit-causality.test.ts',
          ].includes(file) ||
          file ===
            'test/integration/historical-command-session-retention.test.ts',
      )
      .sort(),
    administration.files,
  );
});

test('matrixOrder only schedules stable shards and defaults to manifest flattening', () => {
  const original = createModulePlan(files, manifest);
  assert.deepEqual(
    original.shards.map(({ id }) => id),
    ['first-1', 'first-2', 'shared-1'],
  );
  const reordered = mutate((m) => {
    m.matrixOrder = ['first-2', 'shared-1', 'first-1'];
  });
  const snapshot = structuredClone(reordered);
  const plan = createModulePlan(files, reordered);
  assert.deepEqual(plan, {
    ...original,
    shards: [original.shards[1], original.shards[2], original.shards[0]],
  });
  assert.deepEqual(createModulePlan([...files].reverse(), reordered), plan);
  assert.deepEqual(createModulePlan(files, reordered), plan);
  assert.deepEqual(reordered, snapshot);
  const writes = [];
  const deps = {
    files,
    manifest: reordered,
    write: (value) => writes.push(JSON.parse(value)),
    run: () => assert.fail('dry-run cannot execute'),
  };
  main(['--matrix'], deps);
  main(['--verify'], deps);
  main(['--module', 'first', '--shard', '2/2', '--list'], deps);
  assert.deepEqual(
    writes[0].include,
    plan.shards.map(({ id, module, label, shard }) => ({
      id,
      module,
      label,
      shard,
    })),
  );
  assert.deepEqual(writes[1], plan);
  assert.deepEqual(writes[2].shards, [original.shards[1]]);
  assert.equal(
    main(['--module', 'first', '--shard', '2/2'], {
      ...deps,
      run: (selected) => {
        assert.deepEqual(selected, original.shards[1].files);
        return 17;
      },
    }),
    17,
  );
});

test('real scheduling permutation preserves full inventory and every stable shard', () => {
  const manifest = readModules();
  const scheduled = createModulePlan(discoverFiles(), manifest);
  delete manifest.matrixOrder;
  const flattened = createModulePlan(discoverFiles(), manifest);
  assert.equal(scheduled.filesSha256, flattened.filesSha256);
  assert.equal(scheduled.totalFiles, flattened.totalFiles);
  assert.deepEqual(scheduled.shards.slice(0, 8), flattened.shards.slice(0, 8));
  for (const shard of scheduled.shards) {
    assert.deepEqual(
      shard,
      flattened.shards.find(({ id }) => id === shard.id),
    );
  }
});

test('matrixOrder rejects incomplete, duplicate, extra and invalid IDs or types', () => {
  for (const matrixOrder of [
    undefined,
    null,
    false,
    3,
    'first-1',
    {},
    [],
    ['first-1', 'first-2'],
    ['first-1', 'first-2', 'shared-1', 'extra-1'],
    ['first-1', 'first-1', 'shared-1'],
    ['first-1', 'first-2', 'extra-1'],
    ['first-1', 'first-2', 1],
    ['first-1', 'first-2', null],
    ['first-1', 'first-2', { id: 'shared-1' }],
    ['first-1', 'first-2', ''],
    Object.assign(new Array(3), { 0: 'first-1', 2: 'shared-1' }),
  ]) {
    assert.throws(
      () =>
        createModulePlan(
          files,
          mutate((m) => {
            m.matrixOrder = matrixOrder;
          }),
        ),
      /matrixOrder/,
    );
  }
});
