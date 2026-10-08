import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import type { Response } from 'supertest';
import { errandRuntimeFixture } from '../support/errand-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { approveErrand } from '../support/errand-review-fixtures.js';
import { ErrandsService } from '../../src/errands/service.js';
import { discoveryCursorBucket } from '../../src/community/discovery-cursors.js';
import { errandAdminPageSchema } from '../../src/errands/admin-contracts.js';
const ok = (r: Response) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return errandAdminPageSchema.parse(r.body);
};
const unavailable = (r: Response) => {
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.error?.code, 'ERRAND_UNAVAILABLE');
};
test(
  'E2A streaming counts, entire sparse scan witnesses, deferred waits and owner fencing',
  { timeout: 240000 },
  async (t) => {
    const f = await errandRuntimeFixture();
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    const list = (a: Actor, q: Record<string, unknown> = {}) =>
      f.auth(request(f.http).get('/v1/admin/errands'), a).query(q);
    const profile = async (a: Actor, n: string) =>
      f.pool.query(
        'INSERT INTO whaleu_profile.profiles(account_id,nickname) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET nickname=EXCLUDED.nickname',
        [a.accountId, n],
      );
    const late = async (
      a: Actor,
      q: Record<string, unknown>,
      work: () => Promise<unknown>,
    ) => {
      const block = await f.pool.connect();
      try {
        await block.query('BEGIN');
        await block.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [
            `whaleu:discovery:quota:v1:${discoveryCursorBucket(a.accountId).hash}`,
          ],
        );
        const pending = list(a, { limit: 1, ...q }).then((x) => x);
        await f.waitForLock('pg_advisory_xact_lock(hashtextextended');
        await work();
        await block.query('COMMIT');
        return await pending;
      } finally {
        await block.query('ROLLBACK');
        block.release();
      }
    };
    try {
      const admin = await f.actor({
          affiliation: 'unverified',
          identity: false,
        }),
        p = await f.actor(),
        tailA = await f.actor(),
        tailB = await f.actor();
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'Synthetic E2A proof')",
          [randomUUID(), admin.accountId, f.scope.home.regionId],
        ),
      );
      await profile(p, 'MatchMain');
      await profile(tailA, 'MatchTail');
      await profile(tailB, 'HiddenTail');
      // Deterministic old timestamps are fixture input, not disabled lifecycle or
      // review guards. Every row is published by the ordinary AppModule service.
      await f.pool.query(
        `CREATE FUNCTION whaleu_errands.synthetic_admin_time() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.created_at:=CASE NEW.expected_time_text WHEN 'tail' THEN '2000-01-01T00:00:00.123456Z'::timestamptz WHEN 'invalid' THEN '0001-01-01 BC'::timestamptz ELSE '2001-01-01T00:00:00.123456Z'::timestamptz END; RETURN NEW; END $$; CREATE TRIGGER synthetic_admin_time BEFORE INSERT ON whaleu_errands.orders FOR EACH ROW EXECUTE FUNCTION whaleu_errands.synthetic_admin_time();`,
      );
      const publish = async (a: Actor, expectedTimeText = 'fixed') => {
        const body = f.body(undefined, {
          title: 'Historical public order',
          publicText: 'A public errand',
          expectedTimeText,
        });
        await approveErrand(f.pool, await f.envelope(a, body));
        const receipt = await f.app
          .get(ErrandsService)
          .publish(a.accessToken, body);
        assert.equal(receipt.outcome, 'applied');
        if (receipt.outcome !== 'applied')
          throw new Error('Synthetic publication rejected');
        return receipt;
      };
      const all: Awaited<ReturnType<typeof publish>>[] = [];
      for (let i = 0; i < 1030; i++) all.push(await publish(p));
      const a = await publish(tailA, 'tail'),
        b = await publish(tailB, 'tail');
      await t.test(
        'more than1024 historical tied rows stream exact decimal counts and bounded distinct keysets',
        async () => {
          const page = ok(await list(admin, { limit: 50 }));
          assert.deepEqual(page.total, { status: 'known', value: '1032' });
          assert.equal(page.items.length, 50);
          assert.equal(page.continuation, 'more');
          assert.ok(
            page.items.every((x) => x.createdAt === '2001-01-01T00:00:00.123Z'),
          );
          const next = ok(
            await list(admin, { limit: 50, cursor: page.nextCursor }),
          );
          assert.deepEqual(next.total, { status: 'known', value: '1032' });
          assert.equal(
            new Set([...page.items, ...next.items].map((x) => x.id)).size,
            100,
          );
          assert.deepEqual(ok(await list(admin, { keyword: 'Match' })).total, {
            status: 'known',
            value: '1031',
          });
        },
      );
      await t.test(
        'sparse empty page has explicit more and negative profile facts remain in the late witness',
        async () => {
          const sparse = ok(await list(admin, { keyword: 'NowMatches' }));
          assert.equal(sparse.items.length, 0);
          assert.equal(sparse.continuation, 'more');
          assert.deepEqual(sparse.total, { status: 'known', value: '0' });
          unavailable(
            await late(admin, { keyword: 'NowMatches' }, () =>
              profile(p, 'NowMatches'),
            ),
          );
          await profile(p, 'MatchMain');
        },
      );
      await t.test(
        'count change outside first101 candidates preserves page but invalidates large optional total',
        async () => {
          const result = ok(
            await late(admin, { status: 'pending' }, async () => {
              const response = await f.command(
                tailA,
                a.orderId,
                a.revision,
                'cancel',
              );
              assert.equal(
                response.body.outcome,
                'applied',
                JSON.stringify(response.body),
              );
            }),
          );
          assert.equal(result.items.length, 1);
          assert.deepEqual(result.total, { status: 'unavailable' });
          assert.deepEqual(ok(await list(admin, { status: 'pending' })).total, {
            status: 'known',
            value: '1031',
          });
        },
      );
      await t.test(
        'equal cardinality name swap beyond page cannot rescue invalidated large epoch proof',
        async () => {
          const before = ok(await list(admin, { keyword: 'Match' }));
          assert.deepEqual(before.total, { status: 'known', value: '1031' });
          const result = ok(
            await late(admin, { keyword: 'Match' }, async () => {
              await f.pool.query(
                "UPDATE whaleu_profile.profiles SET nickname=CASE account_id WHEN $1::uuid THEN 'HiddenTail' ELSE 'MatchTail' END WHERE account_id=ANY($2::uuid[])",
                [tailA.accountId, [tailA.accountId, tailB.accountId]],
              );
            }),
          );
          assert.equal(result.items[0]!.id, before.items[0]!.id);
          assert.deepEqual(result.total, { status: 'unavailable' });
          assert.deepEqual(ok(await list(admin, { keyword: 'Match' })).total, {
            status: 'known',
            value: '1031',
          });
        },
      );
      await t.test(
        'status entry from legal E1 cancellation during quota wait changes candidate witness',
        async () => {
          const cancelled = await f.command(
            tailB,
            b.orderId,
            b.revision,
            'cancel',
          );
          assert.equal(cancelled.body.outcome, 'applied');
          unavailable(
            await late(admin, { status: 'cancelled' }, async () => {
              const row = all.at(-1)!;
              const response = await f.command(
                p,
                row.orderId,
                row.revision,
                'cancel',
              );
              assert.equal(response.body.outcome, 'applied');
            }),
          );
        },
      );
      await t.test(
        'deferred constraint wait happens before final page fences and catches current profile change',
        async () => {
          await f.pool.query(
            `CREATE FUNCTION whaleu_community.synthetic_admin_deferred() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(1464356199,1); RETURN NULL; END $$; CREATE CONSTRAINT TRIGGER synthetic_admin_deferred AFTER INSERT ON whaleu_community.discovery_cursors DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.synthetic_admin_deferred();`,
          );
          const block = await f.pool.connect();
          try {
            await block.query('BEGIN');
            await block.query('SELECT pg_advisory_xact_lock(1464356199,1)');
            const pending = list(admin, { limit: 2 }).then((x) => x);
            await f.waitForLock('SET CONSTRAINTS ALL IMMEDIATE');
            await profile(p, 'ChangedAtDeferred');
            await block.query('COMMIT');
            unavailable(await pending);
          } finally {
            await block.query('ROLLBACK');
            block.release();
            await f.pool.query(
              'DROP TRIGGER synthetic_admin_deferred ON whaleu_community.discovery_cursors; DROP FUNCTION whaleu_community.synthetic_admin_deferred()',
            );
          }
          await profile(p, 'MatchMain');
        },
      );
      await t.test(
        'active Profile writer causes bounded NOWAIT failure and completes without deadlock',
        async () => {
          const writer = await f.pool.connect();
          try {
            await writer.query('BEGIN');
            await writer.query(
              "UPDATE whaleu_profile.profiles SET nickname='Uncommitted' WHERE account_id=$1",
              [p.accountId],
            );
            unavailable(await list(admin));
            await writer.query('COMMIT');
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
          assert.equal(
            ok(await list(admin)).items[0]!.publisher.status,
            'available',
          );
          await profile(p, 'MatchMain');
        },
      );
      await t.test(
        'unrepresentable coordinate beyond first page makes only optional count unavailable',
        async () => {
          await publish(p, 'invalid');
          const page = ok(await list(admin));
          assert.equal(page.items.length, 20);
          assert.deepEqual(page.total, { status: 'unavailable' });
        },
      );
      await t.test(
        'parser failures and GET bodies retain no-store and authorization variation',
        async () => {
          for (const response of [
            await f
              .auth(request(f.http).get('/v1/admin/errands'), admin)
              .send({}),
            await f
              .auth(request(f.http).get('/v1/admin/errands'), admin)
              .set('Content-Type', 'application/json')
              .send('{'),
            await f
              .auth(request(f.http).get('/v1/admin/errands'), admin)
              .set('Content-Type', 'application/json')
              .send(JSON.stringify({ value: 'x'.repeat(100000) })),
          ]) {
            assert.ok(response.status >= 400);
            assert.equal(response.headers['cache-control'], 'no-store');
            assert.equal(response.headers['vary'], 'Authorization');
          }
        },
      );
      void b;
    } finally {
      await f.close();
    }
  },
);
