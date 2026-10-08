import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SubscriptionComponentWorker } from '../../src/community/subscription-component/worker.js';
import { subscriptionFixture } from '../support/subscription-component-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

test(
  'subscription component: real HTTP publication, causal replay, concurrent workers and atomic rollback',
  { timeout: 120000 },
  async (t) => {
    const f = await subscriptionFixture();
    try {
      const author = await f.actor(),
        a = await f.actor(),
        b = await f.actor();
      const worker = f.app.get(SubscriptionComponentWorker);
      const run = (...obligationIds: string[]) =>
        worker.run({ mode: 'apply', obligationIds });
      const state = async (postId: string) =>
        (
          await f.pool.query(
            'SELECT * FROM whaleu_post_hotness.subscription_states WHERE post_id=$1',
            [postId],
          )
        ).rows[0];
      await t.test(
        'fresh normal publication enrolls once; rejected publication and hook failure do not enroll',
        async () => {
          const p = await f.publish(author);
          const initial = await state(p.id);
          assert.equal(initial.count, '0');
          assert.equal(initial.last_sequence, '0');
          const baseline = (
            await f.pool.query(
              'SELECT * FROM whaleu_post_hotness.subscription_baselines WHERE post_id=$1',
              [p.id],
            )
          ).rows;
          assert.equal(baseline.length, 1);
          assert.equal(baseline[0].opening_count, '0');
          assert.deepEqual(
            (await f.publication(author, p.body).expect(201)).body,
            p.receipt,
          );
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT * FROM whaleu_post_hotness.subscription_baselines WHERE post_id=$1',
                [p.id],
              )
            ).rows,
            baseline,
          );
          const rejected = f.intent('Synthetic unapproved subscription post');
          await f.approve(author, rejected, 'reject');
          const rejection = await f.publication(author, rejected).expect(201);
          assert.equal(rejection.body.outcome, 'rejected');
          const body = f.intent('Synthetic enrollment rollback');
          await f.approve(author, body);
          await f.pool.query(
            `CREATE FUNCTION whaleu_maintenance_test.fail_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic enrollment interruption'; END $$; CREATE TRIGGER synthetic_enrollment_failure BEFORE INSERT ON whaleu_post_hotness.subscription_baselines FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.fail_enrollment()`,
          );
          try {
            await f.publication(author, body).expect(500);
          } finally {
            await f.pool.query(
              'DROP TRIGGER synthetic_enrollment_failure ON whaleu_post_hotness.subscription_baselines; DROP FUNCTION whaleu_maintenance_test.fail_enrollment()',
            );
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.publication_requests WHERE client_request_id=$1',
                [body.clientRequestId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.report_origins WHERE source_request_id=$1',
                [body.clientRequestId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.posts WHERE text=$1',
                [body.text],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'ended positive, negative and resave replay in numeric sequence; duplicate workers and self save are exactly once',
        async () => {
          const p = await f.publish(author);
          await f.pool.query(
            "SELECT setval('whaleu_community.discussion_sequence',9007199254740993,false)",
          );
          await f.save(a, p.id);
          await f.save(a, p.id, false);
          await f.save(a, p.id);
          await f.save(b, p.id);
          await f.save(author, p.id);
          const ids = await f.obligations(p.id);
          assert.equal(ids.length, 5);
          assert.equal(ids[0]!.source_sequence, '9007199254740993');
          const before = await f.snapshot();
          assert.equal((await run(ids[1]!.id)).blockedPredecessor, 1);
          assert.deepEqual(
            await f.snapshot(),
            before,
            'out-of-order negative is strictly read-only',
          );
          const duplicates = await Promise.all([
            run(ids[0]!.id),
            run(ids[0]!.id),
          ]);
          assert.equal(
            duplicates.reduce((n, r) => n + r.applied, 0),
            1,
          );
          assert.equal(
            duplicates.reduce((n, r) => n + r.alreadyCompleted, 0),
            1,
          );
          assert.equal((await state(p.id)).count, '1');
          for (const id of ids.slice(1))
            assert.equal((await run(id.id)).applied, 1);
          assert.equal((await state(p.id)).count, '3');
          assert.equal(
            (await state(p.id)).last_sequence,
            ids[4]!.source_sequence,
          );
          const after = await f.snapshot();
          assert.equal((await run(ids[4]!.id)).alreadyCompleted, 1);
          assert.deepEqual(
            await f.snapshot(),
            after,
            'retry after lost response is read-only',
          );
          for (const [key, value] of Object.entries(before))
            if (
              key.startsWith('whaleu_experience.') ||
              key.includes('reward_source_')
            )
              assert.deepEqual(
                after[key],
                value,
                `${key} must remain unchanged`,
              );
          const siblings = (
            await f.pool.query(
              "SELECT status FROM whaleu_community.saved_obligations o JOIN whaleu_community.saved_epochs e ON e.id=o.epoch_id WHERE e.post_id=$1 AND action<>'save_ranking'",
              [p.id],
            )
          ).rows;
          assert.ok(siblings.length > 0);
          assert.ok(siblings.every((r) => r.status === 'pending'));
        },
      );
      await t.test(
        'failure at receipt, state, membership and acknowledgement rolls back and remains retryable',
        async () => {
          for (const target of [
            'subscription_receipts',
            'subscription_states',
            'subscription_memberships',
            'saved_obligations',
          ]) {
            const p = await f.publish(author);
            await f.save(a, p.id);
            const id = (await f.obligations(p.id))[0]!.id;
            const before = await f.snapshot();
            const schema =
              target === 'saved_obligations'
                ? 'whaleu_community'
                : 'whaleu_post_hotness';
            const event =
              target === 'subscription_receipts' ||
              target === 'subscription_memberships'
                ? 'INSERT'
                : 'UPDATE';
            await f.pool.query(
              `CREATE FUNCTION whaleu_maintenance_test.fail_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic effect interruption'; END $$; CREATE TRIGGER synthetic_effect_failure BEFORE ${event} ON ${schema}.${target} FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.fail_effect()`,
            );
            try {
              assert.equal((await run(id)).failed, 1);
            } finally {
              await f.pool.query(
                `DROP TRIGGER synthetic_effect_failure ON ${schema}.${target}; DROP FUNCTION whaleu_maintenance_test.fail_effect()`,
              );
            }
            assert.deepEqual(
              await f.snapshot(),
              before,
              `atomic rollback at ${target}`,
            );
            assert.equal((await run(id)).applied, 1);
            assert.equal((await state(p.id)).count, '1');
          }
        },
      );
      await t.test(
        'hidden and deleted cleanup remain causal and do not discard captured positives',
        async () => {
          for (const deleted of [false, true]) {
            const p = await f.publish(author);
            await f.save(a, p.id);
            if (deleted) await f.deletePost(author, p.id);
            else
              await withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(
                  "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
                  [p.id],
                ),
              );
            await f.save(a, p.id, false, true);
            for (const row of await f.obligations(p.id))
              assert.equal((await run(row.id)).applied, 1);
            assert.equal((await state(p.id)).count, '0');
          }
        },
      );
      await t.test(
        'parent-first worker waits safely while real unsave races the same parent',
        async () => {
          const p = await f.publish(author);
          await f.save(a, p.id);
          const first = (await f.obligations(p.id))[0]!.id;
          const holder = await f.pool.connect();
          await holder.query('BEGIN');
          await holder.query(
            'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
            [p.id],
          );
          let processing: ReturnType<typeof run> | undefined;
          let unsaving: ReturnType<typeof f.save> | undefined;
          try {
            processing = run(first);
            await f.waitForLock('SELECT id FROM whaleu_community.posts');
            await holder.query(
              'SELECT id FROM whaleu_community.saved_obligations WHERE id=$1 FOR UPDATE NOWAIT',
              [first],
            );
            await holder.query(
              'SELECT post_id FROM whaleu_post_hotness.subscription_states WHERE post_id=$1 FOR UPDATE NOWAIT',
              [p.id],
            );
            unsaving = f.save(a, p.id, false);
            await holder.query('COMMIT');
            assert.equal((await processing).applied, 1);
            await unsaving;
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
          }
          const negative = (await f.obligations(p.id))[1]!.id;
          assert.equal((await run(negative)).applied, 1);
          assert.equal((await state(p.id)).count, '0');
        },
      );
      await t.test(
        'raw unknown first selection does not enroll or starve a later known post',
        async () => {
          const raw = await f.rawUnknown(author);
          await f.save(a, raw);
          const unknown = (await f.obligations(raw))[0]!.id;
          const p = await f.publish(author);
          await f.save(a, p.id);
          const result = await run(unknown, (await f.obligations(p.id))[0]!.id);
          assert.equal(result.blockedBaseline, 1);
          assert.equal(result.applied, 1);
          assert.equal(await state(raw), undefined);
          assert.equal(
            (
              await f.pool.query(
                'SELECT status FROM whaleu_community.saved_obligations WHERE id=$1',
                [unknown],
              )
            ).rows[0].status,
            'pending',
          );
        },
      );
      await t.test(
        'missing first selection cannot starve later known post',
        async () => {
          const p = await f.publish(author);
          await f.save(a, p.id);
          const result = await run(
            randomUUID(),
            (await f.obligations(p.id))[0]!.id,
          );
          assert.equal(result.missing, 1);
          assert.equal(result.applied, 1);
        },
      );
    } finally {
      await f.close();
    }
  },
);
