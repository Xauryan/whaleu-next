import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { boundedOwnerProof } from '../database/required-owner-proof.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  registerOptionalTransactionProof,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
  transactionReadEpoch,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { schoolUidSchema } from './contracts.js';
import type { SchoolUid } from './contracts.js';
const unavailable = 'SCHOOL_UID_UNAVAILABLE' as const;
interface ProjectionFact {
  account: string;
  fingerprint: string;
  until: string | null;
  value: SchoolUid;
}
const fences =
  'LOCK TABLE whaleu_identity.accounts,whaleu_identity.legacy_account_mappings,whaleu_verification.native_enrollments,whaleu_school_uid.inventory_batches,whaleu_school_uid.import_sources,whaleu_school_uid.account_heads,whaleu_school_uid.assignment_events,whaleu_school_uid.allocations,whaleu_school_uid.school_admissions,whaleu_school_uid.account_coverage,whaleu_verification.events,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions,whaleu_campus.institutions,whaleu_campus.school_identifiers IN SHARE MODE NOWAIT';
async function read(account: string, tx: PoolClient): Promise<ProjectionFact> {
  const row = (
    await tx.query<{
      fingerprint: string;
      until: string | null;
      value: unknown;
    }>(
      `SELECT whaleu_profile.moderation_hash(whaleu_school_uid.projection_facts($1)) fingerprint,whaleu_school_uid.projection($1) value,(SELECT a.expires_at::text FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision) JOIN whaleu_verification.assertions a ON(a.id,a.account_id)=(s.affiliation_assertion_id,s.account_id) WHERE h.account_id=$1) until`,
      [account],
    )
  ).rows[0];
  if (!row) throw new ApplicationError(unavailable);
  return Object.freeze({
    account,
    fingerprint: row.fingerprint,
    until: row.until,
    value: schoolUidSchema.parse(row.value),
  });
}
const required: RequiredTransactionProof<ProjectionFact> = {
  maximumFacts: 1,
  failureCode: unavailable,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, unavailable, async (readTx) => {
      await readTx.query(fences);
      for (const f of facts)
        if ((await read(f.account, readTx)).fingerprint !== f.fingerprint)
          throw new ApplicationError(unavailable);
    }),
};
function timeout(value: string, max: number) {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/.exec(value);
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    min: 60000,
    h: 3600000,
    d: 86400000,
  };
  if (!match) throw new ApplicationError(unavailable);
  const n = Number(match[1]) * units[match[2] ?? 'ms']!;
  return `${Math.max(1, Math.min(n || max, max))}ms`;
}
const attempts = new WeakMap<PoolClient, object>();
@Injectable()
export class SchoolUidProjectionFacade {
  /** Used only when the management owner already retains the joint source fact. */
  async boundByManagement(account: string, tx: PoolClient): Promise<SchoolUid> {
    return (await read(account, tx)).value;
  }
  async required(account: string, tx: PoolClient): Promise<SchoolUid> {
    const fact = await read(account, tx);
    enableRequiredTransactionProof(tx, required);
    registerRequiredTransactionFact(tx, required, account, fact);
    if (fact.value.status === 'assigned')
      registerTransactionExactDeadline(tx, fact.until, unavailable);
    return fact.value;
  }
  /** One isolated optional owner attempt. Failure never prunes prior owner facts. */
  async optional(
    account: string,
    tx: PoolClient,
    apply: (value: SchoolUid) => void,
  ): Promise<void> {
    const epoch = transactionReadEpoch(tx);
    if (!epoch || attempts.get(tx) === epoch)
      throw new ApplicationError(unavailable);
    attempts.set(tx, epoch);
    const checkpoint = checkpointTransactionDeadlines(tx);
    await tx.query('SAVEPOINT school_uid_projection');
    let fact: ProjectionFact;
    try {
      const settings = (
        await tx.query<{ statement_timeout: string; lock_timeout: string }>(
          "SELECT current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout",
        )
      ).rows[0]!;
      await tx.query(
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
        [
          timeout(settings.statement_timeout, 100),
          timeout(settings.lock_timeout, 1),
        ],
      );
      fact = await read(account, tx);
      await tx.query(
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
        [settings.statement_timeout, settings.lock_timeout],
      );
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT school_uid_projection');
      await tx.query('RELEASE SAVEPOINT school_uid_projection');
      restoreTransactionDeadlines(tx, checkpoint);
      const restored = transactionReadEpoch(tx);
      if (restored) attempts.set(tx, restored);
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['55P03', '57014'].includes(String(error.code))
      ) {
        apply({ status: 'unavailable' });
        return;
      }
      throw error;
    }
    await tx.query('RELEASE SAVEPOINT school_uid_projection');
    apply(fact.value);
    registerOptionalTransactionProof(tx, {
      until:
        fact.value.status === 'assigned' && fact.until
          ? Date.parse(fact.until)
          : null,
      validate: async () => {
        await tx.query(fences);
        return (await read(account, tx)).fingerprint === fact.fingerprint;
      },
      invalidate: () => apply({ status: 'unavailable' }),
    });
  }
  async lookupAccount(
    schoolCode: string,
    uid: string,
    tx: PoolClient,
  ): Promise<string | null> {
    const rows = (
      await tx.query<{ account_id: string }>(
        `SELECT h.account_id FROM whaleu_campus.school_identifiers m JOIN whaleu_school_uid.account_heads h ON h.institution_id=m.institution_id JOIN whaleu_school_uid.allocations a ON(a.id,a.account_id,a.institution_id)=(h.allocation_id,h.account_id,h.institution_id) WHERE m.school_code=$1 AND a.uid=$2::bigint LIMIT 2`,
        [schoolCode, uid],
      )
    ).rows;
    return rows.length === 1 ? rows[0]!.account_id : null;
  }
}
