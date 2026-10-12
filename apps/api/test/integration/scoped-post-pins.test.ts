import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { postPinFixture } from '../support/post-pin-fixture.js';
import { setReviewState } from '../support/community-approval-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
const ok = (r: { status: number; body: unknown }, status = 200) =>
  assert.equal(r.status, status, JSON.stringify(r.body));
test(
  'scoped original-region pins, independent immutable renewals/read markers and exact owner closure',
  { timeout: 180000 },
  async (t) => {
    const f = await postPinFixture();
    t.after(() => f.close());
    const author = await f.actor(),
      admin = await f.actor(),
      reader = await f.actor(),
      outsider = await f.actor();
    const http = f.app.getHttpServer();
    const feedbackSpace = randomUUID();
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic explicit feedback',true)",
        [feedbackSpace],
      );
      await tx.query(
        "INSERT INTO whaleu_community.feedback_topic(topic,space_id,provenance,source_reference) VALUES('feedback',$1,'accepted','synthetic:explicit-feedback')",
        [feedbackSpace],
      );
    });
    await f.grant(admin.accountId, 'school_admin', f.scope.home.regionId);
    await f.grant(outsider.accountId, 'super_admin');
    const a = await f.publish(author),
      b = await f.publish(author, f.scope.home.spaceId, 'pets'),
      trade = await f.publish(author, f.scope.home.spaceId, 'trading'),
      foreign = await f.publish(author, f.scope.foreign.spaceId),
      global = await f.publish(author, f.scope.global.spaceId),
      feedback = await f.publish(author, feedbackSpace, 'feedback');
    const get = (path: string, actor = reader) =>
      request(http)
        .get(path)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    const send = (command: object, actor = admin) =>
      request(http)
        .post('/v1/community/post-pin-commands')
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(command);
    const command = (postId: string, extra: object = {}) => ({
      operation: 'pin',
      postId,
      clientRequestId: randomUUID(),
      ...extra,
    });
    const list = (
      spaceId = f.scope.home.spaceId,
      extra: object = {},
      actor = reader,
    ) => get('/v1/community/post-pins', actor).query({ spaceId, ...extra });
    const slot = (spaceId = f.scope.home.spaceId, actor = admin) =>
      get('/v1/community/post-pin-slot', actor).query({ spaceId });
    const detail = (id: string, actor = reader) =>
      get(`/v1/community/posts/${id}/pin`, actor);
    await t.test(
      'missing mapping/history stays unavailable and grants never follow browse campus',
      async () => {
        const before = await list();
        ok(before);
        assert.deepEqual(before.body, {
          spaceId: f.scope.home.spaceId,
          status: 'unavailable',
          items: [],
        });
        ok(await send(command(a.id)), 503);
        assert.equal((await slot()).body.status, 'unavailable');
        await f.bind(f.scope.home.spaceId, 'regional', f.scope.home.regionId);
        await f.bind(
          f.scope.foreign.spaceId,
          'regional',
          f.scope.foreign.regionId,
        );
        await f.bind(f.scope.global.spaceId, 'university_city', null);
        await f.bind(feedbackSpace, 'feedback', null);
        await f.bind(
          f.scope.related.spaceId,
          'regional',
          f.scope.related.regionId,
          'unavailable',
        );
        assert.equal(
          (await list(f.scope.related.spaceId)).body.status,
          'unavailable',
        );
        ok(await send(command(a.id), reader), 403);
        ok(await send(command(foreign.id)), 403);
        ok(await send(command(global.id)), 403);
        ok(await send(command(feedback.id)), 403);
        ok(await slot(f.scope.home.spaceId, reader), 403);
        ok(await slot(f.scope.global.spaceId, admin), 403);
        ok(await slot(feedbackSpace, admin), 403);
        assert.equal((await detail(global.id, admin)).body.canPin, false);
        assert.equal((await detail(a.id, admin)).body.canPin, true);
      },
    );
    let first: Record<string, unknown> = {},
      firstCommand = command(a.id);
    await t.test(
      'same region shares one slot across categories and priority; other region/global independent',
      async () => {
        firstCommand = command(a.id);
        const result = await send(firstCommand);
        ok(result);
        first = result.body;
        assert.equal(first['outcome'], 'applied');
        const row = (
          await f.pool.query(
            'SELECT duration_hours,level FROM whaleu_community.post_pins WHERE id=$1',
            [first['pinId']],
          )
        ).rows[0];
        assert.deepEqual(row, { duration_hours: 24, level: 2 });
        assert.equal(
          (await send(command(b.id, { level: 1, durationHours: 1 }))).body.code,
          'POST_PIN_CONFLICT',
        );
        assert.equal(
          (await send(command(trade.id))).body.code,
          'POST_PIN_CONFLICT',
        );
        ok(await send(command(foreign.id), outsider));
        ok(await send(command(global.id), outsider));
        ok(await send(command(feedback.id), outsider));
        assert.equal(
          (await list(feedbackSpace, { category: 'feedback' })).body.items[0]
            .post.id,
          feedback.id,
        );
        assert.equal((await list()).body.items[0].pin.pinId, first['pinId']);
        assert.equal(
          (await list(f.scope.home.spaceId, { category: 'pets' })).body.items
            .length,
          0,
        );
        const guest = await request(http)
          .get('/v1/community/post-pins')
          .query({ spaceId: f.scope.home.spaceId });
        ok(guest);
        assert.equal(guest.body.items[0].pin.readState, 'guest');
        const ordinary = await get('/v1/community/posts').query({
          spaceId: f.scope.home.spaceId,
        });
        ok(ordinary);
        assert.ok(
          ordinary.body.items.some((p: { id: string }) => p.id === a.id),
        );
        assert.equal('pinned' in ordinary.body, false);
      },
    );
    await t.test(
      'exact read is per account and pin; same key is immutable and new key renewal resets unread',
      async () => {
        const read = {
          operation: 'read',
          postId: a.id,
          pinId: first['pinId'],
          clientRequestId: randomUUID(),
        };
        const receipt = await send(read, reader);
        ok(receipt);
        assert.equal((await detail(a.id, reader)).body.pin.readState, 'read');
        assert.equal((await detail(a.id, admin)).body.pin.readState, 'unread');
        assert.deepEqual(
          (await send({ ...read, clientRequestId: randomUUID() }, reader)).body
            .recordedAt,
          receipt.body.recordedAt,
        );
        const renewed = await send(
          command(a.id, { durationHours: 168, level: 1 }),
        );
        ok(renewed);
        assert.notEqual(renewed.body.pinId, first['pinId']);
        assert.equal((await detail(a.id, reader)).body.pin.readState, 'unread');
        assert.deepEqual((await send(firstCommand)).body, first);
        ok(await send({ ...firstCommand, durationHours: 1 }), 409);
        assert.equal(
          (await send({ ...read, clientRequestId: randomUUID() }, reader)).body
            .code,
          'POST_PIN_STALE',
        );
        assert.equal(
          (
            await send({
              operation: 'unpin',
              postId: a.id,
              pinId: first['pinId'],
              clientRequestId: randomUUID(),
            })
          ).body.code,
          'POST_PIN_STALE',
        );
        const recovery = await get(
          '/v1/me/community/post-pin-requests/' + firstCommand.clientRequestId,
          admin,
        );
        assert.deepEqual(recovery.body, first);
        ok(
          await get(
            '/v1/me/community/post-pin-requests/' +
              firstCommand.clientRequestId,
            reader,
          ),
          404,
        );
      },
    );
    await t.test(
      'named blocks suppress projection and exact read without leaking the conflicting pin',
      async () => {
        const blocked = await f.actor();
        const result = await request(http)
          .put('/v1/me/safety/blocks')
          .set('Authorization', `Bearer ${blocked.accessToken}`)
          .send({
            clientRequestId: randomUUID(),
            source: { kind: 'post', id: a.id },
            blocked: true,
          });
        ok(result);
        assert.equal(result.body.receipt.outcome, 'applied');
        const projection = await list(f.scope.home.spaceId, {}, blocked);
        ok(projection);
        assert.equal(projection.body.items.length, 0);
        ok(await detail(a.id, blocked), 404);
        const pin = (await detail(a.id, admin)).body.pin;
        ok(
          await send(
            {
              operation: 'read',
              postId: a.id,
              pinId: pin.pinId,
              clientRequestId: randomUUID(),
            },
            blocked,
          ),
          404,
        );
        await f.grant(blocked.accountId, 'school_admin', f.scope.home.regionId);
        const own = await f.publish(blocked);
        const conflict = await send(command(own.id), blocked);
        ok(conflict);
        assert.equal(conflict.body.code, 'POST_PIN_CONFLICT');
        assert.equal('pinId' in conflict.body, false);
        assert.equal('text' in conflict.body, false);
      },
    );
    await t.test(
      'hidden or Review-withdrawn pins reserve slots; exact manager closure exposes no content and frees slot',
      async () => {
        let pin = (await detail(a.id, admin)).body.pin;
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [a.id],
          ),
        );
        assert.equal((await list()).body.items.length, 0);
        const occupied = await slot();
        ok(occupied);
        assert.equal(occupied.body.canUnpin, true);
        assert.equal(occupied.body.pin.pinId, pin.pinId);
        assert.deepEqual(Object.keys(occupied.body.pin).sort(), [
          'level',
          'pinId',
          'pinnedUntil',
          'postId',
        ]);
        assert.equal('canPin' in occupied.body, false);
        assert.equal('text' in occupied.body, false);
        assert.equal('author' in occupied.body, false);
        assert.equal(
          (await send(command(b.id))).body.code,
          'POST_PIN_CONFLICT',
        );
        ok(
          await send(
            {
              operation: 'read',
              postId: a.id,
              pinId: pin.pinId,
              clientRequestId: randomUUID(),
            },
            reader,
          ),
          404,
        );
        const close = await send({
          operation: 'unpin',
          postId: a.id,
          pinId: pin.pinId,
          clientRequestId: randomUUID(),
        });
        ok(close);
        assert.equal(close.body.outcome, 'applied');
        assert.equal('text' in close.body, false);
        const next = await send(command(b.id));
        ok(next);
        pin = next.body;
        await setReviewState(f.pool, b.approval.decisionId, 'revoked');
        assert.equal((await slot()).body.pin.pinId, pin.pinId);
        assert.equal((await list()).body.items.length, 0);
        ok(
          await send({
            operation: 'unpin',
            postId: b.id,
            pinId: pin.pinId,
            clientRequestId: randomUUID(),
          }),
        );
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
            [a.id],
          ),
        );
      },
    );
    await t.test(
      'deletion releases slot and old response replay cannot revive it',
      async () => {
        const p = await send(command(a.id));
        ok(p);
        const del = await request(http)
          .delete('/v1/community/posts/' + a.id)
          .set('Authorization', `Bearer ${author.accessToken}`);
        ok(del, 204);
        assert.equal((await list()).body.items.length, 0);
        assert.equal(
          (
            await f.pool.query(
              'SELECT reason FROM whaleu_community.post_pin_closures WHERE pin_id=$1',
              [p.body.pinId],
            )
          ).rows[0].reason,
          'deleted',
        );
        assert.deepEqual((await send(firstCommand)).body, first);
      },
    );
    await t.test(
      'urgent trade pins occupy the same region slot but obey exact category/subtype filters',
      async () => {
        const q = command(trade.id, { durationHours: 1, level: 1 }),
          r = await send(q);
        ok(r);
        assert.equal((await list()).body.items.length, 0);
        const page = await list(f.scope.home.spaceId, {
          category: 'trading',
          tradingSubtype: 'shuma',
        });
        ok(page);
        assert.equal(page.body.items[0].post.id, trade.id);
        assert.equal(page.body.items[0].post.trading.price.amount, '12.5');
        assert.equal('contacts' in page.body.items[0].post.trading, false);
        assert.equal(
          (
            await list(f.scope.home.spaceId, {
              category: 'trading',
              tradingSubtype: 'yifu',
            })
          ).body.items.length,
          0,
        );
        ok(
          await send({
            operation: 'unpin',
            postId: trade.id,
            pinId: r.body.pinId,
            clientRequestId: randomUUID(),
          }),
        );
        assert.deepEqual((await send(q)).body, r.body);
        assert.equal(
          (await list(f.scope.home.spaceId, { category: 'trading' })).body.items
            .length,
          0,
        );
      },
    );
    await t.test(
      'expiry suppresses presentation without cleanup, and original receipt replay cannot renew it',
      async () => {
        await f.pool.query(
          "CREATE FUNCTION whaleu_community.pin_test_expiring() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.pinned_until:=clock_timestamp()+interval '700 milliseconds';NEW.pinned_at:=NEW.pinned_until-NEW.duration_hours*interval '1 hour';RETURN NEW;END$$;CREATE TRIGGER a_pin_test_expiring BEFORE INSERT ON whaleu_community.post_pins FOR EACH ROW EXECUTE FUNCTION whaleu_community.pin_test_expiring()",
        );
        const q = command(trade.id);
        let result;
        try {
          result = await send(q);
          ok(result);
        } finally {
          await f.pool.query(
            'DROP TRIGGER a_pin_test_expiring ON whaleu_community.post_pins;DROP FUNCTION whaleu_community.pin_test_expiring()',
          );
        }
        await f.pool.query('SELECT pg_sleep(0.8)');
        assert.equal(
          (await list(f.scope.home.spaceId, { category: 'trading' })).body.items
            .length,
          0,
        );
        assert.deepEqual((await send(q)).body, result.body);
        assert.equal((await detail(trade.id, admin)).body.pin, null);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.post_pin_closures WHERE pin_id=$1',
              [result.body.pinId],
            )
          ).rowCount,
          0,
          'no cleanup worker was invoked',
        );
      },
    );
    await t.test(
      'durable cancellation prevents a delayed original; concurrent new keys have exactly one changing winner',
      async () => {
        const c = await f.publish(author),
          d = await f.publish(author);
        const cancelled = command(c.id);
        const result = await request(http)
          .post(
            `/v1/me/community/post-pin-requests/${cancelled.clientRequestId}/cancel`,
          )
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send(cancelled);
        ok(result);
        assert.equal(result.body.code, 'POST_PIN_CANCELLED');
        assert.deepEqual((await send(cancelled)).body, result.body);
        const results = await Promise.all([
          send(command(c.id)),
          send(command(d.id)),
        ]);
        results.forEach((r) => ok(r));
        assert.deepEqual(results.map((r) => r.body.outcome).sort(), [
          'applied',
          'rejected',
        ]);
        const winner = results.find((r) => r.body.outcome === 'applied')!.body;
        ok(
          await send(
            {
              operation: 'unpin',
              postId: winner.postId,
              pinId: winner.pinId,
              clientRequestId: randomUUID(),
            },
            reader,
          ),
          403,
        );
      },
    );
  },
);
