import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { schoolUidFixture } from '../support/school-uid-fixture.js';
import {
  syntheticAssertion,
  insertSyntheticAssertion,
  setSyntheticSnapshot,
} from '../support/verification-fixtures.js';
import { institutionalSyntheticTransition } from '../support/institutional-sso-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { revokeAssertion } from '../../src/verification/revocation.js';
test(
  'institutional prospective migration preserves historical bytes and allows faithful existing-owner expiry/revocation without invented admission',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture({
      maximumMigration: 144,
    });
    t.after(() => f.close());
    assert.equal(f.historicalPrefix, 144);
    assert.equal(
      (
        await f.pool.query(
          'SELECT max(substring(name FROM 1 FOR 4)::integer) migration FROM whaleu_meta.schema_migrations',
        )
      ).rows[0].migration,
      144,
    );
    const cases: {
      actor: Awaited<ReturnType<typeof f.actor>>;
      affiliation: ReturnType<typeof syntheticAssertion>;
      number: ReturnType<typeof syntheticAssertion>;
      expiredFact: 'affiliation' | 'student_number';
    }[] = [];
    for (const expiredFact of ['affiliation', 'student_number'] as const) {
      const actor = await f.actor();
      const enrollment = async () =>
        (
          await f.pool.query(
            'SELECT (SELECT count(*)::int FROM whaleu_verification.account_heads WHERE account_id=$1) heads,(SELECT count(*)::int FROM whaleu_verification.native_enrollments WHERE account_id=$1) native_enrollments',
            [actor.accountId],
          )
        ).rows[0];
      assert.deepEqual(await enrollment(), { heads: 0, native_enrollments: 0 });
      // This explicitly synthetic pre-0145 history is not native enrollment.
      // Establish its ordinary immutable ledger before transitioning existing
      // facts; missing application/phone history must not become verified absence.
      const baseline = await setSyntheticSnapshot(
        f.pool,
        actor.accountId,
        [],
        'none',
        'missing',
      );
      assert.equal(baseline.revision, 1);
      assert.deepEqual(await enrollment(), { heads: 1, native_enrollments: 0 });
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT s.affiliation_assertion_id,s.student_number_assertion_id,s.phone_assertion_id,s.application_state,s.application_coverage,e.kind,e.expected_revision FROM whaleu_verification.snapshots s JOIN whaleu_verification.events e ON (e.account_id,e.snapshot_id,e.revision)=(s.account_id,s.id,s.revision) WHERE s.account_id=$1 AND s.id=$2',
            [actor.accountId, baseline.snapshotId],
          )
        ).rows[0],
        {
          affiliation_assertion_id: null,
          student_number_assertion_id: null,
          phone_assertion_id: null,
          application_state: 'none',
          application_coverage: 'missing',
          kind: 'reconciled_snapshot',
          expected_revision: 0,
        },
      );
      const affiliation = syntheticAssertion(
        actor.accountId,
        f.scope.institutionId,
        'affiliation',
        {
          method: 'institutional_sso',
          source_reference: 'synthetic-pre-migration-affiliation',
          origin_region_id: f.scope.home.regionId,
          verified_at: new Date(Date.now() - 60000),
          ...(expiredFact === 'affiliation'
            ? { expires_at: new Date(Date.now() - 1000) }
            : {}),
        },
      );
      const number = syntheticAssertion(
        actor.accountId,
        f.scope.institutionId,
        'student_number',
        {
          method: 'institutional_sso',
          source_reference: 'synthetic-pre-migration-number',
          student_number: '00009999',
          ...(expiredFact === 'student_number'
            ? { expires_at: new Date(Date.now() - 1000) }
            : {}),
        },
      );
      await inTransaction(f.pool, async (tx) => {
        await insertSyntheticAssertion(tx, affiliation);
        await insertSyntheticAssertion(tx, number);
      });
      await institutionalSyntheticTransition(f.pool, actor.accountId, {
        affiliation: affiliation.id,
        number: number.id,
      });
      cases.push({ actor, affiliation, number, expiredFact });
    }
    const rows = async () =>
      (
        await f.pool.query(
          'SELECT to_jsonb(a) row FROM whaleu_verification.assertions a WHERE id=ANY($1::uuid[]) ORDER BY id',
          [cases.flatMap((c) => [c.affiliation.id, c.number.id])],
        )
      ).rows;
    const before = await rows();
    await runMigrations(
      f.pool,
      await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      ),
      { mode: 'up' },
    );
    assert.deepEqual(await rows(), before);
    for (const { actor, affiliation, number, expiredFact } of cases) {
      const expired = expiredFact === 'affiliation' ? affiliation : number;
      await inTransaction(f.pool, async (tx) => {
        const h = (
            await tx.query(
              'SELECT h.revision,h.snapshot_id FROM whaleu_verification.account_heads h WHERE account_id=$1 FOR UPDATE',
              [actor.accountId],
            )
          ).rows[0],
          id = randomUUID(),
          snapshot = randomUUID();
        await tx.query(
          "INSERT INTO whaleu_verification.assertions SELECT changed.* FROM whaleu_verification.assertions a CROSS JOIN LATERAL jsonb_populate_record(NULL::whaleu_verification.assertions,to_jsonb(a)||jsonb_build_object('id',$2::uuid,'assertion_state','expired','previous_assertion_id',a.id)) changed WHERE a.id=$1",
          [expired.id, id],
        );
        await tx.query(
          `INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage) SELECT $1,account_id,revision+1,${expiredFact === 'affiliation' ? '$2' : 'affiliation_assertion_id'},${expiredFact === 'student_number' ? '$2' : 'student_number_assertion_id'},phone_assertion_id,application_state,application_coverage FROM whaleu_verification.snapshots WHERE id=$3`,
          [snapshot, id, h.snapshot_id],
        );
        await tx.query(
          `INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,fact_kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code) VALUES($1,$2,$3,'expire','${expiredFact}',$2,$4,$5,$6,'synthetic_authoritative_expiry')`,
          [
            randomUUID(),
            actor.accountId,
            randomUUID(),
            h.revision,
            snapshot,
            h.revision + 1,
          ],
        );
        await tx.query(
          'UPDATE whaleu_verification.account_heads SET revision=$2,snapshot_id=$3 WHERE account_id=$1',
          [actor.accountId, h.revision + 1, snapshot],
        );
      });
      const revision = (
        await f.pool.query(
          'SELECT revision FROM whaleu_verification.account_heads WHERE account_id=$1',
          [actor.accountId],
        )
      ).rows[0].revision;
      await inTransaction(f.pool, (tx) =>
        revokeAssertion(tx, {
          accountId: actor.accountId,
          actorAccountId: actor.accountId,
          operationId: randomUUID(),
          fact:
            expiredFact === 'affiliation' ? 'student_number' : 'affiliation',
          expectedRevision: revision,
          reasonCode: 'synthetic_authorized_revocation',
        }),
      );
      assert.deepEqual(await rows(), before);
      for (const table of [
        'institutional_results',
        'institutional_completions',
      ])
        assert.equal(
          (
            await f.pool.query(
              `SELECT count(*)::int n FROM whaleu_verification.${table}`,
            )
          ).rows[0].n,
          0,
        );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM whaleu_school_uid.producing_causes WHERE account_id=$1 AND kind='institutional_sso'",
            [actor.accountId],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_verification.institutional_descendants WHERE account_id=$1',
            [actor.accountId],
          )
        ).rows[0].n,
        2,
      );
    }
  },
);
