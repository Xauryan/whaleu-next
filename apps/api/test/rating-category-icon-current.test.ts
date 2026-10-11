import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { Decision } from '../src/community/community-policy.js';
import {
  canonicalRatingCategoryIconEnvelope,
  type AcceptedRatingCategoryIconApproval,
  type RatingCategoryIconDefinitionDescriptor,
  type RatingCategoryIconEnvelope,
} from '../src/community/content-review/rating-category-icon-contracts.js';
import {
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import {
  currentCategoryIconDescriptor,
  currentCategoryIcons,
  type CategoryIconExpectedRead,
} from '../src/ratings/category-management/icon-current.js';
import {
  categoryIconContentDigest,
  categoryIconDigest,
  type CategoryIconReleaseRow,
} from '../src/ratings/category-management/icon-extension.js';
import { categoryIconDefinitionBody } from '../src/ratings/category-management/icon-repository.js';
import type { CategoryIconRoot } from '../src/ratings/category-management/icon-references.js';
import type { ScopedExpectedCategory } from '../src/ratings/scoped/compiler.js';
import type { ResolvedRatingReadScope } from '../src/ratings/scoped/context.service.js';
import { ratingScopedDigest } from '../src/ratings/scoped/protocol-registry.js';
import { retainRatingReadByteCount } from '../src/ratings/target-cover-current.js';
import { CategoryIconMediaRequiredProof } from '../src/media/category-icon-required-proof.js';
import { sealManifest } from '../src/media/manifest.js';
import { manifestFixture } from './support/media/discovery-manifest.js';
import {
  review8Binding,
  review8Envelope,
  review8Id as id,
} from './support/rating-category-icon-review-fixtures.js';

const sealed = sealManifest(manifestFixture());
const context = { id: id(700), token: 'a'.repeat(43) };
const catalogId = id(701),
  releaseId = id(702),
  headRevision = id(703);
function fixture(
  options: { image?: boolean; override?: boolean; count?: number } = {},
) {
  const count = options.count ?? 1;
  const calls: { sql: string; values: unknown[] }[] = [];
  const reviewBatches: RatingCategoryIconDefinitionDescriptor[][] = [];
  const envelopes: RatingCategoryIconEnvelope[] = [],
    expectedRows: CategoryIconExpectedRead[] = [],
    roots: CategoryIconRoot[] = [],
    projections: CategoryIconReleaseRow[] = [],
    bindings: ReturnType<typeof review8Binding>[] = [];
  const scopeKey = options.override ? `campus:${id(20)}` : 'global';
  const scope = {
    catalog: {
      id: catalogId,
      scopeKey,
      regionId: options.override ? id(19) : null,
      campusId: options.override ? id(20) : null,
      headRevision,
      sourceDigest: '3'.repeat(64),
    },
    selector: options.override
      ? { kind: 'campus', campusId: id(20) }
      : { kind: 'global' },
  } as unknown as ResolvedRatingReadScope;
  for (let n = 0; n < count; n++) {
    const original = review8Envelope(options),
      categoryId = id(1000 + n * 20),
      identityId = id(1001 + n * 20);
    const baseDefinitionId = id(1002 + n * 20),
      overrideDefinitionId = options.override ? id(1003 + n * 20) : null;
    const icon =
      original.content.icon.kind === 'image'
        ? {
            ...original.content.icon,
            definitionId: overrideDefinitionId ?? baseDefinitionId,
            appearance: {
              ...original.content.icon.appearance,
              categoryId,
              identityId,
              appearanceId: id(1004 + n * 20),
              assetId: id(1005 + n * 20),
              manifestDigest: sealed.digest,
            },
          }
        : {
            ...original.content.icon,
            definitionId: overrideDefinitionId ?? baseDefinitionId,
          };
    const content = {
      ...original.content,
      categoryId,
      identityId,
      baseDefinitionId,
      overrideDefinitionId,
      icon,
    };
    const envelope = canonicalRatingCategoryIconEnvelope({
      ...original,
      definitionId: id(1006 + n * 20),
      definitionDigest: categoryIconContentDigest(content),
      content,
      assetIds: icon.kind === 'image' ? [icon.appearance.assetId] : [],
    });
    envelopes.push(envelope);
    const binding = {
      ...review8Binding(envelope),
      id: id(1007 + n * 20),
      decision_id: id(1008 + n * 20),
    };
    bindings.push(binding);
    const value =
      icon.kind === 'image'
        ? { kind: 'image' as const, appearance: icon.appearance }
        : {
            kind: 'absent' as const,
            evidenceId: icon.evidenceId,
            evidenceDigest: icon.evidenceDigest,
          };
    roots.push({
      kind: 'base',
      definitionId: baseDefinitionId,
      categoryId,
      identityId,
      source: content.baseSource,
      scopeKeys: [scopeKey],
      retention: 'current',
      value: options.override
        ? { kind: 'absent', evidenceId: id(10), evidenceDigest: 'c'.repeat(64) }
        : value,
    });
    if (options.override)
      roots.push({
        kind: 'override',
        definitionId: overrideDefinitionId!,
        categoryId,
        identityId,
        source: null,
        baseSource: content.baseSource,
        campusId: id(20),
        scopeKeys: [scopeKey],
        retention: 'current',
        value,
      });
    const expected: ScopedExpectedCategory = {
      body: {
        id: categoryId,
        parentId: null,
        level: 1,
        kind: content.kind,
        systemKey: null,
        isSystem: false,
        originKind: options.override ? 'regional' : 'global',
        name: content.name,
        description: content.description,
        active: true,
        hidden: false,
        ordinal: String(n),
        identityKind: 'scoped_source',
        identityId,
      },
      baseSourceId: content.baseSource.id,
      baseSourceRevision: content.baseSource.revision,
      overrideSourceId: null,
      overrideSourceRevision: null,
      lifecycleSourceId: null,
      lifecycleSourceRevision: null,
      orderSourceId: null,
      orderSourceRevision: null,
      placementRevision: id(1009 + n * 20),
    };
    const row = {
      id: categoryId,
      revision: id(1010 + n * 20),
      effective_digest: ratingScopedDigest('effective', expected),
      placement_revision: expected.placementRevision,
      expected,
    };
    expectedRows.push(row);
    const body = {
      releaseId,
      catalogId,
      scopeKey,
      categoryId,
      effectiveRevision: row.revision,
      effectiveDigest: row.effective_digest,
      placementRevision: row.placement_revision,
      extensionVersion: 'ratings-category-icon-v1' as const,
      content,
      review: {
        id: binding.id,
        definitionDigest: binding.definition_digest,
        approvalDigest: binding.approval_digest,
      },
    };
    projections.push({
      ...body,
      digest: categoryIconDigest('release-row', body),
    });
  }
  const extent: {
    scopeKey: string;
    adopted: boolean;
    beforeCatalogId: string | null;
    beforeHeadRevision: string | null;
    beforeReleaseId: string | null;
    beforeAdopted: boolean;
  }[] = [
    {
      scopeKey,
      adopted: true,
      beforeCatalogId: null,
      beforeHeadRevision: null,
      beforeReleaseId: null,
      beforeAdopted: false,
    },
  ];
  const seal = () =>
    categoryIconDigest('release', {
      extent,
      managementCoverage: [],
      rows: [...projections]
        .sort(
          (a, b) =>
            a.scopeKey.localeCompare(b.scopeKey) ||
            a.categoryId.localeCompare(b.categoryId),
        )
        .map((row) => row.digest),
    });
  const manifest = {
    release_id: releaseId,
    extension_version: 'ratings-category-icon-v1',
    digest: seal(),
    row_count: projections.length,
    scope_extent: extent,
    management_coverage: [],
    root_snapshot: roots as unknown[],
    serialized_bytes: '1000',
  };
  const head = {
    scope_key: scopeKey,
    catalog_id: catalogId,
    head_revision: headRevision,
    release_id: releaseId,
    cause: {
      categoryIconExtension: 'ratings-category-icon-v1',
      categoryIconDigest: manifest.digest,
      categoryIconScopeKeys: [scopeKey],
    } as Record<string, unknown>,
  };
  let omitManifest = false,
    omitProjection = false,
    duplicateProjection = false,
    changedHeadAtEnd = false;
  let headReads = 0,
    mediaDecision = 'allow',
    omittedDefinition = false;
  let iconEpoch = '1',
    mediaEpoch = '1';
  const decisions = new Map<string, 'allow' | 'deny' | 'unavailable'>();
  const mediaRows = envelopes.flatMap((envelope) => {
    if (envelope.content.icon.kind !== 'image') return [];
    const appearance = envelope.content.icon.appearance;
    return [
      {
        parent_id: appearance.appearanceId,
        parent_kind: 'category_icon',
        binding_id: id(80000 + mediaRowsIndex(envelopes, envelope)),
        asset_id: appearance.assetId,
        binding_digest: sealed.digest,
        ordinal: 0,
        slot: 'icon',
        id: appearance.assetId,
        intent_id: id(80001 + mediaRowsIndex(envelopes, envelope)),
        audience: 'content-gated',
        purpose: 'ratings-category-icon-image',
        owner_kind: 'ratings',
        resource_kind: 'category_icon',
        content_version: '1',
        manifest_digest: sealed.digest,
        manifest: sealed.manifest,
        policy_revision: 'media-static-v1',
        intent_state: 'ready',
        protocol_version: 8,
        target_kind: 'edit',
        head_revision: '1',
        event_id: id(80002 + mediaRowsIndex(envelopes, envelope)),
        state: 'allow',
        event_digest: sealed.digest,
        event_policy: 'media-static-v1',
        effective_at: new Date(1000),
        valid_until: new Date(10000),
        read_at: new Date(5000),
        exact_time_valid: true,
      },
    ];
  });
  const tx = {
    query: async (sql: string, supplied?: unknown[]) => {
      const values = supplied ?? [];
      calls.push({ sql, values });
      if (sql.includes('SELECT h.scope_key,h.catalog_id')) {
        headReads++;
        return {
          rows:
            changedHeadAtEnd && headReads > 1 ? [] : [structuredClone(head)],
        };
      }
      if (sql.includes('SELECT jsonb_build_object('))
        return {
          rows: [{ state: { epoch: iconEpoch, head: structuredClone(head) } }],
        };
      if (
        sql.includes(
          'FROM whaleu_ratings.category_icon_release_manifests WHERE',
        )
      )
        return { rows: omitManifest ? [] : [structuredClone(manifest)] };
      if (sql.includes('SELECT p.catalog_id,p.category_id'))
        return {
          rows: projections.map((row) => ({
            catalog_id: row.catalogId,
            catalog_release_id: releaseId,
            category_id: row.categoryId,
            effective_revision: row.effectiveRevision,
            scope_key: row.scopeKey,
            extension_digest: row.digest,
          })),
        };
      if (sql.includes('to_jsonb(b) binding')) {
        const wanted = new Set(values[2] as string[]);
        const rows = projections
          .filter((row) => wanted.has(row.categoryId))
          .map((row) => ({
            release_id: row.releaseId,
            catalog_id: row.catalogId,
            category_id: row.categoryId,
            effective_revision: row.effectiveRevision,
            extension_digest: row.digest,
            projection: structuredClone(row),
            review_binding_id: row.review.id,
            appearance_id:
              row.content.icon.kind === 'image'
                ? row.content.icon.appearance.appearanceId
                : null,
            binding: structuredClone(
              bindings.find((binding) => binding.id === row.review.id),
            ),
          }));
        return {
          rows: omitProjection
            ? rows.slice(1)
            : duplicateProjection
              ? [...rows, rows[0]]
              : rows,
        };
      }
      if (sql.includes('FROM whaleu_ratings.category_icon_definitions WHERE')) {
        const wanted = new Set(values[0] as string[]);
        const rows = roots
          .filter((root) => wanted.has(root.definitionId))
          .map((root) => {
            const base = root.kind === 'base' ? root.source : root.baseSource;
            return {
              id: root.definitionId,
              category_id: root.categoryId,
              identity_id: root.identityId,
              kind: root.kind,
              campus_id: root.kind === 'base' ? null : root.campusId,
              base_source_id: base.id,
              base_source_revision: base.revision,
              text_source_id: root.source?.id ?? null,
              text_source_revision: root.source?.revision ?? null,
              value: root.value,
              appearance_id:
                root.value.kind === 'image'
                  ? root.value.appearance.appearanceId
                  : null,
              definition_digest: categoryIconDigest(
                'definition',
                categoryIconDefinitionBody(root),
              ),
            };
          });
        return { rows: omittedDefinition ? rows.slice(1) : rows };
      }
      if (sql.includes("current_setting('max_connections')"))
        return { rows: [{ isolation: 'read committed', capacity: 32 }] };
      if (sql.includes('FROM whaleu_media.media_owner_states'))
        return {
          rows: Array.from({ length: 128 }, (_, slot) => ({
            slot,
            version: 1,
            epoch: mediaEpoch,
          })),
        };
      if (sql.includes('FROM unnest($1::uuid[],$2::text[])')) {
        const wanted = new Set(values[0] as string[]);
        return {
          rows: mediaRows
            .filter((row) => wanted.has(row.parent_id))
            .map((row) => ({ ...row, state: mediaDecision })),
        };
      }
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (
        sql.startsWith('LOCK TABLE') ||
        sql.includes('set_config(') ||
        sql === 'SET CONSTRAINTS ALL IMMEDIATE' ||
        sql.includes('FOR SHARE NOWAIT')
      )
        return { rows: [] };
      if (sql.includes('to_regclass(')) return { rows: [{ present: false }] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(5000) }] };
      assert.fail(`Unexpected Category current SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const review = {
    currentBatch: async (
      definitions: readonly RatingCategoryIconDefinitionDescriptor[],
    ) => {
      reviewBatches.push([...definitions]);
      return definitions.map(
        (definition): Decision<AcceptedRatingCategoryIconApproval> => {
          const kind = decisions.get(definition.definitionId) ?? 'allow';
          if (kind === 'unavailable') return { kind };
          if (kind === 'deny') return { kind, reason: 'RATING_NOT_FOUND' };
          const binding = bindings.find(
            (item) => item.definition_id === definition.definitionId,
          )!;
          return {
            kind,
            value: {
              version: 8,
              decisionId: binding.decision_id,
              digest: binding.approval_digest,
              envelope: definition.envelope,
            },
          };
        },
      );
    },
  };
  return {
    tx,
    calls,
    scope,
    head,
    manifest,
    expectedRows,
    projections,
    roots,
    bindings,
    envelopes,
    review,
    reviewBatches,
    mediaRows,
    decisions,
    gate: () => currentCategoryIcons(scope, expectedRows, tx, review),
    descriptor: (n = 0) =>
      currentCategoryIconDescriptor(scope, expectedRows[n]!.id, context, tx),
    reseal: () => {
      manifest.digest = seal();
      head.cause['categoryIconDigest'] = manifest.digest;
    },
    omitManifest: () => {
      omitManifest = true;
    },
    omitProjection: () => {
      omitProjection = true;
    },
    duplicateProjection: () => {
      duplicateProjection = true;
    },
    moveHead: () => {
      changedHeadAtEnd = true;
    },
    omitDefinition: () => {
      omittedDefinition = true;
    },
    mediaDecision: (value: string) => {
      mediaDecision = value;
    },
    changeIconEpoch: () => {
      iconEpoch = '2';
    },
    changeMediaEpoch: () => {
      mediaEpoch = '2';
    },
  };
}
function mediaRowsIndex(
  envelopes: readonly RatingCategoryIconEnvelope[],
  envelope: RatingCategoryIconEnvelope,
) {
  return envelopes.indexOf(envelope) * 3;
}

test('unmarked old release reads only the old head/cause relations, with no new proof or Review query', async () => {
  const f = fixture();
  f.head.cause = { kind: 'source_release' };
  assert.deepEqual(await f.gate(), ['allow']);
  assert.equal(f.calls.length, 1);
  assert(f.calls[0]!.sql.includes('whaleu_ratings.scoped_catalog_heads'));
  assert(f.calls[0]!.sql.includes('whaleu_ratings.scoped_releases'));
  assert.equal(
    f.calls.some((call) =>
      /category_icon|whaleu_media|whaleu_community/.test(call.sql),
    ),
    false,
  );
  assert.equal(f.reviewBatches.length, 0);
  assert.throws(() => f.descriptor());
});

test('unknown extension markers and missing cause digest fail before querying the new schema', async () => {
  for (const cause of [
    { categoryIconExtension: 'future' },
    { categoryIconExtension: null },
    { categoryIconExtension: 'ratings-category-icon-v1' },
  ]) {
    const f = fixture();
    f.head.cause = cause;
    await assert.rejects(() => f.gate());
    assert.equal(f.calls.length, 1);
  }
});

test('a valid mixed-release marker leaves excluded scopes on original reads only', async () => {
  const f = fixture();
  f.head.cause['categoryIconScopeKeys'] = [`campus:${id(20)}`];
  assert.deepEqual(await f.gate(), ['allow']);
  assert.equal(f.calls.length, 1);
  assert.equal(f.reviewBatches.length, 0);
  assert.equal(
    f.calls.some((call) =>
      /category_icon|whaleu_media|whaleu_community/.test(call.sql),
    ),
    false,
  );
  assert.throws(() => f.descriptor());
});

test('partial and noncanonical scoped markers cannot downgrade to original reads', async () => {
  const valid = {
    categoryIconExtension: 'ratings-category-icon-v1',
    categoryIconDigest: 'a'.repeat(64),
    categoryIconScopeKeys: ['global'],
  };
  const causes = [
    { categoryIconDigest: valid.categoryIconDigest },
    { categoryIconScopeKeys: ['global'] },
    { ...valid, categoryIconScopeKeys: null },
    { ...valid, categoryIconScopeKeys: [] },
    { ...valid, categoryIconScopeKeys: ['global', 'global'] },
    { ...valid, categoryIconScopeKeys: ['global', `campus:${id(20)}`] },
    { ...valid, categoryIconScopeKeys: ['campus:not-a-uuid'] },
    { ...valid, categoryIconScopeKeys: [1] },
    {
      ...valid,
      categoryIconScopeKeys: Array.from(
        { length: 1002 },
        (_, n) => `campus:${id(n + 1)}`,
      ).sort(),
    },
  ];
  for (const cause of causes) {
    const f = fixture();
    f.head.cause = cause;
    await assert.rejects(() => f.gate(), { code: 'RATING_SCOPE_UNAVAILABLE' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.reviewBatches.length, 0);
  }
});

test('scope extent seals adopted empty scopes and exact unadopted predecessor facts', async () => {
  const f = fixture();
  f.manifest.scope_extent.unshift({
    scopeKey: `campus:${id(20)}`,
    adopted: false,
    beforeCatalogId: id(21),
    beforeHeadRevision: id(22),
    beforeReleaseId: id(23),
    beforeAdopted: false,
  });
  f.reseal();
  assert.deepEqual(await f.gate(), ['allow']);

  const empty = fixture({ count: 0 });
  assert.deepEqual(await empty.gate(), []);

  const changed = fixture();
  changed.manifest.scope_extent.unshift({
    scopeKey: `campus:${id(20)}`,
    adopted: false,
    beforeCatalogId: null,
    beforeHeadRevision: null,
    beforeReleaseId: null,
    beforeAdopted: false,
  });
  await assert.rejects(() => changed.gate(), {
    code: 'RATING_SCOPE_UNAVAILABLE',
  });
});

test('manifest scope extent must be strict canonical and match the adopted marker exactly', async () => {
  for (const failure of [
    'missing',
    'duplicate',
    'unadopted',
    'prior-head',
    'prior-adoption',
    'extra',
    'marker',
  ] as const) {
    const f = fixture();
    const item = f.manifest.scope_extent[0]!;
    if (failure === 'missing')
      Object.assign(f.manifest, { scope_extent: undefined });
    if (failure === 'duplicate') f.manifest.scope_extent.push({ ...item });
    if (failure === 'unadopted') item.adopted = false;
    if (failure === 'prior-head') item.beforeCatalogId = id(21);
    if (failure === 'prior-adoption') item.beforeAdopted = true;
    if (failure === 'extra') Object.assign(item, { ignored: true });
    if (failure === 'marker')
      f.head.cause['categoryIconScopeKeys'] = [`campus:${id(20)}`, 'global'];
    if (failure !== 'missing') f.reseal();
    await assert.rejects(() => f.gate(), { code: 'RATING_SCOPE_UNAVAILABLE' });
    assert.equal(f.reviewBatches.length, 0);
  }
});

test('exact reviewed absence qualifies a null descriptor and caches immutable reads only in the same epoch', async () => {
  const f = fixture();
  assert.throws(() => f.descriptor());
  assert.deepEqual(await f.gate(), ['allow']);
  assert.equal(f.descriptor(), null);
  assert.deepEqual(await f.gate(), ['allow']);
  assert.equal(f.reviewBatches.length, 1);
  assert.equal(
    f.calls.filter((call) => call.sql.includes('to_jsonb(b) binding')).length,
    1,
  );
  const checkpoint = checkpointTransactionDeadlines(f.tx);
  restoreTransactionDeadlines(f.tx, checkpoint);
  assert.throws(() => f.descriptor());
  await f.gate();
  assert.equal(f.reviewBatches.length, 2);
});

test('a qualified exact base or campus image exposes only the opaque Media8 descriptor', async () => {
  for (const override of [false, true]) {
    const f = fixture({ image: true, override });
    assert.deepEqual(await f.gate(), ['allow']);
    const descriptor = f.descriptor();
    assert.deepEqual(descriptor, {
      protocol: 'ratings-category-icon-media-v1',
      kind: 'ratings-category-icon-media',
      categoryId: f.expectedRows[0]!.id,
      contextId: context.id,
      contextToken: context.token,
      appearanceId: f.mediaRows[0]!.parent_id,
      bindingId: f.mediaRows[0]!.binding_id,
      width: sealed.manifest.variants[1].width,
      height: sealed.manifest.variants[1].height,
      variants: ['thumb-v1', 'display-v1'],
    });
    assert.equal(
      /url|bucket|provider|objectKey/i.test(JSON.stringify(descriptor)),
      false,
    );
  }
});

test('manifest absence, missing or duplicate projection, count and digest mismatches never become null', async () => {
  for (const failure of [
    'manifest',
    'projection',
    'duplicate',
    'count',
    'digest',
    'cause',
    'roots',
    'definition',
  ] as const) {
    const f = fixture();
    if (failure === 'manifest') f.omitManifest();
    if (failure === 'projection') f.omitProjection();
    if (failure === 'duplicate') f.duplicateProjection();
    if (failure === 'count') f.manifest.row_count++;
    if (failure === 'digest') f.manifest.digest = '0'.repeat(64);
    if (failure === 'cause')
      f.head.cause['categoryIconDigest'] = '0'.repeat(64);
    if (failure === 'roots') f.manifest.root_snapshot = [];
    if (failure === 'definition') f.omitDefinition();
    await assert.rejects(() => f.gate());
    assert.throws(() => f.descriptor());
  }
});

test('strict projection rejects extra provider fields and every immutable release/body/definition mismatch', async () => {
  for (const patch of [
    { releaseId: id(999) },
    { catalogId: id(999) },
    { categoryId: id(999) },
    { effectiveRevision: id(999) },
    { effectiveDigest: '0'.repeat(64) },
    { placementRevision: id(999) },
    { scopeKey: `campus:${id(999)}` },
    { extensionVersion: 'future' },
    { url: 'https://example.invalid/image' },
  ]) {
    const f = fixture();
    Object.assign(f.projections[0]!, patch);
    const { digest, ...body } = f.projections[0]!;
    assert.equal(typeof digest, 'string');
    Object.assign(f.projections[0]!, {
      digest: categoryIconDigest('release-row', body),
    });
    f.reseal();
    await assert.rejects(() => f.gate());
    assert.throws(() => f.descriptor());
  }
});

test('persisted envelope and exact source roots must reproduce the unchanged original expected body', async () => {
  for (const failure of [
    'name',
    'source',
    'base',
    'override',
    'binding',
    'approval',
  ] as const) {
    const f = fixture({ override: true });
    if (failure === 'name')
      Object.assign(f.projections[0]!.content, { name: 'Unreviewed text' });
    if (failure === 'source')
      Object.assign(f.projections[0]!.content, {
        baseSource: { id: id(999), revision: id(998) },
      });
    if (failure === 'base')
      Object.assign(f.projections[0]!.content, { baseDefinitionId: id(999) });
    if (failure === 'override')
      Object.assign(f.projections[0]!.content, {
        overrideDefinitionId: id(999),
      });
    if (failure === 'binding') f.bindings[0]!.envelope = review8Envelope();
    if (failure === 'approval') f.bindings[0]!.approval_digest = '0'.repeat(64);
    const { digest, ...body } = f.projections[0]!;
    assert.equal(typeof digest, 'string');
    Object.assign(f.projections[0]!, {
      digest: categoryIconDigest('release-row', body),
    });
    f.reseal();
    await assert.rejects(() => f.gate());
  }
});

test('all requested pool rows are qualified; explicit reject denies and unknown Review fails the whole read', async () => {
  const denied = fixture({ count: 3 });
  denied.decisions.set(denied.envelopes[2]!.definitionId, 'deny');
  assert.deepEqual(await denied.gate(), ['allow', 'allow', 'deny']);
  assert.equal(denied.reviewBatches[0]?.length, 3);
  assert.throws(() => denied.descriptor(2));
  const unknown = fixture({ count: 3 });
  unknown.decisions.set(unknown.envelopes[2]!.definitionId, 'unavailable');
  await assert.rejects(() => unknown.gate());
  assert.throws(() => unknown.descriptor(0));
});

test('Media8 denied current attachment denies the category; malformed or missing metadata stays unavailable', async () => {
  const denied = fixture({ image: true });
  denied.mediaDecision('held');
  assert.deepEqual(await denied.gate(), ['deny']);
  assert.throws(() => denied.descriptor());
  for (const failure of [
    'missing',
    'unknown',
    'digest',
    'purpose',
    'slot',
  ] as const) {
    const f = fixture({ image: true });
    if (failure === 'missing') f.mediaRows.length = 0;
    if (failure === 'unknown') f.mediaDecision('unknown');
    if (failure === 'digest') f.mediaRows[0]!.manifest_digest = '0'.repeat(64);
    if (failure === 'purpose')
      f.mediaRows[0]!.purpose = 'ratings-target-cover-image';
    if (failure === 'slot') f.mediaRows[0]!.slot = 'cover';
    await assert.rejects(() => f.gate());
    assert.throws(() => f.descriptor());
  }
});

test('Review denial does not mask unknown media in another unselected pool row', async () => {
  const f = fixture({ image: true, count: 2 });
  f.decisions.set(f.envelopes[0]!.definitionId, 'deny');
  f.mediaRows[1]!.manifest_digest = '0'.repeat(64);
  await assert.rejects(() => f.gate());
  assert.throws(() => f.descriptor(0));
});

test('Review chunks never exceed 128 and every image is included, including the last pool entry', async () => {
  const f = fixture({ image: true, count: 129 });
  assert.equal((await f.gate()).length, 129);
  assert.deepEqual(
    f.reviewBatches.map((batch) => batch.length),
    [128, 1],
  );
  const reads = f.calls.filter((call) =>
    call.sql.includes('FROM unnest($1::uuid[],$2::text[])'),
  );
  assert.deepEqual(
    reads.map((call) => (call.values[0] as string[]).length),
    [128, 1],
  );
  assert.equal(f.descriptor(128)?.categoryId, f.expectedRows[128]!.id);
});

test('head moves during qualification, conflicting repeated bodies and cross-scope descriptors fail closed', async () => {
  const moved = fixture();
  moved.moveHead();
  await assert.rejects(() => moved.gate());
  assert.throws(() => moved.descriptor());
  const f = fixture();
  await f.gate();
  assert.throws(() =>
    currentCategoryIconDescriptor(
      { ...f.scope, catalog: { ...f.scope.catalog, id: id(999) } },
      f.expectedRows[0]!.id,
      context,
      f.tx,
    ),
  );
  await assert.rejects(() =>
    currentCategoryIcons(
      f.scope,
      [{ ...f.expectedRows[0]!, revision: id(999) }],
      f.tx,
      f.review,
    ),
  );
  const other = fixture();
  assert.throws(() =>
    currentCategoryIconDescriptor(
      f.scope,
      f.expectedRows[0]!.id,
      context,
      other.tx,
    ),
  );
});

test('all icon metadata shares the existing transaction 64 MiB ledger, including later chunks', async () => {
  const f = fixture();
  retainRatingReadByteCount(f.tx, 64 * 1024 * 1024 - 1);
  await assert.rejects(() => f.gate());
  assert.throws(() => f.descriptor());
});

test('required Category and Media8 fences run after deferred constraints and detect late writers', async () => {
  const good = fixture({ image: true });
  await good.gate();
  await checkTransactionDeadlines(good.tx);
  const deferred = good.calls.findIndex(
    (call) => call.sql === 'SET CONSTRAINTS ALL IMMEDIATE',
  );
  assert(deferred >= 0);
  assert(
    good.calls.findIndex((call) =>
      call.sql.includes('LOCK TABLE whaleu_ratings.category_icon_epoch'),
    ) > deferred,
  );
  assert(
    good.calls.findIndex((call) =>
      call.sql.includes('category_icon_request_markers IN SHARE MODE NOWAIT'),
    ) > deferred,
  );
  for (const owner of ['category', 'media'] as const) {
    const f = fixture({ image: true });
    await f.gate();
    if (owner === 'category') f.changeIconEpoch();
    else f.changeMediaEpoch();
    await assert.rejects(() => checkTransactionDeadlines(f.tx));
  }
});

test('current Category qualification never erases a previously captured external Media8 fact', async () => {
  const f = fixture({ image: true });
  await new CategoryIconMediaRequiredProof().capture(f.tx);
  f.changeMediaEpoch();
  await f.gate();
  await assert.rejects(() => checkTransactionDeadlines(f.tx));
});
