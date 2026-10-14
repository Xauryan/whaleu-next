import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  ratingAssistanceFixture,
  SyntheticRatingAssistance,
} from '../support/rating-assistance-fixture.js';
import {
  assistanceIntentHash,
  assistanceInputDigest,
  ASSISTANCE_PROFILE,
  assistanceRequestSchema,
  assistanceResultSchema,
  validAssistanceOutput,
} from '../../src/ratings/assistance/contracts.js';
import { postApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { mintToken, hashToken } from '../../src/identity/tokens.js';
import { RatingAssistanceService } from '../../src/ratings/assistance/service.js';
import { ratingCategoryScopedIntentSchema } from '../../src/ratings/category-management/scoped-contracts.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingAssistanceRepository } from '../../src/ratings/assistance/repository.js';
import { RatingAssistanceQualification } from '../../src/ratings/assistance/qualification.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
const prefix = '/v2/ratings/assistance/requests';
type Fixture = Awaited<ReturnType<typeof ratingAssistanceFixture>>;
type Actor = Fixture['admin'];
async function draft(f: Fixture, actor: Actor = f.admin) {
  const context = await f.managementContext(actor);
  return assistanceRequestSchema.parse({
    version: 1,
    requestId: randomUUID(),
    draftId: randomUUID(),
    inputRevision: 0,
    selector: context.commandContext.selector,
    context: context.commandContext,
    purpose: 'category_description',
    payload: {
      operation: 'create_categories_scoped',
      parentId: null,
      draftNodeKey: 'root',
      name: `课程体验${actor.accountId.slice(0, 8)}`,
      placement: { kind: 'campuses', campusIds: [f.campusA] },
      expectedSnapshot: context.snapshotRevision,
    },
  });
}
const post = (f: Fixture, actor: Actor, body: object) =>
  f.auth(request(f.http).post(prefix), actor).send(body);
const get = (f: Fixture, actor: Actor, id: string, suffix = '') =>
  f.auth(request(f.http).get(`${prefix}/${id}${suffix}`), actor);
const cancel = (
  f: Fixture,
  actor: Actor,
  body: ReturnType<typeof assistanceRequestSchema.parse>,
) =>
  f
    .auth(request(f.http).post(`${prefix}/${body.requestId}/cancel`), actor)
    .send({ purpose: body.purpose, intentHash: assistanceIntentHash(body) });
async function newAdmin(f: Fixture) {
  const actor = await f.actor();
  await f.grant(actor, 'super_admin');
  return actor;
}

test(
  'rating assistance default AppModule disabled, private recovery and absent-create fence',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingAssistanceFixture();
    t.after(() => f.close());
    const body = await draft(f),
      response = await post(f, f.admin, body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.outcome, 'unavailable');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.headers['vary'] ?? '', /Authorization/i);
    assert.equal(
      (await f.pool.query('SELECT * FROM whaleu_ratings.assistance_requests'))
        .rowCount,
      0,
    );
    assert.equal(
      (await get(f, f.admin, body.requestId, '/result')).body.status,
      'unavailable',
    );
    assert.deepEqual((await post(f, f.admin, body)).body, response.body);
    const absent = await draft(f);
    assert.equal((await cancel(f, f.admin, absent)).body.outcome, 'cancelled');
    assert.equal((await post(f, f.admin, absent)).body.outcome, 'cancelled');
    const stranger = await f.actor();
    assert.equal((await get(f, stranger, body.requestId)).status, 404);
    assert.equal(
      (await post(f, f.admin, { ...body, inputRevision: 1 })).status,
      409,
    );
    const unauth = await request(f.http).post(prefix).send(body);
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers['vary'] ?? '', /Authorization/i);
    const invalid = await request(f.http)
      .post(prefix)
      .set('Content-Type', 'application/json')
      .send('{');
    assert.equal(invalid.status, 400);
    assert.match(invalid.headers['vary'] ?? '', /Authorization/i);
    assert.equal(
      (await get(f, f.admin, body.requestId).send({ unexpected: true })).status,
      400,
    );
  },
);

test(
  'rating assistance real HTTP generation, exact Review publication independence, quotas and cancellation races',
  { timeout: 240000 },
  async (t) => {
    const runtime = new SyntheticRatingAssistance(),
      f = await ratingAssistanceFixture(runtime);
    t.after(() => f.close());
    t.beforeEach(() => {
      runtime.beforeReady = null;
      runtime.action = 'allow';
    });
    await t.test(
      'one exact private result, same-key replay and final field publication stays separate',
      async () => {
        const body = await draft(f),
          before = await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_ratings.scoped_command_outcomes',
          );
        const response = await post(f, f.admin, body);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.outcome, 'generated');
        assert.equal(runtime.sends.length, 1);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.scoped_command_outcomes',
            )
          ).rows[0].n,
          before.rows[0].n,
        );
        const preview = assistanceResultSchema.parse(
          (await get(f, f.admin, body.requestId, '/result')).body,
        );
        assert.equal(preview.status, 'available');
        if (preview.status !== 'available') throw Error('Result missing');
        assert.equal(preview.text, '共同分享真实课程体验');
        assert.deepEqual(Object.keys(runtime.sends[0]!.input).sort(), [
          'context',
          'name',
        ]);
        assert.deepEqual((await post(f, f.admin, body)).body, response.body);
        assert.equal(runtime.sends.length, 1);
        assert.deepEqual((await cancel(f, f.admin, body)).body, response.body);
        assert.equal(
          (await get(f, f.admin, body.requestId, '/result')).body.status,
          'unavailable',
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.assistance_payloads WHERE account_id=$1 AND request_id=$2',
              [f.admin.accountId, body.requestId],
            )
          ).rowCount,
          0,
        );
        const current = await f.managementContext(f.admin);
        const intent = f.managementIntent(current, 'create_categories_scoped', {
          parentId: null,
          placement: { kind: 'campuses', campusIds: [f.campusA] },
          nodes: [
            {
              key: 'root',
              parentKey: null,
              name: runtime.sends[0]!.input.name,
              description: preview.text,
            },
          ],
        });
        const preparation = await f.prepareManagement(f.admin, intent);
        // Existing exact Review owner is still required; assistance is no approval.
        const missing = await f.commitManagement(
          f.admin,
          intent,
          preparation.contextRevision,
        );
        assert.ok(missing.status >= 400 || missing.body.outcome === 'closed');
        const finalIntent = ratingCategoryScopedIntentSchema.parse({
          ...intent,
          payload: { ...intent.payload, clientRequestId: randomUUID() },
        });
        const finalPrepared = await f.prepareManagement(f.admin, finalIntent);
        await f.approveManagement(f.admin, finalIntent);
        const committed = await f.commitManagement(
          f.admin,
          finalIntent,
          finalPrepared.contextRevision,
        );
        assert.equal(
          committed.body.outcome,
          'applied',
          JSON.stringify(committed.body),
        );
      },
    );
    await t.test(
      'SQL and application literal validators agree on Unicode punctuation and control boundaries',
      async () => {
        for (const purpose of [
          'category_description',
          'rating_publish_title',
        ] as const) {
          for (const text of [
            '共同分享真实课程体验',
            '共同分享真实课程体验。',
            '共同分享真实课程体★',
            '共同分享真实课程体𑁇',
            '这门课程怎么样？',
            '怎么样?',
            '怎么样？ ',
            '\t怎么样？',
            '共同分享真实课\u0085程',
            '共同分享真实课\u2028程',
            '“共同分享真实课程体验”',
            '<课程体验好吗？>',
            'a://b好吗？',
            '😀😀😀😀😀😀😀😀😀',
            '😀😀😀😀😀😀😀😀😀😀😀😀？',
          ]) {
            const row = await f.pool.query<{ valid: boolean }>(
              'SELECT whaleu_ratings.assistance_result_literal($1,$2) AS valid',
              [purpose, text],
            );
            assert.equal(
              row.rows[0]!.valid,
              validAssistanceOutput(purpose, text),
              `${purpose}:${JSON.stringify(text)}`,
            );
          }
        }
      },
    );
    await t.test(
      'fresh generation independently rechecks phone and all affected campuses',
      async () => {
        for (const phone of ['unverified', 'unavailable'] as const) {
          const actor = await newAdmin(f),
            body = await draft(f, actor);
          await f.certify(actor.accountId, { phone });
          const before = runtime.sends.length,
            response = await post(f, actor, body);
          assert.notEqual(response.status, 200);
          assert.equal(runtime.sends.length, before);
          assert.equal(
            (
              await f.pool.query(
                'SELECT * FROM whaleu_ratings.assistance_claims WHERE account_id=$1 AND request_id=$2',
                [actor.accountId, body.requestId],
              )
            ).rowCount,
            0,
          );
        }
        const limited = await f.actor();
        await f.exactCategoryGrant(limited, f.campusA);
        const body = await draft(f, limited);
        assert.equal(body.purpose, 'category_description');
        if (body.purpose !== 'category_description')
          throw Error('Wrong fixture purpose');
        const overbroad = {
          ...body,
          payload: {
            ...body.payload,
            placement: {
              kind: 'campuses',
              campusIds: [f.campusA, f.campusB].sort(),
            },
          },
        };
        const before = runtime.sends.length,
          response = await post(f, limited, overbroad);
        assert.notEqual(response.status, 200);
        assert.equal(runtime.sends.length, before);
      },
    );
    await t.test(
      'account generation quotas are durable across keys, recovery does not reserve',
      async () => {
        const actor = await newAdmin(f),
          a = await draft(f, actor),
          b = { ...a, requestId: randomUUID(), draftId: randomUUID() };
        const first = await post(f, actor, a);
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.equal(first.body.outcome, 'generated');
        const second = await post(f, actor, b);
        assert.equal(second.status, 200, JSON.stringify(second.body));
        assert.equal(second.body.outcome, 'generated');
        const third = await post(f, actor, {
          ...a,
          requestId: randomUUID(),
          draftId: randomUUID(),
        });
        assert.equal(third.status, 429, JSON.stringify(third.body));
        assert.equal(third.headers['retry-after'], '60');
        assert.equal((await get(f, actor, a.requestId)).status, 200);
        assert.equal((await cancel(f, actor, a)).status, 200);
      },
    );
    await t.test(
      'independent HTTP admissions share the active quota and duplicate key never double reserves',
      async () => {
        const actor = await newAdmin(f),
          body = await draft(f, actor);
        let release!: () => void, ready!: () => void;
        const waiting = new Promise<void>((resolve) => {
          ready = resolve;
        });
        runtime.beforeReady = async () => {
          ready();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        };
        const before = runtime.sends.length;
        const first = post(f, actor, body).then((response) => response);
        await Promise.race([
          waiting,
          first.then((response) =>
            assert.fail(
              `Admission ended before readiness: ${response.status} ${JSON.stringify(response.body)}`,
            ),
          ),
        ]);
        const duplicate = await post(f, actor, body);
        assert.equal(duplicate.body.outcome, 'claimed');
        const competitor = await post(f, actor, {
          ...body,
          requestId: randomUUID(),
        });
        assert.equal(competitor.status, 429);
        const count = await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.assistance_requests WHERE account_id=$1',
          [actor.accountId],
        );
        assert.equal(count.rows[0].n, 1);
        assert.equal(runtime.sends.length, before);
        release();
        assert.equal((await first).body.outcome, 'generated');
        runtime.beforeReady = null;
        assert.equal(runtime.sends.length, before + 1);
      },
    );
    await t.test(
      'cancel while synthetic readiness waits prevents effect and preserves original fence',
      async () => {
        const actor = await newAdmin(f),
          body = await draft(f, actor);
        let release!: () => void, ready!: () => void;
        const waiting = new Promise<void>((r) => {
          ready = r;
        });
        runtime.beforeReady = async () => {
          ready();
          await new Promise<void>((r) => {
            release = r;
          });
        };
        const before = runtime.sends.length;
        const sending = post(f, actor, body).then((r) => r);
        await Promise.race([
          waiting,
          sending.then((response) =>
            assert.fail(
              `Admission ended before readiness: ${response.status} ${JSON.stringify(response.body)}`,
            ),
          ),
        ]);
        assert.equal((await cancel(f, actor, body)).body.outcome, 'cancelled');
        release();
        const response = await sending;
        runtime.beforeReady = null;
        assert.equal(response.body.outcome, 'cancelled');
        assert.equal(runtime.sends.length, before);
        assert.equal(
          (await get(f, actor, body.requestId, '/result')).body.status,
          'unavailable',
        );
      },
    );
    await t.test(
      'actual removal-issued mute and suspension deny generation and plaintext with exact existing recovery classification',
      async () => {
        await seedReviewPolicy(f.pool);
        for (const kind of ['interaction_mute', 'access_suspension'] as const) {
          const actor = await f.actor();
          await f.exactCategoryGrant(actor, f.campusA);
          const sourceBody = publishPostSchema.parse({
            clientRequestId: randomUUID(),
            spaceId: f.scope.home.spaceId,
            category: 'discussion',
            text: 'Actual Safety source for assistance boundary',
            authorMode: 'named',
            commentsPolicy: 'open',
            imageAssetIds: [],
          });
          await approveEnvelope(
            f.pool,
            await postApprovalEnvelope(
              f.app,
              f.pool,
              actor.accountId,
              sourceBody,
            ),
          );
          const published = await f
            .auth(request(f.http).post('/v1/community/posts'), actor)
            .send(sourceBody);
          assert.equal(
            published.body.outcome,
            'created',
            JSON.stringify(published.body),
          );
          const body = await draft(f, actor);
          assert.equal((await post(f, actor, body)).body.outcome, 'generated');
          const view = await f
            .auth(
              request(f.http).get(
                '/v1/community/admin-post-removal/management',
              ),
              f.admin,
            )
            .query({ kind: 'post', id: published.body.resourceId });
          assert.equal(view.status, 200, JSON.stringify(view.body));
          const applied = await f
            .auth(
              request(f.http).post('/v1/community/admin-post-removal/commands'),
              f.admin,
            )
            .send({
              version: 2,
              clientRequestId: randomUUID(),
              target: { kind: 'post', id: published.body.resourceId },
              expectedTargetVersion: view.body.targetVersion,
              action: 'remove_post',
              punishment: {
                kind,
                duration: { kind: 'finite', unit: 'hours', value: 2 },
                reason: 'Explicit disposable assistance Safety regression',
                expectedRevision: '0',
              },
            });
          assert.equal(
            applied.body.outcome,
            'applied',
            JSON.stringify(applied.body),
          );
          const sends = runtime.sends.length;
          const snapshot = async () =>
            (
              await f.pool.query(
                `SELECT (SELECT count(*)::int FROM whaleu_ratings.assistance_requests) requests,(SELECT count(*)::int FROM whaleu_ratings.assistance_jobs) jobs,(SELECT count(*)::int FROM whaleu_ratings.assistance_results) results`,
              )
            ).rows[0];
          const before = await snapshot();
          const code =
            kind === 'interaction_mute'
              ? 'SAFETY_ACTION_RESTRICTED'
              : 'SAFETY_ACCESS_SUSPENDED';
          for (const response of [
            await post(f, actor, { ...body, requestId: randomUUID() }),
            await get(f, actor, body.requestId, '/result'),
          ]) {
            assert.equal(response.status, 403, JSON.stringify(response.body));
            assert.equal(response.body.error.code, code);
            assert.ok(!JSON.stringify(response.body).includes('共同分享'));
          }
          assert.equal(runtime.sends.length, sends);
          assert.deepEqual(await snapshot(), before);
          for (const recovery of [
            await get(f, actor, body.requestId),
            await cancel(f, actor, body),
          ]) {
            if (kind === 'access_suspension') {
              assert.equal(recovery.status, 403, JSON.stringify(recovery.body));
              assert.equal(recovery.body.error.code, 'SAFETY_ACCESS_SUSPENDED');
            } else {
              assert.equal(recovery.status, 200, JSON.stringify(recovery.body));
              assert.equal(recovery.body.outcome, 'generated');
            }
          }
          if (kind === 'access_suspension')
            assert.deepEqual(await snapshot(), before);
        }
      },
    );
    await t.test(
      'logout during readiness forbids original-session dispatch and a new same-account session recovers metadata only',
      async () => {
        const actor = await newAdmin(f),
          body = await draft(f, actor);
        let release!: () => void, ready!: () => void;
        const waiting = new Promise<void>((resolve) => {
          ready = resolve;
        });
        runtime.beforeReady = async () => {
          ready();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        };
        const before = runtime.sends.length;
        const sending = post(f, actor, body).then((response) => response);
        await Promise.race([
          waiting,
          sending.then((response) =>
            assert.fail(
              `Admission ended before readiness: ${response.status} ${JSON.stringify(response.body)}`,
            ),
          ),
        ]);
        const identity = (
          await f.pool.query<{ subject: string }>(
            "SELECT subject FROM whaleu_identity.provider_identities WHERE provider='wechat' AND app_id='synthetic-runtime-only' AND account_id=$1",
            [actor.accountId],
          )
        ).rows[0]!;
        await f.app.get(IdentityService).logout(actor.accessToken);
        const accessToken = mintToken('access'),
          refreshToken = mintToken('refresh');
        const session = await f.app.get(IdentityRepository).createSession(
          {
            provider: 'wechat',
            appId: 'synthetic-runtime-only',
            subject: identity.subject,
          },
          {
            access: hashToken(accessToken),
            refresh: hashToken(refreshToken),
          },
        );
        const renewed = { ...actor, ...session, accessToken, refreshToken };
        assert.equal(renewed.accountId, actor.accountId);
        assert.notEqual(renewed.sessionId, actor.sessionId);
        release();
        assert.equal((await sending).status, 401);
        runtime.beforeReady = null;
        assert.equal(runtime.sends.length, before);
        assert.equal((await get(f, actor, body.requestId)).status, 401);
        assert.equal(
          (await get(f, renewed, body.requestId)).body.outcome,
          'unavailable',
        );
        assert.equal(
          (await post(f, renewed, body)).body.outcome,
          'unavailable',
        );
        assert.equal(
          (await get(f, renewed, body.requestId, '/result')).body.status,
          'unavailable',
        );
        assert.equal(
          (await cancel(f, renewed, body)).body.outcome,
          'unavailable',
        );
        assert.equal(runtime.sends.length, before);
      },
    );
    await t.test(
      'owner revocation during provider readiness closes dispatch without losing metadata recovery',
      async () => {
        const actor = await newAdmin(f),
          body = await draft(f, actor);
        let release!: () => void, ready!: () => void;
        const waiting = new Promise<void>((resolve) => {
          ready = resolve;
        });
        runtime.beforeReady = async () => {
          ready();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        };
        const before = runtime.sends.length;
        const sending = post(f, actor, body).then((response) => response);
        await Promise.race([
          waiting,
          sending.then((response) =>
            assert.fail(
              `Admission ended before readiness: ${response.status} ${JSON.stringify(response.body)}`,
            ),
          ),
        ]);
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            "UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$1 WHERE account_id=$1 AND role='super_admin'",
            [actor.accountId],
          ),
        );
        release();
        const response = await sending;
        runtime.beforeReady = null;
        assert.equal(response.body.outcome, 'unavailable');
        assert.equal(runtime.sends.length, before);
        assert.equal(
          (await get(f, actor, body.requestId)).body.outcome,
          'unavailable',
        );
        assert.equal(
          (await cancel(f, actor, body)).body.outcome,
          'unavailable',
        );
        const attempts = await f.pool.query(
          'SELECT * FROM whaleu_ratings.assistance_attempts WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, body.requestId],
        );
        assert.equal(attempts.rowCount, 0);
      },
    );
    await t.test(
      'unknown provider acceptance cannot release reservation or replay a send',
      async () => {
        const actor = await newAdmin(f),
          body = await draft(f, actor);
        runtime.action = 'unknown';
        const before = runtime.sends.length;
        const response = await post(f, actor, body);
        assert.equal(response.body.outcome, 'outcome_unknown');
        assert.equal(runtime.sends.length, before + 1);
        await post(f, actor, body);
        assert.equal(runtime.sends.length, before + 1);
        assert.equal(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.assistance_settlements WHERE account_id=$1 AND request_id=$2',
              [actor.accountId, body.requestId],
            )
          ).rowCount,
          0,
        );
        assert.equal((await cancel(f, actor, body)).body.outcome, 'cancelled');
        assert.equal(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.assistance_attempts WHERE account_id=$1 AND request_id=$2',
              [actor.accountId, body.requestId],
            )
          ).rowCount,
          1,
        );
        runtime.action = 'allow';
      },
    );
    await t.test(
      'malformed accepted output is charged but never becomes recoverable plaintext',
      async () => {
        const actor = await newAdmin(f),
          body = await draft(f, actor);
        runtime.action = 'malformed';
        assert.equal((await post(f, actor, body)).body.outcome, 'rejected');
        const before = runtime.sends.length;
        assert.equal((await post(f, actor, body)).body.outcome, 'rejected');
        assert.equal(runtime.sends.length, before);
        assert.equal(
          (await get(f, actor, body.requestId, '/result')).body.status,
          'unavailable',
        );
        const receipt = await f.pool.query(
          'SELECT acceptance,input_tokens,output_tokens FROM whaleu_ratings.assistance_settlements WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, body.requestId],
        );
        assert.deepEqual(receipt.rows, [
          { acceptance: 'accepted', input_tokens: 32, output_tokens: 10 },
        ]);
        runtime.action = 'allow';
      },
    );
    await t.test(
      'accepted response loss and unresolved cancellation preserve bounded accounting without resend',
      async () => {
        const service = f.app.get(RatingAssistanceService);
        const cases = [];
        for (const action of ['lose_ack', 'unknown'] as const) {
          const actor = await newAdmin(f),
            body = await draft(f, actor);
          runtime.action = action;
          const before = runtime.sends.length;
          assert.equal(
            (await post(f, actor, body)).body.outcome,
            'outcome_unknown',
          );
          assert.equal(
            (await cancel(f, actor, body)).body.outcome,
            'cancelled',
          );
          assert.equal(
            (await get(f, actor, body.requestId, '/result')).body.status,
            'unavailable',
          );
          assert.equal(runtime.sends.length, before + 1);
          cases.push({ actor, body, action });
        }
        const sends = runtime.sends.length;
        // Wait for the actual persisted dispatch bound; no timestamp tampering,
        // shortened production lease, or fixture-only deadline bypass.
        await f.pool.query(
          `SELECT pg_sleep(greatest(0,extract(epoch FROM max(dispatch_until)-clock_timestamp()))+0.01) FROM whaleu_ratings.assistance_attempts`,
        );
        runtime.action = 'unknown';
        for (let n = 0; n < 4; n++) await service.reconcilePending();
        assert.equal(runtime.sends.length, sends);
        for (const { actor, body, action } of cases) {
          const settlements = await f.pool.query(
            'SELECT acceptance,input_tokens,output_tokens,monetary_minor_units FROM whaleu_ratings.assistance_settlements WHERE account_id=$1 AND request_id=$2',
            [actor.accountId, body.requestId],
          );
          assert.deepEqual(settlements.rows, [
            {
              acceptance:
                action === 'lose_ack' ? 'accepted' : 'conservatively_charged',
              input_tokens: action === 'lose_ack' ? 32 : 512,
              output_tokens: action === 'lose_ack' ? 10 : 64,
              monetary_minor_units: 0,
            },
          ]);
          assert.equal(
            (await get(f, actor, body.requestId)).body.outcome,
            'cancelled',
          );
          assert.equal(
            (await get(f, actor, body.requestId, '/result')).body.status,
            'unavailable',
          );
          const reconciliations = await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_ratings.assistance_reconciliations WHERE account_id=$1 AND request_id=$2',
            [actor.accountId, body.requestId],
          );
          assert.equal(
            reconciliations.rows[0].n,
            action === 'lose_ack' ? 1 : 3,
          );
        }
        runtime.action = 'allow';
      },
    );
    await t.test(
      'direct SQL cannot mutate or truncate claims, meter overflow, or create a result without exact attempt',
      async () => {
        const actor = await newAdmin(f),
          body = await draft(f, actor);
        assert.equal((await post(f, actor, body)).body.outcome, 'generated');
        for (const sql of [
          'UPDATE whaleu_ratings.assistance_claims SET intent_hash=intent_hash WHERE false',
          'DELETE FROM whaleu_ratings.assistance_claims WHERE false',
          'TRUNCATE whaleu_ratings.assistance_claims',
        ])
          await assert.rejects(f.pool.query(sql));
        await assert.rejects(
          f.pool.query(
            'INSERT INTO whaleu_ratings.assistance_results(account_id,request_id,result_id,result_digest,literal_text) VALUES($1,$2,$3,$4,$5)',
            [
              actor.accountId,
              randomUUID(),
              randomUUID(),
              '0'.repeat(64),
              '共同分享真实课程体验',
            ],
          ),
        );
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_ratings.assistance_settlements SET input_tokens=513 WHERE account_id=$1',
            [actor.accountId],
          ),
        );
        const plain = await get(f, actor, body.requestId, '/result');
        assert.equal(plain.body.status, 'available');
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            "UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$1 WHERE account_id=$1 AND role='super_admin'",
            [actor.accountId],
          ),
        );
        const withheld = await get(f, actor, body.requestId, '/result');
        assert.ok(
          withheld.status >= 400 || withheld.body.status === 'unavailable',
        );
        assert.ok(!JSON.stringify(withheld.body).includes('共同分享'));
        assert.equal(
          (await get(f, actor, body.requestId)).body.outcome,
          'generated',
        );
        assert.equal((await cancel(f, actor, body)).body.outcome, 'generated');
      },
    );
    await t.test(
      'actual bounded plaintext expiry cleanup retains original receipt, accounting and no-resend replay',
      async () => {
        const actor = await newAdmin(f),
          body = await draft(f, actor);
        const db = f.app.get(DatabaseService),
          records = f.app.get(RatingAssistanceRepository),
          qualifier = f.app.get(RatingAssistanceQualification),
          service = f.app.get(RatingAssistanceService);
        await db.transaction(
          async (tx) => {
            await records.bind(
              actor.accountId,
              body.requestId,
              body.purpose,
              assistanceIntentHash(body),
              tx,
            );
            const q = await qualifier.qualify(actor.accessToken, body, tx);
            // Exercise the production SQL's permitted shorter retention at initial
            // admission. No immutable row, clock, owner proof or trigger is changed.
            await tx.query(
              `INSERT INTO whaleu_ratings.assistance_requests(account_id,request_id,purpose,intent_hash,draft_id,input_revision,session_id,context_id,source_revision,input_digest,profile,admitted_at,queue_until,payload_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp(),clock_timestamp()+interval '120 seconds',clock_timestamp()+interval '2 seconds')`,
              [
                actor.accountId,
                body.requestId,
                body.purpose,
                assistanceIntentHash(body),
                body.draftId,
                body.inputRevision,
                q.sessionId,
                body.context.id,
                q.sourceRevision,
                assistanceInputDigest(q.input, q.sourceRevision),
                ASSISTANCE_PROFILE,
              ],
            );
            await tx.query(
              'INSERT INTO whaleu_ratings.assistance_payloads(account_id,request_id,intent,provider_input,source_binding) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)',
              [
                actor.accountId,
                body.requestId,
                JSON.stringify(body),
                JSON.stringify(q.input),
                JSON.stringify(q.sourceBinding),
              ],
            );
            await tx.query(
              "INSERT INTO whaleu_ratings.assistance_jobs(account_id,request_id,state) VALUES($1,$2,'queued')",
              [actor.accountId, body.requestId],
            );
          },
          { isolationLevel: 'read committed' },
        );
        await service.process(actor.accessToken, body.requestId);
        const receipt = (await get(f, actor, body.requestId)).body;
        assert.equal(receipt.outcome, 'generated', JSON.stringify(receipt));
        const sends = runtime.sends.length;
        await f.pool.query(
          'SELECT pg_sleep(greatest(0,extract(epoch FROM payload_until-clock_timestamp()))+0.01) FROM whaleu_ratings.assistance_requests WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, body.requestId],
        );
        assert.equal(await service.cleanup(), 1);
        const retained = (
          await f.pool.query(
            `SELECT (SELECT count(*)::int FROM whaleu_ratings.assistance_claims WHERE account_id=$1 AND request_id=$2) claims,(SELECT count(*)::int FROM whaleu_ratings.assistance_settlements WHERE account_id=$1 AND request_id=$2) accounting,(SELECT count(*)::int FROM whaleu_ratings.assistance_payloads WHERE account_id=$1 AND request_id=$2) payloads,(SELECT count(*)::int FROM whaleu_ratings.assistance_results WHERE account_id=$1 AND request_id=$2) results`,
            [actor.accountId, body.requestId],
          )
        ).rows[0];
        assert.deepEqual(retained, {
          claims: 1,
          accounting: 1,
          payloads: 0,
          results: 0,
        });
        assert.deepEqual((await get(f, actor, body.requestId)).body, receipt);
        assert.deepEqual((await post(f, actor, body)).body, receipt);
        assert.equal(
          (await get(f, actor, body.requestId, '/result')).body.status,
          'unavailable',
        );
        assert.equal(runtime.sends.length, sends);
      },
    );
    await t.test(
      'real leased claims enforce the fixed four-worker bound across five accounts',
      async () => {
        const db = f.app.get(DatabaseService),
          records = f.app.get(RatingAssistanceRepository);
        const qualifier = f.app.get(RatingAssistanceQualification);
        const queued: {
          actor: Actor;
          body: ReturnType<typeof assistanceRequestSchema.parse>;
        }[] = [];
        for (let n = 0; n < 5; n++) {
          const actor = await newAdmin(f),
            body = await draft(f, actor);
          await db.transaction(
            async (tx) => {
              await records.bind(
                actor.accountId,
                body.requestId,
                body.purpose,
                assistanceIntentHash(body),
                tx,
              );
              const qualified = await qualifier.qualify(
                actor.accessToken,
                body,
                tx,
              );
              await records.admit(
                actor.accountId,
                qualified.sessionId,
                body,
                qualified.input,
                qualified.sourceRevision,
                qualified.sourceBinding,
                tx,
              );
            },
            { isolationLevel: 'read committed' },
          );
          queued.push({ actor, body });
        }
        for (let n = 0; n < queued.length; n++) {
          const { actor, body } = queued[n]!;
          const claim = await db.transaction(
            (tx) => records.claim(actor.accountId, body.requestId, tx),
            { isolationLevel: 'read committed' },
          );
          assert.equal(claim !== null, n < 4);
        }
        for (const { actor, body } of queued)
          assert.equal(
            (await cancel(f, actor, body)).body.outcome,
            'cancelled',
          );
      },
    );
    await t.test(
      'a real deferred SQL wait expires the exact claim and rolls back plaintext while retaining accepted usage',
      async () => {
        const actor = await newAdmin(f),
          body = await draft(f, actor);
        const db = f.app.get(DatabaseService),
          records = f.app.get(RatingAssistanceRepository);
        const qualifier = f.app.get(RatingAssistanceQualification);
        await db.transaction(
          async (tx) => {
            await records.bind(
              actor.accountId,
              body.requestId,
              body.purpose,
              assistanceIntentHash(body),
              tx,
            );
            const qualified = await qualifier.qualify(
              actor.accessToken,
              body,
              tx,
            );
            await records.admit(
              actor.accountId,
              qualified.sessionId,
              body,
              qualified.input,
              qualified.sourceRevision,
              qualified.sourceBinding,
              tx,
            );
          },
          { isolationLevel: 'read committed' },
        );
        const claim = await db.transaction(
          async (tx) => {
            const record = await records.record(
              actor.accountId,
              body.requestId,
              tx,
            );
            assert.ok(record);
            const lease = await tx.query<{ fence: string; lease_until: Date }>(
              `UPDATE whaleu_ratings.assistance_jobs SET state='claimed',fence=fence+1,lease_until=clock_timestamp()+interval '2 seconds' WHERE account_id=$1 AND request_id=$2 RETURNING fence,lease_until`,
              [actor.accountId, body.requestId],
            );
            return { ...record, ...lease.rows[0]!, attempt: 0 };
          },
          { isolationLevel: 'read committed' },
        );
        await db.transaction((tx) => records.dispatch(claim, tx), {
          isolationLevel: 'read committed',
        });
        await db.transaction(
          (tx) =>
            records.settle(
              claim,
              1,
              'accepted',
              { inputTokens: 32, outputTokens: 10, monetaryMinorUnits: 0 },
              tx,
            ),
          { isolationLevel: 'read committed' },
        );
        const writer = await f.pool.connect();
        try {
          await writer.query('BEGIN');
          // Queued before the outcome constraints, so this is a real final SQL
          // wait before those owner checks, with no TS clock or fixture bypass.
          await writer.query(`CREATE TEMP TABLE assistance_deferred_wait(id integer) ON COMMIT DROP;
            CREATE OR REPLACE FUNCTION pg_temp.assistance_deferred_wait() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_sleep(2.1); RETURN NEW; END $$;
            CREATE CONSTRAINT TRIGGER assistance_deferred_wait AFTER INSERT ON assistance_deferred_wait
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.assistance_deferred_wait();
            INSERT INTO assistance_deferred_wait VALUES(1)`);
          await records.generated(claim, 1, '共同分享真实课程体验', writer);
          await assert.rejects(
            writer.query('COMMIT'),
            (error: unknown) =>
              !!error &&
              typeof error === 'object' &&
              'code' in error &&
              error.code === '23514',
          );
        } finally {
          await writer.query('ROLLBACK');
          writer.release();
        }
        assert.equal(
          (await get(f, actor, body.requestId, '/result')).body.status,
          'unavailable',
        );
        const accounting = await f.pool.query(
          'SELECT acceptance FROM whaleu_ratings.assistance_settlements WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, body.requestId],
        );
        assert.deepEqual(accounting.rows, [{ acceptance: 'accepted' }]);
        assert.equal((await cancel(f, actor, body)).body.outcome, 'cancelled');
      },
    );
    await t.test(
      'SQL admission is bidirectional and source-bound, including zero-row immutability',
      async () => {
        const actor = await newAdmin(f),
          base = await draft(f, actor),
          db = f.app.get(DatabaseService),
          records = f.app.get(RatingAssistanceRepository),
          qualifier = f.app.get(RatingAssistanceQualification);
        await assert.rejects(
          f.pool.query(
            'INSERT INTO whaleu_ratings.assistance_claims(account_id,request_id,purpose,intent_hash) VALUES($1,$2,$3,$4)',
            [
              actor.accountId,
              randomUUID(),
              'category_description',
              'a'.repeat(64),
            ],
          ),
        );
        const admit = async (mode: 'valid' | 'name' | 'source') => {
          const body = { ...base, requestId: randomUUID() };
          await db.transaction(
            async (tx) => {
              await records.bind(
                actor.accountId,
                body.requestId,
                body.purpose,
                assistanceIntentHash(body),
                tx,
              );
              const qualified = await qualifier.qualify(
                actor.accessToken,
                body,
                tx,
              );
              await records.admit(
                actor.accountId,
                qualified.sessionId,
                body,
                mode === 'name'
                  ? { ...qualified.input, name: '替换输入' }
                  : qualified.input,
                mode === 'source' ? '0'.repeat(64) : qualified.sourceRevision,
                qualified.sourceBinding,
                tx,
              );
            },
            { isolationLevel: 'read committed' },
          );
          return body;
        };
        await assert.rejects(admit('name'));
        await assert.rejects(admit('source'));
        const body = await admit('valid');
        await assert.rejects(
          f.pool.query(
            'INSERT INTO whaleu_ratings.assistance_cancellations(account_id,request_id,purpose,intent_hash) VALUES($1,$2,$3,$4)',
            [
              actor.accountId,
              body.requestId,
              body.purpose,
              assistanceIntentHash(body),
            ],
          ),
        );
        await assert.rejects(
          f.pool.query(
            'DELETE FROM whaleu_ratings.assistance_payloads WHERE account_id=$1 AND request_id=$2',
            [actor.accountId, body.requestId],
          ),
        );
        await assert.rejects(
          f.pool.query('TRUNCATE whaleu_ratings.assistance_payloads'),
        );
        await assert.rejects(
          f.pool.query(
            `INSERT INTO whaleu_ratings.assistance_outcomes(account_id,request_id,purpose,intent_hash,outcome,result_id,result_digest,attempt,fence) VALUES($1,$2,$3,$4,'generated',$5,$6,1,1)`,
            [
              actor.accountId,
              body.requestId,
              body.purpose,
              assistanceIntentHash(body),
              randomUUID(),
              'a'.repeat(64),
            ],
          ),
        );
        // A legitimate shorter SQL claim exercises takeover without mutating an
        // immutable timestamp or changing the production 30-second ceiling.
        const first = await db.transaction(
          async (tx) => {
            const record = await records.record(
              actor.accountId,
              body.requestId,
              tx,
            );
            assert.ok(record);
            const claimed = await tx.query<{
              fence: string;
              lease_until: Date;
            }>(
              `UPDATE whaleu_ratings.assistance_jobs SET state='claimed',fence=fence+1,lease_until=clock_timestamp()+interval '100 milliseconds' WHERE account_id=$1 AND request_id=$2 RETURNING fence,lease_until`,
              [actor.accountId, body.requestId],
            );
            return { ...record, ...claimed.rows[0]!, attempt: 0 };
          },
          { isolationLevel: 'read committed' },
        );
        await f.pool.query('SELECT pg_sleep(0.15)');
        const successor = await db.transaction(
          (tx) => records.claim(actor.accountId, body.requestId, tx),
          { isolationLevel: 'read committed' },
        );
        assert.ok(successor);
        assert.equal(BigInt(successor.fence), BigInt(first.fence) + 1n);
        const stale = await db.transaction(
          (tx) => records.finishClaim(first, 'unavailable', tx),
          { isolationLevel: 'read committed' },
        );
        assert.equal(stale?.outcome, 'claimed');
        assert.equal(
          (await get(f, actor, body.requestId)).body.outcome,
          'claimed',
        );
        assert.equal((await cancel(f, actor, body)).body.outcome, 'cancelled');
        assert.equal(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.assistance_payloads WHERE account_id=$1 AND request_id=$2',
              [actor.accountId, body.requestId],
            )
          ).rowCount,
          0,
        );
      },
    );
    assert.ok(f.app.get(RatingAssistanceService));
  },
);
