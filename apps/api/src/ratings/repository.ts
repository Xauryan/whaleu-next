import { Inject, Injectable } from '@nestjs/common';
import { RatingCategoryContentReviewFacade } from '../community/content-review/rating-category-content-review.facade.js';
import { canonicalRatingCategoryBase } from '../community/content-review/rating-category-contracts.js';
import type { RatingCategoryBaseDescriptor } from '../community/content-review/rating-category-contracts.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { boundedOwnerProof } from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { ratingSummarySchema } from './contracts.js';
import type { RatingSummary, SetRatingScore } from './contracts.js';
import {
  currentRatingTargetRow,
  ratingCurrentTargetColumns,
  ratingCurrentTargetDefinitionJoins,
} from './target-definition.repository.js';
import type {
  CurrentTargetRead,
  CurrentTargetRow,
  TargetCreationRow,
} from './target-definition.repository.js';
export type {
  CurrentTargetRow,
  TargetCreationRow,
} from './target-definition.repository.js';
export const ratingIso = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export interface RatingCatalog {
  id: string;
  regionId: string | null;
}
export interface CategoryRow {
  id: string;
  parent_id: string | null;
  level: 1 | 2 | 3;
  kind: string;
  system_key: string | null;
  name: string;
  description: string;
  revision: string;
  ordinal: string;
  active: boolean;
  hidden: boolean;
}
interface CategorySourceRead {
  ordinal: number;
  lineage: {
    source_kind: string;
    effective_revision: string;
    base_revision: string | null;
    scope_version_id: string | null;
    topology_snapshot_id: string | null;
  } | null;
  base: {
    category_id: string;
    revision: string;
    parent_id: string | null;
    level: number;
    name: string;
    description: string;
    active: boolean;
    is_global: boolean;
    scope_version_id: string;
    release_id: string;
    envelope: unknown;
  } | null;
  head_revision: string | null;
  source_scope: {
    id: string;
    region_id: string | null;
    campus_ids: string[];
    topology_snapshot_id: string;
    release_id: string;
  } | null;
}
/** The caller owns current-catalog and Ratings epoch proof. Opaque legacy rows
 * retain only their frozen v1 contract. Every native row requires exact source
 * lineage and current Review, including every ancestor supplied by the caller. */
export async function qualifyRatingCategoryRows(
  review: RatingCategoryContentReviewFacade,
  catalog: RatingCatalog,
  categories: readonly CategoryRow[],
  tx: PoolClient,
): Promise<readonly ('allow' | 'deny')[]> {
  if (!categories.length) return Object.freeze([]);
  if (categories.length > 512) throw new ApplicationError('RATING_UNAVAILABLE');
  const rows = (
    await tx.query<CategorySourceRead>(
      `SELECT w.ordinal::integer ordinal,to_jsonb(l) lineage,to_jsonb(b) base,h.revision head_revision,to_jsonb(s) source_scope
    FROM unnest($2::uuid[]) WITH ORDINALITY w(id,ordinal)
    LEFT JOIN whaleu_ratings.catalog_category_lineage l ON l.catalog_id=$1 AND l.category_id=w.id
    LEFT JOIN whaleu_ratings.category_base_versions b ON b.category_id=l.category_id AND b.revision=l.base_revision
    LEFT JOIN whaleu_ratings.category_base_heads h ON h.category_id=b.category_id
    LEFT JOIN whaleu_ratings.category_scope_versions s ON s.id=b.scope_version_id ORDER BY w.ordinal`,
      [catalog.id, categories.map((row) => row.id)],
    )
  ).rows;
  if (rows.length !== categories.length)
    throw new ApplicationError('RATING_UNAVAILABLE');
  const native: { index: number; descriptor: RatingCategoryBaseDescriptor }[] =
    [];
  for (const [index, source] of rows.entries()) {
    const category = categories[index]!,
      lineage = source.lineage;
    if (
      source.ordinal !== index + 1 ||
      !lineage ||
      lineage.effective_revision !== category.revision
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    if (lineage.source_kind === 'opaque') {
      if (
        lineage.base_revision !== null ||
        lineage.scope_version_id !== null ||
        lineage.topology_snapshot_id !== null ||
        source.base !== null ||
        source.head_revision !== null ||
        source.source_scope !== null
      )
        throw new ApplicationError('RATING_UNAVAILABLE');
      continue;
    }
    const base = source.base,
      scope = source.source_scope;
    if (
      lineage.source_kind !== 'native' ||
      !base ||
      !scope ||
      source.head_revision !== base.revision ||
      base.category_id !== category.id ||
      base.revision !== category.revision ||
      lineage.base_revision !== base.revision ||
      lineage.scope_version_id !== base.scope_version_id ||
      scope.id !== base.scope_version_id ||
      lineage.topology_snapshot_id !== scope.topology_snapshot_id ||
      scope.release_id !== base.release_id ||
      base.parent_id !== category.parent_id ||
      base.level !== category.level ||
      base.name !== category.name ||
      base.description !== category.description ||
      base.active !== category.active ||
      category.kind !== 'general' ||
      category.system_key !== null ||
      base.is_global !== (scope.region_id === null) ||
      (scope.region_id !== null && scope.region_id !== catalog.regionId)
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    let descriptor: RatingCategoryBaseDescriptor;
    try {
      descriptor = canonicalRatingCategoryBase({
        categoryId: category.id,
        baseRevision: base.revision,
        envelope: base.envelope as RatingCategoryBaseDescriptor['envelope'],
      });
    } catch {
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }
    const envelope = descriptor.envelope,
      node = envelope.categories.find((value) => value.id === category.id)!;
    if (
      envelope.releaseId !== base.release_id ||
      envelope.scope.regionId !== scope.region_id ||
      envelope.scope.topologySnapshotId !== scope.topology_snapshot_id ||
      JSON.stringify(envelope.scope.campusIds) !==
        JSON.stringify(scope.campus_ids) ||
      !envelope.catalogs.some((item) => item.regionId === catalog.regionId) ||
      node.scopeVersionId !== scope.id ||
      node.parentId !== category.parent_id ||
      node.level !== category.level ||
      node.name !== category.name ||
      node.description !== category.description
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    native.push({ index, descriptor });
  }
  const decisions = await review.currentBatch(
    native.map((value) => value.descriptor),
    tx,
  );
  if (decisions.length !== native.length)
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  const result: ('allow' | 'deny')[] = categories.map(() => 'allow');
  for (const [index, decision] of decisions.entries()) {
    if (decision.kind === 'unavailable')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    result[native[index]!.index] = decision.kind;
  }
  return Object.freeze(result);
}
/** @deprecated Raw v1 creation data only; public reads use CurrentTargetRow. */
export type TargetRow = TargetCreationRow;
export interface CommentRow {
  id: string;
  target_id: string;
  account_id: string;
  author_mode: 'named' | 'anonymous';
  persona_id: string | null;
  body: string;
  revision: string;
  envelope: unknown;
  ordinal: string;
  created_at: string;
  deleted_at: string | null;
  persona_name: string | null;
}
type Fact =
  | { kind: 'epoch'; value: string }
  | { kind: 'catalog'; id: string; regionId: string | null }
  | {
      kind: 'target';
      id: string;
      revision: string;
      contentVersion: number;
      definitionRevision: string;
      appliedTargetRevision: string;
    }
  | { kind: 'comment'; id: string; revision: string; deleted: boolean }
  | { kind: 'reply'; id: string; revision: string; deleted: boolean };
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 161,
  failureCode: 'RATING_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_UNAVAILABLE', async (read) => {
      // Rows are already locked and catalog definitions sealed. Bounded
      // indexed typed set queries, no final blocking lock or unbounded history scan.
      const expectedEpochs = facts.filter(
        (f): f is Extract<Fact, { kind: 'epoch' }> => f.kind === 'epoch',
      );
      if (expectedEpochs.length) {
        await read.query(
          'LOCK TABLE whaleu_ratings.navigation_epoch IN SHARE MODE NOWAIT',
        );
        const value = (
          await read.query<{ epoch: string }>(
            'SELECT epoch::text FROM whaleu_ratings.navigation_epoch WHERE singleton AND version=1',
          )
        ).rows[0]?.epoch;
        if (!value || expectedEpochs.some((f) => f.value !== value))
          throw new ApplicationError('RATING_UNAVAILABLE');
      }
      const catalogs = facts.filter(
          (f): f is Extract<Fact, { kind: 'catalog' }> => f.kind === 'catalog',
        ),
        targets = facts.filter(
          (f): f is Extract<Fact, { kind: 'target' }> => f.kind === 'target',
        ),
        comments = facts.filter(
          (f): f is Extract<Fact, { kind: 'comment' }> => f.kind === 'comment',
        );
      const check = async (sql: string, values: unknown[], n: number) => {
        if (!n) return;
        if ((await read.query<{ n: number }>(sql, values)).rows[0]?.n !== n)
          throw new ApplicationError('RATING_UNAVAILABLE');
      };
      await check(
        `SELECT count(*)::integer n FROM unnest($1::uuid[],$2::uuid[]) f(id,region_id) JOIN whaleu_ratings.catalog_heads h ON h.scope_key=coalesce(f.region_id::text,'global') AND h.catalog_id=f.id JOIN whaleu_ratings.catalogs c ON c.id=f.id AND c.region_id IS NOT DISTINCT FROM f.region_id WHERE whaleu_ratings.category_catalog_compat_current(c.id) AND c.sealed AND c.coverage='complete' AND c.provenance='accepted' AND c.effective_at<=clock_timestamp() AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp())`,
        [catalogs.map((f) => f.id), catalogs.map((f) => f.regionId)],
        catalogs.length,
      );
      await check(
        `SELECT count(*)::integer n FROM unnest($1::uuid[],$2::uuid[],$3::integer[],$4::uuid[],$5::uuid[])
         f(id,revision,content_version,definition_revision,applied_target_revision)
         JOIN whaleu_ratings.targets t ON t.id=f.id AND t.revision=f.revision AND t.active
         JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id
           AND h.content_version=f.content_version AND h.definition_revision=f.definition_revision
         JOIN whaleu_ratings.target_definition_versions d ON d.target_id=h.target_id
           AND d.content_version=h.content_version AND d.definition_revision=h.definition_revision
           AND d.applied_target_revision=f.applied_target_revision
         JOIN whaleu_ratings.target_definition_lifecycles l ON l.target_id=t.id
           AND l.target_revision=t.revision AND l.content_version=h.content_version
           AND l.definition_revision=h.definition_revision
         WHERE NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones tombstone WHERE tombstone.target_id=t.id)`,
        [
          targets.map((f) => f.id),
          targets.map((f) => f.revision),
          targets.map((f) => f.contentVersion),
          targets.map((f) => f.definitionRevision),
          targets.map((f) => f.appliedTargetRevision),
        ],
        targets.length,
      );
      await check(
        `SELECT count(*)::integer n FROM unnest($1::uuid[],$2::uuid[],$3::boolean[]) f(id,revision,deleted) JOIN whaleu_ratings.comments c ON c.id=f.id AND c.revision=f.revision AND (c.deleted_at IS NOT NULL)=f.deleted`,
        [
          comments.map((f) => f.id),
          comments.map((f) => f.revision),
          comments.map((f) => f.deleted),
        ],
        comments.length,
      );
      const replies = facts.filter(
        (f): f is Extract<Fact, { kind: 'reply' }> => f.kind === 'reply',
      );
      await check(
        `SELECT count(*)::integer n FROM unnest($1::uuid[],$2::uuid[],$3::boolean[]) f(id,revision,deleted) JOIN whaleu_ratings.replies r ON r.id=f.id AND r.revision=f.revision AND (r.deleted_at IS NOT NULL)=f.deleted`,
        [
          replies.map((f) => f.id),
          replies.map((f) => f.revision),
          replies.map((f) => f.deleted),
        ],
        replies.length,
      );
    }),
};
@Injectable()
export class RatingsRepository {
  constructor(
    @Inject(RatingCategoryContentReviewFacade)
    private readonly categoryReview: RatingCategoryContentReviewFacade = new RatingCategoryContentReviewFacade(),
  ) {}
  enable(tx: PoolClient) {
    enableRequiredTransactionProof(tx, proof);
  }
  async navigation(tx: PoolClient) {
    const row = (
      await tx.query<{ epoch: string }>(
        'SELECT epoch::text FROM whaleu_ratings.navigation_epoch WHERE singleton AND version=1',
      )
    ).rows[0];
    if (!row || !/^(0|[1-9][0-9]*)$/.test(row.epoch))
      throw new ApplicationError('RATING_UNAVAILABLE');
    registerRequiredTransactionFact(tx, proof, `epoch:${row.epoch}`, {
      kind: 'epoch',
      value: row.epoch,
    });
    return row.epoch;
  }
  async catalog(
    regionId: string | null,
    tx: PoolClient,
  ): Promise<RatingCatalog> {
    const row = (
      await tx
        .query<{ id: string; valid_until: Date | null }>(
          `SELECT c.id,least(c.valid_until,whaleu_ratings.category_catalog_compat_until(c.id)) valid_until FROM whaleu_ratings.catalog_heads h JOIN whaleu_ratings.catalogs c ON c.id=h.catalog_id WHERE h.scope_key=coalesce($1::uuid::text,'global') AND c.region_id IS NOT DISTINCT FROM $1::uuid FOR SHARE OF h,c`,
          [regionId],
        )
        .catch((error: unknown) => {
          // The narrow SQL helper raises on missing/expired native topology;
          // it must not become a successful null policy-exempt deadline.
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '23514'
          )
            throw new ApplicationError('RATING_UNAVAILABLE');
          throw error;
        })
    ).rows[0];
    if (
      !row ||
      !(
        await tx.query(
          `SELECT 1 FROM whaleu_ratings.catalogs WHERE id=$1 AND whaleu_ratings.category_catalog_compat_current(id) AND sealed AND coverage='complete' AND provenance='accepted' AND effective_at<=clock_timestamp() AND (valid_until IS NULL OR valid_until>clock_timestamp())`,
          [row.id],
        )
      ).rows[0]
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      row.valid_until?.getTime() ?? null,
      'RATING_UNAVAILABLE',
    );
    registerRequiredTransactionFact(tx, proof, `catalog:${row.id}`, {
      kind: 'catalog',
      id: row.id,
      regionId,
    });
    return { id: row.id, regionId };
  }
  async category(
    catalog: RatingCatalog,
    id: string,
    tx: PoolClient,
  ): Promise<CategoryRow> {
    await this.navigation(tx);
    return this.categoryForMutation(catalog, id, tx);
  }
  /** Writer snapshot: identical ancestry/source/Review qualification, without
   * retaining a pre-mutation navigation epoch. The writer must retain its exact
   * final catalog/target tuple and after-state epoch proof. */
  async categoryForMutation(
    catalog: RatingCatalog,
    id: string,
    tx: PoolClient,
  ): Promise<CategoryRow> {
    const rows = (
      await tx.query<CategoryRow>(
        `WITH RECURSIVE path AS (SELECT c.*,1 depth FROM whaleu_ratings.categories c WHERE catalog_id=$1 AND id=$2 UNION ALL SELECT c.*,p.depth+1 FROM whaleu_ratings.categories c JOIN path p ON c.catalog_id=p.catalog_id AND c.id=p.parent_id WHERE p.depth<3) SELECT c.*,c.ordinal::text FROM whaleu_ratings.categories c JOIN path p ON p.catalog_id=c.catalog_id AND p.id=c.id ORDER BY c.level FOR SHARE OF c`,
        [catalog.id, id],
      )
    ).rows;
    const leaf = rows.at(-1);
    if (
      !leaf ||
      leaf.id !== id ||
      rows.length !== leaf.level ||
      rows.some(
        (r, i) =>
          !r.active ||
          r.hidden ||
          r.level !== i + 1 ||
          (i === 0 ? r.parent_id !== null : r.parent_id !== rows[i - 1]!.id),
      )
    )
      throw new ApplicationError('RATING_NOT_FOUND');
    if (
      (
        await qualifyRatingCategoryRows(this.categoryReview, catalog, rows, tx)
      ).some((decision) => decision === 'deny')
    )
      throw new ApplicationError('RATING_NOT_FOUND');
    return leaf;
  }
  async categories(
    catalog: RatingCatalog,
    parentId: string | null,
    after: string | null,
    limit: number,
    tx: PoolClient,
  ): Promise<CategoryRow[]> {
    await this.navigation(tx);
    if (parentId) await this.category(catalog, parentId, tx);
    const allowed: CategoryRow[] = [];
    let cursor = after,
      scanned = 0;
    while (allowed.length < limit + 1) {
      const rows = (
        await tx.query<CategoryRow>(
          `SELECT c.*,c.ordinal::text FROM whaleu_ratings.categories c WHERE c.catalog_id=$1 AND c.parent_id IS NOT DISTINCT FROM $2::uuid AND c.active AND NOT c.hidden AND ($3::bigint IS NULL OR c.ordinal>$3::bigint) ORDER BY c.ordinal LIMIT $4 FOR SHARE OF c`,
          [catalog.id, parentId, cursor, 128],
        )
      ).rows;
      scanned += rows.length;
      if (scanned > 10000) throw new ApplicationError('RATING_UNAVAILABLE');
      const decisions = await qualifyRatingCategoryRows(
        this.categoryReview,
        catalog,
        rows,
        tx,
      );
      rows.forEach((row, index) => {
        if (decisions[index] === 'allow') allowed.push(row);
      });
      if (rows.length < 128) break;
      const next = rows.at(-1)!.ordinal;
      if (cursor !== null && BigInt(next) <= BigInt(cursor))
        throw new ApplicationError('RATING_UNAVAILABLE');
      cursor = next;
    }
    return allowed.slice(0, limit + 1);
  }
  async target(
    catalog: RatingCatalog,
    id: string,
    tx: PoolClient,
    write = false,
  ): Promise<{ row: CurrentTargetRow; category: CategoryRow }> {
    // Retain absence/denial as well as successful reads, including head changes.
    await this.navigation(tx);
    const link = (
      await tx.query<{ category_id: string }>(
        'SELECT category_id FROM whaleu_ratings.target_memberships WHERE catalog_id=$1 AND target_id=$2',
        [catalog.id, id],
      )
    ).rows[0];
    if (!link) throw new ApplicationError('RATING_NOT_FOUND');
    const category = await this.category(catalog, link.category_id, tx),
      current = (
        await tx.query<CurrentTargetRead>(
          `SELECT ${ratingCurrentTargetColumns} FROM whaleu_ratings.targets t
           ${ratingCurrentTargetDefinitionJoins}
           WHERE t.id=$1 FOR ${write ? 'UPDATE' : 'SHARE'} OF t`,
          [id],
        )
      ).rows[0];
    if (
      !current?.active ||
      current.owner_deleted === true ||
      current.category_id !== category.id ||
      (current.region_id !== null && current.region_id !== catalog.regionId)
    )
      throw new ApplicationError('RATING_NOT_FOUND');
    const row = currentRatingTargetRow(current);
    registerRequiredTransactionFact(
      tx,
      proof,
      `target:${id}:${row.revision}:${row.definition.contentVersion}:${row.definition.definitionRevision}:${row.definition.appliedTargetRevision}`,
      {
        kind: 'target',
        id,
        revision: row.revision,
        contentVersion: row.definition.contentVersion,
        definitionRevision: row.definition.definitionRevision,
        appliedTargetRevision: row.definition.appliedTargetRevision,
      },
    );
    return { row, category };
  }
  async targets(
    catalog: RatingCatalog,
    categoryId: string,
    after: string | null,
    limit: number,
    tx: PoolClient,
  ) {
    await this.navigation(tx);
    await this.category(catalog, categoryId, tx);
    return (
      await tx.query<{ id: string; ordinal: string }>(
        `SELECT m.target_id id,m.ordinal::text FROM whaleu_ratings.target_memberships m JOIN whaleu_ratings.targets t ON t.id=m.target_id WHERE m.catalog_id=$1 AND m.category_id=$2 AND t.active AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones tombstone WHERE tombstone.target_id=t.id) AND ($3::bigint IS NULL OR m.ordinal>$3::bigint) ORDER BY m.ordinal LIMIT $4`,
        [catalog.id, categoryId, after, limit + 1],
      )
    ).rows;
  }
  async summary(targetId: string, tx: PoolClient): Promise<RatingSummary> {
    const row = (
      await tx.query<{
        revision: string;
        count: string;
        sum: string;
        b1: string;
        b2: string;
        b3: string;
        b4: string;
        b5: string;
      }>(
        `SELECT s.* FROM whaleu_ratings.score_summaries s JOIN whaleu_ratings.score_baselines b ON b.target_id=s.target_id JOIN whaleu_ratings.target_sources o ON o.id=b.source_id AND o.target_id=b.target_id JOIN whaleu_ratings.target_creations c ON c.target_id=b.target_id WHERE s.target_id=$1 AND b.kind='fresh_zero' AND o.origin='new_native' AND o.coverage='complete' AND o.provenance='accepted' AND o.effective_at<=clock_timestamp() AND b.creation_transaction=c.creation_transaction AND c.source_id=o.id FOR SHARE OF s,b,o,c`,
        [targetId],
      )
    ).rows[0];
    if (!row) return { status: 'unavailable' };
    const count = Number(row.count),
      sum = Number(row.sum);
    return ratingSummarySchema.parse({
      status: 'known',
      count,
      sum,
      average: count === 0 ? null : Math.round((sum * 10) / count) / 10,
      distribution: {
        '1': Number(row.b1),
        '2': Number(row.b2),
        '3': Number(row.b3),
        '4': Number(row.b4),
        '5': Number(row.b5),
      },
      revision: row.revision,
    });
  }
  async myScore(targetId: string, actor: string, tx: PoolClient) {
    if ((await this.summary(targetId, tx)).status !== 'known')
      throw new ApplicationError('RATING_SCORE_UNAVAILABLE');
    return {
      myScore:
        (
          await tx.query<{ score: number; revision: string }>(
            'SELECT score,revision FROM whaleu_ratings.scores WHERE target_id=$1 AND account_id=$2 FOR SHARE',
            [targetId, actor],
          )
        ).rows[0] ?? null,
    };
  }
  async setScore(
    targetId: string,
    actor: string,
    command: SetRatingScore,
    tx: PoolClient,
  ) {
    if ((await this.summary(targetId, tx)).status !== 'known')
      throw new ApplicationError('RATING_SCORE_UNAVAILABLE');
    const existing = (
      await tx.query<{ score: number; revision: string; occurred_at: string }>(
        `SELECT score,revision,${ratingIso('updated_at')} occurred_at FROM whaleu_ratings.scores WHERE target_id=$1 AND account_id=$2 FOR UPDATE`,
        [targetId, actor],
      )
    ).rows[0];
    if ((existing?.revision ?? null) !== command.expectedRevision)
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    if (existing?.score === command.score)
      return {
        outcome: 'noop' as const,
        targetId,
        subjectId: targetId,
        revision: existing.revision,
        occurredAt: existing.occurred_at,
      };
    const revision = randomUUID(),
      sql = existing
        ? `UPDATE whaleu_ratings.scores SET score=$3,revision=$4,request_id=$5 WHERE target_id=$1 AND account_id=$2 RETURNING ${ratingIso('updated_at')} occurred_at`
        : `INSERT INTO whaleu_ratings.scores(target_id,account_id,score,revision,request_id) VALUES($1,$2,$3,$4,$5) RETURNING ${ratingIso('updated_at')} occurred_at`;
    const row = (
      await tx.query<{ occurred_at: string }>(sql, [
        targetId,
        actor,
        command.score,
        revision,
        command.clientRequestId,
      ])
    ).rows[0]!;
    return {
      outcome: 'applied' as const,
      targetId,
      subjectId: targetId,
      revision,
      occurredAt: row.occurred_at,
    };
  }
  async comments(
    targetId: string,
    after: string | null,
    limit: number,
    tx: PoolClient,
  ) {
    return (
      await tx.query<{ id: string; ordinal: string }>(
        `SELECT c.id,c.ordinal::text FROM whaleu_ratings.comments c WHERE target_id=$1 AND deleted_at IS NULL AND ($2::bigint IS NULL OR ordinal<$2::bigint) ORDER BY c.ordinal DESC LIMIT $3`,
        [targetId, after, limit + 1],
      )
    ).rows;
  }
  async commentTarget(id: string, tx: PoolClient) {
    const row = (
      await tx.query<{ target_id: string }>(
        'SELECT target_id FROM whaleu_ratings.comments WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('RATING_NOT_FOUND');
    return row.target_id;
  }
  async comment(
    id: string,
    targetId: string,
    tx: PoolClient,
    write = false,
    includeDeleted = false,
  ): Promise<CommentRow> {
    const row = (
      await tx.query<CommentRow>(
        `SELECT c.*,c.ordinal::text,${ratingIso('c.created_at')} created_at,${ratingIso('c.deleted_at')} deleted_at,p.display_name persona_name FROM whaleu_ratings.comments c LEFT JOIN whaleu_ratings.personas p ON p.target_id=c.target_id AND p.account_id=c.account_id AND p.public_id=c.persona_id WHERE c.id=$1 AND c.target_id=$2 FOR ${write ? 'UPDATE' : 'SHARE'} OF c`,
        [id, targetId],
      )
    ).rows[0];
    if (!row || (!includeDeleted && row.deleted_at !== null))
      throw new ApplicationError('RATING_NOT_FOUND');
    if (!write) this.retainComment(row, tx);
    return row;
  }
  retainComment(
    row: Pick<CommentRow, 'id' | 'revision' | 'deleted_at'>,
    tx: PoolClient,
  ) {
    registerRequiredTransactionFact(
      tx,
      proof,
      `comment:${row.id}:${row.revision}`,
      {
        kind: 'comment',
        id: row.id,
        revision: row.revision,
        deleted: row.deleted_at !== null,
      },
    );
  }
  retainReply(
    row: Pick<CommentRow, 'id' | 'revision' | 'deleted_at'>,
    tx: PoolClient,
  ) {
    registerRequiredTransactionFact(
      tx,
      proof,
      `reply:${row.id}:${row.revision}`,
      {
        kind: 'reply',
        id: row.id,
        revision: row.revision,
        deleted: row.deleted_at !== null,
      },
    );
  }
  async persona(targetId: string, actor: string, tx: PoolClient) {
    const id = randomUUID();
    await tx.query(
      'INSERT INTO whaleu_ratings.personas(target_id,account_id,public_id,display_name) VALUES($1,$2,$3,$4) ON CONFLICT(target_id,account_id) DO NOTHING',
      [targetId, actor, id, `分身${id.slice(0, 8)}`],
    );
    return (
      await tx.query<{ public_id: string; display_name: string }>(
        'SELECT public_id,display_name FROM whaleu_ratings.personas WHERE target_id=$1 AND account_id=$2 FOR SHARE',
        [targetId, actor],
      )
    ).rows[0]!;
  }
  async insertComment(
    input: {
      id: string;
      targetId: string;
      actor: string;
      authorMode: 'named' | 'anonymous';
      personaId: string | null;
      body: string;
      revision: string;
      requestId: string;
      envelope: unknown;
    },
    tx: PoolClient,
  ) {
    const row = (
      await tx.query<{ created_at: string }>(
        `INSERT INTO whaleu_ratings.comments(id,target_id,account_id,author_mode,persona_id,body,revision,request_id,envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING ${ratingIso('created_at')} created_at`,
        [
          input.id,
          input.targetId,
          input.actor,
          input.authorMode,
          input.personaId,
          input.body,
          input.revision,
          input.requestId,
          JSON.stringify(input.envelope),
        ],
      )
    ).rows[0]!;
    this.retainComment(
      { id: input.id, revision: input.revision, deleted_at: null },
      tx,
    );
    return {
      outcome: 'applied' as const,
      targetId: input.targetId,
      subjectId: input.id,
      revision: input.revision,
      occurredAt: row.created_at,
    };
  }
  async deleteComment(
    row: Pick<
      CommentRow,
      'id' | 'target_id' | 'account_id' | 'revision' | 'deleted_at'
    >,
    actor: string,
    requestId: string,
    expectedRevision: string,
    tx: PoolClient,
  ) {
    if (row.account_id !== actor)
      throw new ApplicationError('RATING_NOT_FOUND');
    if (row.revision !== expectedRevision)
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    if (row.deleted_at !== null) {
      this.retainComment(row, tx);
      return {
        outcome: 'noop' as const,
        targetId: row.target_id,
        subjectId: row.id,
        revision: row.revision,
        occurredAt: row.deleted_at,
      };
    }
    const revision = randomUUID(),
      deleted = (
        await tx.query<{ deleted_at: string }>(
          `UPDATE whaleu_ratings.comments SET deleted_at=clock_timestamp(),delete_request_id=$2,revision=$3 WHERE id=$1 RETURNING ${ratingIso('deleted_at')} deleted_at`,
          [row.id, requestId, revision],
        )
      ).rows[0]!;
    this.retainComment(
      { id: row.id, revision, deleted_at: deleted.deleted_at },
      tx,
    );
    return {
      outcome: 'applied' as const,
      targetId: row.target_id,
      subjectId: row.id,
      revision,
      occurredAt: deleted.deleted_at,
    };
  }
}
