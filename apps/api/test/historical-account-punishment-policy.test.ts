import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { readMigrations } from '../src/database/migrations.js';
import { historicalAccountPunishmentPolicy } from './support/historical-account-punishment-policy.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});

test('historical adapter requires controlled environment and registered exact boundary', async () => {
  await assert.rejects(
    historicalAccountPunishmentPolicy(
      { ...config, NODE_ENV: 'production' },
      65,
    ),
  );
  await assert.rejects(
    historicalAccountPunishmentPolicy(
      { ...config, DATABASE_URL: 'postgres://fixture@example.org/whaleu_test' },
      65,
    ),
  );
  await assert.rejects(
    historicalAccountPunishmentPolicy(
      {
        ...config,
        DATABASE_URL: 'postgres://fixture@127.0.0.1/not_disposable',
      },
      65,
    ),
  );
  await assert.rejects(historicalAccountPunishmentPolicy(config, 64));
  await assert.rejects(historicalAccountPunishmentPolicy(config, 135));
});

test('historical adapter rechecks checksums, exact prefix and partial ledger each time', async () => {
  const policy = await historicalAccountPunishmentPolicy(config, 65);
  const expected = (
    await readMigrations(
      fileURLToPath(new URL('../migrations', import.meta.url)),
    )
  )
    .filter((migration) => Number(migration.name.slice(0, 4)) <= 65)
    .map(({ name, checksum }) => ({ name, checksum }));
  let rows = expected;
  let absent = true;
  let metadataReads = 0;
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('schema_migrations')) {
        assert.ok(sql.includes('LIMIT $1'));
        assert.deepEqual(values, [expected.length + 1]);
        metadataReads++;
        return { rows };
      }
      assert.ok(sql.includes('pg_class') && sql.includes('pg_proc'));
      assert.ok(
        (values?.[0] as string[]).includes(
          'whaleu_authorization.account_punishment_authority_epoch',
        ),
      );
      assert.ok(
        (values?.[0] as string[]).includes('whaleu_safety.account_appeals'),
      );
      assert.ok(
        (values?.[1] as string[]).includes(
          'whaleu_safety.issue_account_punishment',
        ),
      );
      assert.ok(
        (values?.[1] as string[]).includes(
          'whaleu_authorization.advance_account_punishment_authority_epoch',
        ),
      );
      assert.ok(
        !(values?.[1] as string[]).includes(
          'whaleu_community.admin_post_removal_command_guard',
        ),
      );
      return { rows: [{ absent }] };
    },
  } as unknown as PoolClient;
  const enforce = () =>
    policy.enforce('00000000-0000-4000-8000-000000000000', 'interaction', tx);
  await enforce();
  await enforce();
  assert.equal(
    metadataReads,
    2,
    'never cache database acceptance across calls',
  );
  for (const invalid of [
    expected.slice(1),
    expected.slice(0, -1),
    [...expected, { name: '0065_extra.sql', checksum: '0'.repeat(64) }],
    expected.map((row, index) =>
      index === 0 ? { ...row, checksum: '0'.repeat(64) } : row,
    ),
    expected.map((row, index) =>
      index === 0 ? { ...row, checksum: '' } : row,
    ),
  ]) {
    rows = invalid;
    await assert.rejects(enforce, { code: 'SAFETY_UNAVAILABLE' });
  }
  rows = expected;
  absent = false;
  await assert.rejects(enforce, { code: 'SAFETY_UNAVAILABLE' });
  absent = true;
  await enforce();
});
