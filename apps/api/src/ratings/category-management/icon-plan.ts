import { canonicalJson } from '../../community/content-review/contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import { RatingScopedCompilationBudget } from '../scoped/compiler.js';
import { ratingScopedArtifactId } from '../scoped/commands.service.js';
import {
  planCategoryManagement,
  type CategorySnapshot,
  type CategoryManagementPlan,
} from './plan.js';
import {
  categoryIconTextIntent,
  categoryIconTextHash,
  ratingCategoryIconIntentHash,
  ratingCategoryIconIntentSchema,
  categoryIconReplacements,
  type RatingCategoryIconIntent,
  type CategoryIconAppearance,
  type CategoryIconBaseEdit,
  type CategoryIconReplacement,
} from './icon-contracts.js';
import { categoryIconDigest } from './icon-extension.js';
import {
  validateCategoryIconRoots,
  categoryIconAffectedScopes,
  consolidateCategoryIconLineages,
  type CategoryIconRoot,
  type CategoryIconBaseRoot,
  type CategoryIconOverrideRoot,
} from './icon-references.js';

export interface CategoryIconTrustedUpload {
  readonly uploadScopeId: string;
  readonly scopeRevision: string;
  readonly assetId: string;
  readonly manifestDigest: string;
  readonly actorId: string;
  readonly categoryId: string;
  readonly identityId: string;
  readonly origin: CategoryIconAppearance['origin'];
  readonly textHash: string;
  readonly expiresAt: number;
}
export interface CategoryIconPlan {
  readonly version: 1;
  readonly accountId: string;
  readonly requestId: string;
  readonly outerHash: string;
  readonly textHash: string;
  readonly textPlan: CategoryManagementPlan;
  readonly beforeSnapshot: string;
  readonly beforeRoots: readonly CategoryIconRoot[];
  readonly afterRoots: readonly CategoryIconRoot[];
  readonly newAppearances: readonly CategoryIconAppearance[];
  readonly uploads: readonly CategoryIconTrustedUpload[];
  readonly categoryIds: readonly string[];
  readonly affectedScopeKeys: readonly string[];
  readonly globalRequired: boolean;
  readonly noop: boolean;
  readonly mediaNoop: boolean;
  readonly adoptionRequired: boolean;
  readonly digest: string;
}
function unavailable(): never {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
}
function changed(): never {
  throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
}
const rootKey = (root: CategoryIconRoot) =>
  canonicalJson([
    root.kind,
    root.categoryId,
    root.kind === 'base' ? root.source : root.baseSource,
    root.kind === 'override' ? root.campusId : null,
  ]);
const sourceKey = (source: { id: string; revision: string }) =>
  `${source.id}:${source.revision}`;
const sameValue = (
  a: CategoryIconRoot['value'],
  b: CategoryIconRoot['value'],
) =>
  (a.kind === 'absent' && b.kind === 'absent') ||
  canonicalJson(a) === canonicalJson(b);
/** Pure composite planner. The text plan keeps its frozen hash and all original
 * causal fields; the shared request and media artifacts use only outerHash. */
export function planCategoryIconManagement(
  actor: string,
  raw: RatingCategoryIconIntent,
  snapshot: CategorySnapshot,
  media: {
    readonly revision: string;
    readonly roots: readonly CategoryIconRoot[];
    readonly markedScopeKeys: readonly string[];
  },
  trustedUploads: readonly CategoryIconTrustedUpload[],
  budget: RatingScopedCompilationBudget,
): CategoryIconPlan {
  const intent = ratingCategoryIconIntentSchema.parse(raw);
  if (intent.mediaSnapshot !== media.revision) changed();
  budget.observe({
    categoryIconTextSnapshot: snapshot,
    categoryIconUploads: trustedUploads,
  });
  const before = validateCategoryIconRoots(media.roots, budget);
  const outerHash = ratingCategoryIconIntentHash(intent),
    textHash = categoryIconTextHash(intent);
  const textPlan = planCategoryManagement(
    actor,
    categoryIconTextIntent(intent),
    textHash,
    snapshot,
  );
  budget.observe({ categoryIconTextPlan: textPlan });
  const requested = categoryIconReplacements(intent);
  if (
    trustedUploads.length !== requested.length ||
    new Set(trustedUploads.map((upload) => upload.assetId)).size !==
      trustedUploads.length ||
    trustedUploads.some(
      (upload) =>
        upload.actorId !== actor ||
        upload.textHash !== textHash ||
        !requested.some(
          (ref) =>
            ref.assetId === upload.assetId &&
            ref.uploadScopeId === upload.uploadScopeId,
        ),
    )
  )
    unavailable();
  const roots = new Map(
    before.map((root) => [rootKey(root), structuredClone(root)]),
  );
  const appearances = new Map<string, CategoryIconAppearance>();
  const scope =
    intent.context.selector.kind === 'global'
      ? 'global'
      : `campus:${intent.context.selector.campusId}`;
  const definitionId = (key: string) =>
    ratingScopedArtifactId(outerHash, `category-icon-definition:${key}`);
  const absence = (key: string): CategoryIconBaseRoot['value'] => ({
    kind: 'absent',
    evidenceId: ratingScopedArtifactId(
      outerHash,
      `category-icon-absence:${key}`,
    ),
    evidenceDigest: categoryIconDigest('explicit-absence', {
      actor,
      requestId: intent.payload.clientRequestId,
      outerHash,
      key,
    }),
  });
  const newImage = (
    replacement: CategoryIconReplacement,
    root: CategoryIconRoot,
  ): CategoryIconBaseRoot['value'] => {
    const upload =
      trustedUploads.find(
        (item) =>
          item.uploadScopeId === replacement.uploadScopeId &&
          item.assetId === replacement.assetId,
      ) ?? unavailable();
    const origin =
      root.kind === 'base'
        ? { kind: 'base' as const }
        : { kind: 'override' as const, campusId: root.campusId };
    if (
      upload.categoryId !== root.categoryId ||
      upload.identityId !== root.identityId ||
      canonicalJson(upload.origin) !== canonicalJson(origin)
    )
      unavailable();
    const slot = `${root.categoryId}:${canonicalJson(origin)}`;
    let appearance = appearances.get(slot);
    if (!appearance) {
      appearance = {
        appearanceId: ratingScopedArtifactId(
          outerHash,
          `category-icon-appearance:${slot}`,
        ),
        assetId: upload.assetId,
        manifestDigest: upload.manifestDigest,
        actorId: actor,
        categoryId: root.categoryId,
        identityId: root.identityId,
        origin,
      };
      appearances.set(slot, appearance);
    } else if (
      appearance.assetId !== upload.assetId ||
      appearance.manifestDigest !== upload.manifestDigest
    )
      unavailable();
    return { kind: 'image', appearance };
  };
  const write = (root: CategoryIconRoot, value: CategoryIconRoot['value']) => {
    if (root.kind === 'base' && value.kind === 'inherit') unavailable();
    if (sameValue(root.value, value)) return root;
    const next = {
      ...root,
      definitionId: definitionId(rootKey(root)),
      value,
    } as CategoryIconRoot;
    roots.set(rootKey(root), next);
    return next;
  };
  // Text source successors preserve immutable appearances. Multiple compatible
  // textual branches require a complete media/override comparison before merge.
  for (const issue of textPlan.sourceIssues.filter(
    (item) => item.kind === 'scoped_category_base',
  )) {
    const categoryId = String(issue.payload['categoryId']),
      identityId = String(issue.payload['identityId']);
    const priorId = issue.payload['previousBaseSourceId'];
    const source = { id: issue.id, revision: issue.revision };
    const existing = [...roots.values()].filter(
      (root): root is CategoryIconBaseRoot =>
        root.kind === 'base' && root.categoryId === categoryId,
    );
    const merging =
      intent.operation === 'set_category_scope_scoped' &&
      existing.length > 1 &&
      textPlan.sourceIssues.filter(
        (item) =>
          item.kind === 'scoped_category_base' &&
          item.payload['categoryId'] === categoryId,
      ).length === 1;
    const predecessors = merging
      ? existing
      : existing.filter((root) => root.source.id === priorId);
    if (priorId !== undefined && priorId !== null && predecessors.length === 0)
      unavailable();
    let value: CategoryIconBaseRoot['value'];
    if (!predecessors.length) {
      value = absence(`create:${categoryId}`);
    } else if (merging) {
      const all = [...roots.values()].filter(
        (root) =>
          root.categoryId === categoryId &&
          (root.kind === 'base' ||
            predecessors.some(
              (base) => sourceKey(base.source) === sourceKey(root.baseSource),
            )),
      );
      value = consolidateCategoryIconLineages(
        all,
        all.map((root) => root.definitionId),
        predecessors.map((root) => root.source),
        budget,
      ).base.value;
    } else value = predecessors[0]!.value;
    const next: CategoryIconBaseRoot = {
      kind: 'base',
      definitionId: definitionId(`base:${issue.id}`),
      categoryId,
      identityId,
      source,
      scopeKeys: [...issue.scopeKeys],
      retention: predecessors[0]?.retention ?? 'current',
      value,
    };
    for (const predecessor of predecessors) {
      roots.delete(rootKey(predecessor));
      for (const old of [...roots.values()]) {
        if (
          old.kind !== 'override' ||
          sourceKey(old.baseSource) !== sourceKey(predecessor.source)
        )
          continue;
        roots.delete(rootKey(old));
        const successor: CategoryIconOverrideRoot = {
          ...old,
          definitionId: definitionId(`override:${issue.id}:${old.campusId}`),
          baseSource: source,
          retention:
            old.retention === 'archived'
              ? 'archived'
              : issue.scopeKeys.includes(`campus:${old.campusId}`)
                ? 'current'
                : 'dormant',
        };
        const duplicate = roots.get(rootKey(successor));
        if (duplicate && !sameValue(duplicate.value, successor.value))
          unavailable();
        roots.set(rootKey(successor), successor);
      }
    }
    roots.set(rootKey(next), next);
  }
  for (const issue of textPlan.sourceIssues.filter(
    (item) => item.kind === 'scoped_category_override',
  )) {
    const categoryId = String(issue.payload['categoryId']),
      campusId = issue.scopeKeys[0]?.slice(7) ?? unavailable();
    if (
      issue.scopeKeys.length !== 1 ||
      !issue.scopeKeys[0]!.startsWith('campus:')
    )
      unavailable();
    const baseSource = {
      id: String(issue.payload['baseSourceId']),
      revision: String(issue.payload['baseSourceRevision']),
    };
    const bases = [...roots.values()].filter(
      (root): root is CategoryIconBaseRoot =>
        root.kind === 'base' &&
        root.categoryId === categoryId &&
        sourceKey(root.source) === sourceKey(baseSource),
    );
    const base = bases.length === 1 ? bases[0]! : unavailable();
    const existing = [...roots.values()].find(
      (root) =>
        root.kind === 'override' &&
        root.categoryId === categoryId &&
        root.campusId === campusId &&
        sourceKey(root.baseSource) === sourceKey(baseSource),
    );
    const next: CategoryIconOverrideRoot = {
      kind: 'override',
      definitionId: definitionId(`override-source:${issue.id}`),
      categoryId,
      identityId: base.identityId,
      source: { id: issue.id, revision: issue.revision },
      baseSource,
      campusId,
      scopeKeys: [...issue.scopeKeys],
      retention: existing?.retention ?? 'current',
      value: existing?.value ?? { kind: 'inherit' },
    };
    if (existing) roots.delete(rootKey(existing));
    roots.set(rootKey(next), next);
  }
  const editBase = (categoryId: string, edit: CategoryIconBaseEdit) => {
    const bases = [...roots.values()].filter(
      (root): root is CategoryIconBaseRoot =>
        root.kind === 'base' && root.categoryId === categoryId,
    );
    if (!bases.length) unavailable();
    for (const root of bases) {
      if (edit.mode === 'keep') {
        if (root.value.kind === 'unresolved') unavailable();
        continue;
      }
      write(
        root,
        edit.mode === 'clear' ? absence(rootKey(root)) : newImage(edit, root),
      );
    }
  };
  switch (intent.operation) {
    case 'create_categories_scoped':
      for (const node of intent.payload.nodes)
        editBase(
          ratingScopedArtifactId(textHash, `category:${node.key}`),
          node.icon,
        );
      break;
    case 'create_system_category_scoped':
      editBase(
        ratingScopedArtifactId(textHash, 'category:root'),
        intent.payload.icon,
      );
      break;
    case 'batch_update_subcategories_scoped':
      for (const node of intent.payload.addNodes)
        editBase(
          ratingScopedArtifactId(textHash, `category:${node.key}`),
          node.icon,
        );
      break;
    case 'edit_category_base_scoped':
      editBase(intent.payload.categoryId, intent.payload.icon);
      break;
    case 'set_category_override_scoped': {
      if (intent.context.selector.kind !== 'campus') unavailable();
      const categoryId = intent.payload.categoryId,
        campusId = intent.context.selector.campusId;
      const selected =
        snapshot.categories.find(
          (item) =>
            item.scopeKey === scope && item.expected.body.id === categoryId,
        ) ?? unavailable();
      const baseSource = {
        id: selected.expected.baseSourceId,
        revision: selected.expected.baseSourceRevision,
      };
      const base =
        [...roots.values()].find(
          (root): root is CategoryIconBaseRoot =>
            root.kind === 'base' &&
            root.categoryId === categoryId &&
            sourceKey(root.source) === sourceKey(baseSource),
        ) ?? unavailable();
      let root = [...roots.values()].find(
        (candidate): candidate is CategoryIconOverrideRoot =>
          candidate.kind === 'override' &&
          candidate.categoryId === categoryId &&
          candidate.campusId === campusId &&
          sourceKey(candidate.baseSource) === sourceKey(baseSource),
      );
      const edit = intent.payload.icon;
      if (!root && edit.mode === 'inherit') break;
      if (!root) {
        root = {
          kind: 'override',
          definitionId: definitionId(`override:${baseSource.id}:${campusId}`),
          categoryId,
          identityId: base.identityId,
          campusId,
          baseSource,
          source:
            selected.expected.overrideSourceId === null
              ? null
              : {
                  id: selected.expected.overrideSourceId,
                  revision:
                    selected.expected.overrideSourceRevision ?? unavailable(),
                },
          scopeKeys: [scope],
          retention: 'current',
          value: { kind: 'inherit' },
        };
        roots.set(rootKey(root), root);
      }
      if (edit.mode === 'inherit') write(root, { kind: 'inherit' });
      else if (edit.value === null) write(root, absence(rootKey(root)));
      else if (edit.value.mode === 'keep') {
        if (root.value.kind !== 'image') unavailable();
      } else write(root, newImage(edit.value, root));
      break;
    }
  }
  const after = [
    ...validateCategoryIconRoots([...roots.values()], budget),
  ].sort((a, b) => rootKey(a).localeCompare(rootKey(b)));
  const beforeSorted = [...before].sort((a, b) =>
    rootKey(a).localeCompare(rootKey(b)),
  );
  const changedCategoryIds = new Set<string>(textPlan.categoryIds);
  const beforeByKey = new Map(
    beforeSorted.map((root) => [rootKey(root), root]),
  );
  for (const root of after)
    if (
      canonicalJson(root) !==
      canonicalJson(beforeByKey.get(rootKey(root)) ?? null)
    )
      changedCategoryIds.add(root.categoryId);
  for (const root of beforeSorted)
    if (!roots.has(rootKey(root))) changedCategoryIds.add(root.categoryId);
  const mediaNoop = canonicalJson(after) === canonicalJson(beforeSorted);
  const authorityCategoryIds = new Set(changedCategoryIds);
  if ('categoryId' in intent.payload)
    authorityCategoryIds.add(intent.payload.categoryId);
  if (
    intent.operation === 'set_category_scope_scoped' &&
    intent.payload.propagation === 'subtree'
  ) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of snapshot.categories)
        if (
          row.expected.body.parentId !== null &&
          authorityCategoryIds.has(row.expected.body.parentId) &&
          !authorityCategoryIds.has(row.expected.body.id)
        ) {
          authorityCategoryIds.add(row.expected.body.id);
          grew = true;
        }
    }
  }
  const authorityRoots = (values: readonly CategoryIconRoot[]) =>
    intent.operation === 'set_category_override_scoped'
      ? values.filter(
          (root) =>
            root.kind === 'override' && `campus:${root.campusId}` === scope,
        )
      : [
            'edit_category_base_scoped',
            'set_category_scope_scoped',
            'create_categories_scoped',
            'create_system_category_scoped',
            'batch_update_subcategories_scoped',
          ].includes(intent.operation)
        ? values
        : [];
  const affectedScopeKeys =
    intent.operation === 'set_category_override_scoped'
      ? [...textPlan.affectedScopeKeys]
      : categoryIconAffectedScopes(
          categoryIconAffectedScopes(
            textPlan.affectedScopeKeys,
            beforeSorted,
            new Set(
              authorityRoots(beforeSorted)
                .map((root) => root.categoryId)
                .filter((id) => authorityCategoryIds.has(id)),
            ),
            budget,
          ),
          after,
          new Set(
            authorityRoots(after)
              .map((root) => root.categoryId)
              .filter((id) => authorityCategoryIds.has(id)),
          ),
          budget,
        );
  const adoptionRequired = affectedScopeKeys.some(
    (key) => !media.markedScopeKeys.includes(key),
  );
  const plan = {
    version: 1 as const,
    accountId: actor,
    requestId: intent.payload.clientRequestId,
    outerHash,
    textHash,
    textPlan,
    beforeSnapshot: media.revision,
    beforeRoots: beforeSorted,
    afterRoots: after,
    newAppearances: [...appearances.values()].sort((a, b) =>
      a.appearanceId.localeCompare(b.appearanceId),
    ),
    uploads: [...trustedUploads],
    categoryIds: [...changedCategoryIds].sort(),
    affectedScopeKeys,
    globalRequired:
      textPlan.globalRequired || affectedScopeKeys.includes('global'),
    noop: textPlan.noop && mediaNoop && !adoptionRequired,
    mediaNoop,
    adoptionRequired,
    digest: '',
  };
  plan.digest = categoryIconDigest('plan', { ...plan, digest: '' });
  budget.observe({ categoryIconPlan: plan });
  return plan;
}
