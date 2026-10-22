import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { loadConfig } from '../../src/config/config.js';
import {
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import {
  HOME_POLICY_SOURCE,
  admissionDefinitionDigest,
} from '../../src/community/home-feed-policy/admission-contract.js';
import type { HomeAdmissionDefinition } from '../../src/community/home-feed-policy/admission-contract.js';
import { seedCommunityScope } from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
const execute = promisify(execFile);
interface Prepared {
  preparationId: string;
  currentRevision: number;
  previewDigest: string;
  expiresAt: string;
  validUntil: string;
  publicationReady: false;
}
/** Separate explicit TLS lane. Requires real loopback whaleu_test PG18.6+ and
 * trusted CA (NODE_EXTRA_CA_CERTS when starting Node). Never disable certificate
 * verification. Uses actual production-config CLI subprocesses/OS identity;
 * metadata only, not publication/provider/device/production activation proof.
 * One deliberate five-minute real-clock window proves persisted-token expiry. */
test(
  'home admission CLI: real production config, verified TLS, immutable preparation and actual expiry',
  { timeout: 600000 },
  async () => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database, 'Explicit disposable TLS TEST_DATABASE_URL required');
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: database,
      PG_SSL_MODE: 'verify-full',
      LOG_LEVEL: 'silent',
      PG_STATEMENT_TIMEOUT_MS: '60000',
    };
    const pool = new Pool(poolOptions(loadConfig(base)));
    let suite: PoolClient | undefined,
      owns = false,
      locked = false;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.ok(locked);
      assert.equal(
        (
          await suite.query<{ ssl: boolean }>(
            'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
          )
        ).rows[0]?.ssl,
        true,
      );
      assert.ok(
        supportedPostgresVersion(
          (
            await suite.query<{ v: number }>(
              "SELECT current_setting('server_version_num')::integer v",
            )
          ).rows[0]!.v,
        ),
      );
      assert.equal(
        (
          await suite.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
      );
      owns = true;
      const migrations = (
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        )
      ).filter((m) => Number(m.name.slice(0, 4)) <= 177);
      assert.equal(migrations.at(-1)?.name, '0177_home_policy_admission.sql');
      await runMigrations(pool, migrations, { mode: 'up' });
      const scope = await seedCommunityScope(pool);
      const operator = `manual:${hostname()}:${userInfo().username}`;
      const env = {
        ...process.env,
        ...base,
        COMMUNITY_TEXT_REVIEW: 'source_manual',
        COMMUNITY_TEXT_REVIEW_SPACE_ID: scope.home.spaceId,
        COMMUNITY_TEXT_REVIEW_REGION_ID: scope.home.regionId,
        COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: randomUUID(),
        COMMUNITY_TEXT_REVIEW_OPERATOR: operator,
      };
      const entry = fileURLToPath(
        new URL(
          '../../src/community/home-feed-policy/operator.ts',
          import.meta.url,
        ),
      );
      const cli = async (
        command: unknown,
        overrides: NodeJS.ProcessEnv = {},
      ) => {
        const result = await execute(
          process.execPath,
          ['--import', 'tsx', entry, JSON.stringify(command)],
          {
            cwd: fileURLToPath(new URL('../..', import.meta.url)),
            env: { ...env, ...overrides },
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          },
        );
        assert.equal(result.stderr, '');
        return JSON.parse(result.stdout) as Record<string, unknown>;
      };
      const definition: HomeAdmissionDefinition = {
        version: 1,
        sourceCommit: HOME_POLICY_SOURCE,
        categoryMappings: [
          {
            nativeCategory: 'discussion',
            sourceKind: 'regional',
            legacyChoose: 2,
          },
          { nativeCategory: 'water', sourceKind: 'regional', legacyChoose: 9 },
        ],
        scopeMappings: [
          {
            sourceSpaceId: scope.home.spaceId,
            sourceKind: 'regional',
            sourceRegionId: scope.home.regionId,
            targetWaterSpaceId: scope.home.spaceId,
            targetRegionId: scope.home.regionId,
          },
        ],
        authorModes: ['named', 'anonymous'],
        exemptions: { audit: 'none', attachments: 'normalized_server_facts' },
        surfaces: { home: true, hot: 'exclude_water', following: 'excluded' },
        markdownReferences: false,
      };
      const proposal = {
        definition,
        evidenceRef:
          'Synthetic production-config CLI acceptance on disposable verified TLS',
        validForHours: 1,
      };
      const prepare = async () =>
        (await cli({ command: 'prepare', ...proposal })) as unknown as Prepared;
      const applyCommand = (p: Prepared) => ({
        command: 'apply',
        ...proposal,
        preparationId: p.preparationId,
        expectedRevision: p.currentRevision,
        previewDigest: p.previewDigest,
      });
      const initial = await cli({ command: 'preflight' });
      assert.equal(initial['catalogReady'], true);
      assert.equal(initial['admissionPresent'], false);
      assert.equal(initial['publicationReady'], false);
      await assert.rejects(() =>
        cli(
          { command: 'prepare', ...proposal },
          { COMMUNITY_TEXT_REVIEW_OPERATOR: 'manual:wrong:identity' },
        ),
      );
      await assert.rejects(() => cli({ command: 'preview', ...proposal })); // Not falsely advertised as read-only.
      const prepared = await prepare();
      assert.equal(prepared.publicationReady, false);
      assert.equal(prepared.currentRevision, 0);
      assert.equal(
        (
          await pool.query<{ n: number }>(
            'SELECT count(*)::integer n FROM whaleu_community.home_policy_admissions',
          )
        ).rows[0]!.n,
        0,
      );
      await assert.rejects(() =>
        cli({ ...applyCommand(prepared), preparationId: randomUUID() }),
      );
      await assert.rejects(() =>
        cli({ ...applyCommand(prepared), validForHours: 2 }),
      );
      await assert.rejects(() =>
        cli({ ...applyCommand(prepared), previewDigest: '0'.repeat(64) }),
      );
      const applied = await cli(applyCommand(prepared));
      assert.equal(applied['applied'], true);
      assert.equal(applied['publicationReady'], false);
      const record = (
        await pool.query<{
          valid_until: Date;
          digest: string;
          database_actor: string;
          actor: string;
          operator_ref: string;
        }>(
          `SELECT a.valid_until,a.digest,a.database_actor,current_user actor,a.operator_ref FROM whaleu_community.home_policy_admissions a WHERE preparation_id=$1`,
          [prepared.preparationId],
        )
      ).rows[0]!;
      assert.equal(record.valid_until.toISOString(), prepared.validUntil);
      assert.equal(record.digest, admissionDefinitionDigest(definition));
      assert.equal(record.database_actor, record.actor);
      assert.equal(record.operator_ref, operator);
      await assert.rejects(() => cli(applyCommand(prepared))); // Consumed immutable nonce.
      const expiring = await prepare();
      const head = (
        await pool.query('SELECT * FROM whaleu_community.home_policy_head')
      ).rows;
      const delay = Date.parse(expiring.expiresAt) - Date.now() + 100;
      assert.ok(delay > 0 && delay <= 301000);
      await sleep(delay);
      assert.equal(
        (
          await pool.query<{ expired: boolean }>(
            'SELECT expires_at<=clock_timestamp() expired FROM whaleu_community.home_policy_preparations WHERE id=$1',
            [expiring.preparationId],
          )
        ).rows[0]!.expired,
        true,
      );
      assert.deepEqual(
        (await pool.query('SELECT * FROM whaleu_community.home_policy_head'))
          .rows,
        head,
      );
      await assert.rejects(() => cli(applyCommand(expiring))); // Same head, genuine elapsed issuance window.
      assert.deepEqual(
        (await pool.query('SELECT * FROM whaleu_community.home_policy_head'))
          .rows,
        head,
      );
      assert.equal(
        (await cli({ command: 'preflight' }))['publicationReady'],
        false,
      );
    } finally {
      if (owns)
        for (const schema of migrationSchemaNames)
          await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (locked)
        await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      suite?.release();
      await pool.end();
    }
  },
);
