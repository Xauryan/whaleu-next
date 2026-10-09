import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import {
  approveRating,
  setRatingReviewState,
} from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { AuthorDisplayService } from '../../src/profile/author-display.service.js';
import { inTransaction } from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { RatingDiscussionService } from '../../src/ratings/discussion-service.js';
import {
  ratingReplyPageSchema,
  ratingReplySchema,
  ratingReplyReceiptSchema,
} from '../../src/ratings/discussion-contracts.js';

test('rating replies normal HTTP: typed ancestry, recovery, privacy, continuation and tombstones', async (t) => {
  const f = await ratingDiscussionFixture();
  t.after(() => f.close());
  const a = await f.actor(),
    b = await f.actor(),
    c = await f.actor(),
    catalog = await f.catalog(a, { count: 2 }),
    target = catalog.targets[0]!,
    otherTarget = catalog.targets[1]!;
  const root = await f.publish(
      a,
      catalog,
      target,
      f.body(catalog, target, { authorMode: 'anonymous' }),
    ),
    otherRoot = await f.publish(a, catalog, target),
    foreignRoot = await f.publish(a, catalog, otherTarget);
  const get = (path: string, actor = b, query: Record<string, unknown> = {}) =>
    f.auth(request(f.http).get(path), actor).query(query);
  const scoreBefore = (
    await f.pool.query(
      'SELECT * FROM whaleu_ratings.score_summaries ORDER BY target_id',
    )
  ).rows;
  const r1 = await f.publishReply(
    b,
    catalog,
    target,
    root,
    f.replyBody(catalog, target, root, {
      authorMode: 'anonymous',
      body: '  First\r\nreply 😀  ',
    }),
  );
  const r2 = await f.publishReply(
    c,
    catalog,
    target,
    root,
    f.replyBody(catalog, target, root, {
      replyTo: { replyId: r1.id, expectedRevision: r1.revision },
    }),
  );
  await t.test(
    'database canonical text matches transport Unicode boundaries without rewriting stored text',
    async () => {
      for (const [body, expected] of [
        ['v', true],
        ['😀'.repeat(500), true],
        ['😀'.repeat(501), false],
        ['inside\ttext\nline', true],
        [' leading', false],
        ['trailing\n', false],
        ['\ufefftext', false],
        ['\u2000text', false],
        ['inside\r\nline', false],
        ['bad\u0085text', false],
        ['vertical\vtab', false],
      ] as const) {
        assert.equal(
          (
            await f.pool.query(
              'SELECT whaleu_ratings.canonical_text($1,500) valid',
              [body],
            )
          ).rows[0]!.valid,
          expected,
          JSON.stringify(body),
        );
      }
    },
  );
  await t.test(
    'discussion root stays R1 shaped, reply ancestry is explicit, target persona remains private',
    async () => {
      const context = await get(`/v1/ratings/comments/${root.id}/discussion`);
      assert.equal(context.status, 200, JSON.stringify(context.body));
      assert.equal(context.body.root.id, root.id);
      assert.equal(context.body.allowedActions.createReply, true);
      assert.equal(context.body.root.replyCount, undefined);
      const one = await get(`/v1/ratings/replies/${r1.id}`);
      assert.equal(one.status, 200, JSON.stringify(one.body));
      ratingReplySchema.parse(one.body);
      assert.equal(one.body.body, 'First\nreply 😀');
      assert.deepEqual(one.body.replyTo, { kind: 'root' });
      assert.equal(one.body.author.mode, 'anonymous');
      assert.equal(one.body.isMine, true);
      const another = await f.publishReply(
        b,
        catalog,
        target,
        otherRoot,
        f.replyBody(catalog, target, otherRoot, { authorMode: 'anonymous' }),
      );
      const same = await get(`/v1/ratings/replies/${another.id}`);
      assert.equal(same.body.author.personaId, one.body.author.personaId);
      const foreign = await f.publishReply(
        b,
        catalog,
        otherTarget,
        foreignRoot,
        f.replyBody(catalog, otherTarget, foreignRoot, {
          authorMode: 'anonymous',
        }),
      );
      assert.notEqual(
        (await get(`/v1/ratings/replies/${foreign.id}`)).body.author.personaId,
        one.body.author.personaId,
      );
      const encoded = JSON.stringify(
        (await get(`/v1/ratings/replies/${r2.id}`)).body,
      );
      assert.ok(!encoded.includes(b.accountId));
      assert.ok(!encoded.includes('recipient'));
      assert.ok(!encoded.includes('original_user_id'));
    },
  );
  await t.test(
    'strict commands reject forged recipients/assets/extra keys and wrong typed ancestry',
    async () => {
      for (const patch of [
        { recipient: b.accountId },
        { reply_to_user_id: b.accountId },
        { username: 'fake' },
        { assetIds: [randomUUID()] },
        {
          replyTo: {
            replyId: r1.id,
            expectedRevision: r1.revision,
            accountId: b.accountId,
          },
        },
        { body: '\ud800' },
        { body: 'x'.repeat(501) },
      ]) {
        const res = await f
          .auth(
            request(f.http).post(`/v1/ratings/comments/${root.id}/replies`),
            b,
          )
          .send({ ...f.replyBody(catalog, target, root), ...patch });
        assert.equal(res.status, 400, JSON.stringify(res.body));
      }
      const wrong = f.replyBody(catalog, target, otherRoot, {
        replyTo: { replyId: r1.id, expectedRevision: r1.revision },
      });
      await approveRating(
        f.pool,
        f.replyEnvelope(b, catalog, target, otherRoot, wrong),
      );
      const res = await f
        .auth(
          request(f.http).post(`/v1/ratings/comments/${otherRoot.id}/replies`),
          b,
        )
        .send(wrong);
      assert.equal(res.body.outcome, 'rejected');
      assert.equal(res.body.code, 'RATING_NOT_FOUND');
      const foreign = f.replyBody(catalog, otherTarget, root);
      const cross = await f
        .auth(
          request(f.http).post(`/v1/ratings/comments/${root.id}/replies`),
          b,
        )
        .send(foreign);
      assert.equal(cross.body.code, 'RATING_NOT_FOUND');
    },
  );
  await t.test(
    'same-key replay is exact, recovery routes are disjoint and cross-operation namespace conflicts',
    async () => {
      const before = (
        await f.pool.query(
          'SELECT count(*) n FROM whaleu_ratings.effect_events',
        )
      ).rows;
      const retry = await f
        .auth(
          request(f.http).post(`/v1/ratings/comments/${root.id}/replies`),
          b,
        )
        .send(r1.input);
      assert.deepEqual(retry.body, r1.receipt);
      ratingReplyReceiptSchema.parse(retry.body);
      assert.deepEqual(
        (await get(`/v1/ratings/reply-requests/${r1.input.clientRequestId}`))
          .body,
        r1.receipt,
      );
      assert.equal(
        (await get(`/v1/ratings/requests/${r1.input.clientRequestId}`)).body
          .error.code,
        'REQUEST_NOT_FOUND',
      );
      assert.equal(
        (
          await get(
            `/v1/ratings/reply-requests/${root.input.clientRequestId}`,
            a,
          )
        ).body.error.code,
        'REQUEST_NOT_FOUND',
      );
      assert.equal(
        (await get(`/v1/ratings/reply-requests/${r1.input.clientRequestId}`, c))
          .body.error.code,
        'REQUEST_NOT_FOUND',
      );
      const conflict = await f
        .auth(
          request(f.http).post(`/v1/ratings/comments/${root.id}/replies`),
          b,
        )
        .send({ ...r1.input, body: 'Changed intent' });
      assert.equal(conflict.body.error.code, 'REQUEST_CONFLICT');
      const mixed = await f
        .auth(
          request(f.http).post(`/v1/ratings/targets/${target.id}/comments`),
          b,
        )
        .send(
          f.body(catalog, target, {
            clientRequestId: r1.input.clientRequestId,
          }),
        );
      assert.equal(mixed.body.error.code, 'REQUEST_CONFLICT');
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT count(*) n FROM whaleu_ratings.effect_events',
          )
        ).rows,
        before,
      );
      assert.deepEqual(Object.keys(r1.receipt).sort(), [
        'occurredAt',
        'operation',
        'outcome',
        'replyId',
        'requestId',
        'revision',
        'rootId',
        'targetId',
      ]);
    },
  );
  await t.test(
    'oldest pages and inclusive position are bounded; cursors bind account/limit/root and lifecycle',
    async () => {
      const first = await get(`/v1/ratings/comments/${root.id}/replies`, b, {
        limit: 1,
      });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      ratingReplyPageSchema.parse(first.body);
      assert.equal(first.body.items[0].id, r1.id);
      assert.equal(first.body.continuation, 'more');
      const next = await get(`/v1/ratings/comments/${root.id}/replies`, b, {
        limit: 1,
        cursor: first.body.nextCursor,
      });
      assert.equal(next.body.items[0].id, r2.id);
      assert.equal(next.body.continuation, 'end');
      const position = await get(`/v1/ratings/replies/${r2.id}/position`, b, {
        limit: 1,
      });
      assert.equal(position.body.page.items[0].id, r2.id);
      for (const [id, actor, limit] of [
        [root.id, c, 1],
        [root.id, b, 2],
        [otherRoot.id, b, 1],
      ] as const) {
        assert.equal(
          (
            await get(`/v1/ratings/comments/${id}/replies`, actor, {
              limit,
              cursor: first.body.nextCursor,
            })
          ).body.error.code,
          'DISCOVERY_RESTART_REQUIRED',
        );
      }
      await f.publishReply(c, catalog, target, root);
      assert.equal(
        (
          await get(`/v1/ratings/comments/${root.id}/replies`, b, {
            limit: 1,
            cursor: first.body.nextCursor,
          })
        ).body.error.code,
        'DISCOVERY_RESTART_REQUIRED',
      );
    },
  );
  await t.test(
    'known hidden-only scan advances while review changes invalidate negative continuation',
    async () => {
      await setRatingReviewState(f.pool, r1.approval.decisionId, 'held');
      const page = await get(`/v1/ratings/comments/${root.id}/replies`, b, {
        limit: 1,
      });
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.equal(page.body.items.length, 0);
      assert.equal(page.body.continuation, 'scan');
      await setRatingReviewState(f.pool, r1.approval.decisionId, 'allow');
      assert.equal(
        (
          await get(`/v1/ratings/comments/${root.id}/replies`, b, {
            limit: 1,
            cursor: page.body.nextCursor,
          })
        ).body.error.code,
        'DISCOVERY_RESTART_REQUIRED',
      );
    },
  );
  await t.test(
    'incoming named-root block keeps list read separate from reply/direct access and invalidates cursors',
    async () => {
      const profileId = (
        await inTransaction(f.pool, async (tx) => {
          await lockSafetyPolicy(tx);
          return f.app.get(AuthorDisplayService).prepare(b.accountId, tx);
        })
      ).profileId;
      const blockId = randomUUID();
      await withCommunityScopeWriter(f.pool, async (tx) => {
        await tx.query(
          "INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,revision,display_snapshot,source_kind,source_id) VALUES($1,$2,$3,true,1,'Synthetic rating root blocker','profile',$4)",
          [blockId, a.accountId, b.accountId, profileId],
        );
        await tx.query(
          "INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) VALUES($1,$2,$3,'blocked',1)",
          [randomUUID(), a.accountId, blockId],
        );
      });
      try {
        const thread = await get(
          `/v1/ratings/comments/${otherRoot.id}/discussion`,
        );
        assert.equal(thread.status, 200, JSON.stringify(thread.body));
        assert.equal(thread.body.allowedActions.createReply, false);
        const page = await get(`/v1/ratings/comments/${otherRoot.id}/replies`);
        assert.equal(page.status, 200, JSON.stringify(page.body));
        assert.equal(page.body.items[0].allowedActions.reply, false);
        const id = page.body.items[0].id as string;
        assert.equal(
          (await get(`/v1/ratings/replies/${id}`)).body.error.code,
          'RATING_NOT_FOUND',
        );
        assert.equal(
          (await get(`/v1/ratings/replies/${id}/position`)).body.error.code,
          'RATING_NOT_FOUND',
        );
        const command = f.replyBody(catalog, target, otherRoot);
        assert.equal(
          (
            await f
              .auth(
                request(f.http).post(
                  `/v1/ratings/comments/${otherRoot.id}/replies`,
                ),
                b,
              )
              .send(command)
          ).body.code,
          'RATING_NOT_FOUND',
        );
      } finally {
        await withCommunityScopeWriter(f.pool, async (tx) => {
          await tx.query(
            'UPDATE whaleu_safety.blocks SET active=false,revision=2 WHERE id=$1',
            [blockId],
          );
          await tx.query(
            "INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) VALUES($1,$2,$3,'unblocked',2)",
            [randomUUID(), a.accountId, blockId],
          );
        });
      }
    },
  );
  await t.test(
    'unknown approval stays uncertain; canonical scope/phone/parent revision fail closed',
    async () => {
      const missing = f.replyBody(catalog, target, root);
      const response = await f
        .auth(
          request(f.http).post(`/v1/ratings/comments/${root.id}/replies`),
          b,
        )
        .send(missing);
      assert.equal(response.body.error.code, 'CONTENT_REVIEW_UNAVAILABLE');
      assert.equal(
        (await get(`/v1/ratings/reply-requests/${missing.clientRequestId}`))
          .body.error.code,
        'REQUEST_NOT_FOUND',
      );
      const wrong = f.replyBody(catalog, target, root, {
        expectedRootRevision: randomUUID(),
      });
      assert.equal(
        (
          await f
            .auth(
              request(f.http).post(`/v1/ratings/comments/${root.id}/replies`),
              b,
            )
            .send(wrong)
        ).body.code,
        'RATING_REVISION_CONFLICT',
      );
      const noPhone = await f.actor({ phone: 'unverified' });
      assert.equal(
        (await get(`/v1/ratings/comments/${root.id}/replies`, noPhone)).body
          .error.code,
        'PHONE_VERIFICATION_REQUIRED',
      );
    },
  );
  await t.test(
    'single reply deletion preserves later replies and removes all quoted identity; noop uses original time',
    async () => {
      const bad = await f.deleteReply(c, catalog, target, root, r1);
      assert.equal(bad.code, 'RATING_NOT_FOUND');
      const deleted = await f.deleteReply(b, catalog, target, root, r1);
      assert.equal(deleted.outcome, 'applied');
      assert.equal(
        (await get(`/v1/ratings/replies/${r1.id}`)).body.error.code,
        'RATING_NOT_FOUND',
      );
      const later = await get(`/v1/ratings/replies/${r2.id}`);
      assert.equal(later.status, 200, JSON.stringify(later.body));
      assert.deepEqual(later.body.replyTo, {
        kind: 'reply',
        status: 'unavailable',
      });
      assert.equal(later.body.allowedActions.reply, true);
      await f.publishReply(
        b,
        catalog,
        target,
        root,
        f.replyBody(catalog, target, root, {
          replyTo: { replyId: r2.id, expectedRevision: r2.revision },
        }),
      );
      const noop = await f.deleteReply(b, catalog, target, root, {
        id: r1.id,
        revision: deleted.revision,
      });
      assert.equal(noop.outcome, 'noop');
      assert.equal(noop.occurredAt, deleted.occurredAt);
      assert.equal(noop.revision, deleted.revision);
    },
  );
  await t.test(
    'raw immutable source, registry, ancestry and receipt forgeries fail closed',
    async () => {
      for (const sql of [
        'UPDATE whaleu_ratings.replies SET reply_to_id=id WHERE id=$1',
        "UPDATE whaleu_ratings.replies SET body='changed' WHERE id=$1",
        'DELETE FROM whaleu_ratings.replies WHERE id=$1',
        'UPDATE whaleu_ratings.reply_transitions SET revision=gen_random_uuid() WHERE reply_id=$1',
        'UPDATE whaleu_ratings.effect_events SET root_author_id=actor_account_id WHERE reply_id=$1',
        'DELETE FROM whaleu_ratings.reward_groups WHERE reply_id=$1',
      ]) {
        await assert.rejects(f.pool.query(sql, [r2.id]));
      }
      await assert.rejects(
        f.pool.query(
          "UPDATE whaleu_experience.source_units SET source_domain='community' WHERE source_domain='ratings'",
        ),
      );
      await assert.rejects(
        f.pool.query(
          "INSERT INTO whaleu_notifications.rating_processing_receipts(event_id,recipient_account_id,reason,outcome) SELECT event_id,recipient_account_id,reason,'materialized' FROM whaleu_ratings.notice_obligations LIMIT 1",
        ),
      );
    },
  );
  await t.test(
    'root tombstone hides all descendants without touching score/experience capture; receipt still recovers',
    async () => {
      const deleted = await f.deleteRoot(a, catalog, target, root);
      assert.equal(deleted.outcome, 'applied');
      for (const path of [
        `/v1/ratings/comments/${root.id}/discussion`,
        `/v1/ratings/comments/${root.id}/replies`,
        `/v1/ratings/replies/${r2.id}`,
        `/v1/ratings/replies/${r2.id}/position`,
      ])
        assert.equal((await get(path)).body.error.code, 'RATING_NOT_FOUND');
      const fresh = await f
        .auth(
          request(f.http).post(`/v1/ratings/comments/${root.id}/replies`),
          b,
        )
        .send(f.replyBody(catalog, target, root));
      assert.equal(fresh.body.code, 'RATING_NOT_FOUND');
      assert.deepEqual(
        (await get(`/v1/ratings/reply-requests/${r1.input.clientRequestId}`))
          .body,
        r1.receipt,
      );
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_ratings.score_summaries ORDER BY target_id',
          )
        ).rows,
        scoreBefore,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::integer n FROM whaleu_ratings.reward_units WHERE action LIKE 'delete_%'",
          )
        ).rows[0]!.n,
        0,
      );
    },
  );
  // Explicit service check: no supported isolation/proof path may silently bypass a missing root.
  await assert.rejects(
    f.app
      .get(RatingDiscussionService)
      .listReplies(b.accessToken, randomUUID(), { limit: 20 }),
  );
});
