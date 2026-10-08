import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { discoveryCursorBucket } from '../../src/community/discovery-cursors.js';
import { SearchReadContext } from '../../src/community/content-review/search-read-context.js';
import { DatabaseService } from '../../src/database/database.js';
import { SafetyRepository } from '../../src/safety/repository.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { enableSafetyRelationshipProof } from '../../src/safety/relationship-proof.js';
import { withScalarSearchSafetyHeads } from '../support/search-scalar-safety.js';
import { childEnvelope, seedChildren } from './discussion-search-fixtures.js';
import { trading } from './federated-search-fixtures.js';
import { searchHarness, ok, failure } from './search-fixtures.js';

const old = '2026-09-01T00:00:00.000000Z';
const at = (i: number) =>
  `2026-10-01T00:00:00.${String(999999 - i).padStart(6, '0')}Z`;
const headQuery = 'FROM whaleu_safety.account_heads';
const relationshipQuery = 'SELECT EXISTS(SELECT 1 FROM whaleu_safety.blocks';

test(
  'search Safety head reuse: scalar observations, actual locks and final deadlines',
  { timeout: 120000 },
  async (t) => {
    const h = await searchHarness();
    const records = h.app.get(SafetyRepository);
    const database = h.app.get(DatabaseService);
    const scalar = <T>(work: () => Promise<T>) =>
      withScalarSearchSafetyHeads(records, work);
    const cursorCount = async () =>
      (
        await h.pool.query<{ n: number }>(
          'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
        )
      ).rows[0]!.n;
    try {
      await t.test(
        'Safety-only scalar differential covers component definitions, anonymous/self/guest and exact errors',
        async () => {
          const w = await h.world();
          await w.publish({ text: 'needle ordinary' });
          await w.publish({
            text: 'needle trading',
            category: 'trading',
            trading,
          });
          await w.publish({
            text: 'needle poll',
            component: {
              kind: 'poll',
              question: 'Synthetic question',
              selectionMode: 'single',
              options: ['First', 'Second'],
            },
          });
          await w.publish({
            text: 'needle formation',
            authorMode: 'anonymous',
            component: {
              kind: 'formation',
              capacity: 20,
              theme: 'Synthetic',
              contacts: trading.contacts,
              contactSharing: 'members_v1',
            },
          });
          for (const viewer of [w.reader, w.author, null]) {
            for (const query of [
              { limit: '1' },
              { q: 'absent' },
              { category: 'trading' },
            ]) {
              const contextual = await w.search(query, viewer);
              const baseline = await scalar(
                async () => await w.search(query, viewer),
              );
              ok(contextual);
              ok(baseline);
              assert.deepEqual(
                { ...contextual.body, nextCursor: null },
                { ...baseline.body, nextCursor: null },
              );
              if (contextual.body.nextCursor)
                assert.deepEqual(
                  await h.position(contextual.body.nextCursor),
                  await h.position(baseline.body.nextCursor),
                );
            }
          }
          await h.pool.query(
            "UPDATE whaleu_safety.account_heads SET block_coverage='missing' WHERE account_id=$1",
            [w.reader.accountId],
          );
          const contextual = await w.search();
          const baseline = await scalar(async () => await w.search());
          failure(contextual, 503, 'COMMUNITY_UNAVAILABLE');
          failure(baseline, 503, 'COMMUNITY_UNAVAILABLE');
          assert.deepEqual(
            { ...contextual.body.error, requestId: null },
            { ...baseline.body.error, requestId: null },
          );
        },
      );

      await t.test(
        'raw allow→block→unblock observations remain fresh in the same transaction',
        async () => {
          const results: unknown[][] = [];
          for (const useScalar of [false, true]) {
            const w = await h.world();
            const statements: string[] = [];
            h.observer.setHook(async (event) => {
              statements.push(event.sql);
            });
            try {
              const work = () =>
                database.transaction(
                  async (tx) => {
                    enableSafetyRelationshipProof(tx);
                    const read = new SearchReadContext(tx);
                    try {
                      await lockSafetyPolicy(tx);
                      const check = () =>
                        records.directions(
                          w.reader.accountId,
                          w.author.accountId,
                          'direct_post',
                          tx,
                          read,
                        );
                      const first = await check();
                      const relation = await h.writeBlock(w.reader, w.author);
                      const denied = await check();
                      await h.writeBlock(w.reader, w.author, false, relation);
                      const third = await check();
                      read.assertCurrent(tx);
                      return [first, denied, third];
                    } finally {
                      read.close();
                    }
                  },
                  { isolationLevel: 'read committed' },
                );
              results.push(await (useScalar ? scalar(work) : work()));
            } finally {
              h.observer.setHook(null);
            }
            assert.equal(
              statements.filter((sql) => sql.includes(headQuery)).length,
              useScalar ? 6 : 2,
            );
            assert.equal(
              statements.filter(
                (sql) => sql === 'SELECT clock_timestamp() AS now',
              ).length,
              7,
            );
            assert.equal(
              statements.filter((sql) => sql.includes(relationshipQuery))
                .length,
              3,
            );
            assert.equal(
              statements.filter((sql) =>
                sql.includes(
                  'WITH ORDINALITY AS r(viewer,author,bilateral,ordinality)',
                ),
              ).length,
              1,
            );
          }
          assert.deepEqual(results[0], results[1]);
          assert.deepEqual(results[0], [
            { outgoing: false, incoming: false },
            { outgoing: true, incoming: false },
            { outgoing: false, incoming: false },
          ]);
        },
      );

      await t.test(
        'a cached coverage head holds the actual SHARE row lock until commit; next request observes revocation',
        async () => {
          const w = await h.world();
          const writer = await h.pool.connect();
          let update: Promise<unknown> | undefined;
          try {
            await writer.query('BEGIN');
            const pid = (
              await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')
            ).rows[0]!.pid;
            await database.transaction(
              async (tx) => {
                enableSafetyRelationshipProof(tx);
                const read = new SearchReadContext(tx);
                try {
                  await lockSafetyPolicy(tx);
                  assert.ok(
                    await records.directions(
                      w.reader.accountId,
                      w.author.accountId,
                      'direct_post',
                      tx,
                      read,
                    ),
                  );
                  update = writer.query(
                    "UPDATE whaleu_safety.account_heads SET block_coverage='missing' WHERE account_id=$1",
                    [w.reader.accountId],
                  );
                  const expires = Date.now() + 3000;
                  let waiting = false;
                  while (!waiting && Date.now() < expires) {
                    waiting =
                      (
                        await h.pool.query<{ waiting: boolean }>(
                          "SELECT wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AS waiting FROM pg_stat_activity WHERE pid=$1",
                          [pid],
                        )
                      ).rows[0]?.waiting === true;
                    if (!waiting) await sleep(10);
                  }
                  assert.equal(
                    waiting,
                    true,
                    'Actual writer must wait for the retained head row lock',
                  );
                  assert.ok(
                    await records.directions(
                      w.reader.accountId,
                      w.author.accountId,
                      'direct_post',
                      tx,
                      read,
                    ),
                  );
                  read.assertCurrent(tx);
                } finally {
                  read.close();
                }
              },
              { isolationLevel: 'read committed' },
            );
            await update;
            await writer.query('COMMIT');
            await database.transaction(
              async (tx) => {
                enableSafetyRelationshipProof(tx);
                const read = new SearchReadContext(tx);
                try {
                  assert.equal(
                    await records.directions(
                      w.reader.accountId,
                      w.author.accountId,
                      'list_projection',
                      tx,
                      read,
                    ),
                    null,
                  );
                } finally {
                  read.close();
                }
              },
              { isolationLevel: 'read committed' },
            );
          } finally {
            await update?.catch(() => {});
            await writer.query('ROLLBACK');
            writer.release();
          }
        },
      );

      await t.test(
        'cached head expiry at a later consumed node and after successor insertion matches scalar failure',
        async () => {
          for (const boundary of ['later-candidate', 'cursor'] as const) {
            const errors: unknown[] = [];
            for (const useScalar of [false, true]) {
              const w = await h.world();
              const base = await w.envelope({ text: 'plain parent' });
              const [post] = await w.seed(1, () => base, { time: () => old });
              const rootBase = await childEnvelope(h, w, post!.id);
              const [root] = await seedChildren(
                h,
                'comment',
                1,
                () => rootBase,
                { time: () => old },
              );
              const replyBase = await childEnvelope(
                h,
                w,
                post!.id,
                root!.id,
                w.author,
                'needle descendant',
              );
              const replies = await seedChildren(
                h,
                'reply',
                4,
                () => replyBase,
                { time: at },
              );
              const expiresAt = new Date(Date.now() + 1200);
              await h.pool.query(
                'UPDATE whaleu_safety.account_heads SET valid_until=$2 WHERE account_id=$1',
                [w.reader.accountId, expiresAt],
              );
              const before = await cursorCount();
              let waited = false,
                inserted = false,
                readerHeads = 0,
                relationships = 0;
              h.observer.setHook(async (event) => {
                if (
                  event.sql.includes(headQuery) &&
                  event.values[0] === w.reader.accountId
                )
                  readerHeads++;
                if (event.sql.includes(relationshipQuery)) relationships++;
                if (
                  event.sql.includes(
                    'INSERT INTO whaleu_community.discovery_cursors',
                  )
                )
                  inserted = true;
                const laterNode =
                  event.sql.includes(
                    'SELECT * FROM whaleu_community.content_approval_bindings',
                  ) &&
                  event.values[0] === 'reply' &&
                  event.values[1] === replies[1]!.id;
                if (
                  !waited &&
                  (boundary === 'later-candidate'
                    ? laterNode
                    : event.sql === 'SET CONSTRAINTS ALL IMMEDIATE')
                ) {
                  assert.ok(
                    relationships >= 3,
                    'Earlier consumed ancestry must already have reused Safety coverage',
                  );
                  if (!useScalar) assert.equal(readerHeads, 1);
                  if (boundary === 'cursor') assert.equal(inserted, true);
                  waited = true;
                  await sleep(
                    Math.max(0, expiresAt.getTime() - Date.now()) + 40,
                  );
                }
              });
              try {
                const run = async () =>
                  await w.search({ type: 'reply', limit: '2' });
                const result = await (useScalar ? scalar(run) : run());
                failure(result, 503, 'COMMUNITY_UNAVAILABLE');
                errors.push({ ...result.body.error, requestId: null });
                assert.equal(waited, true);
                assert.equal(inserted, boundary === 'cursor');
                assert.equal(await cursorCount(), before);
                if (!useScalar) assert.equal(readerHeads, 1);
              } finally {
                h.observer.setHook(null);
              }
            }
            assert.deepEqual(errors[0], errors[1]);
          }
        },
      );

      await t.test(
        'real cursor quota wait cannot outlive reused coverage and commit a successor',
        async () => {
          for (const useScalar of [false, true]) {
            const w = await h.world();
            const base = await w.envelope({ text: 'needle quota' });
            await w.seed(4, () => base, { time: at });
            const expiresAt = new Date(Date.now() + 1500);
            await h.pool.query(
              'UPDATE whaleu_safety.account_heads SET valid_until=$2 WHERE account_id=$1',
              [w.reader.accountId, expiresAt],
            );
            const before = await cursorCount();
            const writer = await h.pool.connect();
            let result: ReturnType<typeof w.search> | undefined;
            let pending:
              Promise<Awaited<ReturnType<typeof w.search>>> | undefined;
            let inserted = false,
              readerHeads = 0;
            try {
              await writer.query('BEGIN');
              const pid = (
                await writer.query<{ pid: number }>(
                  'SELECT pg_backend_pid() pid',
                )
              ).rows[0]!.pid;
              await writer.query(
                'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                [
                  `whaleu:discovery:quota:v1:${discoveryCursorBucket(w.reader.accountId).hash}`,
                ],
              );
              h.observer.setHook(async (event) => {
                if (
                  event.sql.includes(headQuery) &&
                  event.values[0] === w.reader.accountId
                )
                  readerHeads++;
                if (
                  event.sql.includes(
                    'INSERT INTO whaleu_community.discovery_cursors',
                  )
                )
                  inserted = true;
              });
              const run = async () => {
                result = w.search({ limit: '2' });
                return await result;
              };
              pending = useScalar ? scalar(run) : run();
              let waiting = false;
              const limit = Date.now() + 3000;
              while (!waiting && Date.now() < limit) {
                waiting = (
                  await h.pool.query<{ waiting: boolean }>(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%hashtextextended%') waiting",
                    [pid],
                  )
                ).rows[0]!.waiting;
                if (!waiting) await sleep(10);
              }
              assert.equal(
                waiting,
                true,
                'Search must actually wait on its quota lock',
              );
              assert.equal(readerHeads, useScalar ? 2 : 1);
              await sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 40);
              await writer.query('ROLLBACK');
              failure(await pending, 503, 'COMMUNITY_UNAVAILABLE');
              assert.equal(
                inserted,
                true,
                'Final proof must roll back the already inserted successor',
              );
              assert.equal(await cursorCount(), before);
            } finally {
              await writer.query('ROLLBACK');
              await pending;
              h.observer.setHook(null);
              writer.release();
            }
          }
        },
      );

      await t.test(
        'raw block after repeated coverage reuse and cursor creation fails final proof and rolls storage back',
        async () => {
          const errors: unknown[] = [];
          for (const useScalar of [false, true]) {
            const w = await h.world();
            const base = await w.envelope({ text: 'plain parent' });
            const [post] = await w.seed(1, () => base, { time: () => old });
            const rootBase = await childEnvelope(h, w, post!.id);
            const [root] = await seedChildren(h, 'comment', 1, () => rootBase, {
              time: () => old,
            });
            const replyBase = await childEnvelope(
              h,
              w,
              post!.id,
              root!.id,
              w.author,
              'needle descendant',
            );
            await seedChildren(h, 'reply', 4, () => replyBase, { time: at });
            const before = await cursorCount();
            let block: string | undefined,
              readerHeads = 0,
              relationships = 0,
              finalFence = false;
            h.observer.setHook(async (event) => {
              if (
                event.sql.includes(headQuery) &&
                event.values[0] === w.reader.accountId
              )
                readerHeads++;
              if (event.sql.includes(relationshipQuery)) relationships++;
              if (
                event.sql ===
                'LOCK TABLE whaleu_safety.blocks IN SHARE MODE NOWAIT'
              )
                finalFence = true;
              if (
                !block &&
                event.sql.includes(
                  'INSERT INTO whaleu_community.discovery_cursors',
                )
              ) {
                assert.ok(relationships >= 6);
                if (!useScalar) assert.equal(readerHeads, 1);
                block = await h.writeBlock(w.reader, w.author);
              }
            });
            try {
              const run = async () =>
                await w.search({ type: 'reply', limit: '2' });
              const response = await (useScalar ? scalar(run) : run());
              failure(response, 503, 'COMMUNITY_UNAVAILABLE');
              errors.push({ ...response.body.error, requestId: null });
              assert.ok(block);
              assert.equal(finalFence, true);
              assert.equal(await cursorCount(), before);
            } finally {
              h.observer.setHook(null);
            }
            await h.writeBlock(w.reader, w.author, false, block!);
            const fresh = await w.search({ type: 'reply', limit: '2' });
            ok(fresh);
            assert.equal(fresh.body.items.length, 2);
          }
          assert.deepEqual(errors[0], errors[1]);
        },
      );

      await t.test(
        'reverse-only blocks and anonymous ancestry retain separate purpose-specific descendant decisions',
        async () => {
          const w = await h.world();
          const namedChild = await w.actor();
          const named = await w.envelope({ text: 'needle named parent' });
          const [namedPost] = await w.seed(1, () => named, {
            time: () => at(0),
          });
          const namedRootBase = await childEnvelope(
            h,
            w,
            namedPost!.id,
            null,
            w.author,
            'needle named root',
          );
          await seedChildren(h, 'comment', 1, () => namedRootBase, {
            time: () => at(1),
          });
          const anonymous = await w.envelope({
            text: 'needle anonymous parent',
            authorMode: 'anonymous',
          });
          const [anonPost] = await w.seed(1, () => anonymous, {
            time: () => at(2),
          });
          const anonymousRootBase = await childEnvelope(
            h,
            w,
            anonPost!.id,
            null,
            w.author,
            'needle anonymous root',
            'anonymous',
          );
          const [anonRoot] = await seedChildren(
            h,
            'comment',
            1,
            () => anonymousRootBase,
            { time: () => at(3) },
          );
          const replyBase = await childEnvelope(
            h,
            w,
            anonPost!.id,
            anonRoot!.id,
            namedChild,
            'needle named descendant',
          );
          const [reply] = await seedChildren(h, 'reply', 1, () => replyBase, {
            time: () => at(4),
          });
          await h.writeBlock(w.author, w.reader);
          await h.writeBlock(namedChild, w.reader);
          for (const outgoing of [false, true]) {
            if (outgoing) {
              await h.writeBlock(w.reader, w.author);
              await h.writeBlock(w.reader, namedChild);
            }
            const contextual = await w.search({ type: 'all', limit: '10' });
            const baseline = await scalar(
              async () => await w.search({ type: 'all', limit: '10' }),
            );
            ok(contextual);
            ok(baseline);
            assert.deepEqual(contextual.body, baseline.body);
            assert.deepEqual(
              new Set(
                contextual.body.items.map(
                  (item: { contentId: string }) => item.contentId,
                ),
              ),
              new Set(
                outgoing
                  ? [anonPost!.id, anonRoot!.id]
                  : [namedPost!.id, anonPost!.id, anonRoot!.id, reply!.id],
              ),
            );
          }
        },
      );

      await t.test(
        'off-page and sentinel unknown or expired named parent Safety heads remain entirely undemanded',
        async () => {
          const w = await h.world();
          const other = await w.actor();
          const base = await w.envelope({ text: 'plain parent' });
          const [firstPost, laterPost] = await w.seed(
            2,
            (i) => ({
              ...base,
              accountId: i === 0 ? w.author.accountId : other.accountId,
            }),
            { time: () => old },
          );
          const firstRootBase = await childEnvelope(h, w, firstPost!.id);
          const [firstRoot] = await seedChildren(
            h,
            'comment',
            1,
            () => firstRootBase,
            { time: () => old },
          );
          const laterRootBase = await childEnvelope(
            h,
            w,
            laterPost!.id,
            null,
            other,
          );
          const [laterRoot] = await seedChildren(
            h,
            'comment',
            1,
            () => laterRootBase,
            { time: () => old },
          );
          const firstBase = await childEnvelope(
            h,
            w,
            firstPost!.id,
            firstRoot!.id,
            w.author,
            'needle visible',
          );
          const [first] = await seedChildren(h, 'reply', 1, () => firstBase, {
            time: () => at(0),
          });
          const laterBase = await childEnvelope(
            h,
            w,
            laterPost!.id,
            laterRoot!.id,
            other,
            'needle unknown offpage',
          );
          const laterReplies = await seedChildren(
            h,
            'reply',
            129,
            () => laterBase,
            { time: (i) => at(i + 1) },
          );
          const forbidden = new Set([
            laterPost!.id,
            laterRoot!.id,
            ...laterReplies.map((row) => row.id),
          ]);
          for (const invalid of ['unknown', 'expired'] as const) {
            await h.pool.query(
              'UPDATE whaleu_safety.account_heads SET block_coverage=$2,valid_until=$3 WHERE account_id=$1',
              [
                other.accountId,
                invalid === 'unknown' ? 'missing' : 'complete',
                invalid === 'expired' ? new Date(0) : null,
              ],
            );
            for (const useScalar of [false, true]) {
              h.observer.setHook(async (event) => {
                if (event.sql.includes(headQuery))
                  assert.notEqual(
                    event.values[0],
                    other.accountId,
                    'Off-page Safety head trap',
                  );
                if (
                  event.sql.includes(
                    'WITH ORDINALITY AS r(viewer,author,bilateral,ordinality)',
                  )
                )
                  assert.equal(
                    (event.values[1] as string[]).includes(other.accountId),
                    false,
                    'Off-page final relationship trap',
                  );
                if (
                  /SELECT \* FROM whaleu_community\.(posts|root_comments|replies) WHERE id=/.test(
                    event.sql,
                  )
                )
                  assert.equal(
                    forbidden.has(String(event.values[0])),
                    false,
                    'Off-page body trap',
                  );
                if (
                  event.sql.includes(
                    'SELECT * FROM whaleu_community.content_approval_bindings',
                  )
                )
                  assert.equal(
                    forbidden.has(String(event.values[1])),
                    false,
                    'Off-page approval trap',
                  );
              });
              try {
                const run = async () =>
                  await w.search({ type: 'reply', limit: '1' });
                const response = await (useScalar ? scalar(run) : run());
                ok(response);
                assert.deepEqual(
                  response.body.items.map(
                    (item: { contentId: string }) => item.contentId,
                  ),
                  [first!.id],
                );
                assert.equal(response.body.continuation, 'more');
              } finally {
                h.observer.setHook(null);
              }
            }
            const contextual = await w.search({ type: 'reply', limit: '2' });
            const baseline = await scalar(
              async () => await w.search({ type: 'reply', limit: '2' }),
            );
            failure(contextual, 503, 'COMMUNITY_UNAVAILABLE');
            failure(baseline, 503, 'COMMUNITY_UNAVAILABLE');
            assert.deepEqual(
              { ...contextual.body.error, requestId: null },
              { ...baseline.body.error, requestId: null },
            );
          }
        },
      );
    } finally {
      await h.close();
    }
  },
);
