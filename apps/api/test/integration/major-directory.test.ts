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

test(
  'cold Major capture plans stay scalar and retain full off-page inactive history, Review and Safety deadlines',
  { timeout: 180000 },
  async (t) => {
    const { majorCatalog, majorCatalogCaptureSql } =
      await import('../../src/majors/proof.js');
    const { discussionEpoch, majorDiscussionEpochSql } =
      await import('../../src/majors/discussion/proof.js');
    const f = await majorDiscussionFixture();
    t.after(() => f.close());
    const publisher = await f.actor({ identity: false });
    const reader = await f.actor({
      affiliation: 'unverified',
      identity: false,
    });
    const session = (
      await f.pool.query<{ id: string }>(
        'SELECT id FROM whaleu_identity.sessions WHERE account_id=$1',
        [reader.accountId],
      )
    ).rows[0]!.id;
    const rows = Array.from({ length: 1000 }, (_, departmentId) =>
      f.add({ departmentId }),
    );
    const offPage = rows.at(-1)!;
    const catalog = await f.accept(rows);
    const get = () =>
      request(f.app.getHttpServer())
        .get('/v1/majors')
        .set('Authorization', 'Bearer ' + reader.accessToken);
    await f.acceptDiscussion([
      ...rows.slice(0, 50).map((row) => row.id),
      offPage.id,
    ]);
    const time = (
      await f.pool.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]!.now.getTime();
    const visibility = new Date(time + 180000);
    const command = f.root(catalog, offPage, 'Complete off-page boundary');
    await reviewMajorDiscussion(
      f.pool,
      publisher.accountId,
      offPage.id,
      command,
      null,
      'allow',
      { visibilityUntil: visibility },
    );
    ok(
      await request(f.app.getHttpServer())
        .post(`/v1/majors/${offPage.id}/discussion`)
        .set('Authorization', 'Bearer ' + publisher.accessToken)
        .send(command),
    );
    rows[rows.length - 1] = { ...offPage, active: false };
    await f.accept(rows);
    const future = new Date(time + 120000),
      assertion = randomUUID();
    await f.pool.query(
      "INSERT INTO whaleu_majors.major_discussion_history_assertions(id,major_id,kind,coverage,source_reference,policy_reference,accepted_at,valid_until) VALUES($1,$2,'likes','unknown','synthetic:future-offpage','synthetic:preserve-all-boundaries',$3,$4)",
      [assertion, offPage.id, future, new Date(time + 3600000)],
    );
    await f.pool.query(
      "UPDATE whaleu_majors.major_discussion_history_heads SET assertion_id=$2 WHERE major_id=$1 AND kind='likes'",
      [offPage.id, assertion],
    );
    const read = async () => {
      const instant = (
        await f.pool.query<{ now: string }>(
          'SELECT clock_timestamp()::text now',
        )
      ).rows[0]!.now;
      const values = [reader.accountId, session, instant];
      const current = (
        await f.pool.query(
          majorCatalogCaptureSql.replace(
            'clock_timestamp() now',
            '$3::timestamptz now',
          ),
          values,
        )
      ).rows[0];
      const oracle = (
        await f.pool.query(
          `SELECT least($3::timestamptz+interval '10 minutes',whaleu_majors.major_discussion_access_deadline($1,$2,$3),whaleu_majors.major_discussion_source_boundary($3),(SELECT min(whaleu_majors.major_discussion_deadline(e.major_id,$3)) FROM whaleu_majors.major_entries e WHERE e.catalog_id=(whaleu_majors.major_catalog_source($3)->>'catalog')::uuid))::text until`,
          values,
        )
      ).rows[0];
      assert.equal(
        current.until,
        oracle.until,
        'set-oriented result equals the complete original per-Major boundary oracle',
      );
      return current;
    };
    assert.equal(
      new Date((await read()).until).getTime(),
      future.getTime(),
      'future-issued history on an inactive off-page Major is not pruned',
    );
    await discussionHistory(f.pool, offPage.id, 'likes');
    assert.equal(
      new Date((await read()).until).getTime(),
      visibility.getTime(),
      'off-page Review visibility remains a boundary',
    );
    const safety = new Date(time + 60000);
    await f.pool.query(
      'UPDATE whaleu_safety.account_heads SET valid_until=$2 WHERE account_id=$1',
      [publisher.accountId, safety],
    );
    assert.equal(
      new Date((await read()).until).getTime(),
      safety.getTime(),
      'off-page author Safety is independent of the reader access deadline',
    );
    const firstPage = await get();
    ok(firstPage);
    assert.equal(firstPage.body.totalCount, 999);
    assert.equal(firstPage.body.items.length, 20);
    assert.ok(
      firstPage.body.items.every(
        (item: { summary: unknown }) =>
          JSON.stringify(item.summary) ===
          JSON.stringify({ kind: 'known', rootCount: 0, hotComment: null }),
      ),
    );
    assert.equal(typeof firstPage.body.nextCursor, 'string');
    const nextPage = await request(f.app.getHttpServer())
      .get('/v1/majors?cursor=' + encodeURIComponent(firstPage.body.nextCursor))
      .set('Authorization', 'Bearer ' + reader.accessToken);
    ok(nextPage);
    assert.equal(nextPage.body.totalCount, 999);
    assert.equal(nextPage.body.items[0].id, rows[20]!.id);
    assert.notEqual(nextPage.body.items[0].id, firstPage.body.items[0].id);
    const maximumPage = await request(f.app.getHttpServer())
      .get('/v1/majors?limit=50')
      .set('Authorization', 'Bearer ' + reader.accessToken);
    ok(maximumPage);
    assert.equal(maximumPage.body.items.length, 50);
    assert.ok(
      maximumPage.body.items.every(
        (item: { summary: unknown }) =>
          JSON.stringify(item.summary) ===
          JSON.stringify({ kind: 'known', rootCount: 0, hotComment: null }),
      ),
    );
    const maximumNext = await request(f.app.getHttpServer())
      .get(
        '/v1/majors?limit=50&cursor=' +
          encodeURIComponent(maximumPage.body.nextCursor),
      )
      .set('Authorization', 'Bearer ' + reader.accessToken);
    ok(maximumNext);
    assert.equal(maximumNext.body.items.length, 50);
    assert.equal(maximumNext.body.items[0].id, rows[50]!.id);
    await f.pool.query(
      "UPDATE whaleu_campus.campuses SET full_name=full_name||' changed' WHERE id=$1",
      [rows[0]!.campusId],
    );
    ok(
      await request(f.app.getHttpServer())
        .get(
          '/v1/majors?cursor=' + encodeURIComponent(firstPage.body.nextCursor),
        )
        .set('Authorization', 'Bearer ' + reader.accessToken),
      409,
    );
    const afterMapping = await get();
    ok(afterMapping);
    await f.pool.query(
      "UPDATE whaleu_majors.major_catalog_head SET state='withdrawn'",
    );
    await f.pool.query(
      "UPDATE whaleu_majors.major_catalog_head SET state='accepted'",
    );
    ok(
      await request(f.app.getHttpServer())
        .get(
          '/v1/majors?cursor=' +
            encodeURIComponent(afterMapping.body.nextCursor),
        )
        .set('Authorization', 'Bearer ' + reader.accessToken),
      409,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM pg_stats WHERE schemaname IN ('whaleu_majors','whaleu_community') AND tablename IN ('major_catalog_epoch','major_discussion_epoch','major_discussion_review_epoch')",
        )
      ).rows[0]!.n,
      0,
      'fresh singleton tables have no ANALYZE statistics',
    );
    const diagnostics = [];
    for (const [name, sql, values] of [
      ['catalog', majorCatalogCaptureSql, [reader.accountId, session]],
      ['discussion', majorDiscussionEpochSql, []],
    ] as const) {
      const plan = (
        await f.pool.query(
          'EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) ' + sql,
          [...values],
        )
      ).rows[0]['QUERY PLAN'][0];
      assert.equal(
        plan.Plan['Plan Rows'],
        1,
        'singleton ownership must not estimate a Cartesian population',
      );
      assert.ok(plan.Plan['Total Cost'] < 100000, JSON.stringify(plan));
      diagnostics.push({
        name,
        rows: plan.Plan['Plan Rows'],
        cost: plan.Plan['Total Cost'],
        executionMs: plan['Execution Time'],
        jit: plan.JIT ?? null,
      });
    }
    const sourceBody = (
      await f.pool.query<{ body: string }>(
        "SELECT prosrc body FROM pg_proc WHERE oid='whaleu_majors.major_discussion_sources(uuid[],timestamptz)'::regprocedure",
      )
    ).rows[0]!.body;
    const sourceSql = sourceBody
      .replace(/\bids\b/g, '$1::uuid[]')
      .replace(/\binstant\b/g, '$2::timestamptz');
    const now = (
      await f.pool.query<{ now: string }>('SELECT clock_timestamp()::text now')
    ).rows[0]!.now;
    const sourcePlan = (
      await f.pool.query(
        'EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) ' + sourceSql,
        [rows.slice(0, 50).map((row) => row.id), now],
      )
    ).rows[0]['QUERY PLAN'][0];
    assert.equal(
      (
        JSON.stringify(sourcePlan).match(
          /whaleu_majors\.major_catalog_source\(/g,
        ) ?? []
      ).length,
      1,
      'the actual projection plan evaluates the complete Major source exactly once',
    );
    diagnostics.push({
      name: 'discussion-sources-50',
      rows: sourcePlan.Plan['Plan Rows'],
      cost: sourcePlan.Plan['Total Cost'],
      executionMs: sourcePlan['Execution Time'],
      jit: sourcePlan.JIT ?? null,
    });
    const missingId = randomUUID();
    const sourceIds = [rows[0]!.id, offPage.id, missingId, rows[0]!.id];
    const projected = (
      await f.pool.query(
        'SELECT ordinal::text ordinal,major_id,source FROM whaleu_majors.major_discussion_sources($1,$2)',
        [sourceIds, now],
      )
    ).rows;
    assert.deepEqual(
      projected.map((row) => [row.ordinal, row.major_id]),
      sourceIds.map((id, index) => [String(index + 1), id]),
    );
    assert.equal(projected[1]!.source, null);
    assert.equal(projected[2]!.source, null);
    assert.deepEqual(projected[0]!.source, projected[3]!.source);
    const { readFileSync } = await import('node:fs');
    const original = readFileSync(
      new URL('../../migrations/0121_major_discussion.sql', import.meta.url),
      'utf8',
    ).match(
      /CREATE FUNCTION whaleu_majors\.major_discussion_source\([^]*?AS \$\$([^]*?)\$\$;/,
    )![1]!;
    const originalSql = original
      .replace(/\bwid\b/g, '$1::uuid')
      .replace(/\binstant\b/g, '$2::timestamptz');
    for (const id of [rows[0]!.id, offPage.id, randomUUID()]) {
      assert.equal(
        (
          await f.pool.query(
            `SELECT (${originalSql}) IS NOT DISTINCT FROM whaleu_majors.major_discussion_source($1,$2) same`,
            [id, now],
          )
        ).rows[0]!.same,
        true,
        'forward migration preserves the exact original source shape and missing/inactive null',
      );
    }
    t.diagnostic(
      JSON.stringify({
        majorColdPlans: diagnostics,
        environment: (
          await f.pool.query(
            "SELECT version() version,pg_jit_available() jit_available,current_setting('jit') jit,current_setting('jit_above_cost') jit_above_cost,current_setting('TimeZone') timezone,(SELECT datcollate FROM pg_database WHERE datname=current_database()) collate",
          )
        ).rows[0],
      }),
    );
    for (const table of [
      'whaleu_majors.major_catalog_epoch',
      'whaleu_majors.major_discussion_epoch',
      'whaleu_community.major_discussion_review_epoch',
    ]) {
      const tx = await f.pool.connect();
      await tx.query('BEGIN');
      try {
        await tx.query(`DELETE FROM ${table}`);
        await assert.rejects(
          majorCatalog(tx, reader.accountId, session, false),
          { code: 'MAJOR_CATALOG_UNAVAILABLE' },
        );
        if (!table.endsWith('major_catalog_epoch'))
          await assert.rejects(discussionEpoch(tx), {
            code: 'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
          });
      } finally {
        await tx.query('ROLLBACK');
        tx.release();
      }
    }
  },
);

test(
  'missing catalog epoch fails direct discussion reads and positive commands at the existing owner fence',
  { timeout: 120000 },
  async (t) => {
    const f = await majorDiscussionFixture();
    t.after(() => f.close());
    const actor = await f.actor({ identity: false }),
      major = f.add(),
      catalog = await f.accept([major]),
      http = f.app.getHttpServer();
    await f.acceptDiscussion([major.id]);
    const get = (path: string) =>
      request(http)
        .get(base + path)
        .set('Authorization', 'Bearer ' + actor.accessToken);
    const post = (path: string, body: object) =>
      request(http)
        .post(base + path)
        .set('Authorization', 'Bearer ' + actor.accessToken)
        .send(body);
    const original = f.root(catalog, major, 'original before epoch loss');
    await reviewMajorDiscussion(f.pool, actor.accountId, major.id, original);
    const published = await post(`/${major.id}/discussion`, original);
    ok(published);
    ok(await get(`/${major.id}/discussion`));
    const fresh = f.root(catalog, major, 'must roll back without epoch'),
      reply = f.reply(catalog, major, 'reply must roll back without epoch');
    await reviewMajorDiscussion(f.pool, actor.accountId, major.id, fresh);
    await reviewMajorDiscussion(
      f.pool,
      actor.accountId,
      major.id,
      reply,
      published.body.commentId,
    );
    await f.pool.query('DELETE FROM whaleu_majors.major_catalog_epoch');
    const source = (
      await f.pool.query(
        'SELECT whaleu_majors.major_catalog_source(clock_timestamp()) catalog,whaleu_majors.major_discussion_source($1,clock_timestamp()) discussion',
        [major.id],
      )
    ).rows[0]!;
    assert.equal(source.catalog.epoch, null);
    assert.ok(
      source.discussion,
      'capture alone is not the authorization fence',
    );
    for (const path of [
      `/${major.id}/discussion`,
      `/${major.id}/discussion/${published.body.commentId}`,
    ]) {
      const response = await get(path);
      ok(response, 503);
      assert.equal(
        response.body.error.code,
        'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
      );
    }
    const like = f.like(catalog, major);
    for (const [path, command] of [
      [`/${major.id}/discussion`, fresh],
      [`/${major.id}/discussion/${published.body.commentId}/replies`, reply],
      [`/${major.id}/discussion/${published.body.commentId}/like`, like],
    ] as const) {
      const response = await post(path, command);
      ok(response, 503);
      assert.equal(
        response.body.error.code,
        'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
      );
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_majors.major_discussion_commands WHERE request_id=ANY($1::uuid[])',
          [
            [
              fresh.clientRequestId,
              reply.clientRequestId,
              like.clientRequestId,
            ],
          ],
        )
      ).rows[0]!.n,
      0,
      'unavailable authority creates no terminal command or receipt',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_majors.major_discussion_comments WHERE major_id=$1',
          [major.id],
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_majors.major_discussion_like_events WHERE major_id=$1',
          [major.id],
        )
      ).rows[0]!.n,
      0,
    );
    const receipt = await get(
      `/discussion-requests/${original.clientRequestId}`,
    );
    ok(receipt);
    assert.deepEqual(receipt.body, published.body);
  },
);
