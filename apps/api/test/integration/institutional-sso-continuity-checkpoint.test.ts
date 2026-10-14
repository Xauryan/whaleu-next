import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  institutionalSsoFixture,
  institutionalSyntheticTransition,
} from '../support/institutional-sso-fixture.js';
import {
  syntheticAssertion,
  insertSyntheticAssertion,
} from '../support/verification-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
const ok = (r: { status: number; body: unknown }) =>
  assert.equal(r.status, 200, JSON.stringify(r.body));
const state = async (pool: Pool, account: string) =>
  (
    await pool.query(
      `SELECT to_jsonb(g) generation,to_jsonb(h) head,whaleu_verification.relevant_fact_witness(h.account_id) witness FROM whaleu_verification.account_heads h LEFT JOIN whaleu_verification.relevant_fact_generations g USING(account_id) WHERE h.account_id=$1`,
      [account],
    )
  ).rows[0];
const upgrade = async (pool: Pool) =>
  runMigrations(
    pool,
    await readMigrations(
      fileURLToPath(new URL('../../migrations', import.meta.url)),
    ),
    { mode: 'up' },
  );
async function drivers(pool: Pool) {
  await pool.query(`
 CREATE TABLE whaleu_verification.synthetic_continuity_driver(id uuid PRIMARY KEY,account_id uuid NOT NULL,affiliation uuid,number uuid,phone_loss boolean NOT NULL DEFAULT false,application text);
 CREATE TABLE whaleu_verification.synthetic_continuity_deferred(LIKE whaleu_verification.synthetic_continuity_driver INCLUDING ALL);
 CREATE TABLE whaleu_verification.synthetic_continuity_depth(depth integer NOT NULL);
 CREATE FUNCTION whaleu_verification.synthetic_continuity_transition() RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE h whaleu_verification.account_heads;s whaleu_verification.snapshots;next_snapshot uuid:=gen_random_uuid();
 BEGIN
 SELECT * INTO STRICT h FROM whaleu_verification.account_heads WHERE account_id=NEW.account_id FOR UPDATE;
 SELECT * INTO STRICT s FROM whaleu_verification.snapshots WHERE id=h.snapshot_id;
 INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage)
 VALUES(next_snapshot,h.account_id,h.revision+1,COALESCE(NEW.affiliation,s.affiliation_assertion_id),COALESCE(NEW.number,s.student_number_assertion_id),CASE WHEN NEW.phone_loss THEN NULL ELSE s.phone_assertion_id END,COALESCE(NEW.application,s.application_state),s.application_coverage);
 INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code)
 VALUES(gen_random_uuid(),h.account_id,gen_random_uuid(),'reconciled_snapshot',h.account_id,h.revision,next_snapshot,h.revision+1,'synthetic_nested_transition');
 UPDATE whaleu_verification.account_heads SET revision=h.revision+1,snapshot_id=next_snapshot WHERE account_id=h.account_id;
 RETURN NULL;END $$;
 CREATE TRIGGER synthetic_continuity_transition AFTER INSERT ON whaleu_verification.synthetic_continuity_driver FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_continuity_transition();
 CREATE FUNCTION whaleu_verification.synthetic_continuity_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO whaleu_verification.synthetic_continuity_driver SELECT NEW.*;RETURN NULL;END $$;
 CREATE CONSTRAINT TRIGGER synthetic_continuity_dispatch AFTER INSERT ON whaleu_verification.synthetic_continuity_deferred DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_continuity_dispatch();
 CREATE FUNCTION whaleu_verification.synthetic_continuity_depth() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO whaleu_verification.synthetic_continuity_depth VALUES(pg_trigger_depth());RETURN NULL;END $$;
 CREATE TRIGGER z_synthetic_continuity_depth AFTER UPDATE ON whaleu_verification.relevant_fact_generations FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_continuity_depth();
 `);
}

test(
  'continuity checkpoint upgrade preserves nonzero generations and prepared witness, refusing unavailable old ownership',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture({ maximumMigration: 145 });
    t.after(() => f.close());
    const a = await f.actor(),
      first = await f.prepare(a);
    ok(
      await f.authorize(
        a,
        first.command.requestId,
        first.hash,
        await f.mint(a.accountId, first.command.requestId),
      ),
    );
    const prepared = await f.prepare(a),
      before = await state(f.pool, a.accountId);
    const requestBefore = (
      await f.pool.query(
        'SELECT to_jsonb(q) row FROM whaleu_verification.institutional_requests q WHERE account_id=$1 AND request_id=$2',
        [a.accountId, prepared.command.requestId],
      )
    ).rows[0].row;
    assert.ok(BigInt(before.generation.affiliation_generation) > 0n);
    await f.pool.query(
      'ALTER TABLE whaleu_verification.account_heads DISABLE TRIGGER institutional_relevant_fact_transition',
    );
    await assert.rejects(
      upgrade(f.pool),
      /Existing continuity source is unavailable/,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='whaleu_verification' AND table_name='relevant_fact_generations' AND column_name='head_revision'",
        )
      ).rows[0].n,
      0,
    );
    await f.pool.query(
      'ALTER TABLE whaleu_verification.account_heads ENABLE TRIGGER institutional_relevant_fact_transition',
    );
    const correctiveSql = await readFile(
      new URL(
        '../../migrations/0146_institutional_continuity_owner_checkpoint.sql',
        import.meta.url,
      ),
      'utf8',
    );
    await assert.rejects(
      inTransaction(f.pool, async (tx) => {
        await tx.query(
          'DROP TRIGGER relevant_fact_generation_guard ON whaleu_verification.relevant_fact_generations;CREATE TRIGGER relevant_fact_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_verification.relevant_fact_generations FOR EACH ROW WHEN(false) EXECUTE FUNCTION whaleu_verification.relevant_fact_generation_guard()',
        );
        await tx.query(correctiveSql);
      }),
      /Existing continuity trigger identity is unavailable/,
    );
    await assert.rejects(
      inTransaction(f.pool, async (tx) => {
        const missing = randomUUID();
        await tx.query(
          'ALTER TABLE whaleu_verification.account_heads DISABLE TRIGGER institutional_relevant_fact_transition',
        );
        await tx.query('INSERT INTO whaleu_identity.accounts(id) VALUES($1)', [
          missing,
        ]);
        await tx.query(
          'INSERT INTO whaleu_verification.account_heads(account_id) VALUES($1)',
          [missing],
        );
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        await tx.query(
          'ALTER TABLE whaleu_verification.account_heads ENABLE TRIGGER institutional_relevant_fact_transition',
        );
        await tx.query(correctiveSql);
      }),
      /exact existing head coverage/,
    );
    await upgrade(f.pool);
    const after = await state(f.pool, a.accountId);
    const {
      head_revision: checkpointRevision,
      head_snapshot_id: checkpointSnapshot,
      ...originalGeneration
    } = after.generation;
    assert.deepEqual(originalGeneration, before.generation);
    assert.deepEqual(after.witness, before.witness);
    assert.equal(checkpointRevision, after.head.revision);
    assert.equal(checkpointSnapshot, after.head.snapshot_id);
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT to_jsonb(q) row FROM whaleu_verification.institutional_requests q WHERE account_id=$1 AND request_id=$2',
          [a.accountId, prepared.command.requestId],
        )
      ).rows[0].row,
      requestBefore,
    );
    const completed = await f.authorize(
      a,
      prepared.command.requestId,
      prepared.hash,
      await f.mint(a.accountId, prepared.command.requestId),
    );
    ok(completed);
    assert.equal(completed.body.state, 'completed');
    assert.deepEqual(completed.body.changedFacts, []);
  },
);

test(
  'real nested and deferred head transitions consume exact checkpoints, including subtransaction initialization and rollback',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    await drivers(f.pool);
    await t.test(
      'SAVEPOINT and PLpgSQL EXCEPTION subxids create empty heads without top-level xid assumptions',
      async () => {
        const tx = await f.pool.connect(),
          rolledBack = randomUUID(),
          retained = randomUUID();
        try {
          await tx.query('BEGIN');
          await tx.query('SAVEPOINT synthetic_head');
          await tx.query(
            'INSERT INTO whaleu_identity.accounts(id) VALUES($1);',
            [rolledBack],
          );
          await tx.query(
            'INSERT INTO whaleu_verification.account_heads(account_id) VALUES($1)',
            [rolledBack],
          );
          assert.equal(
            (
              await tx.query(
                'SELECT head_revision FROM whaleu_verification.relevant_fact_generations WHERE account_id=$1',
                [rolledBack],
              )
            ).rows[0].head_revision,
            0,
          );
          assert.equal(
            (
              await tx.query(
                'SELECT xmin::text<>mod(pg_current_xact_id()::text::numeric,4294967296)::text subxid FROM whaleu_verification.account_heads WHERE account_id=$1',
                [rolledBack],
              )
            ).rows[0].subxid,
            true,
          );
          await tx.query('ROLLBACK TO SAVEPOINT synthetic_head');
          assert.equal(
            (
              await tx.query(
                'SELECT 1 FROM whaleu_verification.relevant_fact_generations WHERE account_id=$1',
                [rolledBack],
              )
            ).rowCount,
            0,
          );
          await tx.query('RELEASE SAVEPOINT synthetic_head');
          await tx.query(
            `DO $$ BEGIN BEGIN INSERT INTO whaleu_identity.accounts(id) VALUES('${retained}');INSERT INTO whaleu_verification.account_heads(account_id) VALUES('${retained}');EXCEPTION WHEN others THEN RAISE;END;END $$`,
          );
          assert.equal(
            (
              await tx.query(
                'SELECT xmin::text<>mod(pg_current_xact_id()::text::numeric,4294967296)::text subxid FROM whaleu_verification.account_heads WHERE account_id=$1',
                [retained],
              )
            ).rows[0].subxid,
            true,
          );
          await tx.query('COMMIT');
        } finally {
          await tx.query('ROLLBACK');
          tx.release();
        }
        assert.equal(
          (await state(f.pool, retained)).generation.head_revision,
          0,
        );
      },
    );
    await t.test(
      'phone/application changes at depth three preserve the same relevant witness and subsequent SSO',
      async () => {
        const a = await f.actor(),
          p = await f.prepare(a),
          before = await state(f.pool, a.accountId);
        await f.pool.query(
          "INSERT INTO whaleu_verification.synthetic_continuity_driver(id,account_id,phone_loss,application) VALUES($1,$2,true,'pending'),($3,$2,false,'rejected')",
          [randomUUID(), a.accountId, randomUUID()],
        );
        const after = await state(f.pool, a.accountId);
        assert.deepEqual(after.witness, before.witness);
        assert.equal(after.head.revision, before.head.revision + 2);
        assert.equal(after.generation.head_revision, after.head.revision);
        const complete = await f.authorize(
          a,
          p.command.requestId,
          p.hash,
          await f.mint(a.accountId, p.command.requestId),
        );
        ok(complete);
        assert.equal(complete.body.state, 'completed');
        assert.equal(
          (
            await f.pool.query(
              'SELECT s.application_state,s.phone_assertion_id FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1',
              [a.accountId],
            )
          ).rows[0].application_state,
          'rejected',
        );
      },
    );
    await t.test(
      'two deferred depth-four transitions retain A→B→A history and reject the old prepared witness',
      async () => {
        const a = await f.actor(),
          first = syntheticAssertion(
            a.accountId,
            f.home.institutionId,
            'affiliation',
            { origin_region_id: f.home.regionId },
          ),
          second = syntheticAssertion(
            a.accountId,
            f.home.institutionId,
            'affiliation',
            { origin_region_id: f.home.regionId },
          );
        await inTransaction(f.pool, async (tx) => {
          await insertSyntheticAssertion(tx, first);
          await insertSyntheticAssertion(tx, second);
        });
        await institutionalSyntheticTransition(f.pool, a.accountId, {
          affiliation: first.id,
        });
        const p = await f.prepare(a),
          before = await state(f.pool, a.accountId),
          calls = f.transport.calls;
        await inTransaction(f.pool, (tx) =>
          tx.query(
            'INSERT INTO whaleu_verification.synthetic_continuity_deferred(id,account_id,affiliation) VALUES($1,$2,$3),($4,$2,$5)',
            [randomUUID(), a.accountId, second.id, randomUUID(), first.id],
          ),
        );
        const after = await state(f.pool, a.accountId);
        assert.equal(
          after.witness.affiliationAssertionId,
          before.witness.affiliationAssertionId,
        );
        assert.equal(
          BigInt(after.generation.affiliation_generation),
          BigInt(before.generation.affiliation_generation) + 2n,
        );
        assert.equal(
          after.generation.student_number_generation,
          before.generation.student_number_generation,
        );
        assert.equal(after.head.revision, before.head.revision + 2);
        assert.equal(after.generation.head_snapshot_id, after.head.snapshot_id);
        const rejected = await f.authorize(
          a,
          p.command.requestId,
          p.hash,
          await f.mint(a.accountId, p.command.requestId),
        );
        ok(rejected);
        assert.equal(rejected.body.state, 'stale');
        assert.equal(f.transport.calls, calls);
        assert.ok(
          (
            await f.pool.query(
              'SELECT max(depth) n FROM whaleu_verification.synthetic_continuity_depth',
            )
          ).rows[0].n >= 4,
        );
      },
    );
  },
);

test(
  'unrelated nested generation writes cannot borrow depth, GUCs, another table, or an already consumed real transition',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const a = await f.actor();
    await f.pool.query(
      'CREATE TABLE whaleu_verification.synthetic_continuity_attack(account_id uuid)',
    );
    for (const [name, sql] of [
      [
        'no-op',
        'UPDATE whaleu_verification.relevant_fact_generations SET affiliation_generation=affiliation_generation WHERE account_id=NEW.account_id',
      ],
      [
        'invented affiliation increment',
        'UPDATE whaleu_verification.relevant_fact_generations SET affiliation_generation=affiliation_generation+1 WHERE account_id=NEW.account_id',
      ],
      [
        'invented number increment',
        'UPDATE whaleu_verification.relevant_fact_generations SET student_number_generation=student_number_generation+1 WHERE account_id=NEW.account_id',
      ],
      [
        'reset epoch',
        'UPDATE whaleu_verification.relevant_fact_generations SET tracking_epoch=gen_random_uuid() WHERE account_id=NEW.account_id',
      ],
      [
        'fake checkpoint',
        'UPDATE whaleu_verification.relevant_fact_generations SET head_revision=head_revision+1,head_snapshot_id=gen_random_uuid() WHERE account_id=NEW.account_id',
      ],
      [
        'zero-row update',
        'UPDATE whaleu_verification.relevant_fact_generations SET affiliation_generation=affiliation_generation WHERE false',
      ],
      [
        'zero-row insert',
        'INSERT INTO whaleu_verification.relevant_fact_generations SELECT * FROM whaleu_verification.relevant_fact_generations WHERE false',
      ],
      [
        'zero-row delete',
        'DELETE FROM whaleu_verification.relevant_fact_generations WHERE false',
      ],
      ['truncate', 'TRUNCATE whaleu_verification.relevant_fact_generations'],
    ])
      await t.test(name!, async () => {
        const before = await state(f.pool, a.accountId);
        await f.pool.query(
          `CREATE FUNCTION whaleu_verification.synthetic_continuity_attack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('whaleu.continuity_owner','true',true);${sql};RETURN NULL;END $$;CREATE TRIGGER synthetic_continuity_attack AFTER INSERT ON whaleu_verification.synthetic_continuity_attack FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_continuity_attack()`,
        );
        try {
          await assert.rejects(
            f.pool.query(
              'INSERT INTO whaleu_verification.synthetic_continuity_attack VALUES($1)',
              [a.accountId],
            ),
          );
          assert.deepEqual(await state(f.pool, a.accountId), before);
        } finally {
          await f.pool.query(
            'DROP TRIGGER synthetic_continuity_attack ON whaleu_verification.synthetic_continuity_attack;DROP FUNCTION whaleu_verification.synthetic_continuity_attack()',
          );
        }
      });
    await t.test(
      'same named owner attached to another relation cannot mint continuity',
      async () => {
        await f.pool.query(
          'CREATE TRIGGER institutional_relevant_fact_transition AFTER INSERT ON whaleu_verification.synthetic_continuity_attack FOR EACH ROW EXECUTE FUNCTION whaleu_verification.advance_relevant_fact_generations()',
        );
        try {
          await assert.rejects(
            f.pool.query(
              'INSERT INTO whaleu_verification.synthetic_continuity_attack VALUES($1)',
              [a.accountId],
            ),
            /real Verification head trigger/,
          );
        } finally {
          await f.pool.query(
            'DROP TRIGGER institutional_relevant_fact_transition ON whaleu_verification.synthetic_continuity_attack',
          );
        }
      },
    );
    await t.test(
      'stealing the exact pending head delta forces the real owner second-consumption to roll back',
      async () => {
        const before = await state(f.pool, a.accountId);
        await f.pool
          .query(`CREATE FUNCTION whaleu_verification.synthetic_steal_continuity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    UPDATE whaleu_verification.relevant_fact_generations g SET head_revision=NEW.revision,head_snapshot_id=NEW.snapshot_id,
    affiliation_generation=g.affiliation_generation+(CASE WHEN o.affiliation_assertion_id IS DISTINCT FROM n.affiliation_assertion_id THEN 1 ELSE 0 END),
    student_number_generation=g.student_number_generation+(CASE WHEN o.student_number_assertion_id IS DISTINCT FROM n.student_number_assertion_id THEN 1 ELSE 0 END)
    FROM whaleu_verification.snapshots o,whaleu_verification.snapshots n WHERE g.account_id=NEW.account_id AND o.id=OLD.snapshot_id AND n.id=NEW.snapshot_id;
    RETURN NULL;END $$;CREATE TRIGGER a_synthetic_steal_continuity AFTER UPDATE ON whaleu_verification.account_heads FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_steal_continuity()`);
        try {
          await assert.rejects(
            institutionalSyntheticTransition(f.pool, a.accountId, {
              application: 'pending',
            }),
            (error: unknown) => {
              assert.ok(
                error &&
                  typeof error === 'object' &&
                  'message' in error &&
                  'where' in error,
              );
              assert.match(String(error.message), /exactly one head/);
              assert.match(
                String(error.where),
                /advance_relevant_fact_generations/,
              );
              return true;
            },
          );
          assert.deepEqual(await state(f.pool, a.accountId), before);
        } finally {
          await f.pool.query(
            'DROP TRIGGER a_synthetic_steal_continuity ON whaleu_verification.account_heads;DROP FUNCTION whaleu_verification.synthetic_steal_continuity()',
          );
        }
      },
    );
    await t.test(
      'direct existing-row writes cannot reset or invent continuity',
      async () => {
        const before = await state(f.pool, a.accountId);
        for (const mutation of [
          'affiliation_generation=affiliation_generation',
          'affiliation_generation=affiliation_generation+1',
        ]) {
          await assert.rejects(
            f.pool.query(
              `UPDATE whaleu_verification.relevant_fact_generations SET ${mutation} WHERE account_id=$1`,
              [a.accountId],
            ),
          );
        }
        assert.deepEqual(await state(f.pool, a.accountId), before);
      },
    );
    await t.test(
      'a nested exact two-head steal is rejected by statement cardinality and rolls back both rows',
      async () => {
        const b = await f.actor(),
          accounts = [a.accountId, b.accountId],
          before = await Promise.all(
            accounts.map((account) => state(f.pool, account)),
          );
        await f.pool
          .query(`CREATE FUNCTION whaleu_verification.synthetic_steal_two_continuities() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      UPDATE whaleu_verification.relevant_fact_generations g SET head_revision=h.revision,head_snapshot_id=h.snapshot_id,
      affiliation_generation=g.affiliation_generation+(CASE WHEN o.affiliation_assertion_id IS DISTINCT FROM n.affiliation_assertion_id THEN 1 ELSE 0 END),
      student_number_generation=g.student_number_generation+(CASE WHEN o.student_number_assertion_id IS DISTINCT FROM n.student_number_assertion_id THEN 1 ELSE 0 END)
      FROM whaleu_verification.account_heads h,whaleu_verification.snapshots o,whaleu_verification.snapshots n WHERE g.account_id=h.account_id AND g.head_revision=h.revision-1 AND o.id=g.head_snapshot_id AND n.id=h.snapshot_id;
      RETURN NULL;END $$;CREATE TRIGGER a_synthetic_steal_two_continuities AFTER UPDATE ON whaleu_verification.account_heads FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_steal_two_continuities()`);
        try {
          await assert.rejects(
            inTransaction(f.pool, async (tx) => {
              for (const account of accounts) {
                const snapshot = randomUUID();
                await tx.query(
                  "INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage) SELECT $2,s.account_id,s.revision+1,s.affiliation_assertion_id,s.student_number_assertion_id,s.phone_assertion_id,'pending',s.application_coverage FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1",
                  [account, snapshot],
                );
                await tx.query(
                  "INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code) SELECT gen_random_uuid(),account_id,gen_random_uuid(),'reconciled_snapshot',account_id,revision,$2,revision+1,'synthetic_two_head' FROM whaleu_verification.account_heads WHERE account_id=$1",
                  [account, snapshot],
                );
              }
              await tx.query(
                'UPDATE whaleu_verification.account_heads h SET revision=s.revision,snapshot_id=s.id FROM whaleu_verification.snapshots s WHERE h.account_id=ANY($1::uuid[]) AND s.account_id=h.account_id AND s.revision=h.revision+1',
                [accounts],
              );
            }),
            (error: unknown) => {
              assert.ok(
                error &&
                  typeof error === 'object' &&
                  'message' in error &&
                  'where' in error,
              );
              assert.match(String(error.message), /exactly one head/);
              assert.match(
                String(error.where),
                /synthetic_steal_two_continuities/,
              );
              return true;
            },
          );
          assert.deepEqual(
            await Promise.all(
              accounts.map((account) => state(f.pool, account)),
            ),
            before,
          );
        } finally {
          await f.pool.query(
            'DROP TRIGGER a_synthetic_steal_two_continuities ON whaleu_verification.account_heads;DROP FUNCTION whaleu_verification.synthetic_steal_two_continuities()',
          );
        }
      },
    );
    await t.test(
      'committed empty head missing its generation cannot be lazily repaired by another trigger',
      async () => {
        const missing = randomUUID();
        await inTransaction(f.pool, async (tx) => {
          await tx.query(
            'ALTER TABLE whaleu_verification.account_heads DISABLE TRIGGER institutional_relevant_fact_transition',
          );
          await tx.query(
            'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
            [missing],
          );
          await tx.query(
            'INSERT INTO whaleu_verification.account_heads(account_id) VALUES($1)',
            [missing],
          );
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          await tx.query(
            'ALTER TABLE whaleu_verification.account_heads ENABLE TRIGGER institutional_relevant_fact_transition',
          );
        });
        await f.pool.query(
          'CREATE FUNCTION whaleu_verification.synthetic_continuity_attack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO whaleu_verification.relevant_fact_generations(account_id,head_revision,head_snapshot_id) VALUES(NEW.account_id,0,NULL);RETURN NULL;END $$;CREATE TRIGGER synthetic_continuity_attack AFTER INSERT ON whaleu_verification.synthetic_continuity_attack FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_continuity_attack()',
        );
        try {
          await assert.rejects(
            f.pool.query(
              'INSERT INTO whaleu_verification.synthetic_continuity_attack VALUES($1)',
              [missing],
            ),
            /newly inserted empty head/,
          );
          assert.equal((await state(f.pool, missing)).generation, null);
        } finally {
          await f.pool.query(
            'DROP TRIGGER synthetic_continuity_attack ON whaleu_verification.synthetic_continuity_attack;DROP FUNCTION whaleu_verification.synthetic_continuity_attack()',
          );
        }
      },
    );
  },
);

test(
  'continuity inventory rejects qualified guards and stale checkpoints after a disabled-tracker ABA',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const a = await f.actor();
    await t.test(
      'same function and event mask with WHEN(false) is unavailable',
      async () => {
        await f.pool.query(
          'DROP TRIGGER relevant_fact_generation_guard ON whaleu_verification.relevant_fact_generations;CREATE TRIGGER relevant_fact_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_verification.relevant_fact_generations FOR EACH ROW WHEN(false) EXECUTE FUNCTION whaleu_verification.relevant_fact_generation_guard()',
        );
        try {
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_verification.institutional_continuity_valid() valid',
              )
            ).rows[0].valid,
            false,
          );
          assert.equal((await state(f.pool, a.accountId)).witness, null);
        } finally {
          await f.pool.query(
            'DROP TRIGGER relevant_fact_generation_guard ON whaleu_verification.relevant_fact_generations;CREATE TRIGGER relevant_fact_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_verification.relevant_fact_generations FOR EACH ROW EXECUTE FUNCTION whaleu_verification.relevant_fact_generation_guard()',
          );
        }
      },
    );
    await t.test(
      'same event mask with UPDATE OF excludes unrelated fields and is unavailable',
      async () => {
        await f.pool.query(
          'DROP TRIGGER relevant_fact_generation_guard ON whaleu_verification.relevant_fact_generations;CREATE TRIGGER relevant_fact_generation_guard BEFORE INSERT OR UPDATE OF tracking_epoch OR DELETE ON whaleu_verification.relevant_fact_generations FOR EACH ROW EXECUTE FUNCTION whaleu_verification.relevant_fact_generation_guard()',
        );
        try {
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_verification.institutional_continuity_valid() valid',
              )
            ).rows[0].valid,
            false,
          );
        } finally {
          await f.pool.query(
            'DROP TRIGGER relevant_fact_generation_guard ON whaleu_verification.relevant_fact_generations;CREATE TRIGGER relevant_fact_generation_guard BEFORE INSERT OR UPDATE OR DELETE ON whaleu_verification.relevant_fact_generations FOR EACH ROW EXECUTE FUNCTION whaleu_verification.relevant_fact_generation_guard()',
          );
        }
      },
    );
    await t.test(
      'reenabling a tracker after real head changes never turns a stale watermark into continuity',
      async () => {
        const first = syntheticAssertion(
            a.accountId,
            f.home.institutionId,
            'affiliation',
            { origin_region_id: f.home.regionId },
          ),
          second = syntheticAssertion(
            a.accountId,
            f.home.institutionId,
            'affiliation',
            { origin_region_id: f.home.regionId },
          );
        await inTransaction(f.pool, async (tx) => {
          await insertSyntheticAssertion(tx, first);
          await insertSyntheticAssertion(tx, second);
        });
        await institutionalSyntheticTransition(f.pool, a.accountId, {
          affiliation: first.id,
        });
        const prepared = await f.prepare(a),
          initial = await state(f.pool, a.accountId);
        await f.pool.query(
          'ALTER TABLE whaleu_verification.account_heads DISABLE TRIGGER institutional_relevant_fact_transition',
        );
        try {
          await institutionalSyntheticTransition(f.pool, a.accountId, {
            affiliation: second.id,
          });
          await institutionalSyntheticTransition(f.pool, a.accountId, {
            affiliation: first.id,
          });
        } finally {
          await f.pool.query(
            'ALTER TABLE whaleu_verification.account_heads ENABLE TRIGGER institutional_relevant_fact_transition',
          );
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT s.affiliation_assertion_id FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1',
              [a.accountId],
            )
          ).rows[0].affiliation_assertion_id,
          first.id,
        );
        ok(await f.closeRequest(a, prepared.command.requestId, prepared.hash));
        const after = await state(f.pool, a.accountId);
        assert.equal(
          (
            await f.pool.query(
              'SELECT whaleu_verification.institutional_continuity_valid() valid',
            )
          ).rows[0].valid,
          true,
        );
        assert.deepEqual(after.generation, initial.generation);
        assert.equal(after.head.revision, initial.head.revision + 2);
        assert.equal(after.witness, null);
        await assert.rejects(
          institutionalSyntheticTransition(f.pool, a.accountId, {
            application: 'rejected',
          }),
          /exactly one head/,
        );
      },
    );
  },
);
