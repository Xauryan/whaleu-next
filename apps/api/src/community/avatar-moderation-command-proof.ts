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
import type { ModerationTarget } from '../profile/moderation/contracts.js';
import { communityCountProofOwner } from './count-epochs.js';
const code = 'PROFILE_MODERATION_UNAVAILABLE' as const;
interface Fact {
  actor: string;
  requestId: string;
  target: ModerationTarget;
  fingerprint: string;
}
function fingerprint(value: unknown): string {
  if (
    !Array.isArray(value) ||
    value.length !== 128 ||
    value.some(
      (row, slot) =>
        !Array.isArray(row) ||
        row.length !== 3 ||
        row[0] !== slot ||
        row[1] !== 1 ||
        typeof row[2] !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(row[2]) ||
        BigInt(row[2]) > 9223372036854775807n,
    )
  )
    throw new ApplicationError(code);
  return ownerFingerprint(value);
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 256,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      if (!(await communityCountProofOwner.fence(read)))
        throw new ApplicationError(code);
      await read.query(
        'LOCK TABLE whaleu_community.rating_target_link_generation IN SHARE MODE NOWAIT',
      );
      for (const fact of facts) {
        const row = (
          await read.query<{ value: unknown }>(
            'SELECT whaleu_profile.avatar_moderation_command_community($1,$2,$3,$4) value',
            [fact.actor, fact.requestId, fact.target.kind, fact.target.id],
          )
        ).rows[0];
        if (!row || fingerprint(row.value) !== fact.fingerprint)
          throw new ApplicationError(code);
      }
    }),
};
/** Only the explicit avatar command resolver uses this bridge. The first raw
 * vector remains the retained fact: the authorization rerun has the same key,
 * so it cannot replace that fact with the command's post-retirement vector.
 * Final validation requires the exact current-transaction command and reverses
 * only its SQL-proved Media effects; missing commands never fall back to raw. */
export async function retainAvatarCommandCommunity(
  actor: string,
  target: ModerationTarget,
  requestId: string,
  tx: PoolClient,
): Promise<void> {
  enableRequiredTransactionProof(tx, proof);
  const settings = (
    await tx.query<{ isolation: string; capacity: number }>(
      `SELECT current_setting('transaction_isolation') isolation,current_setting('max_connections')::integer+current_setting('max_prepared_transactions')::integer+current_setting('max_worker_processes')::integer+current_setting('max_wal_senders')::integer capacity`,
    )
  ).rows[0];
  if (
    !settings ||
    settings.isolation !== 'read committed' ||
    !Number.isInteger(settings.capacity) ||
    settings.capacity < 1 ||
    settings.capacity >= 128
  )
    throw new ApplicationError(code);
  const rows = await communityCountProofOwner.capture(tx);
  registerRequiredTransactionFact(
    tx,
    proof,
    JSON.stringify([actor, requestId, target.kind, target.id]),
    Object.freeze({
      actor,
      requestId,
      target: Object.freeze({ ...target }),
      fingerprint: fingerprint(
        rows.map((row) => [row.slot, row.version, row.epoch]),
      ),
    }),
  );
}
