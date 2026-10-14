import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../../src/database/transaction-deadlines.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import {
  SchoolIdentityVerificationFacade,
  schoolIdentityCorrectionIds,
} from '../../src/verification/school-identity.facade.js';
import {
  setSyntheticSnapshot,
  syntheticAssertion,
} from '../support/verification-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

/** Source transition stage tests deliberately roll back their unapproved causes.
 * Durable correction authorization/UID closure is never replaced or disabled. */
test(
  'correction source captures exact three own statements and refuses foreign or extra source statements',
  { timeout: 120000 },
  async (t) => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    assert.ok(connectionString, 'Disposable PostgreSQL required');
    const url = new URL(connectionString);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const pool = new Pool({
      connectionString,
      max: 6,
      statement_timeout: 5000,
    });
    const lease = await pool.connect();
    let owns = false;
    try {
      assert.equal(
        (
          await lease.query('SELECT pg_try_advisory_lock($1,$2) locked', [
            MIGRATION_LOCK[0],
            2,
          ])
        ).rows[0].locked,
        true,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0].n,
        0,
      );
      owns = true;
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      const account = randomUUID(),
        actor = randomUUID(),
        schoolA = randomUUID(),
        schoolB = randomUUID(),
        regionA = randomUUID(),
        regionB = randomUUID();
      await pool.query(
        'INSERT INTO whaleu_identity.accounts(id) VALUES($1),($2)',
        [account, actor],
      );
      await pool.query(
        "INSERT INTO whaleu_campus.institutions(id,name) VALUES($1,'Synthetic source A'),($2,'Synthetic source B')",
        [schoolA, schoolB],
      );
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic source A',true),($2,'Synthetic source B',true)",
        [regionA, regionB],
      );
      await setSyntheticSnapshot(pool, account, [
        syntheticAssertion(account, schoolA, 'affiliation', {
          origin_region_id: regionA,
          expiry_kind: 'at',
          expires_at: new Date(Date.now() + 3600000),
        }),
        syntheticAssertion(account, schoolA, 'student_number'),
      ]);
      const owner = new SchoolIdentityVerificationFacade();
      const speculative = async (work: (tx: PoolClient) => Promise<void>) => {
        const tx = await pool.connect();
        const originalQuery = tx.query;
        await tx.query('BEGIN');
        startTransactionDeadlines(tx);
        try {
          await work(tx);
        } finally {
          tx.query = originalQuery;
          await tx.query('ROLLBACK');
          clearTransactionDeadlines(tx);
          tx.release();
        }
      };
      const prepare = async (
        tx: PoolClient,
        kind: 'correct_school' | 'unchanged' = 'correct_school',
        afterInitialVector?: () => Promise<void>,
      ) => {
        const vector = await owner.observeGeneration(tx, account);
        await afterInitialVector?.();
        const observation = await owner.observe(account, tx);
        assert.ok(observation);
        await owner.lock(observation, tx);
        const ids =
          kind === 'correct_school'
            ? schoolIdentityCorrectionIds()
            : {
                assertionId: observation.affiliation.id,
                snapshotId: observation.head.snapshot_id,
                eventId: observation.eventId,
              };
        const causeId = randomUUID(),
          commandId = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_school_uid.producing_causes(id,kind,account_id,actor_account_id,source_id,affiliation_assertion_id,snapshot_id,institution_id,verification_event_id,old_snapshot_id,old_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            causeId,
            kind,
            account,
            actor,
            commandId,
            ids.assertionId,
            ids.snapshotId,
            kind === 'correct_school' ? schoolB : schoolA,
            ids.eventId,
            observation.head.snapshot_id,
            observation.head.revision,
          ],
        );
        await owner.registerGeneration(causeId, vector, tx);
        return {
          causeId,
          commandId,
          actorAccountId: actor,
          accountId: account,
          destinationInstitutionId: schoolB,
          destinationRegionId: regionB,
          observation,
          ids,
        };
      };
      await t.test(
        'exact correction permits its own three deltas but no zero-row tail',
        () =>
          speculative(async (tx) => {
            const input = await prepare(tx);
            await owner.append(input, tx);
            await owner.finalProof(input.causeId, tx);
            const exact = (
              await tx.query(
                'SELECT expires_at::text,expiry_kind FROM whaleu_verification.assertions WHERE id=$1',
                [input.ids.assertionId],
              )
            ).rows[0];
            assert.equal(
              exact.expiry_kind,
              input.observation.affiliation.expiry_kind,
            );
            assert.equal(
              new Date(exact.expires_at).getTime(),
              new Date(input.observation.affiliation.expires_at!).getTime(),
            );
            assert.equal(
              (
                await tx.query(
                  'SELECT a.expires_at=b.expires_at exact FROM whaleu_verification.assertions a JOIN whaleu_verification.assertions b ON b.id=a.previous_assertion_id WHERE a.id=$1',
                  [input.ids.assertionId],
                )
              ).rows[0].exact,
              true,
            );
            const rows = (
              await tx.query(
                'SELECT phase,relation_name,operation,jsonb_array_length(new_rows)::integer n,writer_slot FROM whaleu_verification.school_identity_source_statements WHERE cause_id=$1 ORDER BY phase',
                [input.causeId],
              )
            ).rows;
            assert.deepEqual(
              rows.map((r) => [r.phase, r.relation_name, r.operation, r.n]),
              [
                [1, 'whaleu_verification.assertions', 'INSERT', 1],
                [2, 'whaleu_verification.snapshots', 'INSERT', 1],
                [3, 'whaleu_verification.account_heads', 'UPDATE', 1],
              ],
            );
            assert.equal(new Set(rows.map((r) => r.writer_slot)).size, 1);
            await assert.rejects(
              tx.query(
                'UPDATE whaleu_verification.account_heads SET revision=revision WHERE false',
              ),
              { code: '23514' },
            );
          }),
      );
      for (const expression of [
        "'policy_exempt',NULL",
        "a.expiry_kind,a.expires_at+interval '1 second'",
      ])
        await t.test(`finite expiry cannot be changed to ${expression}`, () =>
          speculative(async (tx) => {
            const input = await prepare(tx),
              query = tx.query.bind(tx);
            tx.query = (async (sql: string, values?: unknown[]) =>
              query(
                sql.startsWith('INSERT INTO whaleu_verification.assertions')
                  ? sql.replace('a.expiry_kind,a.expires_at', expression)
                  : sql,
                values,
              )) as PoolClient['query'];
            await assert.rejects(owner.append(input, tx), { code: '23514' });
          }),
        );
      for (const attack of [
        {
          name: 'missing predecessor',
          table: 'assertions',
          from: 'a.expires_at,a.id',
          to: 'a.expires_at,NULL',
        },
        {
          name: 'dropped independent student-number pointer',
          table: 'snapshots',
          from: 's.student_number_assertion_id,s.phone_assertion_id',
          to: 'NULL,s.phone_assertion_id',
        },
        {
          name: 'changed application state',
          table: 'snapshots',
          from: 's.application_state,s.application_coverage',
          to: "'rejected',s.application_coverage",
        },
        {
          name: 'changed application coverage',
          table: 'snapshots',
          from: 's.application_state,s.application_coverage',
          to: "s.application_state,'missing'",
        },
        {
          name: 'zero-row assertion insertion',
          table: 'assertions',
          from: 'WHERE c.cause_id=$1',
          to: 'WHERE c.cause_id=$1 AND false',
        },
      ])
        await t.test(
          `${attack.name} cannot be an accepted own transition`,
          () =>
            speculative(async (tx) => {
              const input = await prepare(tx),
                query = tx.query.bind(tx);
              tx.query = (async (sql: string, values?: unknown[]) => {
                if (
                  sql.startsWith(
                    `INSERT INTO whaleu_verification.${attack.table}`,
                  )
                ) {
                  assert.ok(sql.includes(attack.from), attack.name);
                  sql = sql.replace(attack.from, attack.to);
                }
                return query(sql, values);
              }) as PoolClient['query'];
              await assert.rejects(owner.append(input, tx), { code: '23514' });
            }),
        );
      await t.test('zero-delta no-op accepts no Verification write', () =>
        speculative(async (tx) => {
          const input = await prepare(tx, 'unchanged');
          await owner.finalProof(input.causeId, tx);
          assert.equal(
            (
              await tx.query(
                'SELECT count(*)::integer n FROM whaleu_verification.school_identity_source_statements WHERE cause_id=$1',
                [input.causeId],
              )
            ).rows[0].n,
            0,
          );
          await assert.rejects(
            tx.query(
              'UPDATE whaleu_verification.account_heads SET revision=revision WHERE false',
            ),
            { code: '23514' },
          );
        }),
      );
      await t.test(
        'foreign admitted statement between initial registration and own assertion rejects',
        () =>
          speculative(async (tx) => {
            const input = await prepare(tx);
            await pool.query(
              'UPDATE whaleu_verification.assertions SET source_reference=source_reference WHERE false',
            );
            await assert.rejects(owner.append(input, tx), { code: '23514' });
          }),
      );
      await t.test(
        'foreign statement between own assertion and snapshot rejects rather than refreshing baseline',
        () =>
          speculative(async (tx) => {
            const input = await prepare(tx),
              query = tx.query.bind(tx);
            tx.query = (async (sql: string, values?: unknown[]) => {
              const result = await query(sql, values);
              if (sql.startsWith('INSERT INTO whaleu_verification.assertions'))
                await pool.query(
                  'UPDATE whaleu_verification.assertions SET source_reference=source_reference WHERE false',
                );
              return result;
            }) as PoolClient['query'];
            await assert.rejects(owner.append(input, tx), { code: '23514' });
          }),
      );
      await t.test(
        'repeated capture cannot replace the trigger-owned initial vector',
        () =>
          speculative(async (tx) => {
            const original = await owner.observeGeneration(tx, account);
            await pool.query(
              'UPDATE whaleu_campus.campuses SET is_active=is_active WHERE false',
            );
            const retained = await owner.observeGeneration(tx, account);
            assert.deepEqual(retained, original);
            assert.notDeepEqual(await owner.observeGeneration(tx), original);
            await assert.rejects(
              tx.query(
                'UPDATE whaleu_verification.school_identity_source_observations SET initial_vector=whaleu_verification.school_identity_admission_vector() WHERE account_id=$1',
                [account],
              ),
              { code: 'P0001' },
            );
          }),
      );
      await t.test(
        'foreign admission before initial source lock cannot be refreshed away',
        () =>
          speculative(async (tx) => {
            await assert.rejects(
              prepare(tx, 'correct_school', async () => {
                await pool.query(
                  'UPDATE whaleu_campus.campuses SET is_active=is_active WHERE false',
                );
              }),
              { code: '23514' },
            );
          }),
      );
      await t.test(
        'foreign statement between own snapshot and head rejects',
        () =>
          speculative(async (tx) => {
            const input = await prepare(tx),
              query = tx.query.bind(tx);
            tx.query = (async (sql: string, values?: unknown[]) => {
              const result = await query(sql, values);
              if (sql.startsWith('INSERT INTO whaleu_verification.snapshots'))
                await pool.query(
                  'UPDATE whaleu_verification.assertions SET source_reference=source_reference WHERE false',
                );
              return result;
            }) as PoolClient['query'];
            await assert.rejects(owner.append(input, tx), { code: '23514' });
          }),
      );
      await t.test(
        'foreign generation committed during an own assertion FK wait rejects its after-vector',
        () =>
          speculative(async (tx) => {
            const input = await prepare(tx),
              blocker = await pool.connect();
            const pid = (await tx.query('SELECT pg_backend_pid() pid')).rows[0]
              .pid;
            let rejected: Promise<void> | undefined;
            await blocker.query('BEGIN');
            try {
              await blocker.query(
                'SELECT id FROM whaleu_verification.assertions WHERE id=$1 FOR UPDATE',
                [input.observation.affiliation.id],
              );
              rejected = assert.rejects(owner.append(input, tx), {
                code: '23514',
              });
              const deadline = Date.now() + 4000;
              let waiting = false;
              while (Date.now() < deadline) {
                waiting = (
                  await pool.query(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND query LIKE 'INSERT INTO whaleu_verification.assertions%') waiting",
                    [pid],
                  )
                ).rows[0].waiting;
                if (waiting) break;
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
              assert.equal(
                waiting,
                true,
                'Own source statement must really wait before the foreign commit',
              );
              await pool.query(
                'UPDATE whaleu_verification.assertions SET source_reference=source_reference WHERE false',
              );
            } finally {
              await blocker.query('ROLLBACK');
              blocker.release();
            }
            await rejected;
          }),
      );
      await t.test(
        'complete speculative correction cannot commit without its actual command and UID graph',
        () =>
          speculative(async (tx) => {
            const input = await prepare(tx);
            await owner.append(input, tx);
            await assert.rejects(tx.query('SET CONSTRAINTS ALL IMMEDIATE'), {
              code: '23514',
            });
          }),
      );
      for (const patch of [
        {
          method: 'administrator_correction',
          policy: 'synthetic-only',
          source: 'synthetic-only',
        },
        {
          method: 'reconciled_import',
          policy: 'verified-school-correction/v1',
          source: 'synthetic-only',
        },
        {
          method: 'reconciled_import',
          policy: 'synthetic-only',
          source: `school_identity_correction:${randomUUID()}`,
        },
        {
          method: 'administrator_correction',
          policy: 'verified-school-correction/v1',
          source: `school_identity_correction:${randomUUID()}`,
        },
      ])
        await t.test(
          `standalone discriminator ${patch.method}/${patch.policy}/${patch.source}`,
          async () => {
            await assert.rejects(
              pool.query(
                `INSERT INTO whaleu_verification.assertions(id,account_id,fact_kind,assertion_state,coverage_state,provenance_state,method,source_reference,policy_reference,source_account_id,verified_at,expiry_kind) VALUES($1,$2,'affiliation','verified','complete','accepted',$3,$4,$5,$2,clock_timestamp(),'policy_exempt')`,
                [
                  randomUUID(),
                  account,
                  patch.method,
                  patch.source,
                  patch.policy,
                ],
              ),
              { code: '23514' },
            );
          },
        );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::integer n FROM whaleu_school_uid.producing_causes',
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::integer n FROM whaleu_verification.school_identity_corrections',
          )
        ).rows[0].n,
        0,
      );
    } finally {
      try {
        if (owns)
          for (const schema of ['whaleu_school_uid', ...migrationSchemaNames])
            await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await lease.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
        lease.release();
        await pool.end();
      }
    }
  },
);
