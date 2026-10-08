import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { HOT_SCORE_IDENTITY, hotScoreCertificateHash } from './certificate.js';
import type { HotScoreCertificate } from './certificate.js';
import type { HotScoreSnapshot } from './contracts.js';

/** These joins/conditions are cheap discovery hints only. Every emission and
 * refresh independently validates full locked retained-source receipt proof. */
export const HOT_CURRENT_JOINS = `
JOIN whaleu_post_hotness.subscription_states hs_subscription ON hs_subscription.post_id=hs.post_id
JOIN whaleu_post_hotness.like_states hs_like ON hs_like.post_id=hs.post_id
JOIN whaleu_post_hotness.comment_states hs_comment ON hs_comment.post_id=hs.post_id
JOIN whaleu_post_hotness.view_states hs_view ON hs_view.post_id=hs.post_id`;
export const HOT_CURRENT_HINT = `hs.source_formula_version=6
 AND hs.numeric_profile='pg18-numeric40-round4-v1' AND hs.numeric_profile_version=1
 AND hs.formula_fingerprint='${HOT_SCORE_IDENTITY[3]}' AND hs.expression_fingerprint='${HOT_SCORE_IDENTITY[4]}'
 AND hs.snapshot#>>'{states,view,count}'=hs_view.count::text
 ${(['subscription', 'like', 'comment'] as const)
   .map(
     (
       c,
     ) => `AND hs.snapshot#>>'{states,${c},processedHead}'=hs_${c}.last_sequence::text
 AND hs.snapshot#>>'{states,${c},lastReceiptId}' IS NOT DISTINCT FROM hs_${c}.last_receipt_id::text
 AND hs_${c}.last_sequence=coalesce((SELECT max(source_sequence) FROM whaleu_post_hotness.${c}_sources src WHERE src.post_id=hs.post_id),0)`,
   )
   .join('\n')}
 AND hs.snapshot#>>'{states,subscription,counts,0}'=hs_subscription.count::text
 AND hs.snapshot#>>'{states,like,counts,0}'=hs_like.count::text
 ${['root_count', 'reply_count', 'eligible_count', 'unique_actor_count'].map((c, i) => `AND hs.snapshot#>>'{states,comment,counts,${i}}'=hs_comment.${c}::text`).join('\n')}`;

@Injectable()
export class HotScoreStorage {
  async certificate(
    postId: string,
    tx: PoolClient,
  ): Promise<HotScoreCertificate | null> {
    return (
      (
        await tx.query<HotScoreCertificate>(
          `SELECT post_id,owner_id,source_request_id,creation_xid::text,component_version,
      source_formula_version,numeric_profile,numeric_profile_version,formula_fingerprint,expression_fingerprint,
      score::text,snapshot,certificate_hash,computed_at=(snapshot->>'snapshotAt')::timestamptz AS clock_matches
      FROM whaleu_post_hotness.scores WHERE post_id=$1`,
          [postId],
        )
      ).rows[0] ?? null
    );
  }
  async replace(
    snapshot: HotScoreSnapshot,
    score: string,
    tx: PoolClient,
  ): Promise<void> {
    const b = snapshot.baselines.subscription!;
    await tx.query(
      `INSERT INTO whaleu_post_hotness.scores(post_id,owner_id,source_request_id,creation_xid,component_version,
      source_formula_version,numeric_profile,numeric_profile_version,formula_fingerprint,expression_fingerprint,score,snapshot,certificate_hash,computed_at)
      VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::timestamptz)
      ON CONFLICT(post_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,source_request_id=EXCLUDED.source_request_id,
      creation_xid=EXCLUDED.creation_xid,component_version=EXCLUDED.component_version,
      source_formula_version=EXCLUDED.source_formula_version,numeric_profile=EXCLUDED.numeric_profile,
      numeric_profile_version=EXCLUDED.numeric_profile_version,formula_fingerprint=EXCLUDED.formula_fingerprint,
      expression_fingerprint=EXCLUDED.expression_fingerprint,score=EXCLUDED.score,snapshot=EXCLUDED.snapshot,
      certificate_hash=EXCLUDED.certificate_hash,computed_at=EXCLUDED.computed_at`,
      [
        snapshot.postId,
        snapshot.ownerId,
        b.sourceRequestId,
        snapshot.creationXid,
        ...HOT_SCORE_IDENTITY,
        score,
        JSON.stringify(snapshot),
        hotScoreCertificateHash(snapshot, score),
        snapshot.snapshotAt,
      ],
    );
  }
  /** Caller owns the parent and has validated all independent native identities. */
  async enroll(postId: string, tx: PoolClient): Promise<void> {
    await tx.query(
      'INSERT INTO whaleu_post_hotness.processing(post_id) VALUES($1) ON CONFLICT(post_id) DO NOTHING',
      [postId],
    );
  }
  async orderSelected(
    ids: readonly string[],
    tx: PoolClient,
  ): Promise<string[]> {
    return (
      await tx.query<{ post_id: string }>(
        `SELECT post_id FROM whaleu_post_hotness.processing
      WHERE post_id=ANY($1::uuid[]) ORDER BY next_attempt_at,last_attempt_at NULLS FIRST,post_id LIMIT 20`,
        [ids],
      )
    ).rows.map((row) => row.post_id);
  }
  async due(tx: PoolClient, limit: number): Promise<string[]> {
    return (
      await tx.query<{ post_id: string }>(
        `SELECT work.post_id FROM whaleu_post_hotness.processing work
      WHERE work.next_attempt_at<=clock_timestamp() AND (work.result IN ('pending','blocked','failed') OR NOT EXISTS(
        SELECT 1 FROM whaleu_post_hotness.scores hs ${HOT_CURRENT_JOINS} WHERE hs.post_id=work.post_id AND (${HOT_CURRENT_HINT})))
      ORDER BY work.next_attempt_at,work.last_attempt_at NULLS FIRST,work.post_id LIMIT $1`,
        [limit],
      )
    ).rows.map((row) => row.post_id);
  }
  /** Final metadata-only transaction: acquires no domain lock before or after
   * this UPDATE. This preserves backoff even when a parent is stuck, without
   * any queue-before-parent inversion. A late concurrent attempt may cause a
   * redundant retry, never authorize effects or claim current certificate state. */
  async schedule(
    postId: string,
    result: 'current' | 'blocked' | 'failed',
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      `UPDATE whaleu_post_hotness.processing SET last_attempt_at=clock_timestamp(),result=$2,
      consecutive_failures=CASE WHEN $2='failed' THEN least(8,consecutive_failures+1) ELSE 0 END,
      next_attempt_at=clock_timestamp()+CASE WHEN $2='failed' THEN make_interval(secs=>least(300,5*power(2,least(6,consecutive_failures)))::integer)
        ELSE interval '5 seconds' END WHERE post_id=$1`,
      [postId, result],
    );
  }
}

/** Successful native publication calls this only after all four guarded baseline owners. */
export async function enrollPublishedHotProcessing(
  postId: string,
  tx: PoolClient,
): Promise<void> {
  await tx.query(
    'INSERT INTO whaleu_post_hotness.processing(post_id) VALUES($1)',
    [postId],
  );
}
