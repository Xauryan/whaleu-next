import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { canonicalEqual } from '../content-review/contracts.js';
import { relatedRootScopeSchema } from '../content-review/scope-contracts.js';
import type {
  ContentScopeSnapshot,
  RelatedRootScope,
} from '../content-review/scope-contracts.js';
import type { ContentKind } from '../content-review/contracts.js';

export interface DistributionBindingFact {
  postId: string;
  category: import('../contracts.js').Category;
  decisionId: string;
  digest: string;
  scope: RelatedRootScope;
  valid: boolean;
}
/** Immutable historical native proof only. Current topology is deliberately absent. */
interface BindingReadBudget {
  rows<T>(
    tx: PoolClient,
    sql: string,
    values: unknown[],
    cap: number,
  ): Promise<T[]>;
}
export async function readDistributionBindings(
  postIds: readonly string[],
  tx: PoolClient,
  budget?: BindingReadBudget,
): Promise<Map<string, DistributionBindingFact>> {
  const ids = [...new Set(postIds)].sort();
  if (ids.length > 256) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  const result = new Map<string, DistributionBindingFact>();
  if (!ids.length) return result;
  type Row = {
    category: import('../contracts.js').Category;
    postId: string;
    decisionId: string;
    digest: string;
    scope: unknown;
    valid: boolean;
  };
  const sql = `SELECT b.post_id AS "postId",b.decision_id AS "decisionId",b.digest,b.scope,(a.envelope->>'category') AS category,
    whaleu_community.related_sync_binding_valid(b.post_id) AS valid
    FROM whaleu_community.post_distribution_bindings b JOIN whaleu_community.content_approval_bindings a ON a.content_kind='post' AND a.content_id=b.post_id WHERE b.post_id=ANY($1::uuid[]) ORDER BY b.post_id`;
  const rows = budget
    ? await budget.rows<Row>(tx, sql, [ids], ids.length)
    : (await tx.query<Row>(sql, [ids])).rows;
  for (const row of rows) {
    const scope = relatedRootScopeSchema.safeParse(row.scope);
    if (!scope.success || !ids.includes(row.postId) || result.has(row.postId))
      continue;
    result.set(
      row.postId,
      Object.freeze({
        ...row,
        scope: Object.freeze(scope.data),
        valid: row.valid === true,
      }),
    );
  }
  return result;
}
export function distributionScopeMatches(
  fact: DistributionBindingFact | undefined,
  kind: ContentKind,
  scope: ContentScopeSnapshot,
): boolean {
  if (!fact?.valid) return false;
  if (kind === 'post')
    return scope.sync === 'related' && canonicalEqual(scope, fact.scope);
  return (
    scope.sync === 'inherited_related' &&
    scope.originalSpaceId === fact.scope.originalSpaceId &&
    scope.originalRegionId === fact.scope.originalRegionId &&
    scope.parentDistribution.postId === fact.postId &&
    scope.parentDistribution.decisionId === fact.decisionId &&
    scope.parentDistribution.digest === fact.digest
  );
}
