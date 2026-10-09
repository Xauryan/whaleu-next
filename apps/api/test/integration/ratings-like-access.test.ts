import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import {
  ratingLikeReceiptSchema,
  ratingLikeStateSchema,
} from '../../src/ratings/likes/contracts.js';
import { AuthorDisplayService } from '../../src/profile/author-display.service.js';

// Synthetic local facts with the ordinary strict HTTP controllers, command
// recovery, current authorization, and real immutable membership transitions.
test('rating like HTTP access and recovery remain strict, private and desired-state causal', async (t) => {
  const f = await ratingDiscussionFixture();
  t.after(() => f.close());
  const author = await f.actor(),
    other = await f.actor();
  const catalog = await f.catalog(author, { count: 2 }),
    target = catalog.targets[0]!,
    otherTarget = catalog.targets[1]!;
  const root = await f.publish(author, catalog, target),
    secondRoot = await f.publish(author, catalog, target),
    foreignRoot = await f.publish(other, catalog, otherTarget);
  const reply = await f.publishReply(other, catalog, target, root);
  type Actor = typeof author;
  interface LikeInput extends Record<string, unknown> {
    clientRequestId: string;
  }
  type Content = { id: string; revision: string };
  type Subject = {
    kind: 'comment' | 'reply';
    row: Content;
    root: Content;
    target: typeof target;
  };
  const rootSubject: Subject = { kind: 'comment', row: root, root, target };
  const replySubject: Subject = { kind: 'reply', row: reply, root, target };
  const path = (s: Subject) =>
    `/v1/ratings/${s.kind === 'comment' ? 'comments' : 'replies'}/${s.row.id}/like`;
  const get = (a: Actor, s: Subject) => f.auth(request(f.http).get(path(s)), a);
  const put = (a: Actor, s: Subject, body: Record<string, unknown>) =>
    f.auth(request(f.http).put(path(s)), a).send(body);
  async function known(a: Actor, s: Subject) {
    const response = await get(a, s);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const state = ratingLikeStateSchema.parse(response.body);
    assert.equal(state.status, 'known', JSON.stringify(state));
    if (state.status !== 'known')
      throw new Error('Expected independent native coverage');
    return state;
  }
  async function body(
    a: Actor,
    s: Subject,
    liked: boolean,
  ): Promise<LikeInput> {
    const state = await known(a, s);
    return {
      clientRequestId: randomUUID(),
      regionId: catalog.regionId,
      targetId: s.target.id,
      expectedTargetRevision: s.target.revision,
      expectedRevision: s.row.revision,
      expectedLikeRevision: state.revision,
      liked,
      ...(s.kind === 'reply'
        ? { rootId: s.root.id, expectedRootRevision: s.root.revision }
        : {}),
    };
  }
  async function apply(a: Actor, s: Subject, liked: boolean) {
    const input = await body(a, s, liked),
      response = await put(a, s, input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const receipt = ratingLikeReceiptSchema.parse(response.body);
    assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
    return { input, receipt };
  }
  async function reject(a: Actor, s: Subject, input: LikeInput, code: string) {
    const response = await put(a, s, input);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, {
      requestId: input.clientRequestId,
      operation: s.kind === 'comment' ? 'set_comment_like' : 'set_reply_like',
      outcome: 'rejected',
      code,
    });
    assert.equal(
      (
        await f.pool.query(
          'SELECT * FROM whaleu_ratings.like_transitions WHERE account_id=$1 AND request_id=$2',
          [a.accountId, input.clientRequestId],
        )
      ).rowCount,
      0,
    );
  }
  await t.test(
    'strict root/reply commands reject owner and reward extras; GET and recovery reject unknown inputs and bodies',
    async () => {
      const a = await f.actor();
      for (const s of [rootSubject, replySubject]) {
        const input = await body(a, s, true);
        for (const [key, value] of Object.entries({
          actorAccountId: randomUUID(),
          recipientAccountId: randomUUID(),
          authorMode: 'anonymous',
          profileId: randomUUID(),
          points: 2,
          quotaDay: '2026-10-09',
          count: 99,
          messageId: randomUUID(),
        })) {
          const response = await put(a, s, { ...input, [key]: value });
          assert.equal(response.status, 400, JSON.stringify(response.body));
        }
        for (const response of [
          await f
            .auth(request(f.http).get(path(s)), a)
            .query({ liked: 'true' }),
          await f.auth(request(f.http).get(path(s)), a).send({ liked: true }),
          await f
            .auth(request(f.http).get(path(s)), a)
            .type('text/plain')
            .send('hidden body'),
          await f
            .auth(request(f.http).put(path(s)), a)
            .query({ regionId: randomUUID() })
            .send(input),
          await put(a, s, { ...input, liked: 'true' }),
        ])
          assert.equal(response.status, 400, JSON.stringify(response.body));
        assert.equal(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
              [a.accountId, input.clientRequestId],
            )
          ).rowCount,
          0,
        );
      }
      const id = randomUUID();
      assert.equal(
        (
          await f
            .auth(request(f.http).get(`/v1/ratings/like-requests/${id}`), a)
            .query({ accountId: a.accountId })
        ).status,
        400,
      );
      assert.equal(
        (
          await f
            .auth(request(f.http).get(`/v1/ratings/like-requests/${id}`), a)
            .send({ liked: true })
        ).status,
        400,
      );
    },
  );
  await t.test(
    'typed ancestry, target and content CAS fail closed before desired-state noops',
    async () => {
      const a = await f.actor();
      const rootBody = await body(a, rootSubject, false),
        replyBody = await body(a, replySubject, false);
      await reject(
        a,
        rootSubject,
        { ...rootBody, targetId: otherTarget.id },
        'RATING_NOT_FOUND',
      );
      await reject(
        a,
        replySubject,
        { ...replyBody, targetId: otherTarget.id },
        'RATING_NOT_FOUND',
      );
      await reject(
        a,
        replySubject,
        { ...replyBody, clientRequestId: randomUUID(), rootId: secondRoot.id },
        'RATING_NOT_FOUND',
      );
      await reject(
        a,
        replySubject,
        {
          ...replyBody,
          clientRequestId: randomUUID(),
          rootId: foreignRoot.id,
          targetId: otherTarget.id,
        },
        'RATING_NOT_FOUND',
      );
      for (const field of ['expectedTargetRevision', 'expectedRevision'])
        await reject(
          a,
          rootSubject,
          { ...rootBody, clientRequestId: randomUUID(), [field]: randomUUID() },
          'RATING_REVISION_CONFLICT',
        );
      await reject(
        a,
        replySubject,
        {
          ...replyBody,
          clientRequestId: randomUUID(),
          expectedRootRevision: randomUUID(),
        },
        'RATING_REVISION_CONFLICT',
      );
      assert.equal(
        (
          await f.auth(
            request(f.http).get(`/v1/ratings/comments/${reply.id}/like`),
            a,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await f.auth(
            request(f.http).get(`/v1/ratings/replies/${root.id}/like`),
            a,
          )
        ).status,
        404,
      );
    },
  );
  await t.test(
    'same-key simultaneous retry is one transition; old like receipt after unlike never reapplies',
    async () => {
      const a = await f.actor(),
        input = await body(a, rootSubject, true);
      const results = await Promise.all([
        put(a, rootSubject, input),
        put(a, rootSubject, input),
      ]);
      assert.equal(results[0]!.status, 200, JSON.stringify(results[0]!.body));
      assert.equal(results[1]!.status, 200, JSON.stringify(results[1]!.body));
      assert.deepEqual(results[0]!.body, results[1]!.body);
      assert.equal(results[0]!.body.outcome, 'applied');
      assert.equal(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_ratings.like_transitions WHERE account_id=$1 AND request_id=$2',
            [a.accountId, input.clientRequestId],
          )
        ).rowCount,
        1,
      );
      const unliked = await apply(a, rootSubject, false),
        state = await known(a, rootSubject);
      assert.equal(state.liked, false);
      assert.deepEqual(
        (await put(a, rootSubject, input)).body,
        results[0]!.body,
      );
      assert.deepEqual(await known(a, rootSubject), state);
      const recovered = await f.auth(
        request(f.http).get(
          `/v1/ratings/like-requests/${String(input.clientRequestId)}`,
        ),
        a,
      );
      assert.equal(recovered.status, 200);
      assert.deepEqual(recovered.body, results[0]!.body);
      assert.notEqual(unliked.receipt.revision, results[0]!.body.revision);
      assert.equal(
        (
          await f.auth(
            request(f.http).get(
              `/v1/ratings/like-requests/${String(input.clientRequestId)}`,
            ),
            other,
          )
        ).status,
        404,
      );
      for (const oldRoute of ['requests', 'reply-requests'])
        assert.equal(
          (
            await f.auth(
              request(f.http).get(
                `/v1/ratings/${oldRoute}/${String(input.clientRequestId)}`,
              ),
              a,
            )
          ).status,
          404,
        );
    },
  );
  await t.test(
    'new stale membership CAS rejects even when desired state matches; another actor count change preserves own token',
    async () => {
      const a = await f.actor(),
        b = await f.actor(),
        initial = await known(a, replySubject);
      const intent = await body(a, replySubject, true);
      await apply(b, replySubject, true);
      const afterOther = await known(a, replySubject);
      assert.equal(afterOther.revision, initial.revision);
      assert.equal(afterOther.liked, false);
      assert.equal(afterOther.count, initial.count + 1);
      const accepted = await put(a, replySubject, intent);
      assert.equal(
        accepted.body.outcome,
        'applied',
        JSON.stringify(accepted.body),
      );
      await reject(
        a,
        replySubject,
        { ...intent, clientRequestId: randomUUID() },
        'RATING_REVISION_CONFLICT',
      );
      const unlikeIntent = await body(a, replySubject, false);
      await apply(a, replySubject, false);
      await reject(
        a,
        replySubject,
        { ...unlikeIntent, clientRequestId: randomUUID() },
        'RATING_REVISION_CONFLICT',
      );
    },
  );
  await t.test(
    'all rating operations share request keys, while recoveries only decode their own operation families',
    async () => {
      const a = await f.actor(),
        first = await apply(a, rootSubject, true);
      const replyIntent = {
        ...(await body(a, replySubject, true)),
        clientRequestId: first.input.clientRequestId,
      };
      const cross = await put(a, replySubject, replyIntent);
      assert.equal(cross.status, 409);
      assert.equal(cross.body.error.code, 'REQUEST_CONFLICT');
      const changed = await put(a, rootSubject, {
        ...first.input,
        liked: false,
      });
      assert.equal(changed.status, 409);
      assert.equal(changed.body.error.code, 'REQUEST_CONFLICT');
      const sameActorPublished = await f.publish(a, catalog, target);
      const collision = await put(a, rootSubject, {
        ...(await body(a, rootSubject, false)),
        clientRequestId: sameActorPublished.input.clientRequestId,
      });
      assert.equal(collision.status, 409);
      assert.equal(collision.body.error.code, 'REQUEST_CONFLICT');
      assert.equal(
        (
          await f.auth(
            request(f.http).get(
              `/v1/ratings/like-requests/${sameActorPublished.input.clientRequestId}`,
            ),
            a,
          )
        ).status,
        404,
      );
      const createdReply = await f.publishReply(a, catalog, target, root);
      const replyCollision = await put(a, replySubject, {
        ...(await body(a, replySubject, true)),
        clientRequestId: createdReply.input.clientRequestId,
      });
      assert.equal(replyCollision.status, 409);
      assert.equal(replyCollision.body.error.code, 'REQUEST_CONFLICT');
    },
  );
  await t.test(
    'review-denied current state is inaccessible but owner recovery and same-key replay need only session',
    async () => {
      const a = await f.actor(),
        ownRoot = await f.publish(author, catalog, target),
        subject: Subject = {
          kind: 'comment',
          row: ownRoot,
          root: ownRoot,
          target,
        };
      const positive = await apply(a, subject, true),
        fresh = await body(a, subject, false);
      await setRatingReviewState(f.pool, ownRoot.approval.decisionId, 'held');
      assert.equal((await get(a, subject)).status, 404);
      await reject(a, subject, fresh, 'RATING_NOT_FOUND');
      assert.deepEqual(
        (await put(a, subject, positive.input)).body,
        positive.receipt,
      );
      assert.deepEqual(
        (
          await f.auth(
            request(f.http).get(
              `/v1/ratings/like-requests/${String(positive.input.clientRequestId)}`,
            ),
            a,
          )
        ).body,
        positive.receipt,
      );
    },
  );
  await t.test(
    'named Safety is bidirectional; anonymous target nodes never expose hidden author identity through blocks',
    async () => {
      const a = await f.actor();
      const anonymousRoot = await f.publish(
        author,
        catalog,
        target,
        f.body(catalog, target, { authorMode: 'anonymous' }),
      );
      const anonymousReply = await f.publishReply(
        author,
        catalog,
        target,
        anonymousRoot,
        f.replyBody(catalog, target, anonymousRoot, {
          authorMode: 'anonymous',
        }),
      );
      const anonymousSubjects: Subject[] = [
        { kind: 'comment', row: anonymousRoot, root: anonymousRoot, target },
        { kind: 'reply', row: anonymousReply, root: anonymousRoot, target },
      ];
      for (const [blocker, blocked] of [
        [a, author],
        [author, a],
      ] as const) {
        const blockId = randomUUID();
        const profile = await withCommunityScopeWriter(f.pool, (tx) =>
          f.app.get(AuthorDisplayService).prepare(blocked.accountId, tx),
        );
        const namedIntent = await body(a, rootSubject, true);
        await withCommunityScopeWriter(f.pool, async (tx) => {
          await tx.query(
            "INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,revision,display_snapshot,source_kind,source_id) VALUES($1,$2,$3,true,1,'Synthetic rating like blocker','profile',$4)",
            [blockId, blocker.accountId, blocked.accountId, profile.profileId],
          );
          await tx.query(
            "INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) VALUES($1,$2,$3,'blocked',1)",
            [randomUUID(), blocker.accountId, blockId],
          );
        });
        try {
          assert.equal((await get(a, rootSubject)).status, 404);
          assert.equal(
            (await get(a, replySubject)).status,
            404,
            'Named root gates its child regardless of reply author',
          );
          await reject(a, rootSubject, namedIntent, 'RATING_NOT_FOUND');
          for (const subject of anonymousSubjects) {
            const state = await known(a, subject),
              input = await body(a, subject, !state.liked),
              response = await put(a, subject, input);
            assert.equal(
              response.body.outcome,
              'applied',
              JSON.stringify(response.body),
            );
            for (const privateId of [author.accountId, profile.profileId])
              assert.equal(
                JSON.stringify({ state, receipt: response.body }).includes(
                  privateId,
                ),
                false,
              );
            assert.deepEqual(
              Object.keys(response.body).sort(),
              [
                'liked',
                'occurredAt',
                'operation',
                'outcome',
                'replyId',
                'requestId',
                'revision',
                'rootId',
                'targetId',
              ].sort(),
            );
          }
        } finally {
          await withCommunityScopeWriter(f.pool, async (tx) => {
            await tx.query(
              'UPDATE whaleu_safety.blocks SET active=false,revision=2 WHERE id=$1',
              [blockId],
            );
            await tx.query(
              "INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) VALUES($1,$2,$3,'unblocked',2)",
              [randomUUID(), blocker.accountId, blockId],
            );
          });
        }
      }
    },
  );
  await t.test(
    'self-like public receipt and current state contain no recipient, author or reward internals',
    async () => {
      const anonymousRoot = await f.publish(
        author,
        catalog,
        target,
        f.body(catalog, target, { authorMode: 'anonymous' }),
      );
      const subject: Subject = {
        kind: 'comment',
        row: anonymousRoot,
        root: anonymousRoot,
        target,
      };
      const positive = await apply(author, subject, true),
        state = await known(author, subject);
      for (const value of [positive.receipt, state]) {
        assert.equal(JSON.stringify(value).includes(author.accountId), false);
        assert.equal(
          /author|recipient|beneficiary|groupId|unitId|profileId/.test(
            JSON.stringify(value),
          ),
          false,
        );
      }
      assert.equal(state.liked, true);
      assert.equal(state.count, 1);
    },
  );
  await t.test(
    'deleted quote does not gate a live reply; deleting root gates every retained descendant membership',
    async () => {
      const a = await f.actor(),
        parent = await f.publish(author, catalog, target),
        quoted = await f.publishReply(other, catalog, target, parent);
      const children = [];
      for (let i = 0; i < 6; i++)
        children.push(
          await f.publishReply(
            other,
            catalog,
            target,
            parent,
            f.replyBody(catalog, target, parent, {
              replyTo: {
                replyId: quoted.id,
                expectedRevision: quoted.revision,
              },
            }),
          ),
        );
      assert.equal(
        (await f.deleteReply(other, catalog, target, parent, quoted)).outcome,
        'applied',
      );
      const subjects: Subject[] = children.map((row) => ({
        kind: 'reply',
        row,
        root: parent,
        target,
      }));
      const pending: LikeInput[] = [];
      for (const subject of subjects) {
        await apply(a, subject, true);
        pending.push(await body(a, subject, false));
      }
      const before = (
        await f.pool.query(
          'SELECT subject_id,account_id,active_like_id,revision FROM whaleu_ratings.like_memberships WHERE account_id=$1 ORDER BY subject_id',
          [a.accountId],
        )
      ).rows;
      assert.equal(
        (await f.deleteRoot(author, catalog, target, parent)).outcome,
        'applied',
      );
      for (let i = 0; i < subjects.length; i++) {
        assert.equal((await get(a, subjects[i]!)).status, 404);
        await reject(a, subjects[i]!, pending[i]!, 'RATING_NOT_FOUND');
      }
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT subject_id,account_id,active_like_id,revision FROM whaleu_ratings.like_memberships WHERE account_id=$1 ORDER BY subject_id',
            [a.accountId],
          )
        ).rows,
        before,
        'Root deletion is not an unlike',
      );
    },
  );
  await t.test(
    'region hints never borrow another catalog, and target deactivate/reactivate preserves membership but invalidates content CAS',
    async () => {
      const a = await f.actor();
      await f.catalog(author, { regionId: f.scope.home.regionId });
      const hint = await f
        .auth(request(f.http).get(path(rootSubject)), a)
        .query({ regionId: f.scope.home.regionId });
      assert.equal(hint.status, 404, JSON.stringify(hint.body));
      const misplaced = await body(a, rootSubject, true);
      await reject(
        a,
        rootSubject,
        { ...misplaced, regionId: f.scope.home.regionId },
        'RATING_NOT_FOUND',
      );
      const positive = await apply(a, rootSubject, true),
        original = await known(a, rootSubject),
        oldIntent = await body(a, rootSubject, false);
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_ratings.targets SET active=false,revision=$2 WHERE id=$1',
          [target.id, randomUUID()],
        ),
      );
      assert.equal((await get(a, rootSubject)).status, 404);
      assert.deepEqual(
        (await put(a, rootSubject, positive.input)).body,
        positive.receipt,
      );
      await reject(
        a,
        rootSubject,
        { ...oldIntent, clientRequestId: randomUUID() },
        'RATING_NOT_FOUND',
      );
      target.revision = randomUUID();
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_ratings.targets SET active=true,revision=$2 WHERE id=$1',
          [target.id, target.revision],
        ),
      );
      assert.deepEqual(await known(a, rootSubject), original);
      await reject(
        a,
        rootSubject,
        { ...oldIntent, clientRequestId: randomUUID() },
        'RATING_REVISION_CONFLICT',
      );
      assert.equal(
        (await apply(a, rootSubject, false)).receipt.outcome,
        'applied',
      );
    },
  );
});
