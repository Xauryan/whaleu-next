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
async function canonicalFact(
  accountId: string,
  kind: Exclude<Kind, 'temporary'>,
  tx: PoolClient,
) {
  const row = (
    await tx.query<FactRow>(
      `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now) SELECT ${projection},h.snapshot_id,instant.now,
     coalesce(a.assertion_state<>'verified' OR (isfinite(a.verified_at) AND a.verified_at<=instant.now AND ((a.expiry_kind='policy_exempt' AND a.expires_at IS NULL) OR (a.expiry_kind='at' AND isfinite(a.expires_at) AND a.expires_at>a.verified_at AND a.expires_at>instant.now))),false) exact_time
     FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id AND s.account_id=h.account_id
     JOIN whaleu_verification.assertions a ON a.id=CASE WHEN $2='phone' THEN s.phone_assertion_id ELSE s.affiliation_assertion_id END AND a.account_id=h.account_id AND a.fact_kind=$2 CROSS JOIN instant WHERE h.account_id=$1`,
      [accountId, kind],
    )
  ).rows[0];
  const policy = row
    ? assertionStatus(row, accountId, kind, row.now)
    : 'unavailable';
  const status: Status =
    policy === 'verified'
      ? row?.exact_time === true
        ? 'verified'
        : 'unavailable'
      : policy === 'unavailable'
        ? 'unavailable'
        : 'unverified';
  return {
    status,
    until: status === 'verified' ? (row!.expires_at?.getTime() ?? null) : null,
    fingerprint: ownerFingerprint([
      row?.snapshot_id ?? null,
      row?.id ?? null,
      status,
      row?.exact_time ?? false,
    ]),
  };
}
async function temporaryFact(accountId: string, tx: PoolClient) {
  const row = (
    await tx.query<{
      id: string;
      issuer_version: string;
      status: Status;
      valid_until: Date;
      issuer_until: Date | null;
    }>(
      `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
     SELECT a.id,i.xmin::text issuer_version,a.valid_until,i.valid_until issuer_until,
     CASE WHEN a.purpose<>'private_messages' OR a.coverage<>'complete' OR a.provenance<>'accepted' OR
       i.issuer IS NULL OR NOT i.active OR i.purpose<>'private_messages' OR i.coverage<>'complete' OR i.provenance<>'accepted' OR
       NOT isfinite(i.valid_from) OR i.valid_from>a.effective_at OR (i.valid_until IS NOT NULL AND (NOT isfinite(i.valid_until) OR i.valid_until<=instant.now)) OR
       a.effective_at>instant.now THEN 'unavailable'
       WHEN a.state='verified' AND a.valid_until>instant.now THEN 'verified' ELSE 'unverified' END status
     FROM whaleu_verification.dm_base_heads h JOIN whaleu_verification.dm_base_assertions a ON a.id=h.assertion_id AND a.account_id=h.account_id
     LEFT JOIN whaleu_verification.dm_issuers i ON i.issuer=a.issuer AND i.policy_reference=a.policy_reference CROSS JOIN instant WHERE h.account_id=$1`,
      [accountId],
    )
  ).rows[0];
  const status: Status = row?.status ?? 'unavailable';
  return {
    status,
    until:
      status === 'verified'
        ? Math.min(
            row!.valid_until.getTime(),
            row!.issuer_until?.getTime() ?? Infinity,
          )
        : null,
    fingerprint: ownerFingerprint([
      row?.id ?? null,
      row?.issuer_version ?? null,
      status,
    ]),
  };
}
const proof: RequiredTransactionProof<Observation> = {
  maximumFacts: 32,
  failureCode: 'VERIFICATION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'VERIFICATION_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,whaleu_verification.dm_base_heads,whaleu_verification.dm_base_assertions,whaleu_verification.dm_issuers IN SHARE MODE NOWAIT',
      );
      for (const fact of facts) {
        const fresh =
          fact.kind === 'temporary'
            ? await temporaryFact(fact.accountId, read)
            : await canonicalFact(fact.accountId, fact.kind, read);
        if (fresh.fingerprint !== fact.fingerprint)
          throw new ApplicationError('VERIFICATION_UNAVAILABLE');
      }
    }),
};
/** DM admission is phone AND (canonical affiliation OR DM-purpose temporary).
 * Neither rating/errand grants, account roles, nor campus selection is authority.
 * Issuers are an empty-by-default owner ledger; this module never issues grants. */
@Injectable()
export class DmVerificationFacade {
  private async fact(accountId: string, kind: Kind, tx: PoolClient) {
    enableRequiredTransactionProof(tx, proof);
    await tx.query(
      kind === 'temporary'
        ? 'SELECT account_id FROM whaleu_verification.dm_base_heads WHERE account_id=$1 FOR SHARE'
        : 'SELECT account_id FROM whaleu_verification.account_heads WHERE account_id=$1 FOR SHARE',
      [accountId],
    );
    const fact =
      kind === 'temporary'
        ? await temporaryFact(accountId, tx)
        : await canonicalFact(accountId, kind, tx);
    registerRequiredTransactionFact(
      tx,
      proof,
      `${accountId}:${kind}:${fact.fingerprint}`,
      Object.freeze({ accountId, kind, fingerprint: fact.fingerprint }),
    );
    if (fact.status === 'verified')
      registerTransactionDeadline(tx, fact.until, 'VERIFICATION_UNAVAILABLE');
    return fact.status;
  }
  async require(
    accountId: string,
    tx: PoolClient,
    options: { phone: boolean },
  ): Promise<void> {
    if (options.phone) {
      const phone = await this.fact(accountId, 'phone', tx);
      if (phone === 'unavailable')
        throw new ApplicationError('VERIFICATION_UNAVAILABLE');
      if (phone !== 'verified')
        throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
    }
    const affiliation = await this.fact(accountId, 'affiliation', tx);
    if (affiliation === 'verified') return;
    const temporary = await this.fact(accountId, 'temporary', tx);
    if (temporary === 'verified') return;
    if (affiliation === 'unavailable' || temporary === 'unavailable')
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    throw new ApplicationError('AFFILIATION_VERIFICATION_REQUIRED');
  }
}
