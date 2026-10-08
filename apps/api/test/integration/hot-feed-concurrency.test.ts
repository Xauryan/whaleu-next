import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import {
  hotFeedFixture,
  hotIds,
  hotOk,
  hotFailure,
} from '../support/hot-feed-fixture.js';
import { setRuntimeVerification } from '../support/community-runtime-fixtures.js';
import { hashToken } from '../../src/identity/tokens.js';
import {
  DiscoveryCursorRepository,
  discoveryCursorBucket,
} from '../../src/community/discovery-cursors.js';
import { inTransaction } from '../../src/database/database.js';

const finalRows = 'WITH ORDINALITY AS r(viewer,author,bilateral,ordinality)';

test(
  'hot feed bounded traversal and final PostgreSQL race proofs',
  { timeout: 300000 },
  async (t) => {
    const f = await hotFeedFixture();
    try {
      await t.test(
        'day cap counts emitted slots; 128 denied certificates plus structural lookahead make scan_pending progress',
        async () => {
          const w = await f.world(),
            rows: string[] = [];
          for (let n = 0; n < 130; n++) {
            const p = await w.publish();
            rows.push(p.id);
            if (n < 129)
              await f.pool.query(
                'UPDATE whaleu_post_hotness.view_states SET count=1 WHERE post_id=$1',
                [p.id],
              );
            await f.materializer.refresh(p.id);
          }
          let cursor: string | null = null,
            total = 0;
          for (let page = 0; page < 5; page++) {
            const body = hotOk(await w.hot(cursor ? { cursor } : {}));
            total += body.items.length;
            cursor = body.nextCursor;
            assert.equal(body.continuation, page === 4 ? 'end' : 'more');
          }
          assert.equal(total, 50);
          assert.equal(cursor, null);
          // A forged derived certificate remains structurally discoverable, but it is
          // never proof. No triggers, canonical source facts or guards are disabled.
          await f.pool.query(
            "UPDATE whaleu_post_hotness.scores SET certificate_hash=repeat('0',64) WHERE post_id=ANY($1::uuid[])",
            [rows.slice(0, 129)],
          );
          const seen: { sql: string; rows: number }[] = [];
          f.observer.setHook(async (event) => {
            seen.push({ sql: event.sql, rows: event.rows });
          });
          const before = await f.domainSnapshot();
          const first = hotOk(await w.hot());
          f.observer.setHook(null);
          assert.deepEqual(first.items, []);
          assert.equal(first.continuation, 'scan_pending');
          assert.deepEqual(await f.domainSnapshot(), before);
          const guest = hotOk(await w.hot({}, null));
          assert.deepEqual(guest.items, []);
          assert.equal(guest.continuation, 'login_required');
          const unverified = await w.actor('unverified'),
            phone = hotOk(await w.hot({}, unverified));
          assert.deepEqual(phone.items, []);
          assert.equal(phone.continuation, 'phone_verification_required');
          hotFailure(
            await w.hot({ cursor: first.nextCursor }, unverified),
            403,
            'PHONE_VERIFICATION_REQUIRED',
          );
          const batch = seen.find((e) => /LIMIT\s+129/.test(e.sql));
          assert.ok(batch);
          assert.equal(batch.rows, 129);
          assert.ok(!/SELECT\s+p\.\*/i.test(batch.sql));
          assert.ok(
            !/\bp\.(text|account_id)\b/.test(batch.sql),
            'Structural lookahead projects no content or actor',
          );
          const second = hotOk(await w.hot({ cursor: first.nextCursor }));
          assert.deepEqual(hotIds(second), [rows[129]]);
          assert.equal(second.continuation, 'end');
          assert.ok(!first.nextCursor!.includes(rows[0]!));
        },
      );
      await t.test(
        'all six caps terminate by remaining emitted slots without counting examined candidates',
        async () => {
          const w = await f.world();
          for (let n = 0; n < 12; n++) await w.ready();
          for (const [range, cap] of [
            ['day', 50],
            ['week', 200],
            ['month', 1000],
            ['half_year', 1000],
            ['year', 1000],
            ['history', 1000],
          ] as const) {
            const first = hotOk(await w.hot({ range, limit: 1 }), 1);
            const row = (
              await f.pool.query<{
                scope_hash: string;
                position: Record<string, unknown> & { v: number };
              }>(
                'SELECT scope_hash,position FROM whaleu_community.discovery_cursors WHERE cursor=$1',
                [first.nextCursor],
              )
            ).rows[0]!;
            assert.equal(row.position['kind'], 'hot');
            // Create bounded private navigation through its owner, without mutating the
            // immutable stored cursor or encoding a score in a client-visible token.
            const position = { ...row.position, emitted: cap - 1 };
            const capped = await inTransaction(f.pool, (tx) =>
              f.app
                .get(DiscoveryCursorRepository)
                .create(
                  row.scope_hash,
                  discoveryCursorBucket(w.reader.accountId),
                  position,
                  tx,
                ),
            );
            const last = hotOk(
              await w.hot({ range, limit: 1, cursor: capped }),
              1,
            );
            assert.equal(last.items.length, 1);
            assert.equal(last.continuation, 'end');
            assert.equal(last.nextCursor, null);
            assert.equal(
              hotOk(await w.hot({ range, limit: 1 }), 1).continuation,
              'more',
              'Refresh resets delivered slots',
            );
          }
        },
      );
      await t.test(
        'candidate score movement after structural selection is skipped at original coordinate',
        async () => {
          const w = await f.world(),
            moving = await w.ready(),
            other = await w.ready();
          await f.pool.query(
            'UPDATE whaleu_post_hotness.view_states SET count=1 WHERE post_id=$1',
            [moving.id],
          );
          await f.materializer.refresh(moving.id);
          let changed = false;
          f.observer.setHook(async (event) => {
            if (!changed && /LIMIT\s+129/.test(event.sql)) {
              changed = true;
              await f.pool.query(
                'UPDATE whaleu_post_hotness.view_states SET count=32 WHERE post_id=$1',
                [moving.id],
              );
              await f.materializer.refresh(moving.id);
            }
          });
          try {
            const page = hotOk(await w.hot({ limit: 1 }), 1);
            assert.equal(changed, true);
            assert.deepEqual(hotIds(page), [other.id]);
          } finally {
            f.observer.setHook(null);
          }
          assert.deepEqual(hotIds(hotOk(await w.hot({ limit: 1 }), 1)), [
            moving.id,
          ]);
        },
      );
      await t.test(
        'parent lock precedes component locks and bounded lock timeout never returns partial data',
        async () => {
          const w = await f.world(),
            post = await w.ready(),
            holder = await f.pool.connect();
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [post.id],
            );
            const response = Promise.resolve(w.hot());
            await f.waitForLock('whaleu_community.posts');
            for (const component of ['subscription', 'like', 'comment', 'view'])
              await holder.query(
                `SELECT post_id FROM whaleu_post_hotness.${component}_states WHERE post_id=$1 FOR UPDATE NOWAIT`,
                [post.id],
              );
            const result = await response;
            hotFailure(result, 503);
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
          }
          assert.deepEqual(hotIds(hotOk(await w.hot())), [post.id]);
        },
      );
      await t.test(
        'new block inserted after cursor creation fails final relationship proof and rolls the cursor back',
        async () => {
          const w = await f.world();
          for (let n = 0; n < 3; n++) await w.ready();
          const before = (
            await f.pool.query<{ n: number }>(
              'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
            )
          ).rows[0]!.n;
          let inserted = false,
            final = false;
          f.observer.setHook(async (event) => {
            if (event.sql.includes(finalRows)) final = true;
            if (
              !inserted &&
              event.sql.includes(
                'INSERT INTO whaleu_community.discovery_cursors',
              )
            ) {
              inserted = true;
              await f.rawBlock(w.reader, w.author);
            }
          });
          try {
            hotFailure(await w.hot({ limit: 1 }), 503);
            assert.equal(inserted, true);
            assert.equal(final, true);
          } finally {
            f.observer.setHook(null);
          }
          assert.equal(
            (
              await f.pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
              )
            ).rows[0]!.n,
            before,
          );
        },
      );
      await t.test(
        'phone/session expiry after cursor insertion fails at final transaction deadline',
        async () => {
          for (const deadline of ['phone', 'session'] as const) {
            const w = await f.world();
            for (let n = 0; n < 3; n++) await w.ready();
            const expiresAt = new Date(Date.now() + 1600);
            if (deadline === 'phone')
              await setRuntimeVerification(
                f.pool,
                w.reader.accountId,
                w.scope.institutionId,
                w.scope.home.regionId,
                'verified',
                'verified',
                expiresAt,
              );
            else
              await f.pool.query(
                'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE token_hash=$1',
                [hashToken(w.reader.accessToken), expiresAt],
              );
            const before = (
              await f.pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
              )
            ).rows[0]!.n;
            let waited = false,
              inserted = false;
            f.observer.setHook(async (event) => {
              if (
                event.sql.includes(
                  'INSERT INTO whaleu_community.discovery_cursors',
                )
              )
                inserted = true;
              if (!waited && event.sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
                assert.equal(inserted, true);
                waited = true;
                await sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 75);
              }
            });
            try {
              hotFailure(
                await w.hot({ limit: 1 }),
                deadline === 'phone' ? 403 : 401,
                deadline === 'phone'
                  ? 'PHONE_VERIFICATION_REQUIRED'
                  : undefined,
              );
              assert.equal(waited, true);
            } finally {
              f.observer.setHook(null);
            }
            assert.equal(
              (
                await f.pool.query<{ n: number }>(
                  'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
                )
              ).rows[0]!.n,
              before,
            );
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);
