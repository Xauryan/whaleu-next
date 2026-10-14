import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import {
  institutionalSsoFixture,
  institutionalRows,
} from '../support/institutional-sso-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { postApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import { PHONE_CONSENT } from '../../src/verification/phone-binding.service.js';
const ok = (r: { status: number; body: unknown }, status = 200) =>
  assert.equal(r.status, status, JSON.stringify(r.body));
type Fixture = Awaited<ReturnType<typeof institutionalSsoFixture>>;
type Actor = Awaited<ReturnType<Fixture['actor']>>;
function gate() {
  let arrived!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => (arrived = r)),
    wait = new Promise<void>((r) => (release = r));
  return {
    entered,
    release,
    run: async () => {
      arrived();
      await wait;
    },
  };
}
async function noIssue(f: Fixture, actor: Actor) {
  const rows = await institutionalRows(f.pool, actor.accountId);
  assert.equal(rows.results, 0);
  assert.equal(rows.completions, 0);
  assert.equal(rows.causes, 0);
  assert.equal(rows.assertions, 0);
}
async function authorizePhone(f: Fixture, actor: Actor) {
  const http = f.app.getHttpServer(),
    auth = `Bearer ${actor.accessToken}`,
    id = randomUUID();
  ok(
    await request(http)
      .post('/v1/me/phone-binding/requests')
      .set('Authorization', auth)
      .send({ requestId: id, consent: PHONE_CONSENT, replacesRequestId: null }),
  );
  ok(
    await request(http)
      .post(`/v1/me/phone-binding/requests/${id}/authorize`)
      .set('Authorization', auth)
      .send({
        code: 'synthetic-sso-admin-phone-' + randomUUID(),
        consent: PHONE_CONSENT,
      }),
  );
}
/** Real login/document/phone/identity/publication and causal removal. Only the
 * exact existing synthetic Review fixture supplies its accepted source envelope. */
async function punishmentSource(f: Fixture, actor: Actor) {
  const http = f.app.getHttpServer(),
    auth = `Bearer ${actor.accessToken}`;
  await f.profile(actor);
  await f.approve(f.admin, await f.submit(actor));
  const phone = randomUUID();
  ok(
    await request(http)
      .post('/v1/me/phone-binding/requests')
      .set('Authorization', auth)
      .send({
        requestId: phone,
        consent: PHONE_CONSENT,
        replacesRequestId: null,
      }),
  );
  ok(
    await request(http)
      .post(`/v1/me/phone-binding/requests/${phone}/authorize`)
      .set('Authorization', auth)
      .send({
        code: 'synthetic-sso-authority-' + randomUUID(),
        consent: PHONE_CONSENT,
      }),
  );
  const current = await request(http)
    .get('/v1/me/identity-campus')
    .set('Authorization', auth);
  ok(current);
  ok(
    await request(http)
      .put('/v1/me/identity-campus')
      .set('Authorization', auth)
      .send({
        requestId: randomUUID(),
        campusId: f.home.campusId,
        expectedStateRevision: current.body.expectedStateRevision,
      }),
  );
  const body = publishPostSchema.parse({
    clientRequestId: randomUUID(),
    spaceId: f.scope.home.spaceId,
    category: 'discussion',
    text: 'Synthetic SSO authority race source',
    imageAssetIds: [],
    authorMode: 'named',
    commentsPolicy: 'open',
  });
  await approveEnvelope(
    f.pool,
    await postApprovalEnvelope(f.app, f.pool, actor.accountId, body),
  );
  const post = await request(http)
    .post('/v1/community/posts')
    .set('Authorization', auth)
    .send(body);
  ok(post, 201);
  return { kind: 'post' as const, id: String(post.body.resourceId) };
}
async function punish(
  f: Fixture,
  target: Awaited<ReturnType<typeof punishmentSource>>,
  kind: 'interaction_mute' | 'access_suspension',
) {
  const http = f.app.getHttpServer(),
    auth = `Bearer ${f.admin.accessToken}`,
    view = await request(http)
      .get('/v1/community/admin-post-removal/management')
      .set('Authorization', auth)
      .query({ ...target, version: '2' });
  ok(view);
  const result = await request(http)
    .post('/v1/community/admin-post-removal/commands')
    .set('Authorization', auth)
    .send({
      version: 2,
      clientRequestId: randomUUID(),
      target,
      expectedTargetVersion: view.body.targetVersion,
      action: 'remove_post',
      punishment: {
        kind,
        duration: { kind: 'finite', unit: 'hours', value: 2 },
        reason: 'Synthetic SSO authority boundary',
        expectedRevision: '0',
      },
    });
  ok(result);
  assert.equal(result.body.outcome, 'applied');
  assert.ok(result.body.punishment.punishmentId);
}
test(
  'institutional private self-service preserves mute eligibility and enforces real suspension before claim, during provider and after admission',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    await seedReviewPolicy(f.pool);
    await authorizePhone(f, f.admin);
    await t.test(
      'interaction mute does not disable deliberate verification',
      async () => {
        const a = await f.actor(),
          source = await punishmentSource(f, a);
        await punish(f, source, 'interaction_mute');
        const p = await f.prepare(a);
        const r = await f.authorize(
          a,
          p.command.requestId,
          p.hash,
          await f.mint(a.accountId, p.command.requestId),
        );
        ok(r);
        assert.equal(r.body.state, 'completed');
      },
    );
    for (const phase of [
      'before-claim',
      'provider-gap',
      'after-admission',
    ] as const)
      await t.test(`access suspension ${phase}`, async () => {
        const a = await f.actor(),
          source = await punishmentSource(f, a),
          p = await f.prepare(a),
          opaque = await f.mint(a.accountId, p.command.requestId),
          before = f.transport.calls;
        if (phase === 'before-claim') {
          await punish(f, source, 'access_suspension');
          const r = await f.authorize(a, p.command.requestId, p.hash, opaque);
          assert.equal(r.status, 403);
          assert.equal(f.transport.calls, before);
          await noIssue(f, a);
        } else if (phase === 'provider-gap') {
          const b = gate();
          f.transport.beforeReturn = b.run;
          const pending = f
            .authorize(a, p.command.requestId, p.hash, opaque)
            .then((r) => r);
          await b.entered;
          try {
            await punish(f, source, 'access_suspension');
          } finally {
            b.release();
          }
          const r = await pending;
          assert.equal(r.status, 403);
          f.transport.beforeReturn = null;
          await noIssue(f, a);
        } else {
          await f.pool.query(
            "CREATE FUNCTION whaleu_verification.synthetic_sso_authority_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic pre-finalization interruption'; END $$; CREATE TRIGGER a_synthetic_sso_authority_failure BEFORE INSERT ON whaleu_verification.institutional_completions FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_sso_authority_failure()",
          );
          assert.equal(
            (await f.authorize(a, p.command.requestId, p.hash, opaque)).status,
            503,
          );
          await f.pool.query(
            'DROP TRIGGER a_synthetic_sso_authority_failure ON whaleu_verification.institutional_completions; DROP FUNCTION whaleu_verification.synthetic_sso_authority_failure()',
          );
          assert.equal(
            (await institutionalRows(f.pool, a.accountId)).results,
            1,
          );
          await punish(f, source, 'access_suspension');
          assert.equal(
            (await f.recover(a, p.command.requestId, p.hash)).status,
            403,
          );
          const rows = await institutionalRows(f.pool, a.accountId);
          assert.equal(rows.completions, 0);
          assert.equal(rows.causes, 0);
          assert.equal(rows.assertions, 0);
        }
        ok(await f.read(a, p.command.requestId));
        const closed = await f.closeRequest(a, p.command.requestId, p.hash);
        ok(closed);
        assert.equal(closed.body.state, 'cancelled');
        assert.equal(
          f.transport.calls,
          before + (phase === 'before-claim' ? 0 : 1),
        );
      });
  },
);
test(
  'institutional provider gap rechecks original session, base account and accepted institution/provider mappings',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    for (const change of [
      'logout',
      'blocked-account',
      'binding-revision',
      'binding-disabled',
      'campus-institution',
      'campus-inactive',
      'region-assignment',
    ] as const)
      await t.test(change, async (sub) => {
        sub.after(async () => {
          await withCommunityScopeWriter(f.pool, async (tx) => {
            await tx.query(
              'UPDATE whaleu_campus.campuses SET institution_id=$2,is_active=true WHERE id=$1',
              [f.home.campusId, f.home.institutionId],
            );
            await tx.query(
              'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=$2 WHERE campus_id=$1',
              [f.home.campusId, f.home.regionId],
            );
          });
          await f.install();
        });
        const code = randomUUID(),
          a = await f.actor(code),
          p = await f.prepare(a),
          opaque = await f.mint(a.accountId, p.command.requestId),
          b = gate();
        f.transport.beforeReturn = b.run;
        const pending = f
          .authorize(a, p.command.requestId, p.hash, opaque)
          .then((r) => r);
        await b.entered;
        try {
          if (change === 'logout')
            ok(
              await request(f.app.getHttpServer())
                .post('/v1/auth/logout')
                .set('Authorization', `Bearer ${a.accessToken}`)
                .send({}),
              204,
            );
          else if (change === 'blocked-account')
            await f.pool.query(
              "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
              [a.accountId],
            );
          else if (
            change === 'binding-revision' ||
            change === 'binding-disabled'
          )
            await f.install(f.home, change !== 'binding-disabled');
          else
            await withCommunityScopeWriter(f.pool, (tx) =>
              change === 'campus-institution'
                ? tx.query(
                    'UPDATE whaleu_campus.campuses SET institution_id=$2 WHERE id=$1',
                    [f.home.campusId, f.destination.institutionId],
                  )
                : change === 'campus-inactive'
                  ? tx.query(
                      'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
                      [f.home.campusId],
                    )
                  : tx.query(
                      'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=$2 WHERE campus_id=$1',
                      [f.home.campusId, f.destination.regionId],
                    ),
            );
        } finally {
          b.release();
        }
        const result = await pending;
        f.transport.beforeReturn = null;
        await noIssue(f, a);
        if (change === 'logout' || change === 'blocked-account') {
          const denied = change === 'blocked-account' ? 403 : 401;
          assert.equal(result.status, denied);
          assert.equal((await f.read(a, p.command.requestId)).status, denied);
          assert.equal(
            (await f.closeRequest(a, p.command.requestId, p.hash)).status,
            denied,
          );
          if (change === 'blocked-account')
            await f.pool.query(
              "UPDATE whaleu_identity.accounts SET status='active' WHERE id=$1",
              [a.accountId],
            );
          const replacement = await f.actor(code);
          assert.equal(replacement.accountId, a.accountId);
          ok(await f.read(replacement, p.command.requestId));
          const closed = await f.closeRequest(
            replacement,
            p.command.requestId,
            p.hash,
          );
          ok(closed);
          assert.equal(closed.body.state, 'cancelled');
        } else if (change === 'campus-inactive') {
          assert.equal(result.status, 409);
          assert.equal(result.body.error.code, 'COMMUNITY_SCOPE_UNAVAILABLE');
        } else {
          ok(result);
          assert.ok(
            ['stale', 'provider_unavailable'].includes(result.body.state),
            JSON.stringify(result.body),
          );
        }
        // Restore via ordinary source writes/new immutable binding revision, never
        // restore an old request witness. Every next case creates a deliberate key.
        await withCommunityScopeWriter(f.pool, async (tx) => {
          await tx.query(
            'UPDATE whaleu_campus.campuses SET institution_id=$2,is_active=true WHERE id=$1',
            [f.home.campusId, f.home.institutionId],
          );
          await tx.query(
            'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=$2 WHERE campus_id=$1',
            [f.home.campusId, f.home.regionId],
          );
        });
        await f.install();
      });
  },
);

test(
  'institutional final deferred closure rejects a pending session revocation and a committed binding revision',
  { timeout: 240000 },
  async (t) => {
    const f = await institutionalSsoFixture();
    t.after(() => f.close());
    const key = 793146;
    await f.pool.query(
      `CREATE FUNCTION whaleu_verification.synthetic_sso_final_authority_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${key}); RETURN NULL; END $$; CREATE CONSTRAINT TRIGGER a_synthetic_sso_final_authority_wait AFTER INSERT ON whaleu_verification.school_identity_source_observations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_sso_final_authority_wait()`,
    );
    for (const change of ['logout', 'binding'] as const)
      await t.test(change, async () => {
        const code = randomUUID(),
          a = await f.actor(code),
          p = await f.prepare(a),
          opaque = await f.mint(a.accountId, p.command.requestId),
          block = await f.pool.connect();
        await block.query('BEGIN');
        await block.query('SELECT pg_advisory_xact_lock($1)', [key]);
        const pending = f
          .authorize(a, p.command.requestId, p.hash, opaque)
          .then((r) => r);
        let logout: Promise<{ status: number; body: unknown }> | undefined;
        try {
          await f.waitForLock('SET CONSTRAINTS ALL IMMEDIATE');
          if (change === 'logout') {
            logout = request(f.app.getHttpServer())
              .post('/v1/auth/logout')
              .set('Authorization', `Bearer ${a.accessToken}`)
              .send({})
              .then((r) => r);
            await f.waitForLock('UPDATE whaleu_identity.sessions');
            assert.equal(
              (
                await f.pool.query(
                  'SELECT revoked_at IS NULL pending FROM whaleu_identity.sessions WHERE id=$1',
                  [a.sessionId],
                )
              ).rows[0].pending,
              true,
            );
          } else {
            const old = (
              await f.pool.query(
                'SELECT binding_id FROM whaleu_verification.institutional_binding_heads WHERE campus_id=$1',
                [f.home.campusId],
              )
            ).rows[0].binding_id;
            await f.install();
            assert.notEqual(
              (
                await f.pool.query(
                  'SELECT binding_id FROM whaleu_verification.institutional_binding_heads WHERE campus_id=$1',
                  [f.home.campusId],
                )
              ).rows[0].binding_id,
              old,
            );
          }
        } finally {
          try {
            await block.query('ROLLBACK');
          } finally {
            block.release();
          }
        }
        assert.equal((await pending).status, 503);
        if (logout) ok(await logout, 204);
        const rows = await institutionalRows(f.pool, a.accountId);
        assert.equal(rows.results, 1);
        assert.equal(rows.completions, 0);
        assert.equal(rows.causes, 0);
        assert.equal(rows.assertions, 0);
        if (change === 'logout') {
          const replacement = await f.actor(code);
          assert.equal(
            (await f.recover(replacement, p.command.requestId, p.hash)).status,
            409,
          );
          ok(await f.closeRequest(replacement, p.command.requestId, p.hash));
        } else {
          const stale = await f.recover(a, p.command.requestId, p.hash);
          ok(stale);
          assert.equal(stale.body.state, 'stale');
        }
      });
    await f.pool.query(
      'DROP TRIGGER a_synthetic_sso_final_authority_wait ON whaleu_verification.school_identity_source_observations; DROP FUNCTION whaleu_verification.synthetic_sso_final_authority_wait()',
    );
    assert.equal(f.transport.calls, 2);
  },
);
