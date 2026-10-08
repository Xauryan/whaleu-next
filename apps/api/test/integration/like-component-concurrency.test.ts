import request from 'supertest';
import { discussionApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import { approveEnvelope } from '../support/community-approval-fixtures.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { LikeComponentWorker } from '../../src/community/like-component/worker.js';
import { likeFixture } from '../support/like-component-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

test(
  'like component: actual HTTP transitions, retained epochs, locking and atomic effects',
  { timeout: 120000 },
  async (t) => {
    const f = await likeFixture();
    try {
      const author = await f.actor(),
        a = await f.actor(),
        b = await f.actor();
      const worker = f.app.get(LikeComponentWorker);
      const run = (...sourceIds: string[]) =>
        worker.run({ mode: 'apply', sourceIds });
      await t.test(
        'publication independently enrolls both components and exact replay is inert',
        async () => {
          const p = await f.publish(author);
          for (const component of ['like', 'subscription']) {
            const row = (
              await f.pool.query(
                `SELECT * FROM whaleu_post_hotness.${component}_baselines WHERE post_id=$1`,
                [p.id],
              )
            ).rows;
            assert.equal(row.length, 1);
            assert.equal(row[0].opening_count, '0');
          }
          assert.equal((await f.state(p.id)).count, '0');
          const before = await f.snapshot();
          assert.deepEqual(
            (await f.publication(author, p.body).expect(201)).body,
            p.receipt,
          );
          // Request replay may refresh session metadata; component evidence remains exact.
          const after = await f.snapshot();
          for (const [key, value] of Object.entries(before))
            if (key.startsWith('whaleu_post_hotness.'))
              assert.deepEqual(after[key], value);
          const raw = await f.rawUnknown(author);
          await f.like(a, raw);
          assert.equal(await f.state(raw), undefined);
          assert.deepEqual(await f.sources(raw), []);
        },
      );
      await t.test(
        'rejection and either enrollment hook failure leave no partial native publication',
        async () => {
          const rejected = f.intent('Synthetic rejected like baseline');
          await f.approve(author, rejected, 'reject');
          assert.equal(
            (await f.publication(author, rejected).expect(201)).body.outcome,
            'rejected',
          );
          for (const component of ['like', 'subscription']) {
            const body = f.intent(`Synthetic ${component} enrollment failure`);
            await f.approve(author, body);
            await f.pool.query(
              `CREATE FUNCTION whaleu_maintenance_test.fail_like_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic enrollment interruption'; END $$; CREATE TRIGGER synthetic_enrollment_failure BEFORE INSERT ON whaleu_post_hotness.${component}_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.fail_like_enrollment()`,
            );
            try {
              await f.publication(author, body).expect(500);
            } finally {
              await f.pool.query(
                `DROP TRIGGER synthetic_enrollment_failure ON whaleu_post_hotness.${component}_baselines; DROP FUNCTION whaleu_maintenance_test.fail_like_enrollment()`,
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
          }
        },
      );
      await t.test(
        'root and reply publication and likes never enter post-like component',
        async () => {
          const p = await f.publish(author),
            body = {
              clientRequestId: randomUUID(),
              text: 'Synthetic root',
              imageAssetIds: [],
              authorMode: 'named' as const,
            };
          await approveEnvelope(
            f.pool,
            await discussionApprovalEnvelope(
              f.app,
              f.pool,
              a.accountId,
              p.id,
              body,
            ),
          );
          const root = await request(f.app.getHttpServer())
            .post(`/v1/community/posts/${p.id}/comments`)
            .set('Authorization', `Bearer ${a.accessToken}`)
            .send(body)
            .expect(201);
          assert.equal(root.body.outcome, 'created');
          const replyBody = {
            ...body,
            clientRequestId: randomUUID(),
            text: 'Synthetic reply',
            targetReplyId: null,
          };
          await approveEnvelope(
            f.pool,
            await discussionApprovalEnvelope(
              f.app,
              f.pool,
              b.accountId,
              p.id,
              replyBody,
              root.body.resourceId,
            ),
          );
          const reply = await request(f.app.getHttpServer())
            .post(`/v1/community/comments/${root.body.resourceId}/replies`)
            .set('Authorization', `Bearer ${b.accessToken}`)
            .send(replyBody)
            .expect(201);
          assert.equal(reply.body.outcome, 'created');
          for (const [kind, id] of [
            ['comments', root.body.resourceId],
            ['replies', reply.body.resourceId],
          ]) {
            await request(f.app.getHttpServer())
              .put(`/v1/community/${kind}/${id}/like`)
              .set('Authorization', `Bearer ${author.accessToken}`)
              .send({ clientRequestId: randomUUID() })
              .expect(200);
            assert.equal(await f.state(id), undefined);
          }
          assert.deepEqual(await f.sources(p.id), []);
          assert.equal((await f.state(p.id)).count, '0');
        },
      );
      await t.test(
        'unlike uses deletion xid; old request cannot re-like; 1/0/1 uses retained epochs after live row removal',
        async () => {
          const p = await f.publish(author),
            requestId = randomUUID();
          const receipt = await f.like(a, p.id, true, requestId);
          await f.like(a, p.id); // fresh request, no membership change
          await f.like(a, p.id, false);
          await f.like(a, p.id, false);
          assert.deepEqual(await f.like(a, p.id, true, requestId), receipt);
          assert.equal((await f.sources(p.id)).length, 2);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.post_likes WHERE post_id=$1',
                [p.id],
              )
            ).rowCount,
            0,
          );
          await f.like(a, p.id);
          const rows = await f.sources(p.id);
          assert.equal(rows.length, 3);
          assert.equal(rows[1]!.positive_source_id, rows[0]!.id);
          assert.notEqual(
            rows[0]!.source_transaction,
            rows[1]!.source_transaction,
          );
          assert.notEqual(rows[0]!.like_id, rows[2]!.like_id);
          assert.equal((await run(rows[2]!.id)).blockedPredecessor, 1);
          for (const [i, count] of ['1', '0', '1'].entries()) {
            assert.equal((await run(rows[i]!.id)).applied, 1);
            assert.equal((await f.state(p.id)).count, count);
          }
          const before = await f.snapshot();
          assert.equal(
            (await run(rows[0]!.id, rows[1]!.id, rows[2]!.id)).alreadyCompleted,
            3,
          );
          assert.deepEqual(await f.snapshot(), before);
          await f.like(author, p.id);
          await f.like(b, p.id);
          for (const row of (await f.sources(p.id)).slice(3))
            assert.equal((await run(row.id)).applied, 1);
          assert.equal((await f.state(p.id)).count, '3');
        },
      );
      await t.test(
        'capture, outbox and request receipt save failures roll back actual membership and retry once',
        async () => {
          for (const [schema, table, event] of [
            ['whaleu_post_hotness', 'like_sources', 'INSERT'],
            ['whaleu_community', 'outbox', 'INSERT'],
            ['whaleu_community', 'post_like_requests', 'UPDATE'],
          ]) {
            const p = await f.publish(author),
              requestId = randomUUID(),
              before = await f.snapshot();
            await f.pool.query(
              `CREATE FUNCTION whaleu_maintenance_test.fail_like_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic capture interruption'; END $$; CREATE TRIGGER synthetic_capture_failure BEFORE ${event} ON ${schema}.${table} FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.fail_like_capture()`,
            );
            try {
              await request(f.app.getHttpServer())
                .put(`/v1/community/posts/${p.id}/like`)
                .set('Authorization', `Bearer ${a.accessToken}`)
                .send({ requestId, liked: true })
                .expect(500);
            } finally {
              await f.pool.query(
                `DROP TRIGGER synthetic_capture_failure ON ${schema}.${table}; DROP FUNCTION whaleu_maintenance_test.fail_like_capture()`,
              );
            }
            const after = await f.snapshot();
            for (const [key, value] of Object.entries(before))
              if (
                !Array.isArray(value) ||
                !value.some(
                  (row) =>
                    typeof row === 'object' &&
                    row !== null &&
                    'is_called' in row,
                )
              )
                assert.deepEqual(after[key], value, key);
            assert.deepEqual(await f.sources(p.id), []);
            await f.like(a, p.id, true, requestId);
            assert.equal((await f.sources(p.id)).length, 1);
          }
        },
      );
      await t.test(
        'real final actor revalidation rolls back source, request, event and injected account change',
        async () => {
          const p = await f.publish(author),
            requestId = randomUUID(),
            before = await f.snapshot();
          await f.pool.query(
            `CREATE FUNCTION whaleu_maintenance_test.block_like_actor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=NEW.account_id; RETURN NEW; END $$; CREATE TRIGGER synthetic_actor_change AFTER UPDATE ON whaleu_community.post_like_requests FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.block_like_actor()`,
          );
          try {
            await request(f.app.getHttpServer())
              .put(`/v1/community/posts/${p.id}/like`)
              .set('Authorization', `Bearer ${a.accessToken}`)
              .send({ requestId, liked: true })
              .expect(403);
          } finally {
            await f.pool.query(
              'DROP TRIGGER synthetic_actor_change ON whaleu_community.post_like_requests; DROP FUNCTION whaleu_maintenance_test.block_like_actor()',
            );
          }
          const after = await f.snapshot();
          for (const [key, value] of Object.entries(before))
            if (
              !Array.isArray(value) ||
              !value.some(
                (row) =>
                  typeof row === 'object' && row !== null && 'is_called' in row,
              )
            )
              assert.deepEqual(after[key], value, key);
          await f.like(a, p.id, true, requestId);
          assert.equal((await f.sources(p.id)).length, 1);
        },
      );
      await t.test(
        'duplicate settlement and lost response are exactly once, external ledgers untouched',
        async () => {
          const p = await f.publish(author);
          await f.like(a, p.id);
          await f.save(a, p.id);
          const id = (await f.sources(p.id))[0]!.id,
            before = await f.snapshot();
          const results = await Promise.all([run(id), run(id)]);
          assert.equal(
            results.reduce((n, r) => n + r.applied, 0),
            1,
          );
          assert.equal(
            results.reduce((n, r) => n + r.alreadyCompleted, 0),
            1,
          );
          const after = await f.snapshot();
          for (const [key, value] of Object.entries(before))
            if (!key.startsWith('whaleu_post_hotness.like_'))
              assert.deepEqual(after[key], value, key);
          assert.equal((await run(id)).alreadyCompleted, 1);
          assert.deepEqual(await f.snapshot(), after);
        },
      );
      await t.test(
        'receipt, state, membership and deferred commit interruption atomically roll back',
        async () => {
          for (const [target, event, deferred] of [
            ['like_receipts', 'INSERT', false],
            ['like_states', 'UPDATE', false],
            ['like_memberships', 'INSERT', false],
            ['like_receipts', 'INSERT', true],
          ] as const) {
            const p = await f.publish(author);
            await f.like(a, p.id);
            const id = (await f.sources(p.id))[0]!.id,
              before = await f.snapshot();
            await f.pool.query(
              `CREATE FUNCTION whaleu_maintenance_test.fail_like_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic effect interruption'; END $$; CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER synthetic_like_failure ${deferred ? 'AFTER' : 'BEFORE'} ${event} ON whaleu_post_hotness.${target} ${deferred ? 'DEFERRABLE INITIALLY DEFERRED' : ''} FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.fail_like_effect()`,
            );
            try {
              assert.equal((await run(id)).failed, 1);
            } finally {
              await f.pool.query(
                `DROP TRIGGER synthetic_like_failure ON whaleu_post_hotness.${target}; DROP FUNCTION whaleu_maintenance_test.fail_like_effect()`,
              );
            }
            assert.deepEqual(await f.snapshot(), before);
            assert.equal((await run(id)).applied, 1);
          }
        },
      );
      await t.test(
        'hidden/deleted posts and inactive actors retain captured positive; soft deletion creates no negative',
        async () => {
          for (const hidden of [true, false]) {
            const actor = await f.actor(),
              p = await f.publish(author);
            await f.like(actor, p.id);
            if (hidden)
              await withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
                  [p.id],
                ),
              );
            else await f.deletePost(author, p.id);
            await f.pool.query(
              "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
              [actor.accountId],
            );
            const rows = await f.sources(p.id);
            assert.equal(rows.length, 1);
            assert.equal((await run(rows[0]!.id)).applied, 1);
            assert.equal((await f.state(p.id)).count, '1');
          }
        },
      );
      await t.test(
        'direct DELETE NOWAIT fails instead of parent/live-row inversion; worker starts at parent',
        async () => {
          const p = await f.publish(author);
          await f.like(a, p.id);
          const id = (await f.sources(p.id))[0]!.id;
          const holder = await f.pool.connect(),
            writer = await f.pool.connect();
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [p.id],
            );
            await writer.query('BEGIN');
            await writer.query("SET LOCAL statement_timeout='2s'");
            await assert.rejects(
              writer.query(
                'DELETE FROM whaleu_community.post_likes WHERE post_id=$1',
                [p.id],
              ),
              (e: unknown) =>
                typeof e === 'object' &&
                e !== null &&
                'code' in e &&
                e.code === '55P03',
            );
            await writer.query('ROLLBACK');
            await writer.query('BEGIN');
            await writer.query("SET LOCAL statement_timeout='2s'");
            await assert.rejects(
              writer.query(
                'INSERT INTO whaleu_community.post_likes(post_id,account_id) VALUES($1,$2)',
                [p.id, b.accountId],
              ),
              (e: unknown) =>
                typeof e === 'object' &&
                e !== null &&
                'code' in e &&
                e.code === '55P03',
            );
            await writer.query('ROLLBACK');
            const processing = run(id);
            await f.waitForLock('SELECT id FROM whaleu_community.posts');
            await holder.query(
              'SELECT post_id FROM whaleu_post_hotness.like_states WHERE post_id=$1 FOR UPDATE NOWAIT',
              [p.id],
            );
            await holder.query('COMMIT');
            assert.equal((await processing).applied, 1);
            await writer.query('BEGIN');
            await writer.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [p.id],
            );
            await writer.query(
              'DELETE FROM whaleu_community.post_likes WHERE post_id=$1',
              [p.id],
            );
            await writer.query('COMMIT');
            const negative = (await f.sources(p.id))[1]!;
            assert.equal((await run(negative.id)).applied, 1);
            assert.equal((await f.state(p.id)).count, '0');
          } finally {
            await holder.query('ROLLBACK');
            await writer.query('ROLLBACK');
            holder.release();
            writer.release();
          }
        },
      );
      await t.test(
        'huge source sequences and aborted sequence gaps preserve numeric order',
        async () => {
          const p = await f.publish(author);
          await f.pool.query(
            "SELECT setval('whaleu_post_hotness.like_source_sequence',9007199254740993,false)",
          );
          const tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [p.id],
            );
            await tx.query(
              'INSERT INTO whaleu_community.post_likes(post_id,account_id) VALUES($1,$2)',
              [p.id, a.accountId],
            );
            await tx.query('ROLLBACK');
          } finally {
            tx.release();
          }
          await f.like(a, p.id);
          await f.like(a, p.id, false);
          await f.like(a, p.id);
          const rows = await f.sources(p.id);
          assert.equal(rows[0]!.source_sequence, '9007199254740994');
          for (const row of rows) assert.equal((await run(row.id)).applied, 1);
          assert.equal(
            (await f.state(p.id)).last_sequence,
            rows[2]!.source_sequence,
          );
          assert.equal((await f.state(p.id)).count, '1');
        },
      );
      await t.test(
        'missing and blocked first selections do not starve independent posts',
        async () => {
          const p = await f.publish(author),
            q = await f.publish(author);
          await f.like(a, p.id);
          await f.like(a, p.id, false);
          await f.like(a, q.id);
          const result = await run(
            randomUUID(),
            (await f.sources(p.id))[1]!.id,
            (await f.sources(q.id))[0]!.id,
          );
          assert.equal(result.missing, 1);
          assert.equal(result.blockedPredecessor, 1);
          assert.equal(result.applied, 1);
        },
      );
    } finally {
      await f.close();
    }
  },
);
