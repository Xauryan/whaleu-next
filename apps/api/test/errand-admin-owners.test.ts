import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import {
  ADMIN_PARTICIPANT_BATCH_LIMIT,
  ProfileAdminParticipantFacade,
} from '../src/profile/admin-participant.facade.js';
import {
  CampusErrandScopeFacade,
  ERRAND_ADMIN_REGION_BATCH_LIMIT,
} from '../src/campus/errand-scope.facade.js';
import type { CampusCommunityPolicyService } from '../src/campus/community-policy/campus-community-policy.service.js';
import {
  errandCountProofOwner,
  fenceErrandAdminReads,
} from '../src/errands/count-epochs.js';
import {
  profileCountProofOwner,
  fenceProfileAdminReads,
} from '../src/profile/count-epochs.js';

const id = (number: number) =>
  `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const unavailable = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'ERRAND_UNAVAILABLE';
const profiles = new ProfileAdminParticipantFacade();
const campus = new CampusErrandScopeFacade({
  sameGroup: async () => {
    assert.fail('Historical labels must not require a current region relation');
  },
} as unknown as CampusCommunityPolicyService);

function fixture(rows: readonly unknown[] = [], failure?: Error) {
  const commands: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      commands.push({ sql, values });
      if (failure) throw failure;
      return { rows };
    },
  } as unknown as PoolClient;
  return { tx, commands };
}
const participant = {
  accountId: id(1),
  profileId: id(3),
  displayName: '鲸鱼用户',
};

test('admin participant batch deduplicates joins, projects only public columns and preserves explicit absence', async () => {
  const f = fixture([participant]);
  const result = await profiles.batch([id(2), id(1), id(1)], f.tx);
  assert.deepEqual(
    [...result],
    [
      [
        id(1),
        { status: 'available', profileId: id(3), displayName: '鲸鱼用户' },
      ],
      [id(2), { status: 'unavailable' }],
    ],
  );
  assert.equal(f.commands.length, 1);
  const command = f.commands[0]!;
  assert.deepEqual(command.values, [[id(1), id(2)]]);
  assert.equal(
    command.sql.replace(/\s+/g, ' ').trim(),
    `SELECT account_id AS "accountId", public_id AS "profileId", coalesce(nickname,'鲸鱼用户') AS "displayName" FROM whaleu_profile.profiles WHERE account_id=ANY($1::uuid[]) ORDER BY account_id`,
  );
  assert.doesNotMatch(
    command.sql,
    /FOR SHARE|FOR UPDATE|INSERT|preferences|bio|selected_campus|contacts|student|provider/i,
  );
  assert.equal(JSON.stringify([...result.values()]).includes(id(1)), false);
  assert.equal(JSON.stringify([...result.values()]).includes(id(2)), false);
});

test('empty participant batches perform no query or implicit profile creation', async () => {
  const f = fixture();
  assert.equal((await profiles.batch([], f.tx)).size, 0);
  assert.equal(f.commands.length, 0);
});

test('participant bound counts unique accounts and rejects invalid identifiers before reading', async () => {
  assert.equal(ADMIN_PARTICIPANT_BATCH_LIMIT, 512);
  const ids = Array.from({ length: 512 }, (_, index) => id(index));
  const f = fixture();
  assert.equal((await profiles.batch([...ids, ...ids], f.tx)).size, 512);
  assert.equal(f.commands.length, 1);
  for (const invalid of [
    [...ids, id(512)],
    ['12345'],
    ['ABCDEF01-0000-4000-8000-000000000001'],
    ['not-an-id'],
  ]) {
    const rejected = fixture();
    await assert.rejects(profiles.batch(invalid, rejected.tx), unavailable);
    assert.equal(rejected.commands.length, 0);
  }
});

test('participant facts fail closed on malformed, unrelated, duplicate or private-shaped rows', async () => {
  for (const rows of [
    [{ ...participant, profileId: '12345' }],
    [{ ...participant, profileId: 'ABCDEF01-0000-4000-8000-000000000001' }],
    [{ ...participant, displayName: '' }],
    [{ ...participant, displayName: 'x'.repeat(21) }],
    [{ ...participant, displayName: 'bad\u0000name' }],
    [{ ...participant, displayName: null }],
    [{ ...participant, accountId: id(9) }],
    [{ ...participant, preferences: { hideProfilePosts: true } }],
    [participant, participant],
    [participant, { ...participant, accountId: id(2) }],
  ])
    await assert.rejects(
      profiles.batch([id(1), id(2)], fixture(rows).tx),
      unavailable,
    );
});

test('a failed participant query cannot masquerade as missing profiles', async () => {
  for (const failure of [
    new Error('private database failure'),
    Object.assign(new Error('cancelled'), { code: '57014' }),
  ])
    await assert.rejects(
      profiles.batch([id(1)], fixture([], failure).tx),
      unavailable,
    );
});

test('historical labels retain inactive regions and independently represent missing source or target IDs', async () => {
  const f = fixture([
    { id: id(1), label: 'Retired source', active: false },
    { id: id(2), label: 'Active target', active: true },
  ]);
  assert.deepEqual(
    [...(await campus.historicalBatch([id(3), id(2), id(1), id(1)], f.tx))],
    [
      [
        id(1),
        {
          id: id(1),
          status: 'available',
          label: 'Retired source',
          active: false,
        },
      ],
      [
        id(2),
        {
          id: id(2),
          status: 'available',
          label: 'Active target',
          active: true,
        },
      ],
      [id(3), { id: id(3), status: 'unavailable' }],
    ],
  );
  assert.equal(f.commands.length, 1);
  assert.deepEqual(f.commands[0]!.values, [[id(1), id(2), id(3)]]);
  assert.equal(
    f.commands[0]!.sql.replace(/\s+/g, ' ').trim(),
    'SELECT id,name AS label,is_active AS active FROM whaleu_campus.operating_regions WHERE id=ANY($1::uuid[]) ORDER BY id',
  );
  assert.doesNotMatch(f.commands[0]!.sql, /FOR SHARE|FOR UPDATE|INSERT/i);
});

test('historical label bounds match two immutable region IDs per 101 candidates', async () => {
  assert.equal(ERRAND_ADMIN_REGION_BATCH_LIMIT, 202);
  const f = fixture();
  assert.equal((await campus.historicalBatch([], f.tx)).size, 0);
  assert.equal(f.commands.length, 0);
  const ids = Array.from({ length: 202 }, (_, index) => id(index));
  assert.equal(
    (await campus.historicalBatch([...ids, ...ids], f.tx)).size,
    202,
  );
  for (const invalid of [[...ids, id(202)], ['12345']]) {
    const rejected = fixture();
    await assert.rejects(
      campus.historicalBatch(invalid, rejected.tx),
      unavailable,
    );
    assert.equal(rejected.commands.length, 0);
  }
});

test('historical labels validate Unicode code points, active flags and row identity', async () => {
  const valid = { id: id(1), label: '🐳'.repeat(200), active: false };
  assert.deepEqual(
    (await campus.historicalBatch([id(1)], fixture([valid]).tx)).get(id(1)),
    { ...valid, status: 'available' },
  );
  for (const rows of [
    [{ ...valid, label: '🐳'.repeat(201) }],
    [{ ...valid, label: '' }],
    [{ ...valid, label: ' ' }],
    [{ ...valid, label: 'bad\u0000label' }],
    [{ ...valid, label: '\ud800' }],
    [{ ...valid, active: 'false' }],
    [{ ...valid, id: id(2) }],
    [{ ...valid, relationship: 'related' }],
    [valid, valid],
  ])
    await assert.rejects(
      campus.historicalBatch([id(1)], fixture(rows).tx),
      unavailable,
    );
});

test('historical label read failures never return an empty or missing-only map', async () => {
  await assert.rejects(
    campus.historicalBatch([id(1)], fixture([], new Error('failure')).tx),
    unavailable,
  );
});

const owners = [
  {
    owner: errandCountProofOwner,
    schema: 'whaleu_errands',
    table: 'orders',
    key: 1464356105,
  },
  {
    owner: profileCountProofOwner,
    schema: 'whaleu_profile',
    table: 'profiles',
    key: 1464356106,
  },
] as const;

for (const { owner, schema, key } of owners) {
  test(`${schema} epoch owner captures only its fixed metadata and fences gate before all slots`, async () => {
    assert.equal(owner.order, key);
    const rows = Array.from({ length: 128 }, (_, slot) => ({
      slot,
      version: 1,
      epoch: String(slot),
    }));
    const f = fixture(rows);
    assert.deepEqual(await owner.capture(f.tx), rows);
    assert.equal(
      f.commands[0]!.sql,
      `SELECT slot,version,epoch::text FROM ${schema}.admin_count_epochs ORDER BY slot`,
    );
    const commands: string[] = [];
    const tx = {
      query: async (sql: string) => {
        commands.push(sql);
        return {
          rows: sql.includes('generate_series')
            ? Array.from({ length: 128 }, () => ({ locked: true }))
            : [{ locked: true }],
        };
      },
    } as unknown as PoolClient;
    assert.equal(await owner.fence(tx), true);
    assert.deepEqual(
      commands.map((sql) => sql.replace(/\s+/g, ' ').trim()),
      [
        `SELECT pg_try_advisory_xact_lock(${key},128) AS locked`,
        `SELECT pg_try_advisory_xact_lock_shared(${key},slot) AS locked FROM (SELECT generate_series(0,127) AS slot ORDER BY slot) AS slots`,
      ],
    );
  });

  test(`${schema} epoch fence rejects contention, missing slots and nonboolean evidence`, async () => {
    for (const rows of [[], [{ locked: false }], [{ locked: 1 }]]) {
      const f = fixture(rows);
      assert.equal(await owner.fence(f.tx), false);
      assert.equal(f.commands.length, 1);
    }
    for (const slotRows of [
      Array.from({ length: 127 }, () => ({ locked: true })),
      Array.from({ length: 129 }, () => ({ locked: true })),
      Array.from({ length: 128 }, (_, slot) => ({ locked: slot !== 127 })),
    ]) {
      const tx = {
        query: async (sql: string) => ({
          rows: sql.includes('generate_series') ? slotRows : [{ locked: true }],
        }),
      } as unknown as PoolClient;
      assert.equal(await owner.fence(tx), false);
    }
  });
}

test('all administrative owner table fences are exact SHARE NOWAIT and preserve conflicts', async () => {
  const f = fixture();
  const fences = [
    fenceErrandAdminReads,
    fenceProfileAdminReads,
    (tx: PoolClient) => campus.fenceAdminLabels(tx),
  ];
  for (const fence of fences) await fence(f.tx);
  assert.deepEqual(
    f.commands.map(({ sql }) => sql),
    [
      'LOCK TABLE whaleu_errands.orders IN SHARE MODE NOWAIT',
      'LOCK TABLE whaleu_profile.profiles IN SHARE MODE NOWAIT',
      'LOCK TABLE whaleu_campus.operating_regions IN SHARE MODE NOWAIT',
    ],
  );
  for (const fence of fences) {
    const conflict = Object.assign(new Error('busy'), { code: '55P03' });
    await assert.rejects(
      fence(fixture([], conflict).tx),
      (error: unknown) => error === conflict,
    );
  }
});

test('migration keeps 128-slot metadata-only epochs and mechanically preserves all four mature writer paths', () => {
  const mature = readFileSync(
    new URL(
      '../migrations/0021_exact_discovery_count_proofs.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const protocol = mature.slice(
    mature.indexOf('CREATE TABLE whaleu_campus.discovery_count_epochs'),
  );
  const migration = readFileSync(
    new URL('../migrations/0038_errand_admin_reads.sql', import.meta.url),
    'utf8',
  );
  assert.equal(new Set(owners.map(({ key }) => key)).size, owners.length);
  for (const { schema, key, table } of owners) {
    assert.ok(![1464356101, 1464356102, 1464356103, 1464356104].includes(key));
    const expected = protocol
      .replaceAll('whaleu_campus', schema)
      .replaceAll('1464356103', String(key))
      .replaceAll('discovery_count_epoch', 'admin_count_epoch')
      .replaceAll('operating_regions', table);
    assert.ok(migration.includes(expected));
    assert.ok(
      migration.includes(
        `BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${schema}.${table}\n  FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.advance_admin_count_epoch()`,
      ),
    );
    assert.ok(
      migration.includes(
        `INSERT INTO ${schema}.admin_count_epochs(slot,version,epoch)\n  SELECT slot,1,0 FROM generate_series(0,127) AS slot`,
      ),
    );
  }
  assert.deepEqual(
    [...migration.matchAll(/INSERT INTO ([a-z_.]+)/g)].map((match) => match[1]),
    ['whaleu_errands.admin_count_epochs', 'whaleu_profile.admin_count_epochs'],
  );
  assert.doesNotMatch(migration, /ALTER TABLE|CREATE EXTENSION|GRANT\s/i);
  assert.match(migration, /CREATE INDEX errand_admin_history/);
  assert.match(
    migration,
    /CREATE INDEX errand_admin_state_history[\s\S]*?WHERE deleted_at IS NULL;/,
  );
  assert.match(
    migration,
    /CREATE INDEX errand_admin_deleted_history[\s\S]*?WHERE deleted_at IS NOT NULL;/,
  );
});
