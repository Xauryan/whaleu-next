import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { CampusRepository } from '../../src/campus/campus.repository.js';
import {
  migrateSchoolIdentifiers,
  readIdentifierSnapshot,
} from '../../src/campus/school-identifiers/migration.js';
import {
  DatabaseService,
  inTransaction,
  poolOptions,
} from '../../src/database/database.js';
import { loadConfig } from '../../src/config/config.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import {
  syntheticInstitutions,
  syntheticSchoolManifest,
} from '../support/school-fixtures.js';

test(
  'real PostgreSQL reviewed school identifier migration preserves rows, keys and relationships',
  { timeout: 60000 },
  async (t) => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    assert.ok(
      connectionString,
      'Set TEST_DATABASE_URL to disposable loopback whaleu_test; no silent skip',
    );
    const url = new URL(connectionString);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connectionString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '4',
      PG_STATEMENT_TIMEOUT_MS: '10000',
    });
    const pool = new Pool(poolOptions(config));
    let guard: PoolClient | undefined;
    let locked = false;
    let ownsSchemas = false;
    try {
      guard = await pool.connect();
      locked =
        (
          await guard.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock($1,$2) AS locked',
            [MIGRATION_LOCK[0], 2],
          )
        ).rows[0]?.locked === true;
      assert.equal(
        locked,
        true,
        'Another integration suite holds the disposable database',
      );
      assert.equal(
        (
          await pool.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname IN ('whaleu_meta','whaleu_identity','whaleu_campus','whaleu_profile','whaleu_community','whaleu_authorization')",
          )
        ).rows[0]?.count,
        0,
        'Refusing an existing application schema',
      );
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      ownsSchemas = true;
      await runMigrations(
        pool,
        migrations.filter(({ name }) => name < '0006'),
        { mode: 'up' },
      );
      const [first, second, unresolved] = syntheticInstitutions;
      const campusId = randomUUID();
      const secondCampusId = randomUUID();
      const accountId = randomUUID();
      const regionId = randomUUID();
      await pool.query(
        "INSERT INTO whaleu_campus.institutions(id,name) SELECT id,'Same synthetic display name' FROM unnest($1::uuid[]) id",
        [syntheticInstitutions],
      );
      await pool.query(
        "INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) VALUES ($1,$2,'Synthetic North','Test',true),($3,$4,'Unresolved Synthetic','Test',true)",
        [campusId, first, secondCampusId, unresolved],
      );
      await pool.query('INSERT INTO whaleu_identity.accounts(id) VALUES ($1)', [
        accountId,
      ]);
      await pool.query(
        'INSERT INTO whaleu_profile.profiles(account_id,selected_campus_id) VALUES ($1,$2)',
        [accountId, campusId],
      );
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES ($1,'Synthetic independent region',true)",
        [regionId],
      );
      await pool.query(
        'INSERT INTO whaleu_campus.campus_region_assignments(campus_id,operating_region_id) VALUES ($1,$2)',
        [campusId, regionId],
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      await runMigrations(pool, migrations, { mode: 'up' });
      const repository = new CampusRepository({
        query: pool.query.bind(pool),
      } as unknown as DatabaseService);
      const manifest = syntheticSchoolManifest();

      await t.test(
        'schema migration seeds nothing and leaves unresolved public IDs null without leaking UUIDs',
        async () => {
          const directory = await repository.list({ page: 1, pageSize: 20 });
          assert.equal(directory.total, 2);
          assert.ok(
            directory.items.every(
              ({ institutionId }) => institutionId === null,
            ),
          );
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_campus.school_identifiers'))
              .rowCount,
            0,
          );
        },
      );
      await t.test(
        'default dry run writes no registry records and reports unresolved exact source keys',
        async () => {
          const result = await migrateSchoolIdentifiers(pool, manifest);
          assert.equal(result.mode, 'dry-run');
          assert.equal(result.applied, false);
          assert.equal(result.ready, true);
          assert.deepEqual(result.unresolvedInstitutionIds, [
            second,
            unresolved,
          ]);
          assert.equal(
            result.unresolvedLegacyRecords[0]?.legacyRecordId,
            'unresolved-name-match',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_campus.school_identifier_sources',
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_campus.school_identifiers'))
              .rowCount,
            0,
          );
        },
      );
      await t.test(
        'explicit apply persists reviewed strings and exact provenance, with an idempotent repeat',
        async () => {
          const applied = await migrateSchoolIdentifiers(
            pool,
            manifest,
            'apply',
          );
          assert.equal(applied.applied, true);
          const snapshot = await inTransaction(pool, readIdentifierSnapshot);
          assert.deepEqual(snapshot.sources, manifest.sources);
          assert.deepEqual(snapshot.mappings, manifest.mappings);
          assert.deepEqual(snapshot.aliases, manifest.aliases);
          assert.deepEqual(
            snapshot.legacyCrosswalks,
            manifest.legacyCrosswalks,
          );
          const repeat = await migrateSchoolIdentifiers(
            pool,
            manifest,
            'apply',
          );
          assert.equal(repeat.applied, true);
          assert.deepEqual(repeat.additions, {
            sources: [],
            mappings: [],
            aliases: [],
            legacyCrosswalks: [],
          });
          assert.equal(
            (await repository.find(campusId))?.institutionId,
            '00001',
          );
          assert.equal(
            (await repository.find(secondCampusId))?.institutionId,
            null,
          );
          const directory = await repository.list({ page: 1, pageSize: 20 });
          assert.equal(
            directory.items.find(({ id }) => id === campusId)?.institutionId,
            '00001',
          );
          const serialized = JSON.stringify(directory);
          assert.equal(serialized.includes(first), false);
          assert.equal(serialized.includes(unresolved), false);
        },
      );
      await t.test(
        'physical campus, profile selection and independent operating-region relationships are retained exactly',
        async () => {
          assert.deepEqual(
            (
              await pool.query(
                'SELECT id,institution_id FROM whaleu_campus.campuses ORDER BY id',
              )
            ).rows.sort((a: { id: string }, b: { id: string }) =>
              a.id.localeCompare(b.id),
            ),
            [
              { id: campusId, institution_id: first },
              { id: secondCampusId, institution_id: unresolved },
            ].sort((a, b) => a.id.localeCompare(b.id)),
          );
          assert.equal(
            (
              await pool.query<{ selected_campus_id: string }>(
                'SELECT selected_campus_id FROM whaleu_profile.profiles WHERE account_id=$1',
                [accountId],
              )
            ).rows[0]?.selected_campus_id,
            campusId,
          );
          assert.equal((await repository.mappedRegion(campusId))?.id, regionId);
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_campus.institutions'))
              .rowCount,
            3,
          );
          await inTransaction(pool, async (transaction) =>
            assert.equal(
              (await repository.find(campusId, transaction))?.institutionId,
              '00001',
            ),
          );
        },
      );
      await t.test(
        'conflicting canonical mappings, crosswalks and provenance fail atomically',
        async () => {
          const conflict = syntheticSchoolManifest();
          conflict.sources.push({
            ...conflict.sources[0]!,
            id: 'must-not-be-written',
          });
          conflict.mappings.push({
            ...conflict.mappings[0]!,
            institutionId: second,
          });
          const result = await migrateSchoolIdentifiers(
            pool,
            conflict,
            'apply',
          );
          assert.equal(result.ready, false);
          assert.equal(result.applied, false);
          assert.ok(
            result.issues.some(({ code }) => code === 'school_code_conflict'),
          );
          assert.equal(
            (
              await pool.query(
                "SELECT * FROM whaleu_campus.school_identifier_sources WHERE id='must-not-be-written'",
              )
            ).rowCount,
            0,
          );
          const remap = syntheticSchoolManifest();
          remap.legacyCrosswalks[0]!.institutionId = second;
          assert.equal(
            (await migrateSchoolIdentifiers(pool, remap, 'apply')).ready,
            false,
          );
          const provenance = syntheticSchoolManifest();
          provenance.sources[0]!.publisher = 'changed';
          assert.equal(
            (await migrateSchoolIdentifiers(pool, provenance, 'apply')).ready,
            false,
          );
          assert.equal(
            (
              await pool.query<{ institution_id: string }>(
                'SELECT institution_id FROM whaleu_campus.school_legacy_crosswalks',
              )
            ).rows[0]?.institution_id,
            first,
          );
        },
      );
      await t.test(
        'database constraints independently reject inconsistent official code pairs and missing provenance',
        async () => {
          const values = [
            second,
            '00002',
            '4199000003',
            'synthetic-source',
            'synthetic-source',
          ];
          const sql =
            "INSERT INTO whaleu_campus.school_identifiers(institution_id,school_code,moe_code,five_digit_source_id,moe_source_id,reviewed_by,reviewed_at,review_note) VALUES ($1,$2,$3,$4,$5,'synthetic',now(),'synthetic only')";
          await assert.rejects(pool.query(sql, values), { code: '23514' });
          await assert.rejects(
            pool.query(sql, [
              second,
              '00002',
              '4199000002',
              'missing',
              'synthetic-source',
            ]),
            { code: '23503' },
          );
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_campus.school_identifiers'))
              .rowCount,
            1,
          );
        },
      );
      await t.test(
        'later reviewed mapping resolves an existing preserved institution without changing campus IDs',
        async () => {
          const next = syntheticSchoolManifest();
          next.mappings = [
            {
              ...next.mappings[0]!,
              institutionId: unresolved,
              schoolCode: '00003',
              moeCode: '4199000003',
            },
          ];
          next.aliases = [];
          next.legacyCrosswalks = [];
          assert.equal(
            (await migrateSchoolIdentifiers(pool, next, 'apply')).applied,
            true,
          );
          assert.equal(
            (await repository.find(secondCampusId))?.institutionId,
            '00003',
          );
          assert.equal(
            (await repository.find(secondCampusId))?.id,
            secondCampusId,
          );
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_campus.institutions'))
              .rowCount,
            3,
          );
        },
      );
    } finally {
      try {
        if (ownsSchemas)
          for (const schema of [
            'whaleu_authorization',
            'whaleu_community',
            'whaleu_profile',
            'whaleu_campus',
            'whaleu_identity',
            'whaleu_meta',
          ])
            await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        if (locked)
          await guard?.query('SELECT pg_advisory_unlock($1,$2)', [
            MIGRATION_LOCK[0],
            2,
          ]);
        guard?.release();
        await pool.end();
      }
    }
  },
);
