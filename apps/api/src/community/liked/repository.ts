import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { LikedKind } from './contracts.js';

export interface LikedCandidate {
  kind: LikedKind;
  target_id: string;
  post_id: string;
  root_comment_id: string | null;
}
export interface StoredLike {
  like_id: string;
  liked_at: Date | null;
}
@Injectable()
export class LikedHistoryRepository {
  /** References only: never lock membership before its parent content. */
  async candidates(owner: string, tx: PoolClient): Promise<LikedCandidate[]> {
    return (
      await tx.query<LikedCandidate>(
        `SELECT 'post' AS kind,l.post_id AS target_id,l.post_id,NULL::uuid AS root_comment_id
           FROM whaleu_community.post_likes l WHERE l.account_id=$1
         UNION ALL
         SELECT 'comment',l.comment_id,c.post_id,c.id
           FROM whaleu_community.comment_likes l JOIN whaleu_community.root_comments c ON c.id=l.comment_id WHERE l.account_id=$1
         UNION ALL
         SELECT 'reply',l.reply_id,r.post_id,r.root_comment_id
           FROM whaleu_community.reply_likes l JOIN whaleu_community.replies r ON r.id=l.reply_id WHERE l.account_id=$1
         ORDER BY post_id,root_comment_id NULLS FIRST,kind,target_id LIMIT 1025`,
        [owner],
      )
    ).rows;
  }
  /** All normal like/unlike writers hold the parent exclusively. The read has
   * already acquired that parent, root and reply in deterministic order. */
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
