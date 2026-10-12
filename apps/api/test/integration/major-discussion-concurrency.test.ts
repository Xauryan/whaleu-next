import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import type { PoolClient } from 'pg';
import {
  majorDiscussionFixture,
  discussionHistory,
  reviewMajorDiscussion,
  revokeMajorDiscussionReview,
} from '../support/major-discussion-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { majorDiscussionIntentHash } from '../../src/majors/discussion/service.js';
import { MajorDiscussionCursors } from '../../src/majors/discussion/cursor.js';
import { majorDiscussionReviewDigest } from '../../src/community/content-review/major-discussion-review.facade.js';
import { MajorDiscussionNoticeOwner } from '../../src/notifications/major-discussion/owner.js';
const base = '/v1/majors';
function ok(r: { status: number; body: unknown }, status = 200) {
  assert.equal(r.status, status, JSON.stringify(r.body));
}
test(
  'M1 concurrency, complete ranking, raw causal constraints and final owner proofs',
  { timeout: 240000 },
  async (t) => {
    const f = await majorDiscussionFixture();
    t.after(() => f.close());
    const actor = await f.actor({ identity: false }),
      other = await f.actor({ identity: false }),
      w = f.add(),
      http = f.app.getHttpServer();
    let catalog = await f.accept([w]);
    await f.acceptDiscussion([w.id]);
    const get = (path = '', a = actor) =>
      request(http)
        .get(base + path)
        .set('Authorization', 'Bearer ' + a.accessToken);
    const post = (path: string, body: object, a = actor) =>
      request(http)
        .post(base + path)
        .set('Authorization', 'Bearer ' + a.accessToken)
        .send(body);
    const publish = async (body: string, a = actor) => {
      const q = f.root(catalog, w, body),
        decision = await reviewMajorDiscussion(f.pool, a.accountId, w.id, q),
        r = await post(`/${w.id}/discussion`, q, a);
      ok(r);
      return {
        id: r.body.commentId as string,
        q,
        decision: decision as string,
        receipt: r.body,
      };
    };
    let root: Awaited<ReturnType<typeof publish>>, revision: string;
    await t.test(
      'same original publication has one body/result; competing likes have one CAS winner before equality',
      async () => {
        const q = f.root(catalog, w, 'single original');
        await reviewMajorDiscussion(f.pool, actor.accountId, w.id, q);
        const results = await Promise.all([
          post(`/${w.id}/discussion`, q),
          post(`/${w.id}/discussion`, q),
        ]);
        results.forEach((r) => ok(r));
        assert.deepEqual(results[0]!.body, results[1]!.body);
        root = {
          id: results[0]!.body.commentId,
          q,
          receipt: results[0]!.body,
          decision: (
            await f.pool.query<{ id: string }>(
              'SELECT id FROM whaleu_community.major_discussion_review_decisions WHERE request_id=$1',
              [q.clientRequestId],
            )
          ).rows[0]!.id,
        };
        const a = f.like(catalog, w),
          b = f.like(catalog, w),
          likes = await Promise.all([
            post(`/${w.id}/discussion/${root.id}/like`, a, other),
            post(`/${w.id}/discussion/${root.id}/like`, b, other),
          ]);
        likes.forEach((r) => ok(r));
        assert.deepEqual(likes.map((r) => r.body.outcome).sort(), [
          'applied',
          'rejected',
        ]);
        assert.equal(
          likes.find((r) => r.body.outcome === 'rejected')!.body.code,
          'MAJOR_DISCUSSION_MEMBERSHIP_CONFLICT',
        );
        revision = likes.find((r) => r.body.outcome === 'applied')!.body
          .membershipRevision;
        const same = f.like(catalog, w, false, revision),
          removes = await Promise.all([
            post(`/${w.id}/discussion/${root.id}/like`, same, other),
            post(`/${w.id}/discussion/${root.id}/like`, same, other),
          ]);
        removes.forEach((r) => ok(r));
        assert.deepEqual(removes[0]!.body, removes[1]!.body);
        revision = removes[0]!.body.membershipRevision;
        assert.equal(
          (
            await f.pool.query(
              "SELECT 1 FROM whaleu_notifications.major_discussion_notices WHERE kind='like' AND comment_id=$1",
              [root.id],
            )
          ).rowCount,
          1,
        );
      },
    );
    await t.test(
      'cancel racing publication resolves one exact durable outcome and never duplicates',
      async () => {
        const q = f.root(catalog, w, 'cancel race');
        await reviewMajorDiscussion(f.pool, actor.accountId, w.id, q);
        const outcome = await Promise.all([
          post(`/discussion-requests/${q.clientRequestId}/cancel`, {
            majorId: w.id,
            operation: 'major.discussion.root.v1',
            command: q,
          }),
          post(`/${w.id}/discussion`, q),
        ]);
        outcome.forEach((r) => ok(r));
        assert.deepEqual(outcome[0]!.body, outcome[1]!.body);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_majors.major_discussion_comments WHERE request_id=$1',
              [q.clientRequestId],
            )
          ).rowCount,
          outcome[0]!.body.outcome === 'applied' ? 1 : 0,
        );
      },
    );
    const roots: Awaited<ReturnType<typeof publish>>[] = [];
    await t.test(
      'bounded roots pagination covers exact population; changed off-page membership and Review invalidate continuation',
      async () => {
        for (let i = 0; i < 6; i++) roots.push(await publish('page ' + i));
        let first = await get(`/${w.id}/discussion?limit=2`);
        ok(first);
        assert.equal(first.body.items.length, 2);
        assert.ok(first.body.nextCursor);
        const seen = new Set<string>(
          first.body.items.map((r: { id: string }) => r.id),
        );
        let cursor = first.body.nextCursor as string | null;
        while (cursor) {
          const r = await get(
            `/${w.id}/discussion?limit=2&cursor=${encodeURIComponent(cursor)}`,
          );
          ok(r);
          for (const item of r.body.items) {
            assert.equal(seen.has(item.id), false);
            seen.add(item.id);
          }
          cursor = r.body.nextCursor;
        }
        assert.equal(seen.size, first.body.totalCount);
        const l = await post(
          `/${w.id}/discussion/${roots[0]!.id}/like`,
          f.like(catalog, w),
          other,
        );
        ok(l);
        ok(
          await get(
            `/${w.id}/discussion?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
          ),
          409,
        );
        first = await get(`/${w.id}/discussion?limit=2`);
        ok(first);
        await revokeMajorDiscussionReview(f.pool, roots[1]!.decision);
        ok(
          await get(
            `/${w.id}/discussion?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
          ),
          409,
        );
        await f.pool.query(
          "UPDATE whaleu_community.major_discussion_review_heads SET state='active' WHERE decision_id=$1",
          [roots[1]!.decision],
        );
      },
    );
    await t.test(
      'catalog head ABA and current Campus mapping changes invalidate discussion continuation without revoking owned receipts',
      async () => {
        let first = await get(`/${w.id}/discussion?limit=2`);
        ok(first);
        assert.ok(first.body.nextCursor);
        await f.pool.query(
          "UPDATE whaleu_majors.major_catalog_head SET state='withdrawn'",
        );
        await f.pool.query(
          "UPDATE whaleu_majors.major_catalog_head SET state='accepted'",
        );
        ok(
          await get(
            `/${w.id}/discussion?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
          ),
          409,
        );
        first = await get(`/${w.id}/discussion?limit=2`);
        ok(first);
        await f.pool.query(
          "UPDATE whaleu_campus.campuses SET full_name=full_name||' renamed' WHERE id=$1",
          [w.campusId],
        );
        ok(
          await get(
            `/${w.id}/discussion?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`,
          ),
          409,
        );
        ok(await get(`/${w.id}/discussion?limit=2`));
        assert.deepEqual(
          (await get(`/discussion-requests/${root.q.clientRequestId}`)).body,
          root.receipt,
        );
      },
    );
    await t.test(
      'equal timestamp root ties deterministic; raw publication profile/Review/intent matches exact rows',
      async () => {
        const values = await Promise.all(
          ['tie one', 'tie two'].map(async (body) => {
            const q = f.root(catalog, w, body);
            return {
              q,
              id: randomUUID(),
              decision: await reviewMajorDiscussion(
                f.pool,
                actor.accountId,
                w.id,
                q,
              ),
            };
          }),
        );
        await inTransaction(f.pool, async (tx) => {
          for (const value of values) {
            const row = (
              await tx.query<{ created_at: Date }>(
                "INSERT INTO whaleu_majors.major_discussion_comments(id,major_id,actor_id,request_id,catalog_id,major_revision,population_assertion_id,review_decision_id,body) VALUES($1,$2,$3,$4,$5,$6,whaleu_majors.major_discussion_history($2,'population',clock_timestamp()),$7,$8) RETURNING created_at",
                [
                  value.id,
                  w.id,
                  actor.accountId,
                  value.q.clientRequestId,
                  catalog,
                  w.revision,
                  value.decision,
                  value.q.body,
                ],
              )
            ).rows[0]!;
            const operation = 'major.discussion.root.v1' as const,
              receipt = {
                requestId: value.q.clientRequestId,
                operation,
                majorId: w.id,
                outcome: 'applied',
                commentId: value.id,
                createdAt: row.created_at.toISOString(),
              };
            await tx.query(
              'INSERT INTO whaleu_majors.major_discussion_commands(actor_id,request_id,session_id,major_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
              [
                actor.accountId,
                value.q.clientRequestId,
                actor.sessionId,
                w.id,
                operation,
                value.q,
                majorDiscussionIntentHash(
                  actor.accountId,
                  w.id,
                  null,
                  operation,
                  value.q,
                ),
                receipt,
              ],
            );
          }
        });
        const r = await get(`/${w.id}/discussion?sort=time&limit=50`);
        ok(r);
        const tie = r.body.items.filter((item: { id: string }) =>
          values.some((v) => v.id === item.id),
        );
        assert.equal(tie[0].createdAt, tie[1].createdAt);
        assert.deepEqual(
          tie.map((item: { id: string }) => item.id),
          values
            .map((v) => v.id)
            .sort()
            .reverse(),
        );
      },
    );
    await t.test(
      'whole-ranking negative or off-page Review/Safety expiry fails after cursor wait, no partial known totals',
      async () => {
        const cursors = f.app.get(MajorDiscussionCursors),
          original = cursors.create.bind(cursors);
        let changed = false;
        cursors.create = async (...args) => {
          const out = await original(...args);
          if (!changed) {
            changed = true;
            await revokeMajorDiscussionReview(f.pool, roots[2]!.decision);
          }
          return out;
        };
        try {
          ok(await get(`/${w.id}/discussion?limit=1`), 409);
        } finally {
          cursors.create = original;
          await f.pool.query(
            "UPDATE whaleu_community.major_discussion_review_heads SET state='active' WHERE decision_id=$1",
            [roots[2]!.decision],
          );
        }
        const q = f.root(catalog, w, 'expires off page');
        await reviewMajorDiscussion(
          f.pool,
          actor.accountId,
          w.id,
          q,
          null,
          'allow',
          { visibilityUntil: new Date(Date.now() + 1500) },
        );
        ok(await post(`/${w.id}/discussion`, q));
        changed = false;
        cursors.create = async (...args) => {
          const out = await original(...args);
          if (!changed) {
            changed = true;
            await sleep(1600);
          }
          return out;
        };
        try {
          ok(await get(`/${w.id}/discussion?limit=1`), 503);
        } finally {
          cursors.create = original;
          await f.pool.query(
            "UPDATE whaleu_community.major_discussion_review_heads SET state='revoked' WHERE request_id=$1",
            [q.clientRequestId],
          );
        }
        // Known revoked is denied, not an invented allow from an expired policy.
        ok(await get(`/${w.id}/discussion?limit=1`));
        await publish('off-page author expiry', other);
        await f.pool.query(
          "UPDATE whaleu_safety.account_heads SET valid_until=clock_timestamp()+interval '900 milliseconds' WHERE account_id=$1",
          [other.accountId],
        );
        changed = false;
        cursors.create = async (...args) => {
          const out = await original(...args);
          if (!changed) {
            changed = true;
            await sleep(1000);
          }
          return out;
        };
        try {
          ok(await get(`/${w.id}/discussion?limit=1`), 503);
        } finally {
          cursors.create = original;
          await f.pool.query(
            'UPDATE whaleu_safety.account_heads SET valid_until=NULL WHERE account_id=$1',
            [other.accountId],
          );
        }
        ok(await get(`/${w.id}/discussion?limit=1`));
      },
    );
    await t.test(
      'off-page Profile mutation after cursor wait cannot return an old complete named projection',
      async () => {
        const cursors = f.app.get(MajorDiscussionCursors),
          original = cursors.create.bind(cursors),
          before = (
            await f.pool.query<{ nickname: string | null }>(
              'SELECT nickname FROM whaleu_profile.profiles WHERE account_id=$1',
              [other.accountId],
            )
          ).rows[0]!.nickname;
        let changed = false;
        cursors.create = async (...args) => {
          const out = await original(...args);
          if (!changed) {
            changed = true;
            await f.pool.query(
              "UPDATE whaleu_profile.profiles SET nickname='M1Changed' WHERE account_id=$1",
              [other.accountId],
            );
          }
          return out;
        };
        try {
          const result = await get(`/${w.id}/discussion?limit=1`);
          ok(result, 503);
          assert.equal('items' in result.body, false);
          assert.equal('totalCount' in result.body, false);
        } finally {
          cursors.create = original;
          await f.pool.query(
            'UPDATE whaleu_profile.profiles SET nickname=$2 WHERE account_id=$1',
            [other.accountId, before],
          );
        }
        ok(await get(`/${w.id}/discussion?limit=1`));
      },
    );
    await t.test(
      'fresh source/Review loss after publication waits rolls back content, receipt and notice atomically',
      async () => {
        const owner = f.app.get(MajorDiscussionNoticeOwner),
          capture = owner.capture.bind(owner),
          q = f.root(catalog, w, 'revoked after prepare'),
          decision = await reviewMajorDiscussion(
            f.pool,
            actor.accountId,
            w.id,
            q,
          );
        owner.capture = async (...args) => {
          await capture(...args);
          await revokeMajorDiscussionReview(f.pool, decision);
        };
        try {
          ok(await post(`/${w.id}/discussion`, q), 503);
        } finally {
          owner.capture = capture;
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_majors.major_discussion_comments WHERE request_id=$1',
              [q.clientRequestId],
            )
          ).rowCount,
          0,
        );
        ok(await get(`/discussion-requests/${q.clientRequestId}`), 404);
        const sourceQ = f.root(catalog, w, 'source after prepare');
        await reviewMajorDiscussion(f.pool, actor.accountId, w.id, sourceQ);
        owner.capture = async (...args) => {
          await capture(...args);
          await f.pool.query(
            "UPDATE whaleu_majors.major_catalog_head SET state='withdrawn'",
          );
        };
        try {
          ok(await post(`/${w.id}/discussion`, sourceQ), 503);
        } finally {
          owner.capture = capture;
          await f.pool.query(
            "UPDATE whaleu_majors.major_catalog_head SET state='accepted'",
          );
        }
        ok(await get(`/discussion-requests/${sourceQ.clientRequestId}`), 404);
      },
    );
    await t.test(
      'actual deferred source, Review, history, Safety and session changes roll back all publication effects',
      async () => {
        const changes = [
          "UPDATE whaleu_majors.major_catalog_head SET state='withdrawn'",
          "UPDATE whaleu_community.major_discussion_review_heads SET state='revoked' WHERE actor_id=NEW.actor_id AND request_id=NEW.request_id",
          "DELETE FROM whaleu_majors.major_discussion_history_heads WHERE major_id=NEW.major_id AND kind='likes'",
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=NEW.actor_id',
          "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=NEW.session_id",
        ];
        for (const [n, change] of changes.entries()) {
          const q = f.reply(catalog, w, 'deferred loss ' + n);
          await reviewMajorDiscussion(
            f.pool,
            other.accountId,
            w.id,
            q,
            root.id,
          );
          await f.pool.query(
            'CREATE FUNCTION whaleu_majors.m1_test_loss() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN ' +
              change +
              ';RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER zz_m1_test_loss AFTER INSERT ON whaleu_majors.major_discussion_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_majors.m1_test_loss()',
          );
          try {
            const r = await post(
              `/${w.id}/discussion/${root.id}/replies`,
              q,
              other,
            );
            assert.ok(
              [401, 403, 409, 503].includes(r.status),
              JSON.stringify(r.body),
            );
            for (const table of [
              'whaleu_majors.major_discussion_comments',
              'whaleu_majors.major_discussion_commands',
              'whaleu_notifications.major_discussion_notices',
            ])
              assert.equal(
                (
                  await f.pool.query(
                    `SELECT 1 FROM ${table} WHERE request_id=$1`,
                    [q.clientRequestId],
                  )
                ).rowCount,
                0,
              );
          } finally {
            await f.pool.query(
              'DROP TRIGGER zz_m1_test_loss ON whaleu_majors.major_discussion_commands;DROP FUNCTION whaleu_majors.m1_test_loss()',
            );
          }
        }
      },
    );
    await t.test(
      'deferred wait crosses exact Review consumption deadline and SQL microsecond boundaries stay strict',
      async () => {
        const q = f.root(catalog, w, 'consumption deadline'),
          decision = await reviewMajorDiscussion(
            f.pool,
            actor.accountId,
            w.id,
            q,
            null,
            'allow',
            {
              consumeUntil: new Date(Date.now() + 900),
              visibilityUntil: new Date(Date.now() + 60000),
            },
          );
        const edge = (
          await f.pool.query(
            `SELECT whaleu_community.major_discussion_review_status(d.id,true,d.issued_at-interval '1 microsecond')='unavailable' before,whaleu_community.major_discussion_review_status(d.id,true,d.consume_until-interval '1 microsecond')='allow' last_microsecond,whaleu_community.major_discussion_review_status(d.id,true,d.consume_until)='unavailable' consumed,whaleu_community.major_discussion_review_status(d.id,false,d.visibility_until)='unavailable' expired FROM whaleu_community.major_discussion_review_decisions d WHERE d.id=$1`,
            [decision],
          )
        ).rows[0];
        assert.deepEqual(edge, {
          before: true,
          last_microsecond: true,
          consumed: true,
          expired: true,
        });
        const history = (
          await f.pool.query(
            `SELECT whaleu_majors.major_discussion_history($1,'likes',a.accepted_at-interval '1 microsecond') IS NULL before,whaleu_majors.major_discussion_history($1,'likes',a.accepted_at)=a.id accepted,whaleu_majors.major_discussion_history($1,'likes',a.valid_until) IS NULL expired FROM whaleu_majors.major_discussion_history_heads h JOIN whaleu_majors.major_discussion_history_assertions a ON a.id=h.assertion_id WHERE h.major_id=$1 AND h.kind='likes'`,
            [w.id],
          )
        ).rows[0];
        assert.deepEqual(history, {
          before: true,
          accepted: true,
          expired: true,
        });
        await f.pool.query(
          'CREATE FUNCTION whaleu_majors.m1_test_wait() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(1.1);RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER zz_m1_test_wait AFTER INSERT ON whaleu_majors.major_discussion_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_majors.m1_test_wait()',
        );
        try {
          const pending = post(`/${w.id}/discussion`, q).then((r) => r);
          let observed = false;
          const stop = Date.now() + 2500;
          while (Date.now() < stop) {
            observed = (
              await f.pool.query<{ seen: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep' AND query LIKE '%CONSTRAINTS%') seen",
              )
            ).rows[0]!.seen;
            if (observed) break;
            await sleep(10);
          }
          const r = await pending;
          assert.equal(
            observed,
            true,
            'Actual deferred constraint wait must be observed',
          );
          ok(r, 503);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_majors.major_discussion_comments WHERE request_id=$1',
                [q.clientRequestId],
              )
            ).rowCount,
            0,
          );
          ok(await get(`/discussion-requests/${q.clientRequestId}`), 404);
        } finally {
          await f.pool.query(
            'DROP TRIGGER zz_m1_test_wait ON whaleu_majors.major_discussion_commands;DROP FUNCTION whaleu_majors.m1_test_wait()',
          );
        }
      },
    );
    await t.test(
      'future-issued exact Review stays unavailable before its own instant and creates no terminal receipt',
      async () => {
        const q = f.root(catalog, w, 'future Review activation'),
          issuedAt = new Date(Date.now() + 1200),
          decision = await reviewMajorDiscussion(
            f.pool,
            actor.accountId,
            w.id,
            q,
            null,
            'allow',
            { issuedAt },
          );
        const edge = (
          await f.pool.query(
            "SELECT whaleu_community.major_discussion_review_status(id,true,issued_at-interval '1 microsecond') before,whaleu_community.major_discussion_review_status(id,true,issued_at) exact FROM whaleu_community.major_discussion_review_decisions WHERE id=$1",
            [decision],
          )
        ).rows[0];
        assert.deepEqual(edge, { before: 'unavailable', exact: 'allow' });
        ok(await post(`/${w.id}/discussion`, q), 503);
        ok(await get(`/discussion-requests/${q.clientRequestId}`), 404);
        await sleep(Math.max(0, issuedAt.getTime() - Date.now() + 25));
        ok(await post(`/${w.id}/discussion`, q));
      },
    );
    await t.test(
      'raw no-cause success/rejection/cancellation shape and unsupported isolation fail closed',
      async () => {
        const raw = (
          tx: PoolClient,
          q: ReturnType<typeof f.like>,
          receipt: object,
        ) =>
          tx.query(
            'INSERT INTO whaleu_majors.major_discussion_commands(actor_id,request_id,session_id,major_id,subject_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [
              other.accountId,
              q.clientRequestId,
              other.sessionId,
              w.id,
              root.id,
              'major.discussion.like.v1',
              q,
              majorDiscussionIntentHash(
                other.accountId,
                w.id,
                root.id,
                'major.discussion.like.v1',
                q,
              ),
              receipt,
            ],
          );
        for (const tail of [
          {
            outcome: 'applied',
            active: true,
            membershipRevision: randomUUID(),
            recordedAt: new Date().toISOString(),
          },
          {
            outcome: 'noop',
            active: true,
            membershipRevision: revision,
            recordedAt: new Date().toISOString(),
          },
          { outcome: 'rejected', code: 'MAJOR_REVISION_CONFLICT' },
          {
            outcome: 'rejected',
            code: 'MAJOR_DISCUSSION_MEMBERSHIP_CONFLICT',
          },
        ]) {
          const q = f.like(catalog, w, true, revision);
          await assert.rejects(
            inTransaction(f.pool, (tx) =>
              raw(tx, q, {
                requestId: q.clientRequestId,
                operation: 'major.discussion.like.v1',
                majorId: w.id,
                commentId: root.id,
                ...tail,
              }),
            ),
          );
          ok(
            await get(`/discussion-requests/${q.clientRequestId}`, other),
            404,
          );
        }
        const q = f.like(catalog, w, true, revision),
          receipt = {
            requestId: q.clientRequestId,
            operation: 'major.discussion.like.v1',
            majorId: w.id,
            commentId: root.id,
            outcome: 'rejected',
            code: 'MAJOR_DISCUSSION_CANCELLED',
          },
          connection = await f.pool.connect();
        try {
          await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(raw(connection, q, receipt), /read committed/);
        } finally {
          await connection.query('ROLLBACK');
          connection.release();
        }
        const invalid = { ...q, expectedMembershipRevision: 'nope' };
        await assert.rejects(
          inTransaction(f.pool, (tx) => raw(tx, invalid, receipt)),
          /Strict exact/,
        );
      },
    );
    await t.test(
      'raw replies cannot omit atomic recipient obligations or forge server-derived addressed actor',
      async () => {
        const q = f.reply(catalog, w, 'raw missing notice'),
          decision = await reviewMajorDiscussion(
            f.pool,
            other.accountId,
            w.id,
            q,
            root.id,
          ),
          id = randomUUID();
        await assert.rejects(
          inTransaction(f.pool, async (tx) => {
            const row = (
                await tx.query<{ created_at: Date }>(
                  "INSERT INTO whaleu_majors.major_discussion_comments(id,major_id,root_id,actor_id,request_id,catalog_id,major_revision,population_assertion_id,review_decision_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,whaleu_majors.major_discussion_history($2,'population',clock_timestamp()),$8,$9) RETURNING created_at",
                  [
                    id,
                    w.id,
                    root.id,
                    other.accountId,
                    q.clientRequestId,
                    catalog,
                    w.revision,
                    decision,
                    q.body,
                  ],
                )
              ).rows[0]!,
              operation = 'major.discussion.reply.v1' as const,
              receipt = {
                requestId: q.clientRequestId,
                majorId: w.id,
                operation,
                rootId: root.id,
                commentId: id,
                outcome: 'applied',
                createdAt: row.created_at.toISOString(),
              };
            await tx.query(
              'INSERT INTO whaleu_majors.major_discussion_commands(actor_id,request_id,session_id,major_id,subject_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
              [
                other.accountId,
                q.clientRequestId,
                other.sessionId,
                w.id,
                root.id,
                operation,
                q,
                majorDiscussionIntentHash(
                  other.accountId,
                  w.id,
                  root.id,
                  operation,
                  q,
                ),
                receipt,
              ],
            );
          }),
          /notice obligations/,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_majors.major_discussion_comments WHERE id=$1',
              [id],
            )
          ).rowCount,
          0,
        );
        const targetQ = f.reply(catalog, w, 'legitimate addressed target');
        await reviewMajorDiscussion(
          f.pool,
          other.accountId,
          w.id,
          targetQ,
          root.id,
        );
        const targetResponse = await post(
          `/${w.id}/discussion/${root.id}/replies`,
          targetQ,
          other,
        );
        ok(targetResponse);
        const targetId = targetResponse.body.commentId as string;
        const spoof = f.reply(catalog, w, 'raw recipient spoof', targetId),
          spoofDecision = await reviewMajorDiscussion(
            f.pool,
            actor.accountId,
            w.id,
            spoof,
            root.id,
          ),
          spoofId = randomUUID();
        await assert.rejects(
          inTransaction(f.pool, async (tx) => {
            const row = (
                await tx.query<{ created_at: Date }>(
                  "INSERT INTO whaleu_majors.major_discussion_comments(id,major_id,root_id,reply_to_reply_id,reply_to_actor_id,actor_id,request_id,catalog_id,major_revision,population_assertion_id,review_decision_id,body) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,whaleu_majors.major_discussion_history($2,'population',clock_timestamp()),$9,$10) RETURNING created_at",
                  [
                    spoofId,
                    w.id,
                    root.id,
                    targetId,
                    actor.accountId,
                    spoof.clientRequestId,
                    catalog,
                    w.revision,
                    spoofDecision,
                    spoof.body,
                  ],
                )
              ).rows[0]!,
              operation = 'major.discussion.reply.v1' as const,
              receipt = {
                requestId: spoof.clientRequestId,
                majorId: w.id,
                operation,
                rootId: root.id,
                commentId: spoofId,
                outcome: 'applied',
                createdAt: row.created_at.toISOString(),
              };
            await tx.query(
              'INSERT INTO whaleu_majors.major_discussion_commands(actor_id,request_id,session_id,major_id,subject_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
              [
                actor.accountId,
                spoof.clientRequestId,
                actor.sessionId,
                w.id,
                root.id,
                operation,
                spoof,
                majorDiscussionIntentHash(
                  actor.accountId,
                  w.id,
                  root.id,
                  operation,
                  spoof,
                ),
                receipt,
              ],
            );
          }),
          /exact atomic/,
        );
      },
    );
    await t.test(
      'raw publication enforces base identity and cannot fabricate creator notices or Window-style reply targets',
      async () => {
        const phoneOnly = await f.actor({
          affiliation: 'unverified',
          identity: false,
        });
        for (const kind of [
          'invented-creator',
          'wrong-root-author-target',
          'unverified-publisher',
        ] as const) {
          const subject = kind === 'wrong-root-author-target' ? root.id : null,
            publisher =
              kind === 'unverified-publisher'
                ? phoneOnly
                : kind === 'invented-creator'
                  ? actor
                  : other,
            recipient = kind === 'invented-creator' ? other : actor,
            q = subject
              ? f.reply(catalog, w, 'wrong target notice')
              : f.root(catalog, w, 'no creator concept'),
            decision = await reviewMajorDiscussion(
              f.pool,
              publisher.accountId,
              w.id,
              q,
              subject,
            ),
            id = randomUUID(),
            operation = subject
              ? ('major.discussion.reply.v1' as const)
              : ('major.discussion.root.v1' as const);
          await assert.rejects(
            inTransaction(f.pool, async (tx) => {
              const row = (
                await tx.query<{ created_at: Date }>(
                  "INSERT INTO whaleu_majors.major_discussion_comments(id,major_id,root_id,actor_id,request_id,catalog_id,major_revision,population_assertion_id,review_decision_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,whaleu_majors.major_discussion_history($2,'population',clock_timestamp()),$8,$9) RETURNING created_at",
                  [
                    id,
                    w.id,
                    subject,
                    publisher.accountId,
                    q.clientRequestId,
                    catalog,
                    w.revision,
                    decision,
                    q.body,
                  ],
                )
              ).rows[0]!;
              if (kind !== 'unverified-publisher')
                await tx.query(
                  "INSERT INTO whaleu_notifications.major_discussion_notices(id,recipient_id,actor_id,request_id,kind,event_id,major_id,comment_id,root_id) VALUES($1,$2,$3,$4,'reply',$5,$6,$5,$7)",
                  [
                    randomUUID(),
                    recipient.accountId,
                    publisher.accountId,
                    q.clientRequestId,
                    id,
                    w.id,
                    subject ?? id,
                  ],
                );
              const receipt = {
                requestId: q.clientRequestId,
                majorId: w.id,
                operation,
                ...(subject ? { rootId: subject } : {}),
                outcome: 'applied',
                commentId: id,
                createdAt: row.created_at.toISOString(),
              };
              await tx.query(
                'INSERT INTO whaleu_majors.major_discussion_commands(actor_id,request_id,session_id,major_id,subject_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
                [
                  publisher.accountId,
                  q.clientRequestId,
                  publisher.sessionId,
                  w.id,
                  subject,
                  operation,
                  q,
                  majorDiscussionIntentHash(
                    publisher.accountId,
                    w.id,
                    subject,
                    operation,
                    q,
                  ),
                  receipt,
                ],
              );
            }),
            kind === 'unverified-publisher'
              ? /base identity/
              : /notice obligations/,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_majors.major_discussion_comments WHERE id=$1',
                [id],
              )
            ).rowCount,
            0,
          );
        }
      },
    );
    await t.test(
      'real conflicting owner locks refuse current reads without shortening authority proof or fabricating empty',
      async () => {
        const blocker = await f.pool.connect();
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            'LOCK TABLE whaleu_community.major_discussion_review_heads IN SHARE UPDATE EXCLUSIVE MODE',
          );
          const r = await get(`/${w.id}/discussion`);
          ok(r, 503);
          assert.equal('items' in r.body, false);
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
        }
        ok(await get(`/${w.id}/discussion`));
      },
    );
    await t.test(
      'independent population expiry and later source replacement keep original lineage and terminal receipts',
      async () => {
        await discussionHistory(f.pool, w.id, 'population', 'unknown');
        ok(await get(`/${w.id}/discussion`), 503);
        ok(await get(`/discussion-requests/${root.q.clientRequestId}`));
        await f.acceptDiscussion([w.id]);
        catalog = await f.accept([
          { ...w, majorName: 'Renamed synthetic major' },
        ]);
        const page = await get(`/${w.id}/discussion`);
        ok(page);
        assert.equal(
          page.body.items.some((item: { id: string }) => item.id === root.id),
          true,
        );
      },
    );
    await t.test(
      '1001 accepted native candidates exceed complete-ranking budget rather than truncate counts',
      async () => {
        const bounded = f.add();
        const current = await f.accept([w, bounded]);
        await f.acceptDiscussion([bounded.id]);
        const values = Array.from({ length: 1001 }, (_, i) => {
          const command = f.root(current, bounded, 'budget ' + i),
            id = randomUUID(),
            decision = randomUUID(),
            envelope = {
              version: 1 as const,
              purpose: 'major.discussion.root.v1' as const,
              actorId: actor.accountId,
              requestId: command.clientRequestId,
              majorId: bounded.id,
              catalogRevision: current,
              majorRevision: bounded.revision,
              body: command.body,
              rootId: null,
              replyToReplyId: null,
              replyToActorId: null,
            };
          return {
            id,
            decision,
            key: command.clientRequestId,
            body: command.body,
            command,
            digest: majorDiscussionReviewDigest(envelope),
            hash: majorDiscussionIntentHash(
              actor.accountId,
              bounded.id,
              null,
              'major.discussion.root.v1',
              command,
            ),
          };
        });
        const policy = randomUUID();
        await inTransaction(f.pool, async (tx) => {
          await tx.query(
            "INSERT INTO whaleu_community.major_discussion_review_policies(id,issuer,source_reference,coverage,valid_from,valid_until) VALUES($1,'synthetic:budget-review','synthetic:no-provider','complete',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')",
            [policy],
          );
          await tx.query(
            `INSERT INTO whaleu_community.major_discussion_review_decisions(id,actor_id,request_id,major_id,catalog_id,major_revision,purpose,body,policy_id,verdict,digest,consume_until,visibility_until) SELECT x.decision,$2,x.key,$3,$4,$5,'major.discussion.root.v1',x.body,$6,'allow',x.digest,clock_timestamp()+interval '1 hour',clock_timestamp()+interval '1 hour' FROM jsonb_to_recordset($1) AS x(decision uuid,key uuid,body text,digest text)`,
            [
              JSON.stringify(values),
              actor.accountId,
              bounded.id,
              current,
              bounded.revision,
              policy,
            ],
          );
          await tx.query(
            `INSERT INTO whaleu_community.major_discussion_review_heads(actor_id,request_id,decision_id,state) SELECT $2,x.key,x.decision,'active' FROM jsonb_to_recordset($1) AS x(key uuid,decision uuid)`,
            [JSON.stringify(values), actor.accountId],
          );
          await tx.query(
            `INSERT INTO whaleu_majors.major_discussion_comments(id,major_id,actor_id,request_id,catalog_id,major_revision,population_assertion_id,review_decision_id,body) SELECT x.id,$2,$3,x.key,$4,$5,whaleu_majors.major_discussion_history($2,'population',clock_timestamp()),x.decision,x.body FROM jsonb_to_recordset($1) AS x(id uuid,key uuid,decision uuid,body text)`,
            [
              JSON.stringify(values),
              bounded.id,
              actor.accountId,
              current,
              bounded.revision,
            ],
          );
          await tx.query(
            `INSERT INTO whaleu_majors.major_discussion_commands(actor_id,request_id,session_id,major_id,operation,command,intent_hash,receipt) SELECT $2,x.key,$3,$4,'major.discussion.root.v1',x.command,x.hash,jsonb_build_object('requestId',x.key,'majorId',$4::uuid,'operation','major.discussion.root.v1','outcome','applied','commentId',x.id,'createdAt',to_char(date_trunc('milliseconds',transaction_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM jsonb_to_recordset($1) AS x(id uuid,key uuid,command jsonb,hash text)`,
            [
              JSON.stringify(values),
              actor.accountId,
              actor.sessionId,
              bounded.id,
            ],
          );
        });
        const r = await get(`/${bounded.id}/discussion?limit=1`);
        ok(r, 503);
        assert.equal(r.body.error.code, 'MAJOR_DISCUSSION_BUDGET_UNAVAILABLE');
        assert.equal('totalCount' in r.body, false);
      },
    );
  },
);
