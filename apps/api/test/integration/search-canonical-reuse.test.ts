import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../../src/database/transaction-deadlines.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { SearchService } from '../../src/community/search/service.js';
import { withScalarCanonicalReads } from '../support/search-scalar-canonical.js';
import { withScalarSearchSafetyHeads } from '../support/search-scalar-safety.js';
import { SafetyRepository } from '../../src/safety/repository.js';
import { setReviewState } from '../support/community-approval-fixtures.js';
import { searchHarness, ok, failure } from './search-fixtures.js';
import { childEnvelope, seedChildren } from './discussion-search-fixtures.js';
import { trading } from './federated-search-fixtures.js';

const old = '2026-09-01T00:00:00.000000Z';
const at = (i: number) =>
  `2026-10-01T00:00:00.${String(999999 - i).padStart(6, '0')}Z`;

test(
  'search canonical context: lazy scalar equivalence and mandatory finalization',
  { timeout: 120000 },
  async (t) => {
    const h = await searchHarness();
    const scalar = <T>(operation: () => Promise<T>) =>
      withScalarCanonicalReads(h.app.get(SearchService), operation);
    try {
      await t.test(
        'plain/trading/poll/formation, named/anonymous/self/guest pages and logical cursors equal scalar owners',
        async () => {
          const w = await h.world();
          await w.publish({ text: 'needle plain' });
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
        },
      );

      await t.test(
        'off-page and sentinel unknown approvals never hydrate or poison a full earlier page',
        async () => {
          const w = await h.world();
          const base = await w.envelope({
            text: 'plain parent',
            authorMode: 'anonymous',
          });
          const [post] = await w.seed(1, () => base, { time: () => old });
          const rootBase = await childEnvelope(
            h,
            w,
            post!.id,
            null,
            w.author,
            'plain root',
            'anonymous',
          );
          const [root] = await seedChildren(h, 'comment', 1, () => rootBase, {
            time: () => old,
          });
          const replyBase = await childEnvelope(
            h,
            w,
            post!.id,
            root!.id,
            w.reader,
            'needle visible reply',
          );
          const [first] = await seedChildren(h, 'reply', 1, () => replyBase, {
            time: () => at(0),
          });
          const expiresAt = new Date(Date.now() + 100);
          const offpage = await seedChildren(
            h,
            'reply',
            129,
            () => ({ ...replyBase, text: 'needle unknown offpage' }),
            { time: (i) => at(i + 1), visibilityUntil: expiresAt },
          );
          await sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 25);
          const forbidden = new Set(offpage.map((row) => row.id));
          for (const useScalar of [false, true]) {
            const readIds = new Set<string>();
            h.observer.setHook(async (event) => {
              if (
                /SELECT \* FROM whaleu_community\.(posts|root_comments|replies) WHERE id=/.test(
                  event.sql,
                )
              ) {
                const id = String(event.values[0]);
                assert.equal(
                  forbidden.has(id),
                  false,
                  'Unconsumed reply body trap',
                );
                readIds.add(id);
              }
              if (
                event.sql.includes(
                  'FROM whaleu_community.content_approval_bindings',
                )
              )
                assert.equal(
                  forbidden.has(String(event.values[1])),
                  false,
                  'Unconsumed approval trap',
                );
            });
            try {
              const run = async () =>
                await w.search({ type: 'reply', limit: '1' });
              const result = await (useScalar ? scalar(run) : run());
              ok(result);
              assert.deepEqual(
                result.body.items.map(
                  (hit: { contentId: string }) => hit.contentId,
                ),
                [first!.id],
              );
              assert.equal(result.body.continuation, 'more');
              assert.deepEqual(
                readIds,
                new Set([post!.id, root!.id, first!.id]),
              );
            } finally {
              h.observer.setHook(null);
            }
          }
          const contextError = await w.search({ type: 'reply', limit: '2' });
          const scalarError = await scalar(
            async () => await w.search({ type: 'reply', limit: '2' }),
          );
          failure(contextError, 503, 'COMMUNITY_UNAVAILABLE');
          failure(scalarError, 503, 'COMMUNITY_UNAVAILABLE');
          assert.deepEqual(
            { ...contextError.body.error, requestId: null },
            { ...scalarError.body.error, requestId: null },
          );
        },
      );

      await t.test(
        'cached ancestor deadline survives multiple descendants and rolls back a successor',
        async () => {
          const w = await h.world(),
            base = await w.envelope({ text: 'plain expiring parent' });
          const expiresAt = new Date(Date.now() + 2200);
          const [post] = await w.seed(1, () => base, {
            time: () => old,
            visibilityUntil: expiresAt,
          });
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
          const count = async () =>
            (
              await h.pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
              )
            ).rows[0]!.n;
          const before = await count();
          let parentBindings = 0,
            inserted = false;
          h.observer.setHook(async (event) => {
            if (
              event.sql.includes(
                'SELECT * FROM whaleu_community.content_approval_bindings',
              ) &&
              event.values[0] === 'post' &&
              event.values[1] === post!.id
            )
              parentBindings++;
            if (
              event.sql.includes(
                'INSERT INTO whaleu_community.discovery_cursors',
              )
            )
              inserted = true;
            if (event.sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
              assert.equal(inserted, true);
              assert.equal(parentBindings, 1);
              await sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 50);
            }
          });
          try {
            failure(
              await w.search({ type: 'reply', limit: '2' }),
              503,
              'COMMUNITY_UNAVAILABLE',
            );
            assert.equal(inserted, true);
            assert.equal(await count(), before);
          } finally {
            h.observer.setHook(null);
          }
        },
      );

      await t.test(
        'late checkpoint restoration after cursor insertion invalidates the entire search',
        async () => {
          const w = await h.world(),
            base = await w.envelope({ text: 'needle parent' });
          await w.seed(3, () => base, {
            time: at,
            visibilityUntil: new Date(Date.now() + 60000),
          });
          const count = async () =>
            (
              await h.pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
              )
            ).rows[0]!.n;
          const before = await count();
          let checkpoint:
            ReturnType<typeof checkpointTransactionDeadlines> | undefined;
          let restored = false;
          h.observer.setHook(async (event, tx) => {
            if (
              !checkpoint &&
              event.sql.includes(
                'SELECT * FROM whaleu_community.content_approval_bindings',
              )
            )
              checkpoint = checkpointTransactionDeadlines(tx);
            if (
              event.sql.includes(
                'INSERT INTO whaleu_community.discovery_cursors',
              )
            ) {
              assert.ok(checkpoint);
              restoreTransactionDeadlines(tx, checkpoint);
              restored = true;
            }
          });
          try {
            failure(
              await w.search({ limit: '2' }),
              503,
              'COMMUNITY_UNAVAILABLE',
            );
            assert.equal(restored, true);
            assert.equal(await count(), before);
          } finally {
            h.observer.setHook(null);
          }
        },
      );

      await t.test(
        'raw block after cached ancestry fails final proof; fresh transaction observes revoke and source deletion',
        async () => {
          const w = await h.world(),
            base = await w.envelope({ text: 'plain parent' });
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
          const count = async () =>
            (
              await h.pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
              )
            ).rows[0]!.n;
          const before = await count();
          let block: string | undefined,
            parentBindings = 0;
          h.observer.setHook(async (event) => {
            if (
              event.sql.includes(
                'SELECT * FROM whaleu_community.content_approval_bindings',
              ) &&
              event.values[0] === 'post'
            )
              parentBindings++;
            if (
              !block &&
              event.sql.includes(
                'INSERT INTO whaleu_community.discovery_cursors',
              )
            ) {
              assert.equal(parentBindings, 1);
              block = await h.writeBlock(w.reader, w.author);
            }
          });
          try {
            failure(
              await w.search({ type: 'reply', limit: '2' }),
              503,
              'COMMUNITY_UNAVAILABLE',
            );
            assert.ok(block);
            assert.equal(await count(), before);
          } finally {
            h.observer.setHook(null);
          }
          await h.writeBlock(w.reader, w.author, false, block!);
          const allowed = await w.search({ type: 'reply', limit: '2' });
          ok(allowed);
          assert.equal(allowed.body.items.length, 2);
          await setReviewState(h.pool, root!.decision, 'revoked');
          const denied = await w.search({ type: 'reply', limit: '2' });
          const scalarDenied = await scalar(
            async () => await w.search({ type: 'reply', limit: '2' }),
          );
          ok(denied);
          ok(scalarDenied);
          assert.deepEqual(denied.body, scalarDenied.body);
          assert.deepEqual(denied.body.items, []);
          await h.mutate((tx) =>
            tx.query(
              'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE id=$1',
              [post!.id],
            ),
          );
          const deleted = await w.search({ type: 'reply' });
          ok(deleted);
          assert.deepEqual(deleted.body.items, []);
        },
      );
      await t.test(
        'fragmented parents and authors measure actual canonical owner reads without hydrating the sentinel',
        async () => {
          const w = await h.world(),
            authors = [w.author];
          for (let i = 1; i < 16; i++) authors.push(await w.actor());
          const base = await w.envelope({ text: 'plain parent' });
          const posts = await w.seed(
            129,
            (i) => ({
              ...base,
              accountId: authors[i % authors.length]!.accountId,
            }),
            { time: () => old },
          );
          const rootBase = await childEnvelope(h, w, posts[0]!.id);
          const roots = await seedChildren(
            h,
            'comment',
            129,
            (i) => ({
              ...rootBase,
              postId: posts[i]!.id,
              accountId: authors[i % authors.length]!.accountId,
            }),
            { time: () => old },
          );
          const replyBase = await childEnvelope(
            h,
            w,
            posts[0]!.id,
            roots[0]!.id,
          );
          const replies = await seedChildren(
            h,
            'reply',
            129,
            (i) => ({
              ...replyBase,
              postId: posts[i]!.id,
              rootCommentId: roots[i]!.id,
              accountId: authors[i % authors.length]!.accountId,
            }),
            { time: at },
          );
          const run = async () =>
            await w.search({ type: 'reply', q: 'absent' });
          ok(await run());
          const counts = new Map<string, number>();
          const anchors = new Map<string, number>();
          const safetyHeads = new Map<string, number>();
          const contextualStatements: string[] = [];
          const authorIds = new Set(authors.map((author) => author.accountId));
          const forbidden = new Set([
            posts[128]!.id,
            roots[128]!.id,
            replies[128]!.id,
          ]);
          h.observer.setHook(async (event) => {
            contextualStatements.push(event.sql);
            if (event.sql.includes('FROM whaleu_safety.account_heads')) {
              const id = String(event.values[0]);
              safetyHeads.set(id, (safetyHeads.get(id) ?? 0) + 1);
            }
            if (
              event.sql.includes(
                'SELECT * FROM whaleu_community.content_approval_bindings',
              )
            ) {
              const key = `${event.values[0]}:${event.values[1]}`;
              assert.equal(forbidden.has(String(event.values[1])), false);
              counts.set(key, (counts.get(key) ?? 0) + 1);
            }
            if (
              /SELECT \* FROM whaleu_community\.(posts|root_comments|replies) WHERE id=/.test(
                event.sql,
              )
            )
              assert.equal(forbidden.has(String(event.values[0])), false);
            if (
              event.sql ===
                'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE' &&
              authorIds.has(String(event.values[0]))
            ) {
              const id = String(event.values[0]);
              anchors.set(id, (anchors.get(id) ?? 0) + 1);
            }
          });
          let contextual;
          try {
            contextual = await h.observer.measure(
              'fragmented canonical context',
              run,
            );
          } finally {
            h.observer.setHook(null);
          }
          const baseline = await scalar(() =>
            h.observer.measure('fragmented scalar canonical and Safety', run),
          );
          ok(contextual.value);
          ok(baseline.value);
          assert.deepEqual(
            { ...contextual.value.body, nextCursor: null },
            { ...baseline.value.body, nextCursor: null },
          );
          assert.deepEqual(
            await h.position(contextual.value.body.nextCursor),
            await h.position(baseline.value.body.nextCursor),
          );
          assert.equal(contextual.value.body.continuation, 'scan_pending');
          assert.equal(counts.size, 384);
          assert.ok([...counts.values()].every((count) => count === 1));
          assert.equal(anchors.size, 16);
          assert.ok([...anchors.values()].every((count) => count === 1));
          assert.ok(
            contextual.measurement.queries < baseline.measurement.queries,
          );
          const scalarSafetyStatements: string[] = [];
          h.observer.setHook(async (event) => {
            scalarSafetyStatements.push(event.sql);
          });
          let scalarSafety;
          try {
            scalarSafety = await withScalarSearchSafetyHeads(
              h.app.get(SafetyRepository),
              () => h.observer.measure('fragmented scalar Safety heads', run),
            );
          } finally {
            h.observer.setHook(null);
          }
          ok(scalarSafety.value);
          assert.deepEqual(
            { ...scalarSafety.value.body, nextCursor: null },
            { ...contextual.value.body, nextCursor: null },
          );
          assert.deepEqual(
            await h.position(scalarSafety.value.body.nextCursor),
            await h.position(contextual.value.body.nextCursor),
          );
          assert.equal(safetyHeads.size, 17);
          assert.ok([...safetyHeads.values()].every((count) => count === 1));
          const withoutHeads = (statements: string[]) =>
            statements.filter(
              (sql) => !sql.includes('FROM whaleu_safety.account_heads'),
            );
          assert.deepEqual(
            withoutHeads(contextualStatements),
            withoutHeads(scalarSafetyStatements),
          );
          const safetyHeadReads = scalarSafetyStatements.filter((sql) =>
            sql.includes('FROM whaleu_safety.account_heads'),
          ).length;
          assert.equal(safetyHeadReads, 512);
          assert.equal(
            scalarSafety.measurement.queries - contextual.measurement.queries,
            495,
          );
          t.diagnostic(
            JSON.stringify({
              label: 'fragmented 128 consumed reply chains, 16 authors',
              canonicalNodes: counts.size,
              approvalAccounts: anchors.size,
              contextQueries: contextual.measurement.queries,
              scalarOwnerQueries: baseline.measurement.queries,
              contextMs: contextual.measurement.durationMs,
              scalarOwnerMs: baseline.measurement.durationMs,
              safetyHeads: safetyHeads.size,
              scalarSafetyHeadReads: safetyHeadReads,
              scalarSafetyQueries: scalarSafety.measurement.queries,
              scalarSafetyMs: scalarSafety.measurement.durationMs,
              safetyHeadSavedStatements:
                scalarSafety.measurement.queries -
                contextual.measurement.queries,
              safetyRelationshipQueries: contextualStatements.filter((sql) =>
                sql.includes(
                  'SELECT EXISTS(SELECT 1 FROM whaleu_safety.blocks',
                ),
              ).length,
              databaseClocks: contextualStatements.filter(
                (sql) => sql === 'SELECT clock_timestamp() AS now',
              ).length,
            }),
          );
        },
      );
    } finally {
      await h.close();
    }
  },
);
