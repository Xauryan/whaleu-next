import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import { startTransactionDeadlines } from '../src/database/transaction-deadlines.js';
import { RatingScopedReadService } from '../src/ratings/scoped/read.service.js';
import { RatingCategoryIconPublicController } from '../src/ratings/category-management/icon-public-controller.js';
import type { RatingScopedContextService } from '../src/ratings/scoped/context.service.js';

const id = (n: number) =>
  `97000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const query = { contextId: id(1), contextToken: 'a'.repeat(43), limit: 1 };
const category = {
  id: id(4),
  parent_id: null,
  level: 1,
  kind: 'general',
  system_key: null,
  name: 'Category',
  description: '',
  revision: id(5),
  ordinal: '7',
  active: true,
  hidden: false,
};
function fixture(rows = [category]) {
  const calls: { kind: string; values: unknown[] }[] = [];
  const tx = {
    query: async () => {
      throw new Error('Unit read must not bypass original repository');
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const scope = {
    actor: id(2),
    contextId: query.contextId,
    catalogRevision: id(3),
    headRevision: id(6),
    scopeRevision: 'b'.repeat(64),
    sourceDigest: 'b'.repeat(64),
    protocolGeneration: id(7),
    selector: { kind: 'global' },
    session: { sessionId: id(8) },
    catalog: { id: id(3), scopeKey: 'global', headRevision: id(6) },
    context: {
      id: query.contextId,
      token: query.contextToken,
      purpose: 'read',
      mode: 'public',
      sessionGeneration: 'b'.repeat(64),
    },
  };
  const state = { error: null as Error | null };
  const service = Object.create(
    RatingScopedReadService.prototype,
  ) as RatingScopedReadService;
  Object.assign(service, {
    database: {
      transaction: async (run: (tx: PoolClient) => Promise<unknown>) => run(tx),
    },
    contexts: {
      resolve: async (...values: unknown[]) => {
        calls.push({ kind: 'resolve', values });
        return scope;
      },
    },
    records: { enable: () => undefined, navigation: async () => 'records' },
    scoped: {
      enable: () => undefined,
      navigation: async () => 'scoped',
      retainAfter: async () => undefined,
      category: async (...values: unknown[]) => {
        calls.push({ kind: 'category', values });
        if (state.error) throw state.error;
        return category;
      },
      categories: async (...values: unknown[]) => {
        calls.push({ kind: 'categories', values });
        if (state.error) throw state.error;
        return rows;
      },
    },
    safety: { navigation: async () => 'safety' },
    review: { navigation: async () => 'review' },
    access: { recheck: async () => undefined },
    cursors: {
      get: async (...values: unknown[]) => {
        calls.push({ kind: 'cursor-get', values });
        return '3';
      },
      create: async (...values: unknown[]) => {
        calls.push({ kind: 'cursor-create', values });
        return 'c'.repeat(43);
      },
    },
  });
  return { service, calls, state };
}

test('legacy category list preserves the original DTO and cursor semantics', async () => {
  const f = fixture([category, { ...category, id: id(10), ordinal: '9' }]);
  const result = await f.service.categories('session', {
    ...query,
    cursor: 'd'.repeat(43),
  });
  assert.deepEqual(result.items, [
    {
      id: category.id,
      parentId: null,
      level: 1,
      kind: 'general',
      systemKey: null,
      name: category.name,
      description: '',
      revision: category.revision,
    },
  ]);
  assert.equal(result.continuation, 'more');
  assert.equal(result.nextCursor, 'c'.repeat(43));
  assert.deepEqual(f.calls.find((call) => call.kind === 'resolve')!.values[3], {
    purpose: 'read',
    protocolVersion: 2,
  });
  assert.deepEqual(
    f.calls.find((call) => call.kind === 'categories')!.values.slice(1, 4),
    [null, '3', 1],
  );
  assert.equal(
    f.calls.find((call) => call.kind === 'cursor-create')!.values[2],
    '7',
  );
});

test('public icon list uses exact protocol5 but shares the original empty-page scan boundary', async () => {
  const f = fixture([]),
    result = await f.service.categories('session', query, true);
  assert.equal(result.continuation, 'end');
  assert.equal(result.nextCursor, null);
  assert.deepEqual(result.items, []);
  assert.deepEqual(f.calls.find((call) => call.kind === 'resolve')!.values[3], {
    purpose: 'read',
    protocolVersion: 5,
  });
  assert.equal(f.calls.filter((call) => call.kind === 'categories').length, 1);
});

test('public list and detail do not replace an unqualified Category icon with null', async () => {
  for (const detail of [false, true]) {
    const f = fixture();
    await assert.rejects(
      detail
        ? f.service.categoryIcon('session', category.id, query)
        : f.service.categories('session', query, true),
      { code: 'RATING_SCOPE_UNAVAILABLE' },
    );
    assert.equal(
      f.calls.some(
        (call) => call.kind === (detail ? 'category' : 'categories'),
      ),
      true,
    );
  }
});

test('original Category owner denial is propagated before public icon projection', async () => {
  const f = fixture();
  f.state.error = new ApplicationError('RATING_NOT_FOUND');
  await assert.rejects(
    f.service.categoryIcon('session', category.id, query),
    (error) => error === f.state.error,
  );
});

test('native public routes delegate negotiation, explicit5 and categories without media-owner relabeling', () => {
  const calls: unknown[][] = [];
  const contexts = {
    createCategoryIconEntry: (...values: unknown[]) => {
      calls.push(['entry', ...values]);
      return 'entry';
    },
    createCategoryIcon: (...values: unknown[]) => {
      calls.push(['context', ...values]);
      return 'context';
    },
  } as unknown as RatingScopedContextService;
  const reads = {
    categories: (...values: unknown[]) => {
      calls.push(['categories', ...values]);
      return 'categories';
    },
    categoryIcon: (...values: unknown[]) => {
      calls.push(['category', ...values]);
      return 'category';
    },
  } as unknown as RatingScopedReadService;
  const controller = new RatingCategoryIconPublicController(contexts, reads);
  const request = {
    purpose: 'read' as const,
    mode: 'public' as const,
    selector: { kind: 'global' as const },
  };
  const token = `wu_a_${'a'.repeat(43)}`;
  controller.entryContext(`Bearer ${token}`, {}, request);
  controller.context(`Bearer ${token}`, {}, request);
  controller.categories(`Bearer ${token}`, query, undefined);
  controller.category(`Bearer ${token}`, category.id, query, undefined);
  assert.deepEqual(calls, [
    ['entry', token, request],
    ['context', token, request],
    ['categories', token, query, true],
    ['category', token, category.id, query],
  ]);
});
