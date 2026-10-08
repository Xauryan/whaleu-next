import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { HOT_SCORE_COMPONENTS } from './contracts.js';
import type { HotScoreComponent, HotScoreSnapshot } from './contracts.js';

// Identifiers below are closed, module-owned constants. Values are parameters.
function baseline(component: HotScoreComponent): string {
  const b = `${component}_baseline`;
  const opening =
    component === 'comment'
      ? [
          'opening_root_count',
          'opening_reply_count',
          'opening_eligible_count',
          'opening_unique_actor_count',
        ]
      : ['opening_count'];
  return `CASE WHEN ${b}.post_id IS NULL THEN NULL ELSE jsonb_build_object(
    'postId',${b}.post_id,'componentVersion',${b}.component_version,'origin',${b}.origin,
    'ownerId',${b}.owner_id,'sourceRequestId',${b}.source_request_id,
    'creationXid',${b}.creation_xid::text,'createdAt',${b}.created_at,
    'openingCounts',jsonb_build_array(${opening.map((key) => `${b}.${key}::text`).join(',')}),
    'publicationVerified',EXISTS(SELECT 1 FROM whaleu_community.report_origins origin
      JOIN whaleu_community.publication_requests request
        ON request.account_id=origin.owner_account_id AND request.client_request_id=origin.source_request_id
      WHERE origin.kind='post' AND origin.target_id=p.id AND origin.provenance='native_publication'
        AND origin.owner_account_id=p.account_id AND origin.owner_account_id=${b}.owner_id
        AND origin.source_request_id=${b}.source_request_id
        AND ${b}.creation_xid=p.local_creation_transaction
        AND request.operation='publish_post' AND request.receipt->>'outcome'='created'
        AND request.receipt->>'resourceId'=p.id::text
        AND request.receipt->>'requestId'=${b}.source_request_id::text
        AND request.receipt->>'operation'='publish_post')) END`;
}

function receiptKey(component: 'subscription' | 'like' | 'comment'): string {
  return component === 'subscription'
    ? 'r.epoch_id=src.epoch_id AND r.transition=src.transition'
    : 'r.source_id=src.id';
}

/** Exact immutable receipt/source identity, not mutable live relation counts.
 * Subscriptions additionally require their own completed obligation, never the
 * other saved-effect owners, and the retained epoch's exact transition. */
function receiptMatches(
  component: 'subscription' | 'like' | 'comment',
): string {
  const common = `r.post_id=src.post_id AND r.actor_id=src.actor_id
    AND r.source_sequence=src.source_sequence AND r.transition=src.transition AND r.component_version=1`;
  if (component === 'subscription')
    return `${common}
    AND r.delta=CASE src.transition WHEN 'saved' THEN 1 ELSE -1 END
    AND EXISTS(SELECT 1 FROM whaleu_community.saved_obligations obligation
      JOIN whaleu_community.saved_epochs epoch ON epoch.id=obligation.epoch_id
      WHERE obligation.id=r.obligation_id AND obligation.epoch_id=src.epoch_id
        AND obligation.transition=src.transition AND obligation.action='save_ranking'
        AND obligation.recipient_account_id=subscription_baseline.owner_id
        AND obligation.delta=r.delta AND obligation.status='completed'
        AND obligation.local_creation_transaction=src.source_transaction
        AND epoch.post_id=src.post_id AND epoch.account_id=src.actor_id
        AND ((src.transition='saved' AND epoch.started_sequence=src.source_sequence
            AND epoch.local_creation_transaction=src.source_transaction)
          OR (src.transition='unsaved' AND epoch.ended_sequence=src.source_sequence)))`;
  if (component === 'like')
    return `${common} AND r.like_id=src.like_id AND r.delta=src.delta`;
  return `${common} AND r.kind=src.kind AND r.content_id=src.content_id
    AND r.root_id IS NOT DISTINCT FROM src.root_id AND r.delta=src.delta
    AND r.positive_source_id IS NOT DISTINCT FROM src.positive_source_id
    AND r.eligible=(src.actor_id<>comment_baseline.owner_id)`;
}

function asyncState(component: 'subscription' | 'like' | 'comment'): string {
  const st = `${component}_state`;
  const fields =
    component === 'comment'
      ? ['root_count', 'reply_count', 'eligible_count', 'unique_actor_count']
      : ['count'];
  const key = receiptKey(component),
    matches = receiptMatches(component);
  const receipts = `whaleu_post_hotness.${component}_receipts`;
  const sources = `whaleu_post_hotness.${component}_sources`;
  const receiptId =
    component === 'subscription' ? 'obligation_id' : 'source_id';
  return `CASE WHEN ${st}.post_id IS NULL THEN NULL ELSE jsonb_build_object(
    'postId',${st}.post_id,'counts',jsonb_build_array(${fields.map((key) => `${st}.${key}::text`).join(',')}),
    'processedHead',${st}.last_sequence::text,'lastReceiptId',${st}.last_receipt_id,
    'capturedHead',coalesce((SELECT max(src.source_sequence) FROM ${sources} src WHERE src.post_id=p.id),0)::text,
    'unresolvedSequence',(SELECT min(src.source_sequence)::text FROM ${sources} src WHERE src.post_id=p.id
      AND NOT EXISTS(SELECT 1 FROM ${receipts} r WHERE ${key} AND ${matches})),
    'invalidReceipt',EXISTS(SELECT 1 FROM ${sources} src JOIN ${receipts} r ON ${key}
      WHERE src.post_id=p.id AND NOT coalesce((${matches}),false)),
    'terminalReceiptValid',CASE WHEN ${st}.last_sequence=0 THEN ${st}.last_receipt_id IS NULL
      AND ${fields.map((key) => `${st}.${key}=0`).join(' AND ')}
      ELSE EXISTS(SELECT 1 FROM ${receipts} r JOIN ${sources} src ON ${key}
        WHERE r.${receiptId}=${st}.last_receipt_id AND r.post_id=p.id
          AND r.source_sequence=${st}.last_sequence AND ${matches}
          AND ${fields.map((key) => `r.after_${key}=${st}.${key}`).join(' AND ')}) END) END`;
}

/** One ordinary statement after every lock. READ COMMITTED statements before
 * this are only guards; no pre-wait row can supply computation inputs. */
export const HOT_SCORE_SNAPSHOT_SQL = `SELECT jsonb_build_object(
  'postId',p.id,'ownerId',p.account_id,'creationXid',p.local_creation_transaction::text,
  'snapshotAt',statement_timestamp(),
  'baselines',jsonb_build_object(${HOT_SCORE_COMPONENTS.map((c) => `'${c}',${baseline(c)}`).join(',')}),
  'states',jsonb_build_object(
    'subscription',${asyncState('subscription')},
    'like',${asyncState('like')},
    'comment',${asyncState('comment')},
    'view',CASE WHEN view_state.post_id IS NULL THEN NULL ELSE jsonb_build_object(
      'postId',view_state.post_id,'count',view_state.count::text) END)) AS snapshot
FROM whaleu_community.posts p
${HOT_SCORE_COMPONENTS.map(
  (
    c,
  ) => `LEFT JOIN whaleu_post_hotness.${c}_baselines ${c}_baseline ON ${c}_baseline.post_id=p.id
LEFT JOIN whaleu_post_hotness.${c}_states ${c}_state ON ${c}_state.post_id=p.id`,
).join('\n')}
WHERE p.id=$1`;

@Injectable()
export class HotScoreRepository {
  async lockPost(postId: string, tx: PoolClient): Promise<boolean> {
    return (
      (
        await tx.query(
          'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
          [postId],
        )
      ).rows.length === 1
    );
  }
  async coverage(postId: string, tx: PoolClient): Promise<boolean> {
    const result = await tx.query<{ covered: boolean }>(
      `SELECT ${HOT_SCORE_COMPONENTS.map(
        (c) =>
          `EXISTS(SELECT 1 FROM whaleu_post_hotness.${c}_baselines WHERE post_id=$1)`,
      ).join(' AND ')} AS covered`,
      [postId],
    );
    return result.rows[0]?.covered === true;
  }
  async lockStates(postId: string, tx: PoolClient): Promise<void> {
    // Fixed composition order: parent -> subscription -> like -> comment -> view.
    // The explicit view lock also serializes permitted direct positive updates;
    // it cannot prove arbitrary SQL increments came from accepted view events.
    for (const component of HOT_SCORE_COMPONENTS)
      await tx.query(
        `SELECT post_id FROM whaleu_post_hotness.${component}_states WHERE post_id=$1 FOR UPDATE`,
        [postId],
      );
  }
  async snapshot(
    postId: string,
    tx: PoolClient,
  ): Promise<HotScoreSnapshot | null> {
    return (
      (
        await tx.query<{ snapshot: HotScoreSnapshot }>(HOT_SCORE_SNAPSHOT_SQL, [
          postId,
        ])
      ).rows[0]?.snapshot ?? null
    );
  }
}
