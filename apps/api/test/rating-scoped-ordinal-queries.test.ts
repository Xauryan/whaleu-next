import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Exact query-shape units only. Real authorization, issuer provenance and SQL
// execution are covered separately by ratings-scoped-ordinal-pagination.test.ts.
// Do not manufacture a branded resolved scope to bypass repository guards here.
const source = readFileSync(
  new URL('../src/ratings/scoped/repository.ts', import.meta.url),
  'utf8',
);
function methodSource(name: string, nextName: string) {
  const start = source.indexOf(`  async ${name}(`);
  const end = source.indexOf(`  async ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function exactQuery(body: string, projection: string) {
  const queries = [...body.matchAll(/`([^`]*)`/g)]
    .map((match) => match[1]!.replace(/\s+/g, ' ').trim())
    .filter((query) => query.startsWith(projection));
  assert.equal(queries.length, 1);
  return queries[0]!;
}

test('scoped categories SQL keeps text output but qualifies numeric order and unchanged seek/batch', () => {
  const body = methodSource('categories', 'target');
  const query = exactQuery(body, 'SELECT category_id id,ordinal::text');
  assert.equal(
    query,
    'SELECT category_id id,ordinal::text FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND ($3::bigint IS NULL OR ordinal>$3::bigint) ORDER BY scoped_categories.ordinal LIMIT 128',
  );
  assert.match(body, /assertResolvedRatingScope\(scope, tx\)/);
  assert.match(body, /await this\.navigation\(tx\)/);
  assert.match(
    body,
    /if \(parentId\) await this\.category\(scope, parentId, tx\)/,
  );
  assert.match(body, /\[scope\.catalog\.id, parentId, cursor\]/);
  assert.match(body, /if \(evidence\.allowed\) result\.push\(evidence\.leaf\)/);
  assert.match(body, /BigInt\(next\) <= BigInt\(cursor\)/);
  assert.match(body, /if \(scanned > 10000\) unavailable\(\)/);
  assert.doesNotMatch(query, /ORDER BY ordinal\b/);
});

test('scoped target SQL keeps text output but qualifies numeric order and unchanged category/lookahead', () => {
  const body = methodSource('targets', 'subscriptionNavigation');
  const query = exactQuery(body, 'SELECT target_id id,ordinal::text');
  assert.equal(
    query,
    'SELECT target_id id,ordinal::text FROM whaleu_ratings.scoped_target_memberships WHERE catalog_id=$1 AND category_id=$2 AND ($3::bigint IS NULL OR ordinal>$3::bigint) ORDER BY scoped_target_memberships.ordinal LIMIT $4',
  );
  assert.match(body, /assertResolvedRatingScope\(scope, tx\)/);
  assert.match(body, /await this\.category\(scope, categoryId, tx\)/);
  assert.match(body, /\[scope\.catalog\.id, categoryId, after, limit \+ 1\]/);
  assert.doesNotMatch(query, /ORDER BY ordinal\b/);
});
