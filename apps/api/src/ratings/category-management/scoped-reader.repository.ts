import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { RatingScopedCompilationBudget } from '../scoped/compiler.js';
import {
  RatingScopedSourceFacade,
  type ScopedSourceRow,
} from '../scoped/source.facade.js';
import { ratingScopedDigest } from '../scoped/protocol-registry.js';
import { ratingManagedCategorySchema } from './scoped-contracts.js';
import type {
  CategorySnapshot,
  ManagedCategoryRecord,
  ManagedTargetPlacement,
} from './plan.js';

@Injectable()
export class RatingCategoryManagementReader {
  constructor(
    @Inject(RatingScopedSourceFacade)
    private readonly reviewSources: RatingScopedSourceFacade,
  ) {}
  async snapshot(selected: string, tx: PoolClient): Promise<CategorySnapshot> {
    const admission = (
      await tx.query<{ count: string; bytes: string }>(
        `SELECT count(*)::text count,coalesce(sum(pg_column_size(s)),0)::text bytes FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)`,
      )
    ).rows[0]!;
    if (
      BigInt(admission.count) > 100000n ||
      BigInt(admission.bytes) > 67108864n
    )
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const budget = new RatingScopedCompilationBudget();
    const sources = (
      await tx.query<ScopedSourceRow>(
        `SELECT s.*,whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()) current FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision) ORDER BY s.source_kind COLLATE "C",s.source_key COLLATE "C" LIMIT 100001 FOR SHARE OF h,s`,
      )
    ).rows;
    budget.observe(sources);
    const selectedSources = sources.filter((s) =>
      s.scope_keys.includes(selected),
    );
    if (
      !selectedSources.length ||
      selectedSources.some((s) => !s.current) ||
      selectedSources.filter(
        (s) => s.source_kind === 'scope_absence' && s.source_key === selected,
      ).length !== 1
    )
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const heads = (
      await tx.query<{
        scopeKey: string;
        catalogRevision: string;
        headRevision: string;
      }>(
        `SELECT scope_key "scopeKey",catalog_id "catalogRevision",head_revision "headRevision" FROM whaleu_ratings.scoped_catalog_heads ORDER BY scope_key COLLATE "C" LIMIT 1002 FOR SHARE`,
      )
    ).rows;
    if (heads.length > 1001 || !heads.some((h) => h.scopeKey === selected))
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const rows = (
      await tx.query<ManagedCategoryRecord>(`SELECT h.scope_key "scopeKey",c.catalog_id "catalogId",c.effective_revision revision,l.proof expected,p.scope_keys "scopeKeys",p.source_id "placementSourceId",p.source_revision "placementSourceRevision",(whaleu_ratings.scoped_expected_category(l.placement_revision,h.scope_key)=l.proof) "bodyCurrent",whaleu_ratings.scoped_base_category(l.base_source_id,l.base_source_revision) "baseBody",whaleu_ratings.category_historical_metadata(l.base_source_id,l.base_source_revision) "baseMetadata"
   FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_categories c ON c.catalog_id=h.catalog_id JOIN whaleu_ratings.scoped_category_lineage l ON (l.catalog_id,l.category_id)=(c.catalog_id,c.category_id)
   JOIN whaleu_ratings.category_scope_placements p ON p.placement_revision=l.placement_revision ORDER BY h.scope_key COLLATE "C",c.ordinal LIMIT 100001`)
    ).rows;
    if (rows.length > 100000)
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    budget.observe(rows);
    const consumed = new Set([
      ...rows.flatMap((r) => [
        r.expected.baseSourceId,
        ...(r.expected.overrideSourceId ? [r.expected.overrideSourceId] : []),
      ]),
      ...sources
        .filter((s) => s.source_kind === 'scoped_category_override')
        .map((s) => s.id),
    ]);
    const blocked = await this.reviewSources.verifyReviews(
      sources.filter((s) => consumed.has(s.id)),
      tx,
      budget,
      false,
    );
    for (const row of rows)
      if (
        blocked.has(row.expected.baseSourceId) ||
        (row.expected.overrideSourceId &&
          blocked.has(row.expected.overrideSourceId))
      )
        row.bodyCurrent = false;
    const targets = (
      await tx.query<ManagedTargetPlacement>(
        `SELECT p.target_id "targetId",t.category_id "categoryId",p.scope_keys "scopeKeys",p.placement_revision "placementRevision" FROM whaleu_ratings.target_scope_placements p JOIN whaleu_ratings.targets t ON t.id=p.target_id WHERE whaleu_ratings.scoped_source_current(p.source_id,p.source_revision,clock_timestamp()) ORDER BY p.target_id LIMIT 100001`,
      )
    ).rows;
    if (targets.length > 100000)
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    budget.observe(targets);
    const compatHeads = (
      await tx.query<{ value: NonNullable<CategorySnapshot['compatHeads']> }>(
        `SELECT whaleu_ratings.category_management_compat_heads($1::text[]) value`,
        [heads.map((h) => h.scopeKey)],
      )
    ).rows[0]!.value;
    const vector = selectedSources.map((s) => ({
      id: s.id,
      revision: s.revision,
      kind: s.source_kind,
      key: s.source_key,
      digest: s.digest,
    }));
    const upcoming = (
      await tx.query<{ at: Date | null }>(
        `SELECT min(effective_at) at FROM whaleu_ratings.scoped_source_attestations WHERE effective_at>clock_timestamp()`,
      )
    ).rows[0]?.at;
    const validUntil = Math.min(
      ...selectedSources.map((s) => s.valid_until.getTime()),
      upcoming?.getTime() ?? Infinity,
    );
    registerTransactionDeadline(tx, validUntil, 'RATING_SCOPE_UNAVAILABLE');
    const selectedHeads = heads.filter((h) => h.scopeKey === selected),
      sourceDigest = ratingScopedDigest('vector', vector);
    return {
      sources,
      categories: rows,
      targets,
      heads,
      compatHeads,
      sourceDigest,
      snapshotRevision: ratingScopedDigest('category-snapshot', {
        heads: selectedHeads,
        vector,
      }),
      validUntil,
      reviewBlockedSourceIds: [...blocked],
    };
  }
  view(row: ManagedCategoryRecord, snapshot: CategorySnapshot) {
    const byId = new Map(snapshot.sources.map((s) => [s.id, s]));
    const b = row.expected.body,
      life = byId.get(row.expected.lifecycleSourceId ?? ''),
      over = byId.get(row.expected.overrideSourceId ?? '');
    let known = !!row.baseBody && row.bodyCurrent;
    let parent = row.expected.body.parentId;
    let depth = 0;
    while (parent) {
      const ancestor = snapshot.categories.find(
        (r) => r.scopeKey === row.scopeKey && r.expected.body.id === parent,
      );
      if (
        !ancestor ||
        !ancestor.baseBody ||
        !ancestor.bodyCurrent ||
        ++depth > 2
      ) {
        known = false;
        break;
      }
      parent = ancestor.expected.body.parentId;
    }
    const modes =
      over?.payload['modes'] ??
      (over
        ? {
            name: { mode: 'set', value: b.name },
            description: { mode: 'set', value: b.description },
          }
        : { name: { mode: 'inherit' }, description: { mode: 'inherit' } });
    return ratingManagedCategorySchema.parse({
      id: b.id,
      parentId: b.parentId,
      level: b.level,
      kind: b.kind,
      systemKey: b.systemKey,
      name: known ? b.name : null,
      description: known ? b.description : null,
      revision: row.revision,
      baseRevision: row.expected.baseSourceRevision,
      placementRevision: row.expected.placementRevision,
      lifecycleRevision: row.expected.lifecycleSourceRevision,
      overrideRevision: row.expected.overrideSourceRevision,
      orderRevision: row.expected.orderSourceRevision,
      ordinal: b.ordinal,
      businessState:
        life?.payload['businessState'] ?? (b.active ? 'enabled' : 'disabled'),
      hidden: b.hidden,
      scopeKeys: row.scopeKeys,
      baseName: known ? (row.baseBody?.name ?? null) : null,
      baseDescription: known ? (row.baseBody?.description ?? null) : null,
      override: known
        ? modes
        : { name: { mode: 'inherit' }, description: { mode: 'inherit' } },
      blockedReason: known ? null : 'CONTENT_REVIEW_UNAVAILABLE',
    });
  }
}
