import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import {
  courseRatingFixture,
  courseHistory,
} from '../support/course-rating-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import {
  CourseRatingsService,
  courseIntentHash,
} from '../../src/ratings/courses/service.js';
import {
  currentCatalog,
  retainScoreEpoch,
} from '../../src/ratings/courses/proof.js';
import { CourseRepository } from '../../src/ratings/courses/repository.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
const base = '/v1/ratings/courses';
function ok(r: { status: number; body: unknown }, status = 200) {
  assert.equal(r.status, status, JSON.stringify(r.body));
}
test(
  'course source-backed directory, independent immutable first tuples, exact coverage/receipts and current owner proofs',
  { timeout: 240000 },
  async (t) => {
    const f = await courseRatingFixture();
    t.after(() => f.close());
    const actor = await f.actor({ affiliation: 'unverified', identity: false }),
      other = await f.actor({ affiliation: 'unverified', identity: false }),
      http = f.app.getHttpServer();
    type Actor = typeof actor;
    const get = (path = '', a: Actor = actor) =>
      request(http)
        .get(base + path)
        .set('Authorization', `Bearer ${a.accessToken}`);
    const post = (id: string, body: object, a: Actor = actor) =>
      request(http)
        .post(`${base}/${id}/first-score`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send(body);
    const plain = f.add({ name: 'Synthetic Algebra', department: 1 }),
      group90 = f.add({
        name: 'Synthetic Biology',
        department: 90,
        category: 'Synthetic Lab',
      }),
      group99 = f.add({
        name: 'Synthetic Coding',
        department: 99,
        category: 'Synthetic Lab',
      }),
      unknown = f.add({
        name: 'Synthetic History Unknown',
        department: 54,
        history: 'unknown',
      });
    let catalog: string;
    let original: ReturnType<typeof f.command>;
    let receipt: unknown;
    await t.test(
      'production default is unavailable; only explicit synthetic complete acceptance is known-empty',
      async () => {
        ok(await request(http).get(base), 401);
        assert.equal(
          (await get()).body.error.code,
          'COURSE_CATALOG_UNAVAILABLE',
        );
        catalog = await f.accept([]);
        let r = await get();
        ok(r);
        assert.deepEqual(r.body.items, []);
        assert.equal(r.body.continuation, 'end');
        catalog = await f.accept([plain, group90, group99, unknown]);
        r = await get(`/${plain.id}`);
        ok(r);
        assert.equal(r.body.myScore.kind, 'not_submitted');
        assert.deepEqual(r.body.course.summary, {
          kind: 'known',
          count: 0,
          gradeScore: null,
          abilityScore: null,
          overallScore: null,
        });
        assert.equal(r.body.course.campusId, f.scope.home.campusId);
        assert.equal(r.body.course.sourceCampusKey, 'synthetic:source-campus');
      },
    );
    await t.test(
      'exclusive legacy filters, name-only substring, rating/time ordering and opaque current-revision bounded pages',
      async () => {
        let r = await get('?department=99');
        ok(r);
        assert.deepEqual(
          new Set(r.body.items.map((v: { id: string }) => v.id)),
          new Set([group90.id, group99.id]),
        );
        ok(await get('?department=99&category=Synthetic%20Lab'), 400);
        ok(await get('?department=90'), 400);
        r = await get('?category=Synthetic%20Lab');
        ok(r);
        assert.equal(r.body.items.length, 2);
        r = await get('?search=lGeB');
        ok(r);
        assert.equal(r.body.items[0].id, plain.id);
        r = await get('?search=SYNTH-0');
        ok(r);
        assert.deepEqual(r.body.items, [], 'source code is not name search');
        r = await get('?sort=time&limit=2');
        ok(r);
        assert.deepEqual(
          r.body.items.map((v: { id: string }) => v.id),
          [unknown.id, group99.id],
        );
        const cursor = r.body.nextCursor;
        assert.ok(cursor);
        const next = await get(
          '?sort=time&limit=2&cursor=' + encodeURIComponent(cursor),
        );
        ok(next);
        assert.deepEqual(
          next.body.items.map((v: { id: string }) => v.id),
          [group90.id, plain.id],
        );
        assert.equal(next.body.nextCursor, null);
        assert.equal(
          (
            await get(
              '?sort=rating&limit=2&cursor=' + encodeURIComponent(cursor),
            )
          ).body.error.code,
          'DISCOVERY_RESTART_REQUIRED',
        );
        assert.equal(
          (
            await get(
              '?sort=time&limit=2&cursor=' + encodeURIComponent(cursor),
              other,
            )
          ).body.error.code,
          'DISCOVERY_RESTART_REQUIRED',
        );
        await courseHistory(f.pool, unknown.id, 'unknown');
        assert.equal(
          (await get('?sort=time&limit=2&cursor=' + encodeURIComponent(cursor)))
            .body.error.code,
          'DISCOVERY_RESTART_REQUIRED',
        );
      },
    );
    await t.test(
      'unknown own/history never coerces to not-submitted or zero; cannot begin first tuple',
      async () => {
        const r = await get(`/${unknown.id}`);
        ok(r);
        assert.deepEqual(r.body.myScore, { kind: 'unavailable' });
        assert.deepEqual(r.body.course.summary, { kind: 'unavailable' });
        const body = f.command(catalog, unknown);
        assert.equal(
          (await post(unknown.id, body)).body.error.code,
          'COURSE_HISTORY_UNAVAILABLE',
        );
        assert.equal(
          (await get('/requests/' + body.clientRequestId)).body.error.code,
          'REQUEST_NOT_FOUND',
        );
      },
    );
    await t.test(
      'HTTP rejects missing/coerced/non-half scores and untrusted legacy actor identity; no partial ledger',
      async () => {
        for (const axis of ['gradeScore', 'abilityScore', 'overallScore'])
          for (const value of [null, '2', 0, 0.75, 5.5])
            ok(
              await post(
                plain.id,
                f.command(catalog, plain, { [axis]: value }),
              ),
              400,
            );
        ok(
          await post(plain.id, {
            ...f.command(catalog, plain),
            user_id: other.accountId,
            openid: 'untrusted',
          }),
          400,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.course_scores',
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      'first tuple preserves independent overall; exact same-key replay and durable terminal duplicate',
      async () => {
        original = f.command(catalog, plain);
        const r = await post(plain.id, original);
        ok(r);
        receipt = r.body;
        assert.equal(r.body.gradeScore, 0.5);
        assert.equal(r.body.abilityScore, 3);
        assert.equal(r.body.overallScore, 5);
        assert.deepEqual((await post(plain.id, original)).body, receipt);
        assert.deepEqual(
          (await get('/requests/' + original.clientRequestId)).body,
          receipt,
        );
        assert.equal(
          (await post(plain.id, { ...original, overallScore: 4 })).body.error
            .code,
          'REQUEST_CONFLICT',
        );
        const duplicate = f.command(catalog, plain, { gradeScore: 5 });
        const rejection = await post(plain.id, duplicate);
        ok(rejection);
        assert.equal(rejection.body.code, 'COURSE_ALREADY_RATED');
        assert.deepEqual(
          (await get('/requests/' + duplicate.clientRequestId)).body,
          rejection.body,
        );
        const own = await get(`/${plain.id}/my-score`);
        ok(own);
        assert.equal(own.body.kind, 'recorded');
        assert.equal(own.body.overallScore, 5);
        assert.equal(
          (await get(`/${plain.id}/my-score`, other)).body.kind,
          'not_submitted',
        );
        assert.equal(
          (await get('/requests/' + original.clientRequestId, other)).body.error
            .code,
          'REQUEST_NOT_FOUND',
        );
        for (const value of [
          await get(),
          await get(`/${plain.id}`),
          await get(`/${plain.id}/summary`),
        ]) {
          const serialized = JSON.stringify(value.body);
          assert.ok(!serialized.includes(actor.accountId));
          assert.ok(!serialized.includes(other.accountId));
        }
      },
    );
    await t.test(
      'three exact means independently rounded to one decimal with half-up ties, score order and stale continuations',
      async () => {
        const page = await get('?limit=1'),
          cursor = page.body.nextCursor;
        const r = await post(
          plain.id,
          f.command(catalog, plain, {
            gradeScore: 2,
            abilityScore: 1,
            overallScore: 0.5,
          }),
          other,
        );
        ok(r);
        assert.deepEqual((await get(`/${plain.id}/summary`)).body, {
          kind: 'known',
          count: 2,
          gradeScore: 1.3,
          abilityScore: 2,
          overallScore: 2.8,
        });
        assert.equal(
          (await get('?limit=1&cursor=' + encodeURIComponent(cursor))).body
            .error.code,
          'DISCOVERY_RESTART_REQUIRED',
        );
        assert.equal((await get('?sort=rating')).body.items[0].id, plain.id);
      },
    );
    await t.test(
      'all ten half-unit values occur independently on each axis in actual PostgreSQL',
      async () => {
        for (let i = 1; i <= 10; i++) {
          const a = await f.actor({
            affiliation: 'unverified',
            identity: false,
          });
          ok(
            await post(
              group90.id,
              f.command(catalog, group90, {
                gradeScore: i / 2,
                abilityScore: (11 - i) / 2,
                overallScore: (((i + 3) % 10) + 1) / 2,
              }),
              a,
            ),
          );
        }
        assert.deepEqual((await get(`/${group90.id}/summary`)).body, {
          kind: 'known',
          count: 10,
          gradeScore: 2.8,
          abilityScore: 2.8,
          overallScore: 2.8,
        });
        const r = (
          await f.pool.query(
            'SELECT array_agg(DISTINCT grade_half_units ORDER BY grade_half_units) grade,array_agg(DISTINCT ability_half_units ORDER BY ability_half_units) ability,array_agg(DISTINCT overall_half_units ORDER BY overall_half_units) overall FROM whaleu_ratings.course_scores WHERE course_id=$1',
            [group90.id],
          )
        ).rows[0];
        for (const axis of ['grade', 'ability', 'overall'])
          assert.deepEqual(r[axis], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      },
    );
    await t.test(
      'concurrent different keys serialize one lifetime tuple and replay the immutable winner',
      async () => {
        const a = await f.actor({ affiliation: 'unverified', identity: false }),
          one = f.command(catalog, group99, { overallScore: 1 }),
          two = f.command(catalog, group99, { overallScore: 4 });
        const results = await Promise.all([
          post(group99.id, one, a),
          post(group99.id, two, a),
        ]);
        for (const r of results) ok(r);
        assert.deepEqual(results.map((r) => r.body.outcome).sort(), [
          'applied',
          'rejected',
        ]);
        assert.equal(
          results.find((r) => r.body.outcome === 'rejected')!.body.code,
          'COURSE_ALREADY_RATED',
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.course_scores WHERE course_id=$1 AND actor_id=$2',
              [group99.id, a.accountId],
            )
          ).rows[0].n,
          1,
        );
        const retries = await Promise.all([
          post(group99.id, one, a),
          post(group99.id, two, a),
        ]);
        for (let i = 0; i < 2; i++)
          assert.deepEqual(retries[i]!.body, results[i]!.body);
      },
    );
    await t.test(
      'uppercase UUID inputs normalize before identity locking, hashing and exact receipt comparison',
      async () => {
        const a = await f.actor({ affiliation: 'unverified', identity: false }),
          body = f.command(catalog, group99);
        const upper = {
          ...body,
          clientRequestId: body.clientRequestId.toUpperCase(),
          expectedCatalogRevision: body.expectedCatalogRevision.toUpperCase(),
          expectedCourseRevision: body.expectedCourseRevision.toUpperCase(),
        };
        const r = await post(group99.id.toUpperCase(), upper, a);
        ok(r);
        assert.equal(r.body.outcome, 'applied');
        assert.equal(r.body.courseId, group99.id);
        assert.equal(r.body.requestId, body.clientRequestId);
        assert.deepEqual((await post(group99.id, body, a)).body, r.body);
        assert.deepEqual(
          (await get('/requests/' + body.clientRequestId.toUpperCase(), a))
            .body,
          r.body,
        );
      },
    );
    await t.test(
      'stale source revisions persist a terminal original-key rejection without scoring',
      async () => {
        const a = await f.actor({ affiliation: 'unverified', identity: false }),
          b = f.command(randomUUID(), group99);
        const r = await post(group99.id, b, a);
        ok(r);
        assert.equal(r.body.code, 'COURSE_REVISION_CONFLICT');
        assert.deepEqual(
          (await get('/requests/' + b.clientRequestId, a)).body,
          r.body,
        );
        assert.equal(
          (await get(`/${group99.id}/my-score`, a)).body.kind,
          'not_submitted',
        );
      },
    );
    await t.test(
      'current phone and session admission; source/campus withdrawals fail closed, historical recovery stays minimal',
      async () => {
        const noPhone = await f.actor({
          phone: 'unverified',
          affiliation: 'unverified',
          identity: false,
        });
        assert.equal(
          (await get('', noPhone)).body.error.code,
          'PHONE_VERIFICATION_REQUIRED',
        );
        const unknownPhone = await createRuntimeActor(f.app);
        assert.equal(
          (await get('', unknownPhone as Actor)).body.error.code,
          'VERIFICATION_UNAVAILABLE',
        );
        await f.certify(actor.accountId, {
          phone: 'unverified',
          affiliation: 'unverified',
          identity: false,
        });
        assert.equal(
          (await get()).body.error.code,
          'PHONE_VERIFICATION_REQUIRED',
        );
        assert.deepEqual(
          (await get('/requests/' + original.clientRequestId)).body,
          receipt,
        );
        assert.deepEqual((await post(plain.id, original)).body, receipt);
        await f.certify(actor.accountId, {
          affiliation: 'unverified',
          identity: false,
        });
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
            [actor.accountId],
          ),
        );
        assert.equal((await get()).body.error.code, 'SAFETY_ACTION_RESTRICTED');
        assert.deepEqual(
          (await get('/requests/' + original.clientRequestId)).body,
          receipt,
        );
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_safety.account_heads SET actions_allowed=true WHERE account_id=$1',
            [actor.accountId],
          ),
        );
        await f.pool.query(
          "UPDATE whaleu_ratings.course_catalog_head SET state='withdrawn'",
        );
        assert.equal(
          (await get()).body.error.code,
          'COURSE_CATALOG_UNAVAILABLE',
        );
        assert.deepEqual(
          (await get('/requests/' + original.clientRequestId)).body,
          receipt,
        );
        await f.pool.query(
          "UPDATE whaleu_ratings.course_catalog_head SET state='accepted'",
        );
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
            [f.scope.home.campusId],
          ),
        );
        assert.equal(
          (await get(`/${plain.id}`)).body.error.code,
          'COURSE_CATALOG_UNAVAILABLE',
        );
        assert.deepEqual(
          (await get('/requests/' + original.clientRequestId)).body,
          receipt,
        );
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_campus.campuses SET is_active=true WHERE id=$1',
            [f.scope.home.campusId],
          ),
        );
        await f.app.get(IdentityService).logout(other.accessToken);
        ok(await get('/requests/' + original.clientRequestId, other), 401);
      },
    );
    await t.test(
      'post-write source, Safety and current-session changes roll back original tuple and receipt together',
      async () => {
        const records = f.app.get(CourseRepository),
          record = records.record.bind(records);
        for (const kind of ['source', 'safety', 'session'] as const) {
          const a = await f.actor({
              affiliation: 'unverified',
              identity: false,
            }),
            body = f.command(catalog, group99);
          records.record = async (...args) => {
            await record(...args);
            const tx = args[5];
            if (kind === 'source')
              await tx.query(
                "UPDATE whaleu_ratings.course_catalog_head SET state='withdrawn'",
              );
            else if (kind === 'safety')
              await tx.query(
                'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
                [a.accountId],
              );
            else
              await tx.query(
                "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
                [a.sessionId],
              );
          };
          try {
            const r = await post(group99.id, body, a);
            assert.ok([401, 503].includes(r.status), JSON.stringify(r.body));
          } finally {
            records.record = record;
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_ratings.course_scores WHERE course_id=$1 AND actor_id=$2',
                [group99.id, a.accountId],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_ratings.course_commands WHERE actor_id=$1 AND request_id=$2',
                [a.accountId, body.clientRequestId],
              )
            ).rows[0].n,
            0,
          );
        }
      },
    );
    await t.test(
      'a queued external source-withdrawal writer defeats the final proof without committing a tuple or receipt',
      async () => {
        const a = await f.actor({ affiliation: 'unverified', identity: false }),
          body = f.command(catalog, group99);
        const records = f.app.get(CourseRepository),
          record = records.record.bind(records),
          writer = await f.pool.connect();
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>((resolve) => {
            entered = resolve;
          }),
          hold = new Promise<void>((resolve) => {
            release = resolve;
          });
        records.record = async (...args) => {
          await record(...args);
          entered();
          await hold;
        };
        try {
          const submitting = post(group99.id, body, a).then((result) => result);
          await ready;
          await writer.query('BEGIN');
          const withdrawal = writer.query(
            "UPDATE whaleu_ratings.course_catalog_head SET state='withdrawn'",
          );
          await f.waitForLock('UPDATE whaleu_ratings.course_catalog_head');
          release();
          const result = await submitting;
          ok(result, 503);
          await withdrawal;
          await writer.query('COMMIT');
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_ratings.course_scores WHERE actor_id=$1',
                [a.accountId],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_ratings.course_commands WHERE actor_id=$1',
                [a.accountId],
              )
            ).rows[0].n,
            0,
          );
        } finally {
          release();
          records.record = record;
          await writer.query('ROLLBACK');
          writer.release();
          await f.pool.query(
            "UPDATE whaleu_ratings.course_catalog_head SET state='accepted'",
          );
        }
      },
    );
    await t.test(
      'phone expiry through a real deferred constraint wait rolls back both first tuple and receipt',
      async () => {
        const a = await f.actor({ affiliation: 'unverified', identity: false }),
          body = f.command(catalog, group99);
        await f.certify(a.accountId, {
          affiliation: 'unverified',
          identity: false,
          expiresAt: new Date(Date.now() + 1000),
        });
        await f.pool.query(
          'CREATE FUNCTION whaleu_ratings.course_test_deferred_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.2); RETURN NULL; END $$; CREATE CONSTRAINT TRIGGER zz_course_test_deferred_wait AFTER INSERT ON whaleu_ratings.course_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.course_test_deferred_wait()',
        );
        try {
          const r = await post(group99.id, body, a);
          ok(r, 503);
          assert.equal(r.body.error.code, 'VERIFICATION_UNAVAILABLE');
        } finally {
          await f.pool.query(
            'DROP TRIGGER zz_course_test_deferred_wait ON whaleu_ratings.course_commands;DROP FUNCTION whaleu_ratings.course_test_deferred_wait()',
          );
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.course_scores WHERE actor_id=$1',
              [a.accountId],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.course_commands WHERE actor_id=$1',
              [a.accountId],
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      'raw SQL cannot edit/delete/truncate original tuples or receipts, append accepted source or fake missing-score receipt',
      async () => {
        for (const sql of [
          'UPDATE whaleu_ratings.course_scores SET overall_half_units=1',
          'DELETE FROM whaleu_ratings.course_scores',
          'TRUNCATE whaleu_ratings.course_scores CASCADE',
          "UPDATE whaleu_ratings.course_commands SET receipt='{}'::jsonb",
          'DELETE FROM whaleu_ratings.course_commands',
          "UPDATE whaleu_ratings.course_entries SET name='Changed'",
        ]) {
          await assert.rejects(
            f.pool.query(sql),
            (e: unknown) => (e as { code?: string }).code === '23514',
            sql,
          );
        }
        const forged = f.command(catalog, group99),
          hash = courseIntentHash(actor.accountId, group99.id, forged);
        for (const fake of [
          {
            outcome: 'applied',
            gradeScore: 0.5,
            abilityScore: 3,
            overallScore: 5,
            recordedAt: new Date().toISOString(),
          },
          { outcome: 'rejected', code: null },
          { outcome: 'rejected', code: 'COURSE_REVISION_CONFLICT' },
        ]) {
          await assert.rejects(
            f.pool.query(
              'INSERT INTO whaleu_ratings.course_commands(actor_id,request_id,course_id,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6)',
              [
                actor.accountId,
                forged.clientRequestId,
                group99.id,
                JSON.stringify(forged),
                hash,
                JSON.stringify({
                  requestId: forged.clientRequestId,
                  operation: 'course.first-score.v1',
                  courseId: group99.id,
                  ...fake,
                }),
              ],
            ),
            (e: unknown) => (e as { code?: string }).code === '23514',
          );
        }
        const unavailable = f.command(randomUUID(), group99),
          unavailableHash = courseIntentHash(
            actor.accountId,
            group99.id,
            unavailable,
          );
        await f.pool.query(
          "UPDATE whaleu_ratings.course_catalog_head SET state='withdrawn'",
        );
        try {
          await assert.rejects(
            f.pool.query(
              'INSERT INTO whaleu_ratings.course_commands(actor_id,request_id,course_id,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6)',
              [
                actor.accountId,
                unavailable.clientRequestId,
                group99.id,
                JSON.stringify(unavailable),
                unavailableHash,
                JSON.stringify({
                  requestId: unavailable.clientRequestId,
                  operation: 'course.first-score.v1',
                  courseId: group99.id,
                  outcome: 'rejected',
                  code: 'COURSE_REVISION_CONFLICT',
                }),
              ],
            ),
            (e: unknown) => (e as { code?: string }).code === '23514',
          );
        } finally {
          await f.pool.query(
            "UPDATE whaleu_ratings.course_catalog_head SET state='accepted'",
          );
        }
        await assert.rejects(
          f.pool.query(
            'INSERT INTO whaleu_ratings.course_entries SELECT catalog_id,course_id,$1,name,department,category,nature,code,campus_id,source_campus_key,campus_label,campus_mapping_reference,source_created_at FROM whaleu_ratings.course_entries LIMIT 1',
            [randomUUID()],
          ),
          (e: unknown) => (e as { code?: string }).code === '23514',
        );
      },
    );
    await t.test(
      'history expiry anywhere in the full sorted candidate set forces cursor restart without mutation',
      async () => {
        const timed = f.add({ name: 'Synthetic Expiring Highest Course' });
        catalog = await f.accept([...f.courses, timed]);
        const a = await f.actor({ affiliation: 'unverified', identity: false });
        ok(
          await post(
            timed.id,
            f.command(catalog, timed, { overallScore: 5 }),
            a,
          ),
        );
        await courseHistory(
          f.pool,
          timed.id,
          'accepted_empty',
          new Date(Date.now() + 1200),
        );
        const first = await get('?sort=rating&limit=1');
        ok(first);
        assert.equal(first.body.items[0].id, timed.id);
        const cursor = first.body.nextCursor;
        assert.ok(cursor);
        const epoch = (
          await f.pool.query(
            'SELECT revision::text FROM whaleu_ratings.course_score_epoch',
          )
        ).rows[0].revision;
        await delay(1300);
        assert.equal(
          (
            await f.pool.query(
              'SELECT revision::text FROM whaleu_ratings.course_score_epoch',
            )
          ).rows[0].revision,
          epoch,
          'no mutation drives this invalidation',
        );
        assert.equal(
          (
            await get(
              '?sort=rating&limit=1&cursor=' + encodeURIComponent(cursor),
            )
          ).body.error.code,
          'DISCOVERY_RESTART_REQUIRED',
        );
        const fresh = await get('?sort=rating&limit=1');
        ok(fresh);
        assert.notEqual(fresh.body.items[0].id, timed.id);
        // An expiring non-page-one candidate is also covered by the global deadline.
        await courseHistory(
          f.pool,
          group90.id,
          'accepted_empty',
          new Date(Date.now() + 1200),
        );
        const outside = await get('?sort=time&limit=1');
        ok(outside);
        assert.equal(outside.body.items[0].id, timed.id);
        await delay(1300);
        assert.equal(
          (
            await get(
              '?sort=time&limit=1&cursor=' +
                encodeURIComponent(outside.body.nextCursor),
            )
          ).body.error.code,
          'DISCOVERY_RESTART_REQUIRED',
        );
      },
    );
    await t.test(
      'entry assembly and acceptance serialize across two real connections; sealed snapshots never accept a late entry',
      async () => {
        const clone = async () => {
          const id = randomUUID();
          await f.pool.query(
            'INSERT INTO whaleu_ratings.course_catalogs SELECT $1,source_namespace,source_reference,source_revision,coverage,scope_policy,policy_reference,accepted_at,valid_until FROM whaleu_ratings.course_catalogs WHERE id=$2',
            [id, catalog],
          );
          return id;
        };
        const insert = `INSERT INTO whaleu_ratings.course_entries SELECT $1,course_id,revision,name,department,category,nature,code,campus_id,source_campus_key,campus_label,campus_mapping_reference,source_created_at FROM whaleu_ratings.course_entries WHERE catalog_id=$2 AND course_id=$3`;
        const c = await clone(),
          one = await f.pool.connect(),
          two = await f.pool.connect();
        try {
          await one.query('BEGIN');
          await one.query(insert, [c, catalog, plain.id]);
          await two.query('BEGIN');
          const seal = two.query(
            'INSERT INTO whaleu_ratings.course_catalog_acceptances(catalog_id) VALUES($1)',
            [c],
          );
          await f.waitForLock('course_catalog_acceptances');
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_ratings.course_catalog_acceptances WHERE catalog_id=$1',
                [c],
              )
            ).rows[0].n,
            0,
          );
          await one.query('COMMIT');
          await seal;
          await two.query('COMMIT');
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_ratings.course_entries WHERE catalog_id=$1',
                [c],
              )
            ).rows[0].n,
            1,
          );
          const second = await clone();
          await one.query('BEGIN');
          await one.query(
            'INSERT INTO whaleu_ratings.course_catalog_acceptances(catalog_id) VALUES($1)',
            [second],
          );
          await two.query('BEGIN');
          const late = two.query(insert, [second, catalog, plain.id]).then(
            () => null,
            (error) => error as { code: string },
          );
          await f.waitForLock('course_entries');
          await one.query('COMMIT');
          assert.equal((await late)?.code, '23514');
          await two.query('ROLLBACK');
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_ratings.course_entries WHERE catalog_id=$1',
                [second],
              )
            ).rows[0].n,
            0,
          );
          await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await assert.rejects(
            one.query(insert, [await clone(), catalog, plain.id]),
            (e: unknown) => (e as { code?: string }).code === '23514',
          );
          await one.query('ROLLBACK');
        } finally {
          await one.query('ROLLBACK');
          await two.query('ROLLBACK');
          one.release();
          two.release();
        }
      },
    );
    await t.test(
      'final source and score-epoch proofs reject changed facts after initial read, with no stale result escaping',
      async () => {
        await assert.rejects(
          inTransaction(
            f.pool,
            async (tx) => {
              await currentCatalog(tx);
              await tx.query(
                "UPDATE whaleu_ratings.course_catalog_head SET state='withdrawn'",
              );
              return 'must not escape';
            },
            { isolationLevel: 'read committed' },
          ),
        );
        await assert.rejects(
          inTransaction(
            f.pool,
            async (tx) => {
              await retainScoreEpoch(tx);
              await tx.query(
                'UPDATE whaleu_ratings.course_score_epoch SET revision=revision+1',
              );
            },
            { isolationLevel: 'read committed' },
          ),
        );
        const service = f.app.get(CourseRatingsService),
          repo = f.app.get(CourseRepository);
        assert.ok(service);
        assert.ok(repo);
        assert.equal((await get(`/${plain.id}`)).body.course.summary.count, 2);
      },
    );
  },
);
