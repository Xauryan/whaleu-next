/** Bounded new-owner proof. Reuse canonical Community/Campus/Safety epochs;
 * retain only pin-owned state and selected session/grant facts here. */
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  requiredOwnerEpoch,
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerTransactionExactDeadline,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { communityCountProofOwner } from '../count-epochs.js';
import { campusCountProofOwner } from '../../campus/count-epochs.js';
import { safetyCountProofOwner } from '../../safety/count-epochs.js';
const captures = [
  communityCountProofOwner,
  safetyCountProofOwner,
  campusCountProofOwner,
].map((owner) => requiredOwnerEpoch(owner, 'POST_PIN_UNAVAILABLE'));
export async function beginPostPinProof(tx: PoolClient): Promise<void> {
  for (const capture of captures) await capture(tx);
}
interface Input {
  tokenHash?: string | null;
  actor: string | null;
  sessionId: string | null;
  scopeId: string | null;
  postId: string | null;
  grantId: string | null;
  visibility: boolean;
}
interface Fact extends Input {
  phase: 'authority' | 'slot';
  stamp: string;
}
async function stamp(
  input: Input,
  phase: Fact['phase'],
  tx: PoolClient,
): Promise<string> {
  const query =
    phase === 'authority'
      ? `SELECT jsonb_build_object(
 'account',(SELECT to_jsonb(a) FROM whaleu_identity.accounts a WHERE a.id=$1),
 'session',(SELECT to_jsonb(s) FROM whaleu_identity.sessions s WHERE s.id=$2),
 'token',(SELECT to_jsonb(t) FROM whaleu_identity.access_tokens t WHERE t.token_hash=$4 AND t.session_id=$2),
 'verification',(SELECT jsonb_build_array(to_jsonb(h),to_jsonb(s),to_jsonb(a)) FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id LEFT JOIN whaleu_verification.assertions a ON a.id=s.phone_assertion_id WHERE h.account_id=$1),
 'grant',(SELECT to_jsonb(g) FROM whaleu_authorization.role_grants g WHERE g.id=$3)
 ) AS value`
      : `SELECT jsonb_build_object(
 'scope',(SELECT jsonb_build_array(to_jsonb(s),to_jsonb(h)) FROM whaleu_community.post_pin_scopes s JOIN whaleu_community.post_pin_history h ON h.scope_id=s.id WHERE s.id=$2),
 'head',(SELECT jsonb_build_array(to_jsonb(h),to_jsonb(c)) FROM whaleu_community.post_pin_heads h LEFT JOIN whaleu_community.post_pin_closures c ON c.pin_id=h.pin_id WHERE h.scope_id=$2),
 'read',(SELECT to_jsonb(r) FROM whaleu_community.post_pin_heads h JOIN whaleu_community.post_pin_reads r ON r.pin_id=h.pin_id AND r.actor_id=$1 WHERE h.scope_id=$2)
 ) AS value`;
  const row = (
    await tx.query<{ value: unknown }>(
      query,
      phase === 'authority'
        ? [input.actor, input.sessionId, input.grantId, input.tokenHash ?? null]
        : [input.actor, input.scopeId],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('POST_PIN_UNAVAILABLE');
  return ownerFingerprint(row.value);
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 3,
  failureCode: 'POST_PIN_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'POST_PIN_UNAVAILABLE', async (read) => {
      await read.query(
        `LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,whaleu_authorization.role_grants,whaleu_community.post_pin_scopes,whaleu_community.post_pin_history,whaleu_community.post_pin_heads,whaleu_community.post_pin_closures,whaleu_community.post_pin_reads IN SHARE MODE NOWAIT`,
      );
      for (const fact of facts)
        if ((await stamp(fact, fact.phase, read)) !== fact.stamp)
          throw new ApplicationError('POST_PIN_UNAVAILABLE');
    }),
};
export async function retainPostPinProof(
  input: Input,
  tx: PoolClient,
  phase: Fact['phase'] = 'slot',
): Promise<void> {
  if (phase === 'authority' && input.tokenHash && input.sessionId) {
    // Identity's current token and absolute session lifetime are authoritative;
    // sessions.access_expires_at is merely the newest-token cache.
    const expiry = (
      await tx.query<{ token_until: string; session_until: string }>(
        'SELECT t.expires_at::text AS token_until,s.absolute_expires_at::text AS session_until FROM whaleu_identity.access_tokens t JOIN whaleu_identity.sessions s ON s.id=t.session_id WHERE t.token_hash=$1 AND s.id=$2',
        [input.tokenHash, input.sessionId],
      )
    ).rows[0];
    if (!expiry) throw new ApplicationError('AUTHENTICATION_REQUIRED');
    registerTransactionExactDeadline(
      tx,
      expiry.token_until,
      'ACCESS_TOKEN_EXPIRED',
    );
    registerTransactionExactDeadline(
      tx,
      expiry.session_until,
      'ACCESS_TOKEN_EXPIRED',
    );
  }
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    phase + ':' + (input.grantId ?? ''),
    Object.freeze({ ...input, phase, stamp: await stamp(input, phase, tx) }),
  );
}
