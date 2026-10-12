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
}
interface Fact extends Input {
  stamp: string;
}
async function stamp(input: Input, tx: PoolClient): Promise<string> {
  const row = (
    await tx.query<{ value: unknown }>(
      `SELECT jsonb_build_object(
      'account',(SELECT to_jsonb(a) FROM whaleu_identity.accounts a WHERE id=$1),
      'session',(SELECT to_jsonb(s) FROM whaleu_identity.sessions s WHERE id=$2),
      'token',(SELECT to_jsonb(t) FROM whaleu_identity.access_tokens t WHERE token_hash=$3 AND session_id=$2),
      'post',(SELECT jsonb_build_array(id,account_id,deleted_at) FROM whaleu_community.posts WHERE id=$4),
      'ownerVisibility',(SELECT jsonb_build_array(to_jsonb(v),v.xmin::text) FROM whaleu_community.post_owner_visibility v WHERE post_id=$4)
    ) AS value`,
      [input.actor, input.sessionId, input.tokenHash, input.postId],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('POST_OWNER_VISIBILITY_UNAVAILABLE');
  return ownerFingerprint(row.value);
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 1,
  failureCode: 'POST_OWNER_VISIBILITY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'POST_OWNER_VISIBILITY_UNAVAILABLE', async (read) => {
      for (const fact of facts) {
        // These exact rows were locked before the snapshot. The migration makes
        // every overlay writer take the parent UPDATE lock, including first insert.
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
        if ((await stamp(fact, read)) !== fact.stamp)
          throw new ApplicationError('POST_OWNER_VISIBILITY_UNAVAILABLE');
      }
    }),
};
export async function retainOwnerVisibilityProof(
  input: Input,
  tx: PoolClient,
): Promise<void> {
  const expiry = (
    await tx.query<{ token_until: string; session_until: string }>(
      'SELECT t.expires_at::text token_until,s.absolute_expires_at::text session_until FROM whaleu_identity.access_tokens t JOIN whaleu_identity.sessions s ON s.id=t.session_id WHERE t.token_hash=$1 AND s.id=$2',
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
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    'owner',
    Object.freeze({ ...input, stamp: await stamp(input, tx) }),
  );
}
