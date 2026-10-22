import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
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
import { HOME_POLICY_SOURCE } from '../../src/community/home-feed-policy/admission-contract.js';
import type { HomeAdmissionDefinition } from '../../src/community/home-feed-policy/admission-contract.js';
import { seedCommunityScope } from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
const execute = promisify(execFile);
interface Preparation {
  preparationId: string;
  currentRevision: number;
  previewDigest: string;
  expiresAt: string;
  validUntil: string;
  publicationReady: boolean;
}
/** Standalone verified-TLS proof, using formal migration chain through0178 and
 * genuine OS-identified Review, metadata-admission and activation subprocesses.
 * This verifies scoped activation commands, not V7 HTTP/physical device/provider
 * acceptance. No hand-inserted policy, preparation, activation, or fake seal. */
test(
  'Home activation: genuine production source-manual CLI on formal installed protocol',
  { timeout: 300000 },
  async () => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(
      database,
      'Explicit disposable verified-TLS TEST_DATABASE_URL required',
    );
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
      ).filter((m) => Number(m.name.slice(0, 4)) <= 178);
      assert.equal(
        migrations.at(-1)?.name,
        '0178_home_publication_protocol.sql',
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      const scope = await seedCommunityScope(pool),
        operator = `manual:${hostname()}:${userInfo().username}`,
        sourcePolicy = randomUUID();
      const env = {
        ...process.env,
        ...base,
        COMMUNITY_TEXT_REVIEW: 'source_manual',
        COMMUNITY_TEXT_REVIEW_SPACE_ID: scope.home.spaceId,
        COMMUNITY_TEXT_REVIEW_REGION_ID: scope.home.regionId,
        COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: sourcePolicy,
        COMMUNITY_TEXT_REVIEW_OPERATOR: operator,
      };
      const entries = {
        review: '../../src/community/text-review/cli.ts',
        admission: '../../src/community/home-feed-policy/operator.ts',
        activation:
          '../../src/community/home-feed-policy/activation-operator.ts',
      };
      const cli = async (
        kind: keyof typeof entries,
        command: unknown,
        overrides: NodeJS.ProcessEnv = {},
      ) => {
        const output = await execute(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(new URL(entries[kind], import.meta.url)),
            JSON.stringify(command),
          ],
          {
            cwd: fileURLToPath(new URL('../..', import.meta.url)),
            env: { ...env, ...overrides },
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          },
        );
        assert.equal(output.stderr, '');
        return JSON.parse(output.stdout) as Record<string, unknown>;
      };
      const initial = await cli('activation', { command: 'preflight' });
      assert.equal(initial['catalogReady'], true);
      assert.equal(initial['publicationReady'], false);
      assert.equal(initial['canPrepare'], false);
      assert.equal(
        (
          await pool.query<{ n: number }>(
            'SELECT count(*)::integer n FROM whaleu_community.home_publication_activations',
          )
        ).rows[0]!.n,
        0,
      );
      await cli('review', {
        command: 'init-source-policy',
        basis:
          'Synthetic verified-TLS activation fixture; exact source-only manual Review policy',
      });
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
      const metadata = {
        definition,
        evidenceRef:
          'Synthetic explicit fixed-source mapping for activation command proof',
        validForHours: 2,
      };
      const metadataPrepared = (await cli('admission', {
        command: 'prepare',
        ...metadata,
      })) as unknown as Preparation;
      await cli('admission', {
        command: 'apply',
        ...metadata,
        preparationId: metadataPrepared.preparationId,
        expectedRevision: metadataPrepared.currentRevision,
        previewDigest: metadataPrepared.previewDigest,
      });
      const available = await cli('activation', { command: 'preflight' });
      assert.equal(available['canPrepare'], true);
      assert.equal(available['activationPresent'], false);
      assert.equal(available['publicationReady'], false);
      assert.equal(available['explicitReviewPolicyId'], null);
      await assert.rejects(() =>
        cli(
          'activation',
          {
            command: 'prepare',
            evidenceRef: 'Wrong reviewer',
            validForHours: 1,
          },
          { COMMUNITY_TEXT_REVIEW_OPERATOR: 'manual:wrong:identity' },
        ),
      );
      await assert.rejects(() =>
        cli(
          'activation',
          {
            command: 'prepare',
            evidenceRef: 'Wrong source policy',
            validForHours: 1,
          },
          { COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: randomUUID() },
        ),
      );
      const prepare = async () =>
        (await cli('activation', {
          command: 'prepare',
          evidenceRef:
            'Synthetic actual deployment acceptance in disposable verified-TLS fixture',
          validForHours: 1,
        })) as unknown as Preparation;
      const prepared = await prepare(),
        stale = await prepare();
      assert.equal(prepared.publicationReady, false);
      const apply = (p: Preparation) => ({
        command: 'apply',
        preparationId: p.preparationId,
        expectedRevision: p.currentRevision,
        previewDigest: p.previewDigest,
      });
      await assert.rejects(() =>
        cli('activation', { ...apply(prepared), preparationId: randomUUID() }),
      );
      await assert.rejects(() =>
        cli('activation', {
          ...apply(prepared),
          previewDigest: '0'.repeat(64),
        }),
      );
      const result = await cli('activation', apply(prepared));
      assert.equal(result['applied'], true);
      assert.equal(result['publicationReady'], true);
      assert.equal(result['sourceReviewPolicyId'], sourcePolicy);
      assert.equal(result['explicitReviewPolicyId'], null);
      assert.equal(result['configuredSpaceId'], scope.home.spaceId);
      assert.equal(result['configuredRegionId'], scope.home.regionId);
      assert.equal(result['validUntil'], prepared.validUntil);
      await assert.rejects(() => cli('activation', apply(prepared)));
      await assert.rejects(() => cli('activation', apply(stale)));
      const current = await cli('activation', { command: 'preflight' });
      assert.equal(current['publicationReady'], true);
      assert.equal(current['activationPresent'], true);
      const proof = (
        await pool.query<{ activation: { activationId: string } }>(
          'SELECT whaleu_community.home_publication_current() activation',
        )
      ).rows[0]!.activation;
      assert.equal(proof.activationId, result['activationId']);
      const row = (
        await pool.query<{
          actor: string;
          database_actor: string;
          operator_ref: string;
          source_review_policy_id: string;
          explicit_review_policy_id: null;
          valid_until: Date;
        }>(
          `SELECT current_user actor,database_actor,operator_ref,source_review_policy_id,explicit_review_policy_id,valid_until FROM whaleu_community.home_publication_activations WHERE id=$1`,
          [result['activationId']],
        )
      ).rows[0]!;
      assert.equal(row.actor, row.database_actor);
      assert.equal(row.operator_ref, operator);
      assert.equal(row.source_review_policy_id, sourcePolicy);
      assert.equal(row.explicit_review_policy_id, null);
      assert.equal(row.valid_until.toISOString(), prepared.validUntil);
      await assert.rejects(() =>
        pool.query(
          'UPDATE whaleu_community.home_publication_activations SET valid_until=valid_until',
        ),
      );
      await assert.rejects(() =>
        pool.query('DELETE FROM whaleu_community.home_publication_head'),
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
