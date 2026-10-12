import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import { OwnerVisibilityRepository } from '../../src/community/owner-visibility/repository.js';
import { hashToken } from '../../src/identity/tokens.js';
import request from 'supertest';
import { postPinFixture } from '../support/post-pin-fixture.js';
import { setReviewState } from '../support/community-approval-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { ownerVisibilityIntentHash } from '../../src/community/owner-visibility/service.js';
import type { OwnerVisibilityCommand } from '../../src/community/owner-visibility/contracts.js';

const prefix = '/v1/me/community';
const ok = (response: { status: number; body: unknown }, status = 200) =>
  assert.equal(response.status, status, JSON.stringify(response.body));

test(
  'owner visibility exact commands, atomic SQL CAS, actor recovery and cancellation races',
  { timeout: 180000 },
  async (t) => {
    const f = await postPinFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      outsider = await f.actor();
    const post = await f.publish(owner),
      otherPost = await f.publish(outsider);
    const http = f.app.getHttpServer();
    const input = (
      postId = post.id,
      expectedVersion = 0,
      ownerHidden = true,
    ): OwnerVisibilityCommand => ({
      clientRequestId: randomUUID(),
      postId,
      expectedVersion,
      ownerHidden,
    });
    const send = (body: object, actor = owner) =>
      request(http)
        .post(`${prefix}/owner-visibility-commands`)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(body);
    const cancel = (body: OwnerVisibilityCommand, actor = owner) =>
      request(http)
        .post(
          `${prefix}/owner-visibility-requests/${body.clientRequestId}/cancel`,
        )
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(body);
    const recover = (id: string, actor = owner) =>
      request(http)
        .get(`${prefix}/owner-visibility-requests/${id}`)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    const management = (postId = post.id, actor = owner) =>
      request(http)
        .get(`${prefix}/posts/${postId}/owner-visibility`)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    const state = async (id = post.id) =>
      (
        await f.pool.query(
          'SELECT owner_hidden,version,request_id FROM whaleu_community.post_owner_visibility WHERE post_id=$1',
          [id],
        )
      ).rows[0];
    const noCommand = async (requestId: string) =>
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_community.post_owner_visibility_commands WHERE actor_id=$1 AND request_id=$2',
            [owner.accountId, requestId],
          )
        ).rowCount,
        0,
      );

    await t.test(
      'strict command and private minimal management reject another owner and unknown fields',
      async () => {
        const first = await management();
        ok(first);
        assert.deepEqual(first.body, {
          postId: post.id,
          ownerHidden: false,
          version: 0,
          canChange: true,
        });
        assert.equal(first.headers['cache-control'], 'no-store');
        assert.match(first.headers['vary'] ?? '', /Authorization/i);
        await f.grant(outsider.accountId, 'super_admin');
        ok(await management(post.id, outsider), 404);
        ok(await send(input(post.id), outsider), 404);
        ok(await send(input(otherPost.id)), 404);
        for (const extra of [
          { actorId: owner.accountId },
          { authorMode: 'named' },
          { expectedVersion: '0' },
          { ownerHidden: 1 },
          { force: true },
        ]) {
          const body = { ...input(), ...extra };
          ok(await send(body), 400);
          await noCommand(body.clientRequestId);
        }
        ok(await management().query({ actorId: owner.accountId }), 400);
        ok(await recover(randomUUID()), 404);
      },
    );

    let firstReceipt: Record<string, unknown>;
    const firstCommand = input();
    await t.test(
      'response loss replay is exact; body/version/key conflict cannot replace original',
      async () => {
        const before = (
          await f.pool.query(
            'SELECT to_jsonb(p) AS post FROM whaleu_community.posts p WHERE id=$1',
            [post.id],
          )
        ).rows[0];
        const first = await send(firstCommand);
        ok(first);
        firstReceipt = first.body;
        assert.equal(first.body.outcome, 'applied');
        assert.equal(first.body.version, 1);
        assert.equal(first.body.changed, true);
        assert.deepEqual((await send(firstCommand)).body, first.body);
        assert.deepEqual(
          (await recover(firstCommand.clientRequestId)).body,
          first.body,
        );
        assert.deepEqual((await cancel(firstCommand)).body, first.body);
        ok(await send({ ...firstCommand, ownerHidden: false }), 409);
        ok(await send({ ...firstCommand, expectedVersion: 1 }), 409);
        ok(await recover(firstCommand.clientRequestId, outsider), 404);
        ok(await cancel(firstCommand, outsider), 404);
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT to_jsonb(p) AS post FROM whaleu_community.posts p WHERE id=$1',
              [post.id],
            )
          ).rows[0],
          before,
        );
      },
    );
    await t.test(
      'CAS rejects stale versions; no-op and hide/unhide ABA advance independent version',
      async () => {
        const stale = await send(input());
        ok(stale);
        assert.equal(stale.body.code, 'POST_OWNER_VISIBILITY_STALE');
        const noop = await send(input(post.id, 1, true));
        ok(noop);
        assert.equal(noop.body.version, 2);
        assert.equal(noop.body.changed, false);
        const restore = await send(input(post.id, 2, false));
        ok(restore);
        assert.equal(restore.body.version, 3);
        assert.equal(restore.body.changed, true);
        const hidden = await send(input(post.id, 3, true));
        ok(hidden);
        assert.equal(hidden.body.version, 4);
        assert.equal(
          (await send(input(post.id, 1, false))).body.code,
          'POST_OWNER_VISIBILITY_STALE',
        );
        assert.deepEqual(
          (await recover(firstCommand.clientRequestId)).body,
          firstReceipt!,
        );
      },
    );
    await t.test(
      'Review/content denial does not remove author-only minimal management or restore authority',
      async () => {
        await setReviewState(f.pool, post.approval.decisionId, 'held');
        const result = await management();
        ok(result);
        assert.deepEqual(result.body, {
          postId: post.id,
          ownerHidden: true,
          version: 4,
          canChange: true,
        });
        const restore = await send(input(post.id, 4, false));
        ok(restore);
        assert.equal(restore.body.version, 5);
        ok(
          await request(http)
            .get(`/v1/community/posts/${post.id}`)
            .set('Authorization', `Bearer ${owner.accessToken}`),
          404,
        );
        await setReviewState(f.pool, post.approval.decisionId, 'allow');
      },
    );
    await t.test(
      'same-key concurrent writes and cancel race have one exact immutable terminal result',
      async () => {
        const target = await f.publish(owner),
          command = input(target.id);
        const [a, b, c] = await Promise.all([
          send(command),
          send(command),
          cancel(command),
        ]);
        for (const response of [a, b, c]) ok(response);
        assert.deepEqual(a.body, b.body);
        assert.deepEqual(a.body, c.body);
        const after = await state(target.id);
        if (a.body.outcome === 'applied') assert.equal(after?.version, 1);
        else {
          assert.equal(a.body.code, 'POST_OWNER_VISIBILITY_CANCELLED');
          assert.equal(after, undefined);
        }
        const cancelled = input(target.id, after?.version ?? 0, false);
        const terminal = await cancel(cancelled);
        ok(terminal);
        assert.equal(terminal.body.code, 'POST_OWNER_VISIBILITY_CANCELLED');
        assert.deepEqual((await send(cancelled)).body, terminal.body);
        assert.deepEqual(
          (await recover(cancelled.clientRequestId)).body,
          terminal.body,
        );
        ok(
          await request(http)
            .post(`${prefix}/owner-visibility-requests/${randomUUID()}/cancel`)
            .set('Authorization', `Bearer ${owner.accessToken}`)
            .send(cancelled),
          409,
        );
      },
    );
    await t.test(
      'two distinct commands against one expected version cannot both win',
      async () => {
        const target = await f.publish(owner),
          a = input(target.id),
          b = input(target.id, 0, false);
        const outcomes = await Promise.all([send(a), send(b)]);
        for (const response of outcomes) ok(response);
        assert.equal(
          outcomes.filter((r) => r.body.outcome === 'applied').length,
          1,
        );
        assert.equal(
          outcomes.filter((r) => r.body.code === 'POST_OWNER_VISIBILITY_STALE')
            .length,
          1,
        );
        assert.equal((await state(target.id))?.version, 1);
      },
    );
    await t.test(
      'hide remains available under restriction while restoration requires current Safety only',
      async () => {
        const target = await f.publish(owner);
        const changeSafety = (sql: string) =>
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(sql, [owner.accountId]),
          );
        await changeSafety(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
        );
        const hidden = input(target.id);
        const result = await send(hidden);
        ok(result);
        assert.equal(result.body.outcome, 'applied');
        const restrictedManagement = await management(target.id);
        ok(restrictedManagement);
        assert.equal(restrictedManagement.body.canChange, false);
        const ownRestricted = await request(http)
          .get(`${prefix}/posts`)
          .set('Authorization', `Bearer ${owner.accessToken}`);
        ok(ownRestricted);
        assert.equal(
          ownRestricted.body.items.find(
            (item: { id: string }) => item.id === target.id,
          )?.ownerVisibility.canChange,
          false,
        );
        assert.deepEqual(
          (await recover(hidden.clientRequestId)).body,
          result.body,
        );
        const restore = input(target.id, 1, false);
        const denied = await send(restore);
        ok(denied, 403);
        assert.equal(denied.body.error?.code, 'SAFETY_ACTION_RESTRICTED');
        await noCommand(restore.clientRequestId);
        assert.equal((await state(target.id))?.owner_hidden, true);
        const cancelled = input(target.id, 1, false);
        assert.equal(
          (await cancel(cancelled)).body.code,
          'POST_OWNER_VISIBILITY_CANCELLED',
        );
        await changeSafety(
          "UPDATE whaleu_safety.account_heads SET actions_allowed=true,restriction_coverage='missing' WHERE account_id=$1",
        );
        const unknownManagement = await management(target.id);
        ok(unknownManagement);
        assert.equal(unknownManagement.body.canChange, false);
        const unavailable = await send(restore);
        ok(unavailable, 503);
        assert.equal(unavailable.body.error?.code, 'SAFETY_UNAVAILABLE');
        await noCommand(restore.clientRequestId);
        await changeSafety(
          "UPDATE whaleu_safety.account_heads SET restriction_coverage='complete' WHERE account_id=$1",
        );
        // Reuse the exact unresolved intent. No new key silently replaces it.
        const restored = await send(restore);
        ok(restored);
        assert.equal(restored.body.outcome, 'applied');
        assert.equal(restored.body.version, 2);
      },
    );
    await t.test(
      'optional restore hints degrade on Safety contention and late expiry without denying minimal management',
      async () => {
        const target = await f.publish(owner);
        ok(await send(input(target.id)));
        const writer = await f.pool.connect();
        try {
          await writer.query('BEGIN');
          await writer.query(
            'UPDATE whaleu_safety.account_heads SET actions_allowed=actions_allowed WHERE account_id=$1',
            [owner.accountId],
          );
          const minimal = await management(target.id);
          ok(minimal);
          assert.deepEqual(minimal.body, {
            postId: target.id,
            ownerHidden: true,
            version: 1,
            canChange: false,
          });
        } finally {
          await writer.query('ROLLBACK');
          writer.release();
        }
        assert.equal((await management(target.id)).body.canChange, true);
        const observer = observeDirectoryQueries(f.app);
        let delayed = false;
        observer.setHook(async ({ sql }, tx) => {
          if (
            !delayed &&
            sql === 'RELEASE SAVEPOINT owner_restore_capability'
          ) {
            delayed = true;
            await tx.query('SELECT pg_sleep(0.65)');
          }
        });
        try {
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_safety.account_heads SET valid_until=clock_timestamp()+interval '500 milliseconds' WHERE account_id=$1",
              [owner.accountId],
            ),
          );
          const expired = await management(target.id);
          ok(expired);
          assert.equal(delayed, true);
          assert.deepEqual(expired.body, {
            postId: target.id,
            ownerHidden: true,
            version: 1,
            canChange: false,
          });
        } finally {
          observer.restore();
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_safety.account_heads SET valid_until=NULL WHERE account_id=$1',
              [owner.accountId],
            ),
          );
        }
      },
    );
    await t.test(
      'raw SQL cannot erase/reset/forge state, edit receipt, or commit a receipt without its exact state write',
      async () => {
        for (const sql of [
          'DELETE FROM whaleu_community.post_owner_visibility WHERE post_id=$1',
          'UPDATE whaleu_community.post_owner_visibility SET version=1 WHERE post_id=$1',
          'UPDATE whaleu_community.post_owner_visibility SET owner_hidden=NOT owner_hidden WHERE post_id=$1',
        ])
          await assert.rejects(
            f.pool.query(sql, [post.id]),
            (error: unknown) =>
              !!error &&
              typeof error === 'object' &&
              'constraint' in error &&
              error.constraint === 'post_owner_visibility_causal',
          );
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_community.post_owner_visibility_commands SET receipt=receipt WHERE actor_id=$1 AND request_id=$2',
            [owner.accountId, firstCommand.clientRequestId],
          ),
        );
        const tx = await f.pool.connect();
        try {
          await tx.query('BEGIN');
          const command = input(post.id, 5, true);
          const receipt = {
            requestId: command.clientRequestId,
            postId: post.id,
            ownerHidden: true,
            expectedVersion: 5,
            outcome: 'applied',
            version: 6,
            changed: true,
            recordedAt: new Date().toISOString(),
          };
          const session = (
            await tx.query<{ session_id: string }>(
              'SELECT id AS session_id FROM whaleu_identity.sessions WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1',
              [owner.accountId],
            )
          ).rows[0]!;
          await tx.query(
            'INSERT INTO whaleu_community.post_owner_visibility_commands(actor_id,request_id,post_id,session_id,intent_hash,command,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)',
            [
              owner.accountId,
              command.clientRequestId,
              post.id,
              session.session_id,
              ownerVisibilityIntentHash(owner.accountId, command),
              JSON.stringify(command),
              JSON.stringify(receipt),
            ],
          );
          // Simulates a lost/zero-row CAS while the caller attempts to commit receipt.
          assert.equal(
            (
              await tx.query(
                'UPDATE whaleu_community.post_owner_visibility SET owner_hidden=true WHERE post_id=$1 AND version=-1',
                [post.id],
              )
            ).rowCount,
            0,
          );
          await assert.rejects(tx.query('COMMIT'));
          await noCommand(command.clientRequestId);
        } finally {
          await tx.query('ROLLBACK');
          tx.release();
        }
        assert.equal((await state())?.version, 5);
      },
    );
    await t.test(
      'own history that waits behind first hide returns the post-lock owner state',
      async () => {
        const target = await f.publish(owner),
          command = input(target.id);
        const writer = await f.pool.connect(),
          repository = f.app.get(OwnerVisibilityRepository);
        const observer = observeDirectoryQueries(f.app);
        let markEntered!: (pid: number) => void;
        const entered = new Promise<number>((resolve) => {
          markEntered = resolve;
        });
        let observed = false;
        observer.setBeforeHook(async ({ sql }, tx) => {
          if (
            !observed &&
            /FROM whaleu_community\.posts\b/.test(sql) &&
            /account_id=\$1/.test(sql) &&
            /FOR SHARE/.test(sql)
          ) {
            observed = true;
            const pid = (
              await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
            ).rows[0]!.pid;
            markEntered(pid);
          }
        });
        let pending: Promise<request.Response> | undefined;
        try {
          await writer.query('BEGIN');
          await repository.target(owner.accountId, target.id, writer, true);
          const recordedAt = new Date().toISOString();
          await repository.record(
            owner.accountId,
            owner.sessionId,
            ownerVisibilityIntentHash(owner.accountId, command),
            command,
            {
              requestId: command.clientRequestId,
              postId: target.id,
              expectedVersion: 0,
              ownerHidden: true,
              outcome: 'applied',
              version: 1,
              changed: true,
              recordedAt,
            },
            writer,
          );
          await repository.apply(owner.accountId, command, recordedAt, writer);
          pending = request(http)
            .get(`${prefix}/posts`)
            .query({ limit: 10 })
            .set('Authorization', `Bearer ${owner.accessToken}`)
            .then((response) => response);
          const pid = await Promise.race([
            entered,
            sleep(3000).then(() => {
              throw new Error('own-history SELECT was not reached');
            }),
          ]);
          const deadline = Date.now() + 3000;
          let waiting = false;
          while (Date.now() < deadline) {
            waiting =
              (
                await f.pool.query<{ waiting: boolean }>(
                  "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
                  [pid],
                )
              ).rows[0]?.waiting === true;
            if (waiting) break;
            await sleep(10);
          }
          assert.equal(
            waiting,
            true,
            'own-history parent read must actually wait behind uncommitted hide',
          );
          await writer.query('COMMIT');
          const result = await pending;
          ok(result);
          const own = result.body.items.find(
            (item: { id: string }) => item.id === target.id,
          );
          assert.ok(own, JSON.stringify(result.body));
          assert.deepEqual(own.ownerVisibility, {
            ownerHidden: true,
            version: 1,
            canChange: true,
          });
        } finally {
          await writer.query('ROLLBACK');
          writer.release();
          if (pending) await pending;
          observer.restore();
        }
      },
    );
    await t.test(
      'late token expiry rolls back both tentative owner state and immutable receipt',
      async () => {
        const actor = await f.actor(),
          target = await f.publish(actor),
          command = input(target.id);
        const observer = observeDirectoryQueries(f.app);
        let delayed = false;
        observer.setHook(async ({ sql }, tx) => {
          if (
            !delayed &&
            /^INSERT INTO whaleu_community\.post_owner_visibility\(/.test(sql)
          ) {
            delayed = true;
            await tx.query('SELECT pg_sleep(0.65)');
          }
        });
        try {
          await f.pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE token_hash=$1",
            [hashToken(actor.accessToken)],
          );
          const result = await send(command, actor);
          ok(result, 401);
          assert.equal(delayed, true);
          assert.equal(result.body.error?.code, 'ACCESS_TOKEN_EXPIRED');
          assert.equal(await state(target.id), undefined);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.post_owner_visibility_commands WHERE actor_id=$1 AND request_id=$2',
                [actor.accountId, command.clientRequestId],
              )
            ).rowCount,
            0,
          );
        } finally {
          observer.restore();
        }
      },
    );
    await t.test(
      'Safety expiry during tentative restoration cannot commit a restored overlay or terminal receipt',
      async () => {
        const target = await f.publish(owner),
          hidden = input(target.id);
        ok(await send(hidden));
        const restore = input(target.id, 1, false),
          observer = observeDirectoryQueries(f.app);
        let delayed = false;
        observer.setHook(async ({ sql }, tx) => {
          if (
            !delayed &&
            /^UPDATE whaleu_community\.post_owner_visibility SET/.test(sql)
          ) {
            delayed = true;
            await tx.query('SELECT pg_sleep(0.65)');
          }
        });
        try {
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_safety.account_heads SET valid_until=clock_timestamp()+interval '500 milliseconds' WHERE account_id=$1",
              [owner.accountId],
            ),
          );
          const result = await send(restore);
          ok(result, 503);
          assert.equal(delayed, true);
          await noCommand(restore.clientRequestId);
          assert.equal((await state(target.id))?.version, 1);
          assert.equal((await state(target.id))?.owner_hidden, true);
        } finally {
          observer.restore();
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_safety.account_heads SET valid_until=NULL WHERE account_id=$1',
              [owner.accountId],
            ),
          );
        }
        const restored = await send(restore);
        ok(restored);
        assert.equal(restored.body.version, 2);
      },
    );
    await t.test(
      'deleted parent stays minimal and original receipts recover while fresh mutation rejects',
      async () => {
        ok(
          await request(http)
            .delete(`/v1/community/posts/${post.id}`)
            .set('Authorization', `Bearer ${owner.accessToken}`),
          204,
        );
        const current = await management();
        ok(current);
        assert.deepEqual(current.body, {
          postId: post.id,
          ownerHidden: false,
          version: 5,
          canChange: false,
        });
        const rejected = await send(input(post.id, 5, true));
        ok(rejected);
        assert.equal(rejected.body.code, 'POST_OWNER_VISIBILITY_UNAVAILABLE');
        assert.deepEqual(
          (await recover(firstCommand.clientRequestId)).body,
          firstReceipt!,
        );
        assert.equal((await state())?.version, 5);
      },
    );
  },
);
