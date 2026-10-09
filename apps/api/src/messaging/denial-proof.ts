import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
interface Fact {
  actor: string;
  conversationId: string;
  messageId: string | null;
  observationId: string | null;
  fingerprint: string;
}
async function snapshot(f: Omit<Fact, 'fingerprint'>, tx: PoolClient) {
  return (
    await tx.query<{ value: unknown }>(
      `SELECT jsonb_build_object(
 'conversation',(SELECT jsonb_build_array(id,next_message_seq,next_event_seq) FROM whaleu_messaging.conversations WHERE id=$2 AND (account0=$1 OR account1=$1)),
 'members',(SELECT jsonb_agg(jsonb_build_array(slot,lifetime_sent,blocked_at,read_through_seq,hidden_through_seq) ORDER BY slot) FROM whaleu_messaging.participants WHERE conversation_id=$2 AND EXISTS(SELECT 1 FROM whaleu_messaging.participants a WHERE a.conversation_id=$2 AND a.account_id=$1)),
 'message',(SELECT jsonb_build_array(id,sender_id,recalled_at) FROM whaleu_messaging.messages WHERE id=$3 AND conversation_id=$2),
 'observation',(SELECT jsonb_build_array(id,through_seq,valid_until,valid_until>clock_timestamp()) FROM whaleu_messaging.observations WHERE id=$4 AND account_id=$1 AND conversation_id=$2)) value`,
      [f.actor, f.conversationId, f.messageId, f.observationId],
    )
  ).rows[0]!.value;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 1,
  failureCode: 'DM_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'DM_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_messaging.conversations,whaleu_messaging.participants,whaleu_messaging.messages,whaleu_messaging.observations IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if (ownerFingerprint(await snapshot(fact, read)) !== fact.fingerprint)
          throw new ApplicationError('DM_UNAVAILABLE');
    }),
};
/** Preserve exact negative domain state after rolling back command side effects.
 * Source-entry, Verification and Safety denials additionally retain their own facts. */
export async function retainDmDenial(
  actor: string,
  intent: unknown,
  tx: PoolClient,
) {
  if (
    !intent ||
    typeof intent !== 'object' ||
    !('conversationId' in intent) ||
    typeof intent.conversationId !== 'string'
  )
    return;
  const fact = {
    actor,
    conversationId: intent.conversationId,
    messageId:
      'messageId' in intent && typeof intent.messageId === 'string'
        ? intent.messageId
        : null,
    observationId:
      'observationId' in intent && typeof intent.observationId === 'string'
        ? intent.observationId
        : null,
  };
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(tx, proof, actor, {
    ...fact,
    fingerprint: ownerFingerprint(await snapshot(fact, tx)),
  });
}
