import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { PublicationKind, PublicationPageQuery } from './contracts.js';
import type { PublicationAnchor } from './cursor.js';
export interface PublicationCandidate {
  kind: PublicationKind;
  target_id: string;
  post_id: string;
  root_comment_id: string | null;
  record_id: string;
  published_at: Date;
}
const references = {
  post: {
    table: 'posts',
    date: 'published_at',
    columns: 'id AS post_id,NULL::uuid AS root_comment_id',
  },
  comment: {
    table: 'root_comments',
    date: 'created_at',
    columns: 'post_id,id AS root_comment_id',
  },
  reply: {
    table: 'replies',
    date: 'created_at',
    columns: 'post_id,root_comment_id',
  },
} as const;
const selectedKinds = (query: PublicationPageQuery): PublicationKind[] =>
  query.kind === 'topic' ? ['post'] : ['comment', 'reply'];
@Injectable()
export class PublicationHistoryRepository {
  async candidates(
    owner: string,
    query: PublicationPageQuery,
    after: PublicationAnchor | null,
    limit: number,
    tx: PoolClient,
  ): Promise<PublicationCandidate[]> {
    const values: unknown[] = [owner, query.identity];
    if (after) values.push(after.at, after.id, after.targetKind);
    const parts = selectedKinds(query).map((kind) => {
      const ref = references[kind];
      return `(SELECT '${kind}'::text AS kind,id AS target_id,${ref.columns},id AS record_id,${ref.date} AS published_at FROM whaleu_community.${ref.table}
       WHERE account_id=$1 AND author_mode=$2 ${after ? `AND (${ref.date},id,'${kind}'::text)<($3::timestamptz,$4::uuid,$5::text)` : ''}
       ORDER BY ${ref.date} DESC,id DESC LIMIT ${limit})`;
    });
    return (
      await tx.query<PublicationCandidate>(
        `SELECT * FROM (${parts.join(' UNION ALL ')}) AS candidates ORDER BY published_at DESC,record_id DESC,kind DESC LIMIT ${limit}`,
        values,
      )
    ).rows;
  }
  async guard(
    owner: string,
    query: PublicationPageQuery,
    anchor: PublicationAnchor,
    tx: PoolClient,
  ): Promise<PublicationCandidate | null> {
    if (!selectedKinds(query).includes(anchor.targetKind)) return null;
    const kind = anchor.targetKind,
      ref = references[kind];
    return (
      (
        await tx.query<PublicationCandidate>(
          `SELECT '${kind}'::text AS kind,id AS target_id,${ref.columns},id AS record_id,${ref.date} AS published_at FROM whaleu_community.${ref.table} WHERE account_id=$1 AND author_mode=$2 AND id=$3 AND ${ref.date}=$4::timestamptz`,
          [owner, query.identity, anchor.id, anchor.at],
        )
      ).rows[0] ?? null
    );
  }
  async current(
    owner: string,
    query: PublicationPageQuery,
    candidate: PublicationCandidate,
    tx: PoolClient,
  ) {
    return this.guard(
      owner,
      query,
      {
        targetKind: candidate.kind,
        id: candidate.record_id,
        at: candidate.published_at.toISOString(),
      },
      tx,
    );
  }
}
