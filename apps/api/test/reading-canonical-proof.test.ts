/** Real canonical service + native retained epoch proofs with deterministic
 * upstream/SQL-result fixtures. Not PostgreSQL, Auth, or provider acceptance. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { TextSourceReadService } from '../src/community/text-source/read.service.js';
import type { CommunityRepository } from '../src/community/community.repository.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import type { ContentDefinitionRepository } from '../src/community/content-review/content-definition.repository.js';
import type { TextReviewRuntime } from '../src/community/text-review/runtime.js';
import {
  canonicalEnvelope,
  approvalDigest,
} from '../src/community/content-review/contracts.js';
import { formatSource } from '../src/community/reading-formatting/formatter.js';
import { reviewedTextSource } from '../src/community/text-source/protocol.js';
import { ApplicationError } from '../src/http/application-error.js';
import { readingCatalogSnapshotSql } from '../src/community/reading-formatting/catalog.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type FinalFailure = 'drift' | '55P03' | '57014' | '42P01' | 'rollback';
function fixture(
  changed?: 'community' | 'campus',
  missingM2 = false,
  finalFailure?: FinalFailure,
) {
  let finalPhase = false;
  let initiallyFormatted = false;
  const epochs = { community: 0, campus: 0 };
  const sqls: string[] = [];
  let rolledBack = false;
  const tx = {
    query: async (sql: string) => {
      sqls.push(sql);
      if (
        finalPhase &&
        finalFailure === 'rollback' &&
        sql === 'ROLLBACK TO SAVEPOINT optional_final_count_proof'
      )
        throw new Error('Fixture rollback failed');
      if (
        finalPhase &&
        finalFailure === '42P01' &&
        sql.startsWith('LOCK TABLE whaleu_community.reading_format_heads')
      )
        throw Object.assign(new Error('Fixture derived table dropped'), {
          code: '42P01',
        });
      if (
        sql.includes("current_setting('statement_timeout')") &&
        !sql.includes("current_setting('transaction_isolation')")
      )
        return { rows: [{ statement_timeout: '0', lock_timeout: '0' }] };
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              capacity: 32,
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.startsWith('SELECT slot,version,epoch::text')) {
        const owner = sql.includes('whaleu_community') ? 'community' : 'campus';
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: String(epochs[owner]),
          })),
        };
      }
      if (sql.startsWith('SELECT pg_try_advisory_xact_lock_shared'))
        return {
          rows: Array.from({ length: 128 }, () => ({ locked: true })),
        };
      if (sql.startsWith('SELECT pg_try_advisory_xact_lock'))
        return { rows: [{ locked: true }] };
      if (sql.includes('count(*)::integer FROM pg_class') && missingM2)
        return {
          rows: [
            {
              relations: 0,
              functions: 0,
              protocol: false,
              catalog: false,
              marker: null,
              catalogFunction: null,
            },
          ],
        };
      if (sql.includes('count(*)::integer FROM pg_class'))
        return {
          rows: [
            {
              relations: 8,
              functions: 13,
              protocol: true,
              catalog: true,
              catalogFunction: {
                body: readFileSync(
                  new URL(
                    '../migrations/0176_durable_reading_formatting.sql',
                    import.meta.url,
                  ),
                  'utf8',
                )
                  .split('AS $catalog$')[1]!
                  .split('$catalog$;')[0]!,
                stable: true,
                invoker: true,
                sql: true,
                config: ['search_path=pg_catalog'],
                scalar: true,
              },
              marker: {
                body: `SELECT '${JSON.stringify({ version: 1, formatter: 'plain-cjk-slices-v2', generation: 1, migration: '0176_durable_reading_formatting.sql', catalog: 'a'.repeat(64) })}'::jsonb`,
                immutable: true,
                invoker: true,
                sql: true,
                config: ['search_path=pg_catalog'],
                scalar: true,
                sameOwner: true,
              },
            },
          ],
        };
      if (sql === readingCatalogSnapshotSql) {
        if (
          finalPhase &&
          (finalFailure === '55P03' || finalFailure === '57014')
        )
          throw Object.assign(new Error('Fixture schema lookup cancellation'), {
            code: finalFailure,
          });
        return {
          rows: [
            {
              catalog: (finalPhase && finalFailure ? 'b' : 'a').repeat(64),
              slots: [1, 2],
              deparsePath: 'pg_catalog',
              searchPathRestored: true,
            },
          ],
        };
      }
      if (sql.startsWith('SELECT r.plan,') && finalFailure) {
        if (envelope.version !== 6)
          throw new Error('Fixture requires exact source envelope');
        const snapshot = {
          kind: 'post',
          id: id(6),
          sourceRevision: 1,
          sourceHash: envelope.textSource.sourceHash,
          publicationRequestId: id(7),
          text,
          descriptor: {
            version: 1,
            format: 'plain',
            readingFormatting: 'auto',
          },
        };
        const outcome = formatSource(snapshot);
        assert.equal(outcome.kind, 'plan');
        if (outcome.kind !== 'plan')
          throw new Error('Fixture source must be genuinely formattable');
        return {
          rows: [
            {
              plan: outcome.plan,
              client_request_id: id(7),
              source_hash: snapshot.sourceHash,
              evidence: ['fixture-derived-version-1'],
            },
          ],
        };
      }
      if (sql.startsWith('SELECT r.plan,'))
        throw Object.assign(
          new Error('Fixture optional derived-table lock conflict'),
          { code: '55P03' },
        );
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const text = ('鲸'.repeat(119) + '。').repeat(3);
  const envelope = canonicalEnvelope({
    version: 6,
    accountId: id(2),
    purpose: 'publish_post',
    spaceId: id(3),
    category: 'discussion',
    authorMode: 'named',
    commentsPolicy: 'open',
    allowAnonymousDm: false,
    postId: null,
    rootCommentId: null,
    targetReplyId: null,
    text,
    images: [],
    component: { kind: 'none' },
    trading: null,
    textSource: reviewedTextSource(
      text,
      { version: 1, format: 'plain', readingFormatting: 'auto' },
      'post',
    ),
    scope: {
      originalSpaceId: id(3),
      originalRegionId: id(4),
      authorOriginRegionId: id(4),
      identityRegionId: id(4),
      topologySnapshotId: null,
      sync: 'none',
    },
  });
  const accepted = {
    decisionId: id(5),
    digest: approvalDigest(envelope),
    envelope,
  };
  const repository = {
    database: {
      transaction: async <T>(operation: (tx: PoolClient) => Promise<T>) => {
        startTransactionDeadlines(tx);
        try {
          const result = await operation(tx);
          if (finalFailure) {
            assert.ok(
              typeof result === 'object' &&
                result !== null &&
                'presentation' in result,
            );
            const initial = result.presentation;
            assert.ok(typeof initial === 'object' && initial !== null);
            assert.ok('status' in initial);
            assert.equal(initial.status, 'formatted');
            assert.deepEqual(Object.keys(initial).sort(), ['plan', 'status']);
            initiallyFormatted = true;
            finalPhase = true;
          }
          if (changed) epochs[changed]++;
          await checkTransactionDeadlines(tx);
          return result;
        } catch (error) {
          rolledBack = true;
          throw error;
        } finally {
          clearTransactionDeadlines(tx);
        }
      },
    },
  } as unknown as CommunityRepository;
  const access = {
    actor: async () => id(1),
    accessiblePost: async () => {
      for (const owner of ['community', 'campus'])
        assert.ok(
          sqls.some((sql) =>
            sql.includes(`whaleu_${owner}.discovery_count_epochs`),
          ),
          `${owner} must be retained before canonical resource reads`,
        );
      return { post: { id: id(6), text } };
    },
  } as unknown as CommunityAccessService;
  const approvals = {
    binding: async () => ({ decision_id: id(5) }),
    current: async () => ({ kind: 'allow', value: accepted }),
  } as unknown as ApprovalRepository;
  const definitions = {
    current: async () => ({
      kind: 'allow',
      value: {
        envelope,
        authorAccountId: id(2),
        authorMode: 'named',
        parents: [],
        textSource: {
          decision_id: id(5),
          approval_digest: accepted.digest,
          account_id: id(2),
        },
      },
    }),
  } as unknown as ContentDefinitionRepository;
  return {
    service: new TextSourceReadService(
      repository,
      access,
      approvals,
      definitions,
      {} as TextReviewRuntime,
    ),
    sqls,
    rolledBack: () => rolledBack,
    initiallyFormatted: () => initiallyFormatted,
  };
}
for (const version of [1, 2] as const) {
  test(`canonical v${version} read retains native owners and permits unchanged source`, async () => {
    const f = fixture();
    const result =
      version === 1
        ? await f.service.source('fixture-token', 'post', id(6))
        : await f.service.sourceV2('fixture-token', 'post', id(6));
    assert.equal(result.version, version);
    assert.equal(f.rolledBack(), false);
    if (result.version === 2) {
      assert.equal(result.presentation.status, 'source');
      assert.ok(
        f.sqls.some((sql) => sql.startsWith('SELECT r.plan,')),
        'the intended optional row lookup was reached',
      );
      assert.ok(f.sqls.includes('ROLLBACK TO SAVEPOINT optional_reading'));
    }
    assert.ok(
      f.sqls.some((sql) =>
        sql.includes('LOCK TABLE whaleu_campus.discovery_count_epochs'),
      ),
    );
  });
  for (const owner of ['community', 'campus'] as const)
    test(`canonical v${version} ${owner} change remains mandatory across optional rollback`, async () => {
      const f = fixture(owner);
      await assert.rejects(
        version === 1
          ? f.service.source('fixture-token', 'post', id(6))
          : f.service.sourceV2('fixture-token', 'post', id(6)),
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.code === 'COMMUNITY_UNAVAILABLE',
      );
      assert.equal(f.rolledBack(), true);
      if (version === 2) {
        assert.ok(f.sqls.some((sql) => sql.startsWith('SELECT r.plan,')));
        assert.ok(f.sqls.includes('ROLLBACK TO SAVEPOINT optional_reading'));
      }
    });
}

test('missing entire M2 owner preserves genuine authorized source without a derived query', async () => {
  const f = fixture(undefined, true);
  const result = await f.service.sourceV2('fixture-token', 'post', id(6));
  assert.equal(result.presentation.status, 'source');
  assert.equal(
    result.source.text,
    '鲸'.repeat(119) + '。' + ('鲸'.repeat(119) + '。').repeat(2),
  );
  assert.equal(
    f.sqls.some((sql) => sql.startsWith('SELECT r.plan,')),
    false,
  );
  assert.equal(f.rolledBack(), false);
  assert.ok(
    f.sqls.some((sql) =>
      sql.includes('LOCK TABLE whaleu_campus.discovery_count_epochs'),
    ),
  );
});
for (const owner of ['community', 'campus'] as const)
  test(`missing M2 does not discard mandatory ${owner} proof`, async () => {
    const f = fixture(owner, true);
    await assert.rejects(
      f.service.sourceV2('fixture-token', 'post', id(6)),
      (e: unknown) =>
        e instanceof ApplicationError && e.code === 'COMMUNITY_UNAVAILABLE',
    );
    assert.equal(f.rolledBack(), true);
    assert.equal(
      f.sqls.some((sql) => sql.startsWith('SELECT r.plan,')),
      false,
    );
  });

for (const failure of ['drift', '55P03', '57014', '42P01'] as const)
  test(`successful formatted read retains exact canonical source after final M2 ${failure}`, async () => {
    const f = fixture(undefined, false, failure);
    const result = await f.service.sourceV2('fixture-token', 'post', id(6));
    assert.equal(f.initiallyFormatted(), true);
    assert.equal(result.presentation.status, 'source');
    assert.equal(result.source.text, ('鲸'.repeat(119) + '。').repeat(3));
    assert.equal(f.rolledBack(), false);
    assert.ok(
      f.sqls.includes('ROLLBACK TO SAVEPOINT optional_final_count_proof'),
    );
    assert.ok(
      f.sqls.some((sql) =>
        sql.includes('LOCK TABLE whaleu_campus.discovery_count_epochs'),
      ),
    );
  });
test('optional M2 final invalidity cannot swallow failed savepoint rollback', async () => {
  const f = fixture(undefined, false, 'rollback');
  await assert.rejects(
    f.service.sourceV2('fixture-token', 'post', id(6)),
    /Fixture rollback failed/,
  );
  assert.equal(f.initiallyFormatted(), true);
  assert.equal(f.rolledBack(), true);
});
for (const owner of ['community', 'campus'] as const)
  test(`successful initial formatting never overrides mandatory ${owner} final rejection`, async () => {
    const f = fixture(owner, false, 'drift');
    await assert.rejects(
      f.service.sourceV2('fixture-token', 'post', id(6)),
      (e: unknown) =>
        e instanceof ApplicationError && e.code === 'COMMUNITY_UNAVAILABLE',
    );
    assert.equal(f.initiallyFormatted(), true);
    assert.equal(f.rolledBack(), true);
  });
