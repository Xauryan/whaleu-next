import { RatingScopedContentReviewFacade } from '../../community/content-review/rating-scoped-content-review.facade.js';
import { RatingCategoryContentReviewFacade } from '../../community/content-review/rating-category-content-review.facade.js';
import { canonicalRatingScopedCategorySource } from '../../community/content-review/rating-scoped-contracts.js';
import { canonicalRatingCategoryBase } from '../../community/content-review/rating-category-contracts.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import {
  RatingScopedCompilationBudget,
  type ScopedCompilationInput,
  type ScopedExpectedCategory,
  type ScopedMembershipInput,
} from './compiler.js';
import {
  RATING_SCOPED_CATEGORY_LIMIT,
  RATING_SCOPED_MEMBERSHIP_LIMIT,
  RATING_SCOPED_RELEASE_CATEGORY_LIMIT,
  RATING_SCOPED_RELEASE_MEMBERSHIP_LIMIT,
  RATING_SCOPED_BYTE_LIMIT,
} from './constants.js';
import type { RatingScopedCampusProof } from '../../campus/rating-scoped-context.facade.js';
import { assertRatingScopedCampusProof } from '../../campus/rating-scoped-context.facade.js';
export interface ScopedSourceRow {
  id: string;
  revision: string;
  source_kind: string;
  source_key: string;
  scope_keys: string[];
  payload: Record<string, unknown>;
  digest: string;
  issuer: string;
  source_reference: string;
  policy_reference: string;
  valid_until: Date;
  current: boolean;
}
function unavailable(): never {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
}
/** Read-only accepted owner inputs. This class is never a source issuer. */
@Injectable()
export class RatingScopedSourceFacade {
  constructor(
    @Inject(RatingScopedContentReviewFacade)
    private readonly review: RatingScopedContentReviewFacade,
    @Inject(RatingCategoryContentReviewFacade)
    private readonly nativeReview: RatingCategoryContentReviewFacade,
  ) {}
  async verifyReviews(
    rows: readonly ScopedSourceRow[],
    tx: PoolClient,
    budget: RatingScopedCompilationBudget,
    strict = true,
  ) {
    const blocked = new Set<string>();
    const scoped = rows
      .filter(
        (row) =>
          row.source_kind === 'scoped_category_base' ||
          (row.source_kind === 'scoped_category_override' &&
            row.payload['action'] !== 'inherit'),
      )
      .map((row) =>
        canonicalRatingScopedCategorySource({
          sourceId: row.id,
          sourceRevision: row.revision,
          categoryId: (
            row.payload['reviewEnvelope'] as Record<string, unknown> | undefined
          )?.['categoryId'],
          envelope: row.payload['reviewEnvelope'],
        }),
      );
    budget.observe(scoped);
    for (let at = 0; at < scoped.length; at += 128) {
      const decisions = await this.review.currentBatch(
        scoped
          .slice(at, at + 128)
          .map((source) => ({ kind: 'category' as const, source })),
        tx,
      );
      decisions.forEach((d, n) => {
        if (d.kind !== 'allow') blocked.add(scoped[at + n]!.sourceId);
      });
      if (strict && decisions.some((d) => d.kind !== 'allow'))
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
    const native: ReturnType<typeof canonicalRatingCategoryBase>[] = [];
    for (const row of rows.filter(
      (row) => row.source_kind === 'm3a_native_bridge',
    )) {
      const body = (
        await tx.query<{
          category_id: string;
          revision: string;
          envelope: unknown;
        }>(
          `SELECT b.category_id,b.revision,b.envelope FROM whaleu_ratings.catalog_category_lineage l JOIN whaleu_ratings.category_base_versions b ON (b.category_id,b.revision)=(l.category_id,l.base_revision) WHERE l.catalog_id=$1 AND l.category_id=$2 AND l.effective_revision=$3 AND l.source_kind='native'`,
          [
            row.payload['legacyCatalogId'] ??
              row.payload['legacyAfterCatalogId'],
            row.payload['categoryId'],
            row.payload['categoryRevision'],
          ],
        )
      ).rows[0];
      if (!body) unavailable();
      native.push(
        canonicalRatingCategoryBase({
          categoryId: body.category_id,
          baseRevision: body.revision,
          envelope: body.envelope as never,
        }),
      );
    }
    budget.observe(native);
    for (let at = 0; at < native.length; at += 128) {
      const decisions = await this.nativeReview.currentBatch(
        native.slice(at, at + 128),
        tx,
      );
      decisions.forEach((d, n) => {
        if (d.kind !== 'allow')
          for (const row of rows)
            if (
              row.source_kind === 'm3a_native_bridge' &&
              row.payload['categoryId'] === native[at + n]!.categoryId
            )
              blocked.add(row.id);
      });
      if (strict && decisions.some((d) => d.kind !== 'allow'))
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
    for (const adopted of rows.filter(
      (r) => r.source_kind === 'legacy_adoption',
    )) {
      const ref = adopted.payload['reviewSource'] as
        Record<string, unknown> | undefined;
      if (ref?.['kind'] !== 'scoped_category_v5') unavailable();
      const reviewed = (
        await tx.query<ScopedSourceRow>(
          `SELECT s.*,whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()) current FROM whaleu_ratings.scoped_source_attestations s WHERE id=$1 AND revision=$2 AND source_kind='scoped_category_base'`,
          [ref['sourceId'], ref['sourceRevision']],
        )
      ).rows[0];
      if (!reviewed?.current) {
        if (strict) unavailable();
        blocked.add(adopted.id);
        continue;
      }
      registerTransactionDeadline(
        tx,
        reviewed.valid_until.getTime(),
        'RATING_SCOPE_UNAVAILABLE',
      );
      if ((await this.verifyReviews([reviewed], tx, budget, strict)).size)
        blocked.add(adopted.id);
    }
    return blocked;
  }

  async readExactSourceVector(
    scopeKeys: readonly string[],
    tx: PoolClient,
    budget = new RatingScopedCompilationBudget(),
  ) {
    if (
      !scopeKeys.length ||
      scopeKeys.length > 1001 ||
      new Set(scopeKeys).size !== scopeKeys.length
    )
      unavailable();
    const admission = (
      await tx.query<{ count: string; bytes: string }>(
        `SELECT count(*)::text count,coalesce(sum(pg_column_size(s)),0)::text bytes FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision) WHERE s.scope_keys&&$1::text[]`,
        [[...scopeKeys]],
      )
    ).rows[0];
    if (
      !admission ||
      !/^\d+$/.test(admission.count) ||
      !/^\d+$/.test(admission.bytes) ||
      BigInt(admission.count) > 100000n ||
      BigInt(admission.bytes) > BigInt(RATING_SCOPED_BYTE_LIMIT)
    )
      unavailable();
    const rows = (
      await tx.query<ScopedSourceRow>(
        `SELECT s.*,whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()) current FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision) WHERE s.scope_keys&&$1::text[] ORDER BY s.source_kind COLLATE "C",s.source_key COLLATE "C" LIMIT 100001 FOR SHARE OF h,s`,
        [[...scopeKeys]],
      )
    ).rows;
    budget.observe(rows);
    if (
      rows.length > 100000 ||
      rows.some((r) => !r.current || !(r.valid_until instanceof Date))
    )
      unavailable();
    for (const key of scopeKeys)
      if (
        rows.filter(
          (r) =>
            r.source_kind === 'scope_absence' &&
            r.source_key === key &&
            r.scope_keys.length === 1,
        ).length !== 1
      )
        unavailable();
    const upcoming = (
      await tx.query<{ at: Date | null }>(
        `SELECT min(effective_at) at FROM whaleu_ratings.scoped_source_attestations WHERE scope_keys&&$1::text[] AND effective_at>clock_timestamp()`,
        [[...scopeKeys]],
      )
    ).rows[0]?.at;
    const deadlines = rows.map((r) => r.valid_until.getTime());
    if (upcoming) deadlines.push(upcoming.getTime());
    const validUntil = Math.min(...deadlines);
    if (!Number.isFinite(validUntil)) unavailable();
    registerTransactionDeadline(tx, validUntil, 'RATING_SCOPE_UNAVAILABLE');
    const vector = rows.map((r) => ({
      id: r.id,
      revision: r.revision,
      kind: r.source_kind,
      key: r.source_key,
      digest: r.digest,
    }));
    return { rows, vector, validUntil, budget };
  }
  async compilerInputs(
    proof: RatingScopedCampusProof,
    tx: PoolClient,
    budget = new RatingScopedCompilationBudget(),
  ): Promise<ScopedCompilationInput[]> {
    assertRatingScopedCampusProof(proof, tx);
    const captured = await this.readExactSourceVector(
      proof.scopeKeys,
      tx,
      budget,
    );
    budget.observe({
      inventory: proof.inventoryFingerprint,
      mappings: proof.mappings,
      topology: proof.topologySnapshotId,
    });
    const consumed = (
      await tx.query<{ id: string }>(
        `SELECT DISTINCT id FROM (
      SELECT p.base_source_id id FROM whaleu_ratings.category_scope_placements p WHERE p.scope_keys&&$1::text[] AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp())
      UNION SELECT s.id FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision) WHERE s.source_kind='scoped_category_override' AND EXISTS(SELECT 1 FROM whaleu_ratings.category_scope_placements p WHERE p.category_id=coalesce(s.payload->'reviewEnvelope'->>'categoryId',s.payload->>'categoryId')::uuid AND p.scope_keys&&s.scope_keys AND s.scope_keys&&$1::text[] AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp()))
    ) used`,
        [proof.scopeKeys],
      )
    ).rows;
    const ids = new Set(consumed.map((r) => r.id));
    await this.verifyReviews(
      captured.rows.filter((r) => ids.has(r.id)),
      tx,
      budget,
    );
    const inputs: ScopedCompilationInput[] = [];
    let totalCategories = budget.snapshot().categories,
      totalMemberships = budget.snapshot().memberships;
    for (const key of proof.scopeKeys) {
      const campusId = key === 'global' ? null : key.slice(7),
        mapping = campusId
          ? proof.mappings.find((m) => m.campusId === campusId)
          : null;
      if (campusId && !mapping) unavailable();
      const head = (
        await tx.query<{ catalog_id: string; head_revision: string }>(
          'SELECT catalog_id,head_revision FROM whaleu_ratings.scoped_catalog_heads WHERE scope_key=$1 FOR UPDATE',
          [key],
        )
      ).rows[0];
      const categories = (
        await tx.query<{ expected: unknown }>(
          `SELECT whaleu_ratings.scoped_expected_category(p.placement_revision,$1) expected FROM whaleu_ratings.category_scope_placements p WHERE $1=ANY(p.scope_keys) AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp()) ORDER BY p.category_id LIMIT $2`,
          [
            key,
            Math.min(
              RATING_SCOPED_CATEGORY_LIMIT,
              RATING_SCOPED_RELEASE_CATEGORY_LIMIT - totalCategories,
            ) + 1,
          ],
        )
      ).rows;
      if (
        categories.length > RATING_SCOPED_CATEGORY_LIMIT ||
        categories.some((c) => c.expected === null)
      )
        unavailable();
      // The compiler validates the complete category parent tree. Intersect the
      // immutable target placement with this exact current category domain; the
      // independent SQL publication verifier proves category eligibility again.
      const members = (
        await tx.query<{
          target_id: string;
          category_id: string;
          placement_revision: string;
          target_region_id: string | null;
          ordinal: string;
        }>(
          `WITH locked AS MATERIALIZED (
            SELECT t.id target_id,t.category_id,p.placement_revision,t.region_id target_region_id
            FROM whaleu_ratings.target_scope_placements p JOIN whaleu_ratings.targets t ON t.id=p.target_id
            WHERE $1=ANY(p.scope_keys) AND whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp()) AND t.category_id=ANY($4::uuid[])
            ORDER BY t.id LIMIT $2 FOR SHARE OF t,p)
          SELECT current.*, (CASE WHEN previous.ordinal IS NOT NULL THEN previous.ordinal ELSE
            COALESCE((SELECT max(ordinal) FROM whaleu_ratings.scoped_target_memberships WHERE catalog_id=$3),-1)
            +sum(CASE WHEN previous.ordinal IS NULL THEN 1 ELSE 0 END) OVER (ORDER BY current.target_id) END)::text ordinal
          FROM locked current LEFT JOIN whaleu_ratings.scoped_target_memberships previous ON previous.catalog_id=$3 AND previous.target_id=current.target_id
          ORDER BY current.target_id`,
          [
            key,
            Math.min(
              RATING_SCOPED_MEMBERSHIP_LIMIT,
              RATING_SCOPED_RELEASE_MEMBERSHIP_LIMIT - totalMemberships,
            ) + 1,
            head?.catalog_id ?? null,
            categories.map(
              (c) => (c.expected as ScopedExpectedCategory).body.id,
            ),
          ],
        )
      ).rows;
      if (members.length > RATING_SCOPED_MEMBERSHIP_LIMIT) unavailable();
      const memberships: ScopedMembershipInput[] = members.map((m) => ({
        targetId: m.target_id,
        categoryId: m.category_id,
        placementRevision: m.placement_revision,
        targetRegionId: m.target_region_id,
        ordinal: m.ordinal,
      }));
      const sources = captured.rows.filter((r) => r.scope_keys.includes(key));
      const validUntil = Math.min(
        ...sources.map((r) => r.valid_until.getTime()),
        proof.validUntil ?? Infinity,
      );
      const input: ScopedCompilationInput = {
        scopeKey: key,
        regionId: mapping?.regionId ?? null,
        campusId,
        sourceVector: sources.map((r) => ({
          id: r.id,
          revision: r.revision,
          kind: r.source_kind,
          key: r.source_key,
          digest: r.digest,
        })),
        categories: categories.map((r) => r.expected),
        memberships,
        validUntil: new Date(validUntil),
        before: head
          ? { catalogId: head.catalog_id, headRevision: head.head_revision }
          : null,
      };
      totalCategories += categories.length;
      totalMemberships += memberships.length;
      if (
        totalCategories > RATING_SCOPED_RELEASE_CATEGORY_LIMIT ||
        totalMemberships > RATING_SCOPED_RELEASE_MEMBERSHIP_LIMIT
      )
        unavailable();
      budget.observeInput(input);
      inputs.push(input);
    }
    return inputs;
  }
  async requireCreationPolicy(scopeKey: string, tx: PoolClient) {
    const rows = (
      await tx.query<ScopedSourceRow>(
        `SELECT s.*,whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()) current FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision) WHERE s.source_kind='native_scoped_create' AND $1=ANY(s.scope_keys) LIMIT 2 FOR SHARE OF h,s`,
        [scopeKey],
      )
    ).rows;
    if (
      rows.length !== 1 ||
      !rows[0]!.current ||
      rows[0]!.payload['enabled'] !== true
    )
      unavailable();
    registerTransactionDeadline(
      tx,
      rows[0]!.valid_until.getTime(),
      'RATING_SCOPE_UNAVAILABLE',
    );
    return rows[0]!;
  }
  async requireLegacyWriteBridge(logicalScopeKey: string, tx: PoolClient) {
    const row = (
      await tx.query<ScopedSourceRow>(
        `SELECT s.*,whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()) current FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision) WHERE s.source_kind='native_v1_compat_write' AND s.source_key=$1 FOR SHARE OF h,s`,
        [logicalScopeKey],
      )
    ).rows[0];
    if (!row?.current || row.payload['enabled'] !== true) unavailable();
    registerTransactionDeadline(
      tx,
      row.valid_until.getTime(),
      'RATING_SCOPE_UNAVAILABLE',
    );
    return row;
  }
}
