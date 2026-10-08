import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  CommentSource,
  CommentState,
  CommentContribution,
  CommentMembership,
} from './contracts.js';
@Injectable()
export class CommentComponentRepository {
  async reference(id: string, tx: PoolClient): Promise<CommentSource | null> {
    return (
      (
        await tx.query<CommentSource>(
          `SELECT id AS source_id,post_id,actor_id,kind,content_id,root_id,transition,delta,source_sequence::text,positive_source_id FROM whaleu_post_hotness.comment_sources WHERE id=$1`,
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
  async owner(postId: string, tx: PoolClient): Promise<string | null> {
    return (
      (
        await tx.query<{ owner_id: string }>(
          'SELECT owner_id FROM whaleu_post_hotness.comment_baselines WHERE post_id=$1',
          [postId],
        )
      ).rows[0]?.owner_id ?? null
    );
  }
  async state(
    postId: string,
    tx: PoolClient,
    lock: boolean,
  ): Promise<CommentState | null> {
    return (
      (
        await tx.query<CommentState>(
          `SELECT root_count::text,reply_count::text,eligible_count::text,unique_actor_count::text,last_sequence::text,last_receipt_id FROM whaleu_post_hotness.comment_states WHERE post_id=$1${lock ? ' FOR UPDATE' : ''}`,
          [postId],
        )
      ).rows[0] ?? null
    );
  }
  async contribution(
    source: CommentSource,
    tx: PoolClient,
    lock: boolean,
  ): Promise<CommentContribution | null> {
    return (
      (
        await tx.query<CommentContribution>(
          `SELECT actor_id,root_id,eligible,active,positive_source_id,last_sequence::text,last_receipt_id FROM whaleu_post_hotness.comment_contributions WHERE post_id=$1 AND kind=$2 AND content_id=$3${lock ? ' FOR UPDATE' : ''}`,
          [source.post_id, source.kind, source.content_id],
        )
      ).rows[0] ?? null
    );
  }
  async membership(
    postId: string,
    actorId: string,
    tx: PoolClient,
    lock: boolean,
  ): Promise<CommentMembership | null> {
    return (
      (
        await tx.query<CommentMembership>(
          `SELECT active_count::text,last_sequence::text,last_receipt_id FROM whaleu_post_hotness.comment_memberships WHERE post_id=$1 AND actor_id=$2${lock ? ' FOR UPDATE' : ''}`,
          [postId, actorId],
        )
      ).rows[0] ?? null
    );
  }
  async receipt(source: CommentSource, tx: PoolClient): Promise<boolean> {
    const row = (
      await tx.query<{ valid: boolean }>(
        `SELECT post_id=$2 AND actor_id=$3 AND kind=$4 AND content_id=$5 AND root_id IS NOT DISTINCT FROM $6::uuid AND transition=$7 AND delta=$8 AND source_sequence=$9 AND positive_source_id IS NOT DISTINCT FROM $10::uuid AND component_version=1 AS valid FROM whaleu_post_hotness.comment_receipts WHERE source_id=$1`,
        [
          source.source_id,
          source.post_id,
          source.actor_id,
          source.kind,
          source.content_id,
          source.root_id,
          source.transition,
          source.delta,
          source.source_sequence,
          source.positive_source_id,
        ],
      )
    ).rows[0];
    if (row && !row.valid) throw new Error('Comment receipt identity mismatch');
    return !!row;
  }
  async first(postId: string, tx: PoolClient): Promise<string | null> {
    return (
      (
        await tx.query<{ source_sequence: string }>(
          `SELECT s.source_sequence::text FROM whaleu_post_hotness.comment_sources s WHERE s.post_id=$1 AND NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_receipts r WHERE r.source_id=s.id) ORDER BY s.source_sequence LIMIT 1`,
          [postId],
        )
      ).rows[0]?.source_sequence ?? null
    );
  }
  /** Metadata-only earliest unresolved source; settlement revalidates after its parent lock. */
  async nextSource(postId: string, tx: PoolClient): Promise<string | null> {
    const row = (
      await tx.query<{ id: string | null }>(
        `SELECT src.id FROM whaleu_post_hotness.comment_sources src WHERE src.post_id=$1 AND NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.comment_receipts r WHERE r.source_id=src.id) ORDER BY src.source_sequence LIMIT 1`,
        [postId],
      )
    ).rows[0];
    if (row && row.id === null)
      throw new Error('Component source binding unavailable');
    return row?.id ?? null;
  }
}
