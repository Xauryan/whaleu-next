import { Injectable } from '@nestjs/common';
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
async function read(id: string, tx: PoolClient, lock = false) {
  return (
    await tx.query<{ active: boolean; version: unknown }>(
      `SELECT c.is_active AND r.is_active active,jsonb_build_array(to_jsonb(c),to_jsonb(i),to_jsonb(a),to_jsonb(r)) version FROM whaleu_campus.campuses c JOIN whaleu_campus.institutions i ON i.id=c.institution_id JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id JOIN whaleu_campus.operating_regions r ON r.id=a.operating_region_id WHERE c.id=$1 ${lock ? 'FOR SHARE OF c,i,a,r' : ''}`,
      [id],
    )
  ).rows[0];
}
const proof: RequiredTransactionProof<{ id: string; version: string }> = {
  maximumFacts: 50,
  failureCode: 'COURSE_CATALOG_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'COURSE_CATALOG_UNAVAILABLE', async (current) => {
      await current.query(
        'LOCK TABLE whaleu_campus.campuses,whaleu_campus.institutions,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions IN SHARE MODE NOWAIT',
      );
      for (const f of facts) {
        const row = await read(f.id, current);
        if (!row?.active || ownerFingerprint(row.version) !== f.version)
          throw new ApplicationError('COURSE_CATALOG_UNAVAILABLE');
      }
    }),
};
/** Accepted source crosswalk supplies an internal campus UUID. A browsing selection,
 * label, institution code, student number or role never confers course authority. */
@Injectable()
export class CampusCourseScopeFacade {
  async requireCurrent(campusId: string, tx: PoolClient) {
    const row = await read(campusId, tx, true);
    if (!row?.active) throw new ApplicationError('COURSE_CATALOG_UNAVAILABLE');
    const version = ownerFingerprint(row.version);
    enableRequiredTransactionProof(tx, proof);
    registerRequiredTransactionFact(
      tx,
      proof,
      campusId + ':' + version,
      Object.freeze({ id: campusId, version }),
    );
  }
}
