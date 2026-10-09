import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  ratingRuntimeFixture,
  approveRating,
  setRatingReviewState,
} from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { RatingsService } from '../../src/ratings/service.js';
import { ratingReceiptSchema } from '../../src/ratings/contracts.js';
import { inTransaction } from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';

test('ratings R1 canonical HTTP, independent scores, text and durable recovery', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const owner = await f.actor(),
    other = await f.actor(),
    unverified = await f.actor({ affiliation: 'unverified', identity: false }),
    noPhone = await f.actor({ phone: 'unverified' });
  const c = await f.catalog(owner, { count: 3, depth: 3 }),
    target = c.targets[0]!,
    target2 = c.targets[1]!;
  const get = (
    path: string,
    actor = owner,
    query: Record<string, unknown> = {},
  ) => f.auth(request(f.http).get(path), actor).query(query);
  const score = (
    actor = owner,
    value = 1,
    revision: string | null = null,
    id = target.id,
    expectedTargetRevision = target.revision,
    key = randomUUID(),
  ) =>
    f
      .auth(request(f.http).put(`/v1/ratings/targets/${id}/my-score`), actor)
      .send({
        clientRequestId: key,
        regionId: null,
        expectedTargetRevision,
        expectedRevision: revision,
        score: value,
      });
  const snapshot = async () => ({
    scores: (
      await f.pool.query(
        'SELECT *,created_at::text,updated_at::text FROM whaleu_ratings.scores ORDER BY target_id,account_id',
      )
    ).rows,
    summary: (
      await f.pool.query(
        'SELECT * FROM whaleu_ratings.score_summaries ORDER BY target_id',
      )
    ).rows,
    events: (
      await f.pool.query(
        'SELECT * FROM whaleu_ratings.score_transitions ORDER BY sequence',
      )
    ).rows,
  });
  let first: Record<string, unknown>,
    changed: Record<string, unknown>,
    comment: Awaited<ReturnType<typeof f.publish>>;
  await t.test(
    'authentication, global/category phone exemption, three-level direct navigation',
    async () => {
      assert.equal(
        (await request(f.http).get('/v1/ratings/categories')).status,
        401,
      );
      const root = await get('/v1/ratings/categories', noPhone);
      assert.equal(root.status, 200, JSON.stringify(root.body));
      assert.equal(root.body.items[0].id, c.rootId);
      assert.equal(root.body.context.parentId, null);
      const level2 = await get('/v1/ratings/categories', owner, {
        parentId: c.rootId,
      });
      assert.equal(level2.body.items[0].level, 2);
      const level3 = await get('/v1/ratings/categories', owner, {
        parentId: c.categoryIds[1],
      });
      assert.equal(level3.body.items[0].id, c.categoryId);
      assert.equal(
        (await get(`/v1/ratings/targets/${target.id}`, noPhone)).body.error
          .code,
        'PHONE_VERIFICATION_REQUIRED',
      );
      const detail = await get(`/v1/ratings/targets/${target.id}`, unverified);
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      assert.deepEqual(detail.body.allowedActions.authorModes, ['named']);
      assert.equal(
        (await get(`/v1/ratings/targets/${target.id}/my-score`)).body.myScore,
        null,
      );
      const summary = await get(
        `/v1/ratings/targets/${target.id}/score-summary`,
      );
      assert.equal(summary.body.status, 'known');
      assert.equal(summary.body.count, 0);
      assert.equal(summary.body.average, null);
    },
  );
  await t.test(
    'strict invalid scores and additional unknown fields never mutate',
    async () => {
      for (const value of [0, 6, 1.5, '5', null]) {
        const r = await f
          .auth(
            request(f.http).put(`/v1/ratings/targets/${target.id}/my-score`),
            owner,
          )
          .send({
            clientRequestId: randomUUID(),
            regionId: null,
            expectedTargetRevision: target.revision,
            expectedRevision: null,
            score: value,
          });
        assert.equal(r.status, 400);
      }
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_ratings.scores',
          )
        ).rows[0]!.n,
        0,
      );
    },
  );
  await t.test(
    'first score, true noop, same-key recovery and different payload conflict',
    async () => {
      const key = randomUUID(),
        r = await score(owner, 1, null, target.id, target.revision, key);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      first = ratingReceiptSchema.parse(r.body);
      assert.equal(first['outcome'], 'applied');
      const before = await snapshot();
      const noop = await score(owner, 1, first['revision'] as string);
      assert.equal(noop.body.outcome, 'noop');
      assert.equal(noop.body.occurredAt, first['occurredAt']);
      assert.equal(noop.body.revision, first['revision']);
      assert.deepEqual(await snapshot(), before);
      const replay = await score(
        owner,
        1,
        null,
        target.id,
        target.revision,
        key,
      );
      assert.deepEqual(replay.body, first);
      assert.equal(
        (await score(owner, 5, null, target.id, target.revision, key)).body
          .error.code,
        'REQUEST_CONFLICT',
      );
      const receipt = await get(`/v1/ratings/requests/${key}`);
      assert.deepEqual(receipt.body, first);
      assert.equal(
        (await get(`/v1/ratings/requests/${key}`, other)).status,
        404,
      );
    },
  );
  await t.test(
    'change migrates buckets without increasing people; stale revisions reject',
    async () => {
      const r = await score(owner, 5, first['revision'] as string);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      changed = r.body;
      assert.equal(r.body.outcome, 'applied');
      const stale = await score(owner, 5, first['revision'] as string);
      assert.equal(stale.body.outcome, 'rejected');
      assert.equal(stale.body.code, 'RATING_REVISION_CONFLICT');
      const summary = (
        await get(`/v1/ratings/targets/${target.id}/score-summary`)
      ).body;
      assert.equal(summary.count, 1);
      assert.equal(summary.sum, 5);
      assert.deepEqual(summary.distribution, {
        '1': 0,
        '2': 0,
        '3': 0,
        '4': 0,
        '5': 1,
      });
      assert.equal(
        (await get(`/v1/ratings/targets/${target.id}/comments`)).body.items
          .length,
        0,
      );
    },
  );
  await t.test(
    'global named publication is independent of affiliation and score',
    async () => {
      comment = await f.publish(unverified, c, target2);
      const read = await get(`/v1/ratings/comments/${comment.id}`, unverified);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(read.body.author.mode, 'named');
      assert.equal(read.body.isMine, true);
      assert.equal(read.body.allowedActions.delete, true);
      assert.equal(
        (await get(`/v1/ratings/targets/${target2.id}/my-score`, unverified))
          .body.myScore,
        null,
      );
      const own = await f.publish(owner, c, target);
      comment = own;
    },
  );
  await t.test(
    'normal AppModule has no approval fallback, latest pending blocks earlier allow',
    async () => {
      const input = f.body(c, target, { body: 'Exact reviewed content' });
      let r = await f
        .auth(
          request(f.http).post(`/v1/ratings/targets/${target.id}/comments`),
          owner,
        )
        .send(input);
      assert.equal(r.status, 503);
      assert.equal(r.body.error.code, 'CONTENT_REVIEW_UNAVAILABLE');
      await approveRating(f.pool, f.envelope(owner, c, target, input));
      await approveRating(f.pool, f.envelope(owner, c, target, input), {
        result: 'pending',
      });
      r = await f
        .auth(
          request(f.http).post(`/v1/ratings/targets/${target.id}/comments`),
          owner,
        )
        .send(input);
      assert.equal(r.status, 503);
      const changedInput = { ...input, body: 'Slightly changed text' };
      r = await f
        .auth(
          request(f.http).post(`/v1/ratings/targets/${target.id}/comments`),
          owner,
        )
        .send(changedInput);
      assert.equal(r.status, 503);
      const rejected = f.body(c, target, { body: 'Rejected exact intent' });
      await approveRating(f.pool, f.envelope(owner, c, target, rejected), {
        result: 'reject',
      });
      r = await f
        .auth(
          request(f.http).post(`/v1/ratings/targets/${target.id}/comments`),
          owner,
        )
        .send(rejected);
      assert.equal(r.body.outcome, 'rejected');
      assert.equal(r.body.code, 'CONTENT_REJECTED');
    },
  );
  await t.test(
    'anonymous personas stable within target and unlinkable across targets',
    async () => {
      const a = await f.publish(
          owner,
          c,
          target,
          f.body(c, target, { authorMode: 'anonymous', body: 'Anonymous one' }),
        ),
        b = await f.publish(
          owner,
          c,
          target,
          f.body(c, target, { authorMode: 'anonymous', body: 'Anonymous two' }),
        ),
        d = await f.publish(
          owner,
          c,
          target2,
          f.body(c, target2, {
            authorMode: 'anonymous',
            body: 'Anonymous another target',
          }),
        );
      const views = [];
      for (const x of [a, b, d])
        views.push(await get(`/v1/ratings/comments/${x.id}`, other));
      for (const r of views) {
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.author.mode, 'anonymous');
        assert.ok(!JSON.stringify(r.body).includes(owner.accountId));
        assert.deepEqual(Object.keys(r.body.author).sort(), [
          'displayName',
          'mode',
          'personaId',
          'targetId',
        ]);
      }
      assert.equal(
        views[0]!.body.author.personaId,
        views[1]!.body.author.personaId,
      );
      assert.notEqual(
        views[0]!.body.author.personaId,
        views[2]!.body.author.personaId,
      );
    },
  );
  await t.test(
    'own deletion is idempotent and retains independent score; receipts never replay body',
    async () => {
      const body = {
        clientRequestId: randomUUID(),
        regionId: null,
        targetId: target.id,
        expectedTargetRevision: target.revision,
        expectedRevision: comment.revision,
      };
      const foreign = await f
        .auth(
          request(f.http).delete(`/v1/ratings/comments/${comment.id}`),
          other,
        )
        .send(body);
      assert.equal(foreign.body.code, 'RATING_NOT_FOUND');
      const before = (
        await get(`/v1/ratings/targets/${target.id}/score-summary`)
      ).body;
      const deleted = await f
        .auth(
          request(f.http).delete(`/v1/ratings/comments/${comment.id}`),
          owner,
        )
        .send(body);
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      assert.equal(deleted.body.outcome, 'applied');
      assert.equal(
        (await get(`/v1/ratings/comments/${comment.id}`)).status,
        404,
      );
      const noop = await f
        .auth(
          request(f.http).delete(`/v1/ratings/comments/${comment.id}`),
          owner,
        )
        .send({
          ...body,
          clientRequestId: randomUUID(),
          expectedRevision: deleted.body.revision,
        });
      assert.equal(noop.body.outcome, 'noop');
      assert.equal(noop.body.occurredAt, deleted.body.occurredAt);
      assert.deepEqual(
        (await get(`/v1/ratings/targets/${target.id}/score-summary`)).body,
        before,
      );
      const replay = await get(
        `/v1/ratings/requests/${comment.input.clientRequestId}`,
      );
      assert.equal(replay.status, 200);
      assert.ok(!JSON.stringify(replay.body).includes(comment.input.body));
    },
  );
  await t.test(
    'concurrent same actor CAS and different actors preserve exact summary',
    async () => {
      const results = await Promise.all([
        score(owner, 2, changed['revision'] as string),
        score(owner, 4, changed['revision'] as string),
      ]);
      assert.equal(
        results.filter((r) => r.body.outcome === 'applied').length,
        1,
      );
      assert.equal(
        results.filter((r) => r.body.code === 'RATING_REVISION_CONFLICT')
          .length,
        1,
      );
      const others = await Promise.all([f.actor(), f.actor(), f.actor()]);
      const r = await Promise.all(others.map((a, i) => score(a, i + 1)));
      assert.ok(
        r.every((x) => x.body.outcome === 'applied'),
        JSON.stringify(r.map((x) => x.body)),
      );
      const actual = (
          await f.pool.query(
            'SELECT count(*)::integer n,sum(score)::integer sum FROM whaleu_ratings.scores WHERE target_id=$1',
            [target.id],
          )
        ).rows[0]!,
        summary = (await get(`/v1/ratings/targets/${target.id}/score-summary`))
          .body;
      assert.equal(summary.count, actual.n);
      assert.equal(summary.sum, actual.sum);
    },
  );
  await t.test(
    'opaque cursors bind viewer, locator, limit and lifecycle negative facts',
    async () => {
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_ratings.targets SET active=false,revision=$2 WHERE id=$1',
          [target.id, randomUUID()],
        ),
      );
      const page = await get('/v1/ratings/targets', owner, {
        categoryId: c.categoryId,
        limit: 1,
      });
      assert.equal(page.status, 200, JSON.stringify(page.body));
      assert.ok(page.body.nextCursor);
      assert.equal(
        (
          await get('/v1/ratings/targets', other, {
            categoryId: c.categoryId,
            limit: 1,
            cursor: page.body.nextCursor,
          })
        ).body.error.code,
        'DISCOVERY_RESTART_REQUIRED',
      );
      assert.equal(
        (
          await get('/v1/ratings/targets', owner, {
            categoryId: c.categoryId,
            limit: 2,
            cursor: page.body.nextCursor,
          })
        ).body.error.code,
        'DISCOVERY_RESTART_REQUIRED',
      );
      await assert.rejects(
        withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_ratings.targets SET active=true,revision=$2 WHERE id=$1',
            [target.id, target.revision],
          ),
        ),
      );
      const oldRevision = target.revision;
      target.revision = randomUUID();
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_ratings.targets SET active=true,revision=$2 WHERE id=$1',
          [target.id, target.revision],
        ),
      );
      const stale = await score(
        owner,
        5,
        changed['revision'] as string,
        target.id,
        oldRevision,
      );
      assert.equal(stale.body.code, 'RATING_REVISION_CONFLICT');
      assert.equal(
        (
          await get('/v1/ratings/targets', owner, {
            categoryId: c.categoryId,
            limit: 1,
            cursor: page.body.nextCursor,
          })
        ).body.error.code,
        'DISCOVERY_RESTART_REQUIRED',
      );
    },
  );
  await t.test(
    'known review deny filters and invalidates cursor instead of claiming empty unknown',
    async () => {
      const page = await get('/v1/ratings/targets', owner, {
        categoryId: c.categoryId,
        limit: 1,
      });
      assert.ok(page.body.nextCursor);
      await setRatingReviewState(f.pool, target2.approval.decisionId, 'held');
      assert.equal(
        (
          await get('/v1/ratings/targets', owner, {
            categoryId: c.categoryId,
            limit: 1,
            cursor: page.body.nextCursor,
          })
        ).body.error.code,
        'DISCOVERY_RESTART_REQUIRED',
      );
      assert.equal(
        (await get(`/v1/ratings/targets/${target2.id}`)).status,
        404,
      );
      await setRatingReviewState(f.pool, target2.approval.decisionId, 'allow');
    },
  );
  await t.test(
    'raw summary writes, fake transitions, no-op update, fake receipts and score deletion fail',
    async () => {
      const before = await snapshot();
      for (const sql of [
        'UPDATE whaleu_ratings.score_summaries SET count=count+1,b1=b1+1,sum=sum+1',
        'UPDATE whaleu_ratings.scores SET score=score',
        'DELETE FROM whaleu_ratings.scores',
      ])
        await assert.rejects(f.pool.query(sql));
      await assert.rejects(
        inTransaction(f.pool, async (tx) => {
          const key = randomUUID();
          await tx.query(
            `INSERT INTO whaleu_ratings.requests VALUES($1,$2,'set_score',$3,$4)`,
            [
              owner.accountId,
              key,
              'a'.repeat(64),
              JSON.stringify({
                requestId: key,
                operation: 'set_score',
                outcome: 'noop',
                targetId: randomUUID(),
                subjectId: randomUUID(),
                revision: randomUUID(),
                occurredAt: '2026-10-08T00:00:00Z',
              }),
            ],
          );
        }),
      );
      assert.deepEqual(await snapshot(), before);
    },
  );
  await t.test(
    'accepted historical directory never fabricates zero or permits scoring',
    async () => {
      const h = await f.catalog(owner, { baseline: false }),
        target = h.targets[0]!;
      const summary = await get(
        `/v1/ratings/targets/${target.id}/score-summary`,
      );
      assert.deepEqual(summary.body, { status: 'unavailable' });
      assert.equal(
        (await get(`/v1/ratings/targets/${target.id}/my-score`)).body.error
          .code,
        'RATING_SCORE_UNAVAILABLE',
      );
      const detail = await get(`/v1/ratings/targets/${target.id}`);
      assert.equal(detail.body.allowedActions.setScore, false);
      const r = await score(owner, 5, null, target.id, target.revision);
      assert.equal(r.body.error.code, 'RATING_SCORE_UNAVAILABLE');
      await assert.rejects(
        withCommunityScopeWriter(f.pool, async (tx) => {
          const source = (
            await tx.query<{ source_id: string }>(
              'SELECT source_id FROM whaleu_ratings.targets WHERE id=$1',
              [target.id],
            )
          ).rows[0]!.source_id;
          await tx.query(
            `INSERT INTO whaleu_ratings.score_baselines(target_id,id,kind,source_id,source_reference,policy_reference) VALUES($1,$2,'fresh_zero',$3,'synthetic-late-zero','synthetic-policy')`,
            [target.id, randomUUID(), source],
          );
        }),
      );
      assert.equal(
        (await get(`/v1/ratings/requests/${first['requestId']}`)).status,
        200,
      );
    },
  );
  await t.test(
    'regional relationship group admits related and rejects foreign, without browsing expansion',
    async () => {
      const local = await f.catalog(owner, {
          regionId: f.scope.related.regionId,
        }),
        foreign = await f.catalog(owner, {
          regionId: f.scope.foreign.regionId,
        });
      const a = await get(
        `/v1/ratings/targets/${local.targets[0]!.id}`,
        owner,
        { regionId: f.scope.related.regionId },
      );
      assert.equal(a.status, 200, JSON.stringify(a.body));
      const b = await get(
        `/v1/ratings/targets/${foreign.targets[0]!.id}`,
        owner,
        { regionId: f.scope.foreign.regionId },
      );
      assert.ok([403, 404].includes(b.status), JSON.stringify(b.body));
      assert.equal(
        (
          await get(`/v1/ratings/targets/${local.targets[0]!.id}`, unverified, {
            regionId: f.scope.related.regionId,
          })
        ).body.error.code,
        'AFFILIATION_VERIFICATION_REQUIRED',
      );
    },
  );
  await t.test(
    'service unknown authority uses normal providers and no test override',
    async () => {
      const actor = await f.actor({ phone: 'unavailable' });
      await assert.rejects(
        f.app.get(RatingsService).target(actor.accessToken, target.id, null),
        (error) =>
          error instanceof Error &&
          'code' in error &&
          error.code === 'VERIFICATION_UNAVAILABLE',
      );
      await inTransaction(f.pool, async (tx) => {
        await lockSafetyPolicy(tx);
        assert.equal(
          (
            await tx.query(
              'SELECT count(*)::integer n FROM whaleu_ratings.score_summaries WHERE count<0',
            )
          ).rows[0]!.n,
          0,
        );
      });
    },
  );
});
