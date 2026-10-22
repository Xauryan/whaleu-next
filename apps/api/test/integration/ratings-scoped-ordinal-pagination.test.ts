import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import request from 'supertest';
import {
  ratingScopedFixture,
  type RatingScopedFixture,
} from '../support/rating-scoped-fixture.js';
import {
  prepareSyntheticOpaqueAdoption,
  writeSyntheticOpaqueAdoption,
} from '../support/rating-scoped-adoption-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  observeScopedOrdinalQueries,
  type ScopedOrdinalQueryTrace,
} from '../support/rating-scoped-ordinal-observer.js';
import type { RatingNavigationSelector } from '../../src/ratings/scoped/contracts.js';
import {
  ratingScopedCategoryPageSchema,
  ratingScopedTargetPageSchema,
} from '../../src/ratings/scoped/read.service.js';

type Candidate = { id: string; ordinal: string };
type PageTrace = {
  inputCursor: string | null;
  inputAfter: string | null;
  nextCursor: string | null;
  nextAfter: string | null;
  continuation: string;
  items: Candidate[];
  queries: ScopedOrdinalQueryTrace[];
};
const compareOrdinal = (a: Candidate, b: Candidate) =>
  BigInt(a.ordinal) < BigInt(b.ordinal)
    ? -1
    : BigInt(a.ordinal) > BigInt(b.ordinal)
      ? 1
      : 0;
const fixtureTargetId = (suffix: bigint): ReturnType<typeof randomUUID> =>
  `00000000-0000-4000-8000-${suffix.toString(16).padStart(12, '0')}`;

/** HTTP always supplies limit=2 and the actual opaque cursor returned by the
 * previous response. Reading its persisted position does not replace get/create.
 * No reconstructed token, direct repository bypass or precomputed page is used. */
async function traverse(
  f: RatingScopedFixture,
  t: TestContext,
  input: {
    kind: 'categories' | 'targets';
    selector: RatingNavigationSelector;
    filterId: string;
    candidates: Candidate[];
  },
) {
  const context = await f.scopedContext(f.creator, input.selector);
  const expected = [...input.candidates].sort(compareOrdinal);
  const byId = new Map(expected.map((row) => [row.id, row]));
  const pages: PageTrace[] = [];
  const observer = observeScopedOrdinalQueries(f.app);
  const cursorPosition = async (cursor: string | null) => {
    if (cursor === null) return null;
    const stored = (
      await f.pool.query<{ position: unknown }>(
        'SELECT position FROM whaleu_community.discovery_cursors WHERE cursor=$1',
        [cursor],
      )
    ).rows[0];
    assert.ok(stored, 'The returned opaque cursor must be really persisted');
    const position = stored.position as Record<string, unknown>;
    assert.equal(position['v'], 1);
    assert.equal(position['kind'], 'ratings');
    const after = position['after'];
    assert.equal(typeof after, 'string');
    assert.ok(typeof after === 'string' && /^(0|[1-9][0-9]*)$/.test(after));
    return after;
  };
  let cursor: string | null = null;
  try {
    for (;;) {
      // This bounds an erroneous repeating continuation, not the expected data.
      assert.ok(pages.length <= expected.length + 1, 'Cursor failed to end');
      const inputAfter = await cursorPosition(cursor);
      const offset = observer.queries.length;
      const response = await f
        .auth(request(f.http).get(`/v2/ratings/${input.kind}`), f.creator)
        .query({
          contextId: context.id,
          contextToken: context.token,
          limit: 2,
          ...(input.kind === 'categories'
            ? { parentId: input.filterId }
            : { categoryId: input.filterId }),
          ...(cursor === null ? {} : { cursor }),
        });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.match(response.headers['vary'] ?? '', /Authorization/i);
      const page =
        input.kind === 'categories'
          ? ratingScopedCategoryPageSchema.parse(response.body)
          : ratingScopedTargetPageSchema.parse(response.body);
      assert.equal(page.context.contextId, context.id);
      assert.equal(
        page.context.catalogRevision,
        context.heads[0]!.catalogRevision,
      );
      assert.deepEqual(page.context.selector, input.selector);
      assert.ok(page.items.length <= 2);
      const items = page.items.map((item) => {
        const expectedItem = byId.get(item.id);
        assert.ok(
          expectedItem,
          'Only qualified in-scope candidates may appear',
        );
        return expectedItem;
      });
      const nextAfter = await cursorPosition(page.nextCursor);
      const queries = observer.queries.slice(offset);
      pages.push({
        inputCursor: cursor,
        inputAfter,
        nextCursor: page.nextCursor,
        nextAfter,
        continuation: page.continuation,
        items,
        queries,
      });
      assert.ok(queries.length > 0, 'The real scoped repository was reached');
      assert.equal(queries[0]!.after, inputAfter);
      if (page.nextCursor !== null) {
        assert.equal(nextAfter, items.at(-1)!.ordinal);
        if (inputAfter !== null)
          assert.ok(BigInt(nextAfter!) > BigInt(inputAfter));
      }
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    const actual = pages.flatMap((page) => page.items);
    assert.equal(new Set(actual.map((row) => row.id)).size, actual.length);
    assert.deepEqual(
      actual,
      expected,
      'Numeric traversal must omit no candidate',
    );
    assert.equal(pages.at(-1)!.continuation, 'end');
    assert.equal(pages.at(-1)!.nextCursor, null);
    for (const [index, page] of pages.entries()) {
      assert.deepEqual(page.items, expected.slice(index * 2, index * 2 + 2));
      assert.equal(
        page.nextAfter,
        index < pages.length - 1 ? expected[index * 2 + 1]!.ordinal : null,
      );
    }
    return pages;
  } finally {
    observer.restore();
    // Synthetic IDs and opaque navigation references only, never login/context
    // credentials. This preserves the actual failing/succeeding cursor chain.
    t.diagnostic(JSON.stringify({ kind: input.kind, expected, pages }));
  }
}

test(
  'real PostgreSQL scoped ordinal traversal keeps numeric seek and public limit 2',
  { timeout: 600000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    const global: RatingNavigationSelector = { kind: 'global' };
    const campus: RatingNavigationSelector = {
      kind: 'campus',
      campusId: f.campusA,
    };
    const globalIds: string[] = [];
    const issue = async (
      name: string,
      ordinal: string,
      scopeKeys: string[],
      parentId: string | null = null,
      hidden = false,
    ) => {
      const category = await f.issueBase({
        name,
        ordinal,
        scopeKeys,
        parentId,
        level: parentId === null ? 1 : 2,
        hidden,
      });
      if (scopeKeys.includes('global')) globalIds.push(category.categoryId);
      return { id: category.categoryId, ordinal };
    };
    const smallRoot = await issue('Decimal boundary categories', '20000', [
      'global',
    ]);
    const small: Candidate[] = [];
    for (const ordinal of [
      '8',
      '9',
      '10',
      '11',
      '98',
      '99',
      '100',
      '101',
      '997',
      '1001',
    ])
      small.push(
        await issue(
          `Sparse ordinal ${ordinal}`,
          ordinal,
          ['global'],
          smallRoot.id,
        ),
      );
    const largeRoot = await issue('Exact bigint categories', '20001', [
      'global',
    ]);
    const large: Candidate[] = [];
    for (const ordinal of [
      '9007199254740992',
      '9007199254740993',
      '9007199254740997',
      '9007199254740999',
      '9999999999999999',
      '10000000000000000',
      '10000000000000001',
      '9223372036854775807',
    ])
      large.push(
        await issue(
          `Exact ordinal ${ordinal}`,
          ordinal,
          ['global'],
          largeRoot.id,
        ),
      );
    const filteredRoot = await issue('Filtered internal batches', '10000', [
      `campus:${f.campusA}`,
    ]);
    const filtered: Candidate[] = [];
    for (let ordinal = 1n; ordinal <= 136n; ordinal++) {
      const row = await issue(
        `Internal candidate ${ordinal}`,
        ordinal.toString(),
        [`campus:${f.campusA}`],
        filteredRoot.id,
        ordinal <= 130n,
      );
      if (ordinal > 130n) filtered.push(row);
    }
    await issue('Other campus must not leak', '9', [`campus:${f.campusB}`]);

    // Deterministic UUID placement gives a real compiled membership sequence
    // 0..20,22..41,43..105 for the primary category. Ordinals 21 and 42 belong
    // to another category, so both decimal boundaries and real gaps are covered.
    const targetIds: ReturnType<typeof randomUUID>[] = [];
    const expectedTargets: Candidate[] = [];
    for (let index = 0n; index < 104n; index++) {
      const id = fixtureTargetId(1000n + index * 2n);
      targetIds.push(id);
      expectedTargets.push({
        id,
        ordinal: (
          index +
          (index >= 21n ? 1n : 0n) +
          (index >= 41n ? 1n : 0n)
        ).toString(),
      });
    }
    const targetRootId = randomUUID();
    const roots = await f.catalog(f.creator, {
      count: targetIds.length,
      categoryIds: [targetRootId],
      targetIds,
    });
    const legacy = await f.catalog(f.creator, {
      count: 2,
      depth: 2,
      categoryIds: [targetRootId, randomUUID()],
      targetIds: [fixtureTargetId(1041n), fixtureTargetId(1081n)],
      sharedTargets: roots.targets.map((target) => ({
        id: target.id,
        categoryId: targetRootId,
      })),
    });
    for (const categoryId of legacy.categoryIds) {
      const prepared = await prepareSyntheticOpaqueAdoption(
        f,
        legacy.catalogId,
        categoryId,
        ['global'],
      );
      await withCommunityScopeWriter(f.pool, (tx) =>
        writeSyntheticOpaqueAdoption(tx, prepared),
      );
    }
    await f.declareAll();
    await f.declareScope('global', {
      categoryIds: [...globalIds, ...legacy.categoryIds].sort(),
      targetIds: [
        ...targetIds,
        ...legacy.targets.map((target) => target.id),
      ].sort(),
      legacyCatalogIds: [legacy.catalogId],
    });
    await f.capability();
    const published = await f.publish({ activate: true });
    const globalCatalog = published.outputs.find(
      (out) => out.scopeKey === 'global',
    )!;
    assert.deepEqual(
      globalCatalog.memberships
        .filter((row) => row.categoryId === targetRootId)
        .map((row) => ({ id: row.targetId, ordinal: row.ordinal })),
      expectedTargets,
      'The real compiler must establish the claimed sparse fixture ordinals',
    );

    await t.test(
      'B1 categories cross 9/10 and 99/100 with sparse numeric ordinals',
      async (t) => {
        const pages = await traverse(f, t, {
          kind: 'categories',
          selector: global,
          filterId: smallRoot.id,
          candidates: small,
        });
        assert.equal(pages[0]!.nextAfter, '9');
        assert.equal(pages[1]!.inputAfter, '9');
        assert.equal(pages[2]!.nextAfter, '99');
        assert.equal(pages[3]!.inputAfter, '99');
      },
    );
    await t.test(
      'B1 exact >2^53 and int8 maximum strings survive real cursor persistence',
      async (t) => {
        const pages = await traverse(f, t, {
          kind: 'categories',
          selector: global,
          filterId: largeRoot.id,
          candidates: large,
        });
        assert.equal(pages[0]!.nextAfter, '9007199254740993');
        assert.equal(pages[1]!.inputAfter, '9007199254740993');
        assert.equal(
          pages.at(-1)!.items.at(-1)!.ordinal,
          '9223372036854775807',
        );
      },
    );
    await t.test(
      'B1 hidden categories require a genuine >128 candidate scan',
      async (t) => {
        const pages = await traverse(f, t, {
          kind: 'categories',
          selector: campus,
          filterId: filteredRoot.id,
          candidates: filtered,
        });
        const first = pages[0]!.queries;
        assert.equal(first.length, 2);
        assert.equal(first[0]!.ordinals.length, 128);
        assert.equal(first[0]!.ordinals[0], '1');
        assert.equal(first[0]!.ordinals.at(-1), '128');
        assert.equal(first[1]!.after, '128');
        assert.equal(first[1]!.ordinals[0], '129');
        assert.equal(first[1]!.ordinals.at(-1), '136');
        assert.deepEqual(
          pages[0]!.items.map((row) => row.ordinal),
          ['131', '132'],
        );
      },
    );
    await t.test(
      'B2 real qualified targets cross 9/10 and 99/100 with category gaps',
      async (t) => {
        const pages = await traverse(f, t, {
          kind: 'targets',
          selector: global,
          filterId: targetRootId,
          candidates: expectedTargets,
        });
        for (const boundary of ['9', '99']) {
          const index = pages.findIndex((page) => page.nextAfter === boundary);
          assert.ok(index >= 0);
          assert.equal(pages[index + 1]!.inputAfter, boundary);
          assert.equal(
            pages[index + 1]!.items[0]!.ordinal,
            (BigInt(boundary) + 1n).toString(),
          );
        }
        assert.ok(
          expectedTargets.some(
            (row, index) =>
              index > 0 &&
              BigInt(row.ordinal) >
                BigInt(expectedTargets[index - 1]!.ordinal) + 1n,
          ),
        );
      },
    );
    await t.test(
      'catalog and category qualification still reject foreign-scope parents',
      async () => {
        const context = await f.scopedContext(f.creator, campus);
        const response = await f
          .auth(request(f.http).get('/v2/ratings/categories'), f.creator)
          .query({
            contextId: context.id,
            contextToken: context.token,
            parentId: smallRoot.id,
            limit: 2,
          });
        assert.equal(response.status, 404, JSON.stringify(response.body));
        assert.equal(response.body.error.code, 'RATING_NOT_FOUND');
      },
    );
  },
);
