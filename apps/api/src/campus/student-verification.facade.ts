import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  ownerFingerprint,
  boundedOwnerProof,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
export interface StudentCampus {
  campusId: string;
  institutionId: string;
  regionId: string;
  campusName: string;
  institutionName: string;
  version: string;
}
async function read(id: string, tx: PoolClient, lock = false) {
  return (
    await tx.query<{
      campus_id: string;
      institution_id: string;
      region_id: string;
      campus_name: string;
      institution_name: string;
      active: boolean;
      region_active: boolean;
      version: unknown;
    }>(
      `SELECT c.id campus_id,c.institution_id,a.operating_region_id region_id,c.full_name campus_name,i.name institution_name,c.is_active active,r.is_active region_active,jsonb_build_array(c.xmin::text,i.xmin::text,a.xmin::text,r.xmin::text,to_jsonb(c),to_jsonb(i),to_jsonb(a),to_jsonb(r)) version FROM whaleu_campus.campuses c JOIN whaleu_campus.institutions i ON i.id=c.institution_id JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id JOIN whaleu_campus.operating_regions r ON r.id=a.operating_region_id WHERE c.id=$1 ${lock ? 'FOR SHARE OF c,i,a,r' : ''}`,
      [id],
    )
  ).rows[0];
}
const proof: RequiredTransactionProof<{ id: string; version: string }> = {
  maximumFacts: 32,
  failureCode: 'VERIFICATION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'VERIFICATION_UNAVAILABLE', async (readTx) => {
      await readTx.query(
        'LOCK TABLE whaleu_campus.campuses,whaleu_campus.institutions,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions IN SHARE MODE NOWAIT',
      );
      for (const f of facts) {
        const row = await read(f.id, readTx);
        if (
          !row?.active ||
          !row.region_active ||
          ownerFingerprint(row.version) !== f.version
        )
          throw new ApplicationError('VERIFICATION_UNAVAILABLE');
      }
    }),
};
/** Internal UUID authority. Public Campus.institutionId is a school code and is never used here. */
@Injectable()
export class CampusStudentVerificationFacade {
  async resolve(campusId: string, tx: PoolClient): Promise<StudentCampus> {
    const row = await read(campusId, tx, true);
    if (!row?.active || !row.region_active)
      throw new ApplicationError('COMMUNITY_SCOPE_UNAVAILABLE');
    const version = ownerFingerprint(row.version);
    enableRequiredTransactionProof(tx, proof);
    registerRequiredTransactionFact(
      tx,
      proof,
      `${campusId}:${version}`,
      Object.freeze({ id: campusId, version }),
    );
    return {
      campusId: row.campus_id,
      institutionId: row.institution_id,
      regionId: row.region_id,
      campusName: row.campus_name,
      institutionName: row.institution_name,
      version,
    };
  }
}
