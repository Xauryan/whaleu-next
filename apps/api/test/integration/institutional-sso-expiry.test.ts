import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import {
  institutionalSsoFixture,
  institutionalSyntheticTransition,
  institutionalRows,
} from '../support/institutional-sso-fixture.js';
import {
  syntheticAssertion,
  insertSyntheticAssertion,
} from '../support/verification-fixtures.js';
import { inTransaction } from '../../src/database/database.js';
const ok = (response: { status: number; body: unknown }) =>
  assert.equal(response.status, 200, JSON.stringify(response.body));
// Real product TTL. This one test's timeout covers the business wait; no clock,
// production timeout, session or protected request timestamp is modified.
test(
  'institutional genuine 300-second prepared expiry requires durable original recovery before a new request',
  { timeout: 360000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      p = await f.prepare(actor);
    const original = (
      await f.pool.query(
        'SELECT prepared_at::text,request_expires_at::text,extract(epoch FROM request_expires_at-prepared_at)::int seconds FROM whaleu_verification.institutional_requests WHERE account_id=$1 AND request_id=$2',
        [actor.accountId, p.command.requestId],
      )
    ).rows[0];
    assert.equal(original.seconds, 300);
    await wait(
      Math.max(0, Date.parse(original.request_expires_at) - Date.now() + 100),
    );
    const observed = await f.read(actor, p.command.requestId);
    ok(observed);
    assert.equal(observed.body.state, 'expired');
    assert.equal(
      (
        await f.pool.query(
          'SELECT state FROM whaleu_verification.institutional_requests WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, p.command.requestId],
        )
      ).rows[0].state,
      'prepared',
    );
    const expired = await f.recover(actor, p.command.requestId, p.hash);
    ok(expired);
    assert.equal(expired.body.state, 'expired');
    const stored = (
      await f.pool.query(
        'SELECT state,receipt,prepared_at::text,request_expires_at::text FROM whaleu_verification.institutional_requests WHERE account_id=$1 AND request_id=$2',
        [actor.accountId, p.command.requestId],
      )
    ).rows[0];
    assert.equal(stored.state, 'expired');
    assert.deepEqual(stored.receipt, expired.body);
    assert.equal(stored.prepared_at, original.prepared_at);
    assert.equal(stored.request_expires_at, original.request_expires_at);
    const fresh = await f.prepare(actor);
    assert.notEqual(fresh.command.requestId, p.command.requestId);
    ok(await f.closeRequest(actor, fresh.command.requestId, fresh.hash));
    assert.equal(f.transport.calls, 0);
  },
);

test(
  'institutional retained-fact deadline expires admitted local recovery without any provider replay',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const actor = await f.actor();
    const affiliation = syntheticAssertion(
      actor.accountId,
      f.home.institutionId,
      'affiliation',
      {
        origin_region_id: f.home.regionId,
        expires_at: new Date(Date.now() + 15000),
      },
    );
    await inTransaction(f.pool, (tx) =>
      insertSyntheticAssertion(tx, affiliation),
    );
    await institutionalSyntheticTransition(f.pool, actor.accountId, {
      affiliation: affiliation.id,
    });
    const p = await f.prepare(actor),
      opaque = await f.mint(actor.accountId, p.command.requestId);
    // Inject an ordinary transient local write failure only. Trusted provider and
    // all durable admission/causal/currentness owners remain real and unmodified.
    await f.pool.query(
      "CREATE FUNCTION whaleu_verification.synthetic_institutional_local_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic local write interruption'; END $$; CREATE TRIGGER a_synthetic_institutional_local_failure BEFORE INSERT ON whaleu_verification.institutional_completions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_institutional_local_failure()",
    );
    const interrupted = await f.authorize(
      actor,
      p.command.requestId,
      p.hash,
      opaque,
    );
    assert.equal(interrupted.status, 503);
    await f.pool.query(
      'DROP TRIGGER a_synthetic_institutional_local_failure ON whaleu_verification.institutional_completions; DROP FUNCTION whaleu_verification.synthetic_institutional_local_failure()',
    );
    const admitted = (
      await f.pool.query(
        'SELECT q.state,r.finalize_deadline::text,r.fact_expires_at::text FROM whaleu_verification.institutional_requests q JOIN whaleu_verification.institutional_results r ON r.id=q.result_id WHERE q.account_id=$1 AND q.request_id=$2',
        [actor.accountId, p.command.requestId],
      )
    ).rows[0];
    assert.equal(admitted.state, 'ready_to_finalize');
    assert.equal(
      Date.parse(admitted.finalize_deadline),
      affiliation.expires_at!.getTime(),
    );
    await wait(
      Math.max(0, Date.parse(admitted.finalize_deadline) - Date.now() + 100),
    );
    const observed = await f.read(actor, p.command.requestId);
    ok(observed);
    assert.equal(observed.body.state, 'expired');
    const recovered = await f.recover(actor, p.command.requestId, p.hash);
    ok(recovered);
    assert.equal(recovered.body.state, 'expired');
    assert.equal(f.transport.calls, 1);
    assert.equal(
      (await institutionalRows(f.pool, actor.accountId)).completions,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM whaleu_verification.institutional_requests WHERE account_id=$1 AND state IN('prepared','processing','outcome_unknown','ready_to_finalize')",
          [actor.accountId],
        )
      ).rows[0].n,
      0,
    );
  },
);

test(
  'institutional exact PostgreSQL deadline predicate rejects equality and preserves one-microsecond distinctions',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    // Identical shared final-clock predicate, with only the test instant fixed.
    const compared = await f.pool.query(
      "WITH instant AS MATERIALIZED(SELECT '2026-11-01 00:00:00.123456+00'::timestamptz now) SELECT ordinal::int,NOT isfinite(until) OR until<=instant.now expired FROM instant,unnest(ARRAY['2026-11-01 00:00:00.123455+00','2026-11-01 00:00:00.123456+00','2026-11-01 00:00:00.123457+00']::timestamptz[]) WITH ORDINALITY d(until,ordinal) ORDER BY ordinal",
    );
    assert.deepEqual(compared.rows, [
      { ordinal: 1, expired: true },
      { ordinal: 2, expired: true },
      { ordinal: 3, expired: false },
    ]);
    const { registerTransactionExactDeadline } =
      await import('../../src/database/transaction-deadlines.js');
    let exact = '';
    await assert.rejects(
      inTransaction(f.pool, async (tx) => {
        exact = (
          await tx.query(
            "SELECT (date_trunc('milliseconds',clock_timestamp())+interval '1 microsecond')::text deadline",
          )
        ).rows[0].deadline;
        assert.match(exact, /\.\d{3}001/);
        registerTransactionExactDeadline(
          tx,
          exact,
          'INSTITUTIONAL_SSO_UNAVAILABLE',
        );
        await tx.query('SELECT pg_sleep(0.003)');
      }),
      { code: 'INSTITUTIONAL_SSO_UNAVAILABLE' },
    );
  },
);

test(
  'institutional expired response cannot admit while its authenticated fact is still valid and never replays externally',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const a = await f.actor(),
      p = await f.prepare(a),
      until = (
        await f.pool.query(
          "SELECT (clock_timestamp()+interval '1 second')::text until",
        )
      ).rows[0].until;
    const opaque = await f.mint(a.accountId, p.command.requestId, {
      responseUseExpiresAt: until,
    });
    f.transport.beforeReturn = async () => {
      const ms = (
        await f.pool.query(
          'SELECT greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::float8 ms',
          [until],
        )
      ).rows[0].ms;
      await wait(ms + 5);
    };
    assert.equal(
      (await f.authorize(a, p.command.requestId, p.hash, opaque)).status,
      503,
    );
    assert.equal((await institutionalRows(f.pool, a.accountId)).results, 0);
    assert.equal(f.transport.calls, 1);
    const replay = await f.authorize(a, p.command.requestId, p.hash, opaque);
    ok(replay);
    assert.notEqual(replay.body.state, 'completed');
    assert.equal(f.transport.calls, 1);
    ok(await f.closeRequest(a, p.command.requestId, p.hash));
  },
);

test(
  'institutional tentative finalization rolls back when its exact retained-fact minimum expires across the first deferred wait',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const a = await f.actor(),
      affiliation = syntheticAssertion(
        a.accountId,
        f.home.institutionId,
        'affiliation',
        {
          origin_region_id: f.home.regionId,
          expires_at: new Date(Date.now() + 7000),
        },
      );
    await inTransaction(f.pool, (tx) =>
      insertSyntheticAssertion(tx, affiliation),
    );
    await institutionalSyntheticTransition(f.pool, a.accountId, {
      affiliation: affiliation.id,
    });
    const p = await f.prepare(a),
      opaque = await f.mint(a.accountId, p.command.requestId),
      key = 793147;
    await f.pool.query(
      `CREATE FUNCTION whaleu_verification.synthetic_sso_final_deadline_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NULL; END $$; CREATE CONSTRAINT TRIGGER a_synthetic_sso_final_deadline_wait AFTER INSERT ON whaleu_verification.school_identity_source_observations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_sso_final_deadline_wait()`,
    );
    const block = await f.pool.connect();
    await block.query('BEGIN');
    await block.query('SELECT pg_advisory_xact_lock($1)', [key]);
    const pending = f
      .authorize(a, p.command.requestId, p.hash, opaque)
      .then((r) => r);
    try {
      await f.waitForLock('SET CONSTRAINTS ALL IMMEDIATE');
      const q = (
        await f.pool.query(
          'SELECT r.finalize_deadline::text deadline,r.finalize_deadline=a.expires_at exact,extract(epoch FROM r.finalize_deadline-clock_timestamp())*1000 remaining FROM whaleu_verification.institutional_results r JOIN whaleu_verification.assertions a ON a.id=$2 WHERE r.account_id=$1',
          [a.accountId, affiliation.id],
        )
      ).rows[0];
      assert.equal(q.exact, true);
      assert.ok(Number(q.remaining) > 0);
      await wait(Number(q.remaining) + 5);
    } finally {
      await block.query('ROLLBACK');
      block.release();
    }
    assert.equal((await pending).status, 503);
    const rows = await institutionalRows(f.pool, a.accountId);
    assert.equal(rows.results, 1);
    assert.equal(rows.completions, 0);
    assert.equal(rows.causes, 0);
    await f.pool.query(
      'DROP TRIGGER a_synthetic_sso_final_deadline_wait ON whaleu_verification.school_identity_source_observations; DROP FUNCTION whaleu_verification.synthetic_sso_final_deadline_wait()',
    );
    const expired = await f.recover(a, p.command.requestId, p.hash);
    ok(expired);
    assert.equal(expired.body.state, 'expired');
    assert.equal(f.transport.calls, 1);
  },
);

test(
  'institutional real provider timeout and original 60-second claim boundary discard a non-cooperating late transport payload',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const a = await f.actor(),
      p = await f.prepare(a),
      opaque = await f.mint(a.accountId, p.command.requestId);
    let entered!: () => void, release!: () => void;
    const arrived = new Promise<void>((r) => (entered = r)),
      hold = new Promise<void>((r) => (release = r));
    f.transport.ignoreAbort = true;
    f.transport.beforeReturn = async () => {
      entered();
      await hold;
    };
    const pending = f
      .authorize(a, p.command.requestId, p.hash, opaque)
      .then((r) => r);
    await arrived;
    const q = (
      await f.pool.query(
        'SELECT claim_deadline::text deadline,extract(epoch FROM claim_deadline-claimed_at)::int seconds FROM whaleu_verification.institutional_requests WHERE account_id=$1 AND request_id=$2',
        [a.accountId, p.command.requestId],
      )
    ).rows[0];
    assert.equal(q.seconds, 60);
    try {
      const unknown = await pending;
      ok(unknown);
      assert.equal(unknown.body.state, 'outcome_unknown');
      const ms = (
        await f.pool.query(
          'SELECT greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::float8 ms',
          [q.deadline],
        )
      ).rows[0].ms;
      await wait(ms + 5);
    } finally {
      release();
    }
    await wait(20);
    assert.equal(f.transport.returnedPayloads, 1);
    const recovered = await f.recover(a, p.command.requestId, p.hash);
    ok(recovered);
    assert.equal(recovered.body.state, 'outcome_unknown');
    ok(await f.authorize(a, p.command.requestId, p.hash, opaque));
    assert.equal(f.transport.calls, 1);
    assert.equal((await institutionalRows(f.pool, a.accountId)).results, 0);
    ok(await f.closeRequest(a, p.command.requestId, p.hash));
  },
);
