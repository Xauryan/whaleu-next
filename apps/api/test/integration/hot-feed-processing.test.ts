import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import {
  hotFeedFixture,
  hotIds,
  hotOk,
  hotFailure,
} from '../support/hot-feed-fixture.js';
import { HotFeedRunner } from '../../src/community/hot-score/runner.js';
import { ViewComponentCleanup } from '../../src/community/view-component/cleanup.js';

const effects = ['subscription', 'like', 'comment'] as const;
async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  deadlineMs = 15000,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await sleep(50);
  }
  assert.fail('Expected bounded real runtime progress before deadline');
}

test(
  'hot processing uses isolated source transactions, idempotent competing runners, bounded fairness and retry hints',
  { timeout: 180000 },
  async (t) => {
    const f = await hotFeedFixture({ hotFeedProcessing: 'automatic' });
    try {
      const makeDue = (ids: string[]) =>
        f.pool.query(
          "UPDATE whaleu_post_hotness.processing SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE post_id=ANY($1::uuid[])",
          [ids],
        );
      await t.test(
        'automatic setting alone does not start timers in an imported non-HTTP module',
        async () => {
          const w = await f.world(),
            p = await w.publish();
          assert.throws(() => f.app.get(HotFeedRunner));
          assert.equal(await f.certificate(p.id), undefined);
          await f.processing.cycle();
          assert.ok(await f.certificate(p.id));
        },
      );
      await t.test(
        'add/remove/re-add is settled in source order once despite simultaneous automatic cycles',
        async () => {
          const w = await f.world(),
            p = await w.ready();
          await f.save(w.reader, p.id);
          await f.save(w.reader, p.id, false);
          await f.save(w.reader, p.id);
          await f.like(w.reader, p.id);
          await f.like(w.reader, p.id, false);
          await f.like(w.reader, p.id);
          const root = await f.root(w.reader, p.id);
          await f.deleteContent(w.reader, 'root', root.id).expect(204);
          await f.root(w.reader, p.id, 'anonymous');
          const before = await f.domainSnapshot();
          const oldCert = await f.certificate(p.id);
          assert.deepEqual(hotIds(hotOk(await w.hot())), []);
          let ready = false;
          for (let round = 0; round < 6 && !ready; round++) {
            await makeDue([p.id]);
            const summaries = await Promise.all([
              f.processing.cycle(),
              f.processing.cycle(),
            ]);
            assert.ok(
              summaries.every(
                (s) => s.componentTransactions <= 50 && s.attempted <= 20,
              ),
            );
            ready = hotIds(hotOk(await w.hot())).includes(p.id);
          }
          assert.equal(ready, true);
          assert.notDeepEqual(await f.certificate(p.id), oldCert);
          for (const component of effects) {
            const receipts = (
              await f.pool.query<{
                source_sequence: string;
                application_xid: string;
                previous_state_sequence: string;
              }>(
                `SELECT source_sequence::text,application_xid::text,previous_state_sequence::text FROM whaleu_post_hotness.${component}_receipts WHERE post_id=$1 ORDER BY source_sequence`,
                [p.id],
              )
            ).rows;
            assert.equal(receipts.length, 3, component);
            assert.equal(
              new Set(receipts.map((r) => r.application_xid)).size,
              3,
              'Exactly one component source per transaction',
            );
            assert.equal(receipts[0]!.previous_state_sequence, '0');
            assert.equal(
              receipts[1]!.previous_state_sequence,
              receipts[0]!.source_sequence,
            );
            assert.equal(
              receipts[2]!.previous_state_sequence,
              receipts[1]!.source_sequence,
            );
          }
          const after = await f.domainSnapshot();
          for (const [table, value] of Object.entries(before))
            if (
              !table.startsWith('whaleu_post_hotness.') &&
              table !== 'whaleu_community.saved_obligations'
            )
              assert.deepEqual(
                after[table],
                value,
                `Processing cannot mutate unrelated owner ${table}`,
              );
          const obligations = (
            await f.pool.query<{ action: string; status: string }>(
              'SELECT o.action,o.status FROM whaleu_community.saved_obligations o JOIN whaleu_community.saved_epochs e ON e.id=o.epoch_id WHERE e.post_id=$1',
              [p.id],
            )
          ).rows;
          assert.ok(
            obligations
              .filter((o) => o.action === 'save_ranking')
              .every((o) => o.status === 'completed'),
          );
          assert.ok(
            obligations
              .filter((o) => o.action !== 'save_ranking')
              .every((o) => o.status === 'pending'),
          );
          const settled = await f.domainSnapshot();
          await f.processing.cycle();
          assert.deepEqual(
            await f.domainSnapshot(),
            settled,
            'Clean current vectors require no repeated score rewrite or source effects',
          );
        },
      );
      await t.test(
        'component transaction budget never reschedules untouched tail and cannot starve later posts',
        async () => {
          const w = await f.world(),
            ids: string[] = [];
          for (let n = 0; n < 20; n++) {
            const p = await w.publish();
            ids.push(p.id);
            await f.save(w.reader, p.id);
            await f.like(w.reader, p.id);
            await f.root(w.reader, p.id);
          }
          const summary = await f.processing.cycle();
          assert.ok(summary.componentTransactions <= 50);
          assert.ok(summary.attempted < 20);
          const rows = (
            await f.pool.query<{
              post_id: string;
              last_attempt_at: Date | null;
            }>(
              'SELECT post_id,last_attempt_at FROM whaleu_post_hotness.processing WHERE post_id=ANY($1::uuid[]) ORDER BY next_attempt_at,post_id',
              [ids],
            )
          ).rows;
          const untouched = rows.filter((r) => r.last_attempt_at === null);
          assert.equal(untouched.length, 20 - summary.attempted);
          assert.ok(untouched.length > 0);
          // Re-dirty processed prefix immediately. The untouched older frontier still wins.
          for (const row of rows.filter((r) => r.last_attempt_at !== null))
            await f.like(w.reader, row.post_id, false);
          await f.processing.cycle();
          for (const row of untouched)
            assert.ok(
              await f.certificate(row.post_id),
              'No permanently skipped suffix behind an active prefix',
            );
        },
      );
      await t.test(
        'locked oldest parent holds no scheduler row and receives bounded retry while independent posts progress',
        async () => {
          const w = await f.world(),
            bad = await w.publish(),
            good = await w.publish();
          // Make only this world due so an earlier test cannot accidentally consume the bound.
          await f.pool.query(
            "UPDATE whaleu_post_hotness.processing SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE post_id<>ALL($1::uuid[])",
            [[bad.id, good.id]],
          );
          await makeDue([bad.id, good.id]);
          const holder = await f.pool.connect();
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [bad.id],
            );
            const cycle = f.processing.cycle();
            await f.waitForLock('whaleu_community.posts');
            await holder.query('SAVEPOINT scheduler_probe');
            await holder.query(
              'SELECT post_id FROM whaleu_post_hotness.processing WHERE post_id=$1 FOR UPDATE NOWAIT',
              [bad.id],
            );
            // Release only the probe while retaining the original parent lock.
            await holder.query('ROLLBACK TO SAVEPOINT scheduler_probe');
            const summary = await cycle;
            assert.ok(summary.failed >= 1);
            assert.ok(await f.certificate(good.id));
            const work = (
              await f.pool.query<{
                result: string;
                consecutive_failures: number;
                delay: number;
              }>(
                'SELECT result,consecutive_failures,extract(epoch from next_attempt_at-last_attempt_at)::float8 delay FROM whaleu_post_hotness.processing WHERE post_id=$1',
                [bad.id],
              )
            ).rows[0]!;
            assert.equal(work.result, 'failed');
            assert.ok(work.consecutive_failures >= 1);
            assert.ok(work.delay >= 4.99 && work.delay <= 300.01);
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'explicit HTTP automatic runner restores the public feed after accepted interactions with no manual score work',
  { timeout: 45000 },
  async () => {
    const f = await hotFeedFixture({
      hotFeedProcessing: 'automatic',
      httpRuntime: true,
    });
    try {
      // Retention admission is a separate existing owner. Make its disposable local
      // housekeeping ready; this never invokes a hot component or score worker.
      await f.app.get(ViewComponentCleanup).run();
      const w = await f.world(),
        post = await w.publish();
      await until(() => f.certificate(post.id), Boolean, 12000);
      assert.deepEqual(hotIds(hotOk(await w.hot())), [post.id]);
      const first = await f.certificate(post.id);
      await f.like(w.reader, post.id);
      await f.save(w.reader, post.id);
      await f.root(w.reader, post.id);
      await f.view(w.reader, [post.id]);
      assert.deepEqual(hotIds(hotOk(await w.hot())), []);
      await until(
        async () => hotIds(hotOk(await w.hot())),
        (ids) => ids.includes(post.id),
        15000,
      );
      const second = await f.certificate(post.id);
      assert.notEqual(second.certificate_hash, first.certificate_hash);
      assert.equal(second.snapshot.states.view.count, '1');
      for (const component of effects)
        assert.equal(
          second.snapshot.states[component].capturedHead,
          second.snapshot.states[component].processedHead,
        );
      const runner = f.app.get(HotFeedRunner),
        pendingPost = await w.publish(),
        holder = await f.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
          [pendingPost.id],
        );
        const tick = runner.tick();
        await f.waitForLock('whaleu_community.posts');
        let stopped = false;
        const shutdown = runner.beforeApplicationShutdown().then(() => {
          stopped = true;
        });
        await sleep(30);
        assert.equal(
          stopped,
          false,
          'Shutdown waits for the in-flight PostgreSQL transaction',
        );
        await holder.query('ROLLBACK');
        await tick;
        await shutdown;
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      const before = await f.domainSnapshot();
      await runner.tick();
      assert.deepEqual(
        await f.domainSnapshot(),
        before,
        'Shutdown rejects new scheduling',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'disabled public hot stays explicitly unavailable; manual HTTP runtime has no score timer',
  { timeout: 30000 },
  async () => {
    for (const mode of ['disabled', 'manual_only'] as const) {
      const f = await hotFeedFixture({
        hotFeedProcessing: mode,
        httpRuntime: true,
      });
      try {
        const w = await f.world(),
          p = await w.publish();
        assert.throws(() => f.app.get(HotFeedRunner));
        assert.equal(await f.certificate(p.id), undefined);
        if (mode === 'disabled')
          hotFailure(await w.hot(), 503, 'HOT_FEED_UNAVAILABLE');
        else {
          assert.deepEqual(hotIds(hotOk(await w.hot())), []);
          await f.processing.processSelected([p.id]);
          assert.deepEqual(hotIds(hotOk(await w.hot())), [p.id]);
        }
      } finally {
        await f.close();
      }
    }
  },
);
