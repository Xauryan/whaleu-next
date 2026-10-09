import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';

test('owner cleanup uses private metadata despite withdrawn parent visibility and retains exact old command receipts', async (t) => {
  const f = await ratingDiscussionFixture();
  t.after(() => f.close());
  const owner = await f.actor(),
    other = await f.actor();
  const catalog = await f.catalog(owner, {
    regionId: f.scope.home.regionId,
    count: 2,
  });
  const target = catalog.targets[0]!,
    foreign = catalog.targets[1]!;
  const root = await f.publish(owner, catalog, target);
  const reply = await f.publishReply(other, catalog, target, root);
  const extra = await f.publish(owner, catalog, target);
  const stillLive = await f.publish(owner, catalog, target);
  const oldSummary = (
    await f.pool.query(
      'SELECT * FROM whaleu_ratings.score_summaries WHERE target_id=ANY($1::uuid[]) ORDER BY target_id',
      [catalog.targets.map((t) => t.id)],
    )
  ).rows;
  const deleteBody = (subject = root, patch: Record<string, unknown> = {}) => ({
    clientRequestId: randomUUID(),
    regionId: catalog.regionId,
    targetId: target.id,
    expectedTargetRevision: target.revision,
    expectedRevision: subject.revision,
    ...patch,
  });
  const remove = (
    body: Record<string, unknown>,
    actor = owner,
    subject = root,
  ) =>
    f
      .auth(request(f.http).delete(`/v1/ratings/comments/${subject.id}`), actor)
      .send(body);
  // Replacing the accepted catalog makes all old memberships inaccessible.
  await f.catalog(owner, { regionId: catalog.regionId, hidden: true });
  await setRatingReviewState(f.pool, target.approval.decisionId, 'revoked');
  await setRatingReviewState(f.pool, root.approval.decisionId, 'revoked');
  await f.certify(owner.accountId, {
    affiliation: 'unverified',
    identity: false,
  });
  await f.certify(other.accountId, {
    affiliation: 'unavailable',
    identity: false,
  });
  const oldTargetRevision = target.revision;
  target.revision = randomUUID();
  await withCommunityScopeWriter(f.pool, (tx) =>
    tx.query(
      'UPDATE whaleu_ratings.targets SET active=false,revision=$2 WHERE id=$1',
      [target.id, target.revision],
    ),
  );
  await t.test(
    'non-owner and invalid ancestry stay opaque before stale revision disclosure',
    async () => {
      const denied = await remove(
        deleteBody(root, { expectedTargetRevision: oldTargetRevision }),
        other,
      );
      assert.equal(
        denied.body.code,
        'RATING_NOT_FOUND',
        JSON.stringify(denied.body),
      );
      const wrongParent = await remove(
        deleteBody(root, {
          targetId: foreign.id,
          expectedTargetRevision: foreign.revision,
        }),
      );
      assert.equal(
        wrongParent.body.code,
        'RATING_NOT_FOUND',
        JSON.stringify(wrongParent.body),
      );
    },
  );
  await t.test(
    'stale CAS rejects before fresh metadata cleanup applies and replay stays byte-identical',
    async () => {
      const stale = await remove(
        deleteBody(root, { expectedTargetRevision: oldTargetRevision }),
      );
      assert.equal(
        stale.body.code,
        'RATING_REVISION_CONFLICT',
        JSON.stringify(stale.body),
      );
      const context = await f.auth(
        request(f.http).get(`/v1/ratings/comments/${root.id}/deletion-context`),
        owner,
      );
      assert.equal(context.status, 200, JSON.stringify(context.body));
      assert.equal(context.body.targetRevision, target.revision);
      assert.ok(
        !JSON.stringify(context.body).includes('Synthetic root comment'),
      );
      assert.ok(!JSON.stringify(context.body).includes(owner.accountId));
      const input = deleteBody();
      const applied = await remove(input);
      assert.equal(
        applied.body.outcome,
        'applied',
        JSON.stringify(applied.body),
      );
      root.revision = applied.body.revision;
      assert.deepEqual((await remove(input)).body, applied.body);
      const recovery = await f.auth(
        request(f.http).get(`/v1/ratings/requests/${input.clientRequestId}`),
        owner,
      );
      assert.deepEqual(recovery.body, applied.body);
      const noop = await remove(deleteBody());
      assert.equal(noop.body.outcome, 'noop', JSON.stringify(noop.body));
      assert.equal(noop.body.occurredAt, applied.body.occurredAt);
      assert.equal(noop.body.revision, applied.body.revision);
    },
  );
  await t.test(
    'live reply can be cleaned beneath root tombstone with fresh root CAS and unavailable affiliation',
    async () => {
      const input = {
        clientRequestId: randomUUID(),
        regionId: catalog.regionId,
        targetId: target.id,
        rootId: root.id,
        expectedTargetRevision: target.revision,
        expectedRootRevision: root.revision,
        expectedRevision: reply.revision,
      };
      const result = await f
        .auth(request(f.http).delete(`/v1/ratings/replies/${reply.id}`), other)
        .send(input);
      assert.equal(result.body.outcome, 'applied', JSON.stringify(result.body));
      assert.equal(result.body.replyId, reply.id);
      assert.equal(
        (
          await f.pool.query(
            'SELECT deleted_at FROM whaleu_ratings.comments WHERE id=$1',
            [stillLive.id],
          )
        ).rows[0]!.deleted_at,
        null,
      );
    },
  );
  await t.test(
    'global phone gate is retained while absent affiliation does not prevent cleanup',
    async () => {
      await f.certify(owner.accountId, {
        affiliation: 'unverified',
        phone: 'unverified',
        identity: false,
      });
      const denied = await remove(deleteBody(extra), owner, extra);
      assert.equal(
        denied.body.code,
        'PHONE_VERIFICATION_REQUIRED',
        JSON.stringify(denied.body),
      );
      await f.certify(owner.accountId, {
        affiliation: 'unavailable',
        phone: 'verified',
        identity: false,
      });
      const allowed = await remove(deleteBody(extra), owner, extra);
      assert.equal(
        allowed.body.outcome,
        'applied',
        JSON.stringify(allowed.body),
      );
    },
  );
  await t.test(
    'global restriction still blocks cleanup and unknown phone never creates a terminal receipt',
    async () => {
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
          [owner.accountId],
        ),
      );
      const denied = await remove(deleteBody(stillLive), owner, stillLive);
      assert.equal(
        denied.body.code,
        'SAFETY_ACTION_RESTRICTED',
        JSON.stringify(denied.body),
      );
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=true WHERE account_id=$1',
          [owner.accountId],
        ),
      );
      await f.certify(owner.accountId, {
        affiliation: 'unavailable',
        phone: 'unavailable',
        identity: false,
      });
      const input = deleteBody(stillLive);
      const unknown = await remove(input, owner, stillLive);
      assert.equal(
        unknown.body.error?.code,
        'VERIFICATION_UNAVAILABLE',
        JSON.stringify(unknown.body),
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
            [owner.accountId, input.clientRequestId],
          )
        ).rows[0]!.n,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT deleted_at FROM whaleu_ratings.comments WHERE id=$1',
            [stillLive.id],
          )
        ).rows[0]!.deleted_at,
        null,
      );
    },
  );
  assert.deepEqual(
    (
      await f.pool.query(
        'SELECT * FROM whaleu_ratings.score_summaries WHERE target_id=ANY($1::uuid[]) ORDER BY target_id',
        [catalog.targets.map((t) => t.id)],
      )
    ).rows,
    oldSummary,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int n FROM whaleu_ratings.effect_events WHERE event_kind IN ('root_deleted','reply_deleted') AND (expected_experience_units<>0 OR expected_direct_notice_obligations<>0)",
      )
    ).rows[0]!.n,
    0,
  );
});
