import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { RatingScopedSourceFacade } from '../src/ratings/scoped/source.facade.js';
import { RatingScopedContentReviewFacade } from '../src/community/content-review/rating-scoped-content-review.facade.js';
import { RatingCategoryContentReviewFacade } from '../src/community/content-review/rating-category-content-review.facade.js';
import { RatingScopedCompilationBudget } from '../src/ratings/scoped/compiler.js';
import type { ScopedCompilationInput } from '../src/ratings/scoped/compiler.js';

test('whole-release inputs are admitted before accumulation and charged once across source and compiler stages', () => {
  const budget = new RatingScopedCompilationBudget();
  const input: ScopedCompilationInput = {
    scopeKey: 'global',
    regionId: null,
    campusId: null,
    sourceVector: [],
    categories: [{}],
    memberships: [],
    validUntil: new Date(),
    before: null,
  };
  budget.observeInput(input);
  const before = budget.snapshot();
  budget.observeInput(input);
  assert.deepEqual(budget.snapshot(), before);
  assert.equal(before.categories, 1);
  assert.equal(before.scopes, 1);
  budget.observe({}, { categories: 99999 });
  assert.throws(() => budget.observeInput({ ...input, scopeKey: 'another' }), {
    code: 'RATING_UNAVAILABLE',
  });
});

test('scoped source admission rejects aggregate row/byte overflow before materializing any source payload', async () => {
  for (const admission of [
    { count: '100001', bytes: '1' },
    { count: '2', bytes: '67108865' },
    { count: 'x', bytes: '2' },
  ]) {
    const calls: string[] = [];
    const tx = {
      query: async (sql: string) => {
        calls.push(sql);
        assert.match(sql, /sum\(pg_column_size\(s\)\)/);
        return { rows: [admission] };
      },
    } as unknown as PoolClient;
    const facade = new RatingScopedSourceFacade(
      new RatingScopedContentReviewFacade(),
      new RatingCategoryContentReviewFacade(),
    );
    await assert.rejects(facade.readExactSourceVector(['global'], tx), {
      code: 'RATING_SCOPE_UNAVAILABLE',
    });
    assert.equal(
      calls.length,
      1,
      'No unbounded source SELECT may run after failed admission',
    );
  }
});
test('compiler admission ledger is whole-affected-set and rejects rather than truncating the final scope', () => {
  const categories = new RatingScopedCompilationBudget();
  categories.observe({}, { categories: 100000 });
  assert.throws(() => categories.observe({}, { categories: 1 }), {
    code: 'RATING_UNAVAILABLE',
  });
  const members = new RatingScopedCompilationBudget();
  members.observe({}, { members: 99999 });
  members.observe({}, { members: 1 });
  assert.throws(() => members.observe({}, { members: 1 }), {
    code: 'RATING_UNAVAILABLE',
  });
  const scopes = new RatingScopedCompilationBudget();
  scopes.observe({}, { scopes: 1001 });
  assert.throws(() => scopes.observe({}, { scopes: 1 }), {
    code: 'RATING_UNAVAILABLE',
  });
});
