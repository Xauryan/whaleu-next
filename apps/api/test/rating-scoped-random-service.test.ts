import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RatingScopedRandomService,
  compareRatingScopedRandomLocators,
  ratingScopedRandomResponseSchema,
} from '../src/ratings/scoped/random.service.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { RatingNavigationSelector } from '../src/ratings/scoped/contracts.js';
import {
  scopedTestContext,
  scopedTestId as id,
  scopedTestSummary as summary,
  scopedTestTarget,
  scopedTestToken,
} from './rating-scoped-service-helpers.js';

type Dependencies = ConstructorParameters<typeof RatingScopedRandomService>;
function fixture(
  options: {
    deniedAnchor?: boolean;
    reviewUnknown?: boolean;
    categoryFound?: boolean;
    empty?: boolean;
    changedDuplicate?: boolean;
    changedReread?: boolean;
    proofFailure?: boolean;
    countMismatch?: boolean;
    unknownSummary?: boolean;
    globalOnly?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const context = {
    ...scopedTestContext(),
    purpose: 'random',
    protocolGeneration: id(1),
    selector: options.globalOnly
      ? { kind: 'global' }
      : { kind: 'institution_with_global', anchorCampusId: id(2) },
  };
  const makeScope = (
    selector: RatingNavigationSelector,
    generation: string,
    authorized = true,
  ) => ({ context, selector, protocolGeneration: generation, authorized });
  const global = makeScope({ kind: 'global' }, id(20)),
    anchor = makeScope(
      { kind: 'campus', campusId: id(2) },
      id(21),
      !options.deniedAnchor,
    ),
    other = makeScope({ kind: 'campus', campusId: id(22) }, id(23));
  const row = scopedTestTarget(),
    second = scopedTestTarget(id(30), id(31));
  const value = options.unknownSummary ? { status: 'unavailable' } : summary;
  const path = (scope: ReturnType<typeof makeScope>, target = row) => ({
    id: target.id,
    row: target,
    definition: target.definition,
    scope,
    summary: value,
    authorized: scope.authorized,
  });
  const paths = options.empty
    ? []
    : options.globalOnly
      ? [path(global)]
      : [path(global), path(other, second), path(other), path(anchor)];
  if (options.changedDuplicate && paths[3])
    paths[3] = { ...paths[3], row: { ...row, revision: id(99) } };
  const service = new RatingScopedRandomService(
    {
      transaction: async (fn: (tx: object) => Promise<unknown>) => fn({}),
    } as unknown as Dependencies[0],
    {
      resolveRandom: async () => ({
        actor: id(3),
        context,
        scopes: options.globalOnly ? [global] : [global, anchor, other],
      }),
    } as unknown as Dependencies[1],
    {
      enable() {},
      beginPool: async () => {
        calls.push('begin');
        return {};
      },
      nextPool: async () => ({ items: paths, done: true }),
      completePool: async () => {
        calls.push('complete');
        if (options.proofFailure)
          throw new ApplicationError('RATING_UNAVAILABLE');
        return {
          categoryFound: options.categoryFound ?? true,
          pathCount: paths.length + (options.countMismatch ? 1 : 0),
          targetCount: new Set(paths.map((path) => path.id)).size,
        };
      },
      target: async (_scope: unknown, targetId: string) => {
        calls.push('reread');
        const current = targetId === row.id ? row : second;
        return {
          row: options.changedReread
            ? { ...current, revision: id(99) }
            : current,
        };
      },
      retainAfter: async () => {
        calls.push('retain');
      },
    } as unknown as Dependencies[2],
    { enable() {}, summary: async () => value } as unknown as Dependencies[3],
    {
      authorModes: async () => ['named'],
      recheck: async () => {
        calls.push('recheck');
      },
    } as unknown as Dependencies[4],
    {
      currentDefinitionBatch: async (definitions: unknown[]) => {
        calls.push(`review:${definitions.length}`);
        return definitions.map(() => ({
          kind: options.reviewUnknown ? 'unavailable' : 'allow',
        }));
      },
    } as unknown as Dependencies[5],
    {
      navigation: async () => {
        calls.push('safety');
      },
    } as unknown as Dependencies[6],
    {
      qualifyTarget: async () => {
        calls.push('qualify');
      },
    } as unknown as Dependencies[7],
    {
      index: (size: number) => {
        assert(calls.includes('complete'));
        calls.push(`draw:${size}`);
        return 0;
      },
    } as unknown as Dependencies[8],
  );
  return {
    service,
    calls,
    context,
    global,
    anchor,
    other,
    query: {
      contextId: id(1),
      contextToken: scopedTestToken,
      categoryId: id(13),
    },
  };
}
test('scoped random deduplicates targets before entropy and uses selected-campus locator with its actual generation', async () => {
  const f = fixture(),
    response = await f.service.select('session', f.query);
  assert.equal(response.candidateCount, 2);
  assert(f.calls.includes('draw:2'));
  assert(f.calls.includes('review:4'));
  assert.deepEqual(response.item?.locator.selector, f.anchor.selector);
  assert.equal(response.context.protocolGeneration, id(1));
  assert.equal(response.item?.locator.protocolGeneration, id(21));
  assert.notEqual(
    response.item?.locator.protocolGeneration,
    response.context.protocolGeneration,
  );
  assert.equal(response.item?.target.id, id(10));
  assert(f.calls.indexOf('complete') < f.calls.indexOf('reread'));
  assert(f.calls.includes('retain'));
});
test('denied anchor path is excluded but institution peers and independent global still count once', async () => {
  const f = fixture({ deniedAnchor: true }),
    response = await f.service.select('session', f.query);
  assert.equal(response.candidateCount, 2);
  assert.deepEqual(response.item?.locator.selector, f.other.selector);
  assert(f.calls.includes('review:4'));
});
test('global-only random uses global path generation rather than aggregate generation', async () => {
  const f = fixture({ globalOnly: true }),
    response = await f.service.select('session', f.query);
  assert.equal(response.candidateCount, 1);
  assert.deepEqual(response.item?.locator.selector, { kind: 'global' });
  assert.equal(response.item?.locator.protocolGeneration, id(20));
  assert(ratingScopedRandomResponseSchema.safeParse(response).success);
  assert.equal(
    ratingScopedRandomResponseSchema.safeParse({
      ...response,
      item: {
        ...response.item,
        locator: { ...response.item!.locator, selector: f.anchor.selector },
      },
    }).success,
    false,
  );
});
test('valid empty scoped category differs from absent category and consumes no entropy', async () => {
  const empty = fixture({ empty: true }),
    response = await empty.service.select('session', empty.query);
  assert.equal(response.candidateCount, 0);
  assert.equal(response.item, null);
  assert.equal(
    empty.calls.some((call) => call.startsWith('draw:')),
    false,
  );
  const missing = fixture({ empty: true, categoryFound: false });
  await assert.rejects(
    () => missing.service.select('session', missing.query),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === 'RATING_NOT_FOUND',
  );
});
test('unknown proof, incomplete pool, conflicting duplicate facts and changed selected reread fail the entire draw', async () => {
  for (const options of [
    { reviewUnknown: true, deniedAnchor: true },
    { proofFailure: true },
    { countMismatch: true },
    { changedDuplicate: true },
    { changedReread: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(
      () => f.service.select('session', f.query),
      (error: unknown) =>
        error instanceof ApplicationError &&
        ['CONTENT_REVIEW_UNAVAILABLE', 'RATING_UNAVAILABLE'].includes(
          error.code,
        ),
    );
  }
});
test('minimum score uses existing exact statistics and unknown score never yields a partial filtered pool', async () => {
  const f = fixture({ unknownSummary: true });
  await assert.rejects(
    () => f.service.select('session', { ...f.query, minimumAverage: 4.9 }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'RATING_SCORE_UNAVAILABLE',
  );
});
test('locator tie-breaking is deterministic and independent of target sampling', () => {
  const anchor = { kind: 'campus' as const, campusId: id(2) },
    other = { kind: 'campus' as const, campusId: id(22) },
    global = { kind: 'global' as const };
  assert(compareRatingScopedRandomLocators(anchor, other, id(2)) < 0);
  assert(compareRatingScopedRandomLocators(other, global, id(2)) < 0);
});
