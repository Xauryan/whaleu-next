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
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import type { AssertionRecord } from './contracts.js';
import type { PublicationAffiliation } from './publication-eligibility.source.js';
import { assertionStatus } from './policy.js';
type Kind = 'phone' | 'affiliation' | 'temporary';
type Status = 'verified' | 'unverified' | 'unavailable';
interface Observation {
  accountId: string;
  kind: Kind;
  fingerprint: string;
}
interface FactRow extends Omit<AssertionRecord, 'student_number'> {
  snapshot_id: string;
  exact_time: boolean;
  now: Date;
}
const projection = `a.id,a.account_id,a.fact_kind,a.assertion_state,a.coverage_state,a.provenance_state,a.method,a.source_reference,a.policy_reference,a.source_account_id,a.issuer_institution_id,a.source_issuer_institution_id,a.origin_region_id,a.phone_binding_reference,a.verified_at,a.expiry_kind,a.expires_at`;
async function readFact(
  accountId: string,
  kind: Exclude<Kind, 'temporary'>,
  tx: PoolClient,
) {
  const row = (
    await tx.query<FactRow>(
      `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now) SELECT ${projection},h.snapshot_id,instant.now,coalesce(a.assertion_state<>'verified' OR (isfinite(a.verified_at) AND a.verified_at<=instant.now AND ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR (a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at AND a.expires_at>instant.now))),false) exact_time FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id AND s.account_id=h.account_id JOIN whaleu_verification.assertions a ON a.id=CASE WHEN $2='phone' THEN s.phone_assertion_id ELSE s.affiliation_assertion_id END AND a.account_id=h.account_id AND a.fact_kind=$2 CROSS JOIN instant WHERE h.account_id=$1`,
      [accountId, kind],
    )
  ).rows[0];
  const policy = row
    ? assertionStatus(row, accountId, kind, row.now)
    : 'unavailable';
  const status: Status =
    policy === 'verified' && row?.exact_time !== true
      ? 'unavailable'
      : policy === 'verified'
        ? 'verified'
        : policy === 'unavailable'
          ? 'unavailable'
          : 'unverified';
  return {
    row,
    status,
    fingerprint: ownerFingerprint([
      row?.snapshot_id ?? null,
      row?.id ?? null,
      status,
      row?.exact_time ?? false,
    ]),
  };
}
interface TemporaryRow {
  id: string;
  status: Status;
  valid_until: Date;
}
async function readTemporary(accountId: string, tx: PoolClient) {
  const row = (
    await tx.query<TemporaryRow>(
      `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now) SELECT a.id,a.valid_until,CASE WHEN a.coverage<>'complete' OR a.provenance<>'accepted' OR length(btrim(a.issuer))=0 OR length(btrim(a.source_reference))=0 OR length(btrim(a.policy_reference))=0 OR a.effective_at>instant.now THEN 'unavailable' WHEN a.state='verified' AND a.valid_until>instant.now THEN 'verified' ELSE 'unverified' END status FROM whaleu_verification.rating_base_heads h JOIN whaleu_verification.rating_base_assertions a ON a.id=h.assertion_id AND a.account_id=h.account_id CROSS JOIN instant WHERE h.account_id=$1`,
      [accountId],
    )
  ).rows[0];
  const status: Status = row?.status ?? 'unavailable';
  return {
    row,
    status,
    fingerprint: ownerFingerprint([row?.id ?? null, status]),
  };
}
const proof: RequiredTransactionProof<Observation> = {
  maximumFacts: 16,
  failureCode: 'VERIFICATION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'VERIFICATION_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,whaleu_verification.rating_base_heads,whaleu_verification.rating_base_assertions IN SHARE MODE NOWAIT',
      );
      for (const f of facts) {
        const fresh =
          f.kind === 'temporary'
            ? await readTemporary(f.accountId, read)
            : await readFact(f.accountId, f.kind, read);
        if (fresh.fingerprint !== f.fingerprint)
          throw new ApplicationError('VERIFICATION_UNAVAILABLE');
      }
    }),
};
/** Rating-purpose facts only. No phone value or student number is selected. */
@Injectable()
export class RatingVerificationFacade {
  private async fact(
    accountId: string,
    kind: Exclude<Kind, 'temporary'>,
    tx: PoolClient,
  ) {
    enableRequiredTransactionProof(tx, proof);
    await tx.query(
      'SELECT account_id FROM whaleu_verification.account_heads WHERE account_id=$1 FOR SHARE',
      [accountId],
    );
    const fact = await readFact(accountId, kind, tx);
    registerRequiredTransactionFact(
      tx,
      proof,
      `${accountId}:${kind}:${fact.fingerprint}`,
      Object.freeze({ accountId, kind, fingerprint: fact.fingerprint }),
    );
    if (fact.status === 'verified')
      registerTransactionDeadline(
        tx,
        fact.row!.expires_at?.getTime() ?? null,
        'VERIFICATION_UNAVAILABLE',
      );
    return fact;
  }
  async phone(accountId: string, tx: PoolClient) {
    const fact = await this.fact(accountId, 'phone', tx);
    return { status: fact.status, fingerprint: fact.fingerprint };
  }
  async affiliation(
    accountId: string,
    tx: PoolClient,
  ): Promise<PublicationAffiliation & { fingerprint: string }> {
    const fact = await this.fact(accountId, 'affiliation', tx),
      a = fact.row;
    if (fact.status !== 'verified')
      return { status: fact.status, fingerprint: fact.fingerprint };
    if (!a?.origin_region_id || !a.issuer_institution_id)
      return { status: 'unavailable', fingerprint: fact.fingerprint };
    return {
      status: 'verified',
      assertionId: a.id,
      snapshotId: a.snapshot_id,
      institutionId: a.issuer_institution_id,
      originRegionId: a.origin_region_id,
      validUntil: a.expires_at?.getTime() ?? null,
      fingerprint: fact.fingerprint,
    };
  }
  async temporary(accountId: string, tx: PoolClient) {
    enableRequiredTransactionProof(tx, proof);
    await tx.query(
      'SELECT account_id FROM whaleu_verification.rating_base_heads WHERE account_id=$1 FOR SHARE',
      [accountId],
    );
    const fact = await readTemporary(accountId, tx);
    registerRequiredTransactionFact(
      tx,
      proof,
      `${accountId}:temporary:${fact.fingerprint}`,
      Object.freeze({
        accountId,
        kind: 'temporary' as const,
        fingerprint: fact.fingerprint,
      }),
    );
    if (fact.status === 'verified')
      registerTransactionDeadline(
        tx,
        fact.row!.valid_until.getTime(),
        'VERIFICATION_UNAVAILABLE',
      );
    return { status: fact.status, fingerprint: fact.fingerprint };
  }
}
