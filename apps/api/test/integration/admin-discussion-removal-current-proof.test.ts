import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient, QueryResult } from 'pg';
import { DatabaseService } from '../../src/database/database.js';
import { requiredOwnerEpoch } from '../../src/database/required-owner-proof.js';
import { communityCountProofOwner } from '../../src/community/count-epochs.js';
import { adminDiscussionRemovalFixture } from '../support/admin-discussion-removal-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';

type Query = (sql: string, values?: unknown[]) => Promise<QueryResult>;
test(
  'discussion current proofs retain every original owner fact and reject faults, same-value, zero-row, ABA and post-flush late DML',
  { timeout: 300000 },
  async (t) => {
    const f = await adminDiscussionRemovalFixture(true);
    t.after(() => f.close());
    const admin = await f.actor(),
      author = await f.actor();
    await f.grant(admin);
    const database = f.moderationApp.get(DatabaseService);
    for (const kind of ['comment', 'reply'] as const) {
      const post = await f.publish(author, {}, true),
        root = await f.discussion(author, post.id, { images: true }),
        reply = await f.discussion(author, post.id, {
          rootId: root.id,
          images: true,
        });
      const target = kind === 'comment' ? root : reply,
        table = kind === 'comment' ? 'root_comments' : 'replies';
      const selected = await f.removalManagement(target, admin);
      const snapshot = async () =>
        (
          await f.pool.query(`SELECT jsonb_build_object(
      'posts',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM whaleu_community.posts p),
      'roots',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM whaleu_community.root_comments p),
      'replies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM whaleu_community.replies p),
      'commands',(SELECT jsonb_agg(to_jsonb(q) ORDER BY actor_id,request_id) FROM whaleu_community.admin_discussion_removal_commands q),
      'events',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM whaleu_community.admin_discussion_removal_events q),
      'sources',(SELECT jsonb_agg(to_jsonb(q) ORDER BY source_sequence) FROM whaleu_post_hotness.comment_sources q),
      'states',(SELECT jsonb_agg(to_jsonb(q) ORDER BY post_id) FROM whaleu_post_hotness.comment_states q),
      'jobs',(SELECT jsonb_agg(to_jsonb(q) ORDER BY id) FROM whaleu_community.media_cleanup_jobs q),
      'epochs',(SELECT jsonb_agg(to_jsonb(q) ORDER BY slot) FROM whaleu_community.discovery_count_epochs q),
      'media',(SELECT jsonb_agg(to_jsonb(q) ORDER BY slot) FROM whaleu_media.media_owner_states q),
      'pins',(SELECT jsonb_agg(to_jsonb(q) ORDER BY post_id) FROM whaleu_community.comment_pins q),
      'outbox',(SELECT jsonb_agg(to_jsonb(q) ORDER BY event_key) FROM whaleu_community.outbox q)) value`)
        ).rows[0]!.value;
      const baseline = await snapshot();
      const inject = async (
        hook: (
          sql: string,
          values: unknown[] | undefined,
          query: Query,
        ) => Promise<void>,
        before?: (tx: PoolClient) => Promise<unknown>,
      ) => {
        const original = database.transaction,
          run = original.bind(database);
        database.transaction = (work, options) => {
          let restore = () => {};
          return run(async (tx) => {
            if (before) await before(tx);
            const raw = tx.query,
              query = raw.bind(tx) as Query;
            tx.query = (async (sql: string, values?: unknown[]) => {
              const result = await query(sql, values);
              await hook(sql, values, query);
              return result;
            }) as PoolClient['query'];
            restore = () => {
              tx.query = raw;
            };
            return work(tx);
          }, options).finally(() => restore());
        };
        try {
          const response = await f.removalSend(
            admin,
            f.removalCommand(target, selected.targetVersion),
          );
          assert.notEqual(response.status, 200, JSON.stringify(response.body));
        } finally {
          database.transaction = original;
        }
        assert.deepEqual(await snapshot(), baseline);
      };
      await t.test(
        `${kind}: unrelated pre-existing strict epoch cannot be erased`,
        () =>
          inject(
            async () => {},
            (tx) =>
              requiredOwnerEpoch(
                communityCountProofOwner,
                'COMMUNITY_UNAVAILABLE',
              )(tx),
          ),
      );
      await t.test(
        `${kind}: before-wait selected tuple same-value and ancestor ABA are retained`,
        async () => {
          for (const sql of [
            `UPDATE whaleu_community.${table} SET text=text WHERE id=$1`,
            `UPDATE whaleu_community.posts SET text=text WHERE id=$1`,
          ]) {
            let reached = false;
            await inject(async (statement, _values, query) => {
              if (
                !reached &&
                statement.startsWith(
                  'SELECT whaleu_community.admin_discussion_removal_input_facts',
                )
              ) {
                reached = true;
                await query(sql, [sql.includes('posts') ? post.id : target.id]);
              }
            });
            assert.ok(reached);
          }
        },
      );
      for (const stage of [
        'INSERT INTO whaleu_community.admin_discussion_removal_commands',
        `UPDATE whaleu_community.${table}`,
        'INSERT INTO whaleu_community.admin_discussion_removal_events',
        'INSERT INTO whaleu_community.outbox',
        'SELECT whaleu_community.admin_discussion_removal_assert_complete',
      ]) {
        await t.test(`${kind}: atomic rollback after ${stage}`, async () => {
          let reached = false;
          await inject(async (sql, _values, query) => {
            if (!reached && sql.includes(stage)) {
              reached = true;
              await query('SELECT 1/0');
            }
          });
          assert.ok(reached, stage);
        });
      }
      const late = [
        `UPDATE whaleu_community.${table} SET text=text WHERE false`,
        `UPDATE whaleu_community.${table} SET text=text WHERE id='${target.id}'`,
        `UPDATE whaleu_community.posts SET text=text WHERE id='${post.id}'`,
        `UPDATE whaleu_community.root_comments SET text=text WHERE id='${root.id}'`,
        'UPDATE whaleu_community.content_approval_heads SET event_id=event_id WHERE false',
        'UPDATE whaleu_community.post_category_heads SET event_id=event_id WHERE false',
        'UPDATE whaleu_community.post_owner_visibility SET owner_hidden=owner_hidden WHERE false',
        'UPDATE whaleu_safety.account_heads SET actions_allowed=actions_allowed WHERE false',
        'UPDATE whaleu_media.bindings SET detached_at=detached_at WHERE false',
        'UPDATE whaleu_verification.account_heads SET revision=revision WHERE false',
        'UPDATE whaleu_authorization.role_grants SET revoked_at=revoked_at WHERE false',
        'UPDATE whaleu_post_hotness.comment_states SET root_count=root_count WHERE false',
        'DELETE FROM whaleu_community.comment_pins WHERE false',
        'UPDATE whaleu_community.media_cleanup_jobs SET phase=phase WHERE false',
        'UPDATE whaleu_community.outbox SET context=context WHERE false',
      ];
      for (const sql of late)
        await t.test(`${kind}: immediate closure then ${sql}`, async () => {
          let reached = false;
          await inject(async (statement, _values, query) => {
            if (
              !reached &&
              statement.includes('INSERT INTO whaleu_community.outbox')
            ) {
              reached = true;
              await query('SET CONSTRAINTS ALL IMMEDIATE');
              await query(sql);
            }
          });
          assert.ok(reached, sql);
        });
      // The final valid path also proves the fault tests did not manufacture history.
      const success = await f.removalSend(
        admin,
        f.removalCommand(target, selected.targetVersion),
      );
      profileOk(success);
      assert.equal(success.body.outcome, 'applied');
      for (const sql of [
        `UPDATE whaleu_community.${table} SET deleted_at=NULL WHERE id=$1`,
        `UPDATE whaleu_community.${table} SET deleted_at=deleted_at+interval '1 millisecond' WHERE id=$1`,
        `UPDATE whaleu_community.${table} SET local_deletion_transaction=pg_current_xact_id() WHERE id=$1`,
        `DELETE FROM whaleu_community.${table} WHERE id=$1`,
      ])
        await assert.rejects(f.pool.query(sql, [target.id]));
      const sibling = await f.discussion(author, post.id);
      assert.ok(
        sibling.id,
        'Retained cause does not freeze unrelated later sibling publication',
      );
    }
  },
);
