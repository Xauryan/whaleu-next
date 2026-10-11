import { canonicalJson } from '../../community/content-review/contracts.js';
import { canonicalRatingScopedEnvelope } from '../../community/content-review/rating-scoped-contracts.js';
import {
  canonicalRatingCategoryIconEnvelope,
  type RatingCategoryIconEnvelope,
} from '../../community/content-review/rating-category-icon-contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import { RatingScopedCompilationBudget } from '../scoped/compiler.js';
import { ratingScopedArtifactId } from '../scoped/commands.service.js';
import {
  categoryIconContentSchema,
  categoryIconContentDigest,
  type CategoryIconContent,
} from './icon-extension.js';
import {
  resolveCategoryIcon,
  type CategoryIconBaseRoot,
  type CategoryIconOverrideRoot,
} from './icon-references.js';
import type { CategoryIconPlan } from './icon-plan.js';
import { categoryIconManagementSlots } from './icon-management-slots.js';
import type { CategorySnapshot } from './plan.js';
const unavailable = (): never => {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
};
/** Metadata-only preview of public effective bodies plus exact recoverable
 * image-root bodies. Publication consumes the same whole Review set but only
 * compiler-selected public bodies become catalog projections. Historical
 * rejected bytes are never fetched to repair a definition. */
export function plannedCategoryIconContents(
  plan: CategoryIconPlan,
  snapshot: CategorySnapshot,
  budget: RatingScopedCompilationBudget,
): readonly CategoryIconContent[] {
  const sources = new Map(
    snapshot.sources.map((source) => [
      `${source.source_kind}:${source.source_key}`,
      {
        id: source.id,
        revision: source.revision,
        kind: source.source_kind,
        key: source.source_key,
        scopeKeys: source.scope_keys,
        payload: source.payload,
      },
    ]),
  );
  for (const issue of plan.textPlan.sourceIssues)
    sources.set(`${issue.kind}:${issue.key}`, issue);
  const byId = new Map(
    [...sources.values()].map((source) => [
      `${source.id}:${source.revision}`,
      source,
    ]),
  );
  const result = new Map<string, CategoryIconContent>();
  const contentFor = (
    baseRoot: CategoryIconBaseRoot,
    selector: CategoryIconContent['selector'],
    override?: CategoryIconOverrideRoot,
  ): CategoryIconContent => {
    const baseSource = baseRoot.source,
      categoryId = baseRoot.categoryId,
      campusId = selector.kind === 'global' ? null : selector.campusId;
    const base =
      byId.get(`${baseSource.id}:${baseSource.revision}`) ?? unavailable();
    let body: Pick<
      CategoryIconContent,
      'parentId' | 'level' | 'kind' | 'systemKey' | 'name' | 'description'
    >;
    if (base.payload['reviewEnvelope']) {
      const envelope = canonicalRatingScopedEnvelope(
        base.payload['reviewEnvelope'],
      );
      if (
        base.kind !== 'scoped_category_base' ||
        envelope.purpose !== 'publish_rating_category_base_scoped' ||
        envelope.sourceId !== base.id ||
        envelope.sourceRevision !== base.revision ||
        envelope.categoryId !== categoryId ||
        envelope.identityId !== baseRoot.identityId
      )
        return unavailable();
      body = envelope.body;
    } else {
      // Frozen adopted sources retain the original reader's exact base body.
      const historical = snapshot.categories.find(
        (row) =>
          row.expected.baseSourceId === base.id &&
          row.expected.baseSourceRevision === base.revision &&
          row.expected.body.id === categoryId &&
          row.expected.body.identityId === baseRoot.identityId,
      );
      body = historical?.baseBody ?? unavailable();
    }
    const overrideSource = override?.source ?? null;
    let effective = body;
    if (overrideSource) {
      const source =
        byId.get(`${overrideSource.id}:${overrideSource.revision}`) ??
        unavailable();
      if (source.kind !== 'scoped_category_override') unavailable();
      if (source.payload['action'] === 'inherit') {
        if (
          campusId === null ||
          canonicalJson(source.scopeKeys) !==
            canonicalJson([`campus:${campusId}`]) ||
          source.payload['categoryId'] !== categoryId ||
          source.payload['baseSourceId'] !== base.id ||
          source.payload['baseSourceRevision'] !== base.revision ||
          canonicalJson(source.payload['modes']) !==
            canonicalJson({
              name: { mode: 'inherit' },
              description: { mode: 'inherit' },
            }) ||
          'reviewEnvelope' in source.payload ||
          'issuanceDigest' in source.payload
        )
          unavailable();
      } else {
        const envelope = canonicalRatingScopedEnvelope(
          source.payload['reviewEnvelope'],
        );
        // The original text owner reissues every source in the recovery closure
        // against a base successor, preserving its exact modes and Review5 body.
        // An old-base envelope is not a substitute for that issuance.
        if (
          envelope.purpose !== 'publish_rating_category_override_scoped' ||
          envelope.sourceId !== source.id ||
          envelope.sourceRevision !== source.revision ||
          envelope.categoryId !== categoryId ||
          envelope.identityId !== baseRoot.identityId ||
          envelope.baseSourceId !== base.id ||
          envelope.baseSourceRevision !== base.revision ||
          envelope.scope.campusId !== campusId
        )
          return unavailable();
        effective = { ...body, ...envelope.body };
      }
    }
    return categoryIconContentSchema.parse({
      categoryId,
      identityId: baseRoot.identityId,
      parentId: effective.parentId,
      level: effective.level,
      kind: effective.kind,
      systemKey: effective.systemKey,
      name: effective.name,
      description: effective.description,
      selector,
      baseSource,
      overrideSource,
      baseDefinitionId: baseRoot.definitionId,
      overrideDefinitionId: override?.definitionId ?? null,
      icon: resolveCategoryIcon(
        // A direct base-management slot deliberately excludes campus overrides.
        // Public callers pass their exact override and use the identical codec.
        [baseRoot, ...(override ? [override] : [])],
        {
          categoryId,
          identityId: baseRoot.identityId,
          baseSource,
          overrideSource,
          campusId,
        },
        budget,
      ),
    });
  };
  const add = (content: CategoryIconContent) => {
    const scopeKey =
      content.selector.kind === 'global'
        ? 'global'
        : `campus:${content.selector.campusId}`;
    // One selector may have a public effective body and a distinct direct base
    // management body. Identical public/management contents consume one Review.
    const key = `${scopeKey}:${content.categoryId}:${categoryIconContentDigest(content)}`;
    if (!result.has(key)) {
      if (result.size >= 100000) unavailable();
      budget.observe({ categoryIconPlannedContent: content });
      result.set(key, content);
    }
  };
  const publicKeys = new Set<string>();
  for (const placement of sources.values()) {
    if (
      placement.kind !== 'scoped_category_scope' ||
      placement.payload['action'] === 'retired'
    )
      continue;
    const categoryId = String(placement.payload['categoryId']);
    const bases = plan.afterRoots.filter(
      (root): root is CategoryIconBaseRoot =>
        root.kind === 'base' &&
        root.categoryId === categoryId &&
        root.source.id === placement.payload['baseSourceId'] &&
        root.source.revision === placement.payload['baseSourceRevision'],
    );
    if (bases.length !== 1) unavailable();
    const base = bases[0]!;
    for (const scopeKey of placement.scopeKeys) {
      if (!plan.affectedScopeKeys.includes(scopeKey)) continue;
      const campusId = scopeKey === 'global' ? null : scopeKey.slice(7);
      const overrides = plan.afterRoots.filter(
        (root): root is CategoryIconOverrideRoot =>
          root.kind === 'override' &&
          root.categoryId === categoryId &&
          root.identityId === base.identityId &&
          root.campusId === campusId &&
          root.baseSource.id === base.source.id &&
          root.baseSource.revision === base.source.revision,
      );
      if (overrides.length > 1) unavailable();
      const key = `${scopeKey}:${categoryId}`;
      if (publicKeys.has(key)) unavailable();
      publicKeys.add(key);
      add(
        contentFor(
          base,
          campusId === null ? { kind: 'global' } : { kind: 'campus', campusId },
          overrides[0],
        ),
      );
    }
  }
  for (const slot of categoryIconManagementSlots(
    plan.afterRoots,
    plan.affectedScopeKeys,
  ))
    add(
      contentFor(
        slot.base,
        slot.selector,
        slot.root.kind === 'override' ? slot.root : undefined,
      ),
    );
  const contents = [...result.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, content]) => content);
  budget.observe({ categoryIconPlannedContentCount: contents.length });
  return contents;
}
export function plannedCategoryIconEnvelopes(
  plan: CategoryIconPlan,
  contents: readonly CategoryIconContent[],
  context: RatingCategoryIconEnvelope['context'],
): readonly RatingCategoryIconEnvelope[] {
  return contents.map((content) => {
    const definitionDigest = categoryIconContentDigest(content);
    return canonicalRatingCategoryIconEnvelope({
      version: 8,
      purpose: 'publish_rating_category_icon',
      accountId: plan.accountId,
      clientRequestId: plan.requestId,
      operation: plan.textPlan.operation,
      intentHash: plan.outerHash,
      textHash: plan.textHash,
      textPlanDigest: plan.textPlan.previewDigest,
      mediaPlanDigest: plan.digest,
      beforeSnapshot: plan.beforeSnapshot,
      context,
      definitionId: ratingScopedArtifactId(
        plan.outerHash,
        `category-icon-composite:${canonicalJson([content.categoryId, content.selector, definitionDigest])}`,
      ),
      definitionDigest,
      content,
      assetIds:
        content.icon.kind === 'image' ? [content.icon.appearance.assetId] : [],
    });
  });
}
