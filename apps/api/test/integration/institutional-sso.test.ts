import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import {
  institutionalSsoFixture,
  institutionalRows,
} from '../support/institutional-sso-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { revokeAssertion } from '../../src/verification/revocation.js';
import {
  institutionalRequestHash,
  INSTITUTIONAL_CONSENT,
} from '../../src/verification/institutional/contracts.js';
const ok = (response: { status: number; body: unknown }) =>
  assert.equal(response.status, 200, JSON.stringify(response.body));
test(
  'institutional synthetic admission, independent facts, UID, replay and both exact revocations',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      p = await f.prepare(actor),
      opaque = await f.mint(actor.accountId, p.command.requestId);
    const success = await f.authorize(
      actor,
      p.command.requestId,
      p.hash,
      opaque,
    );
    ok(success);
    assert.deepEqual(success.body, {
      requestId: p.command.requestId,
      requestHash: p.hash,
      state: 'completed',
      changedFacts: ['affiliation', 'student_number'],
      uidOutcome: 'issued',
      uidReason: null,
    });
    assert.equal(f.transport.calls, 1);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_verification.school_identity_source_statements s JOIN whaleu_school_uid.producing_causes c ON c.id=s.cause_id WHERE c.account_id=$1',
          [actor.accountId],
        )
      ).rows[0].n,
      4,
    );
    assert.deepEqual(await institutionalRows(f.pool, actor.accountId), {
      requests: 1,
      results: 1,
      completions: 1,
      causes: 1,
      assertions: 2,
    });
    const summary = await request(f.app.getHttpServer())
      .get('/v1/me/verification')
      .set('Authorization', `Bearer ${actor.accessToken}`);
    ok(summary);
    assert.equal(summary.body.affiliation.status, 'verified');
    assert.equal(summary.body.studentNumber.status, 'verified');
    assert.equal(summary.body.phone.status, 'unverified');
    const uid = await request(f.app.getHttpServer())
      .get('/v1/me/school-uid')
      .set('Authorization', `Bearer ${actor.accessToken}`);
    ok(uid);
    assert.ok(!JSON.stringify(uid.body).includes('00001234'));
    assert.deepEqual(
      (
        await f.authorize(
          actor,
          p.command.requestId,
          p.hash,
          'unused-synthetic-response',
        )
      ).body,
      success.body,
    );
    assert.deepEqual(
      (await f.closeRequest(actor, p.command.requestId, p.hash)).body,
      success.body,
    );
    assert.equal(f.transport.calls, 1);
    const retained = await f.prepare(actor);
    const again = await f.authorize(
      actor,
      retained.command.requestId,
      retained.hash,
      await f.mint(actor.accountId, retained.command.requestId),
    );
    ok(again);
    assert.equal(again.body.uidOutcome, 'retained');
    assert.deepEqual(again.body.changedFacts, []);
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT count(st.*)::int n FROM whaleu_verification.institutional_completions c JOIN whaleu_verification.school_identity_source_statements st ON st.cause_id=c.cause_id WHERE c.account_id=$1 GROUP BY c.id ORDER BY n',
          [actor.accountId],
        )
      ).rows.map((r) => r.n),
      [2, 4],
    );
    for (const fact of ['student_number', 'affiliation'] as const) {
      const before = (
        await f.pool.query(
          'SELECT to_jsonb(s) snapshot FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1',
          [actor.accountId],
        )
      ).rows[0].snapshot;
      await inTransaction(f.pool, (tx) =>
        revokeAssertion(tx, {
          accountId: actor.accountId,
          actorAccountId: actor.accountId,
          operationId: randomUUID(),
          fact,
          expectedRevision: before.revision,
          reasonCode: 'synthetic_authorized_revocation',
        }),
      );
      const after = (
        await f.pool.query(
          'SELECT to_jsonb(s) snapshot FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id WHERE h.account_id=$1',
          [actor.accountId],
        )
      ).rows[0].snapshot;
      assert.equal(after.phone_assertion_id, before.phone_assertion_id);
      assert.equal(
        after[
          fact === 'affiliation'
            ? 'student_number_assertion_id'
            : 'affiliation_assertion_id'
        ],
        before[
          fact === 'affiliation'
            ? 'student_number_assertion_id'
            : 'affiliation_assertion_id'
        ],
      );
      const rows = await institutionalRows(f.pool, actor.accountId);
      assert.equal(rows.causes, 2);
      assert.equal(rows.completions, 2);
    }
    const revoked = await request(f.app.getHttpServer())
      .get('/v1/me/verification')
      .set('Authorization', `Bearer ${actor.accessToken}`);
    ok(revoked);
    assert.equal(revoked.body.affiliation.status, 'revoked');
    assert.equal(revoked.body.studentNumber.status, 'revoked');
  },
);
test(
  'institutional original-key cancel fence, active cross-device uniqueness and strict opaque input',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      cap = await f.capability(actor);
    ok(cap);
    const command = {
        requestId: randomUUID(),
        campusId: f.home.campusId,
        capabilityVersion: cap.body.capabilityVersion as string,
        consent: INSTITUTIONAL_CONSENT,
      },
      hash = institutionalRequestHash(actor.accountId, command);
    const cancelled = await f.closeRequest(actor, command.requestId, hash);
    ok(cancelled);
    assert.equal(cancelled.body.state, 'cancelled');
    const late = await request(f.app.getHttpServer())
      .post('/v1/me/institutional-sso/requests')
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send(command);
    ok(late);
    assert.deepEqual(late.body, cancelled.body);
    assert.equal(f.transport.calls, 0);
    const p = await f.prepare(actor);
    const changed = await request(f.app.getHttpServer())
      .post('/v1/me/institutional-sso/requests')
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send({ ...p.command, requestId: randomUUID() });
    assert.equal(changed.status, 409);
    const extra = await request(f.app.getHttpServer())
      .post(`/v1/me/institutional-sso/requests/${p.command.requestId}/complete`)
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send({
        mode: 'authorize',
        requestHash: p.hash,
        authorizationResponse: 'untrusted',
        verified: true,
      });
    assert.equal(extra.status, 400);
    assert.equal(f.transport.calls, 0);
    const other = await f.actor();
    assert.equal(
      (await f.read(other, p.command.requestId)).body.state,
      'not_recorded',
    );
    ok(await f.closeRequest(actor, p.command.requestId, p.hash));
  },
);

test(
  'institutional default binding stays unavailable and terminal session cleanup preserves receipts',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const actor = await f.actor('synthetic-sso-retention'),
      plain = await f.actor(),
      p = await f.prepare(actor);
    const result = await f.authorize(
      actor,
      p.command.requestId,
      p.hash,
      await f.mint(actor.accountId, p.command.requestId),
    );
    ok(result);
    assert.equal(result.body.state, 'completed');
    const { IdentityService } =
        await import('../../src/identity/identity.service.js'),
      { IdentityMaintenance } =
        await import('../../src/identity/maintenance.js'),
      { DatabaseService } = await import('../../src/database/database.js');
    const before = (
      await f.pool.query(
        'SELECT to_jsonb(q) row FROM whaleu_verification.institutional_requests q WHERE account_id=$1',
        [actor.accountId],
      )
    ).rows[0].row;
    for (const owner of [actor, plain]) {
      await f.app.get(IdentityService).logout(owner.accessToken);
      await f.pool.query(
        "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp()-interval '40 days' WHERE id=$1",
        [owner.sessionId],
      );
    }
    const cleanup = await new IdentityMaintenance(
      f.app.get(DatabaseService),
    ).run({ mode: 'apply', retentionDays: 30, batchSize: 100 });
    assert.equal(cleanup.sessions, 2);
    const after = (
      await f.pool.query(
        'SELECT to_jsonb(q) row FROM whaleu_verification.institutional_requests q WHERE account_id=$1',
        [actor.accountId],
      )
    ).rows[0].row;
    assert.deepEqual(after, before);
    const replacement = await f.actor('synthetic-sso-retention');
    const recovered = await f.read(replacement, p.command.requestId);
    ok(recovered);
    assert.deepEqual(recovered.body, result.body);
    const unconfigured = await f.capability(
      replacement,
      f.destination.campusId,
    );
    ok(unconfigured);
    assert.equal(unconfigured.body.state, 'provider_unconfigured');
    assert.deepEqual(unconfigured.body.supportedFacts, []);
  },
);

test(
  'institutional production-default unavailable provider ignores configured synthetic adapter',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture({ defaultProvider: true });
    t.after(() => f.close());
    const actor = await f.actor(),
      cap = await f.capability(actor);
    ok(cap);
    assert.equal(cap.body.state, 'provider_unavailable');
    assert.equal(f.transport.calls, 0);
    const response = await request(f.app.getHttpServer())
      .post('/v1/me/institutional-sso/requests')
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send({
        requestId: randomUUID(),
        campusId: f.home.campusId,
        capabilityVersion: '1'.repeat(64),
        consent: INSTITUTIONAL_CONSENT,
      });
    assert.equal(response.status, 503);
    assert.equal(f.transport.calls, 0);
    assert.equal(
      (await institutionalRows(f.pool, actor.accountId)).requests,
      0,
    );
  },
);

test(
  'institutional actual HTTP JSON has one decoded interpretation, rejects raw claims/content types and bounds bytes',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      p = await f.prepare(actor),
      http = f.app.getHttpServer(),
      path = `/v1/me/institutional-sso/requests/${p.command.requestId}/complete`,
      auth = `Bearer ${actor.accessToken}`;
    const form = await request(http)
      .post(path)
      .set('Authorization', auth)
      .type('form')
      .send({
        mode: 'authorize',
        requestHash: p.hash,
        authorizationResponse: 'synthetic-unused',
      });
    assert.equal(form.status, 400);
    const oversized = await request(http)
      .post(path)
      .set('Authorization', auth)
      .send({
        mode: 'authorize',
        requestHash: p.hash,
        authorizationResponse: 'x'.repeat(70000),
      });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers['cache-control'], 'no-store');
    assert.ok(String(oversized.headers['vary']).includes('Authorization'));
    assert.equal(f.transport.calls, 0);
    const raw = `{"mode":"authorize","mode":"recover","requestHash":"${p.hash}"}`;
    const decoded = await request(http)
      .post(path)
      .set('Authorization', auth)
      .set('Content-Type', 'application/json')
      .send(raw);
    ok(decoded);
    assert.equal(decoded.body.state, 'prepared');
    assert.equal(f.transport.calls, 0);
    const staff = await f.authorize(
      actor,
      p.command.requestId,
      p.hash,
      await f.mint(actor.accountId, p.command.requestId, {
        eligibleStudent: false,
      }),
    );
    ok(staff);
    assert.equal(staff.body.state, 'rejected');
    assert.equal((await institutionalRows(f.pool, actor.accountId)).results, 0);
  },
);
