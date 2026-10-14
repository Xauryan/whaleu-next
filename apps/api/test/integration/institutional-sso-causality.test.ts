import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  institutionalSsoFixture,
  institutionalSyntheticTransition,
  institutionalRows,
} from '../support/institutional-sso-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { revokeAssertion } from '../../src/verification/revocation.js';
const ok = (response: { status: number; body: unknown }) =>
  assert.equal(response.status, 200, JSON.stringify(response.body));
test(
  'institutional source reservations, exact descendant closure and old-pointer anti-revival resist direct SQL forgery',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      p = await f.prepare(actor);
    const success = await f.authorize(
      actor,
      p.command.requestId,
      p.hash,
      await f.mint(actor.accountId, p.command.requestId),
    );
    ok(success);
    const pointers = (
      await f.pool.query(
        'SELECT s.* FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1',
        [actor.accountId],
      )
    ).rows[0];
    const clone = (id: string, changes: Record<string, unknown>) =>
      inTransaction(f.pool, (tx) =>
        tx.query(
          'INSERT INTO whaleu_verification.assertions SELECT changed.* FROM whaleu_verification.assertions a CROSS JOIN LATERAL jsonb_populate_record(NULL::whaleu_verification.assertions,to_jsonb(a)||$2::jsonb) changed WHERE a.id=$1',
          [id, JSON.stringify(changes)],
        ),
      );
    await t.test(
      'no unattached fresh verified SSO or mixed reserved discriminator',
      async () => {
        await assert.rejects(
          clone(pointers.affiliation_assertion_id, { id: randomUUID() }),
        );
        await assert.rejects(
          clone(pointers.affiliation_assertion_id, {
            id: randomUUID(),
            method: 'reconciled_import',
          }),
        );
        await assert.rejects(
          clone(pointers.student_number_assertion_id, {
            id: randomUUID(),
            source_reference: 'synthetic-untrusted',
          }),
        );
      },
    );
    for (const fact of ['affiliation', 'student_number'] as const)
      await t.test(
        `${fact} changed fields, fake predecessor and detached descendants fail`,
        async () => {
          const id =
            pointers[
              fact === 'affiliation'
                ? 'affiliation_assertion_id'
                : 'student_number_assertion_id'
            ];
          for (const change of [
            { previous_assertion_id: randomUUID() },
            { issuer_institution_id: f.destination.institutionId },
            { source_issuer_institution_id: f.destination.institutionId },
            { source_reference: 'changed-source' },
            { policy_reference: 'institutional-sso/changed' },
            { expires_at: '2099-01-01T00:00:00Z' },
            ...(fact === 'student_number'
              ? [{ student_number: 'different-number' }]
              : []),
          ])
            await assert.rejects(
              clone(id, {
                id: randomUUID(),
                assertion_state: 'revoked',
                previous_assertion_id: id,
                ...change,
              }),
            );
          await assert.rejects(
            clone(id, {
              id: randomUUID(),
              assertion_state: 'revoked',
              previous_assertion_id: id,
            }),
          );
          await assert.rejects(
            clone(id, {
              id: randomUUID(),
              assertion_state: 'expired',
              previous_assertion_id: id,
            }),
          );
        },
      );
    await t.test(
      'continuity source cannot be directly reset, silently updated or disabled',
      async () => {
        for (const sql of [
          'UPDATE whaleu_verification.relevant_fact_generations SET affiliation_generation=affiliation_generation WHERE false',
          'DELETE FROM whaleu_verification.relevant_fact_generations WHERE false',
          'TRUNCATE whaleu_verification.relevant_fact_generations',
        ])
          await assert.rejects(inTransaction(f.pool, (tx) => tx.query(sql)));
        await inTransaction(f.pool, async (tx) => {
          await tx.query(
            'ALTER TABLE whaleu_verification.account_heads DISABLE TRIGGER institutional_relevant_fact_transition',
          );
          assert.equal(
            (
              await tx.query(
                'SELECT whaleu_verification.relevant_fact_witness($1) witness',
                [actor.accountId],
              )
            ).rows[0].witness,
            null,
          );
          await tx.query(
            'ALTER TABLE whaleu_verification.account_heads ENABLE TRIGGER institutional_relevant_fact_transition',
          );
        });
      },
    );
    await t.test(
      'revoked number cannot revive old verified pointer or acquire a UID cause',
      async () => {
        await inTransaction(f.pool, (tx) =>
          revokeAssertion(tx, {
            accountId: actor.accountId,
            actorAccountId: actor.accountId,
            operationId: randomUUID(),
            fact: 'student_number',
            expectedRevision: pointers.revision,
            reasonCode: 'synthetic_authorized_revocation',
          }),
        );
        await assert.rejects(
          institutionalSyntheticTransition(f.pool, actor.accountId, {
            number: pointers.student_number_assertion_id,
          }),
        );
        assert.equal(
          (await institutionalRows(f.pool, actor.accountId)).causes,
          1,
        );
        const descendants = (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_verification.institutional_descendants WHERE account_id=$1',
            [actor.accountId],
          )
        ).rows[0];
        assert.equal(descendants.n, 1);
      },
    );
  },
);
test(
  'institutional final first-V0 rejects a zero-row foreign source statement and keeps durable proof for clean recovery',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      p = await f.prepare(actor),
      opaque = await f.mint(actor.accountId, p.command.requestId);
    await f.pool.query(
      'CREATE FUNCTION whaleu_verification.synthetic_institutional_foreign_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE whaleu_verification.account_heads SET revision=revision WHERE false; RETURN NEW; END $$; CREATE TRIGGER a_synthetic_institutional_foreign_source BEFORE INSERT ON whaleu_verification.institutional_completions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_institutional_foreign_source()',
    );
    const rejected = await f.authorize(
      actor,
      p.command.requestId,
      p.hash,
      opaque,
    );
    assert.equal(rejected.status, 503);
    assert.equal((await institutionalRows(f.pool, actor.accountId)).results, 1);
    assert.equal(
      (await institutionalRows(f.pool, actor.accountId)).completions,
      0,
    );
    await f.pool.query(
      'DROP TRIGGER a_synthetic_institutional_foreign_source ON whaleu_verification.institutional_completions; DROP FUNCTION whaleu_verification.synthetic_institutional_foreign_source()',
    );
    const completed = await f.recover(actor, p.command.requestId, p.hash);
    ok(completed);
    assert.equal(completed.body.state, 'completed');
    assert.equal(f.transport.calls, 1);
  },
);

test(
  'institutional protected recipes reject extra/empty/missing/foreign source phases after registration',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const cases = [
      {
        name: 'empty assertion after registration',
        table: 'assertions',
        body: "IF NEW.method='institutional_sso' THEN INSERT INTO whaleu_verification.assertions SELECT * FROM whaleu_verification.assertions WHERE false; END IF; RETURN NEW;",
      },
      {
        name: 'empty head during snapshot phase',
        table: 'snapshots',
        body: 'UPDATE whaleu_verification.account_heads SET revision=revision WHERE false; RETURN NEW;',
      },
      {
        name: 'missing exact final head',
        table: 'account_heads',
        body: 'RETURN NULL;',
      },
      {
        name: 'extra post-write source statement',
        table: 'institutional_uid_results',
        body: 'UPDATE whaleu_verification.account_heads SET revision=revision WHERE false; RETURN NEW;',
      },
      {
        name: 'foreign row source account',
        table: 'assertions',
        body: "IF NEW.method='institutional_sso' THEN NEW.account_id:=NEW.issuer_institution_id; END IF; RETURN NEW;",
      },
    ];
    for (const scenario of cases)
      await t.test(scenario.name, async () => {
        const actor = await f.actor(),
          p = await f.prepare(actor),
          opaque = await f.mint(actor.accountId, p.command.requestId);
        await f.pool.query(
          `CREATE FUNCTION whaleu_verification.synthetic_institutional_phase_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${scenario.body} END $$; CREATE TRIGGER a_synthetic_institutional_phase_failure BEFORE ${scenario.table === 'account_heads' ? 'UPDATE' : 'INSERT'} ON whaleu_verification.${scenario.table} FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_institutional_phase_failure()`,
        );
        const response = await f.authorize(
          actor,
          p.command.requestId,
          p.hash,
          opaque,
        );
        assert.equal(response.status, 503);
        assert.equal(
          (await institutionalRows(f.pool, actor.accountId)).results,
          1,
        );
        assert.equal(
          (await institutionalRows(f.pool, actor.accountId)).completions,
          0,
        );
        await f.pool.query(
          `DROP TRIGGER a_synthetic_institutional_phase_failure ON whaleu_verification.${scenario.table}; DROP FUNCTION whaleu_verification.synthetic_institutional_phase_failure()`,
        );
        const recovered = await f.recover(actor, p.command.requestId, p.hash);
        ok(recovered);
        assert.equal(recovered.body.state, 'completed');
        const phases = (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_verification.school_identity_source_statements s JOIN whaleu_school_uid.producing_causes c ON c.id=s.cause_id WHERE c.account_id=$1',
            [actor.accountId],
          )
        ).rows[0].n;
        assert.equal(phases, 4);
      });
  },
);

test(
  'institutional final proof detects a committed foreign source change across a deferred constraint wait',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      foreign = await f.actor(),
      p = await f.prepare(actor),
      opaque = await f.mint(actor.accountId, p.command.requestId),
      key = 793145;
    await f.pool.query(
      `CREATE FUNCTION whaleu_verification.synthetic_institutional_deferred_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NULL; END $$; CREATE CONSTRAINT TRIGGER a_synthetic_institutional_deferred_wait AFTER INSERT ON whaleu_verification.school_identity_source_observations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_institutional_deferred_wait()`,
    );
    const block = await f.pool.connect();
    await block.query('BEGIN');
    await block.query('SELECT pg_advisory_xact_lock($1)', [key]);
    const pending = f
      .authorize(actor, p.command.requestId, p.hash, opaque)
      .then((r) => r);
    try {
      const { setTimeout: wait } = await import('node:timers/promises');
      let found = false;
      for (let attempt = 0; attempt < 500; attempt++) {
        found = (
          await f.pool.query(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query='SET CONSTRAINTS ALL IMMEDIATE') found",
          )
        ).rows[0].found;
        if (found) break;
        await wait(20);
      }
      assert.equal(found, true, 'Finalization must reach the deferred wait');
      await Promise.race([
        institutionalSyntheticTransition(f.pool, foreign.accountId, {
          application: 'pending',
        }),
        wait(10000).then(() => {
          throw new Error(
            'Foreign source commit was blocked by an earlier fence',
          );
        }),
      ]);
      assert.equal(
        (
          await f.pool.query(
            'SELECT s.application_state FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1',
            [foreign.accountId],
          )
        ).rows[0].application_state,
        'pending',
        'Foreign source change must commit before releasing finalization',
      );
    } finally {
      await block.query('ROLLBACK');
      block.release();
    }
    const response = await pending;
    assert.equal(response.status, 503);
    assert.equal(
      (await institutionalRows(f.pool, actor.accountId)).completions,
      0,
    );
    await f.pool.query(
      'DROP TRIGGER a_synthetic_institutional_deferred_wait ON whaleu_verification.school_identity_source_observations; DROP FUNCTION whaleu_verification.synthetic_institutional_deferred_wait()',
    );
    const recovered = await f.recover(actor, p.command.requestId, p.hash);
    ok(recovered);
    assert.equal(recovered.body.state, 'completed');
    assert.equal(f.transport.calls, 1);
  },
);

test(
  'institutional protected new-kind completion graph rejects substituted and missing causal links and forged UID outcomes',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const cases = [
      {
        name: 'wrong admitted result',
        table: 'institutional_completions',
        body: 'NEW.result_id:=gen_random_uuid(); RETURN NEW;',
      },
      {
        name: 'cross-account completion',
        table: 'institutional_completions',
        body: 'NEW.account_id:=gen_random_uuid(); RETURN NEW;',
      },
      {
        name: 'wrong producing cause',
        table: 'institutional_completions',
        body: 'NEW.cause_id:=gen_random_uuid(); RETURN NEW;',
      },
      {
        name: 'wrong verification event',
        table: 'institutional_completions',
        body: 'NEW.event_id:=gen_random_uuid(); RETURN NEW;',
      },
      {
        name: 'substituted snapshot',
        table: 'institutional_completions',
        body: 'NEW.snapshot_id:=gen_random_uuid(); RETURN NEW;',
      },
      {
        name: 'missing protected completion',
        table: 'institutional_completions',
        body: 'RETURN NULL;',
      },
      {
        name: 'missing exact verification event',
        table: 'events',
        body: "IF NEW.kind='institutional_sso' THEN RETURN NULL; END IF; RETURN NEW;",
      },
      {
        name: 'substituted UID result completion',
        table: 'institutional_uid_results',
        body: 'NEW.completion_id:=gen_random_uuid(); RETURN NEW;',
      },
      {
        name: 'missing UID result',
        table: 'institutional_uid_results',
        body: 'RETURN NULL;',
      },
      {
        name: 'forged retained outcome',
        table: 'institutional_uid_results',
        body: "NEW.outcome:='retained'; NEW.unavailable_reason:=NULL; RETURN NEW;",
      },
      {
        name: 'forged unknown-history deferred outcome',
        table: 'institutional_uid_results',
        body: "NEW.outcome:='deferred_unavailable'; NEW.unavailable_reason:='account_history_unknown'; RETURN NEW;",
      },
      {
        name: 'unexplained phone-pointer replacement',
        table: 'snapshots',
        body: 'NEW.phone_assertion_id:=NULL; RETURN NEW;',
      },
    ];
    for (const scenario of cases)
      await t.test(scenario.name, async () => {
        const a = await f.actor(),
          p = await f.prepare(a),
          opaque = await f.mint(a.accountId, p.command.requestId),
          before = f.transport.calls;
        await f.pool.query(
          `CREATE FUNCTION whaleu_verification.synthetic_sso_graph_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${scenario.body} END $$; CREATE TRIGGER a_synthetic_sso_graph_failure BEFORE INSERT ON whaleu_verification.${scenario.table} FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_sso_graph_failure()`,
        );
        let response;
        try {
          response = await f.authorize(a, p.command.requestId, p.hash, opaque);
        } finally {
          await f.pool.query(
            `DROP TRIGGER a_synthetic_sso_graph_failure ON whaleu_verification.${scenario.table}; DROP FUNCTION whaleu_verification.synthetic_sso_graph_failure()`,
          );
        }
        assert.equal(response.status, 503, scenario.name);
        const failed = await institutionalRows(f.pool, a.accountId);
        assert.equal(failed.results, 1);
        assert.equal(failed.completions, 0);
        assert.equal(failed.causes, 0);
        assert.equal(failed.assertions, 0);
        const recovered = await f.recover(a, p.command.requestId, p.hash);
        ok(recovered);
        assert.equal(recovered.body.state, 'completed');
        assert.equal(f.transport.calls, before + 1);
      });
  },
);

test(
  'institutional affiliation revival and wrong descendant event cannot attach old source authority',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const a = await f.actor(),
      p = await f.prepare(a);
    ok(
      await f.authorize(
        a,
        p.command.requestId,
        p.hash,
        await f.mint(a.accountId, p.command.requestId),
      ),
    );
    const before = (
      await f.pool.query(
        'SELECT s.* FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1',
        [a.accountId],
      )
    ).rows[0];
    await f.pool.query(
      "CREATE FUNCTION whaleu_verification.synthetic_sso_descendant_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='revoke' THEN NEW.reason_code:='synthetic_wrong_event'; NEW.fact_kind:='student_number'; END IF; RETURN NEW; END $$; CREATE TRIGGER a_synthetic_sso_descendant_event_failure BEFORE INSERT ON whaleu_verification.events FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_sso_descendant_event_failure()",
    );
    try {
      await assert.rejects(
        inTransaction(f.pool, (tx) =>
          revokeAssertion(tx, {
            accountId: a.accountId,
            actorAccountId: a.accountId,
            operationId: randomUUID(),
            fact: 'affiliation',
            expectedRevision: before.revision,
            reasonCode: 'synthetic_authorized_revocation',
          }),
        ),
      );
    } finally {
      await f.pool.query(
        'DROP TRIGGER a_synthetic_sso_descendant_event_failure ON whaleu_verification.events; DROP FUNCTION whaleu_verification.synthetic_sso_descendant_event_failure()',
      );
    }
    await inTransaction(f.pool, (tx) =>
      revokeAssertion(tx, {
        accountId: a.accountId,
        actorAccountId: a.accountId,
        operationId: randomUUID(),
        fact: 'affiliation',
        expectedRevision: before.revision,
        reasonCode: 'synthetic_authorized_revocation',
      }),
    );
    await assert.rejects(
      institutionalSyntheticTransition(f.pool, a.accountId, {
        affiliation: before.affiliation_assertion_id,
      }),
    );
    assert.equal((await institutionalRows(f.pool, a.accountId)).causes, 1);
  },
);
