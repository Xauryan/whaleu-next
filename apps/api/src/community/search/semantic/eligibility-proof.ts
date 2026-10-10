import type { PoolClient } from 'pg';
import {
  boundedOwnerProof,
  ownerFingerprint,
  requiredOwnerEpoch,
} from '../../../database/required-owner-proof.js';
import type { CountEpochRow } from '../../../database/count-proof.js';
import { communityCountProofOwner } from '../../count-epochs.js';
import { safetyCountProofOwner } from '../../../safety/count-epochs.js';
import { campusCountProofOwner } from '../../../campus/count-epochs.js';
import { mediaCountProofOwner } from '../../../media/required-proof.js';
import { ApplicationError } from '../../../http/application-error.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  transactionReadEpoch,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../../database/transaction-deadlines.js';

const unavailable = () => new ApplicationError('COMMUNITY_UNAVAILABLE');
const owners = [
  communityCountProofOwner,
  safetyCountProofOwner,
  campusCountProofOwner,
].map((owner) => requiredOwnerEpoch(owner, 'COMMUNITY_UNAVAILABLE'));
const mediaStarts = new WeakMap<
  PoolClient,
  { epoch: object; fingerprint: string | null }
>();
function fingerprint(rows: readonly CountEpochRow[]): string {
  if (
    rows.length !== 128 ||
    rows.some(
      (row, index) =>
        row.slot !== index ||
        row.version !== 1 ||
        !/^(0|[1-9][0-9]*)$/.test(row.epoch) ||
        BigInt(row.epoch) > 9223372036854775807n,
    )
  )
    throw unavailable();
  return ownerFingerprint(rows);
}
const mediaProof: RequiredTransactionProof<string> = {
  maximumFacts: 256,
  failureCode: 'COMMUNITY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'COMMUNITY_UNAVAILABLE', async (read) => {
      if (!(await mediaCountProofOwner.fence(read))) throw unavailable();
      const current = fingerprint(await mediaCountProofOwner.capture(read));
      if (facts.some((fact) => fact !== current)) throw unavailable();
    }),
};
/** Capture before any structural enumeration, even an empty scope. A missing
 * optional Media installation can be ignored only when no Media is consumed.
 * No required fact/deadline is enrolled by this rollbackable preliminary read. */
export async function captureSemanticMediaProof(tx: PoolClient): Promise<void> {
  const epoch = transactionReadEpoch(tx);
  if (!epoch) throw unavailable();
  if (mediaStarts.get(tx)?.epoch === epoch) return;
  const checkpoint = checkpointTransactionDeadlines(tx);
  await tx.query('SAVEPOINT semantic_media_start');
  let value: string | null = null;
  try {
    await boundedOwnerProof(tx, 'COMMUNITY_UNAVAILABLE', async (read) => {
      const settings = (
        await read.query<{ isolation: string; capacity: number }>(
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
        throw unavailable();
      value = fingerprint(await mediaCountProofOwner.capture(read));
    });
  } catch {
    await tx.query('ROLLBACK TO SAVEPOINT semantic_media_start');
    restoreTransactionDeadlines(tx, checkpoint);
  }
  await tx.query('RELEASE SAVEPOINT semantic_media_start');
  mediaStarts.set(tx, { epoch: transactionReadEpoch(tx)!, fingerprint: value });
}
/** Only a previously captured whole-scope start can become mandatory. Capturing
 * at the first image would miss earlier inserts and negative dependencies. */
export function requireSemanticMediaProof(tx: PoolClient): void {
  const start = mediaStarts.get(tx);
  if (
    !start ||
    start.epoch !== transactionReadEpoch(tx) ||
    start.fingerprint === null
  )
    throw unavailable();
  enableRequiredTransactionProof(tx, mediaProof);
  registerRequiredTransactionFact(
    tx,
    mediaProof,
    start.fingerprint,
    start.fingerprint,
  );
}
export async function captureSemanticEligibilityProof(
  tx: PoolClient,
): Promise<void> {
  for (const capture of owners) await capture(tx);
  await captureSemanticMediaProof(tx);
}
