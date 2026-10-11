import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import { canonicalRatingCategoryIconEnvelope } from '../src/community/content-review/rating-category-icon-contracts.js';
import {
  canonicalRatingScopedCategorySource,
  ratingScopedApprovalDigest,
  type RatingScopedCategorySourceDescriptor,
} from '../src/community/content-review/rating-scoped-contracts.js';
import { startTransactionDeadlines } from '../src/database/transaction-deadlines.js';
import {
  categoryIconMediaContentKey,
  type CategoryIconMediaContentFact,
} from '../src/media/category-icon-content-snapshot.facade.js';
import {
  currentCategoryIconManagementRoot,
  type CategoryIconManagementRootDependencies,
} from '../src/ratings/category-management/icon-root-current.js';
import {
  categoryIconContentDigest,
  categoryIconDigest,
} from '../src/ratings/category-management/icon-extension.js';
import {
  RatingCategoryIconRepository,
  categoryIconDefinitionBody,
  categoryIconRootKey,
} from '../src/ratings/category-management/icon-repository.js';
import type { CategoryIconRoot } from '../src/ratings/category-management/icon-references.js';
import { RatingScopedCompilationBudget } from '../src/ratings/scoped/compiler.js';
import { retainRatingReadByteCount } from '../src/ratings/target-cover-current.js';
import {
  review8Binding,
  review8Envelope,
  review8Id as id,
} from './support/rating-category-icon-review-fixtures.js';

type ReviewDecision = 'allow' | 'deny' | 'unavailable';
interface FixtureOptions {
  campus?: boolean;
  textOverride?: boolean;
  inheritOverride?: boolean;
  originalBase?: 'native' | 'legacy-native' | 'adopted';
  retention?: 'current' | 'dormant' | 'archived';
}
function fixture(options: FixtureOptions = {}) {
  let envelope = review8Envelope({
    image: true,
    override: options.campus ?? false,
    textOverride: options.textOverride || options.inheritOverride || false,
  });
  if (options.originalBase && options.originalBase !== 'adopted') {
    const native = structuredClone(envelope);
    native.content.identityId = native.content.categoryId;
    if (native.content.icon.kind === 'image')
      native.content.icon.appearance.identityId = native.content.categoryId;
    envelope = canonicalRatingCategoryIconEnvelope({
      ...native,
      definitionDigest: categoryIconContentDigest(native.content),
    });
  }
  const content = envelope.content,
    icon = content.icon;
  assert.equal(icon.kind, 'image');
  if (icon.kind !== 'image') throw new Error('Image fixture required');
  const campusId =
    content.selector.kind === 'campus' ? content.selector.campusId : null;
  const key = campusId ? `campus:${campusId}` : 'global';
  const retention = options.retention ?? 'current';
  const roots: CategoryIconRoot[] = [
    {
      kind: 'base',
      definitionId: content.baseDefinitionId,
      categoryId: content.categoryId,
      identityId: content.identityId,
      source: content.baseSource,
      scopeKeys: options.campus && retention === 'dormant' ? ['global'] : [key],
      retention,
      value: options.campus
        ? { kind: 'absent', evidenceId: id(30), evidenceDigest: 'a'.repeat(64) }
        : { kind: 'image', appearance: icon.appearance },
    },
  ];
  if (options.campus)
    roots.push({
      kind: 'override',
      definitionId: content.overrideDefinitionId!,
      categoryId: content.categoryId,
      identityId: content.identityId,
      baseSource: content.baseSource,
      source: content.overrideSource,
      campusId: campusId!,
      scopeKeys: [key],
      retention,
      value: { kind: 'image', appearance: icon.appearance },
    });
  const selected = roots[roots.length - 1]!;
  const binding = review8Binding(envelope);
  const head = {
    root_key: canonicalJson([selected.definitionId, content.selector]),
    root_definition_id: selected.definitionId,
    selector: structuredClone(content.selector),
    review_binding_id: binding.id,
    binding: structuredClone(binding),
  };
  const shared = {
    version: 5,
    accountId: id(1),
    categoryId: content.categoryId,
    identityId: content.identityId,
    issuanceDigest: 'd'.repeat(64),
    placement: campusId
      ? { kind: 'campuses', campusIds: [campusId] }
      : { kind: 'global' },
    assetIds: [],
  };
  const base = canonicalRatingScopedCategorySource({
    sourceId: content.baseSource.id,
    sourceRevision: content.baseSource.revision,
    categoryId: content.categoryId,
    envelope: {
      ...shared,
      purpose: 'publish_rating_category_base_scoped',
      sourceId: content.baseSource.id,
      sourceRevision: content.baseSource.revision,
      issuanceId: content.baseSource.id,
      body: {
        parentId: content.parentId,
        level: content.level,
        kind: content.kind,
        systemKey: content.systemKey,
        name: options.textOverride ? 'Original base name' : content.name,
        description: content.description,
      },
    },
  });
  const descriptors = [base];
  if (content.overrideSource)
    descriptors.push(
      canonicalRatingScopedCategorySource({
        sourceId: content.overrideSource.id,
        sourceRevision: content.overrideSource.revision,
        categoryId: content.categoryId,
        envelope: {
          ...shared,
          purpose: 'publish_rating_category_override_scoped',
          sourceId: content.overrideSource.id,
          sourceRevision: content.overrideSource.revision,
          issuanceId: content.overrideSource.id,
          baseSourceId: content.baseSource.id,
          baseSourceRevision: content.baseSource.revision,
          scope: content.selector,
          body: { name: content.name, description: content.description },
        },
      }),
    );
  const sources = descriptors.map((source) => ({
    id: source.sourceId,
    revision: source.sourceRevision,
    source_kind:
      source.envelope.purpose === 'publish_rating_category_base_scoped'
        ? 'scoped_category_base'
        : 'scoped_category_override',
    issuer: 'ratings-category-management',
    scope_keys: [key],
    original_body: null as Record<string, unknown> | null,
    payload: { reviewEnvelope: structuredClone(source.envelope) } as Record<
      string,
      unknown
    >,
    valid_until: new Date(100000),
    current: true,
  }));
  if (options.originalBase) {
    const source = sources[0]!;
    source.source_kind =
      options.originalBase === 'adopted'
        ? 'legacy_adoption'
        : 'm3a_native_bridge';
    source.issuer =
      options.originalBase === 'legacy-native'
        ? 'ratings-legacy-bridge'
        : 'original-category-source';
    source.payload = {
      categoryId: content.categoryId,
      ...(options.originalBase === 'adopted'
        ? {
            identityId: content.identityId,
            reviewSource: {
              kind: 'scoped_category_v5',
              sourceId: id(72),
              sourceRevision: id(73),
            },
          }
        : options.originalBase === 'legacy-native'
          ? {
              legacyAfterCatalogId: id(70),
              categoryRevision: id(71),
              bridgeId: id(74),
            }
          : { legacyCatalogId: id(70), categoryRevision: id(71) }),
    };
    source.original_body = {
      id: content.categoryId,
      ...base.envelope.body,
      isSystem: content.systemKey !== null,
      originKind: 'global',
      active: true,
      hidden: false,
      ordinal: '1',
      identityKind:
        options.originalBase === 'adopted' ? 'adopted' : 'native_bridge',
      identityId: content.identityId,
    };
  }
  if (options.inheritOverride) {
    const source = sources[1]!;
    source.payload = {
      categoryId: content.categoryId,
      baseSourceId: content.baseSource.id,
      baseSourceRevision: content.baseSource.revision,
      action: 'inherit',
      modes: { name: { mode: 'inherit' }, description: { mode: 'inherit' } },
      management: { version: 1, accountId: id(1), requestId: id(2) },
    };
  }
  const parent = {
    ownerKind: 'ratings' as const,
    resourceKind: 'category_icon' as const,
    resourceId: icon.appearance.appearanceId,
    contentVersion: 1 as const,
  };
  const fact: CategoryIconMediaContentFact = {
    version: 8,
    parent,
    decision: 'allow',
    validUntil: 100000,
    attachments: [
      {
        slot: 'icon',
        ordinal: 0,
        bindingId: id(50),
        assetId: icon.appearance.assetId,
        manifestDigest: icon.appearance.manifestDigest,
        width: 64,
        height: 64,
        policyRevision: 'media-static-v1',
        intentId: id(51),
        intentState: 'ready',
        headRevision: '1',
        eventId: id(52),
      },
    ],
  };
  const calls: { sql: string; values: unknown[] }[] = [],
    sourceCalls: RatingScopedCategorySourceDescriptor[] = [],
    order: string[] = [];
  let missingHead = false,
    missingSource = false,
    sourceDecision: ReviewDecision = 'allow';
  let reviewDecision: ReviewDecision = 'allow',
    mediaFact: CategoryIconMediaContentFact | null = fact;
  let epoch = '1',
    snapshot = 'e'.repeat(64),
    mutateDuringMedia: (() => void) | undefined;
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT version,epoch::text'))
        return { rows: [{ version: 1, epoch }] };
      if (
        sql.includes(
          'SELECT root_key FROM whaleu_ratings.category_icon_definition_heads',
        )
      )
        return {
          rows: roots.map((root) => ({ root_key: categoryIconRootKey(root) })),
        };
      if (
        sql.includes(
          'jsonb_array_elements(whaleu_ratings.category_icon_complete_roots())',
        )
      )
        return {
          rows: roots.map((root) => ({
            root_key: categoryIconRootKey(root),
            root: structuredClone(root),
            definition_digest: categoryIconDigest(
              'definition',
              categoryIconDefinitionBody(root),
            ),
            retired: false,
          })),
        };
      if (sql.includes('SELECT jsonb_build_object('))
        return { rows: [{ state: { epoch, keys: values[0] } }] };
      if (sql.includes('category_icon_snapshot('))
        return { rows: [{ snapshot }] };
      if (
        sql.includes(
          'FROM whaleu_ratings.category_icon_management_review_heads',
        )
      ) {
        assert.deepEqual(values, [
          selected.definitionId,
          canonicalJson(content.selector),
        ]);
        return { rows: missingHead ? [] : [structuredClone(head)] };
      }
      if (sql.includes('FROM unnest($1::uuid[],$2::uuid[]) wanted'))
        return { rows: missingSource ? [] : structuredClone(sources) };
      assert.fail(`Unexpected management root SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const dependencies: CategoryIconManagementRootDependencies = {
    roots: new RatingCategoryIconRepository(),
    sourceReview: {
      async currentCategorySource(descriptor) {
        sourceCalls.push(descriptor);
        if (sourceDecision === 'deny')
          return { kind: 'deny', reason: 'RATING_NOT_FOUND' };
        if (sourceDecision === 'unavailable') return { kind: 'unavailable' };
        return {
          kind: 'allow',
          value: {
            version: 5,
            decisionId: id(60),
            digest: ratingScopedApprovalDigest(descriptor.envelope),
            envelope: descriptor.envelope,
          },
        };
      },
    },
    review: {
      async currentBatch(definitions) {
        order.push('review8');
        assert.deepEqual(
          definitions.map((item) => item.envelope),
          [envelope],
        );
        if (reviewDecision === 'deny')
          return [{ kind: 'deny', reason: 'RATING_NOT_FOUND' }];
        if (reviewDecision === 'unavailable') return [{ kind: 'unavailable' }];
        return [
          {
            kind: 'allow',
            value: {
              version: 8,
              decisionId: binding.decision_id,
              digest: binding.approval_digest,
              envelope,
            },
          },
        ];
      },
    },
    mediaProof: {
      async capture() {
        order.push('media-proof');
        return 'f'.repeat(64);
      },
    },
    media: {
      async readBatch(references) {
        order.push('media');
        assert.deepEqual(references, [
          {
            parent,
            expected: [
              {
                assetId: icon.appearance.assetId,
                digest: icon.appearance.manifestDigest,
              },
            ],
          },
        ]);
        mutateDuringMedia?.();
        return new Map(
          mediaFact ? [[categoryIconMediaContentKey(parent), mediaFact]] : [],
        );
      },
    },
  };
  const input = {
    categoryId: content.categoryId,
    appearanceId: icon.appearance.appearanceId,
    selector: content.selector,
  };
  return {
    tx,
    input,
    envelope,
    roots,
    head,
    sources,
    sourceCalls,
    calls,
    order,
    fact,
    dependencies,
    run: () =>
      currentCategoryIconManagementRoot(
        input,
        tx,
        new RatingScopedCompilationBudget(),
        dependencies,
      ),
    omitHead: () => {
      missingHead = true;
    },
    omitSource: () => {
      missingSource = true;
    },
    rejectSource: (value: ReviewDecision) => {
      sourceDecision = value;
    },
    rejectReview: (value: ReviewDecision) => {
      reviewDecision = value;
    },
    media: (value: CategoryIconMediaContentFact | null) => {
      mediaFact = value;
    },
    changeDuringMedia: (kind: 'epoch' | 'closure' | 'rollback') => {
      mutateDuringMedia = () => {
        if (kind === 'epoch') epoch = '2';
        if (kind === 'closure') snapshot = 'f'.repeat(64);
        if (kind === 'rollback') startTransactionDeadlines(tx);
      };
    },
  };
}

test('Management Category icon reads exact active, archived and dormant roots without a public projection', async () => {
  const cases: FixtureOptions[] = [
    {},
    { retention: 'archived' },
    { campus: true, retention: 'dormant' },
    { campus: true, textOverride: true, retention: 'dormant' },
  ];
  for (const options of cases) {
    const f = fixture(options),
      result = await f.run();
    assert.equal(result.qualification.kind, 'management-root');
    assert.equal(result.appearance.appearanceId, f.input.appearanceId);
    assert.equal(
      result.qualification.rootDefinitionId,
      f.roots[f.roots.length - 1]!.definitionId,
    );
    assert.equal(result.binding.bindingId, id(50));
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.qualification.baseSource));
    assert.ok(Object.isFrozen(result.appearance.origin));
    assert.deepEqual(f.order, ['review8', 'media-proof', 'media']);
    assert.equal(f.sourceCalls.length, options.textOverride ? 2 : 1);
    assert.equal(
      f.calls.some(
        (call) =>
          /category_icon_projections|category_icon_release_manifests/.test(
            call.sql,
          ) && !call.sql.includes('SELECT jsonb_build_object('),
      ),
      false,
    );
    const allKeys = [
      ...new Set(f.roots.flatMap((root) => root.scopeKeys)),
    ].sort();
    assert.deepEqual(
      f.calls.find((call) => call.sql.includes('category_icon_snapshot('))!
        .values,
      [allKeys],
    );
  }
});
test('Missing exact management pointer never falls back to historical Review or another selector', async () => {
  const f = fixture({ campus: true });
  f.omitHead();
  await assert.rejects(f.run());
  assert.equal(f.sourceCalls.length, 0);
  assert.equal(
    f.calls.filter((call) =>
      call.sql.includes('category_icon_management_review_heads'),
    ).length,
    1,
  );
  assert.equal(f.order.length, 0);
});
test('Selector, root pointer, body source and current definition substitutions fail before Media8', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.head.root_definition_id = id(999);
    },
    (f) => {
      f.head.root_key = canonicalJson([id(999), f.input.selector]);
    },
    (f) => {
      f.head.selector = { kind: 'global' };
    },
    (f) => {
      f.head.review_binding_id = id(999);
    },
    (f) => {
      f.sources[0]!.current = false;
    },
    (f) => {
      f.sources[0]!.revision = id(999);
    },
    (f) => {
      delete f.sources[0]!.payload['reviewEnvelope'];
    },
    (f) => {
      (
        f.sources[0]!.payload['reviewEnvelope'] as { body: { name: string } }
      ).body.name = 'Unreviewed replacement';
    },
    (f) => {
      f.roots[0]!.definitionId = id(999);
    },
  ];
  for (const change of changes) {
    const f = fixture({ campus: true });
    change(f);
    await assert.rejects(f.run());
    assert.equal(f.order.includes('media'), false);
  }
});
test('A successor root cannot revive its predecessor management pointer even with the same image', async () => {
  const f = fixture();
  f.roots[0]!.definitionId = id(999);
  await assert.rejects(f.run());
  assert.equal(f.order.includes('media'), false);
});
test('Management does not infer a campus selector from a global base or choose an ambiguous image lineage', async () => {
  const global = fixture();
  await assert.rejects(
    currentCategoryIconManagementRoot(
      { ...global.input, selector: { kind: 'campus', campusId: id(20) } },
      global.tx,
      new RatingScopedCompilationBudget(),
      global.dependencies,
    ),
  );
  const ambiguous = fixture(),
    base = ambiguous.roots[0]!;
  assert.equal(base.kind, 'base');
  if (base.kind === 'base')
    ambiguous.roots.push({
      ...base,
      definitionId: id(998),
      source: { id: id(997), revision: id(996) },
    });
  await assert.rejects(ambiguous.run());
  assert.equal(ambiguous.order.length, 0);
});
test('Original Review5 and composite Review8 are independently required for recoverable roots', async () => {
  const missing = fixture();
  missing.omitSource();
  await assert.rejects(missing.run());
  for (const decision of ['deny', 'unavailable'] as const) {
    const original = fixture();
    original.rejectSource(decision);
    await assert.rejects(original.run());
    assert.equal(original.order.length, 0);
    const composite = fixture();
    composite.rejectReview(decision);
    await assert.rejects(composite.run());
    assert.equal(composite.order.includes('media'), false);
  }
});
test('Exact Media8 unknown, denied, missing and foreign binding facts are never preview absence', async () => {
  for (const mutate of [
    (_f: ReturnType<typeof fixture>) => null,
    (f: ReturnType<typeof fixture>) => ({
      ...f.fact,
      decision: 'unknown' as const,
    }),
    (f: ReturnType<typeof fixture>) => ({
      ...f.fact,
      decision: 'deny' as const,
    }),
    (f: ReturnType<typeof fixture>) => ({ ...f.fact, attachments: [] }),
    (f: ReturnType<typeof fixture>) => ({
      ...f.fact,
      attachments: [{ ...f.fact.attachments[0]!, assetId: id(999) }],
    }),
    (f: ReturnType<typeof fixture>) => ({ ...f.fact, validUntil: null }),
  ]) {
    const f = fixture();
    f.media(mutate(f));
    await assert.rejects(f.run());
    assert.deepEqual(f.order.slice(-2), ['media-proof', 'media']);
  }
});
test('Management rejects root closure changes and rollback during source/Review/Media qualification', async () => {
  for (const kind of ['epoch', 'closure', 'rollback'] as const) {
    const f = fixture();
    f.changeDuringMedia(kind);
    await assert.rejects(f.run());
  }
});
test('Management complete-root observations share the existing transaction 64 MiB allowance', async () => {
  const f = fixture();
  retainRatingReadByteCount(f.tx, 64 * 1024 * 1024);
  await assert.rejects(f.run());
  assert.equal(f.order.length, 0);
});

test('Exact management inherit tombstones retain their source and base body without fabricated Review5', async () => {
  for (const retention of ['current', 'dormant', 'archived'] as const) {
    const f = fixture({ campus: true, inheritOverride: true, retention }),
      result = await f.run();
    assert.deepEqual(result.content, f.envelope.content);
    assert.deepEqual(result.qualification.overrideSource, {
      id: f.sources[1]!.id,
      revision: f.sources[1]!.revision,
    });
    assert.equal(result.content.name, f.envelope.content.name);
    assert.equal(f.sourceCalls.length, 1);
    assert.equal(f.sourceCalls[0]!.sourceId, f.sources[0]!.id);
    assert.equal('reviewEnvelope' in f.sources[1]!.payload, false);
    assert.deepEqual(f.order, ['review8', 'media-proof', 'media']);
    const read = f.calls.find((call) =>
      call.sql.includes('FROM unnest($1::uuid[],$2::uuid[]) wanted'),
    )!;
    assert.deepEqual(read.values, [
      f.sources.map((source) => source.id),
      f.sources.map((source) => source.revision),
    ]);
  }
});
test('An inherit tombstone must be the exact current management source for this category, base and campus', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.sources[1]!.issuer = 'foreign-issuer';
    },
    (f) => {
      f.sources[1]!.source_kind = 'scoped_category_lifecycle';
    },
    (f) => {
      f.sources[1]!.current = false;
    },
    (f) => {
      f.sources[1]!.id = id(999);
    },
    (f) => {
      f.sources[1]!.revision = id(999);
    },
    (f) => {
      f.sources[1]!.valid_until = new Date(NaN);
    },
    (f) => {
      f.sources[1]!.scope_keys = ['global'];
    },
    (f) => {
      f.sources[1]!.scope_keys = [`campus:${id(999)}`];
    },
    (f) => {
      f.sources[1]!.scope_keys.push(`campus:${id(999)}`);
    },
    (f) => {
      f.sources[1]!.payload['categoryId'] = id(999);
    },
    (f) => {
      f.sources[1]!.payload['baseSourceId'] = id(999);
    },
    (f) => {
      f.sources[1]!.payload['baseSourceRevision'] = id(999);
    },
    (f) => {
      f.sources[1]!.payload['action'] = 'set';
    },
    (f) => {
      delete f.sources[1]!.payload['action'];
    },
    (f) => {
      f.sources[1]!.payload['modes'] = { name: { mode: 'inherit' } };
    },
    (f) => {
      f.sources[1]!.payload['modes'] = {
        name: { mode: 'set', value: f.envelope.content.name },
        description: { mode: 'inherit' },
      };
    },
    (f) => {
      f.sources[1]!.payload['reviewEnvelope'] = null;
    },
    (f) => {
      f.sources[1]!.payload['issuanceDigest'] = null;
    },
    (f) => {
      (
        f.sources[0]!.payload['reviewEnvelope'] as { identityId: string }
      ).identityId = id(999);
    },
    (f) => {
      f.sources.splice(1, 1);
    },
  ];
  for (const change of changes) {
    const f = fixture({ campus: true, inheritOverride: true });
    change(f);
    await assert.rejects(f.run());
    assert.equal(f.order.length, 0);
  }
});
test('A tombstone still requires the exact non-null override source in current composite Review8', async () => {
  for (const overrideSource of [null, { id: id(999), revision: id(998) }]) {
    const f = fixture({ campus: true, inheritOverride: true }),
      changed = structuredClone(f.envelope);
    changed.content.overrideSource = overrideSource;
    f.head.binding = review8Binding(
      canonicalRatingCategoryIconEnvelope({
        ...changed,
        definitionDigest: categoryIconContentDigest(changed.content),
      }),
    );
    await assert.rejects(f.run(), { code: 'RATING_SCOPE_UNAVAILABLE' });
    assert.equal(f.sourceCalls.length, 1);
    assert.equal(f.order.length, 0);
  }
  for (const decision of ['deny', 'unavailable'] as const) {
    const f = fixture({ campus: true, inheritOverride: true });
    f.rejectReview(decision);
    await assert.rejects(f.run(), { code: 'CONTENT_REVIEW_UNAVAILABLE' });
    assert.deepEqual(f.order, ['review8']);
  }
});
test('Adopted native and legacy bases preserve original proof and identity without synthesizing Review5', async () => {
  for (const originalBase of ['native', 'legacy-native', 'adopted'] as const) {
    for (const campus of [false, true]) {
      const f = fixture({ originalBase, campus, inheritOverride: campus });
      f.rejectSource('deny');
      const result = await f.run();
      assert.deepEqual(result.content, f.envelope.content);
      assert.deepEqual(result.qualification.baseSource, {
        id: f.sources[0]!.id,
        revision: f.sources[0]!.revision,
      });
      assert.equal(
        result.qualification.identityId,
        f.sources[0]!.original_body!['identityId'],
      );
      assert.equal(f.sourceCalls.length, 0);
      assert.equal('reviewEnvelope' in f.sources[0]!.payload, false);
      assert.deepEqual(f.order, ['review8', 'media-proof', 'media']);
      const sourceRead = f.calls.find((call) =>
        call.sql.includes('FROM unnest($1::uuid[],$2::uuid[]) wanted'),
      )!;
      assert.ok(
        sourceRead.sql.includes(
          'whaleu_ratings.scoped_base_category(s.id,s.revision)',
        ),
      );
      assert.ok(
        sourceRead.sql.includes(
          'scoped_source_current(s.id,s.revision,clock_timestamp())',
        ),
      );
      assert.equal(sourceRead.sql.includes('category_historical_body'), false);
    }
  }
});
test('Missing, malformed, foreign and stale original base proofs stay unavailable', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.sources[0]!.original_body = null;
    },
    (f) => {
      f.sources[0]!.original_body = {};
    },
    (f) => {
      f.sources[0]!.original_body = null;
      f.sources[0]!.payload['reviewEnvelope'] =
        fixture().sources[0]!.payload['reviewEnvelope'];
    },
    (f) => {
      delete f.sources[0]!.original_body!['description'];
    },
    (f) => {
      f.sources[0]!.original_body!['id'] = id(999);
    },
    (f) => {
      f.sources[0]!.original_body!['identityId'] = id(999);
    },
    (f) => {
      f.sources[0]!.original_body!['identityKind'] = 'scoped_source';
    },
    (f) => {
      f.sources[0]!.source_kind = 'scope_absence';
    },
    (f) => {
      f.sources[0]!.current = false;
    },
    (f) => {
      f.sources[0]!.revision = id(999);
    },
    (f) => {
      f.sources[0]!.valid_until = new Date(NaN);
    },
    (f) => {
      f.sources.length = 0;
    },
  ];
  for (const originalBase of ['native', 'legacy-native', 'adopted'] as const) {
    for (const change of changes) {
      const f = fixture({ originalBase });
      change(f);
      await assert.rejects(f.run(), { code: 'RATING_SCOPE_UNAVAILABLE' });
      assert.equal(f.sourceCalls.length, 0);
      assert.equal(f.order.length, 0);
    }
  }
});
test('Every original base body field is compared with exact Review8 before Media8', async () => {
  const changes: Record<string, unknown>[] = [
    { parentId: id(999), level: 2 },
    { kind: 'different' },
    { systemKey: 'different' },
    { name: 'Different base body' },
    { description: 'Different base description' },
  ];
  for (const originalBase of ['native', 'legacy-native', 'adopted'] as const) {
    for (const change of changes) {
      const f = fixture({ originalBase });
      Object.assign(f.sources[0]!.original_body!, change);
      await assert.rejects(f.run(), { code: 'RATING_SCOPE_UNAVAILABLE' });
      assert.equal(f.sourceCalls.length, 0);
      assert.equal(f.order.length, 0);
    }
  }
});
test('Original-base support keeps scoped overrides and direct scoped bases independently Review5 qualified', async () => {
  for (const originalBase of ['native', 'legacy-native', 'adopted'] as const) {
    const f = fixture({ originalBase, campus: true, textOverride: true }),
      result = await f.run();
    assert.deepEqual(result.content, f.envelope.content);
    assert.equal(f.sourceCalls.length, 1);
    assert.equal(f.sourceCalls[0]!.sourceId, f.sources[1]!.id);
    for (const decision of ['deny', 'unavailable'] as const) {
      const denied = fixture({
        originalBase,
        campus: true,
        textOverride: true,
      });
      denied.rejectSource(decision);
      await assert.rejects(denied.run(), {
        code: 'CONTENT_REVIEW_UNAVAILABLE',
      });
      assert.equal(denied.order.length, 0);
    }
  }
  const direct = fixture(),
    original = fixture({ originalBase: 'adopted' });
  direct.sources[0]!.original_body = original.sources[0]!.original_body;
  delete direct.sources[0]!.payload['reviewEnvelope'];
  await assert.rejects(direct.run(), { code: 'CONTENT_REVIEW_UNAVAILABLE' });
  assert.equal(direct.order.length, 0);
});
test('Original proofs and inherit tombstones retain composite Review8 and transaction fences', async () => {
  const options: FixtureOptions[] = [
    { originalBase: 'native' },
    { originalBase: 'adopted', campus: true, inheritOverride: true },
  ];
  for (const option of options) {
    for (const decision of ['deny', 'unavailable'] as const) {
      const f = fixture(option);
      f.rejectReview(decision);
      await assert.rejects(f.run(), { code: 'CONTENT_REVIEW_UNAVAILABLE' });
      assert.deepEqual(f.order, ['review8']);
    }
    for (const kind of ['epoch', 'closure', 'rollback'] as const) {
      const f = fixture(option);
      f.changeDuringMedia(kind);
      await assert.rejects(f.run(), { code: 'RATING_SCOPE_UNAVAILABLE' });
    }
  }
});
