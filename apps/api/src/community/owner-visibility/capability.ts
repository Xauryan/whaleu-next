import type { PoolClient } from 'pg';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import { registerOptionalTransactionProof } from '../../database/transaction-deadlines.js';

interface SafetyCapabilityHead {
  block_coverage: string;
  restriction_coverage: string;
  provenance: string;
  actions_allowed: boolean | null;
  valid_until: Date | null;
  version: string;
}
const projection =
  'block_coverage,restriction_coverage,provenance,actions_allowed,valid_until,xmin::text AS version';
async function readHead(
  actor: string,
  tx: PoolClient,
): Promise<SafetyCapabilityHead | null> {
  return (
    (
      await tx.query<SafetyCapabilityHead>(
        `SELECT ${projection} FROM whaleu_safety.account_heads WHERE account_id=$1 FOR SHARE NOWAIT`,
        [actor],
      )
    ).rows[0] ?? null
  );
}
function allowed(head: SafetyCapabilityHead | null, now: number): boolean {
  return (
    !!head &&
    head.block_coverage === 'complete' &&
    head.restriction_coverage === 'complete' &&
    head.provenance === 'native_account_creation' &&
    head.actions_allowed === true &&
    typeof head.version === 'string' &&
    /^\d+$/.test(head.version) &&
    Number.isFinite(now) &&
    (head.valid_until === null ||
      (Number.isFinite(head.valid_until.getTime()) &&
        head.valid_until.getTime() > now))
  );
}
/** Optional action hint only. The exact returned object must remain mutable and
 * private until commit. Uncertain Safety narrows restore capability without
 * blocking owner metadata, hide withdrawal, receipt or cancellation recovery. */
export async function retainOwnerRestoreCapability(
  actor: string,
  view: { ownerHidden: boolean; canChange: boolean },
  tx: PoolClient,
): Promise<void> {
  if (!view.canChange || !view.ownerHidden) return;
  view.canChange = false;
  let head: SafetyCapabilityHead | null = null;
  let available = false;
  let punishmentFingerprint: string | null = null;
  await tx.query('SAVEPOINT owner_restore_capability');
  try {
    await boundedOwnerProof(tx, 'SAFETY_UNAVAILABLE', async (read) => {
      head = await readHead(actor, read);
      const now =
        (
          await read.query<{ now: Date }>('SELECT clock_timestamp() AS now')
        ).rows[0]?.now.getTime() ?? NaN;
      const punishment = (
        await read.query<{ allowed: boolean; fingerprint: string }>(
          `SELECT whaleu_safety.account_punishment_allows($1,'interaction') allowed,
         whaleu_safety.account_punishment_fingerprint($1) fingerprint`,
          [actor],
        )
      ).rows[0];
      available = allowed(head, now) && punishment?.allowed === true;
      punishmentFingerprint = punishment?.fingerprint ?? null;
    });
  } catch {
    // An unsuccessful rollback is fatal; no poisoned transaction is disguised
    // as a usable minimal response. A successful rollback releases optional locks.
    await tx.query('ROLLBACK TO SAVEPOINT owner_restore_capability');
    await tx.query('RELEASE SAVEPOINT owner_restore_capability');
    return;
  }
  if (!available)
    await tx.query('ROLLBACK TO SAVEPOINT owner_restore_capability');
  await tx.query('RELEASE SAVEPOINT owner_restore_capability');
  if (!available || !head) return;
  const initial = head as SafetyCapabilityHead;
  const fingerprint = ownerFingerprint(initial);
  registerOptionalTransactionProof(tx, {
    until: initial.valid_until?.getTime() ?? null,
    validate: async () => {
      const current = await readHead(actor, tx);
      const now =
        (
          await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
        ).rows[0]?.now.getTime() ?? NaN;
      await tx.query(`LOCK TABLE whaleu_safety.account_punishments,
        whaleu_safety.account_punishment_heads,
        whaleu_safety.account_punishment_terminals IN SHARE MODE NOWAIT`);
      const punishment = (
        await tx.query<{ allowed: boolean; fingerprint: string }>(
          `SELECT whaleu_safety.account_punishment_allows($1,'interaction') allowed,
         whaleu_safety.account_punishment_fingerprint($1) fingerprint`,
          [actor],
        )
      ).rows[0];
      return (
        allowed(current, now) &&
        ownerFingerprint(current) === fingerprint &&
        punishment?.allowed === true &&
        punishment.fingerprint === punishmentFingerprint
      );
    },
    invalidate: () => {
      view.canChange = false;
    },
  });
  view.canChange = true;
}
