import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { loadConfig } from '../../src/config/config.js';
import {
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { canonicalJson } from '../../src/community/content-review/canonical-json.js';
import {
  configureHomeAdmission,
  homePolicyPreflight,
  loadHomeAdmission,
} from '../../src/community/home-feed-policy/admission.js';
import {
  admissionDefinitionDigest,
  HOME_POLICY_SOURCE,
  HOME_ADMISSION_DOMAIN,
} from '../../src/community/home-feed-policy/admission-contract.js';
import type {
  HomeAdmissionDefinition,
  HomeAdmissionCommand,
} from '../../src/community/home-feed-policy/admission-contract.js';
import {
  seedCommunityScope,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

/** Fresh full-prefix PostgreSQL proof for metadata admission only. Production-mode
 * service configuration is exercised against the explicitly disposable test pool;
 * this is not CLI/TLS/provider, V7 publication, or production activation evidence. */
test(
  'home policy admission: real operator, audit chain, SQL parity and adversarial closure',
  { timeout: 240000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database);
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
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
      // A production-valid configuration, without loosening its TLS requirements.
      // The test harness already owns its independent test-mode connection pool.
      const config = loadConfig({
        ...base,
        NODE_ENV: 'production',
        PG_SSL_MODE: 'verify-full',
        COMMUNITY_TEXT_REVIEW: 'source_manual',
        COMMUNITY_TEXT_REVIEW_SPACE_ID: scope.home.spaceId,
        COMMUNITY_TEXT_REVIEW_REGION_ID: scope.home.regionId,
        COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: randomUUID(),
        COMMUNITY_TEXT_REVIEW_OPERATOR: operator,
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
          {
            nativeCategory: 'discussion',
            sourceKind: 'global',
            legacyChoose: 100,
          },
        ],
        scopeMappings: [
          {
            sourceSpaceId: scope.home.spaceId,
            sourceKind: 'regional',
            sourceRegionId: scope.home.regionId,
            targetWaterSpaceId: scope.home.spaceId,
            targetRegionId: scope.home.regionId,
          },
          {
            sourceSpaceId: scope.global.spaceId,
            sourceKind: 'global',
            sourceRegionId: null,
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
        evidenceRef: 'Synthetic disposable acceptance of fixed-source mappings',
        validForHours: 24,
      };
      const run = (command: HomeAdmissionCommand) =>
        inTransaction(pool, (tx) =>
          configureHomeAdmission(command, config, operator, tx),
        );
      const preview = async (d: HomeAdmissionDefinition = definition) =>
        (await run({ command: 'prepare', ...proposal, definition: d })) as {
          preparationId: string;
          expiresAt: string;
          validUntil: string;
          currentRevision: number;
          previewDigest: string;
          publicationReady: false;
        };
      const apply = async (d: HomeAdmissionDefinition = definition) => {
        const p = await preview(d);
        return (await run({
          command: 'apply',
          ...proposal,
          definition: d,
          expectedRevision: p.currentRevision,
          previewDigest: p.previewDigest,
          preparationId: p.preparationId,
        })) as {
          applied: boolean;
          publicationReady: false;
          admission: { id: string; revision: number; digest: string };
        };
      };
      const head = async () =>
        (
          await pool.query<{ revision: number; admission_id: string }>(
            'SELECT revision,admission_id FROM whaleu_community.home_policy_head',
          )
        ).rows[0] ?? null;
      const count = async () =>
        (
          await pool.query<{ n: number }>(
            'SELECT count(*)::integer n FROM whaleu_community.home_policy_admissions',
          )
        ).rows[0]!.n;
      const direct = async (
        tx: PoolClient,
        d: unknown = definition,
        options: { actor?: string; expiry?: string; transaction?: string } = {},
      ) => {
        const h = (
          await tx.query<{ revision: number; admission_id: string }>(
            'SELECT revision,admission_id FROM whaleu_community.home_policy_head',
          )
        ).rows[0];
        const digest = createHash('sha256')
          .update(HOME_ADMISSION_DOMAIN + canonicalJson(d))
          .digest('hex');
        const preparation = (await configureHomeAdmission(
          {
            command: 'prepare',
            ...proposal,
            evidenceRef: 'synthetic direct forgery',
          },
          config,
          operator,
          tx,
        )) as { preparationId: string; validUntil: string };
        return tx.query(
          `INSERT INTO whaleu_community.home_policy_admissions(id,revision,previous_id,source_commit,definition,digest,operator_ref,database_actor,evidence_ref,accepted_at,valid_until,publication_transaction,preparation_id)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,coalesce($8,current_user),'synthetic direct forgery',statement_timestamp(),${options.expiry ? 'coalesce(statement_timestamp()+' + options.expiry + ',$10::timestamptz)' : '$10::timestamptz'},${options.transaction ?? 'pg_current_xact_id()'},$9)`,
          [
            randomUUID(),
            (h?.revision ?? 0) + 1,
            h?.admission_id ?? null,
            HOME_POLICY_SOURCE,
            JSON.stringify(d),
            digest,
            operator,
            options.actor ?? null,
            preparation.preparationId,
            preparation.validUntil,
          ],
        );
      };
      await t.test(
        'default empty, real preview/apply, SQL digest parity and actual DB actor',
        async () => {
          assert.equal(await head(), null);
          assert.equal(await count(), 0);
          const before = await inTransaction(pool, homePolicyPreflight);
          assert.equal(before.catalogReady, true);
          assert.equal(before.publicationReady, false);
          assert.equal(before.admissionPresent, false);
          const p = await preview();
          assert.equal(p.currentRevision, 0);
          assert.equal(p.publicationReady, false);
          assert.equal(await count(), 0);
          const a = await apply();
          assert.equal(a.applied, true);
          assert.equal(a.admission.revision, 1);
          assert.equal(a.publicationReady, false);
          const row = (
            await pool.query<{
              digest: string;
              sql_digest: string;
              database_actor: string;
              actor: string;
              operator_ref: string;
            }>(
              `SELECT digest,encode(sha256(convert_to($1||whaleu_community.content_canonical_json(definition),'UTF8')),'hex') sql_digest,database_actor,current_user actor,operator_ref FROM whaleu_community.home_policy_admissions WHERE id=$2`,
              [HOME_ADMISSION_DOMAIN, a.admission.id],
            )
          ).rows[0]!;
          assert.equal(row.digest, admissionDefinitionDigest(definition));
          assert.equal(row.digest, row.sql_digest);
          assert.equal(row.database_actor, row.actor);
          assert.equal(row.operator_ref, operator);
          assert.equal(
            (await inTransaction(pool, loadHomeAdmission))?.ref.id,
            a.admission.id,
          );
          const status = await inTransaction(pool, homePolicyPreflight);
          assert.equal(status.catalogReady, true);
          assert.equal(status.publicationReady, false);
          assert.ok(status.blockers.includes('v7_publication_not_integrated'));
        },
      );
      await t.test(
        'unknown/duplicate mappings rejected by both command and SQL',
        async () => {
          const unknown = {
            ...definition,
            categoryMappings: [
              ...definition.categoryMappings,
              {
                nativeCategory: 'feedback',
                sourceKind: 'global',
                legacyChoose: 100,
              },
            ],
          };
          const duplicate = {
            ...definition,
            categoryMappings: [
              ...definition.categoryMappings,
              definition.categoryMappings[0],
            ],
          };
          for (const bad of [unknown, duplicate]) {
            await assert.rejects(() =>
              run({
                command: 'prepare',
                ...proposal,
                definition: bad as HomeAdmissionDefinition,
              }),
            );
            await assert.rejects(() =>
              inTransaction(pool, (tx) => direct(tx, bad)),
            );
          }
          assert.equal(await count(), 1);
        },
      );
      await t.test(
        'stale preview, caller identity, inactive scopes and mismatched configured region deny',
        async () => {
          const stale = await preview();
          await apply();
          await assert.rejects(
            () =>
              run({
                command: 'apply',
                ...proposal,
                expectedRevision: stale.currentRevision,
                previewDigest: stale.previewDigest,
                preparationId: stale.preparationId,
              }),
            /Stale, expired, consumed or mismatched/,
          );
          await assert.rejects(() =>
            inTransaction(pool, (tx) =>
              configureHomeAdmission(
                { command: 'prepare', ...proposal },
                config,
                'manual:not:operator',
                tx,
              ),
            ),
          );
          await assert.rejects(() =>
            inTransaction(pool, (tx) =>
              configureHomeAdmission(
                { command: 'prepare', ...proposal },
                {
                  ...config,
                  COMMUNITY_TEXT_REVIEW_REGION_ID: scope.foreign.regionId,
                },
                operator,
                tx,
              ),
            ),
          );
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
              [scope.global.spaceId],
            ),
          );
          try {
            await assert.rejects(() => preview());
            await assert.rejects(() => inTransaction(pool, (tx) => direct(tx)));
          } finally {
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_community.spaces SET is_active=true WHERE id=$1',
                [scope.global.spaceId],
              ),
            );
          }
        },
      );
      await t.test(
        'immutable audit/head, direct forged scope/lifetime/actor/transaction and orphan admission reject',
        async () => {
          const n = await count(),
            h = await head();
          assert.ok(h);
          for (const sql of [
            "UPDATE whaleu_community.home_policy_admissions SET evidence_ref='changed'",
            'DELETE FROM whaleu_community.home_policy_admissions',
            'TRUNCATE whaleu_community.home_policy_admissions',
            'UPDATE whaleu_community.home_policy_preparations SET expires_at=expires_at',
            'DELETE FROM whaleu_community.home_policy_preparations',
            'DELETE FROM whaleu_community.home_policy_head',
            'TRUNCATE whaleu_community.home_policy_head',
            `UPDATE whaleu_community.home_policy_head SET revision=revision`,
          ])
            await assert.rejects(() =>
              inTransaction(pool, (tx) => tx.query(sql)),
            );
          for (const options of [
            { actor: 'forged_other_role' },
            { expiry: "interval '169 hours'" },
            { expiry: "interval '-1 hour'" },
            { transaction: "'0'::xid8" },
          ])
            await assert.rejects(() =>
              inTransaction(pool, (tx) => direct(tx, definition, options)),
            );
          const forged = {
            ...definition,
            scopeMappings: definition.scopeMappings.map((mapping) =>
              mapping.sourceKind === 'global'
                ? { ...mapping, sourceSpaceId: randomUUID() }
                : mapping,
            ),
          };
          await assert.rejects(() =>
            inTransaction(pool, (tx) => direct(tx, forged)),
          );
          // A valid direct admission without its head is rejected at deferred completion.
          await assert.rejects(() =>
            inTransaction(pool, async (tx) => {
              await direct(tx);
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
            }),
          );
          assert.equal(await count(), n);
          assert.deepEqual(await head(), h);
        },
      );
      await t.test(
        'outer rollback removes both accepted audit row and head transition',
        async () => {
          const h = await head(),
            n = await count(),
            p = await preview();
          await assert.rejects(
            () =>
              inTransaction(pool, async (tx) => {
                await configureHomeAdmission(
                  {
                    command: 'apply',
                    ...proposal,
                    expectedRevision: p.currentRevision,
                    previewDigest: p.previewDigest,
                    preparationId: p.preparationId,
                  },
                  config,
                  operator,
                  tx,
                );
                throw new Error('synthetic outer rollback');
              }),
            /synthetic outer rollback/,
          );
          assert.deepEqual(await head(), h);
          assert.equal(await count(), n);
        },
      );
      await t.test(
        'explicit institution5 mapping remains unavailable without its authority adapter',
        async () => {
          const mapped: HomeAdmissionDefinition = {
            ...definition,
            exemptions: {
              audit: 'institution5_owner',
              attachments: 'normalized_server_facts',
              owner: 'verification_assertion_institution',
              legacyInstitution: 5,
              institutionId: scope.institutionId,
              regionId: scope.home.regionId,
              evidenceRef: 'Synthetic declared mapping; no authority adapter',
            },
          };
          await apply(mapped);
          const status = await inTransaction(pool, homePolicyPreflight);
          assert.equal(status.catalogReady, true);
          assert.equal(status.publicationReady, false);
          assert.ok(
            status.blockers.includes(
              'institution5_authority_adapter_unavailable',
            ),
          );
        },
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
