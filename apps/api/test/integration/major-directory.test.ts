import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import {
  majorDiscussionFixture,
  discussionHistory,
  reviewMajorDiscussion,
} from '../support/major-discussion-fixture.js';

const base = '/v1/majors';
const ok = (r: { status: number; body: unknown }, status = 200) =>
  assert.equal(r.status, status, JSON.stringify(r.body));

test(
  'independent source-backed Major directory, departments, filters, related and exact discussion summaries',
  { timeout: 240000 },
  async (t) => {
    const f = await majorDiscussionFixture();
    t.after(() => f.close());
    const actor = await f.actor({ identity: false }),
      phoneOnly = await f.actor({ affiliation: 'unverified', identity: false }),
      http = f.app.getHttpServer();
    const get = (path = '', a = phoneOnly) =>
      request(http)
        .get(base + path)
        .set('Authorization', 'Bearer ' + a.accessToken);
    const post = (path: string, body: object, a = actor) =>
      request(http)
        .post(base + path)
        .set('Authorization', 'Bearer ' + a.accessToken)
        .send(body);

    await t.test(
      'missing and unknown catalog cannot fabricate an empty production directory; explicit accepted empty can',
      async () => {
        ok(await request(http).get(base), 401);
        ok(await get(), 503);
        ok(await get('/departments'), 503);
        await f.accept([], { coverage: 'unknown' });
        ok(await get(), 503);
        const emptyCatalog = await f.accept([]),
          empty = await get();
        ok(empty);
        assert.deepEqual(empty.body, {
          catalogRevision: emptyCatalog,
          items: [],
          totalCount: 0,
          nextCursor: null,
          continuation: 'end',
        });
        assert.deepEqual((await get('/departments')).body, {
          catalogRevision: emptyCatalog,
          items: [],
        });
        ok(await get('/' + randomUUID()), 404);
      },
    );

    const first = f.add({
        id: '00000000-0000-4000-8000-000000000001',
        departmentId: 55,
        collegeName: 'Computer College',
        majorName: 'Systems %_\\',
      }),
      second = f.add({
        id: '00000000-0000-4000-8000-000000000002',
        departmentId: 55,
        collegeName: 'Computer College',
        majorName: 'Networks',
      }),
      third = f.add({
        id: '00000000-0000-4000-8000-000000000003',
        departmentId: 55,
        collegeName: 'Other College',
        majorName: 'Computer Theory',
      }),
      lower = f.add({ departmentId: -1, majorName: 'History' }),
      higher = f.add({
        departmentId: 100,
        majorName: 'Computer Theory',
        campusId: f.scope.foreign.campusId,
      }),
      inactive = f.add({ departmentId: 89, active: false });
    const rows = [higher, second, inactive, third, lower, first];
    let catalog = await f.accept(rows);

    await t.test(
      'departments group numerically without Course range assumptions; list uses department then stable ID',
      async () => {
        const departments = await get('/departments');
        ok(departments);
        assert.deepEqual(departments.body.items, [
          { departmentId: -1, name: '-1系' },
          { departmentId: 55, name: '55系' },
          { departmentId: 100, name: '100系' },
        ]);
        const all = await get();
        ok(all);
        assert.deepEqual(
          all.body.items.map((m: { id: string }) => m.id),
          [lower.id, first.id, second.id, third.id, higher.id],
        );
        assert.equal(all.body.totalCount, 5);
        assert.ok(
          all.body.items.every(
            (m: { summary: unknown }) =>
              JSON.stringify(m.summary) ===
              JSON.stringify({ kind: 'unavailable' }),
          ),
        );
        const view = (await get('/' + first.id)).body.item;
        assert.deepEqual(view, {
          id: first.id,
          majorRevision: first.revision,
          catalogRevision: catalog,
          campusId: first.campusId,
          departmentId: 55,
          collegeName: first.collegeName,
          majorName: first.majorName,
          summary: { kind: 'unavailable' },
        });
        for (const field of [
          'duration',
          'degree',
          'trainingGoal',
          'mainCourses',
          'careerDirection',
          'creatorId',
          'score',
          'ratingCount',
        ])
          assert.equal(field in view, false);
        ok(await get('/' + inactive.id), 404);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.window_catalogs',
            )
          ).rows[0]!.n,
          0,
        );
      },
    );

    await t.test(
      'department AND keyword matches major OR college; wildcard characters are literal and queries remain strict',
      async () => {
        const matches = await get('?departmentId=55&keyword=computer');
        ok(matches);
        assert.deepEqual(
          matches.body.items.map((m: { id: string }) => m.id),
          [first.id, second.id, third.id],
        );
        const exact = await get(
          '?departmentId=55&keyword=' + encodeURIComponent('%_\\'),
        );
        ok(exact);
        assert.deepEqual(
          exact.body.items.map((m: { id: string }) => m.id),
          [first.id],
        );
        assert.equal(
          (await get('?departmentId=100&keyword=Networks')).body.totalCount,
          0,
        );
        for (const query of [
          'departmentId=01',
          'departmentId=2147483648',
          'limit=51',
          'limit=0',
          'keyword=',
          'courseCode=Systems',
          'minRating=1',
          'campusId=' + first.campusId,
        ])
          ok(await get('?' + query), 400);
      },
    );

    await t.test(
      'opaque continuation binds actor, filters, limit and catalog; pages are duplicate-free',
      async () => {
        const page = await get('?departmentId=55&limit=1');
        ok(page);
        assert.equal(page.body.continuation, 'more');
        const cursor = encodeURIComponent(page.body.nextCursor),
          seen = [page.body.items[0].id];
        let next = page.body.nextCursor as string | null;
        while (next) {
          const r = await get(
            '?departmentId=55&limit=1&cursor=' + encodeURIComponent(next),
          );
          ok(r);
          seen.push(...r.body.items.map((m: { id: string }) => m.id));
          next = r.body.nextCursor;
        }
        assert.deepEqual(seen, [first.id, second.id, third.id]);
        ok(await get('?departmentId=55&limit=1&cursor=' + cursor, actor), 409);
        ok(await get('?departmentId=100&limit=1&cursor=' + cursor), 409);
        ok(await get('?departmentId=55&limit=2&cursor=' + cursor), 409);
        catalog = await f.accept(rows);
        ok(await get('?departmentId=55&limit=1&cursor=' + cursor), 409);
      },
    );

    await t.test(
      'related excludes itself, prefers same department, then deterministically fills other departments',
      async () => {
        const related = await get(`/${first.id}/related?limit=4`);
        ok(related);
        assert.deepEqual(
          related.body.items.map((m: { id: string }) => m.id),
          [second.id, third.id, lower.id, higher.id],
        );
        assert.equal(related.body.totalCount, 4);
        assert.equal(related.body.nextCursor, null);
        assert.equal(related.body.continuation, 'end');
        assert.equal(
          (await get(`/${first.id}/related?limit=1`)).body.items[0].id,
          second.id,
        );
        ok(await get(`/${first.id}/related?cursor=wrong`), 400);
        ok(await get(`/${first.id}/related?limit=51`), 400);
      },
    );

    await t.test(
      'summary is independent accepted population plus likes: roots only, full current hot order and no numeric score',
      async () => {
        await discussionHistory(f.pool, first.id, 'population');
        assert.deepEqual((await get('/' + first.id)).body.item.summary, {
          kind: 'unavailable',
        });
        await discussionHistory(f.pool, first.id, 'likes');
        assert.deepEqual((await get('/' + first.id)).body.item.summary, {
          kind: 'known',
          rootCount: 0,
          hotComment: null,
        });
        const publish = async (body: string) => {
          const q = f.root(catalog, first, body);
          await reviewMajorDiscussion(f.pool, actor.accountId, first.id, q);
          const result = await post(`/${first.id}/discussion`, q);
          ok(result);
          return result.body.commentId as string;
        };
        const one = await publish('  first source-preserved root  '),
          two = await publish('second root');
        const q = f.reply(catalog, first, 'flat reply');
        await reviewMajorDiscussion(f.pool, actor.accountId, first.id, q, one);
        ok(await post(`/${first.id}/discussion/${one}/replies`, q));
        ok(
          await post(
            `/${first.id}/discussion/${one}/like`,
            f.like(catalog, first),
            phoneOnly,
          ),
        );
        const summary = (await get('/' + first.id)).body.item.summary;
        assert.deepEqual(summary, {
          kind: 'known',
          rootCount: 2,
          hotComment: {
            id: one,
            body: '  first source-preserved root  ',
            likes: 1,
          },
        });
        assert.notEqual(one, two);
        assert.equal(
          (
            await f.pool.query(
              "SELECT count(*)::int n FROM whaleu_notifications.major_discussion_notices WHERE kind='reply'",
            )
          ).rows[0]!.n,
          0,
          'self reply does not notify; roots have no creator notification',
        );
        await discussionHistory(f.pool, first.id, 'likes', 'unknown');
        assert.deepEqual((await get('/' + first.id)).body.item.summary, {
          kind: 'unavailable',
        });
      },
    );

    await t.test(
      'accepted source is sealed; identity never remaps source school, campus or department',
      async () => {
        await assert.rejects(
          f.accept([{ ...first, departmentId: 100 }]),
          /foreign key|violates/i,
        );
        await assert.rejects(
          f.accept([{ ...first, campusId: f.scope.foreign.campusId }]),
          /foreign key|violates/i,
        );
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_majors.major_identities SET department_id=department_id',
          ),
          /immutable/,
        );
        await assert.rejects(
          f.pool.query(
            'UPDATE whaleu_majors.major_entries SET major_name=major_name',
          ),
          /immutable/,
        );
        await assert.rejects(
          f.pool.query(
            "INSERT INTO whaleu_majors.major_entries(catalog_id,major_id,revision,department_id,college_name,major_name,is_active,campus_id,source_school_key,school_mapping_reference) VALUES($1,$2,$3,$4,$5,$6,true,$7,$8,'synthetic:sealed-late-write')",
            [
              catalog,
              first.id,
              randomUUID(),
              first.departmentId,
              first.collegeName,
              first.majorName,
              first.campusId,
              'synthetic:source-school:' + first.campusId,
            ],
          ),
          /sealed/,
        );
        const clock = (
          await f.pool.query(
            "SELECT whaleu_majors.major_catalog_source(c.accepted_at-interval '1 microsecond') IS NULL before,whaleu_majors.major_catalog_source(c.valid_until) IS NULL expired FROM whaleu_majors.major_catalogs c WHERE c.id=$1",
            [catalog],
          )
        ).rows[0];
        assert.deepEqual(clock, { before: true, expired: true });
        await f.pool.query(
          "UPDATE whaleu_majors.major_catalog_head SET state='withdrawn'",
        );
        ok(await get(), 503);
        ok(await get('/' + first.id), 503);
      },
    );
  },
);
