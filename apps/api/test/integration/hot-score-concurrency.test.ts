import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { SubscriptionComponentSettlement } from '../../src/community/subscription-component/settlement.js';
import { LikeComponentSettlement } from '../../src/community/like-component/settlement.js';
import { CommentComponentSettlement } from '../../src/community/comment-component/settlement.js';
import {
  assertComputed,
  components,
  hotScoreFixture,
} from '../support/hot-score-fixture.js';
import { observeViewQueries } from '../support/view-component-fixture.js';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const code = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  ['55P03', '57014'].includes(String(error.code));

test(
  'internal score concurrency: parent-first state locking, fresh reread, direct view serialization and bounded release',
  { timeout: 120000 },
  async (t) => {
    const f = await hotScoreFixture();
    try {
      const author = await f.actor(),
        actor = await f.actor();
      await t.test(
        'waiting on parent holds no state lock; committed settlement and direct views are reread afterward',
        async () => {
          const post = await f.publish(author);
          await f.save(actor, post.id);
          await f.like(actor, post.id);
          await f.root(actor, post.id);
          const holder = await f.pool.connect();
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [post.id],
            );
            const pending = f.service.inspect(post.id, 'compute');
            await f.waitForLock('SELECT id FROM whaleu_community.posts');
            for (const component of components)
              await holder.query(
                `SELECT post_id FROM whaleu_post_hotness.${component}_states WHERE post_id=$1 FOR UPDATE NOWAIT`,
                [post.id],
              );
            assert.equal(
              await f.app
                .get(SubscriptionComponentSettlement)
                .process(
                  (await f.ids('subscription', post.id))[0]!,
                  holder,
                  true,
                ),
              'applied',
            );
            assert.equal(
              await f.app
                .get(LikeComponentSettlement)
                .process((await f.ids('like', post.id))[0]!, holder, true),
              'applied',
            );
            assert.equal(
              await f.app
                .get(CommentComponentSettlement)
                .process((await f.ids('comment', post.id))[0]!, holder, true),
              'applied',
            );
            await holder.query(
              'UPDATE whaleu_post_hotness.view_states SET count=count+9 WHERE post_id=$1',
              [post.id],
            );
            await holder.query('COMMIT');
            const result = await pending;
            assertComputed(result);
            assert.equal(result.snapshot.states.view!.count, '9');
            assert.deepEqual(result.snapshot.states.subscription!.counts, [
              '1',
            ]);
            assert.deepEqual(result.snapshot.states.like!.counts, ['1']);
            assert.deepEqual(result.snapshot.states.comment!.counts, [
              '1',
              '0',
              '1',
              '1',
            ]);
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
          }
        },
      );
      await t.test(
        'explicit state order precedes the single snapshot; direct positive view writer cannot tear it',
        async () => {
          const post = await f.publish(author),
            other = await f.publish(author);
          const reached = gate(),
            resume = gate();
          const original = f.repository.snapshot.bind(f.repository);
          f.repository.snapshot = async (id, tx) => {
            if (id === post.id) {
              reached.release();
              await resume.promise;
            }
            return original(id, tx);
          };
          const observed = observeViewQueries(f.app),
            sql: string[] = [];
          observed.setHook(async ({ sql: statement }) => {
            sql.push(statement);
          });
          const writer = await f.pool.connect();
          try {
            const compute = f.service.inspect(post.id, 'compute');
            await reached.promise;
            const unrelated = await f.service.inspect(other.id, 'compute');
            assertComputed(unrelated);
            await writer.query('BEGIN');
            await writer.query("SET LOCAL lock_timeout='80ms'");
            await assert.rejects(
              writer.query(
                'UPDATE whaleu_post_hotness.view_states SET count=count+1 WHERE post_id=$1',
                [post.id],
              ),
              code,
            );
            await writer.query('ROLLBACK');
            const locks = sql.filter((s) => /FOR UPDATE/.test(s));
            assert.deepEqual(locks.slice(0, 5), [
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              ...components.map(
                (c) =>
                  `SELECT post_id FROM whaleu_post_hotness.${c}_states WHERE post_id=$1 FOR UPDATE`,
              ),
            ]);
            resume.release();
            const result = await compute;
            assertComputed(result);
            assert.equal(result.snapshot.states.view!.count, '0');
            assert.equal(result.score, '0.0000');
            await writer.query(
              'UPDATE whaleu_post_hotness.view_states SET count=count+1 WHERE post_id=$1',
              [post.id],
            );
            const after = await f.service.inspect(post.id, 'compute');
            assertComputed(after);
            assert.equal(after.snapshot.states.view!.count, '1');
            assert.equal(after.score, '7.6000');
            assert.ok(
              sql.some(
                (s) =>
                  /statement_timestamp\(\)/.test(s) &&
                  /subscription_baselines/.test(s) &&
                  /view_states/.test(s),
              ),
              'All frozen inputs and snapshotAt share an ordinary SELECT statement',
            );
          } finally {
            resume.release();
            f.repository.snapshot = original;
            observed.restore();
            await writer.query('ROLLBACK');
            writer.release();
          }
        },
      );
      await t.test(
        'direct view writer that acquired state first commits before reader final capture',
        async () => {
          const post = await f.publish(author),
            writer = await f.pool.connect();
          try {
            await writer.query('BEGIN');
            await writer.query(
              'UPDATE whaleu_post_hotness.view_states SET count=count+2 WHERE post_id=$1',
              [post.id],
            );
            const compute = f.service.inspect(post.id, 'compute');
            await f.waitForLock(
              'SELECT post_id FROM whaleu_post_hotness.view_states',
            );
            await writer.query('COMMIT');
            const result = await compute;
            assertComputed(result);
            assert.equal(result.snapshot.states.view!.count, '2');
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
        },
      );
      await t.test(
        'concurrent reporting and capture return all-before snapshot, then all settled after, never partial ready',
        async () => {
          const post = await f.publish(author),
            reached = gate(),
            resume = gate();
          const original = f.repository.snapshot.bind(f.repository);
          f.repository.snapshot = async (id, tx) => {
            if (id === post.id) {
              reached.release();
              await resume.promise;
            }
            return original(id, tx);
          };
          try {
            const compute = f.service.inspect(post.id, 'compute');
            await reached.promise;
            const writers = [
              f.like(actor, post.id),
              f.save(actor, post.id),
              f.root(actor, post.id),
              f.view(actor, [post.id]),
            ];
            // Start supertest's lazy thenable too, while the actual parent is locked.
            const pending = Promise.all(writers.map((w) => Promise.resolve(w)));
            await f.waitForLock('whaleu_community.posts');
            resume.release();
            const before = await compute;
            assertComputed(before);
            assert.equal(before.score, '0.0000');
            assert.equal(before.snapshot.states.view!.count, '0');
            await pending;
            f.repository.snapshot = original;
            assert.equal(
              (await f.service.inspect(post.id, 'compute')).status,
              'blockedFreshness',
            );
            await f.settleAll(post.id);
            const after = await f.service.inspect(post.id, 'compute');
            assertComputed(after);
            assert.equal(after.snapshot.states.view!.count, '1');
            assert.deepEqual(after.snapshot.states.subscription!.counts, ['1']);
            assert.deepEqual(after.snapshot.states.like!.counts, ['1']);
            assert.deepEqual(after.snapshot.states.comment!.counts, [
              '1',
              '0',
              '1',
              '1',
            ]);
          } finally {
            resume.release();
            f.repository.snapshot = original;
          }
        },
      );
      await t.test(
        'advisory dry-run is an actual read-only transaction without mutation locks even when all rows are locked elsewhere',
        async () => {
          const post = await f.publish(author),
            holder = await f.pool.connect(),
            observed = observeViewQueries(f.app);
          const settings: string[] = [],
            statements: string[] = [];
          observed.setHook(async ({ sql }, tx) => {
            statements.push(sql);
            if (sql === 'SET TRANSACTION READ ONLY')
              settings.push(
                (
                  await tx.query(
                    "SELECT current_setting('transaction_read_only') value",
                  )
                ).rows[0]!.value,
              );
          });
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [post.id],
            );
            for (const component of components)
              await holder.query(
                `SELECT post_id FROM whaleu_post_hotness.${component}_states WHERE post_id=$1 FOR UPDATE`,
                [post.id],
              );
            const before = await f.snapshot();
            const result = await f.service.inspect(post.id);
            assertComputed(result);
            assert.equal(result.advisory, true);
            assert.deepEqual(settings, ['on']);
            assert.equal(
              statements.some((s) =>
                /FOR (UPDATE|SHARE|KEY SHARE|NO KEY UPDATE)/.test(s),
              ),
              false,
            );
            assert.deepEqual(await f.snapshot(), before);
          } finally {
            observed.restore();
            await holder.query('ROLLBACK');
            holder.release();
          }
        },
      );
      await t.test(
        'bounded failed state lock rolls back parent and earlier state locks; unsupported inverse writer cannot hang',
        async () => {
          const post = await f.publish(author),
            holder = await f.pool.connect(),
            probe = await f.pool.connect();
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT post_id FROM whaleu_post_hotness.view_states WHERE post_id=$1 FOR UPDATE',
              [post.id],
            );
            const before = await f.snapshot(),
              started = Date.now();
            const failed = await f.service.inspect(post.id, 'compute');
            assert.equal(failed.status, 'failed');
            assert.ok(
              Date.now() - started < 4000,
              'Owner lock_timeout bounds unsupported inverse lock order',
            );
            assert.ok(!('score' in failed));
            await probe.query('BEGIN');
            await probe.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE NOWAIT',
              [post.id],
            );
            for (const component of ['subscription', 'like', 'comment'])
              await probe.query(
                `SELECT post_id FROM whaleu_post_hotness.${component}_states WHERE post_id=$1 FOR UPDATE NOWAIT`,
                [post.id],
              );
            await probe.query('ROLLBACK');
            assert.deepEqual(await f.snapshot(), before);
            await holder.query('ROLLBACK');
            assert.equal(
              (await f.service.inspect(post.id, 'compute')).status,
              'computed',
            );
            await sleep(1);
          } finally {
            await holder.query('ROLLBACK');
            await probe.query('ROLLBACK');
            holder.release();
            probe.release();
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);
