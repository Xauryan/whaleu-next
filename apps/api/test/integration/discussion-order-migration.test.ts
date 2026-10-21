/** Disposable real migration/source-trigger proof. An explicit synthetic identity
 * provider and exact predecessor owner are test-only; cutover timestamps are real. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { approveEnvelope } from '../support/community-approval-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { childEnvelope, seedChildren } from './discussion-search-fixtures.js';
import { searchHarness, ok } from './search-fixtures.js';
import { APP_CONFIG } from '../../src/config/config.js';
import { IDENTITY_PROVIDER } from '../../src/identity/contracts.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { discussionOrderUpgradeFixture } from '../support/discussion-order-upgrade-fixture.js';

const rejected = (code: string) => (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === code;
test(
  'discussion ordering migration: exact backfill, causal source deltas and retained cleanup',
  { timeout: 120000 },
  async (t) => {
    const upgrade = discussionOrderUpgradeFixture();
    const h = await searchHarness({
      deferMigrationsFrom: '0168_community_discussion_order.sql',
      discussionOrderCutover: upgrade.hooks,
    });
    try {
      const historicalApp = h.app,
        historicalHttp = h.http,
        historicalOwner = h.app.get(IdentityRepository),
        historicalService = h.app.get(IdentityService),
        historicalConfig = h.app.get(APP_CONFIG),
        historicalObserver = h.observer;
      await upgrade.assertOldSchema(h.pool);
      const w = await h.world(),
        third = await w.actor();
      assert.equal(upgrade.providerExchanges(), 3);
      const [post] = await w.seed(1),
        base = await childEnvelope(h, w, post!.id);
      const roots = await seedChildren(h, 'comment', 4, () => base, {
        time: (i) => `2020-01-01T00:00:00.00000${i}Z`,
      });
      const root = roots[0]!,
        second = roots[1]!;
      const like = (id: string, actor = w.reader.accountId) =>
        h.pool.query(
          'INSERT INTO whaleu_community.comment_likes(comment_id,account_id) VALUES($1,$2) ON CONFLICT(comment_id,account_id) DO NOTHING RETURNING like_id',
          [id, actor],
        );
      await like(root.id);
      await like(root.id, w.author.accountId);
      await like(second.id);
      // Include a retained hidden root at cutover, not merely future hides.
      await h.pool.query(
        "UPDATE whaleu_community.root_comments SET visibility='hidden' WHERE id=$1",
        [second.id],
      );
      const before = (
        await h.pool.query(
          'SELECT like_id,comment_id,account_id,liked_at FROM whaleu_community.comment_likes ORDER BY like_id',
        )
      ).rows;
      const definitions = (
        await h.pool.query(
          'SELECT to_jsonb(root) AS definition FROM whaleu_community.root_comments root ORDER BY id',
        )
      ).rows;
      assert.equal(
        h.migrationPlan.deferred[0],
        '0168_community_discussion_order.sql',
      );
      assert.ok(h.migrationPlan.appliedInitially.at(-1)!.startsWith('0167_'));
      await upgrade.assertOldSchema(h.pool);
      const applied = await h.applyDeferredMigrations();
      assert.deepEqual(
        applied.map((m) => m.name),
        [...h.migrationPlan.appliedInitially, ...h.migrationPlan.deferred],
      );
      assert.ok(applied.every((m) => m.status === 'applied'));
      await assert.rejects(
        h.applyDeferredMigrations(),
        /only be attempted once/,
      );
      await assert.rejects(
        historicalService.session(w.reader.accessToken),
        /Historical Identity cannot cross an upgrade/,
      );
      assert.equal(upgrade.providerExchanges(), 3);
      await h.restartCurrentApp();
      assert.notEqual(h.app, historicalApp);
      assert.notEqual(h.http, historicalHttp);
      assert.equal(historicalHttp.listening, false);
      assert.notEqual(h.observer, historicalObserver);
      assert.notEqual(h.app.get(IdentityRepository), historicalOwner);
      assert.equal(
        Object.getPrototypeOf(h.app.get(IdentityRepository)),
        IdentityRepository.prototype,
      );
      assert.notEqual(h.app.get(IdentityService), historicalService);
      assert.equal(
        Object.getPrototypeOf(h.app.get(IdentityService)),
        IdentityService.prototype,
      );
      assert.equal(h.app.get(APP_CONFIG), historicalConfig);
      assert.equal(h.app.get(IDENTITY_PROVIDER), upgrade.provider);
      await assert.rejects(
        historicalService.session(w.reader.accessToken),
        /Discussion predecessor phase is closed/,
      );
      await assert.rejects(h.restartCurrentApp(), /only be attempted once/);
      const continuity = await request(h.http)
        .get('/v1/auth/session')
        .set('Authorization', `Bearer ${w.reader.accessToken}`);
      ok(continuity);
      assert.equal(continuity.body.accountId, w.reader.accountId);
      assert.equal(continuity.body.sessionId, w.reader.sessionId);
      // This is the pre-restart world callback, not a newly captured app/server.
      const currentActor = await w.actor();
      assert.equal(upgrade.providerExchanges(), 4);
      const currentSession = await request(h.http)
        .get('/v1/auth/session')
        .set('Authorization', `Bearer ${currentActor.accessToken}`);
      ok(currentSession);
      assert.equal(currentSession.body.sessionId, currentActor.sessionId);
      assert.deepEqual(
        (
          await h.pool.query(
            'SELECT lifecycle,lifecycle_generation,deletion_request_id FROM whaleu_identity.accounts WHERE id=$1',
            [currentActor.accountId],
          )
        ).rows,
        [
          {
            lifecycle: 'active',
            lifecycle_generation: '0',
            deletion_request_id: null,
          },
        ],
      );
      const entries = () =>
        h.pool.query<{
          root_id: string;
          like_count: number;
          live: boolean;
          head_id: string | null;
        }>(
          'SELECT root_id,like_count,live,head_id FROM whaleu_community.discussion_root_order WHERE post_id=$1 ORDER BY root_id',
          [post!.id],
        );
      const assertLiveProjection = async () => {
        const mismatch = await h.pool.query(`
          WITH canonical AS (
            SELECT root_id,post_id,created_at,like_count,head_id
            FROM whaleu_community.discussion_root_order WHERE live
          ), projected AS (
            SELECT root_id,post_id,created_at,like_count,head_id
            FROM whaleu_community.discussion_live_root_order
          )
          (SELECT * FROM canonical EXCEPT SELECT * FROM projected)
          UNION ALL
          (SELECT * FROM projected EXCEPT SELECT * FROM canonical)`);
        assert.equal(
          mismatch.rowCount,
          0,
          'Live projection must exactly match canonical live tuples, including head and timestamp',
        );
      };
      const liveEntries = () =>
        h.pool.query(
          'SELECT to_jsonb(p) AS definition FROM whaleu_community.discussion_live_root_order p ORDER BY root_id',
        );
      const count = async (id: string) =>
        (await entries()).rows.find((r) => r.root_id === id)!.like_count;
      assert.equal(await count(root.id), 2);
      assert.equal(await count(second.id), 1);
      assert.ok((await entries()).rows.every((r) => r.head_id === null));
      assert.deepEqual(
        (
          await h.pool.query(
            'SELECT like_id,comment_id,account_id,liked_at FROM whaleu_community.comment_likes ORDER BY like_id',
          )
        ).rows,
        before,
      );
      assert.deepEqual(
        (
          await h.pool.query(
            'SELECT to_jsonb(root) AS definition FROM whaleu_community.root_comments root ORDER BY id',
          )
        ).rows,
        definitions,
      );
      assert.equal(
        (
          await h.pool.query(
            'SELECT * FROM whaleu_community.discussion_order_memberships WHERE active',
          )
        ).rowCount,
        3,
      );

      await assertLiveProjection();
      assert.equal((await liveEntries()).rowCount, 3);
      assert.ok(
        (await liveEntries()).rows.every((r) => r.definition.head_id === null),
      );
      await h.pool.query(
        "UPDATE whaleu_community.root_comments SET visibility='approved' WHERE id=$1",
        [second.id],
      );
      await assertLiveProjection();
      assert.equal((await liveEntries()).rowCount, 4);

      await t.test(
        'duplicate source writes, unlike/re-like and rollback preserve exact integer state',
        async () => {
          assert.equal((await like(root.id)).rowCount, 0);
          assert.equal(await count(root.id), 2);
          await assertLiveProjection();
          const newLike = await like(root.id, third.accountId);
          assert.equal(await count(root.id), 3);
          await assertLiveProjection();
          const oldId = newLike.rows[0]!.like_id as string;
          assert.equal(
            (
              await h.pool.query(
                'DELETE FROM whaleu_community.comment_likes WHERE like_id=$1',
                [oldId],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await h.pool.query(
                'DELETE FROM whaleu_community.comment_likes WHERE like_id=$1',
                [oldId],
              )
            ).rowCount,
            0,
          );
          assert.equal(await count(root.id), 2);
          await assertLiveProjection();
          const replacement = await like(root.id, third.accountId);
          assert.notEqual(replacement.rows[0]!.like_id, oldId);
          assert.equal(await count(root.id), 3);
          await assertLiveProjection();
          const state = (await entries()).rows;
          const liveState = (await liveEntries()).rows;
          const events = (
            await h.pool.query(
              'SELECT count(*)::integer n FROM whaleu_community.discussion_order_events',
            )
          ).rows[0]!.n;
          const tx = await h.pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query(
              'DELETE FROM whaleu_community.comment_likes WHERE comment_id=$1',
              [root.id],
            );
            assert.equal(
              (
                await tx.query(
                  'SELECT like_count FROM whaleu_community.discussion_root_order WHERE root_id=$1',
                  [root.id],
                )
              ).rows[0]!.like_count,
              0,
            );
            assert.equal(
              (
                await tx.query(
                  'SELECT like_count FROM whaleu_community.discussion_live_root_order WHERE root_id=$1',
                  [root.id],
                )
              ).rows[0]!.like_count,
              0,
            );
            await tx.query('ROLLBACK');
          } finally {
            tx.release();
          }
          assert.deepEqual((await entries()).rows, state);
          assert.deepEqual((await liveEntries()).rows, liveState);
          await assertLiveProjection();
          assert.equal(
            (
              await h.pool.query(
                'SELECT count(*)::integer n FROM whaleu_community.discussion_order_events',
              )
            ).rows[0]!.n,
            events,
          );
          await Promise.all([
            like(roots[2]!.id, w.reader.accountId),
            like(roots[2]!.id, w.author.accountId),
          ]);
          assert.equal(
            await count(roots[2]!.id),
            2,
            'Concurrent FK KEY SHARE writers must serialize without lost updates',
          );
        },
      );

      await t.test(
        'direct counter/witness tampering, source identity edits and truncation fail closed',
        async () => {
          await assert.rejects(
            h.pool.query(
              'UPDATE whaleu_community.discussion_root_order SET like_count=0 WHERE root_id=$1',
              [root.id],
            ),
            rejected('23514'),
          );
          await assert.rejects(
            h.pool.query(
              `INSERT INTO whaleu_community.discussion_order_events(id,root_id,previous_id,kind,previous_count,new_count,live,like_id,account_id)
        SELECT $1,root_id,head_id,'like_add',like_count,like_count+1,live,$2,$3 FROM whaleu_community.discussion_root_order WHERE root_id=$4`,
              [randomUUID(), randomUUID(), w.reader.accountId, root.id],
            ),
            rejected('23514'),
          );
          await assert.rejects(
            h.pool.query(
              'UPDATE whaleu_community.comment_likes SET account_id=$1 WHERE comment_id=$2 AND account_id=$3',
              [third.accountId, second.id, w.reader.accountId],
            ),
            rejected('23514'),
          );
          await assert.rejects(
            h.pool.query(
              'DELETE FROM whaleu_community.discussion_order_memberships WHERE root_id=$1',
              [root.id],
            ),
            rejected('23514'),
          );
          for (const table of [
            'comment_likes',
            'discussion_live_root_order',
            'discussion_root_order',
            'discussion_order_events',
            'discussion_order_memberships',
          ])
            await assert.rejects(
              h.pool.query(`TRUNCATE whaleu_community.${table} CASCADE`),
              rejected('23514'),
            );
          assert.equal(await count(root.id), 3);
          await assertLiveProjection();
        },
      );

      await t.test(
        'live projection rejects direct and nested forged maintenance',
        async () => {
          const commands = [
            'UPDATE whaleu_community.discussion_live_root_order SET like_count=like_count+1',
            "UPDATE whaleu_community.discussion_live_root_order SET created_at=created_at+interval '1 second'",
            'UPDATE whaleu_community.discussion_live_root_order SET head_id=gen_random_uuid()',
            'UPDATE whaleu_community.discussion_live_root_order SET post_id=gen_random_uuid()',
            'UPDATE whaleu_community.discussion_live_root_order SET root_id=gen_random_uuid()',
            'DELETE FROM whaleu_community.discussion_live_root_order',
            'INSERT INTO whaleu_community.discussion_live_root_order SELECT root_id,post_id,created_at,like_count,head_id FROM whaleu_community.discussion_root_order WHERE live',
          ];
          for (const command of commands)
            await assert.rejects(h.pool.query(command), rejected('23514'));
          // Even no-op direct writes are source-owned, not just changed tuples.
          await assert.rejects(
            h.pool.query(
              'UPDATE whaleu_community.discussion_live_root_order SET like_count=like_count WHERE false',
            ),
            rejected('23514'),
          );
          const tx = await h.pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query(
              'CREATE TEMP TABLE live_projection_tamper(command text) ON COMMIT DROP',
            );
            await tx.query(`CREATE FUNCTION pg_temp.live_projection_tamper() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN EXECUTE NEW.command; RETURN NULL; END$$`);
            await tx.query(
              'CREATE TRIGGER live_projection_tamper AFTER INSERT ON live_projection_tamper FOR EACH ROW EXECUTE FUNCTION pg_temp.live_projection_tamper()',
            );
            // Nested depth does not permit mismatched tuples or removal of live roots.
            for (const command of commands.slice(0, -1)) {
              await tx.query('SAVEPOINT reject_tamper');
              await assert.rejects(
                tx.query('INSERT INTO live_projection_tamper VALUES($1)', [
                  command,
                ]),
                rejected('23514'),
              );
              await tx.query('ROLLBACK TO SAVEPOINT reject_tamper');
              await tx.query('RELEASE SAVEPOINT reject_tamper');
            }
            // Nested INSERTs must reject an exact but nonlive canonical tuple.
            await tx.query(
              "UPDATE whaleu_community.root_comments SET visibility='hidden' WHERE id=$1",
              [second.id],
            );
            await tx.query('SAVEPOINT reject_hidden_insert');
            await assert.rejects(
              tx.query('INSERT INTO live_projection_tamper VALUES($1)', [
                `INSERT INTO whaleu_community.discussion_live_root_order SELECT root_id,post_id,created_at,like_count,head_id FROM whaleu_community.discussion_root_order WHERE root_id='${second.id}'`,
              ]),
              rejected('23514'),
            );
            await tx.query('ROLLBACK TO SAVEPOINT reject_hidden_insert');
            await tx.query('ROLLBACK');
          } finally {
            tx.release();
          }
          await assertLiveProjection();
        },
      );

      await t.test(
        'live state restoration, current pin and both mixed like directions remain exact',
        async () => {
          await h.pool.query(
            "UPDATE whaleu_community.root_comments SET visibility='hidden' WHERE id=$1",
            [second.id],
          );
          assert.equal(
            (await entries()).rows.find((r) => r.root_id === second.id)!.live,
            false,
          );
          await assertLiveProjection();
          assert.equal((await liveEntries()).rowCount, 3);
          await h.pool.query(
            "UPDATE whaleu_community.root_comments SET visibility='approved' WHERE id=$1",
            [second.id],
          );
          assert.equal(
            (await entries()).rows.find((r) => r.root_id === second.id)!.live,
            true,
          );
          await assertLiveProjection();
          assert.equal((await liveEntries()).rowCount, 4);
          await h.pool.query(
            'INSERT INTO whaleu_community.comment_pins(post_id,comment_id) VALUES($1,$2)',
            [post!.id, roots[3]!.id],
          );
          for (const [sort, order, expected] of [
            ['likes', 'asc', [roots[3]!.id, second.id, roots[2]!.id, root.id]],
            ['likes', 'desc', [roots[3]!.id, root.id, roots[2]!.id, second.id]],
            ['time', 'asc', [roots[3]!.id, root.id, second.id, roots[2]!.id]],
            ['time', 'desc', [roots[3]!.id, roots[2]!.id, second.id, root.id]],
          ] as const) {
            const found: string[] = [];
            let cursor: string | null = null;
            do {
              const response = await request(h.http)
                .get(`/v1/community/posts/${post!.id}/comments`)
                .set('Authorization', `Bearer ${w.reader.accessToken}`)
                .query({
                  sort,
                  order,
                  limit: 1,
                  ...(cursor ? { cursor } : {}),
                });
              ok(response);
              found.push(
                ...response.body.items.map((r: { id: string }) => r.id),
              );
              cursor = response.body.nextCursor as string | null;
              assert.ok(found.length <= 4);
            } while (cursor);
            assert.deepEqual(found, expected);
          }
          // Approved content and author accounts remain retained, not cascaded.
          await assert.rejects(
            h.pool.query(
              'DELETE FROM whaleu_community.root_comments WHERE id=$1',
              [root.id],
            ),
            rejected('23514'),
          );
          await assert.rejects(
            h.pool.query('DELETE FROM whaleu_identity.accounts WHERE id=$1', [
              w.author.accountId,
            ]),
            rejected('23503'),
          );
        },
      );

      await t.test(
        'pre-approval timestamp changes remain synchronous through binding and rollback without relaxing identity',
        async () => {
          const created = randomUUID(),
            rolledBack = randomUUID();
          const publish = async (id: string, rollback: boolean) => {
            const approval = await approveEnvelope(h.pool, base, {
              policyRevisionId: h.policyId,
            });
            return withCommunityScopeWriter(h.pool, async (tx) => {
              await tx.query(
                "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode,created_at) VALUES($1,$2,$3,$4,$5,'2019-01-01T00:00:00.000001Z')",
                [id, post!.id, base.accountId, base.text, base.authorMode],
              );
              await tx.query(
                'INSERT INTO whaleu_community.comment_likes(comment_id,account_id) VALUES($1,$2)',
                [id, w.reader.accountId],
              );
              await tx.query(
                "UPDATE whaleu_community.root_comments SET created_at='2022-01-01T00:00:00.000009Z' WHERE id=$1",
                [id],
              );
              const order = (
                await tx.query(
                  'SELECT like_count,to_char(created_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') at FROM whaleu_community.discussion_root_order WHERE root_id=$1',
                  [id],
                )
              ).rows[0]!;
              const liveOrder = (
                await tx.query(
                  'SELECT like_count,to_char(created_at AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') at FROM whaleu_community.discussion_live_root_order WHERE root_id=$1',
                  [id],
                )
              ).rows[0]!;
              assert.deepEqual(liveOrder, order);
              assert.deepEqual(order, {
                like_count: 1,
                at: '2022-01-01T00:00:00.000009Z',
              });
              await tx.query('SAVEPOINT identity_must_stay_immutable');
              await assert.rejects(
                tx.query(
                  'UPDATE whaleu_community.root_comments SET post_id=$2 WHERE id=$1',
                  [id, randomUUID()],
                ),
                rejected('23514'),
              );
              await tx.query(
                'ROLLBACK TO SAVEPOINT identity_must_stay_immutable',
              );
              await tx.query('RELEASE SAVEPOINT identity_must_stay_immutable');
              await tx.query(
                `INSERT INTO whaleu_community.content_approval_bindings(content_kind,content_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope)
            VALUES('comment',$1,1,$2,$3,'publish_comment',$4,$5,$6::jsonb,$7::jsonb)`,
                [
                  id,
                  approval.decisionId,
                  base.accountId,
                  approval.version,
                  approval.digest,
                  JSON.stringify(approval.envelope),
                  JSON.stringify(approval.envelope.scope),
                ],
              );
              if (rollback) throw new Error('Intentional creation rollback');
            });
          };
          await publish(created, false);
          await assert.rejects(
            publish(rolledBack, true),
            /Intentional creation rollback/,
          );
          for (const table of [
            'discussion_live_root_order',
            'discussion_root_order',
            'discussion_order_events',
            'discussion_order_memberships',
          ])
            assert.equal(
              (
                await h.pool.query(
                  `SELECT 1 FROM whaleu_community.${table} WHERE root_id=$1`,
                  [rolledBack],
                )
              ).rowCount,
              0,
            );
          assert.equal(
            (
              await h.pool.query(
                'SELECT 1 FROM whaleu_community.root_comments WHERE id=$1',
                [rolledBack],
              )
            ).rowCount,
            0,
          );
          await assert.rejects(
            h.pool.query(
              "UPDATE whaleu_community.root_comments SET created_at='2023-01-01' WHERE id=$1",
              [created],
            ),
            rejected('23514'),
          );
          await assert.rejects(
            h.pool.query(
              'UPDATE whaleu_community.root_comments SET post_id=$2 WHERE id=$1',
              [created, randomUUID()],
            ),
            rejected('23514'),
          );
          const page = await request(h.http)
            .get(`/v1/community/posts/${post!.id}/comments`)
            .set('Authorization', `Bearer ${w.reader.accessToken}`)
            .query({ sort: 'time', order: 'desc', limit: 2 });
          ok(page);
          assert.deepEqual(
            page.body.items.map((r: { id: string }) => r.id),
            [roots[3]!.id, created],
          );
          assert.equal(await count(created), 1);
          await assertLiveProjection();
          // Leave the subsequent explicit cleanup fixture's original membership set.
          await h.pool.query(
            'DELETE FROM whaleu_community.comment_likes WHERE comment_id=$1',
            [created],
          );
        },
      );

      await t.test(
        'multi-root membership cleanup and future root enrollment are synchronous',
        async () => {
          await h.pool.query(
            'DELETE FROM whaleu_community.comment_likes WHERE comment_id=ANY($1::uuid[])',
            [roots.map((r) => r.id)],
          );
          assert.ok((await entries()).rows.every((r) => r.like_count === 0));
          assert.equal(
            (
              await h.pool.query(
                'SELECT 1 FROM whaleu_community.discussion_order_memberships WHERE active',
              )
            ).rowCount,
            0,
          );
          const [next] = await seedChildren(h, 'comment', 1, () => base);
          assert.equal(await count(next!.id), 0);
          await like(next!.id);
          assert.equal(await count(next!.id), 1);
          await assertLiveProjection();
          await h.pool.query(
            'UPDATE whaleu_community.root_comments SET deleted_at=clock_timestamp() WHERE id=$1',
            [next!.id],
          );
          assert.equal(
            (await entries()).rows.find((r) => r.root_id === next!.id)!.live,
            false,
          );
          assert.equal(
            await count(next!.id),
            1,
            'Tombstones do not invent membership deletions',
          );
          await assertLiveProjection();
          assert.equal(
            (
              await h.pool.query(
                'SELECT 1 FROM whaleu_community.discussion_live_root_order WHERE root_id=$1',
                [next!.id],
              )
            ).rowCount,
            0,
          );
          // A fresh child must survive its creation transaction's existing
          // deferred classification proof, even when it is not approved.
          // The order projection must not weaken that older causal invariant.
          const ephemeral = randomUUID(),
            tx = await h.pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query(
              "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode,visibility) VALUES($1,$2,$3,'Unapproved disposable cleanup','named','hidden')",
              [ephemeral, post!.id, w.author.accountId],
            );
            await tx.query(
              'INSERT INTO whaleu_community.comment_likes(comment_id,account_id) VALUES($1,$2)',
              [ephemeral, w.reader.accountId],
            );
            await tx.query(
              'DELETE FROM whaleu_community.comment_likes WHERE comment_id=$1',
              [ephemeral],
            );
            await tx.query(
              'DELETE FROM whaleu_community.root_comments WHERE id=$1',
              [ephemeral],
            );
            assert.equal(
              (
                await tx.query(
                  'SELECT 1 FROM whaleu_community.discussion_root_order WHERE root_id=$1',
                  [ephemeral],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await tx.query(
                  'SELECT 1 FROM whaleu_community.discussion_order_memberships WHERE root_id=$1 AND NOT active',
                  [ephemeral],
                )
              ).rowCount,
              1,
            );
            await assert.rejects(
              tx.query('COMMIT'),
              (error: unknown) =>
                rejected('23514')(error) &&
                typeof error === 'object' &&
                error !== null &&
                'constraint' in error &&
                error.constraint === 'post_category_causal',
            );
            await tx.query('ROLLBACK');
          } catch (error) {
            await tx.query('ROLLBACK');
            throw error;
          } finally {
            tx.release();
          }
          assert.equal(
            (
              await h.pool.query(
                'SELECT 1 FROM whaleu_community.root_comments WHERE id=$1',
                [ephemeral],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await h.pool.query(
                'SELECT 1 FROM whaleu_community.discussion_order_memberships WHERE root_id=$1',
                [ephemeral],
              )
            ).rowCount,
            0,
            'Failed creation/cleanup commits retain no partial membership history',
          );
          // Pre-approval physical cleanup remains possible in a later transaction
          // after the child has survived its creation proof. No approval binding,
          // author retention, or historical membership evidence is removed.
          await h.pool.query(
            "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode,visibility) VALUES($1,$2,$3,'Unapproved disposable cleanup','named','hidden')",
            [ephemeral, post!.id, w.author.accountId],
          );
          await like(ephemeral);
          await h.pool.query(
            'DELETE FROM whaleu_community.comment_likes WHERE comment_id=$1',
            [ephemeral],
          );
          await h.pool.query(
            'DELETE FROM whaleu_community.root_comments WHERE id=$1',
            [ephemeral],
          );
          assert.equal(
            (
              await h.pool.query(
                'SELECT 1 FROM whaleu_community.discussion_root_order WHERE root_id=$1',
                [ephemeral],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await h.pool.query(
                'SELECT 1 FROM whaleu_community.discussion_order_memberships WHERE root_id=$1 AND NOT active',
                [ephemeral],
              )
            ).rowCount,
            1,
            'Later legal cleanup retains the committed inactive membership evidence',
          );
          await assertLiveProjection();
          assert.equal(
            (
              await h.pool.query(
                'SELECT 1 FROM whaleu_community.discussion_live_root_order WHERE root_id=$1',
                [ephemeral],
              )
            ).rowCount,
            0,
          );
        },
      );
    } finally {
      await h.close();
    }
  },
);
