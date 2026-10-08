/** Test-only frozen scalar metadata owner from 1632952. No authorization or
 * final proof is replaced. Differential runs execute actual PostgreSQL SQL. */
import type { PoolClient } from 'pg';
import type { SearchKind } from '../../src/community/search/contracts.js';
import type {
  SearchRepository,
  SearchCandidate,
} from '../../src/community/search/repository.js';

const sources = {
  post: { table: 'posts', alias: 'p', time: 'published_at' },
  comment: { table: 'root_comments', alias: 'c', time: 'created_at' },
  reply: { table: 'replies', alias: 'r', time: 'created_at' },
} as const;
export async function scalarSearchLocks(
  kind: SearchKind,
  ids: readonly string[],
  tx: PoolClient,
): Promise<SearchCandidate[]> {
  const { table, alias, time } = sources[kind];
  const rows: SearchCandidate[] = [];
  for (const id of [...new Set(ids)].sort()) {
    const result = await tx.query<SearchCandidate>(
      `SELECT ${alias}.id,'${kind}'::text AS kind,p.space_id AS "spaceId",p.id AS "postId",
        ${kind === 'post' ? 'NULL::uuid' : kind === 'comment' ? 'c.id' : 'r.root_comment_id'} AS "rootCommentId",
        to_char(${alias}.${time} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
       FROM whaleu_community.${table} ${alias}${kind === 'post' ? '' : ` JOIN whaleu_community.posts p ON p.id=${alias}.post_id`}
       WHERE ${alias}.id=$1 FOR SHARE OF ${alias}`,
      [id],
    );
    if (result.rows[0]) rows.push(result.rows[0]);
  }
  return rows;
}
export async function withScalarSearchLocks<T>(
  repository: SearchRepository,
  operation: () => Promise<T>,
): Promise<T> {
  const original = repository.lockCandidates;
  repository.lockCandidates = scalarSearchLocks;
  try {
    return await operation();
  } finally {
    repository.lockCandidates = original;
  }
}
