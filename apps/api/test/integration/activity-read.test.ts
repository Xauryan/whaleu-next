import { DatabaseService } from '../../src/database/database.js';
import { ActivitiesRepository } from '../../src/activities/repository.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import type { Response } from 'supertest';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import {
  syntheticActivity,
  seedActivityCatalog,
  seedActivityHistory,
  activityVisitCount,
} from '../support/activity-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
function denied(r: Response, code?: string) {
  assert.ok(r.status >= 400, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body), ['error']);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['vary'], 'Authorization');
  if (code) assert.equal(r.body.error.code, code);
}
test(
  'activities ordinary AppModule current authority, accepted publication, global selection and replay-safe receipts',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture(),
      http = f.app.getHttpServer(),
      region = f.scope.home.regionId,
      actor = await f.actor();
    const auth = (r: request.Test, a = actor) =>
      r.set('Authorization', `Bearer ${a.accessToken}`);
    const list = (
      query: Record<string, unknown> = {},
      a = actor,
      target = region,
    ) =>
      auth(
        request(http).get(`/v1/regions/${target}/activities`).query(query),
        a,
      );
    const context = (a = actor) =>
      auth(request(http).get('/v1/activities/context'), a);
    const detail = (id: string, a = actor, target = region) =>
      auth(request(http).get(`/v1/regions/${target}/activities/${id}`), a);
    const visit = (
      catalog: string,
      id = randomUUID(),
      a = actor,
      target = region,
    ) =>
      auth(request(http).put(`/v1/me/activity-visits/${id}`), a).send({
        regionId: target,
        expectedCatalogRevision: catalog,
      });
    try {
      await t.test(
        'required member authority and unknown history never become guest/empty',
        async () => {
          denied(
            await request(http).get('/v1/activities/context'),
            'AUTHENTICATION_REQUIRED',
          );
          assert.deepEqual((await context()).body, {
            regionId: region,
            visitHistory: 'unavailable',
          });
          denied(await list({ window: 'all' }), 'ACTIVITY_UNAVAILABLE');
          for (const fact of ['phone', 'affiliation'] as const)
            for (const state of ['unverified', 'unavailable'] as const) {
              const other = await f.actor({ [fact]: state });
              denied(await context(other));
            }
          const missing = await f.actor({ identity: false });
          denied(await context(missing), 'IDENTITY_CAMPUS_UNAVAILABLE');
          denied(
            await list({}, actor, f.scope.related.regionId),
            'ACTIVITY_SCOPE_UNAVAILABLE',
          );
          denied(
            await detail(randomUUID(), actor, f.scope.related.regionId),
            'ACTIVITY_NOT_FOUND',
          );
          const empty = await seedActivityCatalog(f.pool, region, []);
          denied(await list(), 'ACTIVITY_ENTRY_SELECTION_UNAVAILABLE');
          const all = await list({ window: 'all' });
          assert.equal(all.status, 200, JSON.stringify(all.body));
          assert.equal(all.body.context.catalogRevision, empty);
          assert.deepEqual(all.body.items, []);
          assert.equal(all.body.continuation, 'end');
          assert.equal(typeof all.body.pageCursor, 'string');
          assert.equal(await activityVisitCount(f.pool, actor.accountId), 0);
        },
      );
      await t.test(
        'known never visited chooses recent, opaque pages and page-one replay survive auto visit',
        async () => {
          await seedActivityHistory(f.pool, actor.accountId, 'never_visited');
          const rows = Array.from({ length: 73 }, (_, i) =>
            syntheticActivity({
              ordinal: String(i + 1),
              createdAt: new Date(Date.now() - 3600000).toISOString(),
            }),
          );
          rows.push(
            syntheticActivity({
              ordinal: '0',
              createdAt: '2000-01-01T00:00:00.000001Z',
            }),
          );
          const catalog = await seedActivityCatalog(f.pool, region, rows);
          const first = await list({ limit: 30 });
          assert.equal(first.status, 200, JSON.stringify(first.body));
          assert.equal(first.body.selection.kind, 'recent');
          assert.equal(first.body.items.length, 30);
          assert.equal(first.body.continuation, 'more');
          assert.notEqual(first.body.pageCursor, first.body.nextCursor);
          const id = randomUUID(),
            ack = await visit(catalog, id);
          assert.equal(ack.status, 200, JSON.stringify(ack.body));
          assert.equal(await activityVisitCount(f.pool, actor.accountId), 1);
          assert.deepEqual((await visit(catalog, id)).body, ack.body);
          assert.equal(await activityVisitCount(f.pool, actor.accountId), 1);
          const second = await list({
            limit: 30,
            cursor: first.body.nextCursor,
          });
          assert.equal(second.status, 200, JSON.stringify(second.body));
          assert.deepEqual(second.body.selection, first.body.selection);
          assert.equal(second.body.pageCursor, first.body.nextCursor);
          const previous = await list({
            limit: 30,
            cursor: first.body.pageCursor,
          });
          assert.deepEqual(previous.body.items, first.body.items);
          assert.deepEqual(previous.body.selection, first.body.selection);
          const third = await list({
            limit: 30,
            cursor: second.body.nextCursor,
          });
          assert.equal(third.body.items.length, 13);
          assert.equal(third.body.continuation, 'end');
          assert.equal((await list()).body.selection.kind, 'all');
          const all = await list({ window: 'all', limit: 50 });
          const all2 = await list({
            window: 'all',
            limit: 50,
            cursor: all.body.nextCursor,
          });
          assert.equal(all.body.items.length + all2.body.items.length, 74);
          assert.equal(all2.body.continuation, 'end');
          const ownDetail = await detail(rows[0]!.id);
          assert.equal(ownDetail.status, 200);
          assert.equal(ownDetail.body.bodyText, rows[0]!.bodyText);
          assert.equal(ownDetail.body.activityTime, rows[0]!.activityTime);
          assert.deepEqual(ownDetail.body.reward, {
            status: 'unavailable',
            value: null,
          });
          assert.deepEqual(ownDetail.body.gallery, {
            status: 'unavailable',
            items: null,
          });
          assert.ok(
            !JSON.stringify(ownDetail.body).includes(
              'syntheticUnprojectedField',
            ),
          );
          assert.equal(await activityVisitCount(f.pool, actor.accountId), 1);
          for (const q of [
            { limit: 29, cursor: first.body.nextCursor },
            { window: 'all', limit: 30, cursor: first.body.nextCursor },
          ])
            denied(await list(q), 'DISCOVERY_RESTART_REQUIRED');
          const another = await f.actor();
          denied(
            await list({ limit: 30, cursor: first.body.nextCursor }, another),
            'DISCOVERY_RESTART_REQUIRED',
          );
          denied(await visit(randomUUID(), id), 'ACTIVITY_VISIT_CONFLICT');
          const replacement = await seedActivityCatalog(f.pool, region, rows);
          denied(
            await list({ limit: 30, cursor: first.body.nextCursor }),
            'DISCOVERY_RESTART_REQUIRED',
          );
          denied(await visit(catalog), 'ACTIVITY_REVISION_CHANGED');
          assert.deepEqual((await visit(catalog, id)).body, ack.body);
          // Historical receipt is owner metadata, independent of newly missing member facts.
          await f.certify(actor.accountId, { phone: 'unverified' });
          assert.deepEqual((await visit(catalog, id)).body, ack.body);
          denied(await visit(replacement), 'PHONE_VERIFICATION_REQUIRED');
          await f.certify(actor.accountId);
        },
      );
      await t.test(
        'fallback is exactly ten historical, explicit all uncapped, unknown creation unavailable only for entry',
        async () => {
          const reader = await f.actor();
          await seedActivityHistory(f.pool, reader.accountId, 'never_visited');
          const rows = Array.from({ length: 15 }, (_, i) =>
            syntheticActivity({
              ordinal: String(9007199254740993n + BigInt(i)),
              createdAt: '2000-01-01T00:00:00.000001Z',
            }),
          );
          await seedActivityCatalog(f.pool, region, rows);
          const first = await list({ limit: 4 }, reader);
          assert.deepEqual(
            first.body.items.map((item: { id: string }) => item.id),
            rows
              .toReversed()
              .slice(0, 4)
              .map((row) => row.id),
          );
          assert.deepEqual(first.body.selection, {
            kind: 'historical',
            maximum: 10,
          });
          const second = await list(
              { limit: 4, cursor: first.body.nextCursor },
              reader,
            ),
            third = await list(
              { limit: 4, cursor: second.body.nextCursor },
              reader,
            );
          assert.equal(
            first.body.items.length +
              second.body.items.length +
              third.body.items.length,
            10,
          );
          assert.equal(third.body.continuation, 'end');
          assert.equal(
            (await list({ window: 'all' }, reader)).body.items.length,
            15,
          );
          await seedActivityCatalog(f.pool, region, [
            syntheticActivity({ createdAt: null }),
          ]);
          denied(
            await list({}, reader),
            'ACTIVITY_ENTRY_SELECTION_UNAVAILABLE',
          );
          assert.equal(
            (await list({ window: 'all' }, reader)).body.items[0].createdAt
              .status,
            'unavailable',
          );
          await seedActivityHistory(f.pool, reader.accountId, 'visited');
          assert.equal((await list({}, reader)).body.selection.kind, 'all');
        },
      );
      await t.test(
        'real SQL preserves the exact strict 72-hour microsecond boundary and accepted tie ordinals',
        async () => {
          const rows = [
            syntheticActivity({
              ordinal: '9007199254740993',
              createdAt: '2026-10-05T10:00:00.000000Z',
            }),
            syntheticActivity({
              ordinal: '9007199254740994',
              createdAt: '2026-10-05T10:00:00.000001Z',
            }),
            syntheticActivity({
              ordinal: '9007199254740995',
              createdAt: '2026-10-05T10:00:00.000002Z',
            }),
            syntheticActivity({
              ordinal: '9007199254740996',
              createdAt: '2026-10-05T10:00:00.000002Z',
            }),
          ];
          await seedActivityCatalog(f.pool, region, rows);
          const result = await f.app.get(DatabaseService).transaction(
            async (tx) => {
              const records = f.app.get(ActivitiesRepository),
                catalog = await records.catalog(region, tx);
              const boundary = (
                await tx.query<{ since: string }>(
                  `SELECT to_char(('2026-10-08T10:00:00.000001Z'::timestamptz-interval '72 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') since`,
                )
              ).rows[0]!.since;
              return records.list(
                catalog,
                { kind: 'recent', since: boundary },
                null,
                50,
                tx,
              );
            },
            { isolationLevel: 'read committed' },
          );
          assert.deepEqual(
            result.map((row) => row.id),
            [rows[3]!.id, rows[2]!.id],
          );
          assert.deepEqual(
            result.map((row) => row.display_ordinal),
            ['9007199254740996', '9007199254740995'],
          );
          const all = await list({ window: 'all' });
          assert.deepEqual(
            all.body.items.map((row: { id: string }) => row.id),
            rows.toReversed().map((row) => row.id),
          );
        },
      );
      await t.test(
        'complete empty visit is allowed, concurrent duplicates immutable and monotonic across new requests',
        async () => {
          const reader = await f.actor(),
            catalog = await seedActivityCatalog(f.pool, region, []);
          await seedActivityHistory(f.pool, reader.accountId, 'never_visited');
          assert.deepEqual((await list({}, reader)).body.items, []);
          const id = randomUUID(),
            results = await Promise.all([
              visit(catalog, id, reader),
              visit(catalog, id, reader),
              visit(catalog, id, reader),
            ]);
          for (const r of results) {
            assert.equal(r.status, 200);
            assert.deepEqual(r.body, results[0]!.body);
          }
          assert.equal(await activityVisitCount(f.pool, reader.accountId), 1);
          const next = await visit(catalog, randomUUID(), reader);
          assert.ok(next.body.visitedAt > results[0]!.body.visitedAt);
          assert.equal(await activityVisitCount(f.pool, reader.accountId), 2);
          await assert.rejects(
            f.pool.query(
              'UPDATE whaleu_activities.owner_visit_receipts SET visited_at=clock_timestamp() WHERE account_id=$1',
              [reader.accountId],
            ),
          );
        },
      );
      await t.test(
        'invalid publication and immutable records fail closed; unknown and empty remain distinct',
        async () => {
          const row = syntheticActivity(),
            catalog = await seedActivityCatalog(f.pool, region, [row]);
          for (const [sql, values] of [
            [
              'UPDATE whaleu_activities.content_revisions SET body_text=$2 WHERE id=$1',
              [row.revision, 'Changed'],
            ],
            [
              'UPDATE whaleu_activities.catalog_entries SET display_ordinal=99 WHERE catalog_revision_id=$1',
              [catalog],
            ],
            [
              'UPDATE whaleu_activities.catalog_revisions SET sealed=false WHERE id=$1',
              [catalog],
            ],
            ['DELETE FROM whaleu_activities.identities WHERE id=$1', [row.id]],
          ] as const)
            await assert.rejects(
              withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(sql, [...values]),
              ),
            );
          await seedActivityCatalog(f.pool, region, [
            { ...row, state: 'inactive' },
          ]);
          denied(await detail(row.id), 'ACTIVITY_NOT_FOUND');
          await seedActivityCatalog(f.pool, region, [
            { ...row, state: 'pending' },
          ]);
          denied(await detail(row.id), 'ACTIVITY_NOT_FOUND');
          await seedActivityCatalog(f.pool, region, [row], { seal: false });
          denied(await list({ window: 'all' }), 'ACTIVITY_UNAVAILABLE');
          await assert.rejects(
            seedActivityCatalog(f.pool, region, [row], { expectedCount: 2 }),
          );
          await seedActivityCatalog(f.pool, region, [row], {
            seal: false,
            coverage: 'conflicting',
          });
          denied(await list({ window: 'all' }), 'ACTIVITY_UNAVAILABLE');
        },
      );
      await t.test(
        'strict parser rejects forged authority/media, repeated params, bad IDs and GET bodies',
        async () => {
          for (const q of [
            { ownerId: actor.accountId },
            { window: 'past' },
            { limit: 51 },
            { limit: '01' },
            { cursor: ['a', 'b'] },
            { window: ['all', 'entry'] },
          ])
            denied(await list(q));
          denied(
            await auth(
              request(http)
                .get('/v1/activities/context')
                .send({ userId: actor.accountId }),
            ),
          );
          denied(
            await auth(
              request(http).put(`/v1/me/activity-visits/${randomUUID()}`),
            ).send({
              regionId: region,
              expectedCatalogRevision: randomUUID(),
              visitedAt: new Date().toISOString(),
            }),
          );
          denied(await detail('bad-id'));
        },
      );
    } finally {
      await f.close();
    }
  },
);
