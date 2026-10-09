import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { RatingRandomService } from '../src/ratings/random/service.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { RatingSummary } from '../src/ratings/contracts.js';
import type { CurrentTargetRow } from '../src/ratings/repository.js';
import {
  canonicalRatingTargetDefinition,
  type RatingTargetDefinitionDescriptor,
} from '../src/community/content-review/rating-target-definition-contracts.js';
type Dependencies = ConstructorParameters<typeof RatingRandomService>;
function fixture(
  options: {
    minimumUnknown?: boolean;
    denied?: boolean;
    failRegion?: boolean;
    missingCatalog?: boolean;
    failProof?: boolean;
    duplicatePath?: boolean;
    changedDuplicate?: 'lifecycle' | 'definition';
    changedReread?: 'lifecycle' | 'definition';
  } = {},
) {
  const accountId = randomUUID(),
    campusId = randomUUID(),
    categoryId = randomUUID(),
    regionId = randomUUID(),
    globalId = randomUUID(),
    regionalId = randomUUID();
  const calls: string[] = [];
  const row = (
    id: string,
    region: string | null,
    catalogRevision: string,
  ): CurrentTargetRow => {
    const appliedTargetRevision = randomUUID();
    const envelope = {
      version: 1,
      accountId,
      purpose: 'publish_rating_target',
      clientRequestId: randomUUID(),
      targetId: id,
      targetRevision: appliedTargetRevision,
      categoryId,
      categoryRevision: randomUUID(),
      catalogRevision,
      scope: { regionId: region },
      assetIds: [],
      name: 'Target',
      description: '',
    };
    const definition = canonicalRatingTargetDefinition({
      targetId: id,
      contentVersion: 1,
      definitionRevision: appliedTargetRevision,
      appliedTargetRevision,
      envelope,
    });
    return {
      id,
      category_id: categoryId,
      creator_id: accountId,
      region_id: region,
      active: true,
      revision: randomUUID(),
      name: 'Target',
      description: '',
      envelope: definition.envelope,
      definition,
    };
  };
  const changed = (
    value: CurrentTargetRow,
    kind: 'lifecycle' | 'definition',
  ) => {
    if (kind === 'lifecycle') return { ...value, revision: randomUUID() };
    const appliedTargetRevision = randomUUID();
    const definition = canonicalRatingTargetDefinition({
      ...value.definition,
      definitionRevision: appliedTargetRevision,
      appliedTargetRevision,
      envelope: { ...value.envelope, targetRevision: appliedTargetRevision },
    });
    return { ...value, definition, envelope: definition.envelope };
  };
  const rows = [
    row(randomUUID(), null, globalId),
    row(randomUUID(), regionId, regionalId),
  ];
  const summary: RatingSummary = {
    status: 'known',
    count: 0,
    sum: 0,
    average: null,
    distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    revision: randomUUID(),
  };
  const database = {
    transaction: async (fn: (tx: object) => Promise<unknown>) => fn({}),
  };
  const access = {
    resolve: async () => ({ session: { accountId } }),
    resolveAccount: async (_a: string, r: string) => {
      calls.push(`authorize:${r}`);
      if (options.failRegion)
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    },
    authorModes: async () => ['named'],
    recheck: async () => {
      calls.push('recheck');
    },
  };
  const records = {
    enable: () => {},
    navigation: async () => {},
    catalog: async (r: string | null) => {
      calls.push(`catalog:${r}`);
      if (options.missingCatalog && r)
        throw new ApplicationError('RATING_UNAVAILABLE');
      return { id: r ? regionalId : globalId, regionId: r };
    },
    category: async () => {},
    target: async (_c: unknown, id: string) => {
      const current = rows.find((r) => r.id === id)!;
      return {
        row: options.changedReread
          ? changed(current, options.changedReread)
          : current,
      };
    },
    summary: async (id: string) => {
      calls.push(`summary:${id}`);
      return options.minimumUnknown ? { status: 'unavailable' } : summary;
    },
  };
  let scopes: (string | null)[] = [];
  const random = {
    capture: async () => ({}),
    prepare: async (_pool: unknown, regions: (string | null)[]) => {
      if (options.missingCatalog)
        throw new ApplicationError('RATING_UNAVAILABLE');
      scopes = regions;
    },
    next: async () => {
      calls.push('enumerate');
      const items = scopes.map((region) => ({
        row: rows[region ? 1 : 0]!,
        definition: rows[region ? 1 : 0]!.definition,
        catalog: { id: region ? regionalId : globalId, regionId: region },
        summary: options.minimumUnknown ? { status: 'unavailable' } : summary,
      }));
      if (options.duplicatePath) items.push(items[0]!);
      if (options.changedDuplicate) {
        const current = changed(items[0]!.row, options.changedDuplicate);
        items.push({
          ...items[0]!,
          row: current,
          definition: current.definition,
        });
      }
      return { items, done: true };
    },
    complete: async () => {
      calls.push('pool-complete');
      if (options.failProof) throw new ApplicationError('RATING_UNAVAILABLE');
    },
  };
  const campus = {
    resolve: async (id: string) => {
      assert.equal(id, campusId);
      calls.push('campus');
      return { regionIds: [regionId] };
    },
  };
  const review = {
    begin: async () => ({}),
    validateBatch: async (batch: { items: unknown[] }) =>
      batch.items.map(() => {
        calls.push('batch-review');
        return options.denied ? 'deny' : 'allow';
      }),
    complete: async () => {
      calls.push('review-complete');
    },
    navigation: async () => {},
    currentTargetDefinition: async (
      definition: RatingTargetDefinitionDescriptor,
    ) => {
      calls.push(`review:${definition.targetId}`);
      return { kind: options.denied ? 'deny' : 'allow' };
    },
  };
  const safety = { navigation: async () => {} };
  const service = new RatingRandomService(
    database as unknown as Dependencies[0],
    access as unknown as Dependencies[1],
    records as unknown as Dependencies[2],
    random as unknown as Dependencies[3],
    campus as unknown as Dependencies[4],
    review as unknown as Dependencies[5],
    safety as unknown as Dependencies[6],
    {
      index: (size: number) => {
        assert.ok(calls.includes('pool-complete'));
        assert.ok(calls.includes('review-complete'));
        calls.push('draw');
        return size - 1;
      },
    } as unknown as Dependencies[7],
  );
  return { service, campusId, categoryId, regionId, calls, rows };
}
test('global default never resolves or guesses a campus; returned context is actually read', async () => {
  const f = fixture();
  const response = await f.service.select('token', {
    categoryId: f.categoryId,
  });
  assert.equal(response.context.campusId, null);
  assert.equal(response.item?.regionId, null);
  assert.equal(response.candidateCount, 1);
  assert.equal(f.calls.includes('campus'), false);
  assert.equal(f.calls.at(-1), 'recheck');
});
test('explicit campus authorizes every region before enumeration and includes global', async () => {
  const f = fixture();
  const response = await f.service.select('token', {
    categoryId: f.categoryId,
    campusId: f.campusId,
  });
  assert.equal(response.candidateCount, 2);
  assert.ok(
    f.calls.indexOf(`authorize:${f.regionId}`) < f.calls.indexOf('enumerate'),
  );
  assert.equal(f.calls.filter((c) => c === 'batch-review').length, 2);
  assert.equal(f.calls.filter((c) => c.startsWith('summary:')).length, 1);
  assert.equal(
    response.item?.regionId,
    response.item?.target.id === f.rows[0]!.id ? null : f.regionId,
  );
});
test('unauthorized sibling and missing catalog fail rather than narrowing the requested scope', async () => {
  for (const options of [{ failRegion: true }, { missingCatalog: true }]) {
    const f = fixture(options);
    await assert.rejects(
      f.service.select('token', {
        categoryId: f.categoryId,
        campusId: f.campusId,
      }),
      ApplicationError,
    );
    assert.equal(f.calls.includes('enumerate'), false);
  }
});
test('denied targets are observed but unknown review/score is never a sampled omission', async () => {
  const denied = fixture({ denied: true });
  const result = await denied.service.select('token', {
    categoryId: denied.categoryId,
  });
  assert.equal(result.candidateCount, 0);
  assert.equal(result.item, null);
  assert.equal(
    denied.calls.some((c) => c.startsWith('summary:')),
    false,
  );
  const unknown = fixture({ minimumUnknown: true });
  await assert.rejects(
    unknown.service.select('token', {
      categoryId: unknown.categoryId,
      minimumAverage: 1,
    }),
    (e: unknown) =>
      e instanceof ApplicationError && e.code === 'RATING_SCORE_UNAVAILABLE',
  );
  const unfiltered = await unknown.service.select('token', {
    categoryId: unknown.categoryId,
  });
  assert.equal(unfiltered.candidateCount, 1);
  assert.equal(unfiltered.item?.summary.status, 'unavailable');
});

test('all paths are reviewed before dedup and final proof failure never draws', async () => {
  const duplicate = fixture({ duplicatePath: true });
  const result = await duplicate.service.select('token', {
    categoryId: duplicate.categoryId,
  });
  assert.equal(result.candidateCount, 1);
  assert.equal(duplicate.calls.filter((c) => c === 'batch-review').length, 2);
  assert.equal(duplicate.calls.filter((c) => c === 'draw').length, 1);
  const failed = fixture({ failProof: true });
  await assert.rejects(
    failed.service.select('token', { categoryId: failed.categoryId }),
    ApplicationError,
  );
  assert.equal(failed.calls.includes('draw'), false);
});

test('duplicate canonical paths compare both lifecycle and definition before denying or sampling', async () => {
  for (const changedDuplicate of ['lifecycle', 'definition'] as const) {
    for (const denied of [false, true]) {
      const f = fixture({ changedDuplicate, denied });
      await assert.rejects(
        f.service.select('token', { categoryId: f.categoryId }),
        (error: unknown) =>
          error instanceof ApplicationError &&
          error.code === 'RATING_UNAVAILABLE',
      );
      assert.equal(f.calls.includes('draw'), false);
    }
  }
});

test('selected canonical reread cannot exchange a definition while retaining its lifecycle', async () => {
  for (const changedReread of ['lifecycle', 'definition'] as const) {
    const f = fixture({ changedReread });
    await assert.rejects(
      f.service.select('token', { categoryId: f.categoryId }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'RATING_UNAVAILABLE',
    );
    assert.equal(f.calls.includes('recheck'), false);
  }
});
