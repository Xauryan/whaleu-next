import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  dishRecommendationFixture,
  dishHistory,
  reviewDish,
  revokeDishReview,
} from '../support/dish-recommendation-fixture.js';
import { windowHistory } from '../support/window-rating-fixture.js';
import { dishNameSchema } from '../../src/ratings/windows/dishes/contracts.js';
import { dishIdentity } from '../../src/community/content-review/dish-review.facade.js';
const base = '/v1/ratings/windows';
const ok = (r: { status: number; body: unknown }, status = 200) =>
  assert.equal(r.status, status, JSON.stringify(r.body));
test(
  'W2 exact public dish endorsements, private reversible lineage and current owner proofs',
  { timeout: 240000 },
  async (t) => {
    const f = await dishRecommendationFixture();
    t.after(() => f.close());
    const actor = await f.actor({ affiliation: 'unverified', identity: false }),
      other = await f.actor({ affiliation: 'unverified', identity: false }),
      http = f.app.getHttpServer(),
      w = f.add(),
      unknown = f.add();
    let catalog = await f.accept([w, unknown]);
    const get = (path: string, a = actor) =>
      request(http)
        .get(base + path)
        .set('Authorization', 'Bearer ' + a.accessToken);
    const post = (op: string, command: object, a = actor, id = w.id) =>
      request(http)
        .post(`${base}/${id}/dishes/${op}`)
        .set('Authorization', 'Bearer ' + a.accessToken)
        .send(command);
    const own = (name: string, a = actor, id = w.id) =>
      get(
        `/${id}/dishes/my-membership?dishName=${encodeURIComponent(name)}`,
        a,
      );
    const page = (query = '', a = actor) => get(`/${w.id}/dishes${query}`, a);
    let revision: string,
      first: ReturnType<typeof f.recommend>,
      original: unknown;
    await t.test(
      'catalog/score history never proves dish coverage; no invented empty or own absence',
      async () => {
        ok(await page(), 503);
        assert.equal(
          (await page()).body.error.code,
          'DISH_HISTORY_UNAVAILABLE',
        );
        assert.deepEqual((await own('Rice')).body, { kind: 'unavailable' });
        const q = f.recommend(catalog, w, 'Rice');
        ok(await post('recommend', q), 503);
        ok(await get('/dish-requests/' + q.clientRequestId), 404);
        await f.acceptDishes([w.id]);
        const r = await page();
        ok(r);
        assert.deepEqual(r.body.items, []);
        assert.deepEqual((await own('Rice')).body, { kind: 'not_recommended' });
      },
    );
    await t.test(
      'phone-only add, exact Review envelope, duplicate rejection, two actors and private state',
      async () => {
        first = f.recommend(catalog, w, 'Rice');
        ok(await post('recommend', first), 503);
        ok(await get('/dish-requests/' + first.clientRequestId), 404);
        await reviewDish(f.pool, actor.accountId, w.id, first);
        let r = await post('recommend', first);
        ok(r);
        assert.equal(r.body.outcome, 'applied');
        original = r.body;
        revision = r.body.membershipRevision;
        assert.equal(r.body.dishName, undefined);
        assert.equal(r.body.dishIdentity, dishIdentity('Rice'));
        r = await post('recommend', f.recommend(catalog, w, 'Rice', revision));
        ok(r);
        assert.equal(r.body.code, 'DISH_ALREADY_RECOMMENDED');
        const second = f.recommend(catalog, w, 'Rice');
        await reviewDish(f.pool, other.accountId, w.id, second);
        ok(await post('recommend', second, other));
        r = await page();
        ok(r);
        assert.deepEqual(r.body.items, [
          {
            dishName: 'Rice',
            dishIdentity: dishIdentity('Rice'),
            recommendationCount: 2,
            isRecommended: true,
            myMembershipRevision: revision,
          },
        ]);
        assert.equal(JSON.stringify(r.body).includes(actor.accountId), false);
        assert.equal(JSON.stringify(r.body).includes(other.accountId), false);
        ok(await get('/dish-requests/' + first.clientRequestId, other), 404);
      },
    );
    await t.test(
      'retract, inactive tombstone, remove rejection, re-add and old receipt never rewinds',
      async () => {
        const remove = f.recommend(catalog, w, 'Rice', revision);
        let r = await post('retract', remove);
        ok(r);
        revision = r.body.membershipRevision;
        assert.equal(r.body.active, false);
        assert.deepEqual((await post('recommend', first)).body, original);
        assert.equal((await own('Rice')).body.active, false);
        r = await page();
        assert.equal(r.body.items[0].recommendationCount, 1);
        assert.equal(r.body.items[0].isRecommended, false);
        assert.equal(r.body.items[0].myMembershipRevision, revision);
        r = await post('retract', f.recommend(catalog, w, 'Rice', revision));
        ok(r);
        assert.equal(r.body.code, 'DISH_NOT_RECOMMENDED');
        const readd = f.recommend(catalog, w, 'Rice', revision);
        await reviewDish(f.pool, actor.accountId, w.id, readd);
        r = await post('recommend', readd);
        ok(r);
        revision = r.body.membershipRevision;
        assert.equal((await post('retract', remove)).body.active, false);
        assert.equal((await own('Rice')).body.active, true);
        r = await post(
          'retract',
          f.recommend(catalog, w, 'Rice', remove.expectedMembershipRevision),
        );
        ok(r);
        assert.equal(r.body.code, 'DISH_MEMBERSHIP_REVISION_CONFLICT');
        assert.equal(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.dish_heads WHERE window_id=$1 AND actor_id=$2',
              [w.id, actor.accountId],
            )
          ).rowCount,
          1,
        );
      },
    );
    await t.test(
      'changed key intent conflicts and concurrent first-add/transition CAS has one winner',
      async () => {
        ok(await post('recommend', { ...first, dishName: 'Changed' }), 409);
        const a = f.recommend(catalog, w, 'Rice', revision),
          b = f.recommend(catalog, w, 'Rice', revision),
          results = await Promise.all([post('retract', a), post('retract', b)]);
        results.forEach((r) => ok(r));
        assert.deepEqual(results.map((r) => r.body.outcome).sort(), [
          'applied',
          'rejected',
        ]);
        assert.equal(
          results.find((r) => r.body.outcome === 'rejected')!.body.code,
          'DISH_MEMBERSHIP_REVISION_CONFLICT',
        );
        revision = results.find((r) => r.body.outcome === 'applied')!.body
          .membershipRevision;
        const x = f.recommend(catalog, w, 'Fresh'),
          y = f.recommend(catalog, w, 'Fresh');
        await reviewDish(f.pool, actor.accountId, w.id, x);
        await reviewDish(f.pool, actor.accountId, w.id, y);
        const adds = await Promise.all([
          post('recommend', x),
          post('recommend', y),
        ]);
        adds.forEach((r) => ok(r));
        assert.deepEqual(adds.map((r) => r.body.outcome).sort(), [
          'applied',
          'rejected',
        ]);
      },
    );
    await t.test(
      'Unicode codepoint 10/11, preserved identity variants, SQL/native parity and strict HTTP',
      async () => {
        for (const name of [
          '0',
          'A',
          'a',
          'é',
          'e\u0301',
          'Ａ',
          ' A',
          'A ',
          '🍱'.repeat(10),
          '菜'.repeat(10),
        ]) {
          assert.ok(dishNameSchema.safeParse(name).success);
          const sql = await f.pool.query(
            'SELECT whaleu_ratings.dish_name_valid($1) valid',
            [name],
          );
          assert.equal(sql.rows[0].valid, true);
          const q = f.recommend(catalog, w, name);
          await reviewDish(f.pool, actor.accountId, w.id, q);
          const r = await post('recommend', q);
          ok(r);
          assert.equal(r.body.dishIdentity, dishIdentity(name));
          assert.equal((await own(name)).body.active, true);
        }
        for (const name of [
          '',
          ' ',
          '\u3000',
          '\tA',
          '\u0000',
          '\u007f',
          '\u0080',
          '\ud800',
          '🍱'.repeat(11),
          '菜'.repeat(11),
        ]) {
          assert.equal(dishNameSchema.safeParse(name).success, false);
          ok(await post('recommend', f.recommend(catalog, w, name)), 400);
        }
        ok(
          await post('recommend', {
            ...f.recommend(catalog, w, 'Bad'),
            dishName: 7,
          }),
          400,
        );
        ok(
          await post('recommend', {
            ...f.recommend(catalog, w, 'Bad'),
            actorId: other.accountId,
          }),
          400,
        );
        const r = await page('?limit=50');
        ok(r);
        const items = r.body.items as {
          dishIdentity: string;
          recommendationCount: number;
        }[];
        assert.deepEqual(
          items,
          [...items].sort(
            (a, b) =>
              b.recommendationCount - a.recommendationCount ||
              (a.dishIdentity < b.dishIdentity ? -1 : 1),
          ),
        );
      },
    );
    await t.test(
      'Review reject/unavailable/revoke: negative proof excludes one contribution, keeps healthy neighbor',
      async () => {
        const reject = f.recommend(catalog, w, 'Reject');
        await reviewDish(f.pool, actor.accountId, w.id, reject, 'reject');
        let r = await post('recommend', reject);
        ok(r);
        assert.equal(r.body.code, 'CONTENT_REJECTED');
        assert.equal((await own('Reject')).body.kind, 'not_recommended');
        const one = f.recommend(catalog, w, 'Shared'),
          two = f.recommend(catalog, w, 'Shared');
        const decision = await reviewDish(f.pool, actor.accountId, w.id, one);
        await reviewDish(f.pool, other.accountId, w.id, two);
        ok(await post('recommend', one));
        ok(await post('recommend', two, other));
        await revokeDishReview(f.pool, decision);
        r = await page('?limit=50');
        ok(r);
        assert.equal(
          r.body.items.find(
            (i: { dishName: string }) => i.dishName === 'Shared',
          ).recommendationCount,
          1,
        );
        assert.equal((await own('Shared')).body.active, true);
        ok(
          await post(
            'retract',
            f.recommend(
              catalog,
              w,
              'Shared',
              (await own('Shared')).body.revision,
            ),
          ),
        );
      },
    );
    await t.test(
      'offpage changes restart cursor; new catalog relabel preserves active/inactive history',
      async () => {
        const firstPage = await page('?limit=1');
        ok(firstPage);
        assert.ok(firstPage.body.nextCursor);
        const q = f.recommend(catalog, w, 'ZZZ');
        await reviewDish(f.pool, actor.accountId, w.id, q);
        ok(await post('recommend', q));
        const r = await page(
          '?limit=1&cursor=' + encodeURIComponent(firstPage.body.nextCursor),
        );
        ok(r, 409);
        assert.equal(r.body.error.code, 'DISCOVERY_RESTART_REQUIRED');
        const before = await own('Rice');
        catalog = await f.accept([
          { ...w, revision: randomUUID(), name: 'Relabelled' },
          unknown,
        ]);
        w.revision = f.windows[0]!.revision;
        assert.deepEqual((await own('Rice')).body, before.body);
        assert.ok((await page('?limit=50')).body.items.length);
      },
    );
    await t.test(
      'owner retraction/recovery/cancel survives source, phone, Safety and history loss',
      async () => {
        const name = 'Closure',
          q = f.recommend(catalog, w, name);
        await reviewDish(f.pool, actor.accountId, w.id, q);
        const added = await post('recommend', q);
        ok(added);
        const current = await own(name);
        ok(current);
        await f.certify(actor.accountId, {
          phone: 'unverified',
          affiliation: 'unverified',
          identity: false,
        });
        await f.pool.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
          [actor.accountId],
        );
        await f.pool.query(
          "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
        );
        await dishHistory(f.pool, w.id, 'membership', 'unknown');
        await dishHistory(f.pool, w.id, 'population', 'unknown');
        assert.equal((await own(name)).body.active, true);
        ok(await page(), 403);
        const retract = f.recommend(
            current.body.catalogRevision,
            { revision: current.body.windowRevision },
            name,
            current.body.revision,
          ),
          r = await post('retract', retract);
        ok(r);
        assert.equal(r.body.active, false);
        assert.equal((await own(name)).body.active, false);
        assert.deepEqual((await post('recommend', q)).body, added.body);
        assert.equal((await own(name)).body.active, false);
        const late = f.recommend(catalog, w, 'Pending'),
          cancelled = await request(http)
            .post(`${base}/dish-requests/${late.clientRequestId}/cancel`)
            .set('Authorization', 'Bearer ' + actor.accessToken)
            .send({
              windowId: w.id,
              operation: 'window.dish.recommend.v1',
              command: late,
            });
        ok(cancelled);
        assert.equal(cancelled.body.code, 'DISH_CANCELLED');
        assert.deepEqual((await post('recommend', late)).body, cancelled.body);
        await f.certify(actor.accountId);
        await f.pool.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=true WHERE account_id=$1',
          [actor.accountId],
        );
        await f.pool.query(
          "UPDATE whaleu_ratings.window_catalog_head SET state='accepted'",
        );
        await f.acceptDishes([w.id]);
      },
    );
    await t.test(
      'independent dish coverage remains known when numeric score history is unknown',
      async () => {
        await windowHistory(f.pool, w.id, 'unknown');
        ok(await page());
        assert.equal((await own('Rice')).body.kind, 'recorded');
        const q = f.recommend(catalog, w, 'Separate');
        await reviewDish(f.pool, actor.accountId, w.id, q);
        ok(await post('recommend', q));
        await windowHistory(f.pool, w.id, 'accepted_empty');
      },
    );
    await t.test(
      'unknown Review fails closed, explicit revoke does not poison healthy rows; W1 independent',
      async () => {
        const q = f.recommend(catalog, w, 'Unknown'),
          decision = await reviewDish(f.pool, actor.accountId, w.id, q);
        ok(await post('recommend', q));
        await f.pool.query(
          'DELETE FROM whaleu_community.dish_review_heads WHERE decision_id=$1',
          [decision],
        );
        ok(await page(), 503);
        await f.pool.query(
          "INSERT INTO whaleu_community.dish_review_heads(actor_id,request_id,decision_id,state) VALUES($1,$2,$3,'revoked')",
          [actor.accountId, q.clientRequestId, decision],
        );
        ok(await page());
        const score = await request(http)
          .post(`${base}/${w.id}/score`)
          .set('Authorization', 'Bearer ' + actor.accessToken)
          .send(f.command(catalog, w, { score: -10 }));
        ok(score);
        const detail = await get('/' + w.id);
        ok(detail);
        assert.equal(detail.body.window.summary.ratingCount, 1);
        assert.equal(detail.body.window.summary.mean, -10);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::integer n FROM whaleu_ratings.course_comments',
            )
          ).rows[0].n,
          0,
        );
      },
    );
  },
);
