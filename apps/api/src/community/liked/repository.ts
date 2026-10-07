import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { LikedKind } from './contracts.js';
import type { LikedAnchor } from './cursor.js';

export interface LikedCandidate {
  kind: LikedKind;
  target_id: string;
  post_id: string;
  root_comment_id: string | null;
  like_id: string;
  liked_at: Date | null;
}
export interface StoredLike {
  like_id: string;
  liked_at: Date | null;
}
const kinds = ['post', 'comment', 'reply'] as const;
const references = {
  post: {
    columns: 'l.post_id AS target_id,l.post_id,NULL::uuid AS root_comment_id',
    join: '',
  },
  comment: {
    columns: 'l.comment_id AS target_id,c.post_id,c.id AS root_comment_id',
    join: 'JOIN whaleu_community.root_comments c ON c.id=l.comment_id',
  },
  reply: {
    columns: 'l.reply_id AS target_id,r.post_id,r.root_comment_id',
    join: 'JOIN whaleu_community.replies r ON r.id=l.reply_id',
  },
};
@Injectable()
export class LikedHistoryRepository {
  /** Each index-backed dated/undated branch has a keyset bound and LIMIT before
   * merging; scanning an old page never rescans all newer membership rows. */
  async candidates(
    owner: string,
    after: LikedAnchor | null,
    limit: number,
    tx: PoolClient,
  ): Promise<LikedCandidate[]> {
    const values: unknown[] = [owner];
    if (after) {
      if (after.at === null) values.push(after.id, after.targetKind);
      else values.push(after.at, after.id, after.targetKind);
    }
    const parts: string[] = [];
    for (const kind of kinds) {
      const ref = references[kind];
      for (const dated of [true, false]) {
        if (dated && after?.at === null) continue;
        const seek =
          !after || (!dated && after.at !== null)
            ? ''
            : dated
              ? `AND (liked_at,like_id)<=($2::timestamptz,$3::uuid) AND (liked_at,like_id,'${kind}'::text)<($2::timestamptz,$3::uuid,$4::text)`
              : `AND like_id<=$2::uuid AND (like_id,'${kind}'::text)<($2::uuid,$3::text)`;
        parts.push(`SELECT '${kind}'::text AS kind,${ref.columns},l.like_id,l.liked_at
          FROM (SELECT ${kind}_id,like_id,liked_at FROM whaleu_community.${kind}_likes
            WHERE account_id=$1 AND liked_at IS ${dated ? 'NOT ' : ''}NULL ${seek}
            ORDER BY liked_at DESC NULLS LAST,like_id DESC LIMIT ${limit}) l ${ref.join}`);
      }
    }
    return (
      await tx.query<LikedCandidate>(
        `${parts.map((part) => `(${part})`).join(' UNION ALL ')} ORDER BY liked_at DESC NULLS LAST,like_id DESC,kind DESC LIMIT ${limit}`,
        values,
      )
    ).rows;
  }
  /** The guard is a current membership lookup, never trusted stored ownership. */
  async guard(
    owner: string,
    anchor: LikedAnchor,
    tx: PoolClient,
  ): Promise<LikedCandidate | null> {
    const kind = anchor.targetKind,
      ref = references[kind];
    return (
      (
        await tx.query<LikedCandidate>(
          `SELECT '${kind}'::text AS kind,${ref.columns},l.like_id,l.liked_at FROM whaleu_community.${kind}_likes l ${ref.join}
       WHERE l.account_id=$1 AND l.like_id=$2 AND l.liked_at IS NOT DISTINCT FROM $3::timestamptz`,
          [owner, anchor.id, anchor.at],
        )
      ).rows[0] ?? null
    );
  }
  /** Normal writers hold the full parent first; re-read after its locks. */
  async current(
    owner: string,
    candidate: LikedCandidate,
    tx: PoolClient,
  ): Promise<StoredLike | null> {
    return (
      (
        await tx.query<StoredLike>(
          `SELECT like_id,liked_at FROM whaleu_community.${candidate.kind}_likes WHERE account_id=$1 AND ${candidate.kind}_id=$2`,
          [owner, candidate.target_id],
        )
      ).rows[0] ?? null
    );
  }
}
