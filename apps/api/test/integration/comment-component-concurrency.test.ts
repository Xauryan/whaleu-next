import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { CommentComponentWorker } from '../../src/community/comment-component/worker.js';
import { LikeComponentWorker } from '../../src/community/like-component/worker.js';
import { commentFixture } from '../support/comment-component-fixture.js';

const sqlCode =
  (...codes: string[]) =>
  (error: unknown) =>
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    codes.includes(String(error.code));
test(
  'comment component: parent-first concurrency, kind-scoped identity, exact atomic effects and bigint causality',
  { timeout: 180000 },
  async (t) => {
    const f = await commentFixture();
    try {
      const author = await f.actor(),
        a = await f.actor(),
        b = await f.actor();
      const worker = f.app.get(CommentComponentWorker),
        run = (...sourceIds: string[]) =>
          worker.run({ mode: 'apply', sourceIds });
      const rawRoot = (
        tx: PoolClient,
        post: string,
        actor = a.accountId,
        id = randomUUID(),
      ) =>
        tx.query(
          "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,'Synthetic raw component root','named')",
          [id, post, actor],
        );
      const rawReply = (
        tx: PoolClient,
        post: string,
        root: string,
        actor = a.accountId,
        id = randomUUID(),
      ) =>
        tx.query(
          "INSERT INTO whaleu_community.replies(id,post_id,root_comment_id,account_id,text,author_mode) VALUES($1,$2,$3,$4,'Synthetic raw component reply','named')",
          [id, post, root, actor],
        );
      await t.test(
        'same post public writers serialize, multi-content same account gives one unique member',
        async () => {
          const p = await f.publish(author),
            roots = await Promise.all([
              f.root(a, p.id),
              f.root(a, p.id, 'anonymous'),
              f.root(b, p.id),
            ]);
          await Promise.all([
            f.reply(a, p.id, roots[0]!.id),
            f.reply(b, p.id, roots[1]!.id),
            f.reply(author, p.id, roots[2]!.id),
          ]);
          const rows = await f.sources(p.id);
          assert.equal(rows.length, 6);
          for (const row of rows) assert.equal((await run(row.id)).applied, 1);
          assert.deepEqual(await f.counts(p.id), ['3', '3', '5', '2']);
        },
      );
      await t.test(
        'root and reply with same UUID are independent contributions and negatives cannot consume another child',
        async () => {
          const p = await f.publish(author),
            same = randomUUID();
          await inTransaction(f.pool, async (tx) => {
            await tx.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [p.id],
            );
            await rawRoot(tx, p.id, a.accountId, same);
            await rawReply(tx, p.id, same, a.accountId, same);
          });
          let rows = await f.sources(p.id);
          assert.equal(rows.length, 2);
          assert.equal(rows[0]!.content_id, rows[1]!.content_id);
          assert.notEqual(rows[0]!.kind, rows[1]!.kind);
          for (const row of rows) assert.equal((await run(row.id)).applied, 1);
          assert.deepEqual(await f.counts(p.id), ['1', '1', '2', '1']);
          await inTransaction(f.pool, async (tx) => {
            await tx.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [p.id],
            );
            await tx.query(
              'UPDATE whaleu_community.root_comments SET deleted_at=clock_timestamp() WHERE id=$1',
              [same],
            );
          });
          rows = await f.sources(p.id);
          assert.equal((await run(rows[2]!.id)).applied, 1);
          assert.deepEqual(await f.counts(p.id), ['0', '1', '1', '1']);
          const contributions = (
            await f.pool.query(
              'SELECT kind,active FROM whaleu_post_hotness.comment_contributions WHERE post_id=$1 ORDER BY kind',
              [p.id],
            )
          ).rows;
          assert.deepEqual(contributions, [
            { kind: 'reply', active: true },
            { kind: 'root', active: false },
          ]);
        },
      );
      await t.test(
        'direct insert and tombstone update fail fast while parent locked, then succeed after ordered retry',
        async () => {
          const p = await f.publish(author),
            root = await f.root(a, p.id);
          const holder = await f.pool.connect(),
            writer = await f.pool.connect();
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [p.id],
            );
            for (const action of [
              () => rawRoot(writer, p.id, b.accountId),
              () => rawReply(writer, p.id, root.id, b.accountId),
              () =>
                writer.query(
                  'UPDATE whaleu_community.root_comments SET deleted_at=clock_timestamp() WHERE id=$1',
                  [root.id],
                ),
            ]) {
              await writer.query('BEGIN');
              await writer.query("SET LOCAL statement_timeout='2s'");
              await assert.rejects(action(), sqlCode('55P03'));
              await writer.query('ROLLBACK');
            }
            const processing = run((await f.sources(p.id))[0]!.id);
            await f.waitForLock('SELECT id FROM whaleu_community.posts');
            await holder.query(
              'SELECT post_id FROM whaleu_post_hotness.comment_states WHERE post_id=$1 FOR UPDATE NOWAIT',
              [p.id],
            );
            await holder.query(
              'SELECT id FROM whaleu_community.root_comments WHERE id=$1 FOR UPDATE NOWAIT',
              [root.id],
            );
            await holder.query('COMMIT');
            assert.equal((await processing).applied, 1);
            await writer.query('BEGIN');
            await writer.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [p.id],
            );
            await writer.query(
              'UPDATE whaleu_community.root_comments SET deleted_at=clock_timestamp() WHERE id=$1',
              [root.id],
            );
            await writer.query('COMMIT');
            assert.equal(
              (await run((await f.sources(p.id))[1]!.id)).applied,
              1,
            );
            assert.deepEqual(await f.counts(p.id), ['0', '0', '0', '0']);
          } finally {
            await holder.query('ROLLBACK');
            await writer.query('ROLLBACK');
            holder.release();
            writer.release();
          }
        },
      );
      await t.test(
        'settlement reads immutable evidence without waiting on live child, account, safety, outbox or unrelated component state',
        async () => {
          const p = await f.publish(author),
            root = await f.root(a, p.id),
            id = (await f.sources(p.id))[0]!.id;
          const holder = await f.pool.connect();
          try {
            await holder.query('BEGIN');
            await lockSafetyPolicy(holder, true);
            await holder.query(
              'SELECT id FROM whaleu_community.root_comments WHERE id=$1 FOR UPDATE',
              [root.id],
            );
            await holder.query(
              'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR UPDATE',
              [a.accountId],
            );
            await holder.query(
              'SELECT post_id FROM whaleu_post_hotness.like_states WHERE post_id=$1 FOR UPDATE',
              [p.id],
            );
            await holder.query(
              'SELECT id FROM whaleu_community.outbox WHERE resource_id=$1 FOR UPDATE',
              [root.id],
            );
            const result = await Promise.race([
              run(id),
              new Promise<never>((_, reject) => {
                const timer = setTimeout(
                  () =>
                    reject(
                      new Error('Worker waited on unrelated/live row locks'),
                    ),
                  3000,
                );
                timer.unref();
              }),
            ]);
            assert.equal(result.applied, 1);
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
          }
        },
      );
      await t.test(
        'duplicate selected-source claims and lost response apply one exact effect',
        async () => {
          const p = await f.publish(author);
          await f.root(a, p.id);
          const id = (await f.sources(p.id))[0]!.id;
          const before = await f.snapshot(),
            results = await Promise.all([run(id), run(id), run(id)]);
          assert.equal(
            results.reduce((n, r) => n + r.applied, 0),
            1,
          );
          assert.equal(
            results.reduce((n, r) => n + r.alreadyCompleted, 0),
            2,
          );
          const after = await f.snapshot();
          for (const [key, value] of Object.entries(before))
            if (!key.startsWith('whaleu_post_hotness.comment_'))
              assert.deepEqual(after[key], value, key);
          assert.equal((await run(id)).alreadyCompleted, 1);
          assert.deepEqual(await f.snapshot(), after);
        },
      );
      await t.test(
        'receipt, state, contribution, membership and deferred interruption roll back every effect',
        async () => {
          for (const [target, event, deferred] of [
            ['comment_receipts', 'INSERT', false],
            ['comment_states', 'UPDATE', false],
            ['comment_contributions', 'INSERT', false],
            ['comment_memberships', 'INSERT', false],
            ['comment_receipts', 'INSERT', true],
          ] as const) {
            const p = await f.publish(author);
            await f.root(a, p.id);
            const id = (await f.sources(p.id))[0]!.id,
              before = await f.snapshot();
            await f.pool.query(
              `CREATE FUNCTION whaleu_maintenance_test.fail_comment_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic effect interruption'; END $$; CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER synthetic_comment_failure ${deferred ? 'AFTER' : 'BEFORE'} ${event} ON whaleu_post_hotness.${target} ${deferred ? 'DEFERRABLE INITIALLY DEFERRED' : ''} FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.fail_comment_effect()`,
            );
            try {
              assert.equal((await run(id)).failed, 1);
            } finally {
              await f.pool.query(
                `DROP TRIGGER synthetic_comment_failure ON whaleu_post_hotness.${target}; DROP FUNCTION whaleu_maintenance_test.fail_comment_effect()`,
              );
            }
            assert.deepEqual(await f.snapshot(), before);
            assert.equal((await run(id)).applied, 1);
          }
        },
      );
      await t.test(
        'huge source positions and aborted gaps stay numeric; later selection cannot skip old source',
        async () => {
          const p = await f.publish(author);
          await f.pool.query(
            "SELECT setval('whaleu_post_hotness.comment_source_sequence',9007199254740993,false)",
          );
          const tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [p.id],
            );
            await rawRoot(tx, p.id);
            await tx.query('ROLLBACK');
          } finally {
            tx.release();
          }
          const first = await f.root(a, p.id);
          await f.deleteContent(a, 'root', first.id).expect(204);
          await f.root(a, p.id);
          const rows = await f.sources(p.id);
          assert.equal(rows[0]!.source_sequence, '9007199254740994');
          assert.equal((await run(rows[2]!.id)).blockedPredecessor, 1);
          for (const row of rows) assert.equal((await run(row.id)).applied, 1);
          assert.equal(
            (await f.state(p.id))!.last_sequence,
            rows[2]!.source_sequence,
          );
          assert.deepEqual(await f.counts(p.id), ['1', '0', '1', '1']);
        },
      );
      await t.test(
        'blocked or missing selection does not starve another post or interfere with another component',
        async () => {
          const p = await f.publish(author),
            q = await f.publish(author),
            r = await f.root(a, p.id);
          await f.deleteContent(a, 'root', r.id).expect(204);
          await f.root(a, q.id);
          const blocked = (await f.sources(p.id))[1]!.id,
            ready = (await f.sources(q.id))[0]!.id;
          const result = await run(randomUUID(), blocked, ready);
          assert.equal(result.missing, 1);
          assert.equal(result.blockedPredecessor, 1);
          assert.equal(result.applied, 1);
          await inTransaction(f.pool, async (tx) => {
            await tx.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [p.id],
            );
            await tx.query(
              'INSERT INTO whaleu_community.post_likes(post_id,account_id) VALUES($1,$2)',
              [p.id, a.accountId],
            );
          });
          const like = (
            await f.pool.query(
              'SELECT id FROM whaleu_post_hotness.like_sources WHERE post_id=$1',
              [p.id],
            )
          ).rows[0]!.id;
          const [comments, likes] = await Promise.all([
            run((await f.sources(p.id))[0]!.id),
            f.app
              .get(LikeComponentWorker)
              .run({ mode: 'apply', sourceIds: [like] }),
          ]);
          assert.equal(comments.applied, 1);
          assert.equal(likes.applied, 1);
        },
      );
    } finally {
      await f.close();
    }
  },
);
