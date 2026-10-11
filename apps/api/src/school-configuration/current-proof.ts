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
import type { SchoolEntryKey } from './contracts.js';
export async function lockSchoolConfigurationEntry(
  regionId: string,
  key: SchoolEntryKey,
  tx: PoolClient,
  write = true,
): Promise<void> {
  await tx.query(
    `SELECT pg_advisory_xact_lock${write ? '' : '_shared'}(hashtextextended('whaleu:school-configuration:v1:'||$1||':'||$2,0))`,
    [regionId, key],
  );
}
interface Fact {
  campusId: string | null;
  regionId: string | null;
  key: SchoolEntryKey | null;
  fingerprint: string;
}
async function state(fact: Omit<Fact, 'fingerprint'>, tx: PoolClient) {
  const campus =
    fact.campusId === null
      ? null
      : (
          await tx.query(
            `SELECT to_jsonb(c) c,c.xmin::text cv,to_jsonb(i) i,i.xmin::text iv,to_jsonb(a) a,a.xmin::text av,to_jsonb(r) r,r.xmin::text rv FROM whaleu_campus.campuses c JOIN whaleu_campus.institutions i ON i.id=c.institution_id LEFT JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id LEFT JOIN whaleu_campus.operating_regions r ON r.id=a.operating_region_id WHERE c.id=$1`,
            [fact.campusId],
          )
        ).rows;
  const entry =
    fact.regionId === null || fact.key === null
      ? null
      : (
          await tx.query(
            `SELECT to_jsonb(e) entry,e.xmin::text version,to_jsonb(p) source,p.xmin::text source_version FROM whaleu_school_configuration.entries e JOIN whaleu_school_configuration.publications p USING(region_id,entry_key,revision) WHERE e.region_id=$1 AND e.entry_key=$2`,
            [fact.regionId, fact.key],
          )
        ).rows;
  return ownerFingerprint({ campus, entry });
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 32,
  failureCode: 'SCHOOL_CONFIGURATION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'SCHOOL_CONFIGURATION_UNAVAILABLE', async (read) => {
      if (facts.some((fact) => fact.campusId !== null))
        await read.query(
          'LOCK TABLE whaleu_campus.campuses,whaleu_campus.institutions,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions IN SHARE MODE NOWAIT',
        );
      if (facts.some((fact) => fact.regionId !== null && fact.key !== null))
        await read.query(
          'LOCK TABLE whaleu_school_configuration.entries,whaleu_school_configuration.publications IN SHARE MODE NOWAIT',
        );
      for (const fact of facts) {
        if (
          fact.regionId !== null &&
          fact.key !== null &&
          (
            await read.query<{ locked: boolean }>(
              `SELECT pg_try_advisory_xact_lock_shared(hashtextextended('whaleu:school-configuration:v1:'||$1||':'||$2,0)) locked`,
              [fact.regionId, fact.key],
            )
          ).rows[0]?.locked !== true
        )
          throw new ApplicationError('SCHOOL_CONFIGURATION_UNAVAILABLE');
        if ((await state(fact, read)) !== fact.fingerprint)
          throw new ApplicationError('SCHOOL_CONFIGURATION_UNAVAILABLE');
      }
    }),
};
export async function requireSchoolCurrent(
  fact: Omit<Fact, 'fingerprint'>,
  tx: PoolClient,
): Promise<void> {
  enableRequiredTransactionProof(tx, proof);
  const fingerprint = await state(fact, tx);
  registerRequiredTransactionFact(
    tx,
    proof,
    `${fact.campusId}:${fact.regionId}:${fact.key}:${fingerprint}`,
    Object.freeze({ ...fact, fingerprint }),
  );
}
