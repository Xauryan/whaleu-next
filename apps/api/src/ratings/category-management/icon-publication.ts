import { categoryIconScopeAdopted } from './icon-scope-marker.js';
import { scopedDigest, scopedId } from '../scoped/contracts.js';
import {
  CategoryIconMediaContentSnapshotFacade,
  categoryIconMediaContentKey,
  type MediaSnapshotReadBudget,
} from '../../media/category-icon-content-snapshot.facade.js';
import { CategoryIconMediaRequiredProof } from '../../media/category-icon-required-proof.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { RatingCategoryIconReviewFacade } from '../../community/content-review/rating-category-icon-review.facade.js';
import type { RatingCategoryIconEnvelope } from '../../community/content-review/rating-category-icon-contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import {
  RatingScopedCompilationBudget,
  type ScopedCompiledCatalog,
} from '../scoped/compiler.js';
import {
  categoryIconCapabilities,
  requireCategoryIconCapabilities,
} from './icon-capability.js';
import {
  compileCategoryIconRelease,
  categoryIconContentFor,
  categoryIconContentDigest,
  categoryIconDigest,
  type CategoryIconReleaseCoverage,
} from './icon-extension.js';
import type { CategoryIconRoot } from './icon-references.js';
import { categoryIconManagementSlots } from './icon-management-slots.js';
import { RatingCategoryIconRepository } from './icon-repository.js';
import {
  beginCategoryIconMutation,
  consumeCategoryIconTargetPublication,
  finishCategoryIconMutation,
  retainCategoryIconState,
  type CategoryIconMutation,
} from './icon-proof.js';
export interface CategoryIconPublicationInput {
  readonly roots: readonly CategoryIconRoot[];
  readonly coverage: readonly CategoryIconReleaseCoverage[];
  readonly budget: RatingScopedCompilationBudget;
}
const unavailable = (): never => {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
};
/** Every supplied binding belongs to the exact public compiler set, an exact
 * current recoverable management slot, or both. Management-only rows never enter
 * the public compiler. A root/selector has one canonical direct-root body, so an
 * inherited public body cannot win by insertion order or by sharing an asset. */
export function partitionCategoryIconPublicationCoverage(
  outputs: readonly ScopedCompiledCatalog[],
  roots: readonly CategoryIconRoot[],
  coverage: readonly CategoryIconReleaseCoverage[],
  scopeKeys: readonly string[],
  budget: RatingScopedCompilationBudget,
): {
  publicCoverage: readonly CategoryIconReleaseCoverage[];
  managementCoverage: readonly CategoryIconReleaseCoverage[];
} {
  budget.observe({ categoryIconWholeCoverage: coverage });
  const byContent = new Map<string, CategoryIconReleaseCoverage>();
  const managementKey = (content: CategoryIconReleaseCoverage['content']) =>
    canonicalJson({
      categoryId: content.categoryId,
      identityId: content.identityId,
      selector: content.selector,
      baseSource: content.baseSource,
      overrideSource: content.overrideSource,
      baseDefinitionId: content.baseDefinitionId,
      overrideDefinitionId: content.overrideDefinitionId,
      icon: content.icon,
    });
  const byManagement = new Map<string, CategoryIconReleaseCoverage[]>();
  const rootGroups = new Map<string, CategoryIconRoot[]>();
  const lineageKey = (
    categoryId: string,
    identityId: string,
    source: { id: string; revision: string },
  ) => canonicalJson([categoryId, identityId, source]);
  for (const root of roots) {
    const key = lineageKey(
      root.categoryId,
      root.identityId,
      root.kind === 'base' ? root.source : root.baseSource,
    );
    const group = rootGroups.get(key) ?? [];
    group.push(root);
    rootGroups.set(key, group);
  }
  for (const item of coverage) {
    const digest = categoryIconContentDigest(item.content);
    scopedId.parse(item.review.id);
    scopedDigest.parse(item.review.approvalDigest);
    if (
      byContent.has(digest) ||
      digest !== item.review.definitionDigest ||
      item.categoryId !== item.content.categoryId ||
      item.scopeKey !==
        (item.content.selector.kind === 'global'
          ? 'global'
          : `campus:${item.content.selector.campusId}`)
    )
      unavailable();
    byContent.set(digest, item);
    const key = managementKey(item.content),
      matches = byManagement.get(key) ?? [];
    matches.push(item);
    byManagement.set(key, matches);
  }
  const used = new Set<string>();
  const publicCoverage = outputs.flatMap((output) =>
    output.categories.map((category) => {
      const content = categoryIconContentFor(
        category.expected,
        output.campusId,
        (
          rootGroups.get(
            lineageKey(
              category.expected.body.id,
              category.expected.body.identityId,
              {
                id: category.expected.baseSourceId,
                revision: category.expected.baseSourceRevision,
              },
            ),
          ) ?? []
        ).filter(
          (root) => root.kind === 'base' || root.campusId === output.campusId,
        ),
        budget,
      );
      const digest = categoryIconContentDigest(content),
        item = byContent.get(digest) ?? unavailable();
      if (canonicalJson(item.content) !== canonicalJson(content)) unavailable();
      used.add(digest);
      return item;
    }),
  );
  const managementCoverage = categoryIconManagementSlots(roots, scopeKeys).map(
    ({ root, base, selector }) => {
      if (root.value.kind !== 'image') return unavailable();
      const expected = {
        categoryId: root.categoryId,
        identityId: root.identityId,
        selector,
        baseSource: base.source,
        overrideSource: root.kind === 'override' ? root.source : null,
        baseDefinitionId: base.definitionId,
        overrideDefinitionId:
          root.kind === 'override' ? root.definitionId : null,
        icon: {
          kind: 'image',
          origin: root.kind,
          definitionId: root.definitionId,
          appearance: root.value.appearance,
        },
      };
      const matches = byManagement.get(canonicalJson(expected)) ?? [];
      // Bodies are independently rederived from exact source heads by the
      // preparation/release SQL boundary; never accept a selective body pool.
      if (matches.length !== 1) return unavailable();
      const item = matches[0]!;
      used.add(item.review.definitionDigest);
      return item;
    },
  );
  if (used.size !== byContent.size) unavailable();
  return { publicCoverage, managementCoverage };
}
/** Every publisher enters through this same hook. The dispatch query touches
 * only original relations; old schemas and genuinely unmarked releases do not
 * acquire a Category-media registration dependency. */
export async function prepareCategoryIconPublication(
  releaseId: string,
  outputs: readonly ScopedCompiledCatalog[],
  tx: PoolClient,
  budget: RatingScopedCompilationBudget,
  input?: CategoryIconPublicationInput,
  originalCause?: { kind: string; accountId?: string; requestId?: string },
) {
  const keys = outputs.map((output) => output.scopeKey).sort();
  const previous = (
    await tx.query<{
      scope_key: string;
      catalog_id: string;
      head_revision: string;
      release_id: string;
      cause: Record<string, unknown>;
    }>(
      `SELECT h.scope_key,h.catalog_id,h.head_revision,h.release_id,r.cause FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_releases r ON r.id=h.release_id WHERE h.scope_key=ANY($1::text[]) ORDER BY h.scope_key`,
      [keys],
    )
  ).rows;
  const marked = previous.filter((row) =>
    categoryIconScopeAdopted(row.cause, row.scope_key),
  );
  if (!input && !marked.length) return null;
  budget.observe({ categoryIconPredecessors: previous });
  const scopeKeys = input ? keys : marked.map((row) => row.scope_key).sort();
  const selectedOutputs = outputs.filter((output) =>
    scopeKeys.includes(output.scopeKey),
  );
  const extent = keys.map((scopeKey) => {
    const before = previous.find((row) => row.scope_key === scopeKey);
    return {
      scopeKey,
      adopted: scopeKeys.includes(scopeKey),
      beforeCatalogId: before?.catalog_id ?? null,
      beforeHeadRevision: before?.head_revision ?? null,
      beforeReleaseId: before?.release_id ?? null,
      beforeAdopted: before
        ? categoryIconScopeAdopted(before.cause, scopeKey)
        : false,
    };
  });
  budget.observe({ categoryIconExtent: extent });
  let mutation: CategoryIconMutation | null = null;
  let roots: readonly CategoryIconRoot[],
    coverage: readonly CategoryIconReleaseCoverage[];
  if (input) {
    roots = input.roots;
    coverage = input.coverage;
  } else {
    if (
      !(await consumeCategoryIconTargetPublication(
        releaseId,
        keys,
        originalCause,
        tx,
      ))
    )
      mutation = await beginCategoryIconMutation(tx);
    roots = await new RatingCategoryIconRepository().roots(tx, budget);
    const rows = (
      await tx.query<{
        scope_key: string;
        category_id: string;
        content: CategoryIconReleaseCoverage['content'];
        id: string;
        definition_id: string;
        definition_digest: string;
        approval_digest: string;
        envelope: RatingCategoryIconEnvelope;
      }>(
        `SELECT * FROM (
       SELECT h.scope_key,p.category_id,p.projection->'content' content,b.id,b.definition_id,b.definition_digest,b.approval_digest,b.envelope
       FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.category_icon_projections p ON p.catalog_id=h.catalog_id AND p.release_id=h.release_id
       JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=p.review_binding_id WHERE h.scope_key=ANY($1::text[])
       UNION
       SELECT h.scope_key,(item->>'categoryId')::uuid category_id,item->'content' content,b.id,b.definition_id,b.definition_digest,b.approval_digest,b.envelope
       FROM whaleu_ratings.scoped_catalog_heads h
       JOIN whaleu_ratings.category_icon_release_manifests manifest ON manifest.release_id=h.release_id
       CROSS JOIN LATERAL jsonb_array_elements(manifest.management_coverage) item
       JOIN whaleu_ratings.category_icon_management_review_heads management
         ON management.root_definition_id=(item->'content'->'icon'->>'definitionId')::uuid AND management.selector=item->'content'->'selector'
       JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=management.review_binding_id AND b.id=(item->'review'->>'id')::uuid
         AND b.envelope->'content'=item->'content'
       WHERE h.scope_key=ANY($1::text[]) AND item->>'scopeKey'=h.scope_key
       ) exact_coverage ORDER BY scope_key,category_id,definition_digest LIMIT 100001`,
        [scopeKeys],
      )
    ).rows;
    budget.observe({ categoryIconCarry: rows });
    if (rows.length > 100000) unavailable();
    const review = new RatingCategoryIconReviewFacade();
    for (let offset = 0; offset < rows.length; offset += 128) {
      const decisions = await review.currentBatch(
        rows.slice(offset, offset + 128).map((row) => ({
          definitionId: row.definition_id,
          definitionDigest: row.definition_digest,
          envelope: row.envelope,
        })),
        tx,
      );
      if (decisions.some((decision) => decision.kind !== 'allow'))
        unavailable();
    }
    const mediaBudget: MediaSnapshotReadBudget = {
      rows: async <T>(
        read: PoolClient,
        sql: string,
        values: unknown[],
        cap: number,
      ) => {
        const fetched = (await read.query(sql, values)).rows as T[];
        budget.observe({ categoryIconCarryMedia: fetched });
        if (fetched.length > cap) unavailable();
        return fetched;
      },
    };
    const references = rows.flatMap((row) =>
      row.content.icon.kind === 'image'
        ? [
            {
              parent: {
                ownerKind: 'ratings' as const,
                resourceKind: 'category_icon' as const,
                resourceId: row.content.icon.appearance.appearanceId,
                contentVersion: 1 as const,
              },
              expected: [
                {
                  assetId: row.content.icon.appearance.assetId,
                  digest: row.content.icon.appearance.manifestDigest,
                },
              ],
            },
          ]
        : [],
    );
    if (references.length)
      await new CategoryIconMediaRequiredProof().capture(tx);
    for (let offset = 0; offset < references.length; offset += 128) {
      const chunk = references.slice(offset, offset + 128);
      const facts =
        await new CategoryIconMediaContentSnapshotFacade().readBatch(
          chunk,
          tx,
          mediaBudget,
        );
      for (const reference of chunk) {
        const fact = facts.get(categoryIconMediaContentKey(reference.parent));
        if (
          !fact ||
          fact.version !== 8 ||
          fact.decision !== 'allow' ||
          fact.validUntil === null ||
          !Number.isFinite(fact.validUntil) ||
          canonicalJson(fact.parent) !== canonicalJson(reference.parent) ||
          fact.attachments.length !== 1 ||
          fact.attachments[0]!.assetId !== reference.expected[0]!.assetId ||
          fact.attachments[0]!.manifestDigest !== reference.expected[0]!.digest
        )
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        registerTransactionDeadline(tx, fact.validUntil, 'MEDIA_UNAVAILABLE');
      }
    }
    coverage = rows.map((row) => ({
      scopeKey: row.scope_key,
      categoryId: row.category_id,
      content: row.content,
      review: {
        id: row.id,
        definitionDigest: row.definition_digest,
        approvalDigest: row.approval_digest,
      },
    }));
  }
  await retainCategoryIconState(keys, tx);
  const protocols = (
    await tx.query<{ id: string }>(
      `SELECT DISTINCT p.id FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions p ON p.id=h.version_id WHERE h.logical_scope_key=ANY($1::text[])`,
      [
        [
          ...new Set(
            selectedOutputs.map((output) => output.regionId ?? 'global'),
          ),
        ],
      ],
    )
  ).rows;
  const capabilities = await categoryIconCapabilities(
    protocols.map((row) => row.id),
    scopeKeys,
    tx,
  );
  requireCategoryIconCapabilities(capabilities);
  const partition = partitionCategoryIconPublicationCoverage(
    selectedOutputs,
    roots,
    coverage,
    scopeKeys,
    budget,
  );
  const compiled = compileCategoryIconRelease(
    releaseId,
    selectedOutputs,
    roots,
    partition.publicCoverage,
    budget,
  );
  const digest = categoryIconDigest('release', {
    extent,
    rows: compiled.rows.map((row) => row.digest),
    managementCoverage: partition.managementCoverage,
  });
  return {
    compiled,
    digest,
    extent,
    scopeKeys,
    roots,
    capabilities,
    mutation,
    managementCoverage: partition.managementCoverage,
    writeManagementHeads: input !== undefined,
  };
}
export async function writeCategoryIconPublication(
  releaseId: string,
  publication: NonNullable<
    Awaited<ReturnType<typeof prepareCategoryIconPublication>>
  >,
  tx: PoolClient,
  budget: RatingScopedCompilationBudget,
) {
  const { compiled, digest, extent, roots, capabilities, managementCoverage } =
    publication;
  const reviewIds = [
    ...new Set(
      [...compiled.rows, ...managementCoverage].map((row) => row.review.id),
    ),
  ].sort();
  if (reviewIds.length > 100000) unavailable();
  for (let offset = 0; offset < reviewIds.length; offset += 128) {
    const ids = reviewIds.slice(offset, offset + 128);
    const metadata = (
      await tx.query(
        'SELECT * FROM whaleu_ratings.category_icon_review_bindings WHERE id=ANY($1::uuid[]) ORDER BY id',
        [ids],
      )
    ).rows;
    budget.observe({ categoryIconFinalReviewMetadata: metadata });
    if (metadata.length !== ids.length) unavailable();
  }
  const bytes = Buffer.byteLength(
    canonicalJson({
      extent,
      roots,
      capabilities,
      rows: compiled.rows,
      managementCoverage,
    }),
    'utf8',
  );
  budget.observe({
    categoryIconManifest: { releaseId, digest, bytes },
  });
  await tx.query(
    `INSERT INTO whaleu_ratings.category_icon_release_manifests(release_id,extension_version,digest,row_count,root_snapshot,capabilities,serialized_bytes,scope_extent,management_coverage) VALUES($1,'ratings-category-icon-v1',$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8::jsonb)`,
    [
      releaseId,
      digest,
      compiled.rows.length,
      canonicalJson(roots),
      canonicalJson(capabilities),
      bytes,
      canonicalJson(extent),
      canonicalJson(managementCoverage),
    ],
  );
  for (const row of compiled.rows) {
    await tx.query(
      `INSERT INTO whaleu_ratings.category_icon_projections(release_id,catalog_id,category_id,effective_revision,extension_digest,projection,review_binding_id,appearance_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [
        releaseId,
        row.catalogId,
        row.categoryId,
        row.effectiveRevision,
        row.digest,
        canonicalJson(row),
        row.review.id,
        row.content.icon.kind === 'image'
          ? row.content.icon.appearance.appearanceId
          : null,
      ],
    );
  }
  // Only explicit Category management publication writes these exact root
  // pointers. Foreign publishers carry public proofs without replacing a base
  // management body with a campus-effective body that happens to use its image.
  for (const item of publication.writeManagementHeads
    ? managementCoverage
    : []) {
    if (item.content.icon.kind !== 'image') unavailable();
    await tx.query(
      `INSERT INTO whaleu_ratings.category_icon_management_review_heads(root_key,root_definition_id,selector,review_binding_id)
       VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(root_key) DO UPDATE SET review_binding_id=EXCLUDED.review_binding_id,mutation_transaction=pg_current_xact_id()
       WHERE whaleu_ratings.category_icon_management_review_heads.review_binding_id IS DISTINCT FROM EXCLUDED.review_binding_id`,
      [
        canonicalJson([item.content.icon.definitionId, item.content.selector]),
        item.content.icon.definitionId,
        canonicalJson(item.content.selector),
        item.review.id,
      ],
    );
  }
}
export async function finishCategoryIconPublication(
  publication: Awaited<ReturnType<typeof prepareCategoryIconPublication>>,
  tx: PoolClient,
) {
  if (publication?.mutation)
    await finishCategoryIconMutation(publication.mutation, tx);
}
