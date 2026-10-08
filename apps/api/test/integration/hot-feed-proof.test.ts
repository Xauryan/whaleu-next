import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { hotFeedFixture, hotIds, hotOk } from '../support/hot-feed-fixture.js';
import { HotRepository } from '../../src/community/hot/repository.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { HotScoreStorage } from '../../src/community/hot-score/storage.js';
import { currentHotScoreCertificate } from '../../src/community/hot-score/certificate.js';
import { validateHotScoreSnapshot } from '../../src/community/hot-score/contracts.js';
import { inTransaction } from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';

test(
  'hot certificate identity and elapsed-time range boundaries use full real owner proof',
  { timeout: 120000 },
  async (t) => {
    const f = await hotFeedFixture();
    try {
      await t.test(
        'certificate binds current complete identity/vector and unchanged proof is never recomputed on read or refresh',
        async () => {
          const w = await f.world(),
            p = await w.ready();
          const before = await f.certificate(p.id);
          assert.equal(await f.materializer.refresh(p.id), 'current');
          assert.deepEqual(await f.certificate(p.id), before);
          await inTransaction(f.pool, async (tx) => {
            await f.repository.lockPost(p.id, tx);
            await f.repository.lockStates(p.id, tx);
            const snapshot = await f.repository.snapshot(p.id, tx),
              cert = await f.app.get(HotScoreStorage).certificate(p.id, tx);
            assert.ok(snapshot);
            assert.ok(cert);
            assert.equal(validateHotScoreSnapshot(snapshot).status, 'ready');
            assert.equal(currentHotScoreCertificate(cert, snapshot), true);
          });
          const sql: string[] = [];
          f.observer.setHook(async (event) => {
            sql.push(event.sql);
          });
          try {
            hotOk(await w.hot());
          } finally {
            f.observer.setHook(null);
          }
          assert.ok(
            !sql.some((statement) => /\b(power|ln|sqrt)\s*\(/i.test(statement)),
            'Public reads validate certificates, never evaluate the formula',
          );
          assert.ok(
            !sql.some((statement) =>
              /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+whaleu_post_hotness\./i.test(
                statement,
              ),
            ),
          );
          for (const [column, value] of [
            ['owner_id', randomUUID()],
            ['source_request_id', randomUUID()],
            ['source_formula_version', 7],
            ['numeric_profile', 'unknown-profile'],
            ['numeric_profile_version', 2],
            ['formula_fingerprint', '0'.repeat(64)],
            ['expression_fingerprint', '0'.repeat(64)],
            ['certificate_hash', '0'.repeat(64)],
            ['score', '12.0000'],
          ] as const) {
            await f.pool.query(
              `UPDATE whaleu_post_hotness.scores SET ${column}=$2 WHERE post_id=$1`,
              [p.id, value],
            );
            assert.deepEqual(hotIds(hotOk(await w.hot())), [], column);
            assert.equal(await f.materializer.refresh(p.id), 'refreshed');
            assert.deepEqual(hotIds(hotOk(await w.hot())), [p.id]);
          }
          await f.pool.query(
            "UPDATE whaleu_post_hotness.scores SET snapshot=jsonb_set(snapshot,'{states,view,count}','\"1\"'::jsonb) WHERE post_id=$1",
            [p.id],
          );
          assert.deepEqual(hotIds(hotOk(await w.hot())), []);
          await f.materializer.refresh(p.id);
        },
      );
      await t.test(
        'all age lower bounds are inclusive exact elapsed days in non-UTC DST sessions and future publication is excluded',
        async () => {
          const clock = '2026-11-02T05:30:00.000000Z',
            at = Date.parse(clock),
            repository = f.app.get(HotRepository),
            community = f.app.get(CommunityRepository);
          for (const [range, days] of [
            ['day', 1],
            ['week', 7],
            ['month', 30],
            ['half_year', 180],
            ['year', 365],
          ] as const) {
            const w = await f.world(),
              boundary = at - days * 86400000;
            const inside = await w.dated(new Date(boundary + 1).toISOString()),
              exact = await w.dated(new Date(boundary).toISOString()),
              outside = await w.dated(new Date(boundary - 1).toISOString()),
              future = await w.dated(new Date(at + 1).toISOString());
            await inTransaction(f.pool, async (tx) => {
              await tx.query("SET LOCAL TimeZone='America/New_York'");
              await lockSafetyPolicy(tx);
              const space = await community.space(w.scope.home.spaceId, tx),
                query = { spaceId: space.id, range, limit: 10 };
              const found = await repository.candidates(
                space,
                query,
                clock,
                null,
                tx,
              );
              assert.deepEqual(
                found.map((p) => p.id).sort(),
                [inside.id, exact.id].sort(),
                range,
              );
              assert.equal(
                await repository.structurallyAllowed(
                  exact.id,
                  space,
                  query,
                  clock,
                  tx,
                ),
                true,
              );
              assert.equal(
                await repository.structurallyAllowed(
                  outside.id,
                  space,
                  query,
                  clock,
                  tx,
                ),
                false,
              );
              assert.equal(
                await repository.structurallyAllowed(
                  future.id,
                  space,
                  query,
                  clock,
                  tx,
                ),
                false,
              );
              const historical = await repository.candidates(
                space,
                { ...query, range: 'history' },
                clock,
                null,
                tx,
              );
              assert.deepEqual(
                historical.map((p) => p.id).sort(),
                [inside.id, exact.id, outside.id].sort(),
              );
            });
          }
        },
      );
      await t.test(
        'bounded manual selection never processes rejected partial independent coverage, even when another component captured work',
        async () => {
          const w = await f.world(),
            tx = await f.pool.connect(),
            original = f.database.transaction;
          try {
            await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
            const id = await f.partialNative(tx, w.author.accountId, 'view');
            await tx.query(
              'INSERT INTO whaleu_community.post_likes(post_id,account_id) VALUES($1,$2)',
              [id, w.reader.accountId],
            );
            assert.equal(
              (
                await tx.query(
                  'SELECT 1 FROM whaleu_post_hotness.like_sources WHERE post_id=$1',
                  [id],
                )
              ).rowCount,
              1,
            );
            // Keep deliberately incomplete deferred facts inside one rollback-only
            // real transaction; the unchanged business owner still sees actual SQL.
            f.database.transaction = async (operation, options) => {
              assert.equal(options?.isolationLevel, 'read committed');
              return operation(tx);
            };
            const result = await f.processing.processSelected([id]);
            assert.equal(result.attempted, 0);
            assert.equal(result.blocked, 1);
            for (const table of ['processing', 'scores', 'like_receipts'])
              assert.equal(
                (
                  await tx.query(
                    `SELECT 1 FROM whaleu_post_hotness.${table} WHERE post_id=$1`,
                    [id],
                  )
                ).rowCount,
                0,
              );
            assert.equal(
              (
                await tx.query<{ count: string }>(
                  'SELECT count::text FROM whaleu_post_hotness.like_states WHERE post_id=$1',
                  [id],
                )
              ).rows[0]!.count,
              '0',
            );
          } finally {
            f.database.transaction = original;
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      await t.test(
        'repeated manual selection advances its unattempted suffix under the 50-transaction cycle bound',
        async () => {
          const w = await f.world(),
            ids: string[] = [];
          for (let n = 0; n < 20; n++) ids.push((await w.publish()).id);
          const first = await f.processing.processSelected(ids);
          assert.ok(first.componentTransactions <= 50);
          assert.ok(first.attempted < 20);
          await f.processing.processSelected(ids);
          for (const id of ids) assert.ok(await f.certificate(id));
        },
      );
    } finally {
      await f.close();
    }
  },
);
