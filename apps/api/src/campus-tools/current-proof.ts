import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  transactionReadEpoch,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
export async function lockToolCatalog(
  campusId: string,
  tx: PoolClient,
  write = false,
) {
  await tx.query(
    `SELECT pg_advisory_xact_lock${write ? '' : '_shared'}(hashtextextended('whaleu:campus-tools:v1:'||$1,0))`,
    [campusId],
  );
}
interface Fact {
  campusId: string;
  fingerprint: string;
  epoch: object;
}
async function state(campusId: string, tx: PoolClient) {
  const campus = (
    await tx.query(
      `SELECT to_jsonb(c) c,c.xmin::text cv,c.ctid::text ct,to_jsonb(i) i,i.xmin::text iv,i.ctid::text it,to_jsonb(a) a,a.xmin::text av,a.ctid::text at,to_jsonb(r) r,r.xmin::text rv,r.ctid::text rt FROM whaleu_campus.campuses c JOIN whaleu_campus.institutions i ON i.id=c.institution_id LEFT JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id LEFT JOIN whaleu_campus.operating_regions r ON r.id=a.operating_region_id WHERE c.id=$1`,
      [campusId],
    )
  ).rows;
  const catalog = (
    await tx.query(
      `SELECT to_jsonb(h) h,h.xmin::text hv,h.ctid::text ht,to_jsonb(c) c,c.xmin::text cv,c.ctid::text ct,to_jsonb(a) a,a.xmin::text av,a.ctid::text at FROM whaleu_campus_tools.heads h JOIN whaleu_campus_tools.catalogs c ON c.id=h.catalog_id AND c.campus_id=h.campus_id JOIN whaleu_campus_tools.admissions a ON a.id=c.admission_id AND a.catalog_id=c.id AND a.campus_id=c.campus_id AND a.input_digest=c.digest WHERE h.campus_id=$1`,
      [campusId],
    )
  ).rows;
  const media = (
    await tx.query(
      `SELECT to_jsonb(m) m,m.xmin::text mv,m.ctid::text mt,to_jsonb(p) p,p.xmin::text pv,to_jsonb(r) r,r.xmin::text rv FROM whaleu_campus_tools.media_bindings m JOIN whaleu_campus_tools.media_attempts p ON p.id=m.attempt_id JOIN whaleu_campus_tools.media_results r ON r.attempt_id=m.attempt_id JOIN whaleu_campus_tools.heads h ON h.campus_id=m.campus_id AND h.catalog_id=m.catalog_id WHERE m.campus_id=$1 ORDER BY m.id`,
      [campusId],
    )
  ).rows;
  return ownerFingerprint({ campus, catalog, media });
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 16,
  failureCode: 'CAMPUS_TOOLS_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CAMPUS_TOOLS_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_campus.campuses,whaleu_campus.institutions,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions,whaleu_campus_tools.heads,whaleu_campus_tools.catalogs,whaleu_campus_tools.admissions,whaleu_campus_tools.media_bindings,whaleu_campus_tools.media_attempts,whaleu_campus_tools.media_results IN SHARE MODE NOWAIT',
      );
      for (const fact of facts) {
        const result = await read.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_xact_lock_shared(hashtextextended('whaleu:campus-tools:v1:'||$1,0)) locked`,
          [fact.campusId],
        );
        if (
          fact.epoch !== transactionReadEpoch(tx) ||
          !result.rows[0]?.locked ||
          (await state(fact.campusId, read)) !== fact.fingerprint
        )
          throw new ApplicationError('CAMPUS_TOOLS_UNAVAILABLE');
      }
    }),
};
/** Capture original facts before any downstream source/media/provider wait. */
export async function requireToolCurrent(campusId: string, tx: PoolClient) {
  enableRequiredTransactionProof(tx, proof);
  const epoch = transactionReadEpoch(tx);
  if (!epoch) throw new ApplicationError('CAMPUS_TOOLS_UNAVAILABLE');
  const fingerprint = await state(campusId, tx);
  registerRequiredTransactionFact(
    tx,
    proof,
    `${campusId}:${fingerprint}`,
    Object.freeze({ campusId, fingerprint, epoch }),
  );
}
interface RuntimeFact {
  epoch: object;
  verify: () => boolean;
}
const runtimeProof: RequiredTransactionProof<RuntimeFact> = {
  maximumFacts: 16,
  failureCode: 'CAMPUS_TOOLS_UNAVAILABLE',
  validate: async (facts, tx) => {
    for (const fact of facts)
      if (fact.epoch !== transactionReadEpoch(tx) || !fact.verify())
        throw new ApplicationError('CAMPUS_TOOLS_UNAVAILABLE');
  },
};
/** Trusted adapter revocation is also a delivery fact, not merely an initial
 * successful check. The adapter must provide a bounded synchronous verifier. */
export function requireToolRuntime(
  key: string,
  verify: () => boolean,
  tx: PoolClient,
) {
  enableRequiredTransactionProof(tx, runtimeProof);
  const epoch = transactionReadEpoch(tx);
  if (!epoch || !verify())
    throw new ApplicationError('CAMPUS_TOOLS_UNAVAILABLE');
  registerRequiredTransactionFact(
    tx,
    runtimeProof,
    key,
    Object.freeze({ epoch, verify }),
  );
}
