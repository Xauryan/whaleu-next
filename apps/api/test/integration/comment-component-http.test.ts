import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { CommentComponentWorker } from '../../src/community/comment-component/worker.js';
import { commentFixture } from '../support/comment-component-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

test(
  'comment component: actual public transitions, real-account cardinality and inaccessible retained threads',
  { timeout: 180000 },
  async (t) => {
    const f = await commentFixture();
    try {
      const author = await f.actor(),
        a = await f.actor(),
        b = await f.actor();
      const worker = f.app.get(CommentComponentWorker);
      const run = (...sourceIds: string[]) =>
        worker.run({ mode: 'apply', sourceIds });
      const settle = async (postId: string) => {
        for (const source of await f.sources(postId)) {
          const result = await run(source.id);
          assert.equal(
            result.applied + result.alreadyCompleted,
            1,
            JSON.stringify(result),
          );
        }
      };
      const get = (actor: typeof a, path: string) =>
        request(f.app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${actor.accessToken}`);
      await t.test(
        'fresh public publication enrolls zero independent state, exact replay and legacy post stay independent',
        async () => {
          const p = await f.publish(author);
          assert.deepEqual(await f.counts(p.id), ['0', '0', '0', '0']);
          const baseline = (
            await f.pool.query(
              'SELECT b.creation_xid::text,p.local_creation_transaction::text FROM whaleu_post_hotness.comment_baselines b JOIN whaleu_community.posts p ON p.id=b.post_id WHERE b.post_id=$1',
              [p.id],
            )
          ).rows[0]!;
          assert.equal(
            baseline.creation_xid,
            baseline.local_creation_transaction,
          );
          const before = await f.snapshot();
          assert.deepEqual(
            (await f.publication(author, p.body).expect(201)).body,
            p.receipt,
          );
          const after = await f.snapshot();
          for (const [key, value] of Object.entries(before))
            if (key.startsWith('whaleu_post_hotness.'))
              assert.deepEqual(after[key], value);
          const unknown = await f.rawUnknown(author);
          await f.root(a, unknown);
          assert.equal(await f.state(unknown), undefined);
          assert.deepEqual(await f.sources(unknown), []);
        },
      );
      await t.test(
        'failed enrollment and rejected publication never leave partial publication facts',
        async () => {
          const rejected = f.intent('Synthetic rejected comment baseline');
          await f.approve(author, rejected, 'reject');
          assert.equal(
            (await f.publication(author, rejected).expect(201)).body.outcome,
            'rejected',
          );
          const body = f.intent('Synthetic interrupted comment enrollment');
          await f.approve(author, body);
          await f.pool.query(
            "CREATE FUNCTION whaleu_maintenance_test.fail_comment_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic interruption'; END $$; CREATE TRIGGER synthetic_enrollment_failure BEFORE INSERT ON whaleu_post_hotness.comment_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.fail_comment_enrollment()",
          );
          try {
            await f.publication(author, body).expect(500);
          } finally {
            await f.pool.query(
              'DROP TRIGGER synthetic_enrollment_failure ON whaleu_post_hotness.comment_baselines; DROP FUNCTION whaleu_maintenance_test.fail_comment_enrollment()',
            );
          }
          for (const table of ['publication_requests', 'report_origins'])
            assert.equal(
              (
                await f.pool.query(
                  `SELECT 1 FROM whaleu_community.${table} WHERE ${table === 'publication_requests' ? 'client_request_id' : 'source_request_id'}=$1`,
                  [body.clientRequestId],
                )
              ).rowCount,
              0,
            );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.posts WHERE text=$1',
                [body.text],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'one real account across named/anonymous roots/replies counts once, authors change raw counts only, posts stay independent',
        async () => {
          const p = await f.publish(author),
            root = await f.root(a, p.id);
          await settle(p.id);
          assert.deepEqual(await f.counts(p.id), ['1', '0', '1', '1']);
          const reply = await f.reply(a, p.id, root.id, 'anonymous');
          await settle(p.id);
          assert.deepEqual(await f.counts(p.id), ['1', '1', '2', '1']);
          await f.root(a, p.id, 'anonymous');
          await f.reply(b, p.id, root.id, 'named', reply.id);
          await f.root(author, p.id, 'named');
          await f.root(author, p.id, 'anonymous');
          await f.reply(author, p.id, root.id, 'named');
          await f.reply(author, p.id, root.id, 'anonymous');
          await settle(p.id);
          assert.deepEqual(await f.counts(p.id), ['4', '4', '4', '2']);
          const members = (
            await f.pool.query(
              'SELECT actor_id,active_count FROM whaleu_post_hotness.comment_memberships WHERE post_id=$1 ORDER BY actor_id',
              [p.id],
            )
          ).rows;
          assert.deepEqual(
            new Map(members.map((row) => [row.actor_id, row.active_count])),
            new Map([
              [a.accountId, '3'],
              [b.accountId, '1'],
              [author.accountId, '4'],
            ]),
          );
          const q = await f.publish(author, {
              ...f.intent(),
              authorMode: 'anonymous',
            }),
            qr = await f.root(author, q.id, 'named');
          await f.reply(author, q.id, qr.id, 'named');
          await f.root(a, q.id, 'anonymous');
          await settle(q.id);
          assert.deepEqual(await f.counts(q.id), ['2', '1', '1', '1']);
          assert.deepEqual(await f.counts(p.id), ['4', '4', '4', '2']);
          const ownModes = (
            await f.pool.query(
              'SELECT author_mode FROM whaleu_community.root_comments WHERE post_id=$1 AND account_id=$2 UNION ALL SELECT author_mode FROM whaleu_community.replies WHERE post_id=$1 AND account_id=$2',
              [q.id, author.accountId],
            )
          ).rows;
          assert.deepEqual(
            ownModes.map((row) => row.author_mode),
            ['anonymous', 'anonymous'],
          );
          const visible = await get(b, `/v1/community/posts/${p.id}`).expect(
            200,
          );
          assert.equal(visible.body.commentCount, 4);
          assert.equal(visible.body.replyCount, 4);
          assert.equal(visible.body.discussionCount, 8);
          const anonymous = await get(
            b,
            `/v1/community/replies/${reply.id}`,
          ).expect(200);
          const publicText = JSON.stringify(anonymous.body);
          for (const value of [
            a.accountId,
            'unique_actor_count',
            'eligibleCount',
            'positive_source_id',
            'comment_sources',
          ])
            assert.ok(!publicText.includes(value), value);
          const unchanged = await f.snapshot();
          await settle(p.id);
          assert.deepEqual(
            await f.snapshot(),
            unchanged,
            'Replay after newer state cannot rewind memberships',
          );
        },
      );
      await t.test(
        'deleting some then last contribution decrements unique only on final cardinality transition',
        async () => {
          const p = await f.publish(author),
            r1 = await f.root(a, p.id),
            r2 = await f.root(a, p.id, 'anonymous'),
            q = await f.reply(a, p.id, r2.id);
          await settle(p.id);
          assert.deepEqual(await f.counts(p.id), ['2', '1', '3', '1']);
          await f.deleteContent(a, 'root', r1.id).expect(204);
          await f.deleteContent(a, 'root', r1.id).expect(204);
          await settle(p.id);
          assert.deepEqual(await f.counts(p.id), ['1', '1', '2', '1']);
          await f.deleteContent(a, 'reply', q.id).expect(204);
          await f.deleteContent(a, 'reply', q.id).expect(204);
          await settle(p.id);
          assert.deepEqual(await f.counts(p.id), ['1', '0', '1', '1']);
          await f.deleteContent(a, 'root', r2.id).expect(204);
          await settle(p.id);
          assert.deepEqual(await f.counts(p.id), ['0', '0', '0', '0']);
          const sources = await f.sources(p.id);
          assert.equal(sources.length, 6);
          for (const negative of sources.filter(
            (row) => row.transition === 'deleted',
          )) {
            const positive = sources.find(
              (row) => row.id === negative.positive_source_id,
            )!;
            assert.equal(positive.content_id, negative.content_id);
            assert.equal(positive.kind, negative.kind);
            assert.notEqual(
              positive.source_transaction,
              negative.source_transaction,
            );
            const table =
              negative.kind === 'root' ? 'root_comments' : 'replies';
            const row = (
              await f.pool.query(
                `SELECT local_deletion_transaction::text FROM whaleu_community.${table} WHERE id=$1`,
                [negative.content_id],
              )
            ).rows[0]!;
            assert.equal(
              negative.source_transaction,
              row.local_deletion_transaction,
            );
          }
        },
      );
      for (const sameActor of [true, false])
        await t.test(
          `deleted root retains live ${sameActor ? 'same' : 'different'}-actor reply internally while all public descendant paths deny it`,
          async () => {
            const p = await f.publish(author),
              root = await f.root(a, p.id),
              reply = await f.reply(
                sameActor ? a : b,
                p.id,
                root.id,
                'anonymous',
              );
            await f.deleteContent(a, 'root', root.id).expect(204);
            await settle(p.id);
            assert.deepEqual(await f.counts(p.id), ['0', '1', '1', '1']);
            assert.equal((await f.sources(p.id)).length, 3);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT deleted_at FROM whaleu_community.replies WHERE id=$1',
                  [reply.id],
                )
              ).rows[0]!.deleted_at,
              null,
            );
            for (const path of [
              `/v1/community/comments/${root.id}`,
              `/v1/community/comments/${root.id}/replies`,
              `/v1/community/replies/${reply.id}`,
              `/v1/community/posts/${p.id}/discussion-context?replyId=${reply.id}`,
            ])
              await get(author, path).expect(404);
            await f
              .deleteContent(sameActor ? a : b, 'reply', reply.id)
              .expect(404);
            assert.equal((await f.sources(p.id)).length, 3);
            const post = (
              await get(author, `/v1/community/posts/${p.id}`).expect(200)
            ).body;
            assert.equal(post.commentCount, 0);
            assert.equal(post.replyCount, 0);
            assert.equal(post.discussionCount, 0);
          },
        );
      await t.test(
        'deleting replied-to reply retains its descendants and excludes post author, not root author or recipient',
        async () => {
          const p = await f.publish(author),
            root = await f.root(a, p.id),
            first = await f.reply(a, p.id, root.id),
            second = await f.reply(b, p.id, root.id, 'named', first.id);
          await f.deleteContent(a, 'reply', first.id).expect(204);
          await settle(p.id);
          assert.deepEqual(await f.counts(p.id), ['1', '1', '2', '2']);
          await get(author, `/v1/community/replies/${second.id}`).expect(200);
          assert.equal((await f.sources(p.id)).length, 4);
        },
      );
      await t.test(
        'create/delete/create before settlement is causal 1,0,1 and exact request replay does not recapture',
        async () => {
          const p = await f.publish(author),
            first = await f.root(a, p.id);
          await f.deleteContent(a, 'root', first.id).expect(204);
          assert.deepEqual(
            (await f.rootRequest(a, p.id, first.body).expect(201)).body,
            first.receipt,
          );
          await f.root(a, p.id, 'anonymous');
          const rows = await f.sources(p.id);
          assert.equal(rows.length, 3);
          assert.equal((await run(rows[2]!.id)).blockedPredecessor, 1);
          for (const [i, count] of ['1', '0', '1'].entries()) {
            assert.equal((await run(rows[i]!.id)).applied, 1);
            assert.deepEqual(await f.counts(p.id), [count, '0', count, count]);
          }
          const before = await f.snapshot();
          assert.equal(
            (await run(...rows.map((row) => row.id))).alreadyCompleted,
            3,
          );
          assert.deepEqual(await f.snapshot(), before);
        },
      );
      await t.test(
        'capture failure rolls back public create or self-delete and retry captures exactly once',
        async () => {
          for (const kind of ['root', 'reply'] as const) {
            const p = await f.publish(author),
              root = await f.root(a, p.id),
              body = kind === 'root' ? f.rootBody() : f.replyBody();
            if (kind === 'root') await f.approveRoot(a, p.id, body);
            else
              await f.approveReply(a, p.id, root.id, {
                ...body,
                targetReplyId: null,
              });
            const create = () =>
              kind === 'root'
                ? f.rootRequest(a, p.id, body)
                : f.replyRequest(a, root.id, { ...body, targetReplyId: null });
            const before = await f.sources(p.id);
            await f.pool.query(
              "CREATE FUNCTION whaleu_maintenance_test.fail_comment_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic capture interruption'; END $$; CREATE TRIGGER synthetic_capture_failure BEFORE INSERT ON whaleu_post_hotness.comment_sources FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.fail_comment_capture()",
            );
            try {
              await create().expect(500);
              await f.deleteContent(a, 'root', root.id).expect(500);
            } finally {
              await f.pool.query(
                'DROP TRIGGER synthetic_capture_failure ON whaleu_post_hotness.comment_sources; DROP FUNCTION whaleu_maintenance_test.fail_comment_capture()',
              );
            }
            assert.deepEqual(await f.sources(p.id), before);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT deleted_at FROM whaleu_community.root_comments WHERE id=$1',
                  [root.id],
                )
              ).rows[0]!.deleted_at,
              null,
            );
            const result = await create().expect(201);
            assert.equal(result.body.outcome, 'created');
            await f.deleteContent(a, 'root', root.id).expect(204);
            assert.equal((await f.sources(p.id)).length, before.length + 2);
          }
        },
      );
      await t.test(
        'real report-threshold root and reply removals capture exact negatives; report replay and inaccessible descendants capture none',
        async () => {
          const reporters = await Promise.all(
            Array.from({ length: 10 }, () => f.actor()),
          );
          const p = await f.publish(author),
            root = await f.root(a, p.id),
            reply = await f.reply(b, p.id, root.id);
          const reportLast = async (kind: 'comment' | 'reply', id: string) => {
            for (const reporter of reporters.slice(0, 9))
              assert.equal(
                (await f.report(reporter, kind, id).expect(200)).body.outcome,
                'accepted',
              );
            const requestId = randomUUID(),
              last = reporters[9]!;
            const receipt = (
              await f.report(last, kind, id, requestId).expect(200)
            ).body;
            assert.equal(receipt.outcome, 'accepted');
            assert.deepEqual(
              (await f.report(last, kind, id, requestId).expect(200)).body,
              receipt,
            );
          };
          await reportLast('reply', reply.id);
          await settle(p.id);
          assert.deepEqual(await f.counts(p.id), ['1', '0', '1', '1']);
          const survivor = await f.reply(b, p.id, root.id);
          await reportLast('comment', root.id);
          await settle(p.id);
          assert.deepEqual(await f.counts(p.id), ['0', '1', '1', '1']);
          const sources = await f.sources(p.id);
          assert.equal(sources.length, 5);
          assert.equal(
            sources.filter((row) => row.transition === 'deleted').length,
            2,
          );
          const unavailable = (
            await f.report(reporters[0]!, 'reply', survivor.id).expect(200)
          ).body;
          assert.equal(unavailable.outcome, 'rejected');
          assert.equal(unavailable.code, 'REPORT_TARGET_UNAVAILABLE');
          assert.equal((await f.sources(p.id)).length, 5);
          const events = (
            await f.pool.query(
              "SELECT context FROM whaleu_community.outbox WHERE event_type='moderation_removed' AND resource_id=ANY($1::uuid[])",
              [[root.id, reply.id]],
            )
          ).rows;
          assert.equal(events.length, 2);
          for (const event of events)
            assert.deepEqual(event.context.obligations, [
              'content_invalidation',
              'media_cleanup',
            ]);
          const reviews = (
            await f.pool.query(
              'SELECT o.status,o.attempts FROM whaleu_safety.review_obligations o JOIN whaleu_safety.report_cases c ON c.id=o.case_id WHERE c.post_id=$1',
              [p.id],
            )
          ).rows;
          assert.equal(reviews.length, 2);
          assert.ok(
            reviews.every(
              (row) => row.status === 'provider_disabled' && row.attempts === 0,
            ),
          );
        },
      );
      await t.test(
        'failed tenth report rolls back deletion and report, then moderation and worker serialize parent-first',
        async () => {
          const reporters = await Promise.all(
            Array.from({ length: 10 }, () => f.actor()),
          );
          for (const kind of ['comment', 'reply'] as const) {
            const p = await f.publish(author),
              root = await f.root(a, p.id);
            const target =
              kind === 'comment' ? root : await f.reply(b, p.id, root.id);
            for (const reporter of reporters.slice(0, 9))
              assert.equal(
                (await f.report(reporter, kind, target.id).expect(200)).body
                  .outcome,
                'accepted',
              );
            const requestId = randomUUID(),
              last = reporters[9]!,
              before = await f.sources(p.id);
            await f.pool.query(
              "CREATE FUNCTION whaleu_maintenance_test.fail_report_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic moderation capture interruption'; END $$; CREATE TRIGGER synthetic_report_failure BEFORE INSERT ON whaleu_post_hotness.comment_sources FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.fail_report_capture()",
            );
            try {
              const failure = await f
                .report(last, kind, target.id, requestId)
                .expect(503);
              assert.equal(failure.body.error.code, 'SAFETY_UNAVAILABLE');
            } finally {
              await f.pool.query(
                'DROP TRIGGER synthetic_report_failure ON whaleu_post_hotness.comment_sources; DROP FUNCTION whaleu_maintenance_test.fail_report_capture()',
              );
            }
            assert.deepEqual(await f.sources(p.id), before);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT report_count FROM whaleu_safety.report_cases WHERE target_id=$1',
                  [target.id],
                )
              ).rows[0]!.report_count,
              9,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_safety.report_requests WHERE client_request_id=$1',
                  [requestId],
                )
              ).rowCount,
              0,
            );
            const table = kind === 'comment' ? 'root_comments' : 'replies';
            assert.equal(
              (
                await f.pool.query(
                  `SELECT deleted_at FROM whaleu_community.${table} WHERE id=$1`,
                  [target.id],
                )
              ).rows[0]!.deleted_at,
              null,
            );
            const holder = await f.pool.connect();
            try {
              await holder.query('BEGIN');
              await holder.query(
                'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
                [p.id],
              );
              const moderation = f
                .report(last, kind, target.id, requestId)
                .expect(200)
                .then((response) => response.body);
              await f.waitForLock('SELECT * FROM whaleu_community.posts');
              const processing = run(before[0]!.id);
              await f.waitForLock('SELECT id FROM whaleu_community.posts');
              await holder.query(
                `SELECT id FROM whaleu_community.${table} WHERE id=$1 FOR UPDATE NOWAIT`,
                [target.id],
              );
              await holder.query('COMMIT');
              const [receipt, summary] = await Promise.all([
                moderation,
                processing,
              ]);
              assert.equal(receipt.outcome, 'accepted');
              assert.equal(summary.applied, 1);
            } finally {
              await holder.query('ROLLBACK');
              holder.release();
            }
            await settle(p.id);
            assert.deepEqual(
              await f.counts(p.id),
              kind === 'comment' ? ['0', '0', '0', '0'] : ['1', '0', '1', '1'],
            );
            assert.equal((await f.sources(p.id)).length, before.length + 1);
          }
        },
      );
      await t.test(
        'likes, pins, visibility, account state and parent deletion never fabricate comment transitions; worker touches no other owners',
        async () => {
          const p = await f.publish(author),
            root = await f.root(a, p.id),
            reply = await f.reply(b, p.id, root.id);
          for (const [kind, id] of [
            ['comments', root.id],
            ['replies', reply.id],
          ])
            for (const desired of [true, false]) {
              const client = request(f.app.getHttpServer()),
                path = `/v1/community/${kind}/${id}/like`;
              await (desired ? client.put(path) : client.delete(path))
                .set('Authorization', `Bearer ${author.accessToken}`)
                .send({ clientRequestId: randomUUID() })
                .expect(200);
            }
          for (const desired of [true, false]) {
            const client = request(f.app.getHttpServer()),
              path = `/v1/community/comments/${root.id}/pin`;
            await (desired ? client.put(path) : client.delete(path))
              .set('Authorization', `Bearer ${author.accessToken}`)
              .send({ clientRequestId: randomUUID() })
              .expect(200);
          }
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_community.root_comments SET visibility='hidden' WHERE id=$1",
              [root.id],
            ),
          );
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_community.root_comments SET visibility='approved' WHERE id=$1",
              [root.id],
            ),
          );
          const blocked = (
            await request(f.app.getHttpServer())
              .put('/v1/me/safety/blocks')
              .set('Authorization', `Bearer ${author.accessToken}`)
              .send({
                clientRequestId: randomUUID(),
                source: { kind: 'comment', id: root.id },
                blocked: true,
              })
              .expect(200)
          ).body;
          assert.equal(blocked.receipt.outcome, 'applied');
          await get(author, `/v1/community/comments/${root.id}`).expect(404);
          assert.equal((await f.sources(p.id)).length, 2);
          const unblocked = (
            await request(f.app.getHttpServer())
              .put(`/v1/me/safety/blocks/${blocked.current.relationshipId}`)
              .set('Authorization', `Bearer ${author.accessToken}`)
              .send({
                clientRequestId: randomUUID(),
                blocked: false,
                expectedRevision: blocked.current.revision,
              })
              .expect(200)
          ).body;
          assert.equal(unblocked.receipt.outcome, 'applied');
          await get(author, `/v1/community/comments/${root.id}`).expect(200);
          await f.save(b, p.id);
          await f.deletePost(author, p.id);
          const inactive = await f.actor(),
            q = await f.publish(author);
          await f.root(inactive, q.id);
          await f.pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [inactive.accountId],
          );
          const before = await f.snapshot();
          await settle(p.id);
          await settle(q.id);
          assert.deepEqual(await f.counts(p.id), ['1', '1', '2', '2']);
          assert.deepEqual(await f.counts(q.id), ['1', '0', '1', '1']);
          const after = await f.snapshot();
          for (const [key, value] of Object.entries(before))
            if (!key.startsWith('whaleu_post_hotness.comment_'))
              assert.deepEqual(after[key], value, key);
          assert.equal((await f.sources(p.id)).length, 2);
          assert.equal((await f.sources(q.id)).length, 1);
        },
      );
    } finally {
      await f.close();
    }
  },
);
