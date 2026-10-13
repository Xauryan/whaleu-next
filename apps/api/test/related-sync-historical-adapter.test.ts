import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { readMigrations } from '../src/database/migrations.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { historicalCommunityDistribution } from './support/historical-community-distribution.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});
const space = {
  id: '00000000-0000-4000-8000-000000000010',
  kind: 'regional' as const,
  name: 'Synthetic',
  isActive: true,
  operatingRegionId: '00000000-0000-4000-8000-000000000011',
};

test('related historical adaptation only accepts registered disposable pre0138 prefixes', async () => {
  for (const invalid of [64, 135, 136, 138, 139, 1000])
    await assert.rejects(historicalCommunityDistribution(config, invalid));
  await assert.rejects(
    historicalCommunityDistribution({ ...config, NODE_ENV: 'production' }, 137),
  );
  await assert.rejects(
    historicalCommunityDistribution(
      { ...config, DATABASE_URL: 'postgres://fixture@example.org/whaleu_test' },
      137,
    ),
  );
  await assert.rejects(
    historicalCommunityDistribution(
      { ...config, DATABASE_URL: 'postgres://fixture@127.0.0.1/real_database' },
      137,
    ),
  );
});

test('historical distribution verifies checksum prefix and partial deployment on every local read and rejects related issuance', async () => {
  const owner = await historicalCommunityDistribution(config, 137);
  const expected = (
    await readMigrations(
      fileURLToPath(new URL('../migrations', import.meta.url)),
    )
  )
    .filter((migration) => Number(migration.name.slice(0, 4)) <= 137)
    .map(({ name, checksum }) => ({ name, checksum }));
  let rows = expected,
    absent = true,
    metadataReads = 0;
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes('schema_migrations')) {
        assert.deepEqual(values, [expected.length + 1]);
        metadataReads++;
        return { rows };
      }
      assert.ok(
        sql.includes('pg_class') &&
          sql.includes('pg_proc') &&
          sql.includes('pg_trigger') &&
          sql.includes('pg_attribute') &&
          sql.includes('pg_constraint'),
      );
      assert.ok(
        (values?.[0] as string[]).includes(
          'whaleu_community.post_distribution_bindings',
        ),
      );
      assert.ok(
        (values?.[0] as string[]).includes(
          'whaleu_community.related_posts_scope_page',
        ),
      );
      assert.ok(
        (values?.[1] as string[]).includes(
          'whaleu_community.related_sync_envelope_admitted',
        ),
      );
      assert.ok(
        !(values?.[1] as string[]).includes(
          'whaleu_community.content_definition',
        ),
      );
      assert.ok((values?.[2] as string[]).includes('related_root_complete'));
      assert.ok(
        (values?.[0] as string[]).includes(
          'whaleu_community.related_actor_inflight',
        ),
      );
      assert.ok(
        (values?.[0] as string[]).includes(
          'whaleu_community.related_distribution_inflight',
        ),
      );
      assert.deepEqual(values?.[3], [
        'whaleu_community.content_approval_bindings.related_actor_fingerprint',
        'whaleu_community.content_approval_bindings.related_actor_transaction',
      ]);
      assert.deepEqual(values?.[4], [
        'whaleu_community.content_approval_bindings.related_actor_proof_shape',
      ]);

      return { rows: [{ absent }] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  try {
    const scope = await owner.resolveView(space, tx);
    assert.deepEqual(scope.originalSpaceIds, [space.id]);
    assert.deepEqual(scope.remoteSpaceIds, []);
    assert.deepEqual(
      await owner.allows(
        scope,
        '00000000-0000-4000-8000-000000000020',
        space.id,
        'discussion',
        tx,
      ),
      { kind: 'allow', value: { isRelatedCampusSync: false } },
    );
    assert.deepEqual(
      await owner.allows(
        scope,
        '00000000-0000-4000-8000-000000000021',
        '00000000-0000-4000-8000-000000000099',
        'discussion',
        tx,
      ),
      { kind: 'deny', reason: 'POST_NOT_FOUND' },
    );
    assert.equal(metadataReads, 3);
    await assert.rejects(owner.observeRootAdmission(tx), {
      code: 'COMMUNITY_UNAVAILABLE',
    });
    await assert.rejects(
      owner.requirePolicyEnable(space.operatingRegionId, tx),
      { code: 'COMMUNITY_UNAVAILABLE' },
    );
    for (const invalid of [
      expected.slice(1),
      expected.slice(0, -1),
      [...expected, { name: '0138_untracked.sql', checksum: '0'.repeat(64) }],
      expected.map((row, index) =>
        index === 0 ? { ...row, checksum: '0'.repeat(64) } : row,
      ),
    ]) {
      rows = invalid;
      await assert.rejects(owner.resolveView(space, tx), {
        code: 'COMMUNITY_UNAVAILABLE',
      });
      await assert.rejects(
        owner.allows(
          scope,
          '00000000-0000-4000-8000-000000000020',
          space.id,
          'discussion',
          tx,
        ),
        { code: 'COMMUNITY_UNAVAILABLE' },
      );
    }
    rows = expected;
    absent = false;
    await assert.rejects(owner.resolveView(space, tx), {
      code: 'COMMUNITY_UNAVAILABLE',
    });
    await assert.rejects(
      owner.allows(
        scope,
        '00000000-0000-4000-8000-000000000020',
        space.id,
        'discussion',
        tx,
      ),
      { code: 'COMMUNITY_UNAVAILABLE' },
    );
    absent = true;
    await owner.resolveView(space, tx);
  } finally {
    clearTransactionDeadlines(tx);
  }
});
