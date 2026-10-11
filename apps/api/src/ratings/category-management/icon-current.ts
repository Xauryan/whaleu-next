import {
  collectRatingsMediaMutationRead,
  ratingsMediaMutationActive,
} from '../../media/ratings-discussion-mutation-proof.js';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  canonicalEqual,
  canonicalJson,
} from '../../community/content-review/contracts.js';
import {
  canonicalRatingCategoryIconDefinition,
  ratingCategoryIconApprovalDigest,
  type RatingCategoryIconDefinitionDescriptor,
} from '../../community/content-review/rating-category-icon-contracts.js';
import { RatingCategoryIconReviewFacade } from '../../community/content-review/rating-category-icon-review.facade.js';
import {
  ratingCategoryIconBindingMatches,
  type RatingCategoryIconReviewBinding,
} from '../../community/content-review/rating-category-icon-validation.js';
import {
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import {
  CategoryIconMediaContentSnapshotFacade,
  categoryIconMediaContentKey,
  type CategoryIconMediaContentFact,
  type CategoryIconMediaContentReference,
  type MediaSnapshotReadBudget,
} from '../../media/category-icon-content-snapshot.facade.js';
import { CategoryIconMediaRequiredProof } from '../../media/category-icon-required-proof.js';
import {
  categoryIconMediaDescriptorSchema,
  type CategoryIconMediaDescriptor,
} from '../../media/contracts-category-icon.js';
import { retainRatingReadBytes } from '../target-cover-current.js';
import {
  RatingScopedCompilationBudget,
  scopedExpectedCategorySchema,
  type ScopedExpectedCategory,
} from '../scoped/compiler.js';
import { scopedDigest, scopedId } from '../scoped/contracts.js';
import type { ResolvedRatingReadScope } from '../scoped/context.service.js';
import { RATING_SCOPED_SCOPE_LIMIT } from '../scoped/constants.js';
import { ratingScopedDigest } from '../scoped/protocol-registry.js';
import { RATING_CATEGORY_ICON_EXTENSION } from './icon-contracts.js';
import {
  categoryIconContentDigest,
  categoryIconContentFor,
  categoryIconContentSchema,
  categoryIconDigest,
  type CategoryIconReleaseRow,
} from './icon-extension.js';
import { retainCategoryIconState } from './icon-proof.js';
import { categoryIconDefinitionBody } from './icon-repository.js';
import { categoryIconScopeAdopted } from './icon-scope-marker.js';
import {
  validateCategoryIconRoots,
  type CategoryIconRoot,
} from './icon-references.js';

const scopeKeySchema = z.union([
  z.literal('global'),
  z
    .string()
    .refine(
      (value) =>
        value.startsWith('campus:') &&
        scopedId.safeParse(value.slice(7)).success,
    ),
]);
const scopeExtentSchema = z
  .array(
    z.strictObject({
      scopeKey: scopeKeySchema,
      adopted: z.boolean(),
      beforeCatalogId: scopedId.nullable(),
      beforeHeadRevision: scopedId.nullable(),
      beforeReleaseId: scopedId.nullable(),
      beforeAdopted: z.boolean(),
    }),
  )
  .min(1)
  .max(RATING_SCOPED_SCOPE_LIMIT)
  .superRefine((extent, ctx) => {
    if (
      !extent.some((scope) => scope.adopted) ||
      extent.some(
        (scope, index) =>
          (index > 0 && extent[index - 1]!.scopeKey >= scope.scopeKey) ||
          (scope.beforeCatalogId === null) !==
            (scope.beforeHeadRevision === null) ||
          (scope.beforeCatalogId === null) !==
            (scope.beforeReleaseId === null) ||
          (scope.beforeAdopted && scope.beforeCatalogId === null),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Exact release scope extent required',
      });
  });
const releaseRowSchema = z.strictObject({
  releaseId: scopedId,
  catalogId: scopedId,
  scopeKey: scopeKeySchema,
  categoryId: scopedId,
  effectiveRevision: scopedId,
  effectiveDigest: scopedDigest,
  placementRevision: scopedId,
  extensionVersion: z.literal(RATING_CATEGORY_ICON_EXTENSION),
  content: categoryIconContentSchema,
  review: z.strictObject({
    id: scopedId,
    definitionDigest: scopedDigest,
    approvalDigest: scopedDigest,
  }),
  digest: scopedDigest,
});
const manifestSchema = z.strictObject({
  release_id: scopedId,
  extension_version: z.literal(RATING_CATEGORY_ICON_EXTENSION),
  digest: scopedDigest,
  row_count: z.number().int().min(0).max(100000),
  scope_extent: scopeExtentSchema,
  management_coverage: z
    .array(
      releaseRowSchema.pick({
        scopeKey: true,
        categoryId: true,
        content: true,
        review: true,
      }),
    )
    .max(100000),
  root_snapshot: z.array(z.unknown()).max(100000),
  // Capability qualification belongs to the original context owner.
  serialized_bytes: z.string().regex(/^(0|[1-9][0-9]*)$/),
});
const digestRowSchema = z.strictObject({
  catalog_id: scopedId,
  catalog_release_id: scopedId,
  category_id: scopedId,
  effective_revision: scopedId,
  scope_key: scopeKeySchema,
  extension_digest: scopedDigest,
});
interface OriginalHead {
  scope_key: string;
  catalog_id: string;
  head_revision: string;
  release_id: string;
  cause: unknown;
}
interface ProjectionRecord {
  release_id: string;
  catalog_id: string;
  category_id: string;
  effective_revision: string;
  extension_digest: string;
  projection: unknown;
  review_binding_id: string;
  appearance_id: string | null;
  binding: RatingCategoryIconReviewBinding | null;
}
interface DefinitionRecord {
  id: string;
  category_id: string;
  identity_id: string;
  kind: string;
  campus_id: string | null;
  base_source_id: string;
  base_source_revision: string;
  text_source_id: string | null;
  text_source_revision: string | null;
  value: unknown;
  appearance_id: string | null;
  definition_digest: string;
}
export interface CategoryIconExpectedRead {
  readonly id: string;
  readonly revision: string;
  readonly effective_digest: string;
  readonly placement_revision: string | null;
  readonly expected: unknown;
}
interface ExactExpected {
  readonly row: CategoryIconExpectedRead;
  readonly expected: ScopedExpectedCategory;
  readonly fingerprint: string;
}
interface Manifest {
  readonly digest: string;
  readonly adoptedScopeKeys: readonly string[];
  readonly roots: readonly CategoryIconRoot[];
  readonly rows: ReadonlyMap<string, z.infer<typeof digestRowSchema>>;
}
interface Qualified {
  readonly expected: string;
  readonly projection: CategoryIconReleaseRow;
  readonly decision: 'allow' | 'deny';
  readonly media: CategoryIconMediaContentFact | null;
}
interface ReadState {
  readonly epoch: object;
  readonly releases: Map<string, string>;
  readonly manifests: Map<string, Manifest>;
  readonly scopes: Set<string>;
  readonly qualified: Map<string, Qualified>;
}
const states = new WeakMap<PoolClient, ReadState>();
const reviewFacade = new RatingCategoryIconReviewFacade();
const mediaFacade = new CategoryIconMediaContentSnapshotFacade();
const mediaProof = new CategoryIconMediaRequiredProof();
function unavailable(): never {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
}
function stateFor(tx: PoolClient): ReadState {
  const epoch = transactionReadEpoch(tx);
  if (!epoch) return unavailable();
  let state = states.get(tx);
  if (!state || state.epoch !== epoch) {
    state = {
      epoch,
      releases: new Map(),
      manifests: new Map(),
      scopes: new Set(),
      qualified: new Map(),
    };
    states.set(tx, state);
  }
  return state;
}
function scopeKey(scope: ResolvedRatingReadScope): string {
  return canonicalJson([
    scope.catalog.scopeKey,
    scope.catalog.id,
    scope.catalog.headRevision,
  ]);
}
const projectionKey = (catalogId: string, categoryId: string) =>
  canonicalJson([catalogId, categoryId]);
const qualifiedKey = (
  releaseId: string,
  catalogId: string,
  categoryId: string,
) => canonicalJson([releaseId, catalogId, categoryId]);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** All compilation observations join the transaction-wide Ratings ledger,
 * including root selection; no fresh per-category or per-chunk allowance. */
class ReadBudget extends RatingScopedCompilationBudget {
  constructor(private readonly tx: PoolClient) {
    super();
  }
  override observe(value: unknown): void {
    retainRatingReadBytes(this.tx, value);
  }
}
async function readRows<T>(
  tx: PoolClient,
  sql: string,
  values: unknown[],
  maximum: number,
): Promise<T[]> {
  const rows = (await tx.query(sql, values)).rows as T[];
  retainRatingReadBytes(tx, rows);
  if (rows.length > maximum) unavailable();
  return rows;
}
async function currentHead(scope: ResolvedRatingReadScope, tx: PoolClient) {
  // Deliberately ONLY pre-extension relations. An old-schema read must never
  // mention a Category-icon, Media8 or Review8 relation, even in a LEFT JOIN.
  const rows = await readRows<OriginalHead>(
    tx,
    `SELECT h.scope_key,h.catalog_id,
    h.head_revision,h.release_id,r.cause
    FROM whaleu_ratings.scoped_catalog_heads h
    JOIN whaleu_ratings.scoped_releases r ON r.id=h.release_id
    WHERE h.scope_key=$1 AND h.catalog_id=$2 AND h.head_revision=$3`,
    [scope.catalog.scopeKey, scope.catalog.id, scope.catalog.headRevision],
    1,
  );
  const head = rows[0];
  if (
    !head ||
    head.scope_key !== scope.catalog.scopeKey ||
    head.catalog_id !== scope.catalog.id ||
    head.head_revision !== scope.catalog.headRevision ||
    !scopedId.safeParse(head.release_id).success ||
    !head.cause ||
    typeof head.cause !== 'object' ||
    Array.isArray(head.cause)
  )
    unavailable();
  const cause = head.cause as Record<string, unknown>;
  if (!categoryIconScopeAdopted(cause, scope.catalog.scopeKey))
    return { head, digest: null };
  return { head, digest: cause['categoryIconDigest'] as string };
}
/** Original-head-only dispatch, not content or byte authority. Prepared legacy
 * commands must still qualify their complete original Category ancestor chain
 * whenever this exact head carries C1; old schemas never touch new tables. */
export async function hasCurrentCategoryIconExtension(
  scope: ResolvedRatingReadScope,
  tx: PoolClient,
): Promise<boolean> {
  return (await currentHead(scope, tx)).digest !== null;
}
async function manifestFor(
  releaseId: string,
  digest: string,
  adoptedScopeKeys: readonly string[],
  state: ReadState,
  tx: PoolClient,
  budget: ReadBudget,
): Promise<Manifest> {
  const cached = state.manifests.get(releaseId);
  if (cached) {
    if (
      cached.digest !== digest ||
      !canonicalEqual(cached.adoptedScopeKeys, adoptedScopeKeys)
    )
      unavailable();
    return cached;
  }
  const records = await readRows<unknown>(
    tx,
    `SELECT release_id,extension_version,digest,
    row_count,scope_extent,management_coverage,root_snapshot,serialized_bytes::text
    FROM whaleu_ratings.category_icon_release_manifests WHERE release_id=$1`,
    [releaseId],
    1,
  );
  const parsed = manifestSchema.safeParse(records[0]);
  if (!parsed.success) return unavailable();
  const manifest = parsed.data;
  if (
    manifest.release_id !== releaseId ||
    manifest.digest !== digest ||
    !canonicalEqual(
      manifest.scope_extent
        .filter((scope) => scope.adopted)
        .map((scope) => scope.scopeKey),
      adoptedScopeKeys,
    ) ||
    BigInt(manifest.serialized_bytes) > 67108864n
  )
    unavailable();
  const roots = freeze(
    validateCategoryIconRoots(
      manifest.root_snapshot as CategoryIconRoot[],
      budget,
    ),
  );
  const adoptedScopes = new Set(adoptedScopeKeys);
  // The seal includes EVERY scope's extent and predecessor facts, and all rows
  // in adopted catalogs, not only this category or the random winner.
  const rawDigests = await readRows<unknown>(
    tx,
    `SELECT p.catalog_id,p.category_id,
    p.effective_revision,c.release_id AS catalog_release_id,c.scope_key,p.extension_digest
    FROM whaleu_ratings.category_icon_projections p
    LEFT JOIN whaleu_ratings.scoped_catalogs c ON c.id=p.catalog_id
    WHERE p.release_id=$1 ORDER BY c.scope_key,p.category_id LIMIT 100001`,
    [releaseId],
    100000,
  );
  if (rawDigests.length !== manifest.row_count) unavailable();
  const rows = new Map<string, z.infer<typeof digestRowSchema>>();
  const ordered = rawDigests
    .map((raw) => {
      const item = digestRowSchema.safeParse(raw);
      if (
        !item.success ||
        item.data.catalog_release_id !== releaseId ||
        !adoptedScopes.has(item.data.scope_key)
      )
        return unavailable();
      const key = projectionKey(item.data.catalog_id, item.data.category_id);
      if (rows.has(key)) unavailable();
      rows.set(key, freeze(item.data));
      return item.data;
    })
    .sort(
      (a, b) =>
        a.scope_key.localeCompare(b.scope_key) ||
        a.category_id.localeCompare(b.category_id),
    );
  if (
    categoryIconDigest('release', {
      extent: manifest.scope_extent,
      managementCoverage: manifest.management_coverage,
      rows: ordered.map((row) => row.extension_digest),
    }) !== manifest.digest
  )
    unavailable();
  const value = Object.freeze({
    digest: manifest.digest,
    adoptedScopeKeys: Object.freeze([...adoptedScopeKeys]),
    roots,
    rows,
  });
  state.manifests.set(releaseId, value);
  return value;
}
function exactExpected(row: CategoryIconExpectedRead): ExactExpected {
  const parsed = scopedExpectedCategorySchema.safeParse(row.expected);
  if (!parsed.success) return unavailable();
  const expected = parsed.data;
  if (
    !scopedId.safeParse(row.revision).success ||
    row.id !== expected.body.id ||
    row.placement_revision !== expected.placementRevision ||
    row.effective_digest !== ratingScopedDigest('effective', expected)
  )
    unavailable();
  return {
    row,
    expected,
    fingerprint: canonicalJson([
      row.id,
      row.revision,
      row.effective_digest,
      row.placement_revision,
      expected,
    ]),
  };
}
function exactProjection(
  record: ProjectionRecord,
  exact: ExactExpected,
  scope: ResolvedRatingReadScope,
  releaseId: string,
  manifest: Manifest,
  budget: ReadBudget,
): {
  projection: CategoryIconReleaseRow;
  definition: RatingCategoryIconDefinitionDescriptor;
  roots: readonly CategoryIconRoot[];
} {
  const parsed = releaseRowSchema.safeParse(record.projection);
  if (!parsed.success) return unavailable();
  const projection = parsed.data;
  const { digest, ...body } = projection;
  const saved = manifest.rows.get(
    projectionKey(scope.catalog.id, exact.row.id),
  );
  if (
    !saved ||
    record.release_id !== releaseId ||
    record.catalog_id !== scope.catalog.id ||
    record.category_id !== exact.row.id ||
    record.effective_revision !== exact.row.revision ||
    record.extension_digest !== digest ||
    saved.extension_digest !== digest ||
    saved.scope_key !== scope.catalog.scopeKey ||
    saved.effective_revision !== exact.row.revision ||
    projection.releaseId !== releaseId ||
    projection.catalogId !== scope.catalog.id ||
    projection.scopeKey !== scope.catalog.scopeKey ||
    projection.categoryId !== exact.row.id ||
    projection.effectiveRevision !== exact.row.revision ||
    projection.effectiveDigest !== exact.row.effective_digest ||
    projection.placementRevision !== exact.row.placement_revision ||
    categoryIconDigest('release-row', body) !== digest ||
    projection.review.definitionDigest !==
      categoryIconContentDigest(projection.content) ||
    record.review_binding_id !== projection.review.id ||
    record.appearance_id !==
      (projection.content.icon.kind === 'image'
        ? projection.content.icon.appearance.appearanceId
        : null)
  )
    unavailable();
  const campusId = scope.catalog.campusId;
  if (
    scope.catalog.scopeKey !==
      (campusId === null ? 'global' : `campus:${campusId}`) ||
    !canonicalEqual(projection.content.selector, scope.selector)
  )
    unavailable();
  const roots = manifest.roots.filter(
    (root) =>
      root.categoryId === exact.row.id &&
      root.identityId === exact.expected.body.identityId &&
      (root.kind === 'base'
        ? root.source.id === exact.expected.baseSourceId &&
          root.source.revision === exact.expected.baseSourceRevision
        : root.campusId === campusId &&
          root.baseSource.id === exact.expected.baseSourceId &&
          root.baseSource.revision === exact.expected.baseSourceRevision),
  );
  const content = categoryIconContentFor(
    exact.expected,
    campusId,
    roots,
    budget,
  );
  if (!canonicalEqual(content, projection.content)) unavailable();
  const binding = record.binding;
  if (
    !binding ||
    binding.id !== projection.review.id ||
    binding.definition_digest !== projection.review.definitionDigest ||
    binding.approval_digest !== projection.review.approvalDigest
  )
    unavailable();
  let definition: RatingCategoryIconDefinitionDescriptor;
  try {
    definition = canonicalRatingCategoryIconDefinition({
      definitionId: binding.definition_id,
      definitionDigest: binding.definition_digest,
      envelope: binding.envelope,
    });
  } catch {
    return unavailable();
  }
  if (
    !ratingCategoryIconBindingMatches(binding, definition) ||
    !canonicalEqual(definition.envelope.content, content) ||
    ratingCategoryIconApprovalDigest(definition.envelope) !==
      projection.review.approvalDigest
  )
    unavailable();
  return { projection: freeze(projection), definition, roots };
}
async function qualifyDefinitions(
  roots: readonly CategoryIconRoot[],
  tx: PoolClient,
) {
  const expected = new Map(roots.map((root) => [root.definitionId, root]));
  const rows = await readRows<DefinitionRecord>(
    tx,
    `SELECT id,category_id,identity_id,kind,campus_id,
    base_source_id,base_source_revision,text_source_id,text_source_revision,value,appearance_id,definition_digest
    FROM whaleu_ratings.category_icon_definitions WHERE id=ANY($1::uuid[]) ORDER BY id`,
    [[...expected.keys()]],
    256,
  );
  if (
    rows.length !== expected.size ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  )
    unavailable();
  for (const row of rows) {
    const root = expected.get(row.id) ?? unavailable();
    const base = root.kind === 'base' ? root.source : root.baseSource;
    if (
      !canonicalEqual(row, {
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
      })
    )
      unavailable();
  }
}
function mediaReference(
  row: CategoryIconReleaseRow,
): CategoryIconMediaContentReference | null {
  if (row.content.icon.kind === 'absent') return null;
  const appearance = row.content.icon.appearance;
  return {
    parent: {
      ownerKind: 'ratings',
      resourceKind: 'category_icon',
      resourceId: appearance.appearanceId,
      contentVersion: 1,
    },
    expected: [
      { assetId: appearance.assetId, digest: appearance.manifestDigest },
    ],
  };
}

/** Read-only additional qualification after the original Category owner has
 * resolved and verified the complete ancestor/path rows. Never call this while
 * publishing a Category mutation; neither original owner facts nor external
 * Review/Media facts may be replaced by a post-write observation. */
export async function currentCategoryIcons(
  scope: ResolvedRatingReadScope,
  expectedRows: readonly CategoryIconExpectedRead[],
  tx: PoolClient,
  review: Pick<RatingCategoryIconReviewFacade, 'currentBatch'> = reviewFacade,
): Promise<readonly ('allow' | 'deny')[]> {
  const { head, digest } = await currentHead(scope, tx);
  if (digest === null)
    return Object.freeze(expectedRows.map(() => 'allow' as const));
  if (expectedRows.length > 10000) unavailable();
  const state = stateFor(tx),
    key = scopeKey(scope);
  const previousRelease = state.releases.get(key);
  if (previousRelease !== undefined && previousRelease !== head.release_id)
    unavailable();
  if (!state.scopes.has(scope.catalog.scopeKey)) {
    await retainCategoryIconState([scope.catalog.scopeKey], tx);
    state.scopes.add(scope.catalog.scopeKey);
  }
  const budget = new ReadBudget(tx);
  const manifest = await manifestFor(
    head.release_id,
    digest,
    (head.cause as Record<string, unknown>)[
      'categoryIconScopeKeys'
    ] as string[],
    state,
    tx,
    budget,
  );
  const expected = expectedRows.map(exactExpected);
  retainRatingReadBytes(tx, expectedRows);
  const missing = new Map<string, ExactExpected>();
  for (const exact of expected) {
    const k = qualifiedKey(head.release_id, scope.catalog.id, exact.row.id);
    const cached = state.qualified.get(k),
      pending = missing.get(k);
    if (
      (cached && cached.expected !== exact.fingerprint) ||
      (pending && pending.fingerprint !== exact.fingerprint)
    )
      unavailable();
    if (!cached) missing.set(k, exact);
  }
  const entries = [...missing.values()];
  const pending = new Map<string, Qualified>();
  const mediaBudget: MediaSnapshotReadBudget = {
    rows: <T>(read: PoolClient, sql: string, values: unknown[], cap: number) =>
      readRows<T>(read, sql, values, cap),
  };
  // Review8 max 128, at most 256 exact base/override definitions and at most
  // 128 Media8 references per chunk. The shared ledger survives all chunks.
  for (let start = 0; start < entries.length; start += 128) {
    const chunk = entries.slice(start, start + 128);
    const records = await readRows<ProjectionRecord>(
      tx,
      `SELECT p.release_id,p.catalog_id,p.category_id,
      p.effective_revision,p.extension_digest,p.projection,p.review_binding_id,p.appearance_id,to_jsonb(b) binding
      FROM whaleu_ratings.category_icon_projections p
      LEFT JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=p.review_binding_id
      WHERE p.release_id=$1 AND p.catalog_id=$2 AND p.category_id=ANY($3::uuid[]) ORDER BY p.category_id`,
      [head.release_id, scope.catalog.id, chunk.map((exact) => exact.row.id)],
      chunk.length,
    );
    const byId = new Map(records.map((record) => [record.category_id, record]));
    if (byId.size !== chunk.length || byId.size !== records.length)
      unavailable();
    const qualified = chunk.map((exact) =>
      exactProjection(
        byId.get(exact.row.id) ?? unavailable(),
        exact,
        scope,
        head.release_id,
        manifest,
        budget,
      ),
    );
    await qualifyDefinitions(
      qualified.flatMap((item) => item.roots),
      tx,
    );
    const decisions = await review.currentBatch(
      qualified.map((item) => item.definition),
      tx,
    );
    if (
      decisions.length !== chunk.length ||
      decisions.some((decision) => decision.kind === 'unavailable')
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const references = qualified.flatMap((item) => {
      const reference = mediaReference(item.projection);
      return reference ? [reference] : [];
    });
    if (references.length && !ratingsMediaMutationActive(tx))
      await mediaProof.capture(tx);
    const media = references.length
      ? await mediaFacade.readBatch(references, tx, mediaBudget)
      : new Map<string, CategoryIconMediaContentFact>();
    if (references.length)
      collectRatingsMediaMutationRead(tx, references, media, mediaBudget);
    for (const [index, item] of qualified.entries()) {
      const exact = chunk[index]!,
        reference = mediaReference(item.projection);
      const fact = reference
        ? media.get(categoryIconMediaContentKey(reference.parent))
        : null;
      if (
        reference &&
        (!fact ||
          fact.version !== 8 ||
          !canonicalEqual(fact.parent, reference.parent) ||
          fact.decision === 'unknown' ||
          fact.validUntil === null ||
          !Number.isFinite(fact.validUntil) ||
          fact.attachments.length !== 1 ||
          fact.attachments[0]!.assetId !== reference.expected[0]!.assetId ||
          fact.attachments[0]!.manifestDigest !== reference.expected[0]!.digest)
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      if (fact)
        registerTransactionDeadline(tx, fact.validUntil, 'MEDIA_UNAVAILABLE');
      const decision =
        decisions[index]!.kind === 'deny' || fact?.decision === 'deny'
          ? 'deny'
          : 'allow';
      pending.set(
        qualifiedKey(head.release_id, scope.catalog.id, exact.row.id),
        Object.freeze({
          expected: exact.fingerprint,
          projection: item.projection,
          decision,
          media: fact ?? null,
        }),
      );
    }
  }
  // Catch a head change during multi-statement qualification. The retained
  // original/extension proofs also recheck after deferred waits before output.
  const after = await currentHead(scope, tx);
  if (
    after.head.release_id !== head.release_id ||
    after.digest !== digest ||
    state.epoch !== transactionReadEpoch(tx)
  )
    unavailable();
  for (const [key, value] of pending) state.qualified.set(key, value);
  state.releases.set(key, head.release_id);
  return Object.freeze(
    expected.map(
      (exact) =>
        state.qualified.get(
          qualifiedKey(head.release_id, scope.catalog.id, exact.row.id),
        )?.decision ?? unavailable(),
    ),
  );
}

/** Only a qualified current row in this exact transaction/read epoch can mint
 * this opaque authenticated route. Absence requires a verified composite Review;
 * an old unmarked schema, missing coverage or unknown media is never null. */
export function currentCategoryIconDescriptor(
  scope: ResolvedRatingReadScope,
  categoryId: string,
  context: { id: string; token: string },
  tx: PoolClient,
): CategoryIconMediaDescriptor | null {
  const state = stateFor(tx),
    releaseId = state.releases.get(scopeKey(scope));
  if (!releaseId) return unavailable();
  const entry = state.qualified.get(
    qualifiedKey(releaseId, scope.catalog.id, categoryId),
  );
  if (
    !entry ||
    entry.decision !== 'allow' ||
    entry.projection.scopeKey !== scope.catalog.scopeKey ||
    !canonicalEqual(entry.projection.content.selector, scope.selector)
  )
    return unavailable();
  const icon = entry.projection.content.icon;
  if (icon.kind === 'absent') return null;
  const fact = entry.media;
  if (!fact || fact.decision !== 'allow' || fact.attachments.length !== 1)
    return unavailable();
  const attachment = fact.attachments[0]!;
  return categoryIconMediaDescriptorSchema.parse({
    protocol: 'ratings-category-icon-media-v1',
    kind: 'ratings-category-icon-media',
    categoryId,
    contextId: context.id,
    contextToken: context.token,
    appearanceId: icon.appearance.appearanceId,
    bindingId: attachment.bindingId,
    width: attachment.width,
    height: attachment.height,
    variants: ['thumb-v1', 'display-v1'],
  });
}
