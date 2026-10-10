/** Current-schema raw legacy commands preserve the genuine original intent and
 * old hash before mutation. Historical migration fixtures must not use this. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../../src/community/content-review/contracts.js';

type Operation =
  | 'set_score'
  | 'create_comment'
  | 'create_reply'
  | 'set_comment_like'
  | 'set_reply_like'
  | 'set_target_subscription';
const domains: Record<Operation, string> = {
  set_score: 'whaleu:rating-command:v1',
  create_comment: 'whaleu:rating-command:v1',
  create_reply: 'whaleu:rating-reply-command:v1',
  set_comment_like: 'whaleu:rating-like-command:v1',
  set_reply_like: 'whaleu:rating-like-command:v1',
  set_target_subscription: 'whaleu:rating-subscription-command:v1',
};
export async function prepareLegacyBoundaryRequest(
  tx: PoolClient,
  actor: string,
  operation: Operation,
  intent: {
    clientRequestId: string;
    targetId: string;
    regionId: string | null;
  } & Record<string, unknown>,
) {
  const hash = createHash('sha256')
    .update(domains[operation] + '\n' + canonicalJson({ operation, intent }))
    .digest('hex');
  await tx.query(
    'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
    [actor, intent.clientRequestId, operation, hash],
  );
  const row = (
    await tx.query<{
      witness: { kind: string; proof: { intent: unknown; intentHash: string } };
    }>('SELECT whaleu_ratings.begin_legacy_boundary($1,$2,$3::jsonb) witness', [
      actor,
      intent.clientRequestId,
      canonicalJson(intent),
    ])
  ).rows[0]!;
  assert.equal(row.witness.kind, 'legacy_boundary');
  assert.deepEqual(row.witness.proof.intent, intent);
  assert.equal(row.witness.proof.intentHash, hash);
  return { hash, witness: row.witness };
}
