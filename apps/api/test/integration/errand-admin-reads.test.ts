import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import request from 'supertest';
import type { Response } from 'supertest';
import { errandRuntimeFixture } from '../support/errand-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { revokeErrandReview } from '../support/errand-review-fixtures.js';
import { discoveryCursorBucket } from '../../src/community/discovery-cursors.js';
import { errandAdminPageSchema } from '../../src/errands/admin-contracts.js';

const ok = (r: Response) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return errandAdminPageSchema.parse(r.body);
};
const denied = (r: Response, code?: string) => {
  assert.ok(r.status >= 400, JSON.stringify(r.body));
  if (code) assert.equal(r.body.error?.code, code);
};

test(
  'E2A normal AppModule exact-target public historical admin reads and late writer proofs',
  { timeout: 120000 },
  async (t) => {
    const f = await errandRuntimeFixture();
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    const list = (a: Actor, q: Record<string, unknown> = {}) =>
      f.auth(request(f.http).get('/v1/admin/errands'), a).query(q);
    const grant = async (
      a: Actor,
      role = 'school_admin',
      region: string | null = f.scope.home.regionId,
      expiry: Date | null = null,
    ) => {
      const id = randomUUID();
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,expires_at) VALUES($1,$2,$3,$4,$2,'Synthetic E2A test',$5)",
          [id, a.accountId, role, region, expiry],
        ),
      );
      return id;
    };
    const name = async (a: Actor, n: string) => {
      const current =
        (
          await f.pool.query(
            'SELECT revision FROM whaleu_profile.profiles WHERE account_id=$1',
            [a.accountId],
          )
        ).rows[0]?.revision ?? 0;
      const r = await f
        .auth(request(f.http).patch('/v1/me/profile'), a)
        .send({ expectedRevision: current, nickname: n });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    };
    const late = async (
      a: Actor,
      q: Record<string, unknown>,
      mutate: () => Promise<void>,
    ) => {
      const blocker = await f.pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [
            `whaleu:discovery:quota:v1:${discoveryCursorBucket(a.accountId).hash}`,
          ],
        );
        const pending = list(a, { limit: 1, ...q }).then((r) => r);
        await f.waitForLock('pg_advisory_xact_lock(hashtextextended');
        await mutate();
        await blocker.query('COMMIT');
        return await pending;
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
    };
    try {
      const publisher = await f.actor(),
        runner = await f.actor(),
        admin = await f.actor({ affiliation: 'unverified', identity: false }),
        global = await f.actor({ affiliation: 'unverified', identity: false });
      await name(publisher, 'Alpha鲸');
      await name(runner, 'Runner');
      await grant(admin);
      await grant(global, 'super_admin', null);
      const pending = await f.publish(
        publisher,
        f.body(undefined, { title: 'Public %_ keyword 123' }),
      );
      const accepted = await f.publish(publisher);
      const acceptance = await f.command(
        runner,
        accepted.id,
        accepted.revision,
        'accept',
      );
      assert.equal(acceptance.body.outcome, 'applied');
      const completed = await f.publish(publisher);
      const ac = await f.command(
        runner,
        completed.id,
        completed.revision,
        'accept',
      );
      const co = await f.command(
        publisher,
        completed.id,
        ac.body.revision,
        'complete',
      );
      assert.equal(co.body.outcome, 'applied');
      const cancelled = await f.publish(publisher);
      await f.command(publisher, cancelled.id, cancelled.revision, 'cancel');
      const deleted = await f.publish(publisher);
      await f.command(publisher, deleted.id, deleted.revision, 'delete');
      await t.test(
        'fixed exact scope and global explicit target without affiliation or identity expansion',
        async () => {
          denied(await list(publisher), 'AUTHORIZATION_REQUIRED');
          denied(
            await request(f.http).get('/v1/admin/errands'),
            'AUTHENTICATION_REQUIRED',
          );
          const page = ok(await list(admin));
          assert.equal(page.context.regionId, f.scope.home.regionId);
          assert.equal(page.context.management, 'fixed');
          assert.equal(page.items.length, 5);
          assert.deepEqual(page.total, { status: 'known', value: '5' });
          for (const regionId of [
            f.scope.related.regionId,
            f.scope.foreign.regionId,
          ])
            denied(await list(admin, { regionId }), 'AUTHORIZATION_REQUIRED');
          denied(await list(global), 'BAD_REQUEST');
          assert.equal(
            ok(await list(global, { regionId: f.scope.home.regionId })).context
              .management,
            'global',
          );
          for (const q of [
            { unknown: 'x' },
            { status: ['all', 'pending'] },
            { limit: 51 },
          ])
            denied(await list(admin, q), 'BAD_REQUEST');
          denied(
            await f
              .auth(request(f.http).get('/v1/admin/errands'), admin)
              .send({ regionId: f.scope.home.regionId }),
            'BAD_REQUEST',
          );
        },
      );
      await t.test(
        'all six historical statuses, tombstone overlay, review-independent public projection and zero',
        async () => {
          for (const status of [
            'pending',
            'accepted',
            'completed',
            'cancelled',
            'deleted',
          ]) {
            const r = await list(admin, { status });
            const page = ok(r);
            assert.equal(page.items.length, 1);
            assert.deepEqual(page.total, { status: 'known', value: '1' });
            assert.equal(page.items[0]!.displayState, status);
            assert.equal(r.headers['cache-control'], 'no-store');
            assert.equal(r.headers['vary'], 'Authorization');
          }
          await revokeErrandReview(f.pool, pending.approval.decisionId);
          const page = ok(await list(admin));
          assert.ok(page.items.some((x) => x.id === pending.id));
          const tombstone = page.items.find((x) => x.id === deleted.id)!;
          assert.equal(tombstone.state, 'pending');
          assert.deepEqual(tombstone.deletionReason, { status: 'unavailable' });
          const serialized = JSON.stringify(page);
          for (const field of [
            'privateText',
            'publisherContacts',
            'oppositeContact',
            'capabilities',
            'fixture_publisher',
            'Synthetic private',
            publisher.accountId,
            runner.accountId,
          ])
            assert.ok(!serialized.includes(field), field);
          assert.deepEqual(
            ok(await list(admin, { keyword: 'NoSuchPublicText' })).total,
            { status: 'known', value: '0' },
          );
          assert.deepEqual(ok(await list(admin, { keyword: '123' })).total, {
            status: 'unavailable',
          });
          assert.equal(
            ok(await list(admin, { keyword: '%_' })).items[0]!.id,
            pending.id,
          );
        },
      );
      await t.test(
        'current public participant names and exact UUID references, opaque bound keysets',
        async () => {
          let page = ok(await list(admin, { keyword: 'Alpha鲸', limit: 2 }));
          assert.equal(page.items.length, 2);
          assert.deepEqual(page.total, { status: 'known', value: '5' });
          assert.equal(
            page.context.search.legacyNumericReferences,
            'unavailable',
          );
          const profile = (
            await f.pool.query(
              'SELECT public_id FROM whaleu_profile.profiles WHERE account_id=$1',
              [publisher.accountId],
            )
          ).rows[0]!.public_id;
          assert.equal(
            ok(await list(admin, { keyword: profile })).items.length,
            5,
          );
          const seen = page.items.map((x) => x.id);
          while (page.nextCursor) {
            assert.match(page.nextCursor, /^[A-Za-z0-9_-]{43}$/);
            page = ok(
              await list(admin, {
                keyword: 'Alpha鲸',
                limit: 2,
                cursor: page.nextCursor,
              }),
            );
            seen.push(...page.items.map((x) => x.id));
            assert.deepEqual(page.total, { status: 'known', value: '5' });
          }
          assert.equal(new Set(seen).size, 5);
          assert.equal(seen.length, 5);
          const first = ok(await list(admin, { limit: 1 }));
          denied(
            await list(admin, { limit: 2, cursor: first.nextCursor }),
            'BAD_REQUEST',
          );
          denied(
            await list(global, {
              regionId: f.scope.home.regionId,
              limit: 1,
              cursor: first.nextCursor,
            }),
            'BAD_REQUEST',
          );
          await name(publisher, 'Renamed鲸');
          assert.equal(
            ok(await list(admin, { keyword: 'Renamed鲸' })).items.length,
            5,
          );
          assert.deepEqual(
            ok(await list(admin, { keyword: 'Alpha鲸' })).total,
            { status: 'known', value: '0' },
          );
        },
      );
      await t.test(
        'late profile rename changes matching projections and fails closed after quota wait',
        async () => {
          denied(
            await late(admin, { keyword: 'Renamed鲸' }, () =>
              name(publisher, 'Changed鲸'),
            ),
            'ERRAND_UNAVAILABLE',
          );
          assert.equal(
            ok(await list(admin, { keyword: 'Changed鲸' })).items.length,
            5,
          );
        },
      );
      await t.test(
        'late legal E1 tombstone is caught by page proof even with scalar total unchanged in all',
        async () => {
          const before = ok(await list(admin));
          assert.equal(before.items.length, 5);
          denied(
            await late(admin, {}, async () => {
              const r = await f.command(
                publisher,
                completed.id,
                co.body.revision,
                'delete',
              );
              assert.equal(r.body.outcome, 'applied', JSON.stringify(r.body));
            }),
            'ERRAND_UNAVAILABLE',
          );
          const after = ok(await list(admin));
          assert.deepEqual(after.total, { status: 'known', value: '5' });
          assert.equal(
            after.items.find((x) => x.id === completed.id)!.state,
            'completed',
          );
          assert.equal(
            after.items.find((x) => x.id === completed.id)!.displayState,
            'deleted',
          );
        },
      );
      await t.test(
        'selected grant expiry after quota wait rejects page; irrelevant short school grant cannot expire global choice',
        async () => {
          const expiring = await f.actor({
            affiliation: 'unverified',
            identity: false,
          });
          await grant(
            expiring,
            'school_admin',
            f.scope.home.regionId,
            new Date(Date.now() + 500),
          );
          denied(
            await late(expiring, {}, async () => {
              await sleep(650);
            }),
            'AUTHORIZATION_UNAVAILABLE',
          );
          await grant(
            global,
            'school_admin',
            f.scope.home.regionId,
            new Date(Date.now() + 500),
          );
          ok(
            await late(
              global,
              { regionId: f.scope.home.regionId },
              async () => {
                await sleep(650);
              },
            ),
          );
        },
      );
      await t.test(
        'missing profiles remain explicit without creation; unknown keyword negatives are unavailable',
        async () => {
          const blank = await f.actor();
          const o = await f.publish(
            blank,
            f.body(undefined, { title: 'MissingDisplay' }),
          );
          const page = ok(await list(admin));
          assert.deepEqual(page.items.find((x) => x.id === o.id)!.publisher, {
            status: 'unavailable',
          });
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_profile.profiles WHERE account_id=$1',
                [blank.accountId],
              )
            ).rowCount,
            0,
          );
          denied(
            await list(admin, { keyword: 'NoSuchPublicText' }),
            'ERRAND_UNAVAILABLE',
          );
          denied(
            await late(admin, {}, () => name(blank, 'NowAvailable')),
            'ERRAND_UNAVAILABLE',
          );
          assert.equal(
            ok(await list(admin, { keyword: 'NowAvailable' })).items[0]!.id,
            o.id,
          );
        },
      );
      await t.test(
        'retired source/target metadata remains readable globally while fixed school authority becomes unavailable',
        async () => {
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
              [f.scope.home.regionId],
            ),
          );
          denied(await list(admin), 'AUTHORIZATION_REQUIRED');
          const page = ok(
            await list(global, { regionId: f.scope.home.regionId }),
          );
          assert.ok(page.items.length);
          assert.ok(
            page.items.every(
              (x) =>
                x.targetRegion.status === 'available' && !x.targetRegion.active,
            ),
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
