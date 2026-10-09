import { DatabaseService } from '../../src/database/database.js';
import { RatingsService } from '../../src/ratings/service.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import {
  approveRating,
  setRatingReviewState,
} from '../support/rating-runtime-fixture.js';
import { RatingRootOrderRepository } from '../../src/ratings/like-order-repository.js';
import { inTransaction } from '../../src/database/database.js';
test(
  'rating root ordering uses causal total coverage and bounded opaque tuple seeks',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    const a = await f.actor(),
      b = await f.actor(),
      c = await f.actor(),
      catalog = await f.catalog(a, { count: 2 }),
      target = catalog.targets[0]!;
    const roots: Awaited<ReturnType<typeof f.publish>>[] = [];
    for (let i = 0; i < 7; i++)
      roots.push(
        await f.publish(
          a,
          catalog,
          target,
          f.body(catalog, target, { body: `Root ${i}` }),
        ),
      );
    type Root = (typeof roots)[number];
    const get = (query: Record<string, unknown>) =>
      f
        .auth(
          request(f.http).get(`/v1/ratings/targets/${target.id}/comments`),
          b,
        )
        .query(query);
    const toggle = async (actor: typeof a, root: Root, liked: boolean) => {
      const state = await f.auth(
        request(f.http).get(`/v1/ratings/comments/${root.id}/like`),
        actor,
      );
      assert.equal(state.status, 200);
      const result = await f
        .auth(
          request(f.http).put(`/v1/ratings/comments/${root.id}/like`),
          actor,
        )
        .send({
          clientRequestId: randomUUID(),
          regionId: null,
          targetId: target.id,
          expectedTargetRevision: target.revision,
          expectedRevision: root.revision,
          expectedLikeRevision: state.body.revision,
          liked,
        });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.outcome, 'applied');
      return result.body;
    };
    await toggle(b, roots[1]!, true);
    await toggle(c, roots[1]!, true);
    await toggle(b, roots[3]!, true);
    await toggle(b, roots[5]!, true);
    const collect = async (sort: 'time' | 'likes', order: 'asc' | 'desc') => {
      let cursor: string | undefined;
      const ids: string[] = [];
      do {
        const page = await get({
          sort,
          order,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        assert.equal(page.status, 200, JSON.stringify(page.body));
        assert.deepEqual(Object.keys(page.body.context).sort(), [
          'catalogRevision',
          'regionId',
          'targetId',
        ]);
        for (const item of page.body.items) {
          assert.equal(item.count, undefined);
          ids.push(item.id);
        }
        cursor = page.body.nextCursor ?? undefined;
      } while (cursor);
      return ids;
    };
    await t.test(
      'time and likes in both directions retain exact page DTO and stable tie-breakers',
      async () => {
        assert.deepEqual(
          await collect('time', 'asc'),
          roots.map((r) => r.id),
        );
        assert.deepEqual(
          await collect('time', 'desc'),
          roots.map((r) => r.id).reverse(),
        );
        assert.deepEqual(
          await collect('likes', 'desc'),
          [
            roots[1],
            roots[5],
            roots[3],
            roots[6],
            roots[4],
            roots[2],
            roots[0],
          ].map((r) => r!.id),
        );
        assert.deepEqual(
          await collect('likes', 'asc'),
          [
            roots[6],
            roots[4],
            roots[2],
            roots[0],
            roots[5],
            roots[3],
            roots[1],
          ].map((r) => r!.id),
        );
      },
    );
    await t.test(
      'every order-moving source makes previous opaque cursor restart',
      async () => {
        const old = (await get({ sort: 'likes', order: 'desc', limit: 1 })).body
          .nextCursor;
        await toggle(b, roots[6]!, true);
        const stale = await get({
          sort: 'likes',
          order: 'desc',
          limit: 1,
          cursor: old,
        });
        assert.equal(stale.status, 409);
        assert.equal(stale.body.error.code, 'DISCOVERY_RESTART_REQUIRED');
        const beforeUnlike = (
          await get({ sort: 'likes', order: 'desc', limit: 1 })
        ).body.nextCursor;
        await toggle(b, roots[6]!, false);
        assert.equal(
          (
            await get({
              sort: 'likes',
              order: 'desc',
              limit: 1,
              cursor: beforeUnlike,
            })
          ).status,
          409,
        );
        const beforeDelete = (
          await get({ sort: 'time', order: 'asc', limit: 1 })
        ).body.nextCursor;
        await f.deleteRoot(a, catalog, target, roots[0]!);
        assert.equal(
          (
            await get({
              sort: 'time',
              order: 'asc',
              limit: 1,
              cursor: beforeDelete,
            })
          ).status,
          409,
        );
        const page = await get({ sort: 'time', order: 'asc', limit: 1 });
        assert.equal(
          (
            await get({
              sort: 'likes',
              order: 'asc',
              limit: 1,
              cursor: page.body.nextCursor,
            })
          ).status,
          409,
        );
        assert.equal(
          (await get({ limit: 1, cursor: page.body.nextCursor })).status,
          409,
        );
      },
    );
    await t.test(
      'hidden-only candidates produce bounded scan continuation and current review invalidates negatives',
      async () => {
        const top = roots[1]!;
        await setRatingReviewState(f.pool, top.approval.decisionId, 'revoked');
        const page = await get({ sort: 'likes', order: 'desc', limit: 1 });
        assert.equal(page.status, 200, JSON.stringify(page.body));
        assert.deepEqual(page.body.items, []);
        assert.equal(page.body.continuation, 'scan');
        await setRatingReviewState(f.pool, top.approval.decisionId, 'allow');
        assert.equal(
          (
            await get({
              sort: 'likes',
              order: 'desc',
              limit: 1,
              cursor: page.body.nextCursor,
            })
          ).status,
          409,
        );
      },
    );
    await t.test(
      'ordinary explicit order queries use tuple ranges and do not load off-page bodies',
      async () => {
        const seen: { sql: string; values: unknown[] | undefined }[] = [];
        const tx = await f.pool.connect();
        try {
          await tx.query('BEGIN');
          const original = tx.query.bind(tx);
          const wrapped = new Proxy(tx, {
            get(o, p) {
              if (p === 'query')
                return (sql: string, values?: unknown[]) => {
                  if (sql.includes('FROM whaleu_ratings.root_order_entries'))
                    seen.push({ sql, values });
                  return original(sql, values);
                };
              return Reflect.get(o, p);
            },
          });
          const repo = f.app.get(RatingRootOrderRepository);
          for (const order of ['asc', 'desc'] as const) {
            const first = await repo.page(
                target.id,
                'likes',
                order,
                null,
                2,
                wrapped,
              ),
              last = first[1]!;
            const next = await repo.page(
              target.id,
              'likes',
              order,
              {
                createdMicros: last.createdMicros,
                ordinal: last.ordinal,
                count: last.count,
              },
              2,
              wrapped,
            );
            assert.ok(next.length <= 3);
          }
          assert.ok(
            seen.every(
              (q) =>
                !q.sql.includes('body') &&
                !q.sql.includes('account_id') &&
                !q.sql.includes('COUNT(') &&
                !q.sql.includes(' OR '),
            ),
          );
          assert.equal(seen.length, 4);
          assert.ok(seen[1]!.sql.includes(')>('));
          const table = (
            await original(
              "SELECT indexdef FROM pg_indexes WHERE schemaname='whaleu_ratings' AND indexname IN ('rating_root_likes_asc','rating_root_likes_desc','rating_root_time')",
            )
          ).rows;
          assert.equal(table.length, 3);
        } finally {
          await tx.query('ROLLBACK');
          tx.release();
        }
      },
    );
    await t.test(
      'same-microsecond native publications use numeric ordinal ties',
      async () => {
        await f.pool.query(
          `CREATE FUNCTION whaleu_ratings.test_order_clock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.created_at:='2026-10-08T01:02:03.123456Z'::timestamptz;RETURN NEW;END $$;CREATE TRIGGER zz_test_order_clock BEFORE INSERT ON whaleu_ratings.comments FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.test_order_clock()`,
        );
        const tied: Root[] = [];
        try {
          for (let i = 0; i < 3; i++)
            tied.push(await f.publish(a, catalog, target));
        } finally {
          await f.pool.query(
            'DROP TRIGGER zz_test_order_clock ON whaleu_ratings.comments;DROP FUNCTION whaleu_ratings.test_order_clock()',
          );
        }
        const rows = (
          await f.pool.query<{
            root_id: string;
            ordinal: string;
            created_micros: string;
          }>(
            'SELECT root_id,ordinal::text,created_micros::text FROM whaleu_ratings.root_order_entries WHERE root_id=ANY($1::uuid[]) ORDER BY root_order_entries.ordinal',
            [tied.map((r) => r.id)],
          )
        ).rows;
        assert.equal(new Set(rows.map((r) => r.created_micros)).size, 1);
        assert.deepEqual(
          (await collect('time', 'asc')).filter((id) =>
            tied.some((r) => r.id === id),
          ),
          tied.map((r) => r.id),
        );
        assert.deepEqual(
          (await collect('likes', 'asc')).filter((id) =>
            tied.some((r) => r.id === id),
          ),
          tied.map((r) => r.id).reverse(),
        );
      },
    );
    await t.test(
      'raw root order entry/count/head writes are rejected and leave real state intact',
      async () => {
        for (const sql of [
          'UPDATE whaleu_ratings.root_order_heads SET missing=0',
          'UPDATE whaleu_ratings.root_order_entries SET count=100 WHERE known',
          'DELETE FROM whaleu_ratings.root_order_entries',
        ]) {
          await assert.rejects(inTransaction(f.pool, (tx) => tx.query(sql)));
        }
        assert.equal((await get({ sort: 'likes', order: 'desc' })).status, 200);
      },
    );
    await t.test(
      'populated late seeks expose physical metadata plans separately from bounded candidate and body limits',
      async () => {
        const many = catalog.targets[1]!,
          service = f.app.get(RatingsService);
        for (let i = 0; i < 180; i++) {
          const body = f.body(catalog, many, { body: `Plan probe ${i}` });
          await approveRating(f.pool, f.envelope(a, catalog, many, body));
          const receipt = await service.createComment(
            a.accessToken,
            many.id,
            body,
          );
          assert.equal(receipt.outcome, 'applied');
        }
        await f.pool.query('ANALYZE whaleu_ratings.root_order_entries');
        const tx = await f.pool.connect();
        try {
          const repo = f.app.get(RatingRootOrderRepository),
            original = tx.query.bind(tx);
          for (const sort of ['time', 'likes'] as const)
            for (const order of ['asc', 'desc'] as const) {
              const first = await repo.page(many.id, sort, order, null, 50, tx),
                one = first[49]!,
                second = await repo.page(
                  many.id,
                  sort,
                  order,
                  {
                    createdMicros: one.createdMicros,
                    ordinal: one.ordinal,
                    count: one.count,
                  },
                  50,
                  tx,
                ),
                two = second[49]!;
              let sql = '',
                values: unknown[] = [];
              const recording = new Proxy(tx, {
                get(o, p) {
                  if (p === 'query')
                    return (q: string, v: unknown[]) => {
                      sql = q;
                      values = v;
                      return original(q, v);
                    };
                  return Reflect.get(o, p);
                },
              });
              await repo.page(
                many.id,
                sort,
                order,
                {
                  createdMicros: two.createdMicros,
                  ordinal: two.ordinal,
                  count: two.count,
                },
                2,
                recording,
              );
              const explained = (
                await original(
                  'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql,
                  values,
                )
              ).rows[0]!['QUERY PLAN'];
              const plan = explained[0].Plan,
                serialized = JSON.stringify(plan);
              assert.equal(plan['Actual Rows'], 3, serialized);
              assert.ok(serialized.includes('Index Scan'), serialized);
              assert.ok(serialized.includes('Index Cond'), serialized);
              // A selective metadata bitmap + sort is a valid physical plan.
              // Candidate/body/proof limits are hard; physical MVCC/index work
              // is observed here, never asserted to equal the returned LIMIT.
              t.diagnostic(`${sort}/${order} metadata plan: ${serialized}`);
              assert.ok(
                !serialized.includes('like_memberships') &&
                  !serialized.includes('like_transitions'),
                serialized,
              );
              assert.ok(
                serialized.includes('target_id') && serialized.includes('ROW('),
                serialized,
              );
            }
        } finally {
          await tx.query('ROLLBACK');
          tx.release();
        }
      },
    );
    await t.test(
      'an uncovered root stays unavailable and makes total likes coverage unavailable; time still works',
      async () => {
        // Fault injection stands in for an imported root absent from the like cutover.
        // Only the new enrollment trigger is suppressed; existing publication/review
        // requirements still run and all state is confined to this disposable DB.
        await f.pool.query(
          'ALTER TABLE whaleu_community.rating_approval_bindings DISABLE TRIGGER rating_like_native_publication',
        );
        let unknown: Root;
        try {
          unknown = await f.publish(a, catalog, target);
        } finally {
          await f.pool.query(
            'ALTER TABLE whaleu_community.rating_approval_bindings ENABLE TRIGGER rating_like_native_publication',
          );
        }
        const state = await f.auth(
          request(f.http).get(`/v1/ratings/comments/${unknown!.id}/like`),
          b,
        );
        assert.equal(state.status, 200);
        assert.deepEqual(state.body, { status: 'unavailable' });
        assert.equal((await get({ sort: 'likes', order: 'desc' })).status, 503);
        assert.equal((await get({ sort: 'time', order: 'asc' })).status, 200);
        await f.deleteRoot(a, catalog, target, unknown!);
        assert.equal((await get({ sort: 'likes', order: 'desc' })).status, 200);
      },
    );
    await t.test(
      'order final proof uses explicit target primary-key equality across a populated target catalog',
      async () => {
        const many = await f.catalog(a, { count: 180 }),
          targetId = many.targets[100]!.id;
        await f.pool.query('ANALYZE whaleu_ratings.root_order_heads');
        const db = f.app.get(DatabaseService),
          repo = f.app.get(RatingRootOrderRepository);
        let observed:
          { sql: string; values: unknown[] | undefined } | undefined;
        await db.transaction(
          async (tx) => {
            const original = tx.query.bind(tx);
            tx.query = ((q: string, values?: unknown[]) => {
              if (q.includes('FROM unnest') && q.includes('root_order_heads h'))
                observed = { sql: q, values };
              return original(q, values);
            }) as typeof tx.query;
            await repo.head(targetId, 'likes', tx);
          },
          { isolationLevel: 'read committed' },
        );
        assert.ok(observed);
        assert.ok(observed.sql.includes('h.target_id=f.target'));
        const explained = (
          await f.pool.query(
            'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + observed.sql,
            observed.values,
          )
        ).rows[0]!['QUERY PLAN'];
        const text = JSON.stringify(explained);
        t.diagnostic('order final head proof: ' + text);
        assert.ok(
          text.includes('target_id') && !text.includes('root_order_events'),
          text,
        );
        assert.equal(explained[0].Plan['Actual Rows'], 1, text);
      },
    );
  },
);
