import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
type Fact = {
  kind: 'entry' | 'directory' | 'authority' | 'mapping';
  id: string;
  fingerprint: string;
};
async function state(kind: Fact['kind'], id: string, tx: PoolClient) {
  if (kind === 'entry')
    return ownerFingerprint(
      (
        await tx.query(
          'SELECT *,xmin::text version FROM whaleu_announcements.native_announcements WHERE id=$1',
          [id],
        )
      ).rows,
    );
  if (kind === 'directory') {
    const rows = (
      await tx.query<{ singleton: boolean; revision: string }>(
        'SELECT * FROM whaleu_announcements.native_directory_epoch',
      )
    ).rows;
    if (
      rows.length !== 1 ||
      rows[0]?.singleton !== true ||
      !/^([1-9][0-9]*)$/.test(rows[0].revision)
    )
      throw new ApplicationError('ANNOUNCEMENTS_UNAVAILABLE');
    return ownerFingerprint(rows);
  }
  if (kind === 'authority')
    return ownerFingerprint(
      (
        await tx.query(
          'SELECT *,xmin::text version FROM whaleu_authorization.role_grants WHERE account_id=$1 ORDER BY id',
          [id],
        )
      ).rows,
    );
  const ids = JSON.parse(id) as string[];
  return ownerFingerprint({
    regions: (
      await tx.query(
        'SELECT *,xmin::text version FROM whaleu_campus.operating_regions WHERE id=ANY($1::uuid[]) ORDER BY id',
        [ids],
      )
    ).rows,
    mapping: (
      await tx.query(
        'SELECT a.*,a.xmin::text av,to_jsonb(c) campus,c.xmin::text cv FROM whaleu_campus.campus_region_assignments a JOIN whaleu_campus.campuses c ON c.id=a.campus_id WHERE a.operating_region_id=ANY($1::uuid[]) ORDER BY a.campus_id',
        [ids],
      )
    ).rows,
  });
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 128,
  failureCode: 'ANNOUNCEMENTS_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'ANNOUNCEMENTS_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_announcements.native_announcements,whaleu_announcements.native_directory_epoch,whaleu_authorization.role_grants,whaleu_campus.operating_regions,whaleu_campus.campus_region_assignments,whaleu_campus.campuses IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if ((await state(fact.kind, fact.id, read)) !== fact.fingerprint)
          throw new ApplicationError('ANNOUNCEMENTS_UNAVAILABLE');
    }),
};
export async function requireNativeCurrent(
  kind: Fact['kind'],
  id: string,
  tx: PoolClient,
) {
  enableRequiredTransactionProof(tx, proof);
  const fingerprint = await state(kind, id, tx);
  registerRequiredTransactionFact(
    tx,
    proof,
    `${kind}:${id}:${fingerprint}`,
    Object.freeze({ kind, id, fingerprint }),
  );
}
export async function lockNative(id: string, tx: PoolClient) {
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:announcement-native:v1:'||$1,0))",
    [id],
  );
}
