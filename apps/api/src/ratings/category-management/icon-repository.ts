import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import { RatingScopedCompilationBudget } from '../scoped/compiler.js';
import { categoryIconDigest } from './icon-extension.js';
import {
  validateCategoryIconRoots,
  type CategoryIconRoot,
} from './icon-references.js';
import type { CategoryIconPlan } from './icon-plan.js';

export const categoryIconRootKey = (root: CategoryIconRoot): string =>
  canonicalJson([
    root.kind,
    root.categoryId,
    root.kind === 'base' ? root.source : root.baseSource,
    root.kind === 'override' ? root.campusId : null,
  ]);
export function categoryIconDefinitionBody(root: CategoryIconRoot) {
  const { scopeKeys: _scopeKeys, retention: _retention, ...body } = root;
  void _scopeKeys;
  void _retention;
  return body;
}
const unavailable = (): never => {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
};
interface RootRow {
  root_key: string;
  root: CategoryIconRoot;
  definition_digest: string;
  retired: boolean;
}
/** This repository reads the complete recoverable closure, including dormant
 * and archived roots. It never substitutes an appearance found by category ID. */
@Injectable()
export class RatingCategoryIconRepository {
  async roots(
    tx: PoolClient,
    budget: RatingScopedCompilationBudget,
  ): Promise<readonly CategoryIconRoot[]> {
    const locks = (
      await tx.query(
        `SELECT root_key FROM whaleu_ratings.category_icon_definition_heads ORDER BY root_key LIMIT 100001 FOR SHARE`,
      )
    ).rows;
    budget.observe({ categoryIconRootLocks: locks });
    if (locks.length > 100000) unavailable();
    const rows = (
      await tx.query<RootRow>(`SELECT whaleu_ratings.category_icon_root_key(root) root_key,root,
      coalesce(d.definition_digest,whaleu_ratings.category_icon_digest('definition',whaleu_ratings.category_icon_root_body(root))) definition_digest,
      EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_terminal_retirements t WHERE t.appearance_id=(root->'value'->'appearance'->>'appearanceId')::uuid) retired
      FROM jsonb_array_elements(whaleu_ratings.category_icon_complete_roots()) root
      LEFT JOIN whaleu_ratings.category_icon_definitions d ON d.id=(root->>'definitionId')::uuid
      ORDER BY whaleu_ratings.category_icon_root_key(root) LIMIT 100001`)
    ).rows;
    budget.observe({ categoryIconRootRows: rows });
    if (rows.length > 100000) unavailable();
    const roots = validateCategoryIconRoots(
      rows.map((row) => row.root),
      budget,
    );
    rows.forEach((row, index) => {
      const root = roots[index]!;
      if (
        row.retired ||
        row.root_key !== categoryIconRootKey(root) ||
        row.definition_digest !==
          categoryIconDigest('definition', categoryIconDefinitionBody(root))
      )
        unavailable();
    });
    return roots;
  }
  /** Caller holds the original all-scope management locks and Category epoch.
   * SQL reverse guards independently verify every row against the outer cause. */
  async applyRoots(plan: CategoryIconPlan, tx: PoolClient): Promise<void> {
    const previous = new Map(
      plan.beforeRoots.map((root) => [root.definitionId, root]),
    );
    const nextKeys = new Set(plan.afterRoots.map(categoryIconRootKey));
    const persisted = new Set(
      (
        await tx.query<{ id: string }>(
          `SELECT id FROM whaleu_ratings.category_icon_definitions WHERE id=ANY($1::uuid[])`,
          [
            [...plan.beforeRoots, ...plan.afterRoots].map(
              (root) => root.definitionId,
            ),
          ],
        )
      ).rows.map((row) => row.id),
    );
    for (const root of plan.afterRoots) {
      if (
        root.value.kind === 'unresolved' &&
        previous.has(root.definitionId) &&
        canonicalJson(root) === canonicalJson(previous.get(root.definitionId))
      )
        continue;
      const before = previous.get(root.definitionId);
      if (
        before &&
        canonicalJson(before) === canonicalJson(root) &&
        (persisted.has(root.definitionId) ||
          !root.scopeKeys.some((key) => plan.affectedScopeKeys.includes(key)))
      )
        continue;
      if (!persisted.has(root.definitionId)) {
        const base = root.kind === 'base' ? root.source : root.baseSource;
        const text = root.source;
        const predecessors = plan.beforeRoots
          .filter(
            (before) =>
              before.categoryId === root.categoryId &&
              before.kind === root.kind &&
              (root.kind === 'base' ||
                (before.kind === 'override' &&
                  before.campusId === root.campusId)),
          )
          .map((before) => before.definitionId)
          .filter((id) => id !== root.definitionId)
          .sort();
        await tx.query(
          `INSERT INTO whaleu_ratings.category_icon_definitions
          (id,category_id,identity_id,kind,campus_id,base_source_id,base_source_revision,text_source_id,text_source_revision,
           value,appearance_id,predecessors,definition_digest,actor_id,request_id,intent_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::uuid[],$13,$14,$15,$16)`,
          [
            root.definitionId,
            root.categoryId,
            root.identityId,
            root.kind,
            root.kind === 'base' ? null : root.campusId,
            base.id,
            base.revision,
            text?.id ?? null,
            text?.revision ?? null,
            canonicalJson(root.value),
            root.value.kind === 'image'
              ? root.value.appearance.appearanceId
              : null,
            predecessors,
            categoryIconDigest('definition', categoryIconDefinitionBody(root)),
            plan.accountId,
            plan.requestId,
            plan.outerHash,
          ],
        );
      } else if (
        canonicalJson(
          categoryIconDefinitionBody(previous.get(root.definitionId)!),
        ) !== canonicalJson(categoryIconDefinitionBody(root))
      )
        unavailable();
      await tx.query(
        `INSERT INTO whaleu_ratings.category_icon_definition_heads(root_key,definition_id,scope_keys,retention)
        VALUES($1,$2,$3::text[],$4) ON CONFLICT(root_key) DO UPDATE SET definition_id=EXCLUDED.definition_id,
        scope_keys=EXCLUDED.scope_keys,retention=EXCLUDED.retention,mutation_transaction=pg_current_xact_id()
        WHERE whaleu_ratings.category_icon_definition_heads.definition_id IS DISTINCT FROM EXCLUDED.definition_id
          OR whaleu_ratings.category_icon_definition_heads.scope_keys IS DISTINCT FROM EXCLUDED.scope_keys
          OR whaleu_ratings.category_icon_definition_heads.retention IS DISTINCT FROM EXCLUDED.retention`,
        [
          categoryIconRootKey(root),
          root.definitionId,
          root.scopeKeys,
          root.retention,
        ],
      );
    }
    for (const root of plan.beforeRoots)
      if (!nextKeys.has(categoryIconRootKey(root))) {
        const removed = await tx.query(
          `DELETE FROM whaleu_ratings.category_icon_definition_heads WHERE root_key=$1 AND definition_id=$2`,
          [categoryIconRootKey(root), root.definitionId],
        );
        if (
          removed.rowCount !== 1 &&
          !(removed.rowCount === 0 && !persisted.has(root.definitionId))
        )
          unavailable();
      }
  }
}
