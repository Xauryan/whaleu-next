import type { PoolClient } from 'pg';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
export interface InstitutionalBinding {
  id: string;
  version: string;
  issuer_namespace: string;
  adapter_id: string;
  campus_id: string;
  institution_id: string;
  origin_region_id: string;
  policy_reference: string;
  purpose: string;
  audience: string;
  consent_version: string;
  supports_student_number: boolean;
  enabled: boolean;
  source_fingerprint: string;
}
export async function readInstitutionalBinding(
  campusId: string,
  tx: PoolClient,
) {
  return (
    await tx.query<{
      binding: InstitutionalBinding;
      source: unknown;
      fingerprint: string;
    }>(
      `SELECT whaleu_verification.institutional_binding_fingerprint(b.id) fingerprint,to_jsonb(b) binding,jsonb_build_array(to_jsonb(b),b.xmin::text,to_jsonb(h),h.xmin::text) source FROM whaleu_verification.institutional_binding_heads h JOIN whaleu_verification.institutional_bindings b ON b.id=h.binding_id AND b.campus_id=h.campus_id WHERE h.campus_id=$1`,
      [campusId],
    )
  ).rows[0];
}
async function current(account: string, request: string, tx: PoolClient) {
  return (
    await tx.query<{ state: unknown }>(
      `SELECT jsonb_build_object('request',to_jsonb(q),'relevant',whaleu_verification.relevant_fact_witness(q.account_id),'binding',jsonb_build_array(to_jsonb(b),b.xmin::text,to_jsonb(h),h.xmin::text),'result',to_jsonb(r),'subject',to_jsonb(s),'completion',to_jsonb(c),'triggers', (SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,t.tgfoid::text) ORDER BY t.tgrelid,t.tgname) FROM pg_trigger t WHERE t.tgrelid IN ('whaleu_verification.relevant_fact_generations'::regclass,'whaleu_verification.account_heads'::regclass,'whaleu_verification.institutional_requests'::regclass) AND NOT t.tgisinternal)) state
 FROM whaleu_verification.institutional_requests q JOIN whaleu_verification.institutional_bindings b ON b.id=q.binding_id
 JOIN whaleu_verification.institutional_binding_heads h ON h.campus_id=b.campus_id
 LEFT JOIN whaleu_verification.institutional_results r ON r.id=q.result_id
 LEFT JOIN whaleu_verification.institutional_subjects s ON s.issuer_namespace=r.issuer_namespace AND s.provider_subject=r.provider_subject
 LEFT JOIN whaleu_verification.institutional_completions c ON c.id=q.completion_id WHERE q.account_id=$1 AND q.request_id=$2 AND whaleu_verification.institutional_context_current(q) AND whaleu_verification.institutional_continuity_valid()`,
      [account, request],
    )
  ).rows[0]?.state;
}
interface ProofFact {
  account: string;
  request: string;
  fingerprint: string;
  completion: string | null;
}
const proof: RequiredTransactionProof<ProofFact> = {
  maximumFacts: 1,
  failureCode: 'INSTITUTIONAL_SSO_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'INSTITUTIONAL_SSO_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_verification.relevant_fact_generations,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,whaleu_verification.institutional_bindings,whaleu_verification.institutional_binding_heads,whaleu_verification.institutional_requests,whaleu_verification.institutional_results,whaleu_verification.institutional_subjects,whaleu_verification.institutional_completions,whaleu_verification.institutional_uid_results IN SHARE MODE NOWAIT',
      );
      for (const f of facts) {
        if (
          ownerFingerprint(await current(f.account, f.request, read)) !==
          f.fingerprint
        )
          throw new ApplicationError('INSTITUTIONAL_SSO_UNAVAILABLE');
        if (f.completion) {
          const row = (
            await read.query<{ valid: boolean }>(
              'SELECT whaleu_verification.institutional_completion_valid($1) valid',
              [f.completion],
            )
          ).rows[0];
          if (!row?.valid)
            throw new ApplicationError('INSTITUTIONAL_SSO_UNAVAILABLE');
        }
      }
    }),
};
export async function requireInstitutionalCurrent(
  account: string,
  request: string,
  completion: string | null,
  tx: PoolClient,
) {
  const state = await current(account, request, tx);
  if (!state) throw new ApplicationError('INSTITUTIONAL_SSO_UNAVAILABLE');
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    request,
    Object.freeze({
      account,
      request,
      completion,
      fingerprint: ownerFingerprint(state),
    }),
  );
}
