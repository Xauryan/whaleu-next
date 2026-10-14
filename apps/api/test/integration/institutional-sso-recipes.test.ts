import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import type { RuntimeConfig } from '../../src/config/config.js';
import {
  institutionalSsoFixture,
  institutionalRows,
  institutionalSyntheticTransition,
} from '../support/institutional-sso-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import {
  syntheticAssertion,
  insertSyntheticAssertion,
} from '../support/verification-fixtures.js';
const ok = (response: { status: number; body: unknown }) =>
  assert.equal(response.status, 200, JSON.stringify(response.body));
test(
  'institutional bounded affiliation-only, number-only enrichment, preserved document and deferred UID completion recipes',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    await t.test(
      'one affiliation then one number, exact original values and bounded journal phases',
      async () => {
        const actor = await f.actor(),
          first = await f.prepare(actor);
        const a = await f.authorize(
          actor,
          first.command.requestId,
          first.hash,
          await f.mint(actor.accountId, first.command.requestId, {
            studentNumber: null,
          }),
        );
        ok(a);
        assert.deepEqual(a.body.changedFacts, ['affiliation']);
        const second = await f.prepare(actor),
          n = await f.authorize(
            actor,
            second.command.requestId,
            second.hash,
            await f.mint(actor.accountId, second.command.requestId),
          );
        ok(n);
        assert.deepEqual(n.body.changedFacts, ['student_number']);
        assert.equal(n.body.uidOutcome, 'retained');
        const phases = (
          await f.pool.query(
            'SELECT count(st.*)::int phases FROM whaleu_verification.institutional_completions c JOIN whaleu_verification.school_identity_source_statements st ON st.cause_id=c.cause_id WHERE c.account_id=$1 GROUP BY c.id ORDER BY c.id',
            [actor.accountId],
          )
        ).rows;
        assert.deepEqual(
          phases.map((r) => r.phases),
          [3, 3],
        );
        const num = (
          await f.pool.query(
            "SELECT student_number FROM whaleu_verification.assertions WHERE account_id=$1 AND method='institutional_sso' AND fact_kind='student_number'",
            [actor.accountId],
          )
        ).rows[0];
        assert.equal(num.student_number, '00001234');
      },
    );
    await t.test(
      'covered imported absence is eligible for independently proven first linking',
      async () => {
        const actor = await f.actor();
        const absent = (kind: 'affiliation' | 'student_number') =>
          syntheticAssertion(actor.accountId, f.home.institutionId, kind, {
            assertion_state: 'unverified',
            issuer_institution_id: null,
            source_issuer_institution_id: null,
            origin_region_id: null,
            student_number: null,
            phone_binding_reference: null,
            verified_at: null,
            expiry_kind: 'policy_exempt',
            expires_at: null,
          });
        const affiliation = absent('affiliation'),
          number = absent('student_number');
        await inTransaction(f.pool, async (tx) => {
          await insertSyntheticAssertion(tx, affiliation);
          await insertSyntheticAssertion(tx, number);
        });
        await institutionalSyntheticTransition(f.pool, actor.accountId, {
          affiliation: affiliation.id,
          number: number.id,
        });
        const p = await f.prepare(actor),
          response = await f.authorize(
            actor,
            p.command.requestId,
            p.hash,
            await f.mint(actor.accountId, p.command.requestId),
          );
        ok(response);
        assert.deepEqual(response.body.changedFacts, [
          'affiliation',
          'student_number',
        ]);
        assert.equal(response.body.state, 'completed');
      },
    );
    await t.test(
      'genuine document affiliation is retained and is not rewritten or reapproved',
      async () => {
        const actor = await f.actor();
        await f.approve(f.admin, await f.submit(actor));
        const old = (
          await f.pool.query(
            'SELECT s.affiliation_assertion_id,s.application_state FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1',
            [actor.accountId],
          )
        ).rows[0];
        const p = await f.prepare(actor),
          response = await f.authorize(
            actor,
            p.command.requestId,
            p.hash,
            await f.mint(actor.accountId, p.command.requestId),
          );
        ok(response);
        assert.deepEqual(response.body.changedFacts, ['student_number']);
        assert.equal(response.body.uidOutcome, 'retained');
        const after = (
          await f.pool.query(
            'SELECT s.affiliation_assertion_id,s.application_state,a.method FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id JOIN whaleu_verification.assertions a ON a.id=s.affiliation_assertion_id WHERE h.account_id=$1',
            [actor.accountId],
          )
        ).rows[0];
        assert.equal(
          after.affiliation_assertion_id,
          old.affiliation_assertion_id,
        );
        assert.equal(after.method, 'document_review');
        assert.equal(after.application_state, old.application_state);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_verification.student_decisions WHERE account_id=$1',
              [actor.accountId],
            )
          ).rows[0].n,
          1,
        );
      },
    );
    await t.test(
      'deferred SSO source is completable by existing authorized complete_uid',
      async () => {
        const actor = await f.actor(),
          profile = await f.profile(actor),
          p = await f.prepare(actor, f.deferred.campusId);
        const response = await f.authorize(
          actor,
          p.command.requestId,
          p.hash,
          await f.mint(actor.accountId, p.command.requestId),
        );
        ok(response);
        assert.equal(response.body.state, 'completed');
        assert.equal(response.body.uidOutcome, 'deferred_unavailable');
        assert.equal(response.body.uidReason, 'inventory_unknown');
        const summary = await request(f.app.getHttpServer())
          .get('/v1/me/verification')
          .set('Authorization', `Bearer ${actor.accessToken}`);
        ok(summary);
        assert.equal(summary.body.affiliation.status, 'verified');
        assert.deepEqual(await f.own(actor), { status: 'unavailable' });
        await f.admit(f.deferred);
        const view = await f.management(f.admin, profile);
        assert.equal(view.actions.completeUid, true);
        const completed = await f.send(f.admin, {
          version: 1,
          action: 'complete_uid',
          clientRequestId: randomUUID(),
          targetProfileId: profile,
          expectedStateVersion: view.stateVersion,
        });
        ok(completed);
        assert.equal(completed.body.outcome, 'applied');
        assert.equal((await f.own(actor)).status, 'assigned');
        assert.equal(
          (await institutionalRows(f.pool, actor.accountId)).completions,
          1,
        );
      },
    );
  },
);

test(
  'institutional new cause defers unknown account history and rolls back cleanly at exhausted UID capacity',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const { IdentityRepository } =
        await import('../../src/identity/identity.repository.js'),
      { DatabaseService } = await import('../../src/database/database.js'),
      { APP_CONFIG } = await import('../../src/config/config.js'),
      { hashToken, mintToken } = await import('../../src/identity/tokens.js'),
      { setSyntheticSnapshot } =
        await import('../support/verification-fixtures.js');
    const subject = 'synthetic-missing-native-' + randomUUID(),
      identity = new IdentityRepository(f.app.get(DatabaseService), {
        ...f.app.get<RuntimeConfig>(APP_CONFIG),
        NATIVE_VERIFICATION_ENROLLMENT: 'disabled',
      });
    await identity.createSession(
      { provider: 'wechat', appId: 'wx0000000000000000', subject },
      {
        access: hashToken(mintToken('access')),
        refresh: hashToken(mintToken('refresh')),
      },
    );
    const historical = await f.actor(subject);
    const absent = (kind: 'affiliation' | 'student_number') =>
      syntheticAssertion(historical.accountId, f.home.institutionId, kind, {
        assertion_state: 'unverified',
        issuer_institution_id: null,
        source_issuer_institution_id: null,
        origin_region_id: null,
        student_number: null,
        phone_binding_reference: null,
        verified_at: null,
        expiry_kind: 'policy_exempt',
        expires_at: null,
      });
    await setSyntheticSnapshot(f.pool, historical.accountId, [
      absent('affiliation'),
      absent('student_number'),
    ]);
    const p = await f.prepare(historical),
      r = await f.authorize(
        historical,
        p.command.requestId,
        p.hash,
        await f.mint(historical.accountId, p.command.requestId),
      );
    ok(r);
    assert.equal(r.body.uidOutcome, 'deferred_unavailable');
    assert.equal(r.body.uidReason, 'account_history_unknown');
    assert.equal(
      (await institutionalRows(f.pool, historical.accountId)).causes,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_school_uid.allocations WHERE account_id=$1',
          [historical.accountId],
        )
      ).rows[0].n,
      0,
    );
    await f.admit(f.home, '9223372036854775807');
    const a = await f.actor(),
      q = await f.prepare(a),
      exhausted = await f.authorize(
        a,
        q.command.requestId,
        q.hash,
        await f.mint(a.accountId, q.command.requestId),
      );
    assert.equal(exhausted.status, 409);
    assert.equal(exhausted.body.error.code, 'SCHOOL_UID_EXHAUSTED');
    const rows = await institutionalRows(f.pool, a.accountId);
    assert.equal(rows.results, 1);
    assert.equal(rows.completions, 0);
    assert.equal(rows.causes, 0);
    assert.equal(rows.assertions, 0);
    const closed = await f.closeRequest(a, q.command.requestId, q.hash);
    ok(closed);
    assert.equal(closed.body.state, 'cancelled');
  },
);

test(
  'institutional existing allocation source mismatch cannot be disguised as deferred unavailable for a different unadmitted issuer',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const a = await f.actor();
    await f.approve(f.admin, await f.submit(a));
    const uid = await f.own(a);
    assert.equal(uid.status, 'assigned');
    // Explicit accepted reconciliation changes only the Verification affiliation;
    // it never rewrites the pre-existing school UID ownership graph.
    const imported = syntheticAssertion(
      a.accountId,
      f.deferred.institutionId,
      'affiliation',
      { origin_region_id: f.deferred.regionId },
    );
    await inTransaction(f.pool, (tx) => insertSyntheticAssertion(tx, imported));
    await institutionalSyntheticTransition(f.pool, a.accountId, {
      affiliation: imported.id,
    });
    const old = (
        await f.pool.query(
          'SELECT to_jsonb(h) h FROM whaleu_school_uid.account_heads h WHERE account_id=$1',
          [a.accountId],
        )
      ).rows[0].h,
      p = await f.prepare(a, f.deferred.campusId),
      result = await f.authorize(
        a,
        p.command.requestId,
        p.hash,
        await f.mint(a.accountId, p.command.requestId),
      );
    assert.equal(result.status, 503);
    assert.equal(result.body.error.code, 'INSTITUTIONAL_SSO_UNAVAILABLE');
    const rows = await institutionalRows(f.pool, a.accountId);
    assert.equal(rows.results, 1);
    assert.equal(rows.completions, 0);
    assert.equal(rows.causes, 0);
    assert.equal(rows.assertions, 0);
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT to_jsonb(h) h FROM whaleu_school_uid.account_heads h WHERE account_id=$1',
          [a.accountId],
        )
      ).rows[0].h,
      old,
    );
    ok(await f.closeRequest(a, p.command.requestId, p.hash));
  },
);
