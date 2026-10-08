import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { hashToken } from '../../src/identity/tokens.js';
import { discoveryCursorBucket } from '../../src/community/discovery-cursors.js';
import { setRuntimeVerification } from '../support/community-runtime-fixtures.js';
import { childEnvelope, seedChildren } from './discussion-search-fixtures.js';
import { searchHarness, ok, failure } from './search-fixtures.js';
import {
  freshWorld,
  position,
  addSpace,
  ids,
  instant,
  backendPid,
  waitForLock,
} from './federated-search-fixtures.js';

const finalRows = 'WITH ORDINALITY AS r(viewer,author,bilateral,ordinality)';
const sharedGate =
  "SELECT pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0))";

test(
  'federated catalog: semantic membership, real phantom races and mandatory final proofs',
  { timeout: 300000 },
  async (t) => {
    const h = await searchHarness();
    const cursorCount = async () =>
      (
        await h.pool.query<{ n: number }>(
          'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
        )
      ).rows[0]!.n;
    const waitForSharedGate = async () => {
      for (let i = 0; i < 400; i++) {
        const result = await h.pool.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query=$1 AND wait_event_type='Lock') AS waiting",
          [sharedGate],
        );
        if (result.rows[0]!.waiting) return;
        await sleep(5);
      }
      assert.fail('Reader did not wait on the actual shared common gate');
    };
    try {
      await t.test(
        'catalog statement gates run before count epochs on both owner tables',
        async () => {
          for (const [table, gate] of [
            ['whaleu_community.spaces', 'a_community_search_catalog_gate'],
            ['whaleu_campus.operating_regions', 'a_campus_search_catalog_gate'],
          ] as const) {
            const result = await h.pool.query<{
              tgname: string;
              definition: string;
            }>(
              'SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal ORDER BY tgname',
              [table],
            );
            const names = result.rows.map((row) => row.tgname);
            assert.ok(names.includes(gate));
            assert.ok(
              names.indexOf(gate) < names.indexOf('a_discovery_count_epoch'),
              'Gate precedes exclusive count epoch and source row locks',
            );
            const definition = result.rows.find(
              (row) => row.tgname === gate,
            )!.definition;
            assert.match(
              definition,
              /BEFORE INSERT OR DELETE OR UPDATE|BEFORE INSERT OR UPDATE OR DELETE/,
            );
            assert.match(definition, /FOR EACH STATEMENT/);
          }
          const index = await h.pool.query<{ indexdef: string }>(
            "SELECT indexdef FROM pg_indexes WHERE schemaname='whaleu_community' AND indexname='posts_search_chronological'",
          );
          assert.equal(index.rows.length, 1);
          assert.match(index.rows[0]!.indexdef, /published_at DESC, id DESC/);
          assert.match(
            index.rows[0]!.indexdef,
            /INCLUDE \(space_id, category\)/,
          );
        },
      );

      await t.test(
        'every semantic membership change restarts before scanning even with no posts in the changed member',
        async () => {
          const cases: {
            name: string;
            prepare?: (
              tx: PoolClient,
              space: { spaceId: string; regionId: string | null },
            ) => Promise<unknown>;
            change: (
              tx: PoolClient,
              space: { spaceId: string; regionId: string | null },
            ) => Promise<unknown>;
          }[] = [
            {
              name: 'space insertion',
              change: (tx) =>
                tx.query(
                  "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic new empty member',true)",
                  [randomUUID()],
                ),
            },
            {
              name: 'space removal',
              change: (tx, space) =>
                tx.query('DELETE FROM whaleu_community.spaces WHERE id=$1', [
                  space.spaceId,
                ]),
            },
            {
              name: 'space deactivation',
              change: (tx, space) =>
                tx.query(
                  'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
                  [space.spaceId],
                ),
            },
            {
              name: 'space activation',
              prepare: (tx, space) =>
                tx.query(
                  'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
                  [space.spaceId],
                ),
              change: (tx, space) =>
                tx.query(
                  'UPDATE whaleu_community.spaces SET is_active=true WHERE id=$1',
                  [space.spaceId],
                ),
            },
            {
              name: 'region deactivation',
              change: (tx, space) =>
                tx.query(
                  'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
                  [space.regionId],
                ),
            },
            {
              name: 'region activation',
              prepare: (tx, space) =>
                tx.query(
                  'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
                  [space.regionId],
                ),
              change: (tx, space) =>
                tx.query(
                  'UPDATE whaleu_campus.operating_regions SET is_active=true WHERE id=$1',
                  [space.regionId],
                ),
            },
            {
              name: 'space kind change',
              change: (tx, space) =>
                tx.query(
                  "UPDATE whaleu_community.spaces SET kind='global',operating_region_id=NULL WHERE id=$1",
                  [space.spaceId],
                ),
            },
            {
              name: 'space original-region remap',
              change: async (tx, space) => {
                const region = randomUUID();
                await tx.query(
                  "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic remap region',true)",
                  [region],
                );
                await tx.query(
                  'UPDATE whaleu_community.spaces SET operating_region_id=$2 WHERE id=$1',
                  [space.spaceId, region],
                );
              },
            },
          ];
          for (const entry of cases) {
            const w = await freshWorld(h),
              emptyMember = await addSpace(h, 'regional');
            if (entry.prepare)
              await h.mutate((tx) => entry.prepare!(tx, emptyMember));
            const base = await w.envelope({ text: 'needle stable public' });
            await w.seed(3, () => base, { time: instant });
            const first = await w.aggregate({ limit: '1' });
            ok(first);
            assert.equal(first.body.continuation, 'more');
            await h.mutate((tx) => entry.change(tx, emptyMember));
            let scanned = false;
            h.observer.setHook(async (event) => {
              if (/LIMIT\s+129/i.test(event.sql)) scanned = true;
            });
            try {
              failure(
                await w.aggregate({
                  limit: '1',
                  cursor: first.body.nextCursor,
                }),
                409,
                'DISCOVERY_RESTART_REQUIRED',
              );
            } finally {
              h.observer.setHook(null);
            }
            assert.equal(
              scanned,
              false,
              `${entry.name} must restart before any text-independent content scan`,
            );
          }
        },
      );

      await t.test(
        'cosmetic/inactive/unmapped catalog changes and ordinary post, like and comment churn preserve membership',
        async () => {
          const w = await freshWorld(h),
            base = await w.envelope({ text: 'needle stable' });
          const rows = await w.seed(4, () => base, {
            time: (i) => instant(i * 10),
          });
          const first = await w.aggregate({ limit: '1' });
          ok(first);
          const original = await position(h, first.body.nextCursor);
          await addSpace(h, 'global', false);
          await h.mutate(async (tx) => {
            await tx.query(
              "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic region without a source space',true)",
              [randomUUID()],
            );
            await tx.query(
              "UPDATE whaleu_community.spaces SET name='Synthetic renamed community' WHERE id=$1",
              [w.scope.home.spaceId],
            );
            await tx.query(
              'INSERT INTO whaleu_community.post_likes(post_id,account_id) VALUES($1,$2)',
              [rows[0]!.id, w.reader.accountId],
            );
            // Comments cannot affect search enrollment or body matching. This raw
            // comment is intentionally unread by this post-only search request.
            await tx.query(
              "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,'ordinary churn','named')",
              [randomUUID(), rows[0]!.id, w.author.accountId],
            );
          });
          const newer = await w.seed(
            1,
            () => ({ ...base, text: 'needle newer' }),
            { time: () => instant(-1) },
          );
          const older = await w.seed(
            1,
            () => ({ ...base, text: 'needle between anchors' }),
            { time: () => instant(5) },
          );
          const next = await w.aggregate({
            limit: '1',
            cursor: first.body.nextCursor,
          });
          ok(next);
          assert.deepEqual(ids(next.body), [older[0]!.id]);
          assert.equal(
            next.body.items[0].space.name,
            'Synthetic renamed community',
          );
          assert.equal(
            (await position(h, next.body.nextCursor)).membershipFingerprint,
            original.membershipFingerprint,
          );
          assert.equal(
            ids(next.body).includes(newer[0]!.id),
            false,
            'Live insert above anchor waits for restart',
          );
          const restart = await w.aggregate({ limit: '1' });
          ok(restart);
          assert.deepEqual(ids(restart.body), [newer[0]!.id]);
        },
      );

      await t.test(
        'global traversal ignores unrelated regional insertion, activation and deactivation',
        async () => {
          const w = await freshWorld(h),
            base = await w.envelope({
              spaceId: w.scope.global.spaceId,
              text: 'needle global',
            });
          const rows = await w.seed(4, () => base, { time: instant });
          const first = await w.aggregate({ scope: 'global', limit: '1' });
          ok(first);
          const original = await position(h, first.body.nextCursor);
          await addSpace(h, 'regional');
          await h.mutate((tx) =>
            tx.query(
              'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
              [w.scope.home.regionId],
            ),
          );
          const next = await w.aggregate({
            scope: 'global',
            limit: '1',
            cursor: first.body.nextCursor,
          });
          ok(next);
          assert.deepEqual(ids(next.body), [rows[1]!.id]);
          assert.equal(
            (await position(h, next.body.nextCursor)).membershipFingerprint,
            original.membershipFingerprint,
          );
        },
      );

      await t.test(
        'writer-before-reader gate waits see committed insertion and region deactivation',
        async () => {
          for (const mode of ['insert', 'deactivate'] as const) {
            const w = await freshWorld(h),
              base = await w.envelope({ text: 'needle' });
            await w.seed(1, () => base);
            const writer = await h.pool.connect();
            await writer.query('BEGIN');
            await lockSafetyPolicy(writer, true);
            if (mode === 'insert')
              await writer.query(
                "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic writer-first space',true)",
                [randomUUID()],
              );
            else
              await writer.query(
                'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
                [w.scope.home.regionId],
              );
            const pending = w.aggregate().then((value) => value);
            try {
              await waitForSharedGate();
              await writer.query('COMMIT');
              const result = await pending;
              ok(result);
              assert.equal(result.body.items.length, mode === 'insert' ? 1 : 0);
            } finally {
              await writer.query('ROLLBACK');
              writer.release();
              await pending;
            }
          }
        },
      );

      await t.test(
        'reader-first shared gate blocks actual catalog insert and region writer until request completion, including initially empty catalog',
        async () => {
          for (const mode of [
            'empty-insert',
            'insert',
            'deactivate',
          ] as const) {
            const w = await freshWorld(h);
            if (mode === 'empty-insert')
              await h.mutate((tx) =>
                tx.query(
                  'UPDATE whaleu_community.spaces SET is_active=false WHERE is_active',
                ),
              );
            else {
              const base = await w.envelope({ text: 'needle' });
              await w.seed(1, () => base);
            }
            const writer = await h.pool.connect(),
              pid = await backendPid(writer);
            await writer.query('BEGIN');
            let crossed = false,
              writerDone = false,
              mutation: Promise<void> | undefined;
            h.observer.setHook(async (event) => {
              if (!crossed && event.sql === sharedGate) {
                crossed = true;
                mutation = (async () => {
                  // No helper-acquired exclusive gate: this proves the real raw
                  // statement trigger blocks absent-member phantoms as well.
                  if (mode === 'deactivate')
                    await writer.query(
                      'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
                      [w.scope.home.regionId],
                    );
                  else
                    await writer.query(
                      "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic delayed catalog member',true)",
                      [randomUUID()],
                    );
                  await writer.query('COMMIT');
                  writerDone = true;
                })();
                await waitForLock(h.pool, pid, mode);
                assert.equal(writerDone, false);
              }
              if (crossed && event.sql === 'SET CONSTRAINTS ALL IMMEDIATE')
                assert.equal(
                  writerDone,
                  false,
                  'Gate remains held through mandatory final proof',
                );
            });
            try {
              const result = await w.aggregate();
              ok(result);
              assert.equal(crossed, true);
              assert.equal(
                result.body.items.length,
                mode === 'empty-insert' ? 0 : 1,
              );
              await mutation;
              assert.equal(writerDone, true);
              h.observer.setHook(null);
              if (mode === 'deactivate')
                assert.deepEqual((await w.aggregate()).body.items, []);
            } finally {
              h.observer.setHook(null);
              await writer.query('ROLLBACK');
              writer.release();
              await mutation;
            }
          }
        },
      );

      await t.test(
        'post parent wait re-reads state and rejects unheld global structural additions',
        async () => {
          for (const mode of ['hide', 'unheld'] as const) {
            const w = await freshWorld(h);
            const bases = [
              await w.envelope({ text: 'needle' }),
              await w.envelope({
                spaceId: w.scope.global.spaceId,
                text: 'needle',
              }),
            ];
            const rows = await w.seed(
              mode === 'hide' ? 3 : 130,
              (i) => bases[i % 2]!,
              { time: (i) => instant(mode === 'unheld' && i === 129 ? -1 : i) },
            );
            if (mode === 'unheld')
              await h.mutate((tx) =>
                tx.query(
                  "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
                  [rows[129]!.id],
                ),
              );
            const writer = await h.pool.connect();
            await writer.query('BEGIN');
            await writer.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [rows[0]!.id],
            );
            const pending = w.aggregate({ limit: '1' }).then((value) => value);
            try {
              let waited = false;
              for (let i = 0; i < 400; i++) {
                const result = await h.pool.query<{ waiting: boolean }>(
                  "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE '%FROM whaleu_community.posts p WHERE p.id=ANY($1::uuid[]) ORDER BY p.id ASC FOR SHARE OF p%' AND wait_event_type='Lock') AS waiting",
                );
                if (result.rows[0]!.waiting) {
                  waited = true;
                  break;
                }
                await sleep(5);
              }
              assert.equal(waited, true);
              if (mode === 'hide')
                await writer.query(
                  "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
                  [rows[0]!.id],
                );
              else
                await writer.query(
                  "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
                  [rows[129]!.id],
                );
              await writer.query('COMMIT');
              const result = await pending;
              if (mode === 'hide') {
                ok(result);
                assert.deepEqual(ids(result.body), [rows[1]!.id]);
              } else failure(result, 503, 'COMMUNITY_UNAVAILABLE');
            } finally {
              await writer.query('ROLLBACK');
              writer.release();
              await pending;
            }
          }
        },
      );

      await t.test(
        'quota lock is last and real quota waits cannot publish beyond phone/session deadlines',
        async () => {
          for (const deadline of ['phone', 'session'] as const) {
            const w = await freshWorld(h),
              base = await w.envelope({ text: 'needle' });
            await w.seed(3, () => base, { time: instant });
            const expiresAt = new Date(Date.now() + 2500);
            if (deadline === 'phone')
              await setRuntimeVerification(
                h.pool,
                w.reader.accountId,
                w.scope.institutionId,
                w.scope.home.regionId,
                'verified',
                'verified',
                expiresAt,
              );
            else
              await h.pool.query(
                'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE token_hash=$1',
                [hashToken(w.reader.accessToken), expiresAt],
              );
            const before = await cursorCount(),
              locker = await h.pool.connect();
            await locker.query('BEGIN');
            const quotaKey = `whaleu:discovery:quota:v1:${discoveryCursorBucket(w.reader.accountId).hash}`;
            await locker.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [quotaKey],
            );
            let quota = false,
              inserted = false;
            h.observer.setHook(async (event) => {
              if (event.values.includes(quotaKey)) quota = true;
              if (quota)
                assert.equal(
                  /FOR (?:SHARE|UPDATE)/i.test(event.sql),
                  false,
                  'No domain row lock after quota',
                );
              if (
                event.sql.includes(
                  'INSERT INTO whaleu_community.discovery_cursors',
                )
              )
                inserted = true;
            });
            const pending = w.aggregate({ limit: '1' }).then((value) => value);
            try {
              let waited = false;
              for (let i = 0; i < 400; i++) {
                const result = await h.pool.query<{ waiting: boolean }>(
                  "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query='SELECT pg_advisory_xact_lock(hashtextextended($1,0))' AND wait_event_type='Lock') AS waiting",
                );
                if (result.rows[0]!.waiting) {
                  waited = true;
                  break;
                }
                await sleep(5);
              }
              assert.equal(
                waited,
                true,
                'Use real database quota contention, not simulated elapsed provider output',
              );
              await sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 75);
              await locker.query('COMMIT');
              const result = await pending;
              failure(
                result,
                deadline === 'phone' ? 403 : 401,
                deadline === 'phone'
                  ? 'PHONE_VERIFICATION_REQUIRED'
                  : undefined,
              );
              assert.equal(quota, true);
              assert.equal(
                inserted,
                true,
                'Final deadline rejection rolls back would-be successor',
              );
              assert.equal(await cursorCount(), before);
            } finally {
              h.observer.setHook(null);
              await locker.query('ROLLBACK');
              locker.release();
              await pending;
            }
          }
        },
      );

      await t.test(
        'mandatory named post and named child proofs roll back aggregate cursors after actual block insertion',
        async () => {
          for (const subject of ['post', 'comment', 'reply'] as const) {
            const w = await freshWorld(h),
              child = await w.actor();
            const parent = await w.publish({
              spaceId: w.scope.global.spaceId,
              text:
                subject === 'post'
                  ? 'needle protected'
                  : 'plain anonymous parent',
              authorMode: subject === 'post' ? 'named' : 'anonymous',
            });
            const author = subject === 'post' ? w.author : child;
            if (subject === 'post') {
              const base = await w.envelope({ text: 'needle older' });
              await w.seed(2, () => base, { time: instant });
            } else {
              const rootEnvelope = await childEnvelope(
                h,
                w,
                parent.id,
                null,
                subject === 'comment' ? child : w.author,
                subject === 'comment'
                  ? 'needle protected root'
                  : 'plain anonymous root',
                subject === 'comment' ? 'named' : 'anonymous',
              );
              const roots = await seedChildren(
                h,
                'comment',
                subject === 'comment' ? 3 : 1,
                () => rootEnvelope,
                { time: instant },
              );
              if (subject === 'reply') {
                const replyEnvelope = await childEnvelope(
                  h,
                  w,
                  parent.id,
                  roots[0]!.id,
                  child,
                  'needle protected reply',
                );
                await seedChildren(h, 'reply', 3, () => replyEnvelope, {
                  time: instant,
                });
              }
            }
            const baseline = await w.aggregate({ type: subject, limit: '1' });
            ok(baseline);
            assert.equal(baseline.body.items[0].kind, subject);
            assert.equal(baseline.body.items[0].discussionCount, undefined);
            const before = await cursorCount();
            let inserted = false,
              proof = false;
            h.observer.setHook(async (event) => {
              if (
                event.sql.includes(finalRows) &&
                (event.values[1] as string[]).includes(author.accountId)
              )
                proof = true;
              if (
                !inserted &&
                event.sql.includes(
                  'INSERT INTO whaleu_community.discovery_cursors',
                )
              ) {
                inserted = true;
                await h.writeBlock(w.reader, author);
              }
            });
            try {
              failure(
                await w.aggregate({
                  type: subject,
                  limit: '1',
                  q: 'protected',
                }),
                503,
                'COMMUNITY_UNAVAILABLE',
              );
              assert.equal(inserted, true);
              assert.equal(proof, true);
              assert.equal(await cursorCount(), before);
            } finally {
              h.observer.setHook(null);
            }
            const changed = await w.aggregate({ type: subject, limit: '1' });
            ok(changed);
            assert.equal(
              JSON.stringify(changed.body).includes(author.profileId),
              false,
            );
          }
        },
      );
    } finally {
      await h.close();
    }
  },
);
