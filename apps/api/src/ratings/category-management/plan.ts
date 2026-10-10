import { ApplicationError } from '../../http/application-error.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import {
  canonicalRatingScopedEnvelope,
  type RatingScopedCategoryEnvelope,
} from '../../community/content-review/rating-scoped-contracts.js';
import { ratingScopedArtifactId } from '../scoped/commands.service.js';
import { ratingScopedDigest } from '../scoped/protocol-registry.js';
import {
  RatingScopedCompilationBudget,
  type ScopedExpectedCategory,
} from '../scoped/compiler.js';
import type { ScopedSourceRow } from '../scoped/source.facade.js';
import {
  categoryPlacementSchema,
  type RatingCategoryScopedIntent,
} from './scoped-contracts.js';

export interface ManagedCategoryRecord {
  scopeKey: string;
  catalogId: string;
  revision: string;
  expected: ScopedExpectedCategory;
  scopeKeys: string[];
  placementSourceId: string;
  placementSourceRevision: string;
  baseBody: ScopedExpectedCategory['body'] | null;
  bodyCurrent: boolean;
  baseMetadata?: Pick<
    ScopedExpectedCategory['body'],
    'active' | 'hidden' | 'ordinal' | 'originKind'
  >;
}
export interface ManagedTargetPlacement {
  targetId: string;
  categoryId: string;
  scopeKeys: string[];
  placementRevision: string;
}
export interface CategorySnapshot {
  sources: ScopedSourceRow[];
  categories: ManagedCategoryRecord[];
  targets: ManagedTargetPlacement[];
  heads: { scopeKey: string; catalogRevision: string; headRevision: string }[];
  compatHeads?: {
    compatKey: string;
    versionId: string;
    legacyCatalogId: string | null;
    scopeKeys: string[];
  }[];
  snapshotRevision: string;
  sourceDigest: string;
  validUntil: number;
  reviewBlockedSourceIds?: string[];
}
export interface CategorySourceIssue {
  id: string;
  revision: string;
  kind: string;
  key: string;
  scopeKeys: string[];
  payload: Record<string, unknown>;
  previousSourceId: string | null;
  previousSourceRevision: string | null;
  placement?: {
    revision: string;
    categoryId: string;
    baseSourceId: string;
    baseSourceRevision: string;
  };
}
export interface CategoryChange {
  categoryId: string;
  scopeKeys: string[];
  field:
    | 'body'
    | 'base_body'
    | 'effective_body'
    | 'visibility'
    | 'lifecycle'
    | 'scope'
    | 'order'
    | 'create';
  before: string | null;
  after: string | null;
  beforeStatus: 'available' | 'absent' | 'unavailable';
  afterStatus: 'available' | 'absent' | 'unavailable';
}
export interface CategoryManagementPlan {
  version: 1;
  accountId: string;
  requestId: string;
  intentHash: string;
  operation: RatingCategoryScopedIntent['operation'];
  sourceIssues: CategorySourceIssue[];
  envelopes: RatingScopedCategoryEnvelope[];
  categoryIds: string[];
  affectedScopeKeys: string[];
  globalRequired: boolean;
  beforeHeads: CategorySnapshot['heads'];
  beforeCompatHeads: NonNullable<CategorySnapshot['compatHeads']>;
  beforeBaseAvailability: {
    sourceId: string;
    sourceRevision: string;
    current: boolean;
  }[];
  beforeVector: unknown[];
  beforeDigest: string;
  policySourceId: string;
  policySourceRevision: string;
  registrySourceIds: string[];
  changes: CategoryChange[];
  affectedTargetCount: number;
  previewDigest: string;
  validUntil: string;
  noop: boolean;
}
const fail = (): never => {
  throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
};
const denied = (): never => {
  throw new ApplicationError('RATING_NOT_FOUND');
};
const unavailable = (): never => {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
};
const keys = (v: readonly string[]) => [...new Set(v)].sort();
export const managementScopeKey = (i: RatingCategoryScopedIntent) =>
  i.context.selector.kind === 'global'
    ? 'global'
    : `campus:${i.context.selector.campusId}`;
const placement = (v: string[]) =>
  categoryPlacementSchema.parse(
    v.length === 1 && v[0] === 'global'
      ? { kind: 'global' }
      : {
          kind: 'campuses',
          campusIds: v.map((k) =>
            k.startsWith('campus:') ? k.slice(7) : fail(),
          ),
        },
  );
const placementKeys = (p: ReturnType<typeof categoryPlacementSchema.parse>) =>
  p.kind === 'global' ? ['global'] : p.campusIds.map((id) => `campus:${id}`);
const bodyFields = (b: ScopedExpectedCategory['body']) => ({
  parentId: b.parentId,
  level: b.level as 1 | 2 | 3,
  kind: b.kind,
  systemKey: b.systemKey,
  name: b.name,
  description: b.description,
});

/** Pure exact change planner. It emits the existing source families, never projections. */
export function planCategoryManagement(
  actor: string,
  intent: RatingCategoryScopedIntent,
  hash: string,
  snapshot: CategorySnapshot,
): CategoryManagementPlan {
  const budget = new RatingScopedCompilationBudget();
  budget.observe(snapshot);
  const selected = managementScopeKey(intent),
    current = snapshot.categories.filter((r) => r.scopeKey === selected);
  const sourceMap = new Map(snapshot.sources.map((s) => [s.id, s]));
  const planned = new Map<string, CategorySourceIssue>(),
    changes: Omit<CategoryChange, 'beforeStatus' | 'afterStatus'>[] = [],
    touched = new Set<string>(),
    affected = new Set<string>([selected]),
    registries = new Set<string>();
  let globalRequired = selected === 'global';
  const source = (id: string | null) =>
    id ? (sourceMap.get(id) ?? unavailable()) : null;
  const records = (id: string) =>
    snapshot.categories.filter((r) => r.expected.body.id === id);
  const get = (id: string) =>
    current.find((r) => r.expected.body.id === id) ?? denied();
  const getAny = (id: string) =>
    current.find((r) => r.expected.body.id === id) ??
    snapshot.categories.find((r) => r.expected.body.id === id) ??
    denied();
  const prior = (kind: string, key: string) =>
    snapshot.sources.find(
      (s) => s.source_kind === kind && s.source_key === key,
    );
  const issue = (
    kind: string,
    key: string,
    scopeKeys: string[],
    payload: Record<string, unknown>,
  ) => {
    const previous = prior(kind, key),
      id = ratingScopedArtifactId(hash, `category-source:${kind}:${key}`),
      revision = ratingScopedArtifactId(
        hash,
        `category-source-revision:${kind}:${key}`,
      );
    const item: CategorySourceIssue = {
      id,
      revision,
      kind,
      key,
      scopeKeys: keys(scopeKeys),
      payload: {
        ...payload,
        management: {
          version: 1,
          accountId: actor,
          requestId: intent.payload.clientRequestId,
          intentHash: hash,
        },
      },
      previousSourceId: previous?.id ?? null,
      previousSourceRevision: previous?.revision ?? null,
    };
    planned.set(`${kind}:${key}`, item);
    for (const k of keys([...(previous?.scope_keys ?? []), ...item.scopeKeys]))
      affected.add(k);
    return item;
  };
  const registry = (systemKey: string) => {
    const rows = snapshot.sources.filter(
      (s) =>
        s.source_kind === 'scoped_category_system_registry' &&
        s.payload['systemKey'] === systemKey &&
        s.current,
    );
    if (rows.length !== 1) unavailable();
    const r = rows[0]!;
    if (
      r.payload['enabled'] !== true ||
      r.payload['kind'] !== 'general' ||
      r.payload['consumer'] !== 'ratings_general_v1' ||
      typeof r.payload['maximumDepth'] !== 'number' ||
      ![1, 2, 3].includes(r.payload['maximumDepth'])
    )
      unavailable();
    registries.add(r.id);
    return r;
  };
  const ancestry = (row: ManagedCategoryRecord) => {
    const result = [row];
    while (result.at(-1)!.expected.body.parentId) {
      const last = result.at(-1)!,
        parent =
          records(last.expected.body.parentId!).find(
            (r) => r.scopeKey === last.scopeKey,
          ) ?? denied();
      if (result.length >= 3) fail();
      result.push(parent);
    }
    return result;
  };
  const authorizeBase = (row: ManagedCategoryRecord) => {
    const all = records(row.expected.body.id);
    for (const r of all) for (const k of r.scopeKeys) affected.add(k);
    for (const dep of snapshot.sources.filter(
      (s) =>
        [
          'scoped_category_override',
          'scoped_category_lifecycle',
          'scoped_category_order',
        ].includes(s.source_kind) &&
        String(
          s.payload['categoryId'] ??
            (
              s.payload['reviewEnvelope'] as Record<string, unknown> | undefined
            )?.['categoryId'],
        ) === row.expected.body.id,
    ))
      for (const k of dep.scope_keys) affected.add(k);
    if (
      all.some(
        (r) =>
          r.expected.body.originKind === 'global' || r.expected.body.isSystem,
      )
    )
      globalRequired = true;
    const root = ancestry(row).find((r) => r.expected.body.systemKey !== null);
    if (root) {
      registry(root.expected.body.systemKey!);
      globalRequired = true;
    }
  };
  const review = (
    item: CategorySourceIssue,
    body: ScopedExpectedCategory['body'],
    override?: {
      baseSourceId: string;
      baseSourceRevision: string;
      campusId: string;
    },
  ) => {
    const issuanceDigest = ratingScopedDigest('category-issuance', {
      accountId: actor,
      requestId: intent.payload.clientRequestId,
      intentHash: hash,
      kind: item.kind,
      key: item.key,
      scopeKeys: item.scopeKeys,
      payload: item.payload,
    });
    const shared = {
      version: 5,
      accountId: actor,
      sourceId: item.id,
      sourceRevision: item.revision,
      categoryId: body.id,
      identityId: body.identityId,
      issuanceId: item.id,
      issuanceDigest,
      placement: placement(item.scopeKeys),
      assetIds: [],
    };
    const envelope = canonicalRatingScopedEnvelope(
      override
        ? {
            ...shared,
            purpose: 'publish_rating_category_override_scoped',
            baseSourceId: override.baseSourceId,
            baseSourceRevision: override.baseSourceRevision,
            scope: { kind: 'campus', campusId: override.campusId },
            body: { name: body.name, description: body.description },
          }
        : {
            ...shared,
            purpose: 'publish_rating_category_base_scoped',
            body: bodyFields(body),
          },
    ) as RatingScopedCategoryEnvelope;
    item.payload = {
      ...item.payload,
      issuanceDigest,
      reviewEnvelope: envelope,
    };
  };
  const lifecycle = (
    row: ManagedCategoryRecord,
    state: string,
    hidden: boolean,
    businessRevision?: string,
  ) => {
    const old = source(row.expected.lifecycleSourceId),
      b = row.expected.body;
    const business =
      businessRevision ??
      String(
        old?.payload['businessStateRevision'] ??
          row.expected.baseSourceRevision,
      );
    const partitions = old?.scope_keys ?? [row.scopeKey];
    let requested: CategorySourceIssue | undefined;
    for (const [index, k] of partitions.entries()) {
      const key = old
        ? index === 0
          ? old.source_key
          : `category:${b.id}:${k}`
        : `category:${b.id}:${k}`;
      const existing = planned.get(`scoped_category_lifecycle:${key}`);
      if (k !== row.scopeKey && existing) continue;
      const own = k === row.scopeKey,
        nextState = own
          ? state
          : String(
              old?.payload['businessState'] ??
                (old?.payload['active'] === true ? 'enabled' : 'disabled'),
            );
      const item = issue('scoped_category_lifecycle', key, [k], {
        categoryId: b.id,
        baseSourceId: row.expected.baseSourceId,
        baseSourceRevision: row.expected.baseSourceRevision,
        active: nextState === 'enabled',
        hidden: own ? hidden : old?.payload['hidden'] === true,
        businessState: nextState,
        businessStateRevision: own
          ? business
          : String(
              old?.payload['businessStateRevision'] ??
                row.expected.baseSourceRevision,
            ),
        authorizedExit: nextState !== 'enabled',
        ...(old
          ? {
              lifecyclePredecessor: {
                sourceId: old.id,
                sourceRevision: old.revision,
              },
            }
          : {}),
      });
      if (own) requested = item;
    }
    if (!requested) unavailable();
    touched.add(b.id);
    return requested;
  };
  const stateOf = (r: ManagedCategoryRecord) =>
    String(
      source(r.expected.lifecycleSourceId)?.payload['businessState'] ??
        (r.expected.body.active ? 'enabled' : 'disabled'),
    );
  const changeLife = (id: string, state: string, restore: boolean) => {
    const row = get(id);
    authorizeBase(row);
    const before = stateOf(row);
    if (row.expected.body.isSystem) {
      const r = registry(row.expected.body.systemKey!);
      if (
        state === 'archived' ||
        (state === 'disabled' && r.payload['allowDisable'] !== true)
      )
        denied();
    }
    const existingStates = [
      ...records(id).map(stateOf),
      ...snapshot.sources
        .filter(
          (s) =>
            s.source_kind === 'scoped_category_lifecycle' &&
            s.payload['categoryId'] === id,
        )
        .map((s) =>
          String(
            s.payload['businessState'] ??
              (s.payload['active'] === true ? 'enabled' : 'disabled'),
          ),
        ),
    ];
    if (!restore && existingStates.every((value) => value === state)) return;
    if (
      existingStates.includes('archived') &&
      !(restore && state === 'disabled')
    )
      denied();
    if (!existingStates.includes('archived') && restore) fail();
    const revision = ratingScopedArtifactId(hash, `business-state:${id}`);
    for (const r of records(id))
      lifecycle(r, state, r.expected.body.hidden, revision);
    for (const dormant of snapshot.sources.filter(
      (s) =>
        s.source_kind === 'scoped_category_lifecycle' &&
        s.payload['categoryId'] === id,
    ))
      for (const k of dormant.scope_keys.filter(
        (k) => !records(id).some((r) => r.scopeKey === k),
      )) {
        const virtual = {
          ...row,
          scopeKey: k,
          expected: {
            ...row.expected,
            lifecycleSourceId: dormant.id,
            lifecycleSourceRevision: dormant.revision,
          },
        };
        lifecycle(virtual, state, dormant.payload['hidden'] === true, revision);
      }
    changes.push({
      categoryId: id,
      scopeKeys: keys(records(id).map((r) => r.scopeKey)),
      field: 'lifecycle',
      before,
      after: state,
    });
  };
  const uniqueName = (
    name: string,
    parentId: string | null,
    scopes: string[],
    except?: string,
  ) => {
    if (
      snapshot.categories.some(
        (r) =>
          scopes.includes(r.scopeKey) &&
          r.expected.body.parentId === parentId &&
          r.expected.body.id !== except &&
          r.expected.body.name === name,
      )
    )
      fail();
  };
  const rebase = (
    row: ManagedCategoryRecord,
    name: string,
    description: string,
    newKeys?: string[],
  ) => {
    authorizeBase(row);
    const id = row.expected.body.id;
    uniqueName(
      name,
      row.expected.body.parentId,
      newKeys ?? keys(records(id).map((r) => r.scopeKey)),
      id,
    );
    const grouped = new Map<string, ManagedCategoryRecord[]>();
    for (const r of records(id)) {
      const group = grouped.get(r.expected.baseSourceId) ?? [];
      group.push(r);
      grouped.set(r.expected.baseSourceId, group);
    }
    const merging = !!newKeys && grouped.size > 1,
      originalBases = new Set(grouped.keys());
    if (merging) {
      const all = records(id),
        first = all[0]!,
        canonical = (r: ManagedCategoryRecord) =>
          r.baseBody
            ? canonicalJson({
                body: bodyFields(r.baseBody),
                identityKind: r.baseBody.identityKind,
                identityId: r.baseBody.identityId,
                metadata: {
                  active: r.baseMetadata?.active ?? r.baseBody.active,
                  hidden: r.baseMetadata?.hidden ?? r.baseBody.hidden,
                  ordinal: r.baseMetadata?.ordinal ?? r.baseBody.ordinal,
                },
                state: stateOf(r),
              })
            : null;
      const expected = canonical(first);
      if (expected === null || all.some((r) => canonical(r) !== expected))
        throw new ApplicationError('RATING_CATEGORY_SOURCE_UNRESOLVED');
      grouped.clear();
      grouped.set(first.expected.baseSourceId, all);
    }
    for (const rows of grouped.values()) {
      const r = rows[0]!,
        old = source(r.expected.baseSourceId)!,
        scopeKeys = newKeys ?? keys(rows.flatMap((rr) => rr.scopeKeys));
      const b = { ...r.expected.body, name, description };
      const originId = String(old.payload['originSourceId'] ?? old.id),
        originRevision = String(
          old.payload['originSourceRevision'] ?? old.revision,
        );
      const base = issue(
        'scoped_category_base',
        old.source_kind === 'scoped_category_base'
          ? old.source_key
          : `category:${id}:${old.id}`,
        scopeKeys,
        {
          active:
            r.baseMetadata?.active ??
            r.baseBody?.active ??
            r.expected.body.active,
          hidden: r.baseMetadata?.hidden ?? r.baseBody?.hidden ?? false,
          ordinal:
            r.baseMetadata?.ordinal ??
            r.baseBody?.ordinal ??
            r.expected.body.ordinal,
          originKind: b.isSystem
            ? 'system'
            : newKeys
              ? newKeys[0] === 'global'
                ? 'global'
                : 'regional'
              : b.originKind,
          identityKind: b.identityKind,
          identityId: b.identityId,
          originSourceId: originId,
          originSourceRevision: originRevision,
          previousBaseSourceId: old.id,
          previousBaseSourceRevision: old.revision,
          categoryId: id,
          ...(b.systemKey
            ? {
                maximumDepth:
                  old.payload['maximumDepth'] ??
                  registry(b.systemKey).payload['maximumDepth'],
                registrySourceId: registry(b.systemKey).id,
                registrySourceRevision: registry(b.systemKey).revision,
              }
            : {}),
        },
      );
      review(base, b);
      const placements = new Map(rows.map((v) => [v.placementSourceId, v]));
      let placementIndex = 0;
      for (const rr of placements.values()) {
        const oldScope = source(rr.placementSourceId)!,
          ks = newKeys ?? rr.scopeKeys,
          placementRevision = ratingScopedArtifactId(
            hash,
            `placement:${oldScope.source_key}`,
          );
        if (newKeys && placementIndex++ > 0) {
          issue(
            'scoped_category_scope',
            oldScope.source_key,
            oldScope.scope_keys,
            {
              categoryId: id,
              baseSourceId: base.id,
              baseSourceRevision: base.revision,
              action: 'retired',
              authorizedExit: true,
            },
          );
          continue;
        }
        const p = issue('scoped_category_scope', oldScope.source_key, ks, {
          categoryId: id,
          baseSourceId: base.id,
          baseSourceRevision: base.revision,
          placementRevision,
          scopeKeys: ks,
          placement: placement(ks),
          authorizedExit: !!newKeys,
        });
        p.placement = {
          revision: placementRevision,
          categoryId: id,
          baseSourceId: base.id,
          baseSourceRevision: base.revision,
        };
      }
      const dependencies = snapshot.sources.filter(
        (s) =>
          [
            'scoped_category_override',
            'scoped_category_lifecycle',
            'scoped_category_order',
          ].includes(s.source_kind) &&
          String(
            s.payload['categoryId'] ??
              (
                s.payload['reviewEnvelope'] as
                  Record<string, unknown> | undefined
              )?.['categoryId'],
          ) === id &&
          (merging
            ? originalBases.has(
                String(
                  s.payload['baseSourceId'] ??
                    (
                      s.payload['reviewEnvelope'] as
                        Record<string, unknown> | undefined
                    )?.['baseSourceId'],
                ),
              )
            : String(
                s.payload['baseSourceId'] ??
                  (
                    s.payload['reviewEnvelope'] as
                      Record<string, unknown> | undefined
                  )?.['baseSourceId'],
              ) === old.id &&
              String(
                s.payload['baseSourceRevision'] ??
                  (
                    s.payload['reviewEnvelope'] as
                      Record<string, unknown> | undefined
                  )?.['baseSourceRevision'],
              ) === old.revision),
      );
      for (const previous of dependencies) {
        if (previous.source_kind === 'scoped_category_lifecycle') {
          for (const [index, k] of previous.scope_keys.entries()) {
            const key =
                index === 0 ? previous.source_key : `category:${id}:${k}`,
              state = String(
                previous.payload['businessState'] ??
                  (previous.payload['active'] === true
                    ? 'enabled'
                    : 'disabled'),
              );
            issue('scoped_category_lifecycle', key, [k], {
              categoryId: id,
              baseSourceId: base.id,
              baseSourceRevision: base.revision,
              active: state === 'enabled',
              hidden: previous.payload['hidden'] === true,
              businessState: state,
              businessStateRevision: String(
                previous.payload['businessStateRevision'] ??
                  previous.payload['baseSourceRevision'],
              ),
              authorizedExit: state !== 'enabled',
              lifecyclePredecessor: {
                sourceId: previous.id,
                sourceRevision: previous.revision,
              },
            });
          }
          continue;
        }
        const payload: Record<string, unknown> = {
          ...previous.payload,
          categoryId: id,
          baseSourceId: base.id,
          baseSourceRevision: base.revision,
        };
        delete payload['reviewEnvelope'];
        delete payload['issuanceDigest'];
        const next = issue(
          previous.source_kind,
          previous.source_key,
          previous.scope_keys,
          payload,
        );
        if (previous.source_kind === 'scoped_category_override') {
          const oldBody = (
            previous.payload['reviewEnvelope'] as
              RatingScopedCategoryEnvelope | undefined
          )?.body as { name: string; description: string } | undefined;
          const modes = (previous.payload['modes'] ??
            (oldBody
              ? {
                  name: { mode: 'set', value: oldBody.name },
                  description: { mode: 'set', value: oldBody.description },
                }
              : {
                  name: { mode: 'inherit' },
                  description: { mode: 'inherit' },
                })) as {
            name: { mode: string; value?: string };
            description: { mode: string; value?: string };
          };
          next.payload['modes'] = modes;
          if (previous.payload['action'] !== 'inherit')
            review(
              next,
              {
                ...b,
                name: modes.name.mode === 'inherit' ? name : modes.name.value!,
                description:
                  modes.description.mode === 'inherit'
                    ? description
                    : modes.description.value!,
              },
              {
                baseSourceId: base.id,
                baseSourceRevision: base.revision,
                campusId: previous.scope_keys[0]!.slice(7),
              },
            );
        }
      }
      // Dormant views retain their metadata. A genuinely new view inherits the current shared lifecycle.
      if (newKeys)
        for (const k of newKeys.filter(
          (k) =>
            !rows.some((rr) => rr.scopeKey === k) &&
            !dependencies.some(
              (s) =>
                s.source_kind === 'scoped_category_lifecycle' &&
                s.scope_keys.includes(k),
            ),
        )) {
          const rr = {
            ...r,
            scopeKey: k,
            expected: {
              ...r.expected,
              baseSourceId: base.id,
              baseSourceRevision: base.revision,
              lifecycleSourceId: null,
              lifecycleSourceRevision: null,
            },
          };
          lifecycle(
            rr,
            stateOf(r),
            false,
            String(
              source(r.expected.lifecycleSourceId)?.payload[
                'businessStateRevision'
              ] ?? base.revision,
            ),
          );
        }
    }
    touched.add(id);
    const oldScopes = keys(records(id).map((r) => r.scopeKey)),
      nextScopes = newKeys ?? oldScopes;
    if (newKeys)
      changes.push({
        categoryId: id,
        scopeKeys: keys([...oldScopes, ...newKeys]),
        field: 'scope',
        before: canonicalJson(oldScopes),
        after: canonicalJson(newKeys),
      });
    for (const rows of grouped.values()) {
      const r = rows[0]!;
      changes.push({
        categoryId: id,
        scopeKeys: keys(rows.flatMap((x) => x.scopeKeys)),
        field: 'base_body',
        before:
          r.baseBody &&
          rows.every(
            (rr) => rr.bodyCurrent && ancestry(rr).every((x) => x.bodyCurrent),
          ) &&
          !snapshot.reviewBlockedSourceIds?.includes(r.expected.baseSourceId)
            ? canonicalJson({
                name: r.baseBody.name,
                description: r.baseBody.description,
              })
            : null,
        after:
          newKeys &&
          (!r.bodyCurrent || !ancestry(r).every((x) => x.bodyCurrent))
            ? null
            : canonicalJson({ name, description }),
      });
    }
    const overrides = snapshot.sources.filter(
      (s) =>
        s.source_kind === 'scoped_category_override' &&
        String(
          s.payload['categoryId'] ??
            (
              s.payload['reviewEnvelope'] as Record<string, unknown> | undefined
            )?.['categoryId'],
        ) === id,
    );
    const views = keys([
      ...oldScopes,
      ...nextScopes,
      ...overrides.flatMap((s) => s.scope_keys),
      ...snapshot.sources
        .filter(
          (s) =>
            s.source_kind === 'scoped_category_lifecycle' &&
            s.payload['categoryId'] === id,
        )
        .flatMap((s) => s.scope_keys),
    ]);
    for (const k of views) {
      const r = records(id).find((x) => x.scopeKey === k),
        over = overrides.find((s) => s.scope_keys.includes(k));
      const oldBody = (
        over?.payload['reviewEnvelope'] as
          RatingScopedCategoryEnvelope | undefined
      )?.body as { name: string; description: string } | undefined;
      const modes = (over?.payload['modes'] ??
        (oldBody
          ? {
              name: { mode: 'set', value: oldBody.name },
              description: { mode: 'set', value: oldBody.description },
            }
          : {
              name: { mode: 'inherit' },
              description: { mode: 'inherit' },
            })) as {
        name: { mode: string; value?: string };
        description: { mode: string; value?: string };
      };
      const hidden =
        r?.expected.body.hidden ??
        snapshot.sources.find(
          (s) =>
            s.source_kind === 'scoped_category_lifecycle' &&
            s.payload['categoryId'] === id &&
            s.scope_keys.includes(k),
        )?.payload['hidden'] === true;
      const parentsCurrent = () => {
        let parent = row.expected.body.parentId,
          depth = 0;
        while (parent) {
          const node = snapshot.categories.find(
            (x) => x.scopeKey === k && x.expected.body.id === parent,
          );
          if (!node || !node.bodyCurrent || ++depth > 2) return false;
          parent = node.expected.body.parentId;
        }
        return true;
      };
      const overrideBaseId = String(
        over?.payload['baseSourceId'] ??
          (
            over?.payload['reviewEnvelope'] as
              Record<string, unknown> | undefined
          )?.['baseSourceId'] ??
          r?.expected.baseSourceId ??
          row.expected.baseSourceId,
      );
      const safeOldView =
        parentsCurrent() &&
        !snapshot.reviewBlockedSourceIds?.includes(overrideBaseId) &&
        (!over || !snapshot.reviewBlockedSourceIds?.includes(over.id));
      const safeBefore = !!r && r.bodyCurrent && safeOldView;
      const effective = {
        name: modes.name.mode === 'set' ? modes.name.value! : name,
        description:
          modes.description.mode === 'set'
            ? modes.description.value!
            : description,
        modes,
        applicable: nextScopes.includes(k),
        hidden,
      };
      changes.push({
        categoryId: id,
        scopeKeys: [k],
        field: 'effective_body',
        before: safeBefore
          ? canonicalJson({
              name: r.expected.body.name,
              description: r.expected.body.description,
              modes,
              applicable: true,
              hidden: r.expected.body.hidden,
            })
          : null,
        after:
          (over || newKeys) && !safeOldView ? null : canonicalJson(effective),
      });
    }
  };
  const additions: ManagedCategoryRecord[] = [];
  const add = (
    nodes: Extract<
      RatingCategoryScopedIntent,
      { operation: 'create_categories_scoped' }
    >['payload']['nodes'],
    parentId: string | null,
    scopeKeys: string[],
    system?: { key: string; levelCount: number },
  ) => {
    if (scopeKeys.includes('global')) globalRequired = true;
    scopeKeys.forEach((k) => affected.add(k));
    const baseParent = parentId ? get(parentId) : null;
    if (baseParent) {
      if (stateOf(baseParent) !== 'enabled') denied();
      for (const k of scopeKeys)
        if (!records(parentId!).some((r) => r.scopeKey === k)) denied();
    }
    const systemRoot = system
      ? registry(system.key)
      : baseParent
        ? ancestry(baseParent)
            .map((r) => r.expected.body.systemKey)
            .filter((k): k is string => k !== null)
            .map(registry)[0]
        : undefined;
    const systemAncestor = baseParent
      ? ancestry(baseParent).find((r) => r.expected.body.systemKey)
      : undefined;
    if (systemAncestor && systemRoot?.payload['allowChildren'] !== true)
      denied();
    if (systemRoot) globalRequired = true;
    const configuredDepth = systemAncestor
      ? Number(
          source(systemAncestor.expected.baseSourceId)?.payload[
            'maximumDepth'
          ] ?? systemRoot?.payload['maximumDepth'],
        )
      : 3;
    const maxDepth = systemRoot
      ? Math.min(
          Number(systemRoot.payload['maximumDepth']),
          system ? system.levelCount : configuredDepth,
        )
      : 3;
    if (system && system.levelCount > maxDepth) fail();
    const byKey = new Map<
      string,
      { body: ScopedExpectedCategory['body']; source: CategorySourceIssue }
    >();
    for (const node of nodes) {
      if (
        byKey.has(node.key) ||
        (node.parentKey !== null && !byKey.has(node.parentKey))
      )
        fail();
      const parent = node.parentKey
        ? byKey.get(node.parentKey)!.body
        : (baseParent?.expected.body ?? null);
      const level = (parent?.level ?? 0) + 1;
      if (level > 3 || level > maxDepth) fail();
      const id = ratingScopedArtifactId(hash, `category:${node.key}`);
      if (snapshot.categories.some((r) => r.expected.body.id === id)) fail();
      uniqueName(node.name, parent?.id ?? null, scopeKeys);
      if (
        [...byKey.values()].some(
          (v) =>
            v.body.parentId === (parent?.id ?? null) &&
            v.body.name === node.name,
        )
      )
        fail();
      const ordinal = (
        snapshot.categories
          .filter((r) => scopeKeys.includes(r.scopeKey))
          .reduce(
            (n, r) =>
              BigInt(r.expected.body.ordinal) > n
                ? BigInt(r.expected.body.ordinal)
                : n,
            -1n,
          ) +
        BigInt(byKey.size) +
        1n
      ).toString();
      const body: ScopedExpectedCategory['body'] = {
        id,
        parentId: parent?.id ?? null,
        level,
        kind: system
          ? String(systemRoot!.payload['kind'])
          : (parent?.kind ?? 'general'),
        systemKey: system ? system.key : null,
        isSystem: !!system,
        originKind: system
          ? 'system'
          : scopeKeys[0] === 'global'
            ? 'global'
            : 'regional',
        name: node.name,
        description: node.description,
        active: true,
        hidden: false,
        ordinal,
        identityKind: 'scoped_source',
        identityId: id,
      };
      const base = issue('scoped_category_base', `category:${id}`, scopeKeys, {
        categoryId: id,
        active: true,
        hidden: false,
        ordinal,
        originKind: body.originKind,
        identityKind: body.identityKind,
        identityId: id,
        originSourceId: null,
        originSourceRevision: null,
        previousBaseSourceId: null,
        previousBaseSourceRevision: null,
        ...(system
          ? {
              maximumDepth: system.levelCount,
              registrySourceId: systemRoot!.id,
              registrySourceRevision: systemRoot!.revision,
            }
          : {}),
      });
      review(base, body);
      const pr = ratingScopedArtifactId(hash, `placement:${id}`),
        p = issue('scoped_category_scope', `category:${id}`, scopeKeys, {
          categoryId: id,
          baseSourceId: base.id,
          baseSourceRevision: base.revision,
          placementRevision: pr,
          scopeKeys,
          placement: placement(scopeKeys),
        });
      p.placement = {
        revision: pr,
        categoryId: id,
        baseSourceId: base.id,
        baseSourceRevision: base.revision,
      };
      for (const k of scopeKeys)
        additions.push({
          scopeKey: k,
          catalogId: '',
          revision: id,
          expected: {
            body,
            baseSourceId: base.id,
            baseSourceRevision: base.revision,
            overrideSourceId: null,
            overrideSourceRevision: null,
            lifecycleSourceId: null,
            lifecycleSourceRevision: null,
            orderSourceId: null,
            orderSourceRevision: null,
            placementRevision: pr,
          },
          scopeKeys,
          placementSourceId: p.id,
          placementSourceRevision: p.revision,
          baseBody: body,
          bodyCurrent: true,
        });
      byKey.set(node.key, { body, source: base });
      touched.add(id);
      changes.push({
        categoryId: id,
        scopeKeys,
        field: 'create',
        before: null,
        after: canonicalJson(bodyFields(body)),
      });
    }
    return byKey;
  };
  const reorder = (parentId: string | null, ids: string[], inherit = false) => {
    const siblings = [
        ...current,
        ...additions.filter((r) => r.scopeKey === selected),
      ].filter((r) => r.expected.body.parentId === parentId),
      set = keys(siblings.map((r) => r.expected.body.id));
    const ordered = inherit
      ? [...siblings]
          .sort((a, b) =>
            BigInt(a.baseBody?.ordinal ?? a.expected.body.ordinal) <
            BigInt(b.baseBody?.ordinal ?? b.expected.body.ordinal)
              ? -1
              : 1,
          )
          .map((r) => r.expected.body.id)
      : ids;
    if (
      canonicalJson(keys(ordered)) !== canonicalJson(set) ||
      ordered.length !== set.length
    )
      fail();
    const slots = siblings
      .map((r) => BigInt(r.expected.body.ordinal))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [n, id] of ordered.entries()) {
      const r = siblings.find((s) => s.expected.body.id === id)!,
        ordinal = slots[n]!.toString(),
        old = source(r.expected.orderSourceId);
      if (
        ordinal === r.expected.body.ordinal &&
        (!inherit || !old || old.payload['action'] === 'inherit')
      )
        continue;
      const baseReplacement = [...planned.values()].find(
        (s) =>
          s.kind === 'scoped_category_base' &&
          (s.payload['reviewEnvelope'] as RatingScopedCategoryEnvelope)
            ?.categoryId === id &&
          s.scopeKeys.includes(selected),
      );
      issue(
        'scoped_category_order',
        old?.source_key ?? `category:${id}:${selected}`,
        [selected],
        {
          categoryId: id,
          parentId,
          baseSourceId: baseReplacement?.id ?? r.expected.baseSourceId,
          baseSourceRevision:
            baseReplacement?.revision ?? r.expected.baseSourceRevision,
          ordinal,
          action: inherit ? 'inherit' : 'set',
          siblingIds: ordered,
        },
      );
      touched.add(id);
      changes.push({
        categoryId: id,
        scopeKeys: [selected],
        field: 'order',
        before: r.expected.body.ordinal,
        after: ordinal,
      });
    }
  };
  const p = intent.payload;
  switch (intent.operation) {
    case 'create_categories_scoped': {
      const v = intent.payload;
      if (v.nodes.filter((n) => n.parentKey === null).length !== 1) fail();
      add(v.nodes, v.parentId, placementKeys(v.placement));
      break;
    }
    case 'create_system_category_scoped': {
      const v = intent.payload;
      globalRequired = true;
      if (
        snapshot.categories.some(
          (r) => r.expected.body.systemKey === v.systemKey,
        )
      )
        fail();
      add(
        [
          {
            key: 'root',
            parentKey: null,
            name: v.name,
            description: v.description,
          },
        ],
        null,
        placementKeys(v.placement),
        { key: v.systemKey, levelCount: v.levelCount },
      );
      break;
    }
    case 'edit_category_base_scoped': {
      const v = intent.payload,
        r = get(v.categoryId);
      authorizeBase(r);
      if (
        records(v.categoryId).some(
          (rr) =>
            rr.baseBody?.name !== v.name ||
            rr.baseBody?.description !== v.description,
        )
      )
        rebase(r, v.name, v.description);
      break;
    }
    case 'set_category_override_scoped': {
      const v = intent.payload,
        r = get(v.categoryId),
        b = r.baseBody ?? unavailable();
      if (selected === 'global') denied();
      if (r.expected.body.originKind === 'global') globalRequired = true;
      const root = ancestry(r).find((x) => x.expected.body.systemKey);
      if (
        root &&
        registry(root.expected.body.systemKey!).payload[
          'allowCampusOverride'
        ] !== true
      )
        denied();
      const old = source(r.expected.overrideSourceId),
        modes = { name: v.name, description: v.description };
      const oldModes =
        old?.payload['modes'] ??
        (old
          ? {
              name: { mode: 'set', value: r.expected.body.name },
              description: { mode: 'set', value: r.expected.body.description },
            }
          : { name: { mode: 'inherit' }, description: { mode: 'inherit' } });
      if (canonicalJson(oldModes) === canonicalJson(modes)) break;
      const item = issue(
        'scoped_category_override',
        old?.source_key ?? `category:${v.categoryId}:${selected}`,
        [selected],
        {
          categoryId: v.categoryId,
          baseSourceId: r.expected.baseSourceId,
          baseSourceRevision: r.expected.baseSourceRevision,
          modes,
          action:
            v.name.mode === 'inherit' && v.description.mode === 'inherit'
              ? 'inherit'
              : 'set',
        },
      );
      const next = {
        ...b,
        name: v.name.mode === 'set' ? v.name.value : b.name,
        description:
          v.description.mode === 'set' ? v.description.value : b.description,
      };
      if (item.payload['action'] === 'set')
        review(item, next, {
          baseSourceId: r.expected.baseSourceId,
          baseSourceRevision: r.expected.baseSourceRevision,
          campusId: selected.slice(7),
        });
      touched.add(v.categoryId);
      changes.push({
        categoryId: v.categoryId,
        scopeKeys: [selected],
        field: 'body',
        before:
          r.bodyCurrent && ancestry(r).every((x) => x.bodyCurrent)
            ? canonicalJson({
                name: r.expected.body.name,
                description: r.expected.body.description,
              })
            : null,
        after:
          (r.bodyCurrent && ancestry(r).every((x) => x.bodyCurrent)) ||
          (v.name.mode === 'set' && v.description.mode === 'set')
            ? canonicalJson({ name: next.name, description: next.description })
            : null,
      });
      break;
    }
    case 'set_category_visibility_scoped': {
      const v = intent.payload,
        r = get(v.categoryId);
      if (r.expected.body.originKind === 'global') globalRequired = true;
      const root = ancestry(r).find((x) => x.expected.body.systemKey);
      if (
        root &&
        registry(root.expected.body.systemKey!).payload[
          'allowCampusOverride'
        ] !== true
      )
        denied();
      if (r.expected.body.hidden !== v.hidden) {
        lifecycle(r, stateOf(r), v.hidden);
        changes.push({
          categoryId: v.categoryId,
          scopeKeys: [selected],
          field: 'visibility',
          before: String(r.expected.body.hidden),
          after: String(v.hidden),
        });
      }
      break;
    }
    case 'reorder_categories_scoped': {
      const v = intent.payload;
      if (v.parentId) {
        const parent = get(v.parentId),
          root = ancestry(parent).find((r) => r.expected.body.systemKey);
        if (root) registry(root.expected.body.systemKey!);
      }
      if (v.action === 'inherit' && v.orderedIds.length) fail();
      reorder(v.parentId, v.orderedIds, v.action === 'inherit');
      break;
    }
    case 'set_category_lifecycle_scoped': {
      const v = intent.payload;
      changeLife(v.categoryId, v.state, v.restore);
      break;
    }
    case 'set_category_scope_scoped': {
      const v = intent.payload;
      globalRequired = true;
      const root = get(v.categoryId),
        ks = placementKeys(v.placement),
        desc = new Set([v.categoryId]);
      let again = true;
      while (again) {
        again = false;
        for (const r of snapshot.categories)
          if (
            r.expected.body.parentId &&
            desc.has(r.expected.body.parentId) &&
            !desc.has(r.expected.body.id)
          ) {
            desc.add(r.expected.body.id);
            again = true;
          }
      }
      if (
        v.propagation === 'self' &&
        snapshot.categories.some(
          (r) =>
            r.expected.body.parentId === v.categoryId &&
            records(r.expected.body.id).some((x) => !ks.includes(x.scopeKey)),
        )
      )
        fail();
      if (
        root.expected.body.parentId &&
        ks.some(
          (k) =>
            !records(root.expected.body.parentId!).some(
              (r) => r.scopeKey === k,
            ),
        )
      )
        fail();
      for (const id of v.propagation === 'subtree' ? desc : [v.categoryId]) {
        for (const rr of records(id))
          for (const k of rr.scopeKeys) affected.add(k);
        const r = getAny(id);
        authorizeBase(r);
        if (
          canonicalJson(keys(records(id).map((x) => x.scopeKey))) !==
          canonicalJson(ks)
        )
          rebase(
            r,
            r.baseBody?.name ?? unavailable(),
            r.baseBody?.description ?? unavailable(),
            ks,
          );
      }
      break;
    }
    case 'batch_update_subcategories_scoped': {
      const v = intent.payload;
      const parent = get(v.parentId);
      if (stateOf(parent) !== 'enabled') denied();
      const changed = [...v.disableIds, ...v.restoreIds, ...v.enableIds];
      if (keys(changed).length !== changed.length) fail();
      for (const id of changed)
        if (get(id).expected.body.parentId !== v.parentId) denied();
      if (v.addNodes.some((n) => n.parentKey !== null)) fail();
      const created = add(v.addNodes, v.parentId, [selected]);
      v.disableIds.forEach((id) => changeLife(id, 'disabled', false));
      v.restoreIds.forEach((id) => changeLife(id, 'disabled', true));
      v.enableIds.forEach((id) => changeLife(id, 'enabled', false));
      reorder(
        v.parentId,
        v.orderedChildren.map((v) =>
          v.kind === 'existing'
            ? v.id
            : (created.get(v.key)?.body.id ?? fail()),
        ),
      );
      break;
    }
  }
  void p;
  let issues = [...planned.values()];
  // Coverage is a derived exact complete domain, not permission to invent targets.
  if (issues.length) {
    const placements = new Map<
      string,
      { categoryId: string; scopeKeys: string[] }
    >();
    for (const r of snapshot.categories)
      placements.set(r.placementSourceId, {
        categoryId: r.expected.body.id,
        scopeKeys: r.scopeKeys,
      });
    for (const item of issues.filter(
      (s) => s.kind === 'scoped_category_scope',
    )) {
      if (item.previousSourceId) placements.delete(item.previousSourceId);
      if (item.placement)
        placements.set(item.id, {
          categoryId: item.placement.categoryId,
          scopeKeys: item.scopeKeys,
        });
    }
    for (const k of keys([...affected])) {
      const old = prior('scope_absence', k) ?? unavailable(),
        categoryIds = keys(
          [...placements.values()]
            .filter((p) => p.scopeKeys.includes(k))
            .map((p) => p.categoryId),
        );
      const targetIds = keys(
        snapshot.targets
          .filter(
            (t) =>
              t.scopeKeys.includes(k) && categoryIds.includes(t.categoryId),
          )
          .map((t) => t.targetId),
      );
      issue('scope_absence', k, [k], {
        ...old.payload,
        complete: true,
        categoryIds,
        targetIds,
        previousSourceId: old.id,
        previousSourceRevision: old.revision,
      });
    }
  }
  issues = [...planned.values()];
  const affectedScopeKeys = keys([...affected]);
  if (
    affectedScopeKeys.some((k) => !snapshot.heads.some((h) => h.scopeKey === k))
  )
    unavailable();
  const policies = snapshot.sources.filter(
    (s) =>
      s.source_kind === 'native_scoped_category_management' &&
      s.current &&
      s.payload['enabled'] === true &&
      affectedScopeKeys.every((k) => s.scope_keys.includes(k)) &&
      Array.isArray(s.payload['operations']) &&
      s.payload['operations'].includes(intent.operation),
  );
  if (policies.length !== 1) unavailable();
  const policy = policies[0]!;
  const dependencies = snapshot.sources.filter((s) =>
    s.scope_keys.some((k) => affectedScopeKeys.includes(k)),
  );
  if (dependencies.some((s) => !s.current)) unavailable();
  const beforeVector = dependencies
    .map((s) => ({
      id: s.id,
      revision: s.revision,
      kind: s.source_kind,
      key: s.source_key,
      digest: s.digest,
    }))
    .sort((a, b) =>
      a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.key < b.key ? -1 : 1,
    );
  const beforeHeads = snapshot.heads.filter((h) =>
    affectedScopeKeys.includes(h.scopeKey),
  );
  const affectedCategories = new Set(touched);
  let foundDescendant = true;
  while (foundDescendant) {
    foundDescendant = false;
    for (const r of snapshot.categories)
      if (
        r.expected.body.parentId &&
        affectedCategories.has(r.expected.body.parentId) &&
        !affectedCategories.has(r.expected.body.id)
      ) {
        affectedCategories.add(r.expected.body.id);
        foundDescendant = true;
      }
  }
  const plan: CategoryManagementPlan = {
    version: 1,
    accountId: actor,
    requestId: intent.payload.clientRequestId,
    intentHash: hash,
    operation: intent.operation,
    sourceIssues: issues,
    envelopes: issues.flatMap((s) =>
      s.payload['reviewEnvelope']
        ? [s.payload['reviewEnvelope'] as RatingScopedCategoryEnvelope]
        : [],
    ),
    categoryIds: keys([...touched]),
    affectedScopeKeys,
    globalRequired,
    beforeHeads,
    beforeCompatHeads: (snapshot.compatHeads ?? []).filter((h) =>
      h.scopeKeys.some((k) => affectedScopeKeys.includes(k)),
    ),
    beforeBaseAvailability: [
      ...new Map(
        snapshot.categories
          .filter((r) => affectedScopeKeys.includes(r.scopeKey))
          .map((r) => [
            r.expected.baseSourceId,
            {
              sourceId: r.expected.baseSourceId,
              sourceRevision: r.expected.baseSourceRevision,
              current:
                !!r.baseBody &&
                !snapshot.reviewBlockedSourceIds?.includes(
                  r.expected.baseSourceId,
                ),
            },
          ]),
      ).values(),
    ].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    beforeVector,
    beforeDigest: ratingScopedDigest('category-before', {
      heads: beforeHeads,
      vector: beforeVector,
    }),
    policySourceId: policy.id,
    policySourceRevision: policy.revision,
    registrySourceIds: keys([...registries]),
    changes: changes.map((change) => ({
      ...change,
      beforeStatus:
        change.before !== null
          ? ('available' as const)
          : change.field === 'create'
            ? ('absent' as const)
            : ('unavailable' as const),
      afterStatus:
        change.after !== null
          ? ('available' as const)
          : ('unavailable' as const),
    })),
    affectedTargetCount: new Set(
      snapshot.targets
        .filter(
          (t) =>
            affectedCategories.has(t.categoryId) &&
            t.scopeKeys.some((k) => affectedScopeKeys.includes(k)),
        )
        .map((t) => t.targetId),
    ).size,
    previewDigest: '',
    validUntil: new Date(
      Math.min(
        snapshot.validUntil,
        policy.valid_until.getTime(),
        ...dependencies.map((s) => s.valid_until.getTime()),
        ...[...registries].map((id) =>
          sourceMap.get(id)!.valid_until.getTime(),
        ),
      ),
    ).toISOString(),
    noop: issues.length === 0,
  };
  plan.previewDigest = ratingScopedDigest('category-plan', {
    ...plan,
    previewDigest: '',
  });
  budget.observe(plan);
  return plan;
}
