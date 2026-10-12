import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  floorRatingFixture,
  floorHistory,
} from '../support/canteen-floor-score-fixture.js';
import { windowHistory } from '../support/window-rating-fixture.js';
import {
  dishHistory,
  reviewDish,
} from '../support/dish-recommendation-fixture.js';
import {
  discussionHistory,
  reviewWindowDiscussion,
} from '../support/window-discussion-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { floorIntentHash } from '../../src/ratings/canteen-floors/service.js';
const base = '/v1/ratings/canteen-floors';
const ok = (r: { status: number; body: unknown }, status = 200) =>
  assert.equal(r.status, status, JSON.stringify(r.body));
test(
  'independent floor publication, fractional numeric codec, one active winner, immutable receipt/cancel, zero-window topology and exact floor-only population',
  { timeout: 240000 },
  async (t) => {
    const f = await floorRatingFixture();
    t.after(() => f.close());
    const actor = await f.actor({ affiliation: 'unverified', identity: false }),
      other = await f.actor({ affiliation: 'unverified', identity: false }),
      http = f.app.getHttpServer();
    const get = (path: string, a = actor) =>
      request(http)
        .get(base + path)
        .set('Authorization', 'Bearer ' + a.accessToken);
    const post = (id: string, q: object, a = actor) =>
      request(http)
        .post(base + '/' + id + '/first-score')
        .set('Authorization', 'Bearer ' + a.accessToken)
        .send(q);
    const cancel = (id: string, q: ReturnType<typeof f.command>, a = actor) =>
      request(http)
        .post(base + '/requests/' + q.clientRequestId + '/cancel')
        .set('Authorization', 'Bearer ' + a.accessToken)
        .send({ floorId: id, command: q });
    const floor = f.add({ floorKey: 'B1-mezzanine' }),
      empty = f.add(),
      unknown = f.add({ history: 'unknown', withWindow: true }),
      another = f.add({
        canteenId: randomUUID(),
        canteenRevision: randomUUID(),
        canteenName: 'Other Synthetic Canteen',
        floorKey: 'B1-mezzanine',
      });
    let catalog: string,
      original: ReturnType<typeof f.command>,
      receipt: unknown;
    await t.test(
      'default unavailable, accepted canteen/raw-floor selector and zero-child-window target, independent unknown history',
      async () => {
        ok(await request(http).get(base + '/catalog'), 401);
        ok(await get('/catalog'), 503);
        catalog = await f.accept([]);
        assert.deepEqual((await get('/catalog')).body.canteens, []);
        catalog = await f.accept([floor, empty, unknown, another]);
        let r = await get('/catalog');
        ok(r);
        assert.equal(r.body.canteens.length, 2);
        r = await get('/' + floor.floorId);
        ok(r);
        assert.equal(r.body.floor.sourceFloorKey, 'B1-mezzanine');
        assert.deepEqual(r.body.floor.summary, {
          kind: 'known',
          ratingCount: 0,
          mean: null,
        });
        assert.deepEqual(r.body.myScore, { kind: 'not_submitted' });
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.window_entries WHERE floor_id=$1',
              [floor.floorId],
            )
          ).rowCount,
          0,
        );
        await windowHistory(f.pool, unknown.id, 'accepted_empty');
        r = await get('/' + unknown.floorId);
        ok(r);
        assert.deepEqual(r.body.floor.summary, { kind: 'unavailable' });
        assert.deepEqual(r.body.myScore, { kind: 'unavailable' });
        const q = f.command(catalog, unknown);
        ok(await post(unknown.floorId, q), 503);
        ok(await get('/requests/' + q.clientRequestId), 404);
      },
    );
    await t.test(
      'finite decimal JSON number preserved, strict malformed boundaries never create receipts',
      async () => {
        const corpus = Array.from({ length: 1024 }, (_, i) =>
          String(1 + 4 * (((i * 2654435761) % 4294967296) / 4294967296)),
        );
        const accepted = (
          await f.pool.query<{ valid: boolean }>(
            'SELECT bool_and(whaleu_ratings.floor_scalar(value::numeric)) valid FROM unnest($1::text[]) value',
            [corpus],
          )
        ).rows[0]!;
        assert.equal(
          accepted.valid,
          true,
          'all deterministic binary64 scalar round trips must be preserved',
        );
        for (const score of [
          1,
          5,
          1.25,
          4.75,
          Math.PI,
          1.0000000000000002,
          4.999999999999999,
          1.2345678901234567,
        ]) {
          const a = await f.actor({
              affiliation: 'unverified',
              identity: false,
            }),
            q = f.command(catalog, empty, { score }),
            r = await post(empty.floorId, q, a);
          ok(r);
          assert.equal(r.body.score, score);
          assert.equal(
            (await get('/' + empty.floorId, a)).body.myScore.score,
            score,
          );
          assert.equal(
            (
              await f.pool.query<{ score: string }>(
                'SELECT score::text FROM whaleu_ratings.floor_score_events WHERE request_id=$1',
                [q.clientRequestId],
              )
            ).rows[0]!.score,
            String(score),
          );
        }
        for (const score of [
          0,
          0.5,
          5.000000000000001,
          6,
          -1,
          '4.75',
          null,
          true,
          {},
          [],
        ]) {
          const q = f.command(catalog, floor, { score });
          ok(await post(floor.floorId, q), 400);
          ok(await get('/requests/' + q.clientRequestId), 404);
        }
        for (const patch of [
          { comment: 'not in scalar slice' },
          { images: [] },
          { expectedOwnScoreRevision: null },
          { user_id: actor.accountId },
          { expectedCanteenRevision: undefined },
        ])
          ok(await post(floor.floorId, f.command(catalog, floor, patch)), 400);
        original = f.command(catalog, floor, { score: 1.25 });
        const r = await post(floor.floorId, original);
        ok(r);
        receipt = r.body;
        assert.equal(r.body.outcome, 'applied');
      },
    );
    await t.test(
      'new key including same score rejects once active; original replay and actor-only receipt remain exact',
      async () => {
        assert.deepEqual((await post(floor.floorId, original)).body, receipt);
        assert.deepEqual(
          (await get('/requests/' + original.clientRequestId)).body,
          receipt,
        );
        ok(await get('/requests/' + original.clientRequestId, other), 404);
        ok(await post(floor.floorId, { ...original, score: 4.75 }), 409);
        for (const score of [1.25, 4.75]) {
          const q = f.command(catalog, floor, { score }),
            r = await post(floor.floorId, q);
          ok(r);
          assert.equal(r.body.code, 'FLOOR_ALREADY_RATED');
          assert.deepEqual((await post(floor.floorId, q)).body, r.body);
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.floor_score_events WHERE floor_id=$1 AND actor_id=$2',
              [floor.floorId, actor.accountId],
            )
          ).rowCount,
          1,
        );
      },
    );
    await t.test(
      'floor-only numeric mean counts records, not diners or Window population; separate floors and same raw key in another canteen independent',
      async () => {
        ok(
          await post(
            floor.floorId,
            f.command(catalog, floor, { score: 4.75 }),
            other,
          ),
        );
        assert.deepEqual((await get('/' + floor.floorId + '/summary')).body, {
          kind: 'known',
          ratingCount: 2,
          mean: 3,
        });
        ok(
          await post(
            another.floorId,
            f.command(catalog, another, { score: 3.25 }),
          ),
        );
        assert.deepEqual((await get('/' + another.floorId + '/summary')).body, {
          kind: 'known',
          ratingCount: 1,
          mean: 3.3,
        });
        const wq = {
          clientRequestId: randomUUID(),
          expectedCatalogRevision: catalog,
          expectedWindowRevision: unknown.revision,
          expectedOwnScoreRevision: null,
          score: -10,
        };
        let r = await request(http)
          .post('/v1/ratings/windows/' + unknown.id + '/score')
          .set('Authorization', 'Bearer ' + actor.accessToken)
          .send(wq);
        ok(r);
        assert.equal(
          (await get('/' + unknown.floorId)).body.floor.summary.kind,
          'unavailable',
        );
        await floorHistory(f.pool, unknown.floorId, 'accepted_empty');
        r = await get('/' + unknown.floorId);
        ok(r);
        assert.deepEqual(r.body.floor.summary, {
          kind: 'known',
          ratingCount: 0,
          mean: null,
        });
        ok(
          await post(
            unknown.floorId,
            f.command(catalog, unknown, { score: 4.75 }),
          ),
        );
        assert.deepEqual((await get('/' + unknown.floorId + '/summary')).body, {
          kind: 'known',
          ratingCount: 1,
          mean: 4.8,
        });
        const wr = await request(http)
          .get('/v1/ratings/windows/' + unknown.id)
          .set('Authorization', 'Bearer ' + actor.accessToken);
        ok(wr);
        assert.deepEqual(wr.body.window.summary, {
          kind: 'known',
          ratingCount: 1,
          mean: -10,
        });
        const zero = await request(http)
          .post('/v1/ratings/windows/' + unknown.id + '/score')
          .set('Authorization', 'Bearer ' + actor.accessToken)
          .send({
            ...wq,
            clientRequestId: randomUUID(),
            expectedOwnScoreRevision: wr.body.myScore.revision,
            score: 0,
          });
        ok(zero);
        assert.equal(zero.body.outcome, 'applied');
        const dq = {
          clientRequestId: randomUUID(),
          expectedCatalogRevision: catalog,
          expectedWindowRevision: unknown.revision,
          expectedMembershipRevision: null,
          dishName: 'Rice',
        };
        await dishHistory(f.pool, unknown.id, 'population');
        await dishHistory(f.pool, unknown.id, 'membership');
        await reviewDish(f.pool, actor.accountId, unknown.id, dq);
        const dish = await request(http)
          .post('/v1/ratings/windows/' + unknown.id + '/dishes/recommend')
          .set('Authorization', 'Bearer ' + actor.accessToken)
          .send(dq);
        ok(dish);
        assert.equal(dish.body.outcome, 'applied');
        const generic = await f.catalog(actor, { count: 1 }),
          target = generic.targets[0]!;
        const genericScore = await request(http)
          .put('/v1/ratings/targets/' + target.id + '/my-score')
          .set('Authorization', 'Bearer ' + actor.accessToken)
          .send({
            clientRequestId: randomUUID(),
            regionId: null,
            expectedTargetRevision: target.revision,
            expectedRevision: null,
            score: 1,
          });
        ok(genericScore);
        assert.equal(genericScore.body.outcome, 'applied');
        await discussionHistory(f.pool, unknown.id, 'population');
        await discussionHistory(f.pool, unknown.id, 'likes');
        const rootCommand = {
          clientRequestId: randomUUID(),
          expectedCatalogRevision: catalog,
          expectedWindowRevision: unknown.revision,
          body: 'Synthetic independent Window discussion',
        };
        await reviewWindowDiscussion(
          f.pool,
          actor.accountId,
          unknown.id,
          rootCommand,
        );
        const root = await request(http)
          .post('/v1/ratings/windows/' + unknown.id + '/discussion')
          .set('Authorization', 'Bearer ' + actor.accessToken)
          .send(rootCommand);
        ok(root);
        assert.equal(root.body.outcome, 'applied');
        const replyCommand = {
          ...rootCommand,
          clientRequestId: randomUUID(),
          body: 'Synthetic independent reply',
          replyToReplyId: null,
        };
        await reviewWindowDiscussion(
          f.pool,
          other.accountId,
          unknown.id,
          replyCommand,
          root.body.commentId,
        );
        const reply = await request(http)
          .post(
            '/v1/ratings/windows/' +
              unknown.id +
              '/discussion/' +
              root.body.commentId +
              '/replies',
          )
          .set('Authorization', 'Bearer ' + other.accessToken)
          .send(replyCommand);
        ok(reply);
        assert.equal(reply.body.outcome, 'applied');
        const liked = await request(http)
          .post(
            '/v1/ratings/windows/' +
              unknown.id +
              '/discussion/' +
              root.body.commentId +
              '/like',
          )
          .set('Authorization', 'Bearer ' + other.accessToken)
          .send({
            clientRequestId: randomUUID(),
            expectedCatalogRevision: catalog,
            expectedWindowRevision: unknown.revision,
            expectedMembershipRevision: null,
            active: true,
          });
        ok(liked);
        assert.equal(liked.body.outcome, 'applied');
        assert.deepEqual((await get('/' + unknown.floorId + '/summary')).body, {
          kind: 'known',
          ratingCount: 1,
          mean: 4.8,
        });
        const separateWindow = await request(http)
          .get('/v1/ratings/windows/' + unknown.id)
          .set('Authorization', 'Bearer ' + actor.accessToken);
        ok(separateWindow);
        assert.deepEqual(separateWindow.body.window.summary, {
          kind: 'known',
          ratingCount: 1,
          mean: 0,
        });
      },
    );
    await t.test(
      'concurrent absent-head first submissions serialize to one winner; competing cancellation never leaves two outcomes',
      async () => {
        const a = await f.actor(),
          q1 = f.command(catalog, floor, { score: 1.25 }),
          q2 = f.command(catalog, floor, { score: 4.75 });
        const rs = await Promise.all([
          post(floor.floorId, q1, a),
          post(floor.floorId, q2, a),
        ]);
        rs.forEach((r) => ok(r));
        assert.deepEqual(rs.map((r) => r.body.outcome).sort(), [
          'applied',
          'rejected',
        ]);
        assert.equal(
          rs.find((r) => r.body.outcome === 'rejected')!.body.code,
          'FLOOR_ALREADY_RATED',
        );
        const b = await f.actor(),
          q = f.command(catalog, floor);
        const racing = await Promise.all([
          post(floor.floorId, q, b),
          cancel(floor.floorId, q, b),
        ]);
        racing.forEach((r) => ok(r));
        assert.deepEqual(racing[0]!.body, racing[1]!.body);
        assert.deepEqual(
          (await post(floor.floorId, q, b)).body,
          racing[0]!.body,
        );
      },
    );
    await t.test(
      'replacement catalog retains stable own/aggregate; inactive canteen or floor blocks fresh reads and old revisions conflict',
      async () => {
        const before = (await get('/' + floor.floorId)).body;
        catalog = await f.accept([floor, empty, unknown, another]);
        assert.deepEqual(
          (await get('/' + floor.floorId)).body.myScore,
          before.myScore,
        );
        assert.deepEqual(
          (await get('/' + floor.floorId)).body.floor.summary,
          before.floor.summary,
        );
        const q = f.command(catalog, floor);
        catalog = await f.accept([floor, empty, unknown, another]);
        const r = await post(floor.floorId, q);
        ok(r);
        assert.equal(r.body.code, 'FLOOR_REVISION_CONFLICT');
        for (const patch of [{ parentActive: false }, { floorActive: false }]) {
          await f.accept([{ ...floor, ...patch }]);
          ok(await get('/' + floor.floorId), 404);
          assert.deepEqual(
            (await get('/requests/' + original.clientRequestId)).body,
            receipt,
          );
        }
        catalog = await f.accept([floor, empty, unknown, another]);
      },
    );
    await t.test(
      'unknown/future/expired independent floor history keeps known own record but prevents fresh terminal conflict fabrication',
      async () => {
        for (const state of ['unknown', 'future', 'expired']) {
          await floorHistory(
            f.pool,
            floor.floorId,
            state === 'unknown' ? 'unknown' : 'accepted_empty',
            state === 'expired'
              ? new Date(Date.now() - 1000)
              : new Date(Date.now() + 3600000),
            state === 'expired'
              ? new Date(Date.now() - 2000)
              : state === 'future'
                ? new Date(Date.now() + 10000)
                : undefined,
          );
          const r = await get('/' + floor.floorId);
          ok(r);
          assert.equal(r.body.myScore.score, 1.25);
          assert.deepEqual(r.body.floor.summary, { kind: 'unavailable' });
          const q = f.command(catalog, floor, {
            expectedCatalogRevision: randomUUID(),
          });
          ok(await post(floor.floorId, q), 503);
          ok(await get('/requests/' + q.clientRequestId), 404);
        }
        await floorHistory(f.pool, floor.floorId, 'accepted_empty');
      },
    );
    await t.test(
      'durable cancelled original never publishes after source/phone/Safety loss; historical receipt is session-only',
      async () => {
        const absent = f.command(catalog, floor);
        ok(await cancel(randomUUID(), absent), 404);
        ok(await get('/requests/' + absent.clientRequestId), 404);
        const q = f.command(catalog, floor),
          r = await cancel(floor.floorId, q);
        ok(r);
        assert.equal(r.body.code, 'FLOOR_SCORE_CANCELLED');
        assert.deepEqual((await post(floor.floorId, q)).body, r.body);
        await f.pool.query(
          "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
        );
        await f.certify(actor.accountId, {
          phone: 'unverified',
          affiliation: 'unverified',
          identity: false,
        });
        await f.pool.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
          [actor.accountId],
        );
        assert.deepEqual(
          (await get('/requests/' + original.clientRequestId)).body,
          receipt,
        );
        assert.deepEqual((await post(floor.floorId, original)).body, receipt);
        assert.deepEqual((await cancel(floor.floorId, q)).body, r.body);
        const q2 = f.command(catalog, floor);
        ok(await cancel(floor.floorId, q2));
        await f.certify(actor.accountId, {
          affiliation: 'unverified',
          identity: false,
        });
        await f.pool.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=true WHERE account_id=$1',
          [actor.accountId],
        );
        catalog = await f.accept([floor, empty, unknown, another]);
      },
    );
    await t.test(
      'raw immutable records and strict causal receipt/event/head publication; no invented inactive import or lifetime ledger unique key',
      async () => {
        for (const sql of [
          'UPDATE whaleu_ratings.floor_score_events SET score=1',
          'DELETE FROM whaleu_ratings.floor_score_heads',
          'TRUNCATE whaleu_ratings.floor_commands',
          'UPDATE whaleu_ratings.floor_commands SET receipt=receipt',
          'UPDATE whaleu_ratings.floor_score_heads SET revision=revision',
          'UPDATE whaleu_ratings.floor_history_assertions SET coverage=coverage',
        ])
          await assert.rejects(f.pool.query(sql));
        const a = await f.actor();
        for (const [patch, code] of [
          [{ score: '4.75' }, 'FLOOR_SCORE_CANCELLED'],
          [{ score: 0 }, 'FLOOR_SCORE_CANCELLED'],
          [{ expectedCanteenRevision: 12 }, 'FLOOR_SCORE_CANCELLED'],
          [{}, 'FLOOR_ALREADY_RATED'],
          [{}, 'FLOOR_REVISION_CONFLICT'],
        ] as const) {
          const q = f.command(catalog, floor, patch);
          await assert.rejects(
            inTransaction(f.pool, (tx) =>
              tx.query(
                'INSERT INTO whaleu_ratings.floor_commands(actor_id,request_id,session_id,floor_id,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7)',
                [
                  a.accountId,
                  q.clientRequestId,
                  a.sessionId,
                  floor.floorId,
                  q,
                  floorIntentHash(a.accountId, floor.floorId, q),
                  {
                    requestId: q.clientRequestId,
                    operation: 'floor.score.first.v1',
                    floorId: floor.floorId,
                    outcome: 'rejected',
                    code,
                  },
                ],
              ),
            ),
          );
        }
        assert.deepEqual(
          (
            await f.pool.query(
              "SELECT whaleu_ratings.floor_scalar(1.25) valid,whaleu_ratings.floor_scalar(1.0000000000000001) unrepresentable,whaleu_ratings.floor_scalar(5.0000000000000001) outside,whaleu_ratings.floor_scalar('NaN'::numeric) nan",
            )
          ).rows[0],
          { valid: true, unrepresentable: false, outside: false, nan: false },
        );
        const constraints = (
          await f.pool.query<{ def: string }>(
            "SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='whaleu_ratings.floor_score_events'::regclass AND contype='u'",
          )
        ).rows.map((r) => r.def);
        assert.equal(
          constraints.includes('UNIQUE (floor_id, actor_id)'),
          false,
        );
      },
    );
    await t.test(
      'current phone/Safety/canonical Campus are required; no student/affiliation/browse-school requirement',
      async () => {
        const a = await f.actor({
          phone: 'unverified',
          affiliation: 'unverified',
          identity: false,
        });
        ok(await get('/catalog', a), 403);
        const banned = await f.actor();
        await f.pool.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
          [banned.accountId],
        );
        ok(await get('/catalog', banned), 403);
        await f.pool.query(
          'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
          [floor.campusId],
        );
        ok(await get('/catalog'), 503);
        await f.pool.query(
          'UPDATE whaleu_campus.campuses SET is_active=true WHERE id=$1',
          [floor.campusId],
        );
      },
    );
  },
);
