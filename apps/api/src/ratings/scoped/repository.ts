import { dependencyRows } from '../../database/dependency-read-budget.js';
import type { Decision } from '../../community/community-policy.js';
import {
  currentCategoryIcons,
  hasCurrentCategoryIconExtension,
} from '../category-management/icon-current.js';
import { retainRatingDiscussionScope } from '../discussion-media-current.js';
import { requireCurrentTargetCoverScope } from './target-cover-capability.js';
import { retainRatingReadBytes } from '../target-cover-current.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  transactionReadEpoch,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { canonicalEqual } from '../../community/content-review/contracts.js';
import { RatingContentReviewFacade } from '../../community/content-review/rating-content-review.facade.js';
import { RatingScopedContentReviewFacade } from '../../community/content-review/rating-scoped-content-review.facade.js';
import { RatingCategoryContentReviewFacade } from '../../community/content-review/rating-category-content-review.facade.js';
import { canonicalRatingScopedCategorySource } from '../../community/content-review/rating-scoped-contracts.js';
import { canonicalRatingCategoryBase } from '../../community/content-review/rating-category-contracts.js';
import type { CategoryRow, CurrentTargetRow } from '../repository.js';
import {
  currentRatingTargetRow,
  ratingCurrentTargetColumns,
  ratingCurrentTargetDefinitionJoins,
} from '../target-definition.repository.js';
import type { CurrentTargetRead } from '../target-definition.repository.js';
import { ratingCompletePoolSummary } from '../random/complete-pool.repository.js';
import type { RatingSummary } from '../contracts.js';
import { ratingCategorySchema } from '../contracts.js';
import type { AnyRatingTargetDefinitionDescriptor } from '../../community/content-review/rating-target-definition-contracts.js';
import {
  assertResolvedRatingScope,
  assertResolvedRatingRandomScope,
  retainResolvedRatingScopeAfter,
} from './context.service.js';
import type {
  ResolvedRatingScope,
  ResolvedRatingReadScope,
  ResolvedRatingRandomScope,
} from './context.service.js';
import { scopedExpectedCategorySchema } from './compiler.js';
import { scopedId } from './contracts.js';
import { ratingScopedDigest } from './protocol-registry.js';
import {
  RATING_SCOPED_BYTE_LIMIT,
  RATING_SCOPED_POOL_PATH_LIMIT,
  RATING_SCOPED_POOL_TARGET_LIMIT,
} from './constants.js';
function unavailable(): never {
  throw new ApplicationError('RATING_UNAVAILABLE');
}
async function readEpochs(tx: PoolClient): Promise<string> {
  const rows = (
    await tx.query<{
      kind: string;
      singleton: boolean;
      version: number;
      epoch: string;
    }>(`SELECT 'navigation' kind,singleton,version,epoch::text FROM whaleu_ratings.navigation_epoch
 UNION ALL SELECT 'pool',singleton,version,epoch::text FROM whaleu_ratings.random_pool_epoch ORDER BY kind`)
  ).rows;
  if (
    rows.length !== 2 ||
    rows[0]?.kind !== 'navigation' ||
    rows[1]?.kind !== 'pool' ||
    rows.some(
      (r) =>
        r.singleton !== true ||
        r.version !== 1 ||
        !/^(0|[1-9][0-9]*)$/.test(r.epoch) ||
        BigInt(r.epoch) > 9223372036854775807n,
    )
  )
    unavailable();
  return ownerFingerprint(rows);
}
const proof: RequiredTransactionProof<{ epoch: string }> = {
  maximumFacts: 4,
  failureCode: 'RATING_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_ratings.navigation_epoch,whaleu_ratings.random_pool_epoch IN SHARE MODE NOWAIT',
      );
      const epoch = await readEpochs(read);
      if (facts.some((f) => f.epoch !== epoch)) unavailable();
    }),
};
interface Source {
  id: string;
  revision: string;
  source_kind: string;
  issuer?: string;
  payload: Record<string, unknown>;
  current: boolean;
}
interface CategoryRead extends CategoryRow {
  effective_digest: string;
  proof: unknown;
  base: Source | null;
  override: Source | null;
  placement_revision: string | null;
  expected: unknown;
}
const categoryColumns = `c.category_id id,c.parent_id,c.level,c.kind,c.system_key,c.name,c.description,c.effective_revision revision,c.ordinal::text,c.active,c.hidden,c.effective_digest,
 l.proof,l.placement_revision,to_jsonb(base_source)||jsonb_build_object('current',whaleu_ratings.scoped_source_current(base_source.id,base_source.revision,clock_timestamp())) base,
 CASE WHEN override_source.id IS NULL THEN NULL ELSE to_jsonb(override_source)||jsonb_build_object('current',whaleu_ratings.scoped_source_current(override_source.id,override_source.revision,clock_timestamp())) END override,
 whaleu_ratings.scoped_expected_category(l.placement_revision,$2) expected`;
const categoryJoins = `LEFT JOIN whaleu_ratings.scoped_category_lineage l ON (l.catalog_id,l.category_id,l.effective_revision)=(c.catalog_id,c.category_id,c.effective_revision)
 LEFT JOIN whaleu_ratings.scoped_source_attestations base_source ON (base_source.id,base_source.revision)=(l.base_source_id,l.base_source_revision)
 LEFT JOIN whaleu_ratings.scoped_source_attestations override_source ON (override_source.id,override_source.revision)=(l.override_source_id,l.override_source_revision)`;
interface MembershipRead extends CurrentTargetRead {
  membership_category: string;
  placement_revision: string;
  placement_valid: boolean;
}
async function subscriptionFingerprint(
  actor: string,
  tx: PoolClient,
): Promise<string> {
  const rows = (
    await tx.query<{
      target_id: string;
      revision: string;
      subscribed: boolean;
      last_transition_id: string;
    }>(
      `SELECT target_id,revision,subscribed,last_transition_id
 FROM whaleu_ratings.subscription_memberships WHERE account_id=$1 ORDER BY target_id LIMIT 100001`,
      [actor],
    )
  ).rows;
  if (
    rows.length > 100000 ||
    Buffer.byteLength(JSON.stringify(rows), 'utf8') >
      RATING_SCOPED_BYTE_LIMIT ||
    rows.some(
      (r) =>
        !scopedId.safeParse(r.target_id).success ||
        !scopedId.safeParse(r.revision).success ||
        typeof r.subscribed !== 'boolean' ||
        !scopedId.safeParse(r.last_transition_id).success,
    )
  )
    unavailable();
  return ownerFingerprint(rows);
}
const subscriptionProof: RequiredTransactionProof<{
  actor: string;
  fingerprint: string;
}> = {
  maximumFacts: 1,
  failureCode: 'RATING_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_ratings.subscription_memberships IN SHARE MODE NOWAIT',
      );
      if (
        facts.length !== 1 ||
        facts[0]!.fingerprint !==
          (await subscriptionFingerprint(facts[0]!.actor, read))
      )
        unavailable();
    }),
};
const subscriptionCaches = new WeakMap<
  PoolClient,
  { epoch: object; actor: string; fingerprint: string }
>();
declare const poolBrand: unique symbol;
export interface RatingScopedPoolHandle {
  readonly [poolBrand]: true;
}
export interface RatingScopedPoolItem {
  readonly id: string;
  readonly row: CurrentTargetRow;
  readonly definition: AnyRatingTargetDefinitionDescriptor;
  readonly scope: ResolvedRatingScope;
  readonly summary: RatingSummary;
  readonly authorized: boolean;
}
export interface RatingScopedPoolBatch {
  readonly items: readonly RatingScopedPoolItem[];
  readonly done: boolean;
}
interface PoolState {
  tx: PoolClient;
  readEpoch: object;
  epoch: string;
  expires: number;
  scopes: readonly ResolvedRatingScope[];
  categoryId: string;
  categoryFound: boolean;
  categoryAllowed: Map<string, boolean>;
  afterCatalog: string | null;
  afterTarget: string | null;
  busy: boolean;
  done: boolean;
  complete: boolean;
  bytes: number;
  rawPaths: number;
  paths: number;
  targets: Set<string>;
  rawTargets: Set<string>;
}
const pools = new WeakMap<RatingScopedPoolHandle, PoolState>();
function poolState(handle: RatingScopedPoolHandle, tx: PoolClient): PoolState {
  const state = pools.get(handle);
  if (
    !state ||
    state.tx !== tx ||
    state.readEpoch !== transactionReadEpoch(tx) ||
    performance.now() >= state.expires
  )
    unavailable();
  return state;
}
const poolProof: RequiredTransactionProof<{ handle: RatingScopedPoolHandle }> =
  {
    maximumFacts: 1,
    failureCode: 'RATING_UNAVAILABLE',
    validate: (facts, tx) =>
      boundedOwnerProof(tx, 'RATING_UNAVAILABLE', async (read) => {
        if (facts.length !== 1) unavailable();
        const state = poolState(facts[0]!.handle, tx);
        if (!state.done || !state.complete || state.busy) unavailable();
        await read.query(
          'LOCK TABLE whaleu_ratings.random_pool_epoch,whaleu_ratings.navigation_epoch IN SHARE MODE NOWAIT',
        );
        if ((await readEpochs(read)) !== state.epoch) unavailable();
      }),
  };
@Injectable()
export class RatingScopedRepository {
  constructor(
    @Inject(RatingContentReviewFacade)
    private readonly review: RatingContentReviewFacade,
    @Inject(RatingScopedContentReviewFacade)
    private readonly scopedReview: RatingScopedContentReviewFacade,
    @Inject(RatingCategoryContentReviewFacade)
    private readonly categoryReview: RatingCategoryContentReviewFacade,
  ) {}
  enable(tx: PoolClient): void {
    enableRequiredTransactionProof(tx, proof);
  }
  async navigation(tx: PoolClient): Promise<string> {
    this.enable(tx);
    const epoch = await readEpochs(tx);
    registerRequiredTransactionFact(tx, proof, epoch, Object.freeze({ epoch }));
    return epoch;
  }
  async retainAfter(
    scope: ResolvedRatingReadScope,
    tx: PoolClient,
  ): Promise<void> {
    assertResolvedRatingScope(scope, tx, true);
    await retainResolvedRatingScopeAfter(scope, tx);
    await this.navigation(tx);
  }
  private async sourceReview(
    source: Source,
    categoryId: string,
    tx: PoolClient,
  ): Promise<'allow' | 'deny'> {
    if (!source || source.current !== true)
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    if (source.source_kind === 'm3a_native_bridge') {
      const payload = source.payload;
      const legacyCatalogId =
        payload['legacyCatalogId'] ?? payload['legacyAfterCatalogId'];
      if (
        !scopedId.safeParse(legacyCatalogId).success ||
        payload['categoryId'] !== categoryId ||
        !scopedId.safeParse(payload['categoryRevision']).success
      )
        unavailable();
      const row = (
        await tx.query<{
          category_id: string;
          revision: string;
          envelope: unknown;
        }>(
          `SELECT b.category_id,b.revision,b.envelope FROM whaleu_ratings.catalog_category_lineage l
    JOIN whaleu_ratings.category_base_versions b ON b.category_id=l.category_id AND b.revision=l.base_revision
    WHERE l.catalog_id=$1 AND l.category_id=$2 AND l.effective_revision=$3 AND l.source_kind='native'`,
          [legacyCatalogId, categoryId, payload['categoryRevision']],
        )
      ).rows[0];
      if (!row) unavailable();
      const result = await this.categoryReview.current(
        canonicalRatingCategoryBase({
          categoryId,
          baseRevision: row.revision,
          envelope: row.envelope as never,
        }),
        tx,
      );
      if (result.kind === 'unavailable')
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      return result.kind;
    }
    if (
      source.source_kind === 'scoped_category_override' &&
      source.payload['action'] === 'inherit'
    ) {
      const reset = (
        await tx.query<{ valid: boolean }>(
          `SELECT issuer='ratings-category-management' AND payload->>'categoryId'=$3 AND payload->'modes'=jsonb_build_object('name',jsonb_build_object('mode','inherit'),'description',jsonb_build_object('mode','inherit')) AND NOT payload ? 'reviewEnvelope' valid FROM whaleu_ratings.scoped_source_attestations WHERE id=$1 AND revision=$2`,
          [source.id, source.revision, categoryId],
        )
      ).rows[0];
      if (reset?.valid !== true) unavailable();
      return 'allow';
    }
    if (source.source_kind === 'legacy_adoption') {
      const evidence = source.payload['reviewSource'];
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence))
        unavailable();
      const ref = evidence as Record<string, unknown>;
      if (
        ref['kind'] !== 'scoped_category_v5' ||
        !scopedId.safeParse(ref['sourceId']).success ||
        !scopedId.safeParse(ref['sourceRevision']).success
      )
        unavailable();
      const reviewed = (
        await tx.query<Source>(
          `SELECT s.*,whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()) current FROM whaleu_ratings.scoped_source_attestations s WHERE s.id=$1 AND s.revision=$2 AND s.source_kind='scoped_category_base'`,
          [ref['sourceId'], ref['sourceRevision']],
        )
      ).rows[0];
      if (!reviewed) unavailable();
      return this.sourceReview(reviewed, categoryId, tx);
    }
    if (
      !['scoped_category_base', 'scoped_category_override'].includes(
        source.source_kind,
      )
    )
      unavailable();
    const descriptor = canonicalRatingScopedCategorySource({
      sourceId: source.id,
      sourceRevision: source.revision,
      categoryId,
      envelope: source.payload['reviewEnvelope'],
    });
    const result = await this.scopedReview.currentCategorySource(
      descriptor,
      tx,
    );
    if (result.kind === 'unavailable')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return result.kind;
  }
  private async categoryEvidence(
    scope: ResolvedRatingReadScope,
    id: string,
    tx: PoolClient,
  ): Promise<{
    leaf: CategoryRow | null;
    allowed: boolean;
    path: readonly CategoryRow[];
  }> {
    assertResolvedRatingScope(scope, tx, true);
    const rows = (
      await tx.query<CategoryRead>(
        `WITH RECURSIVE path AS (
   SELECT c.category_id,c.parent_id,c.level,1 depth FROM whaleu_ratings.scoped_categories c WHERE c.catalog_id=$1 AND c.category_id=$3
   UNION ALL SELECT c.category_id,c.parent_id,c.level,p.depth+1 FROM whaleu_ratings.scoped_categories c JOIN path p ON c.category_id=p.parent_id WHERE c.catalog_id=$1 AND p.depth<3)
   SELECT ${categoryColumns} FROM whaleu_ratings.scoped_categories c JOIN path p ON p.category_id=c.category_id ${categoryJoins}
   WHERE c.catalog_id=$1 ORDER BY c.level FOR SHARE OF c`,
        [scope.catalog.id, scope.catalog.scopeKey, id],
      )
    ).rows;
    retainRatingReadBytes(tx, rows);
    if (!rows.length) return { leaf: null, allowed: false, path: [] };
    const leaf = rows.at(-1)!;
    if (
      leaf.id !== id ||
      rows.length !== leaf.level ||
      rows.length > 3 ||
      rows.some(
        (r, i) =>
          r.level !== i + 1 ||
          (i === 0 ? r.parent_id !== null : r.parent_id !== rows[i - 1]!.id),
      )
    )
      unavailable();
    let allowed = true;
    for (const row of rows) {
      if (!row.base || !row.placement_revision) unavailable();
      // Review denial is authoritative only after exact immutable binding. Missing
      // or mismatched Review is never reduced to an empty category result.
      const base = await this.sourceReview(row.base, row.id, tx),
        override = row.override
          ? await this.sourceReview(row.override, row.id, tx)
          : 'allow';
      if (base === 'deny' || override === 'deny') {
        allowed = false;
        continue;
      }
      const expected = scopedExpectedCategorySchema.parse(row.expected),
        saved = scopedExpectedCategorySchema.parse(row.proof);
      if (
        !canonicalEqual(expected, saved) ||
        row.effective_digest !== ratingScopedDigest('effective', expected) ||
        expected.placementRevision !== row.placement_revision ||
        !canonicalEqual(
          {
            id: row.id,
            parentId: row.parent_id,
            level: row.level,
            kind: row.kind,
            systemKey: row.system_key,
            name: row.name,
            description: row.description,
            active: row.active,
            hidden: row.hidden,
            ordinal: row.ordinal,
          },
          {
            id: expected.body.id,
            parentId: expected.body.parentId,
            level: expected.body.level,
            kind: expected.body.kind,
            systemKey: expected.body.systemKey,
            name: expected.body.name,
            description: expected.body.description,
            active: expected.body.active,
            hidden: expected.body.hidden,
            ordinal: expected.body.ordinal,
          },
        )
      )
        unavailable();
      ratingCategorySchema.parse({
        id: row.id,
        parentId: row.parent_id,
        level: row.level,
        kind: row.kind,
        systemKey: row.system_key,
        name: row.name,
        description: row.description,
        revision: row.revision,
      });
      if (!row.active || row.hidden) allowed = false;
    }
    const icons = await currentCategoryIcons(scope, rows, tx);
    if (icons.some((decision) => decision === 'deny')) allowed = false;
    return { leaf, allowed, path: rows };
  }
  /** The complete, current Review-qualified path, never a client path string. */
  async qualifiedPath(
    scope: ResolvedRatingReadScope,
    id: string,
    tx: PoolClient,
  ): Promise<readonly CategoryRow[]> {
    assertResolvedRatingScope(scope, tx);
    await this.navigation(tx);
    const evidence = await this.categoryEvidence(scope, id, tx);
    if (!evidence.leaf || !evidence.allowed)
      throw new ApplicationError('RATING_NOT_FOUND');
    return evidence.path;
  }
  /** A saved text preparation is not current Category-media authority. This
   * conditional recheck leaves unmarked heads and pre-extension schemas on
   * their original text-only path. */
  async recheckPreparedCategoryIcons(
    scope: ResolvedRatingReadScope,
    categoryId: string,
    expectedRevision: string,
    tx: PoolClient,
  ): Promise<void> {
    assertResolvedRatingScope(scope, tx);
    if (!(await hasCurrentCategoryIconExtension(scope, tx))) return;
    const category = await this.category(scope, categoryId, tx, true);
    if (category.revision !== expectedRevision)
      throw new ApplicationError('RATING_REVISION_CONFLICT');
  }
  async category(
    scope: ResolvedRatingReadScope,
    id: string,
    tx: PoolClient,
    write = false,
  ): Promise<CategoryRow> {
    assertResolvedRatingScope(scope, tx);
    if (!write) await this.navigation(tx);
    const result = await this.categoryEvidence(scope, id, tx);
    if (!result.leaf || !result.allowed)
      throw new ApplicationError('RATING_NOT_FOUND');
    return result.leaf;
  }
  async categories(
    scope: ResolvedRatingReadScope,
    parentId: string | null,
    after: string | null,
    limit: number,
    tx: PoolClient,
  ): Promise<CategoryRow[]> {
    assertResolvedRatingScope(scope, tx);
    await this.navigation(tx);
    if (parentId) await this.category(scope, parentId, tx);
    const result: CategoryRow[] = [];
    let cursor = after,
      scanned = 0;
    while (result.length < limit + 1) {
      const rows = (
        await tx.query<{ id: string; ordinal: string }>(
          `SELECT category_id id,ordinal::text FROM whaleu_ratings.scoped_categories
    WHERE catalog_id=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND ($3::bigint IS NULL OR ordinal>$3::bigint) ORDER BY ordinal LIMIT 128`,
          [scope.catalog.id, parentId, cursor],
        )
      ).rows;
      scanned += rows.length;
      if (scanned > 10000) unavailable();
      for (const row of rows) {
        const evidence = await this.categoryEvidence(scope, row.id, tx);
        if (!evidence.leaf) unavailable();
        if (evidence.allowed) result.push(evidence.leaf);
      }
      if (rows.length < 128) break;
      const next = rows.at(-1)!.ordinal;
      if (cursor !== null && BigInt(next) <= BigInt(cursor)) unavailable();
      cursor = next;
    }
    return result.slice(0, limit + 1);
  }
  async target(
    scope: ResolvedRatingReadScope,
    id: string,
    tx: PoolClient,
    write = false,
    coverMutation = false,
  ): Promise<{ row: CurrentTargetRow; category: CategoryRow }> {
    assertResolvedRatingScope(scope, tx);
    if (!write) await this.navigation(tx);
    const raw = (
      await tx.query<MembershipRead>(
        `SELECT ${ratingCurrentTargetColumns},m.category_id membership_category,m.placement_revision,
    coalesce(p.target_id=t.id AND $3=ANY(p.scope_keys) AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp()),false) placement_valid
   FROM whaleu_ratings.scoped_target_memberships m JOIN whaleu_ratings.targets t ON t.id=m.target_id
   LEFT JOIN whaleu_ratings.target_scope_placements p ON p.placement_revision=m.placement_revision AND p.target_id=m.target_id
   ${ratingCurrentTargetDefinitionJoins} WHERE m.catalog_id=$1 AND m.target_id=$2 FOR ${write ? 'UPDATE' : 'SHARE'} OF t`,
        [scope.catalog.id, id, scope.catalog.scopeKey],
      )
    ).rows[0];
    if (!raw || !raw.active || raw.owner_deleted)
      throw new ApplicationError('RATING_NOT_FOUND');
    if (
      raw.placement_valid !== true ||
      raw.membership_category !== raw.category_id
    )
      unavailable();
    const category = await this.category(scope, raw.category_id, tx, write),
      row = currentRatingTargetRow(raw);
    await requireCurrentTargetCoverScope(scope, [row.definition], tx);
    const decision =
      coverMutation && write
        ? await this.review.currentTargetDefinitionForCoverMutation(
            row.definition,
            tx,
          )
        : await this.review.currentTargetDefinition(row.definition, tx);
    if (decision.kind === 'unavailable')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (decision.kind === 'deny')
      throw new ApplicationError('RATING_NOT_FOUND');
    retainRatingDiscussionScope(scope, row.id, tx);
    return { row, category };
  }
  /** List candidates are qualified as one complete Media/Review vector before
   * projection. A denied candidate is omitted; unknown aborts the page. */
  async currentTargetBatch(
    scope: ResolvedRatingReadScope,
    ids: readonly string[],
    tx: PoolClient,
  ): Promise<ReadonlyMap<string, CurrentTargetRow>> {
    assertResolvedRatingScope(scope, tx);
    if (ids.length > 50 || new Set(ids).size !== ids.length) unavailable();
    await this.navigation(tx);
    if (!ids.length) return new Map();
    const rows = (
      await tx.query<MembershipRead>(
        `SELECT ${ratingCurrentTargetColumns},m.category_id membership_category,m.placement_revision,
      coalesce(p.target_id=t.id AND $3=ANY(p.scope_keys) AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp()),false) placement_valid
      FROM whaleu_ratings.scoped_target_memberships m JOIN whaleu_ratings.targets t ON t.id=m.target_id
      LEFT JOIN whaleu_ratings.target_scope_placements p ON p.placement_revision=m.placement_revision AND p.target_id=m.target_id
      ${ratingCurrentTargetDefinitionJoins} WHERE m.catalog_id=$1 AND m.target_id=ANY($2::uuid[]) ORDER BY t.id FOR SHARE OF t`,
        [scope.catalog.id, ids, scope.catalog.scopeKey],
      )
    ).rows;
    retainRatingReadBytes(tx, rows);
    if (rows.length !== ids.length) unavailable();
    const current: CurrentTargetRow[] = [],
      categories = new Set<string>();
    for (const raw of rows) {
      if (
        raw.placement_valid !== true ||
        raw.membership_category !== raw.category_id
      )
        unavailable();
      if (!raw.active || raw.owner_deleted) continue;
      if (!categories.has(raw.category_id)) {
        await this.category(scope, raw.category_id, tx);
        categories.add(raw.category_id);
      }
      current.push(currentRatingTargetRow(raw));
    }
    await requireCurrentTargetCoverScope(
      scope,
      current.map((r) => r.definition),
      tx,
    );
    const decisions = await this.review.currentDefinitionBatch(
        current.map((r) => r.definition),
        tx,
      ),
      result = new Map<string, CurrentTargetRow>();
    for (const [index, row] of current.entries()) {
      const d = decisions[index];
      if (!d || d.kind === 'unavailable')
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      if (d.kind === 'allow') result.set(row.id, row);
    }
    return result;
  }
  /** One complete ancestry vector (256 leaves / 768 nodes), with Review
   * decisions qualified in owner-sized chunks instead of a leaf SQL loop. */
  private async categoryLinkPaths(
    scope: ResolvedRatingReadScope,
    ids: readonly string[],
    tx: PoolClient,
  ): Promise<ReadonlyMap<string, Decision<readonly CategoryRow[]>>> {
    if (ids.length > 256) unavailable();
    const rows = await dependencyRows<CategoryRead & { leaf_id: string }>(
      tx,
      `WITH RECURSIVE path AS (
      SELECT c.category_id,c.parent_id,c.category_id leaf_id,1 depth FROM whaleu_ratings.scoped_categories c WHERE c.catalog_id=$1 AND c.category_id=ANY($3::uuid[])
      UNION ALL SELECT c.category_id,c.parent_id,p.leaf_id,p.depth+1 FROM whaleu_ratings.scoped_categories c JOIN path p ON c.category_id=p.parent_id WHERE c.catalog_id=$1 AND p.depth<3)
      SELECT p.leaf_id,${categoryColumns} FROM whaleu_ratings.scoped_categories c JOIN path p ON p.category_id=c.category_id ${categoryJoins}
      WHERE c.catalog_id=$1 ORDER BY p.leaf_id,c.level FOR SHARE OF c`,
      [scope.catalog.id, scope.catalog.scopeKey, ids],
      768,
    );
    if (rows.length > 768) unavailable();
    retainRatingReadBytes(tx, rows);
    const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
    const sources = [
      ...new Map(
        unique.flatMap((row) =>
          [row.base, row.override]
            .filter((source): source is Source => source !== null)
            .map((source) => [
              source.id + ':' + source.revision,
              { source, categoryId: row.id },
            ]),
        ),
      ).values(),
    ];
    const review = new Map<string, 'allow' | 'deny' | 'unknown'>();
    const resolved = sources.map((entry) => ({
      ...entry,
      original: entry.source.id + ':' + entry.source.revision,
    }));
    const adoptions = resolved.filter(
      (entry) => entry.source.source_kind === 'legacy_adoption',
    );
    if (adoptions.length) {
      const refs = adoptions.flatMap((entry) => {
        const ref = entry.source.payload['reviewSource'] as
          Record<string, unknown> | undefined;
        return ref?.['kind'] === 'scoped_category_v5' &&
          scopedId.safeParse(ref['sourceId']).success &&
          scopedId.safeParse(ref['sourceRevision']).success
          ? [
              {
                original: entry.original,
                id: ref['sourceId'],
                revision: ref['sourceRevision'],
              },
            ]
          : [];
      });
      const aliases = await dependencyRows<Source & { original: string }>(
        tx,
        `SELECT w.original,s.*,whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()) current FROM jsonb_to_recordset($1::jsonb) w(original text,id uuid,revision uuid) JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(w.id,w.revision) WHERE s.source_kind='scoped_category_base'`,
        [JSON.stringify(refs)],
        1536,
      );
      retainRatingReadBytes(tx, aliases);
      const byOriginal = new Map(aliases.map((row) => [row.original, row]));
      for (const entry of adoptions) {
        const source = byOriginal.get(entry.original);
        if (source && entry.source.current) entry.source = source;
      }
    }
    const scoped: {
      original: string;
      source: ReturnType<typeof canonicalRatingScopedCategorySource>;
    }[] = [];
    const legacy = resolved.filter(
      (entry) =>
        entry.source.current &&
        entry.source.source_kind === 'm3a_native_bridge',
    );
    for (const entry of resolved) {
      review.set(entry.original, 'unknown');
      const source = entry.source;
      if (!source.current) continue;
      if (
        source.source_kind === 'scoped_category_override' &&
        source.payload['action'] === 'inherit'
      ) {
        if (
          source.issuer === 'ratings-category-management' &&
          source.payload['categoryId'] === entry.categoryId &&
          canonicalEqual(source.payload['modes'], {
            name: { mode: 'inherit' },
            description: { mode: 'inherit' },
          }) &&
          !Object.hasOwn(source.payload, 'reviewEnvelope')
        )
          review.set(entry.original, 'allow');
      } else if (
        source.source_kind === 'scoped_category_base' ||
        source.source_kind === 'scoped_category_override'
      ) {
        try {
          scoped.push({
            original: entry.original,
            source: canonicalRatingScopedCategorySource({
              sourceId: source.id,
              sourceRevision: source.revision,
              categoryId: entry.categoryId,
              envelope: source.payload['reviewEnvelope'],
            }),
          });
        } catch {
          /* This source stays unknown. */
        }
      }
    }
    for (let offset = 0; offset < scoped.length; offset += 128) {
      const chunk = scoped.slice(offset, offset + 128),
        decisions = await this.scopedReview.currentBatch(
          chunk.map(({ source }) => ({ kind: 'category' as const, source })),
          tx,
        );
      chunk.forEach((entry, index) =>
        review.set(
          entry.original,
          decisions[index]?.kind === 'unavailable'
            ? 'unknown'
            : (decisions[index]?.kind ?? 'unknown'),
        ),
      );
    }
    if (legacy.length) {
      const refs = legacy.flatMap((entry) => {
        const catalog =
          entry.source.payload['legacyCatalogId'] ??
          entry.source.payload['legacyAfterCatalogId'];
        return entry.source.payload['categoryId'] === entry.categoryId &&
          scopedId.safeParse(catalog).success &&
          scopedId.safeParse(entry.source.payload['categoryRevision']).success
          ? [
              {
                original: entry.original,
                catalog,
                category: entry.categoryId,
                revision: entry.source.payload['categoryRevision'],
              },
            ]
          : [];
      });
      const bases = await dependencyRows<{
        original: string;
        category_id: string;
        revision: string;
        envelope: unknown;
      }>(
        tx,
        `SELECT w.original,b.category_id,b.revision,b.envelope FROM jsonb_to_recordset($1::jsonb) w(original text,catalog uuid,category uuid,revision uuid) JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id,l.effective_revision)=(w.catalog,w.category,w.revision) JOIN whaleu_ratings.category_base_versions b ON (b.category_id,b.revision)=(l.category_id,l.base_revision) WHERE l.source_kind='native'`,
        [JSON.stringify(refs)],
        1536,
      );
      retainRatingReadBytes(tx, bases);
      for (let offset = 0; offset < bases.length; offset += 512) {
        const chunk = bases.slice(offset, offset + 512);
        const decisions = await this.categoryReview.currentBatch(
          chunk.map((row) =>
            canonicalRatingCategoryBase({
              categoryId: row.category_id,
              baseRevision: row.revision,
              envelope: row.envelope as never,
            }),
          ),
          tx,
        );
        chunk.forEach((row, index) =>
          review.set(
            row.original,
            decisions[index]?.kind === 'unavailable'
              ? 'unknown'
              : (decisions[index]?.kind ?? 'unknown'),
          ),
        );
      }
    }
    const nodeDecisions = new Map<string, 'allow' | 'deny' | 'unknown'>();
    for (const row of unique) {
      let state: 'allow' | 'deny' | 'unknown' = 'allow';
      const base = row.base
        ? review.get(row.base.id + ':' + row.base.revision)
        : undefined;
      const override = row.override
        ? review.get(row.override.id + ':' + row.override.revision)
        : 'allow';
      if (base === 'deny' || override === 'deny') state = 'deny';
      else if (
        base !== 'allow' ||
        override !== 'allow' ||
        !row.placement_revision
      )
        state = 'unknown';
      else
        try {
          const expected = scopedExpectedCategorySchema.parse(row.expected),
            saved = scopedExpectedCategorySchema.parse(row.proof);
          if (
            !canonicalEqual(expected, saved) ||
            row.effective_digest !==
              ratingScopedDigest('effective', expected) ||
            expected.placementRevision !== row.placement_revision ||
            !canonicalEqual(
              {
                id: row.id,
                parentId: row.parent_id,
                level: row.level,
                kind: row.kind,
                systemKey: row.system_key,
                name: row.name,
                description: row.description,
                active: row.active,
                hidden: row.hidden,
                ordinal: row.ordinal,
              },
              {
                id: expected.body.id,
                parentId: expected.body.parentId,
                level: expected.body.level,
                kind: expected.body.kind,
                systemKey: expected.body.systemKey,
                name: expected.body.name,
                description: expected.body.description,
                active: expected.body.active,
                hidden: expected.body.hidden,
                ordinal: expected.body.ordinal,
              },
            )
          )
            state = 'unknown';
          else {
            ratingCategorySchema.parse({
              id: row.id,
              parentId: row.parent_id,
              level: row.level,
              kind: row.kind,
              systemKey: row.system_key,
              name: row.name,
              description: row.description,
              revision: row.revision,
            });
            if (!row.active || row.hidden) state = 'deny';
          }
        } catch {
          state = 'unknown';
        }
      nodeDecisions.set(row.id, state);
    }
    const validNodes = unique.filter(
      (row) => nodeDecisions.get(row.id) === 'allow',
    );
    if (validNodes.length) {
      const icons = await currentCategoryIcons(scope, validNodes, tx);
      validNodes.forEach((row, index) => {
        if (icons[index] === 'deny') nodeDecisions.set(row.id, 'deny');
      });
    }
    const result = new Map<string, Decision<readonly CategoryRow[]>>();
    for (const id of ids) {
      const path = rows.filter((row) => row.leaf_id === id),
        leaf = path.at(-1);
      if (
        !leaf ||
        leaf.id !== id ||
        path.length !== leaf.level ||
        path.some(
          (row, index) =>
            row.level !== index + 1 ||
            row.parent_id !== (index ? path[index - 1]!.id : null),
        )
      ) {
        result.set(id, { kind: 'unavailable' });
        continue;
      }
      // Missing evidence has precedence over a different denied ancestor.
      const decision = path.some(
        (row) => nodeDecisions.get(row.id) === 'unknown',
      )
        ? 'unavailable'
        : path.some((row) => nodeDecisions.get(row.id) === 'deny')
          ? 'deny'
          : 'allow';
      result.set(
        id,
        decision === 'allow'
          ? { kind: 'allow', value: path }
          : decision === 'deny'
            ? { kind: 'deny', reason: 'POST_NOT_FOUND' }
            : { kind: 'unavailable' },
      );
    }
    return result;
  }
  /** Required current target dependency vector for Community cards. Known
   * denial is per target; a denied category never turns unrelated rows to zero. */
  async targetLinkBatch(
    scope: ResolvedRatingReadScope,
    ids: readonly string[],
    tx: PoolClient,
  ): Promise<
    ReadonlyMap<
      string,
      Decision<{ row: CurrentTargetRow; path: readonly CategoryRow[] }>
    >
  > {
    assertResolvedRatingScope(scope, tx);
    if (ids.length > 256 || new Set(ids).size !== ids.length) unavailable();
    await this.navigation(tx);
    const result = new Map<
      string,
      Decision<{ row: CurrentTargetRow; path: readonly CategoryRow[] }>
    >();
    if (!ids.length) return result;
    const rows = await dependencyRows<MembershipRead>(
      tx,
      `SELECT ${ratingCurrentTargetColumns},m.category_id membership_category,m.placement_revision,
      coalesce(p.target_id=t.id AND $3=ANY(p.scope_keys) AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp()),false) placement_valid
      FROM whaleu_ratings.scoped_target_memberships m JOIN whaleu_ratings.targets t ON t.id=m.target_id
      LEFT JOIN whaleu_ratings.target_scope_placements p ON (p.placement_revision,p.target_id)=(m.placement_revision,m.target_id)
      ${ratingCurrentTargetDefinitionJoins} WHERE m.catalog_id=$1 AND m.target_id=ANY($2::uuid[]) ORDER BY t.id FOR SHARE OF t`,
      [scope.catalog.id, ids, scope.catalog.scopeKey],
      256,
    );
    retainRatingReadBytes(tx, rows);
    for (const id of ids)
      result.set(id, { kind: 'deny', reason: 'POST_NOT_FOUND' });
    const categories = await this.categoryLinkPaths(
      scope,
      [
        ...new Set(
          rows
            .filter((row) => row.active && !row.owner_deleted)
            .map((row) => row.category_id),
        ),
      ],
      tx,
    );
    const pending: { row: CurrentTargetRow; path: readonly CategoryRow[] }[] =
      [];
    for (const raw of rows) {
      if (!raw.active || raw.owner_deleted) continue;
      if (!raw.placement_valid || raw.membership_category !== raw.category_id) {
        result.set(raw.id, { kind: 'unavailable' });
        continue;
      }
      try {
        const path = categories.get(raw.category_id);
        if (!path || path.kind === 'unavailable') {
          result.set(raw.id, { kind: 'unavailable' });
          continue;
        }
        if (path.kind === 'deny') continue;
        pending.push({ row: currentRatingTargetRow(raw), path: path.value });
      } catch (error) {
        if (!(error instanceof ApplicationError)) throw error;
        result.set(raw.id, { kind: 'unavailable' });
      }
    }
    await requireCurrentTargetCoverScope(
      scope,
      pending.map((value) => value.row.definition),
      tx,
    );
    const decisions: Awaited<
      ReturnType<RatingContentReviewFacade['currentDefinitionBatch']>
    >[number][] = [];
    for (let offset = 0; offset < pending.length; offset += 128)
      decisions.push(
        ...(await this.review.currentDefinitionBatch(
          pending
            .slice(offset, offset + 128)
            .map((value) => value.row.definition),
          tx,
        )),
      );
    pending.forEach((value, index) => {
      const decision = decisions[index];
      result.set(
        value.row.id,
        decision?.kind === 'allow'
          ? { kind: 'allow', value }
          : decision?.kind === 'deny'
            ? { kind: 'deny', reason: 'POST_NOT_FOUND' }
            : { kind: 'unavailable' },
      );
    });
    return result;
  }
  async targets(
    scope: ResolvedRatingReadScope,
    categoryId: string,
    after: string | null,
    limit: number,
    tx: PoolClient,
  ): Promise<{ id: string; ordinal: string }[]> {
    assertResolvedRatingScope(scope, tx);
    await this.category(scope, categoryId, tx);
    return (
      await tx.query<{ id: string; ordinal: string }>(
        `SELECT target_id id,ordinal::text FROM whaleu_ratings.scoped_target_memberships WHERE catalog_id=$1 AND category_id=$2
   AND ($3::bigint IS NULL OR ordinal>$3::bigint) ORDER BY ordinal LIMIT $4`,
        [scope.catalog.id, categoryId, after, limit + 1],
      )
    ).rows;
  }
  async subscriptionNavigation(
    scope: ResolvedRatingReadScope,
    tx: PoolClient,
  ): Promise<string> {
    assertResolvedRatingScope(scope, tx);
    const readEpoch = transactionReadEpoch(tx);
    if (!readEpoch) unavailable();
    const cached = subscriptionCaches.get(tx);
    if (cached?.epoch === readEpoch && cached.actor === scope.actor)
      return cached.fingerprint;
    enableRequiredTransactionProof(tx, subscriptionProof);
    const fingerprint = await subscriptionFingerprint(scope.actor, tx);
    registerRequiredTransactionFact(
      tx,
      subscriptionProof,
      scope.actor,
      Object.freeze({ actor: scope.actor, fingerprint }),
    );
    subscriptionCaches.set(tx, {
      epoch: readEpoch,
      actor: scope.actor,
      fingerprint,
    });
    return fingerprint;
  }
  async subscriptions(
    scope: ResolvedRatingReadScope,
    after: string | null,
    limit: number,
    tx: PoolClient,
  ): Promise<{ id: string; ordinal: string }[]> {
    assertResolvedRatingScope(scope, tx);
    await this.navigation(tx);
    await this.subscriptionNavigation(scope, tx);
    return (
      await tx.query<{ id: string; ordinal: string }>(
        `SELECT m.target_id id,m.ordinal::text FROM whaleu_ratings.scoped_target_memberships m
   JOIN whaleu_ratings.subscription_memberships s ON s.target_id=m.target_id AND s.account_id=$2 AND s.subscribed
   WHERE m.catalog_id=$1 AND ($3::bigint IS NULL OR m.ordinal>$3::bigint) ORDER BY m.ordinal LIMIT $4`,
        [scope.catalog.id, scope.actor, after, limit + 1],
      )
    ).rows;
  }
  async beginPool(
    random: ResolvedRatingRandomScope,
    categoryId: string,
    tx: PoolClient,
  ): Promise<RatingScopedPoolHandle> {
    assertResolvedRatingRandomScope(random, tx);
    if (!scopedId.safeParse(categoryId).success) unavailable();
    const readEpoch = transactionReadEpoch(tx);
    if (!readEpoch) unavailable();
    const handle = Object.freeze({}) as RatingScopedPoolHandle;
    const state: PoolState = {
      tx,
      readEpoch,
      epoch: await readEpochs(tx),
      expires: performance.now() + 15000,
      scopes: random.scopes,
      categoryId,
      categoryFound: false,
      categoryAllowed: new Map(),
      afterCatalog: null,
      afterTarget: null,
      busy: false,
      done: false,
      complete: false,
      bytes: 0,
      rawPaths: 0,
      paths: 0,
      targets: new Set(),
      rawTargets: new Set(),
    };
    pools.set(handle, state);
    enableRequiredTransactionProof(tx, poolProof);
    registerRequiredTransactionFact(
      tx,
      poolProof,
      random.context.id,
      Object.freeze({ handle }),
    );
    for (const scope of random.scopes) {
      const result = await this.categoryEvidence(scope, categoryId, tx);
      poolState(handle, tx);
      state.categoryAllowed.set(
        `${scope.catalog.id}:${categoryId}`,
        result.allowed,
      );
      if (result.allowed && scope.authorized) state.categoryFound = true;
    }
    return handle;
  }
  async nextPool(
    handle: RatingScopedPoolHandle,
    tx: PoolClient,
  ): Promise<RatingScopedPoolBatch> {
    const state = poolState(handle, tx);
    if (state.busy || state.done || state.complete) unavailable();
    state.busy = true;
    try {
      const rows = (
        await tx.query<{
          catalog_id: string;
          category_id: string;
          target_id: string;
          placement_valid: boolean;
          target: CurrentTargetRead | null;
          summary: Record<string, unknown> | null;
        }>(
          `WITH RECURSIVE instant AS MATERIALIZED(SELECT clock_timestamp() now),tree AS (
    SELECT c.catalog_id,c.category_id,c.level,1 depth FROM whaleu_ratings.scoped_categories c WHERE c.catalog_id=ANY($1::uuid[]) AND c.category_id=$2
    UNION ALL SELECT c.catalog_id,c.category_id,c.level,p.depth+1 FROM whaleu_ratings.scoped_categories c JOIN tree p ON c.catalog_id=p.catalog_id AND c.parent_id=p.category_id WHERE p.depth<3
   ),paths AS MATERIALIZED(SELECT m.catalog_id,m.category_id,m.target_id,m.placement_revision FROM tree c JOIN whaleu_ratings.scoped_target_memberships m
     ON m.catalog_id=c.catalog_id AND m.category_id=c.category_id WHERE ($3::uuid IS NULL OR (m.catalog_id,m.target_id)>($3::uuid,$4::uuid)) ORDER BY m.catalog_id,m.target_id LIMIT 128)
    SELECT p.catalog_id,p.category_id,p.target_id,to_jsonb(current_target) target,q.summary,
    coalesce(placement.target_id=p.target_id AND catalog.scope_key=ANY(placement.scope_keys) AND whaleu_ratings.scoped_source_current(placement.source_id,placement.source_revision,instant.now),false) placement_valid
    FROM paths p CROSS JOIN instant LEFT JOIN whaleu_ratings.targets t ON t.id=p.target_id ${ratingCurrentTargetDefinitionJoins}
    LEFT JOIN whaleu_ratings.scoped_catalogs catalog ON catalog.id=p.catalog_id
    LEFT JOIN whaleu_ratings.target_scope_placements placement ON placement.placement_revision=p.placement_revision AND placement.target_id=p.target_id
    LEFT JOIN LATERAL(SELECT ${ratingCurrentTargetColumns}) current_target ON t.id IS NOT NULL
    LEFT JOIN LATERAL(SELECT to_jsonb(s) summary FROM whaleu_ratings.score_summaries s
      JOIN whaleu_ratings.score_baselines b ON b.target_id=s.target_id JOIN whaleu_ratings.target_sources o ON o.id=b.source_id AND o.target_id=b.target_id
      JOIN whaleu_ratings.target_creations c ON c.target_id=b.target_id WHERE s.target_id=p.target_id AND b.kind='fresh_zero' AND o.origin='new_native'
      AND o.coverage='complete' AND o.provenance='accepted' AND o.effective_at<=instant.now AND b.creation_transaction=c.creation_transaction AND c.source_id=o.id)q ON true
    ORDER BY p.catalog_id,p.target_id`,
          [
            state.scopes.map((s) => s.catalog.id),
            state.categoryId,
            state.afterCatalog,
            state.afterTarget,
          ],
        )
      ).rows;
      poolState(handle, tx);
      if (rows.length > 128) unavailable();
      const items: RatingScopedPoolItem[] = [];
      for (const path of rows) {
        const scope = state.scopes.find(
          (s) => s.catalog.id === path.catalog_id,
        );
        if (
          !scope ||
          !path.target ||
          path.target.id !== path.target_id ||
          path.target.category_id !== path.category_id ||
          path.placement_valid !== true
        )
          unavailable();
        if (
          state.afterCatalog !== null &&
          (path.catalog_id < state.afterCatalog ||
            (path.catalog_id === state.afterCatalog &&
              path.target_id <= state.afterTarget!))
        )
          unavailable();
        state.afterCatalog = path.catalog_id;
        state.afterTarget = path.target_id;
        state.rawPaths++;
        state.rawTargets.add(path.target_id);
        state.bytes += Buffer.byteLength(JSON.stringify(path), 'utf8');
        retainRatingReadBytes(tx, path);
        if (
          state.rawPaths > RATING_SCOPED_POOL_PATH_LIMIT ||
          state.rawTargets.size > RATING_SCOPED_POOL_TARGET_LIMIT ||
          state.bytes > RATING_SCOPED_BYTE_LIMIT
        )
          unavailable();
        const categoryKey = `${scope.catalog.id}:${path.category_id}`;
        if (!state.categoryAllowed.has(categoryKey)) {
          const result = await this.categoryEvidence(
            scope,
            path.category_id,
            tx,
          );
          poolState(handle, tx);
          if (!result.leaf) unavailable();
          state.categoryAllowed.set(categoryKey, result.allowed);
        }
        if (!path.target.active || path.target.owner_deleted) continue;
        const row = currentRatingTargetRow(path.target),
          summary = ratingCompletePoolSummary(path.summary);
        items.push(
          Object.freeze({
            id: row.id,
            row,
            definition: row.definition,
            scope,
            summary,
            authorized:
              scope.authorized &&
              state.categoryAllowed.get(
                `${scope.catalog.id}:${state.categoryId}`,
              ) === true &&
              state.categoryAllowed.get(categoryKey) === true,
          }),
        );
        state.paths++;
        state.targets.add(row.id);
      }
      state.done = rows.length < 128;
      return Object.freeze({ items: Object.freeze(items), done: state.done });
    } catch (error) {
      pools.delete(handle);
      throw error;
    } finally {
      state.busy = false;
    }
  }
  async completePool(
    handle: RatingScopedPoolHandle,
    tx: PoolClient,
  ): Promise<{
    categoryFound: boolean;
    pathCount: number;
    targetCount: number;
  }> {
    const state = poolState(handle, tx);
    if (!state.done || state.busy || state.complete) unavailable();
    if ((await readEpochs(tx)) !== state.epoch) unavailable();
    state.complete = true;
    return Object.freeze({
      categoryFound: state.categoryFound,
      pathCount: state.paths,
      targetCount: state.targets.size,
    });
  }
}
