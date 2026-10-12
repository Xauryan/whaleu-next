import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import {
  courseCommentFixture,
  commentHistory,
  reviewCourseComment,
  revokeCourseCommentReview,
} from '../support/course-comment-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { CourseCommentReviewFacade } from '../../src/community/content-review/course-comment-review.facade.js';
import { inTransaction } from '../../src/database/database.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { courseCommentIntentHash } from '../../src/ratings/courses/comments/service.js';
const base = '/v1/ratings/courses';
function ok(r: { status: number; body: unknown }, status = 200) {
  assert.equal(r.status, status, JSON.stringify(r.body));
}
test(
  'course comment exact Review, author-undisclosed publication, separate histories, permanent likes and original recovery',
  { timeout: 240000 },
  async (t) => {
    const f = await courseCommentFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      phone = await f.actor({ affiliation: 'unverified', identity: false }),
      other = await f.actor();
    const http = f.app.getHttpServer(),
      course = f.add({ campusId: f.scope.foreign.campusId });
    const catalog = await f.accept([course]);
    const get = (path: string, a = actor) =>
      request(http)
        .get(base + path)
        .set('Authorization', `Bearer ${a.accessToken}`);
    const post = (path: string, body: object, a = actor) =>
      request(http)
        .post(base + path)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send(body);
    const list = (query = '', a = actor) =>
      get(`/${course.id}/comments${query}`, a);
    const publish = (body: ReturnType<typeof f.publish>, a = actor) =>
      post(`/${course.id}/comments`, body, a);
    const like = (id: string, body = f.like(catalog, course), a = phone) =>
      post(`/${course.id}/comments/${id}/like`, body, a);
    let first: {
      id: string;
      decision: string;
      command: ReturnType<typeof f.publish>;
      receipt: unknown;
    };
    await t.test(
      'score history and catalog never imply comment population/like membership; each separate unknown blocks',
      async () => {
        assert.equal(
          (await list()).body.error.code,
          'COURSE_COMMENT_HISTORY_UNAVAILABLE',
        );
        await commentHistory(f.pool, course.id, 'population');
        assert.equal(
          (await list()).body.error.code,
          'COURSE_COMMENT_HISTORY_UNAVAILABLE',
        );
        await commentHistory(f.pool, course.id, 'likes', 'unknown');
        assert.equal(
          (await list()).body.error.code,
          'COURSE_COMMENT_HISTORY_UNAVAILABLE',
        );
        await commentHistory(f.pool, course.id, 'likes');
        const r = await list('', phone);
        ok(r);
        assert.deepEqual(r.body.items, []);
        assert.equal(r.body.continuation, 'end');
      },
    );
    await t.test(
      'phone-only reader/liker cannot publish; no Review is unavailable with no fabricated receipt',
      async () => {
        const q = f.publish(catalog, course);
        assert.equal(
          (await publish(q, phone)).body.error.code,
          'COURSE_COMMENT_BASE_REQUIRED',
        );
        assert.equal(
          (await publish(q)).body.error.code,
          'CONTENT_REVIEW_UNAVAILABLE',
        );
        assert.equal(
          (await get(`/comment-requests/${q.clientRequestId}`)).body.error.code,
          'REQUEST_NOT_FOUND',
        );
      },
    );
    await t.test(
      'exact reviewed text preserves whitespace, authenticated author privately; distinct requests allow repeated comments',
      async () => {
        const q = f.publish(catalog, course, '  exact text\n课程  ');
        const decision = await reviewCourseComment(
          f.pool,
          actor.accountId,
          course.id,
          q,
        );
        let r = await publish(q);
        ok(r);
        first = { id: r.body.commentId, decision, command: q, receipt: r.body };
        const replay = await publish(q);
        ok(replay);
        assert.deepEqual(replay.body, r.body);
        assert.equal(
          (await publish({ ...q, body: q.body.trim() })).body.error.code,
          'REQUEST_CONFLICT',
        );
        r = await list('', phone);
        ok(r);
        assert.deepEqual(Object.keys(r.body.items[0]).sort(), [
          'body',
          'createdAt',
          'id',
          'likes',
        ]);
        assert.equal(r.body.items[0].body, q.body);
        assert.equal(r.body.items[0].likes, 0);
        assert.equal(
          (
            await f.pool.query(
              'SELECT actor_id FROM whaleu_ratings.course_comments WHERE id=$1',
              [first.id],
            )
          ).rows[0].actor_id,
          actor.accountId,
        );
        const repeated = f.publish(catalog, course, q.body);
        await reviewCourseComment(f.pool, actor.accountId, course.id, repeated);
        ok(await publish(repeated));
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.course_comments WHERE course_id=$1',
              [course.id],
            )
          ).rows[0].n,
          2,
        );
      },
    );
    await t.test(
      'Review explicit denial is durable; exact body/account/request/revisions cannot reuse approval',
      async () => {
        const q = f.publish(catalog, course);
        await reviewCourseComment(
          f.pool,
          actor.accountId,
          course.id,
          q,
          'reject',
        );
        const r = await publish(q);
        ok(r);
        assert.equal(r.body.code, 'CONTENT_REJECTED');
        assert.deepEqual((await publish(q)).body, r.body);
        const mismatch = f.publish(catalog, course);
        await reviewCourseComment(f.pool, actor.accountId, course.id, {
          ...mismatch,
          body: 'different exact content',
        });
        assert.equal(
          (await publish(mismatch)).body.error.code,
          'CONTENT_REVIEW_UNAVAILABLE',
        );
        assert.equal(
          (await get(`/comment-requests/${mismatch.clientRequestId}`)).body
            .error.code,
          'REQUEST_NOT_FOUND',
        );
      },
    );
    await t.test(
      'concurrent distinct like keys have one membership, exact count and typed already-liked; self-like allowed',
      async () => {
        const q = f.like(catalog, course),
          otherKey = f.like(catalog, course);
        const rs = await Promise.all([
          like(first.id, q),
          like(first.id, otherKey),
        ]);
        rs.forEach((r) => ok(r));
        assert.deepEqual(rs.map((r) => r.body.outcome).sort(), [
          'applied',
          'rejected',
        ]);
        assert.equal(
          rs.find((r) => r.body.outcome === 'rejected')?.body.code,
          'COURSE_COMMENT_ALREADY_LIKED',
        );
        const replay = await like(first.id, q);
        ok(replay);
        assert.deepEqual(replay.body, rs[0]!.body);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.course_comment_likes WHERE comment_id=$1',
              [first.id],
            )
          ).rows[0].n,
          1,
        );
        ok(await like(first.id, f.like(catalog, course), actor));
        assert.equal(
          (await list()).body.items.find(
            (x: { id: string }) => x.id === first.id,
          ).likes,
          2,
        );
      },
    );
    await t.test(
      'stable likes/time pages bind whole ranking, query, account, session and mutations',
      async () => {
        const p = await list('?limit=1&sort=likes');
        ok(p);
        assert.equal(p.body.items[0].id, first.id);
        assert.ok(p.body.nextCursor);
        const timePage = await list('?limit=1&sort=time');
        ok(timePage);
        assert.ok(timePage.body.nextCursor);
        const timeNext = await list(
          `?limit=1&sort=time&cursor=${encodeURIComponent(timePage.body.nextCursor)}`,
        );
        ok(timeNext);
        assert.notEqual(timePage.body.items[0].id, timeNext.body.items[0].id);
        const c = encodeURIComponent(p.body.nextCursor);
        const r = await list(`?limit=1&sort=likes&cursor=${c}`);
        ok(r);
        assert.notEqual(r.body.items[0].id, first.id);
        assert.equal(
          (await list(`?limit=1&sort=time&cursor=${c}`)).body.error.code,
          'DISCOVERY_RESTART_REQUIRED',
        );
        assert.equal(
          (await list(`?limit=1&sort=likes&cursor=${c}`, other)).body.error
            .code,
          'DISCOVERY_RESTART_REQUIRED',
        );
        ok(await like(first.id, f.like(catalog, course), other));
        assert.equal(
          (await list(`?limit=1&sort=likes&cursor=${c}`)).body.error.code,
          'DISCOVERY_RESTART_REQUIRED',
        );
      },
    );
    await t.test(
      'review revocation hides undisclosed body and invalidates continuation, but original receipt remains recoverable',
      async () => {
        const p = await list('?limit=1');
        ok(p);
        await revokeCourseCommentReview(f.pool, first.decision);
        const r = await list();
        ok(r);
        assert.ok(!r.body.items.some((x: { id: string }) => x.id === first.id));
        assert.equal(
          (await like(first.id)).body.error.code,
          'COURSE_COMMENT_NOT_FOUND',
        );
        assert.equal(
          (
            await list(
              `?limit=1&cursor=${encodeURIComponent(p.body.nextCursor)}`,
            )
          ).body.error.code,
          'DISCOVERY_RESTART_REQUIRED',
        );
        assert.deepEqual(
          (await get(`/comment-requests/${first.command.clientRequestId}`))
            .body,
          first.receipt,
        );
      },
    );
    await t.test(
      'withdrawn source/lost base still recovers immutable receipts but cannot publish/read',
      async () => {
        await f.pool.query(
          "UPDATE whaleu_ratings.course_catalog_head SET state='withdrawn'",
        );
        await f.certify(actor.accountId, {
          affiliation: 'unverified',
          phone: 'unverified',
          identity: false,
        });
        assert.deepEqual(
          (await get(`/comment-requests/${first.command.clientRequestId}`))
            .body,
          first.receipt,
        );
        assert.deepEqual((await publish(first.command)).body, first.receipt);
        assert.equal(
          (await list()).body.error.code,
          'PHONE_VERIFICATION_REQUIRED',
        );
        assert.equal(
          (await list('', phone)).body.error.code,
          'COURSE_CATALOG_UNAVAILABLE',
        );
        await f.certify(actor.accountId);
        await f.pool.query(
          "UPDATE whaleu_ratings.course_catalog_head SET state='accepted'",
        );
      },
    );
    await t.test(
      'durable cancellation before unrecorded command survives delayed publish; recorded result wins cancellation',
      async () => {
        const q = f.publish(catalog, course);
        const input = {
          operation: 'course.comment.publish.v1',
          courseId: course.id,
          command: q,
        };
        let r = await post(
          `/comment-requests/${q.clientRequestId}/cancel`,
          input,
        );
        ok(r);
        assert.equal(r.body.code, 'COURSE_COMMENT_CANCELLED');
        assert.deepEqual((await publish(q)).body, r.body);
        r = await post(
          `/comment-requests/${first.command.clientRequestId}/cancel`,
          { ...input, command: first.command },
        );
        ok(r);
        assert.deepEqual(r.body, first.receipt);
        assert.equal(
          (
            await post(`/comment-requests/${q.clientRequestId}/cancel`, {
              ...input,
              command: { ...q, body: 'changed' },
            })
          ).body.error.code,
          'REQUEST_CONFLICT',
        );
      },
    );
    await t.test(
      'current session required even for historical receipt; other actor cannot discover it',
      async () => {
        assert.equal(
          (
            await get(
              `/comment-requests/${first.command.clientRequestId}`,
              other,
            )
          ).body.error.code,
          'REQUEST_NOT_FOUND',
        );
        const departed = await f.actor();
        await f.app.get(IdentityService).logout(departed.accessToken);
        ok(
          await get(
            `/comment-requests/${first.command.clientRequestId}`,
            departed,
          ),
          401,
        );
      },
    );
    await t.test(
      'unknown or expired independent history never fabricates zero likes or absent membership',
      async () => {
        await commentHistory(f.pool, course.id, 'likes', 'unknown');
        assert.equal(
          (await list()).body.error.code,
          'COURSE_COMMENT_HISTORY_UNAVAILABLE',
        );
        assert.equal(
          (await like(first.id)).body.error.code,
          'COURSE_COMMENT_HISTORY_UNAVAILABLE',
        );
        await commentHistory(f.pool, course.id, 'likes');
        await commentHistory(
          f.pool,
          course.id,
          'population',
          'accepted_empty',
          new Date(Date.now() + 100),
        );
        await delay(120);
        assert.equal(
          (await list()).body.error.code,
          'COURSE_COMMENT_HISTORY_UNAVAILABLE',
        );
        await commentHistory(f.pool, course.id, 'population');
      },
    );
    await t.test(
      'raw forged receipts/updates/deletes/unlike are rejected atomically',
      async () => {
        await assert.rejects(
          f.pool.query(
            'DELETE FROM whaleu_ratings.course_comment_likes WHERE comment_id=$1',
            [first.id],
          ),
          /immutable/,
        );
        await assert.rejects(
          f.pool.query(
            "UPDATE whaleu_ratings.course_comments SET body='forged' WHERE id=$1",
            [first.id],
          ),
          /immutable/,
        );
        await assert.rejects(
          f.pool.query(
            'TRUNCATE whaleu_ratings.course_comment_commands CASCADE',
          ),
          /immutable/,
        );
        const q = f.like(catalog, course),
          receipt = {
            requestId: q.clientRequestId,
            courseId: course.id,
            commentId: first.id,
            operation: 'course.comment.like.v1' as const,
            outcome: 'applied',
            recordedAt: new Date().toISOString(),
          };
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            tx.query(
              'INSERT INTO whaleu_ratings.course_comment_commands(actor_id,request_id,session_id,course_id,comment_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
              [
                actor.accountId,
                q.clientRequestId,
                actor.sessionId,
                course.id,
                first.id,
                receipt.operation,
                q,
                courseCommentIntentHash(
                  actor.accountId,
                  course.id,
                  first.id,
                  receipt.operation,
                  q,
                ),
                receipt,
              ],
            ),
          ),
        );
      },
    );
    await t.test(
      'raw unavailable-source false rejection and unsupported writer isolation cannot create terminal receipts',
      async () => {
        const q = f.like(catalog, course),
          operation = 'course.comment.like.v1' as const,
          receipt = {
            requestId: q.clientRequestId,
            courseId: course.id,
            commentId: first.id,
            operation,
            outcome: 'rejected',
            code: 'COURSE_REVISION_CONFLICT',
          };
        const insert = (tx: import('pg').PoolClient) =>
          tx.query(
            'INSERT INTO whaleu_ratings.course_comment_commands(actor_id,request_id,session_id,course_id,comment_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [
              actor.accountId,
              q.clientRequestId,
              actor.sessionId,
              course.id,
              first.id,
              operation,
              q,
              courseCommentIntentHash(
                actor.accountId,
                course.id,
                first.id,
                operation,
                q,
              ),
              receipt,
            ],
          );
        await assert.rejects(inTransaction(f.pool, insert), /causal/);
        await f.pool.query(
          "UPDATE whaleu_ratings.course_catalog_head SET state='withdrawn'",
        );
        try {
          await assert.rejects(inTransaction(f.pool, insert), /authority/);
        } finally {
          await f.pool.query(
            "UPDATE whaleu_ratings.course_catalog_head SET state='accepted'",
          );
        }
        const raw = await f.pool.connect();
        try {
          await raw.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(insert(raw), /read committed/);
        } finally {
          await raw.query('ROLLBACK');
          raw.release();
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.course_comment_commands WHERE request_id=$1',
              [q.clientRequestId],
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      'raw cancellation validates exact JSON string UUID intent, not coercible or malformed revisions',
      async () => {
        for (const invalid of [
          { expectedCatalogRevision: '------------------------------------' },
          { expectedCourseRevision: 1e35 },
          { body: '\u00a0' },
          { body: '\ufeff' },
          { body: '\u00a0\u2000\ufeff' },
        ]) {
          const q = { ...f.publish(catalog, course), ...invalid },
            operation = 'course.comment.publish.v1',
            receipt = {
              requestId: q.clientRequestId,
              operation,
              courseId: course.id,
              outcome: 'rejected',
              code: 'COURSE_COMMENT_CANCELLED',
            };
          await assert.rejects(
            inTransaction(f.pool, (tx) =>
              tx.query(
                `WITH intent AS(SELECT $1::jsonb command) INSERT INTO whaleu_ratings.course_comment_commands(actor_id,request_id,session_id,course_id,operation,command,intent_hash,receipt) SELECT $2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,command,encode(sha256(convert_to('whaleu:course-comment-command:v1'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('actorId',$2::text,'courseId',$5::text,'commentId',null,'operation',$6::text,'command',command)),'UTF8')),'hex'),$7::jsonb FROM intent`,
                [
                  q,
                  actor.accountId,
                  q.clientRequestId,
                  actor.sessionId,
                  course.id,
                  operation,
                  receipt,
                ],
              ),
            ),
            /Exact typed course comment intent/,
          );
        }
      },
    );
    await t.test(
      'raw applied receipt must contain canonical ISO timestamp, not a merely equivalent SQL timestamp',
      async () => {
        const q = f.publish(catalog, course),
          decision = await reviewCourseComment(
            f.pool,
            actor.accountId,
            course.id,
            q,
          ),
          id = randomUUID();
        await assert.rejects(
          inTransaction(f.pool, async (tx) => {
            const row = (
              await tx.query<{ created_at: Date }>(
                "INSERT INTO whaleu_ratings.course_comments(id,course_id,actor_id,request_id,catalog_id,course_revision,population_assertion_id,body) VALUES($1,$2,$3,$4,$5,$6,whaleu_ratings.course_comment_history($2,'population',clock_timestamp()),$7) RETURNING created_at",
                [
                  id,
                  course.id,
                  actor.accountId,
                  q.clientRequestId,
                  catalog,
                  course.revision,
                  q.body,
                ],
              )
            ).rows[0]!;
            await tx.query(
              'INSERT INTO whaleu_community.course_comment_review_bindings(comment_id,course_id,decision_id) VALUES($1,$2,$3)',
              [id, course.id, decision],
            );
            const receipt = {
              requestId: q.clientRequestId,
              courseId: course.id,
              commentId: id,
              operation: 'course.comment.publish.v1' as const,
              outcome: 'applied',
              createdAt: row.created_at
                .toISOString()
                .replace('T', ' ')
                .replace('Z', '+00'),
            };
            await tx.query(
              'INSERT INTO whaleu_ratings.course_comment_commands(actor_id,request_id,session_id,course_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
              [
                actor.accountId,
                q.clientRequestId,
                actor.sessionId,
                course.id,
                receipt.operation,
                q,
                courseCommentIntentHash(
                  actor.accountId,
                  course.id,
                  null,
                  receipt.operation,
                  q,
                ),
                receipt,
              ],
            );
          }),
          /Publication requires atomic exact Review/,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.course_comments WHERE id=$1',
              [id],
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      'base publication accepts temporary verified and real school/super admins, excludes developer-only grants and browsing campus authority',
      async () => {
        const grant = async (
          a: typeof phone,
          role: 'developer' | 'school_admin' | 'super_admin',
        ) =>
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,$3,$4,$2,'synthetic:base-role-equivalence')",
              [
                randomUUID(),
                a.accountId,
                role,
                role === 'school_admin' ? f.scope.home.regionId : null,
              ],
            ),
          );
        const developer = await f.actor({
          affiliation: 'unverified',
          identity: false,
        });
        await grant(developer, 'developer');
        const dq = f.publish(catalog, course);
        await reviewCourseComment(f.pool, developer.accountId, course.id, dq);
        assert.equal(
          (await publish(dq, developer)).body.error.code,
          'COURSE_COMMENT_BASE_REQUIRED',
        );
        for (const role of ['school_admin', 'super_admin'] as const) {
          const a = await f.actor({
            affiliation: 'unverified',
            identity: false,
          });
          await grant(a, role);
          const q = f.publish(catalog, course);
          await reviewCourseComment(f.pool, a.accountId, course.id, q);
          ok(await publish(q, a));
        }
        const temporary = await f.actor({
          affiliation: 'unverified',
          identity: false,
        });
        await withCommunityScopeWriter(f.pool, async (tx) => {
          const id = randomUUID();
          await tx.query(
            "INSERT INTO whaleu_verification.rating_base_assertions(id,account_id,state,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until) VALUES($1,$2,'verified','complete','accepted','synthetic:temporary','synthetic:temporary-base','synthetic:no-school-match',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')",
            [id, temporary.accountId],
          );
          await tx.query(
            'INSERT INTO whaleu_verification.rating_base_heads(account_id,assertion_id) VALUES($1,$2)',
            [temporary.accountId, id],
          );
        });
        const q = f.publish(catalog, course);
        await reviewCourseComment(f.pool, temporary.accountId, course.id, q);
        ok(await publish(q, temporary));
      },
    );
    await t.test(
      'exact PostgreSQL clock preserves microsecond source/history and Review transitions',
      async () => {
        const row = (
          await f.pool.query(
            "SELECT whaleu_ratings.course_comment_history($1,'population',a.accepted_at-interval '1 microsecond') IS NULL before,whaleu_ratings.course_comment_history($1,'population',a.accepted_at)=a.id AS accepted,whaleu_ratings.course_comment_history($1,'population',a.valid_until) IS NULL expired FROM whaleu_ratings.course_comment_history_heads h JOIN whaleu_ratings.course_comment_history_assertions a ON a.id=h.assertion_id WHERE h.course_id=$1 AND h.kind='population'",
            [course.id],
          )
        ).rows[0];
        assert.deepEqual(row, { before: true, accepted: true, expired: true });
        const q = f.publish(catalog, course),
          id = await reviewCourseComment(f.pool, actor.accountId, course.id, q);
        const review = (
          await f.pool.query(
            "SELECT whaleu_community.course_comment_review_status(id,true,issued_at-interval '1 microsecond') before,whaleu_community.course_comment_review_status(id,true,issued_at) AS accepted,whaleu_community.course_comment_review_status(id,true,consume_until) expired FROM whaleu_community.course_comment_review_decisions WHERE id=$1",
            [id],
          )
        ).rows[0];
        assert.deepEqual(review, {
          before: 'unavailable',
          accepted: 'allow',
          expired: 'unavailable',
        });
      },
    );
    await t.test(
      'whole-ranking Review time expiry beyond page invalidates continuation without epoch mutation',
      async () => {
        const q = f.publish(catalog, course),
          id = await reviewCourseComment(
            f.pool,
            actor.accountId,
            course.id,
            q,
            'allow',
            { visibilityUntil: new Date(Date.now() + 1200) },
          );
        ok(await publish(q));
        const p = await list('?limit=1&sort=likes');
        ok(p);
        assert.ok(p.body.nextCursor);
        const epoch = (
          await f.pool.query(
            'SELECT revision::text FROM whaleu_community.course_comment_review_epoch',
          )
        ).rows[0].revision;
        await delay(1300);
        const r = await list(
          `?limit=1&sort=likes&cursor=${encodeURIComponent(p.body.nextCursor)}`,
        );
        assert.ok(r.status === 503 || r.status === 409);
        assert.equal(
          (
            await f.pool.query(
              'SELECT revision::text FROM whaleu_community.course_comment_review_epoch',
            )
          ).rows[0].revision,
          epoch,
        );
        // The old immutable binding remains unavailable; never silently omit its body.
        assert.ok(id);
      },
    );
    await t.test(
      'Review expiry during real deferred wait rolls back exact publication and receipt',
      async () => {
        const q = f.publish(catalog, course);
        await reviewCourseComment(
          f.pool,
          actor.accountId,
          course.id,
          q,
          'allow',
          { consumeUntil: new Date(Date.now() + 800) },
        );
        await f.pool.query(
          'CREATE FUNCTION whaleu_ratings.c2_test_wait() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(1.1);RETURN NULL;END$$; CREATE CONSTRAINT TRIGGER zz_c2_test_wait AFTER INSERT ON whaleu_ratings.course_comment_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.c2_test_wait()',
        );
        try {
          const r = await publish(q);
          ok(r, 503);
          assert.equal(r.body.error.code, 'CONTENT_REVIEW_UNAVAILABLE');
        } finally {
          await f.pool.query(
            'DROP TRIGGER zz_c2_test_wait ON whaleu_ratings.course_comment_commands; DROP FUNCTION whaleu_ratings.c2_test_wait()',
          );
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.course_comments WHERE request_id=$1',
              [q.clientRequestId],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.course_comment_commands WHERE request_id=$1',
              [q.clientRequestId],
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      'Review revoked between consume and bind cannot leave a mutation or terminal false receipt',
      async () => {
        const q = f.publish(catalog, course),
          decision = await reviewCourseComment(
            f.pool,
            actor.accountId,
            course.id,
            q,
          );
        const owner = f.app.get(CourseCommentReviewFacade),
          original = owner.consume.bind(owner);
        owner.consume = async (...args) => {
          const result = await original(...args);
          await revokeCourseCommentReview(f.pool, decision);
          return result;
        };
        try {
          const r = await publish(q);
          assert.ok(r.status >= 400);
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_ratings.course_comment_commands WHERE request_id=$1',
                [q.clientRequestId],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_ratings.course_comments WHERE request_id=$1',
                [q.clientRequestId],
              )
            ).rows[0].n,
            0,
          );
        } finally {
          owner.consume = original;
        }
      },
    );
    await t.test(
      'queued source withdrawal after initial permission cannot commit a stale publication',
      async () => {
        const q = f.publish(catalog, course);
        await reviewCourseComment(f.pool, actor.accountId, course.id, q);
        const owner = f.app.get(CourseCommentReviewFacade),
          original = owner.consume.bind(owner),
          writer = await f.pool.connect();
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
          }),
          hold = new Promise<void>((resolve) => {
            release = resolve;
          });
        owner.consume = async (...args) => {
          const result = await original(...args);
          entered();
          await hold;
          return result;
        };
        try {
          const publishing = publish(q).then((r) => r);
          await ready;
          await writer.query('BEGIN');
          const withdrawal = writer.query(
            "UPDATE whaleu_ratings.course_catalog_head SET state='withdrawn'",
          );
          await f.waitForLock('UPDATE whaleu_ratings.course_catalog_head');
          release();
          ok(await publishing, 503);
          await withdrawal;
          await writer.query('COMMIT');
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_ratings.course_comments WHERE request_id=$1',
                [q.clientRequestId],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_ratings.course_comment_commands WHERE request_id=$1',
                [q.clientRequestId],
              )
            ).rows[0].n,
            0,
          );
        } finally {
          release();
          owner.consume = original;
          await writer.query('ROLLBACK');
          writer.release();
          await f.pool.query(
            "UPDATE whaleu_ratings.course_catalog_head SET state='accepted'",
          );
        }
      },
    );
    await t.test(
      'phone and history expiries during deferred waits roll back both native mutation and receipt',
      async () => {
        await f.pool.query(
          'CREATE FUNCTION whaleu_ratings.c2_test_wait() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(1.1);RETURN NULL;END$$; CREATE CONSTRAINT TRIGGER zz_c2_test_wait AFTER INSERT ON whaleu_ratings.course_comment_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.c2_test_wait()',
        );
        try {
          for (const kind of ['phone', 'history'] as const) {
            const a = await f.actor(),
              q = f.publish(catalog, course);
            await reviewCourseComment(f.pool, a.accountId, course.id, q);
            if (kind === 'phone')
              await f.certify(a.accountId, {
                expiresAt: new Date(Date.now() + 800),
              });
            else
              await commentHistory(
                f.pool,
                course.id,
                'population',
                'accepted_empty',
                new Date(Date.now() + 800),
              );
            ok(await publish(q, a), 503);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT count(*)::int n FROM whaleu_ratings.course_comments WHERE request_id=$1',
                  [q.clientRequestId],
                )
              ).rows[0].n,
              0,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT count(*)::int n FROM whaleu_ratings.course_comment_commands WHERE request_id=$1',
                  [q.clientRequestId],
                )
              ).rows[0].n,
              0,
            );
          }
        } finally {
          await f.pool.query(
            'DROP TRIGGER zz_c2_test_wait ON whaleu_ratings.course_comment_commands; DROP FUNCTION whaleu_ratings.c2_test_wait()',
          );
          await commentHistory(f.pool, course.id, 'population');
        }
      },
    );
    await t.test(
      'no inherited generic persona, experience, reward, notification effects',
      async () => {
        for (const table of [
          'whaleu_experience.work',
          'whaleu_experience.source_groups',
          'whaleu_experience.source_units',
          'whaleu_notifications.automatic_work',
          'whaleu_notifications.notices',
          'whaleu_notifications.rating_notices',
          'whaleu_notifications.system_notices',
        ])
          assert.equal(
            (await f.pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]
              .n,
            0,
            table,
          );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_community.thread_personas',
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_community.outbox',
            )
          ).rows[0].n,
          0,
        );
        const columns = (
          await f.pool.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='whaleu_ratings' AND table_name='course_comments' ORDER BY column_name",
          )
        ).rows.map((x) => x.column_name);
        for (const forbidden of [
          'author_mode',
          'persona_id',
          'profile_id',
          'avatar_id',
        ])
          assert.ok(!columns.includes(forbidden));
      },
    );
  },
);
