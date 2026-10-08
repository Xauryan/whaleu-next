import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { LikeSource, LikeState, LikeMembership } from './contracts.js';
@Injectable()
export class LikeComponentRepository {
  async reference(id: string, tx: PoolClient): Promise<LikeSource | null> {
    return (
      (
        await tx.query<LikeSource>(
          `SELECT id AS source_id,like_id,transition,post_id,actor_id,delta,source_sequence::text,positive_source_id
          FROM whaleu_post_hotness.like_sources WHERE id=$1`,
          [id],
        )
      ).rows[0] ?? null
    );
  }
  async lockPost(postId: string, tx: PoolClient) {
    await tx.query(
      'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
      [postId],
    );
  }
  async known(postId: string, tx: PoolClient): Promise<boolean> {
    return (
      (
        await tx.query(
          'SELECT post_id FROM whaleu_post_hotness.like_baselines WHERE post_id=$1',
          [postId],
        )
      ).rowCount === 1
    );
  }
  async state(
    postId: string,
    tx: PoolClient,
    lock: boolean,
  ): Promise<LikeState | null> {
    return (
      (
        await tx.query<LikeState>(
          `SELECT count::text,last_sequence::text,last_receipt_id FROM whaleu_post_hotness.like_states WHERE post_id=$1${lock ? ' FOR UPDATE' : ''}`,
          [postId],
        )
      ).rows[0] ?? null
    );
  }
  async membership(
    postId: string,
    actorId: string,
    tx: PoolClient,
    lock: boolean,
  ): Promise<LikeMembership | null> {
    return (
      (
        await tx.query<LikeMembership>(
          `SELECT active_like_id,last_sequence::text,last_receipt_id FROM whaleu_post_hotness.like_memberships WHERE post_id=$1 AND actor_id=$2${lock ? ' FOR UPDATE' : ''}`,
          [postId, actorId],
        )
      ).rows[0] ?? null
    );
  }
  async receipt(source: LikeSource, tx: PoolClient): Promise<boolean> {
    const row = (
      await tx.query<{ valid: boolean }>(
        `SELECT like_id=$2 AND transition=$3 AND post_id=$4 AND actor_id=$5 AND source_sequence=$6 AND delta=$7 AND component_version=1 AS valid FROM whaleu_post_hotness.like_receipts WHERE source_id=$1`,
        [
          source.source_id,
          source.like_id,
          source.transition,
          source.post_id,
          source.actor_id,
          source.source_sequence,
          source.delta,
        ],
      )
    ).rows[0];
    if (row && !row.valid) throw new Error('Like receipt identity mismatch');
    return !!row;
  }
  async first(postId: string, tx: PoolClient): Promise<string | null> {
    return (
      (
        await tx.query<{ source_sequence: string }>(
          `SELECT s.source_sequence::text FROM whaleu_post_hotness.like_sources s
      WHERE s.post_id=$1 AND NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.like_receipts r WHERE r.source_id=s.id)
      ORDER BY s.source_sequence LIMIT 1`,
          [postId],
        )
      ).rows[0]?.source_sequence ?? null
    );
  }
  /** Metadata-only earliest unresolved source; settlement revalidates after its parent lock. */
  async nextSource(postId: string, tx: PoolClient): Promise<string | null> {
    const row = (
      await tx.query<{ id: string | null }>(
        `SELECT src.id FROM whaleu_post_hotness.like_sources src WHERE src.post_id=$1 AND NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.like_receipts r WHERE r.source_id=src.id) ORDER BY src.source_sequence LIMIT 1`,
        [postId],
      )
    ).rows[0];
    if (row && row.id === null)
      throw new Error('Component source binding unavailable');
    return row?.id ?? null;
  }
}
