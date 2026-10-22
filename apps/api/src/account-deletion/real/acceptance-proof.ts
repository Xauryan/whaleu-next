import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
  type RequiredTransactionProof,
} from '../../database/transaction-deadlines.js';
import {
  requireSessionEpoch,
  sessionEpoch,
  retainSessionEpochSchema,
} from '../../identity/session-epoch.js';
import { retainPreparationSchema } from './qualification.js';
import { retainRequestSchema } from './request-qualification.js';

const unavailable = () => new ApplicationError('REAL_DELETION_UNAVAILABLE');
const rejected = () => new ApplicationError('REAL_DELETION_SCOPE_UNAVAILABLE');
interface SessionRow {
  account_id: string;
  session_id: string;
  generation: string;
  current_epoch: string;
  issued_epoch: string;
  status: string;
  lifecycle: string;
  revoked: boolean;
  live: boolean;
  token_until: string;
  absolute_until: string;
}
export interface AcceptanceSessionInput {
  readonly requestId: string;
  readonly accountId: string;
  readonly expectedGeneration: string;
  readonly accessHash: string;
}
export interface AcceptanceSessionFact extends AcceptanceSessionInput {
  readonly sessionId: string;
  readonly previousEpoch: string;
  readonly nextEpoch: string;
}
/** Dedicated acceptance proof, never the ordinary active-session proof. Its one
 * exception is the exact request born in THIS transaction with exactly epoch+1.
 * This module grants no request authority: absent0182 tables/seal fail closed. */
const acceptanceProof: RequiredTransactionProof<AcceptanceSessionFact> = {
  maximumFacts: 1,
  failureCode: 'REAL_DELETION_SCOPE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'REAL_DELETION_SCOPE_UNAVAILABLE', async (read) => {
      const fact = facts[0];
      if (!fact || facts.length !== 1) throw rejected();
      await read.query(
        'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR UPDATE NOWAIT',
        [fact.accountId],
      );
      await read.query(
        'SELECT id FROM whaleu_identity.sessions WHERE id=$1 AND account_id=$2 FOR SHARE NOWAIT',
        [fact.sessionId, fact.accountId],
      );
      await read.query(
        'SELECT token_hash FROM whaleu_identity.access_tokens WHERE token_hash=$1 AND session_id=$2 FOR SHARE NOWAIT',
        [fact.accessHash, fact.sessionId],
      );
      const result = await read.query<{ valid: boolean }>(
        `/* real-acceptance-session-final-v1 */
        SELECT a.status='active' AND a.lifecycle='cooling'
          AND a.real_deletion_request_id=r.id AND a.deletion_request_id IS NULL
          AND a.lifecycle_generation=r.generation AND r.generation=$4::bigint+1
          AND a.session_revocation_epoch=$6::bigint AND r.previous_epoch=$5::bigint AND r.revoked_epoch=$6::bigint
          AND s.revoked_at IS NULL AND s.issued_revocation_epoch=$5::bigint
          AND t.expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp()
          AND r.phase='cooling' AND r.revision=1
          AND r.accepted_transaction=pg_current_xact_id()
          AND r.accepting_session_id=s.id AND r.accepting_token_hash=t.token_hash
          AND r.accepted_at<=clock_timestamp() AS valid
        FROM whaleu_real_deletion.requests r
        JOIN whaleu_identity.accounts a ON a.id=r.account_id
        JOIN whaleu_identity.sessions s ON s.id=$2 AND s.account_id=a.id
        JOIN whaleu_identity.access_tokens t ON t.session_id=s.id AND t.token_hash=$3
        WHERE r.id=$1 AND r.account_id=$7`,
        [
          fact.requestId,
          fact.sessionId,
          fact.accessHash,
          fact.expectedGeneration,
          fact.previousEpoch,
          fact.nextEpoch,
          fact.accountId,
        ],
      );
      if (result.rows.length !== 1 || result.rows[0]?.valid !== true)
        throw rejected();
    }),
};

/** Caller has already acquired the exact provider identity advisory fence. Lock
 * account UPDATE from the outset, then session, then original access token.
 * Do not call IdentityService.session in this same accepting transaction: its
 * ordinary final active/old-epoch proof must remain strict and would conflict.
 * Existing schema qualification remains mandatory before and after the write. */
export async function retainAcceptanceSession(
  tx: PoolClient,
  supplied: AcceptanceSessionInput,
): Promise<AcceptanceSessionFact> {
  // Detach every caller-owned field before the first schema/lock await.
  const parsed = z
    .strictObject({
      requestId: z.uuid(),
      accountId: z.uuid(),
      expectedGeneration: z.string(),
      accessHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .safeParse(supplied);
  if (!parsed.success) throw rejected();
  const input = Object.freeze(parsed.data);
  const generation = sessionEpoch(input.expectedGeneration);
  if (BigInt(generation) >= 9223372036854775807n) throw rejected();
  await retainPreparationSchema(tx);
  await retainRequestSchema(tx);
  await retainSessionEpochSchema(tx);
  await tx.query(
    'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR UPDATE NOWAIT',
    [input.accountId],
  );
  const reference = (
    await tx.query<{ session_id: string }>(
      'SELECT s.id session_id FROM whaleu_identity.sessions s JOIN whaleu_identity.access_tokens t ON t.session_id=s.id WHERE t.token_hash=$1 AND s.account_id=$2',
      [input.accessHash, input.accountId],
    )
  ).rows[0];
  if (!reference) throw rejected();
  await tx.query(
    'SELECT id FROM whaleu_identity.sessions WHERE id=$1 AND account_id=$2 FOR SHARE NOWAIT',
    [reference.session_id, input.accountId],
  );
  await tx.query(
    'SELECT token_hash FROM whaleu_identity.access_tokens WHERE token_hash=$1 AND session_id=$2 FOR SHARE NOWAIT',
    [input.accessHash, reference.session_id],
  );
  const row = (
    await tx.query<SessionRow>(
      `SELECT a.id account_id,s.id session_id,a.lifecycle_generation::text generation,
        a.session_revocation_epoch::text current_epoch,s.issued_revocation_epoch::text issued_epoch,
        a.status,a.lifecycle,s.revoked_at IS NOT NULL revoked,
        (t.expires_at>clock_timestamp() AND s.absolute_expires_at>clock_timestamp()) live,
        t.expires_at::text token_until,s.absolute_expires_at::text absolute_until
      FROM whaleu_identity.accounts a JOIN whaleu_identity.sessions s ON s.account_id=a.id
      JOIN whaleu_identity.access_tokens t ON t.session_id=s.id
      WHERE a.id=$1 AND s.id=$2 AND t.token_hash=$3`,
      [input.accountId, reference.session_id, input.accessHash],
    )
  ).rows[0];
  if (
    !row ||
    row.status !== 'active' ||
    row.lifecycle !== 'active' ||
    row.revoked ||
    row.live !== true ||
    row.generation !== generation
  )
    throw rejected();
  const epoch = requireSessionEpoch(row.issued_epoch, row.current_epoch);
  if (BigInt(epoch) >= 9223372036854775807n) throw unavailable();
  const fact: AcceptanceSessionFact = Object.freeze({
    ...input,
    expectedGeneration: generation,
    sessionId: row.session_id,
    previousEpoch: epoch,
    nextEpoch: String(BigInt(epoch) + 1n),
  });
  registerTransactionExactDeadline(tx, row.token_until, 'ACCESS_TOKEN_EXPIRED');
  registerTransactionExactDeadline(
    tx,
    row.absolute_until,
    'ACCESS_TOKEN_EXPIRED',
  );
  enableRequiredTransactionProof(tx, acceptanceProof);
  registerRequiredTransactionFact(tx, acceptanceProof, input.requestId, fact);
  return fact;
}
