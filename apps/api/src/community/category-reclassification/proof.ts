import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
interface Input {
  actor: string;
  sessionId: string;
  tokenHash: string;
  postId: string | null;
  grantId: string | null;
}
interface Fact extends Input {
  stamp: string;
}
async function stamp(input: Input, tx: PoolClient): Promise<string> {
  if (input.postId === null && input.grantId === null) {
    const row = (
      await tx.query<{ value: unknown }>(
        `SELECT jsonb_build_object(
      'account',(SELECT jsonb_build_array(to_jsonb(a),a.xmin::text) FROM whaleu_identity.accounts a WHERE id=$1),
      'session',(SELECT jsonb_build_array(to_jsonb(s),s.xmin::text) FROM whaleu_identity.sessions s WHERE id=$2),
      'token',(SELECT jsonb_build_array(to_jsonb(t),t.xmin::text) FROM whaleu_identity.access_tokens t WHERE token_hash=$3 AND session_id=$2)
    ) AS value`,
        [input.actor, input.sessionId, input.tokenHash],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('AUTHENTICATION_REQUIRED');
    return ownerFingerprint(row.value);
  }
  const row = (
    await tx.query<{ value: unknown }>(
      `SELECT jsonb_build_object(
 'account',(SELECT jsonb_build_array(to_jsonb(a),a.xmin::text) FROM whaleu_identity.accounts a WHERE id=$1),
 'session',(SELECT jsonb_build_array(to_jsonb(s),s.xmin::text) FROM whaleu_identity.sessions s WHERE id=$2),
 'token',(SELECT jsonb_build_array(to_jsonb(t),t.xmin::text) FROM whaleu_identity.access_tokens t WHERE token_hash=$3 AND session_id=$2),
 'grant',(SELECT jsonb_build_array(to_jsonb(g),g.xmin::text) FROM whaleu_authorization.role_grants g WHERE id=$5),
 'post',(SELECT to_jsonb(p) FROM whaleu_community.posts p WHERE id=$4),
 'hidden',(SELECT to_jsonb(v) FROM whaleu_community.post_owner_visibility v WHERE post_id=$4),
 'head',(SELECT jsonb_build_array(to_jsonb(h),h.xmin::text) FROM whaleu_community.post_category_heads h WHERE post_id=$4)
 ) AS value`,
      [
        input.actor,
        input.sessionId,
        input.tokenHash,
        input.postId,
        input.grantId,
      ],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
  return ownerFingerprint(row.value);
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 1,
  failureCode: 'POST_CATEGORY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'POST_CATEGORY_UNAVAILABLE', async (read) => {
      if (facts.some((fact) => fact.grantId !== null))
        await read.query(
          'LOCK TABLE whaleu_authorization.role_grants IN SHARE MODE NOWAIT',
        );
      for (const fact of facts) {
        await read.query(
          'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE NOWAIT',
          [fact.actor],
        );
        await read.query(
          'SELECT id FROM whaleu_identity.sessions WHERE id=$1 FOR SHARE NOWAIT',
          [fact.sessionId],
        );
        await read.query(
          'SELECT token_hash FROM whaleu_identity.access_tokens WHERE token_hash=$1 FOR SHARE NOWAIT',
          [fact.tokenHash],
        );
        if (fact.postId)
          await read.query(
            'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR SHARE NOWAIT',
            [fact.postId],
          );
        if (fact.grantId)
          await read.query(
            'SELECT id FROM whaleu_authorization.role_grants WHERE id=$1 FOR SHARE NOWAIT',
            [fact.grantId],
          );
      }
      for (const fact of facts)
        if ((await stamp(fact, read)) !== fact.stamp)
          throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
    }),
};
export async function retainCategoryCommandProof(
  input: Input,
  tx: PoolClient,
): Promise<void> {
  const row = (
    await tx.query<{
      token_until: string;
      session_until: string;
      grant_until: string | null;
    }>(
      input.grantId
        ? `SELECT t.expires_at::text AS token_until,s.absolute_expires_at::text AS session_until,g.expires_at::text AS grant_until FROM whaleu_identity.access_tokens t JOIN whaleu_identity.sessions s ON s.id=t.session_id LEFT JOIN whaleu_authorization.role_grants g ON g.id=$3 WHERE t.token_hash=$1 AND s.id=$2`
        : `SELECT t.expires_at::text AS token_until,s.absolute_expires_at::text AS session_until,NULL::text AS grant_until FROM whaleu_identity.access_tokens t JOIN whaleu_identity.sessions s ON s.id=t.session_id WHERE t.token_hash=$1 AND s.id=$2`,
      input.grantId
        ? [input.tokenHash, input.sessionId, input.grantId]
        : [input.tokenHash, input.sessionId],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('AUTHENTICATION_REQUIRED');
  registerTransactionExactDeadline(tx, row.token_until, 'ACCESS_TOKEN_EXPIRED');
  registerTransactionExactDeadline(
    tx,
    row.session_until,
    'ACCESS_TOKEN_EXPIRED',
  );
  registerTransactionExactDeadline(
    tx,
    row.grant_until,
    'AUTHORIZATION_REQUIRED',
  );
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    'command',
    Object.freeze({ ...input, stamp: await stamp(input, tx) }),
  );
}
