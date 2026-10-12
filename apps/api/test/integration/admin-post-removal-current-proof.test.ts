import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import type { PoolClient, QueryResult } from 'pg';
import { DatabaseService } from '../../src/database/database.js';
import { requiredOwnerEpoch } from '../../src/database/required-owner-proof.js';
import { communityCountProofOwner } from '../../src/community/count-epochs.js';
import { adminPostRemovalFixture } from '../support/admin-post-removal-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';

type Query = (sql: string, values?: unknown[]) => Promise<QueryResult>;
test(
  'administrative tombstone retains original and outside facts and fails closed for actual queued authority writers',
  { timeout: 240000 },
  async (t) => {
    const f = await adminPostRemovalFixture(true);
    t.after(() => f.close());
    const admin = await f.actor(),
      subject = await f.actor();
    const grant = await f.grant(admin),
      post = await f.publish(subject, {}, true);
    const database = f.moderationApp.get(DatabaseService);
    const selected = await f.removalManagement(post, admin);
    const snapshot = async () =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object(
    'post',(SELECT to_jsonb(p) FROM whaleu_community.posts p WHERE id=$1),
    'bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM whaleu_media.bindings b),
    'commands',(SELECT count(*) FROM whaleu_community.admin_post_removal_commands),
    'events',(SELECT count(*) FROM whaleu_community.admin_post_removal_events),
    'notices',(SELECT count(*) FROM whaleu_notifications.admin_post_removal_notices),
    'jobs',(SELECT count(*) FROM whaleu_community.media_cleanup_jobs)) value`,
          [post.id],
        )
      ).rows[0]!.value;
    const before = await snapshot();
    const injected = async (
      hook: (
        sql: string,
        values: unknown[] | undefined,
        query: Query,
      ) => Promise<void>,
      beforeWork?: (tx: PoolClient) => Promise<void>,
    ) => {
      const original = database.transaction,
        run = original.bind(database);
      database.transaction = (work, options) =>
        run(async (tx) => {
          if (beforeWork) await beforeWork(tx);
          const raw = tx.query,
            query = raw.bind(tx) as Query;
          tx.query = (async (sql: string, values?: unknown[]) => {
            const result = await query(sql, values);
            await hook(sql, values, query);
            return result;
          }) as PoolClient['query'];
          try {
            return await work(tx);
          } finally {
            tx.query = raw;
          }
        }, options);
      try {
        const response = await f.removalSend(
          admin,
          f.removalCommand(post, selected.targetVersion),
        );
        assert.notEqual(response.status, 200, JSON.stringify(response.body));
      } finally {
        database.transaction = original;
      }
      assert.deepEqual(await snapshot(), before);
    };
    await t.test(
      'an ordinary pre-existing Community proof is never removed or rebased by this mutation',
      async () => {
        await injected(
          async () => {},
          async (tx) => {
            await requiredOwnerEpoch(
              communityCountProofOwner,
              'COMMUNITY_UNAVAILABLE',
            )(tx);
          },
        );
      },
    );
    await t.test(
      'pre-lock source same-value tuple change cannot replace the initial exact facts',
      async () => {
        let changed = false;
        await injected(async (sql, _values, query) => {
          if (
            !changed &&
            sql.startsWith(
              'SELECT whaleu_community.admin_post_removal_input_facts',
            )
          ) {
            changed = true;
            assert.equal(
              (
                await query(
                  'UPDATE whaleu_community.posts SET text=text WHERE id=$1',
                  [post.id],
                )
              ).rowCount,
              1,
            );
          }
        });
        assert.equal(changed, true);
      },
    );
    await t.test(
      'late raw source and zero-row writes remain forbidden after early constraint flushing',
      async () => {
        for (const sql of [
          'UPDATE whaleu_community.posts SET text=text WHERE false',
          'UPDATE whaleu_community.posts SET text=text WHERE id=$1',
          'UPDATE whaleu_media.bindings SET detached_at=detached_at WHERE false',
          'UPDATE whaleu_safety.account_heads SET actions_allowed=actions_allowed WHERE false',
          'UPDATE whaleu_profile.profiles SET revision=revision WHERE false',
        ]) {
          let changed = false;
          await injected(async (statement, _values, query) => {
            if (
              !changed &&
              statement.startsWith(
                'INSERT INTO whaleu_notifications.admin_post_removal_notices',
              )
            ) {
              changed = true;
              await query('SET CONSTRAINTS ALL IMMEDIATE');
              await query(sql, sql.includes('$1') ? [post.id] : []);
            }
          });
          assert.equal(changed, true);
        }
      },
    );
    await t.test(
      'actual grant revocation queued behind the reader rejects the whole tentative removal',
      async () => {
        const writer = await f.pool.connect();
        let update: Promise<QueryResult> | undefined,
          queued = false;
        try {
          await writer.query('BEGIN');
          const pid = (await writer.query('SELECT pg_backend_pid() pid'))
            .rows[0]!.pid;
          await injected(async (sql) => {
            if (
              !queued &&
              sql.startsWith(
                'INSERT INTO whaleu_notifications.admin_post_removal_notices',
              )
            ) {
              queued = true;
              update = writer.query(
                'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
                [grant],
              );
              const until = performance.now() + 1000;
              while (performance.now() < until) {
                if (
                  (
                    await f.pool.query(
                      "SELECT wait_event_type='Lock' waiting FROM pg_stat_activity WHERE pid=$1",
                      [pid],
                    )
                  ).rows[0]?.waiting
                )
                  return;
                await sleep(5);
              }
              throw Error('The real grant writer did not queue');
            }
          });
        } finally {
          if (update) await update;
          await writer.query('ROLLBACK');
          writer.release();
        }
        assert.equal(queued, true);
      },
    );
    await t.test(
      'a live independent zero-row Community writer invalidates the fixed owner vector',
      async () => {
        const writer = await f.pool.connect();
        let started = false;
        try {
          await writer.query('BEGIN');
          await injected(async (sql) => {
            if (
              !started &&
              sql.startsWith(
                'INSERT INTO whaleu_notifications.admin_post_removal_notices',
              )
            ) {
              started = true;
              await writer.query(
                'UPDATE whaleu_community.posts SET text=text WHERE false',
              );
            }
          });
        } finally {
          await writer.query('ROLLBACK');
          writer.release();
        }
        assert.equal(started, true);
      },
    );
    const applied = await f.removalSend(
      admin,
      f.removalCommand(post, selected.targetVersion),
    );
    profileOk(applied);
    assert.equal(applied.body.outcome, 'applied');
    assert.ok(
      (
        await f.pool.query(
          'SELECT local_deletion_transaction::text stamp FROM whaleu_community.posts WHERE id=$1',
          [post.id],
        )
      ).rows[0]!.stamp,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_community.admin_post_removal_commands',
        )
      ).rows[0]!.n,
      1,
    );
    const unknown = await f.removalRecovery(admin, randomUUID());
    profileOk(unknown);
    assert.deepEqual(unknown.body, { state: 'not_recorded' });
  },
);
