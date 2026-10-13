import { noticeContentAllowed } from '../../safety/account-policy/notice-projection.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { StudentVerificationAccess } from './access.js';
import type { StudentApplicationRow } from './contracts.js';
import { requireStudentCurrent } from './current-proof.js';
import { ApplicationError } from '../../http/application-error.js';
interface Notice {
  id: string;
  application_id: string;
  revision: number;
  kind: 'student_auth' | 'auth_result';
  outcome: 'pending' | 'approved' | 'rejected';
  created_at: Date;
  read_at: Date | null;
}
const candidateSql = `SELECT account_id,id,xmin::text version FROM whaleu_authorization.role_grants WHERE account_id<>$2 AND revoked_at IS NULL AND valid_from<=clock_timestamp() AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND ((role='super_admin' AND operating_region_id IS NULL) OR (role='school_admin' AND operating_region_id=$1)) ORDER BY account_id,id LIMIT 65`;
interface CandidateFact {
  region: string;
  applicant: string;
  fingerprint: string;
}
const candidateProof: RequiredTransactionProof<CandidateFact> = {
  maximumFacts: 1,
  failureCode: 'SYSTEM_NOTICES_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'SYSTEM_NOTICES_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_authorization.role_grants IN SHARE MODE NOWAIT',
      );
      for (const f of facts) {
        const rows = (await read.query(candidateSql, [f.region, f.applicant]))
          .rows;
        if (ownerFingerprint(rows) !== f.fingerprint)
          throw new ApplicationError('SYSTEM_NOTICES_UNAVAILABLE');
      }
    }),
};
async function recipientCandidates(
  region: string,
  applicant: string,
  tx: PoolClient,
) {
  const rows = (
    await tx.query<{ account_id: string; id: string; version: string }>(
      candidateSql,
      [region, applicant],
    )
  ).rows;
  const candidates = [...new Set(rows.map((r) => r.account_id))];
  if (rows.length > 64 || candidates.length > 32)
    throw new ApplicationError('SYSTEM_NOTICES_UNAVAILABLE');
  const fingerprint = ownerFingerprint(rows);
  enableRequiredTransactionProof(tx, candidateProof);
  registerRequiredTransactionFact(
    tx,
    candidateProof,
    `${region}:${applicant}:${fingerprint}`,
    Object.freeze({ region, applicant, fingerprint }),
  );
  return candidates.map((account_id) => ({ account_id }));
}
/** Source mutations own Safety writer gate. All recipient authority precedes owner locks. */
@Injectable()
export class StudentVerificationNotices {
  constructor(
    @Inject(AuthorizationService) readonly authorization: AuthorizationService,
    @Inject(StudentVerificationAccess)
    readonly access: StudentVerificationAccess,
  ) {}
  private async owner(account: string, tx: PoolClient, write = false) {
    await tx.query(
      'INSERT INTO whaleu_notifications.student_notice_owners(account_id) VALUES($1) ON CONFLICT DO NOTHING',
      [account],
    );
    await tx.query(
      `SELECT account_id FROM whaleu_notifications.student_notice_owners WHERE account_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
      [account],
    );
  }
  async record(row: StudentApplicationRow, tx: PoolClient) {
    const recipients: { account: string; grant: string | null }[] = [];
    if (row.state === 'pending') {
      const candidates = await recipientCandidates(
        row.region_id,
        row.account_id,
        tx,
      );
      for (const candidate of candidates) {
        const account = candidate.account_id;
        if (!(await this.access.identity.activeAccount(account, tx))) {
          await requireStudentCurrent(null, account, tx);
          continue;
        }
        const safety = await this.access.safety.selectionEligibility(
          account,
          tx,
        );
        if (safety.status === 'unavailable')
          throw new ApplicationError('SAFETY_UNAVAILABLE');
        const grants = await this.authorization.grants(account, tx),
          global = grants.some(
            (g) => g.role === 'super_admin' && g.operatingRegionId === null,
          ),
          schools = grants.filter(
            (g) => g.role === 'school_admin' && g.operatingRegionId !== null,
          );
        if (
          safety.status === 'restricted' ||
          (!global &&
            (schools.length !== 1 ||
              schools[0]?.operatingRegionId !== row.region_id))
        ) {
          await requireStudentCurrent(null, account, tx);
          continue;
        }
        const authority = await this.access.school.authorizeAccount(
          account,
          row.region_id,
          tx,
        );
        await requireStudentCurrent(null, account, tx);
        recipients.push({ account, grant: authority.grant.id });
      }
    } else if (['approved', 'rejected'].includes(row.state)) {
      await this.access.applicant(row, tx);
      recipients.push({ account: row.account_id, grant: null });
    } else return;
    for (const recipient of recipients) {
      await this.owner(recipient.account, tx, true);
      await tx.query(
        `INSERT INTO whaleu_notifications.student_notices(id,application_id,revision,recipient_account_id,recipient_grant_id,kind,outcome) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(application_id,revision,kind,recipient_account_id) DO NOTHING`,
        [
          randomUUID(),
          row.id,
          row.revision,
          recipient.account,
          recipient.grant,
          row.state === 'pending' ? 'student_auth' : 'auth_result',
          row.state,
        ],
      );
    }
  }
  private async target(account: string, notice: Notice, tx: PoolClient) {
    const row = await this.access.row(notice.application_id, tx);
    if (notice.kind === 'auth_result') {
      if (row.account_id !== account)
        throw new ApplicationError('NOTICE_NOT_FOUND');
    } else {
      try {
        await this.access.school.authorizeAccount(account, row.region_id, tx);
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          error.code === 'AUTHORIZATION_REQUIRED'
        )
          return null;
        throw error;
      }
    }
    await requireStudentCurrent(row.id, account, tx);
    return {
      applicationId: row.id,
      regionId: notice.kind === 'student_auth' ? row.region_id : null,
    };
  }
  async list(account: string, page: number, tx: PoolClient) {
    const rows = (
      await tx.query<Notice>(
        'SELECT id,application_id,revision,kind,outcome,created_at,read_at FROM whaleu_notifications.student_notices WHERE recipient_account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 21 OFFSET $2',
        [account, (page - 1) * 20],
      )
    ).rows;
    const contentAllowed = await noticeContentAllowed(account, tx);
    const items = [];
    for (const n of rows.slice(0, 20)) {
      const target = contentAllowed ? await this.target(account, n, tx) : null;
      items.push({
        id: n.id,
        kind: n.kind,
        outcome: n.outcome,
        createdAt: n.created_at.toISOString(),
        read: n.read_at !== null,
        available: target !== null,
      });
    }
    await this.owner(account, tx);
    return { items, page, hasNext: rows.length > 20 };
  }
  async open(account: string, id: string, tx: PoolClient, markRead = false) {
    const notice = (
      await tx.query<Notice>(
        'SELECT * FROM whaleu_notifications.student_notices WHERE id=$1 AND recipient_account_id=$2',
        [id, account],
      )
    ).rows[0];
    if (!notice) throw new ApplicationError('NOTICE_NOT_FOUND');
    const contentAllowed = await noticeContentAllowed(account, tx);
    const target = contentAllowed
      ? await this.target(account, notice, tx)
      : null;
    await this.owner(account, tx, markRead);
    if (markRead && (target || !contentAllowed))
      await tx.query(
        'UPDATE whaleu_notifications.student_notices SET read_at=COALESCE(read_at,clock_timestamp()) WHERE id=$1',
        [id],
      );
    return {
      status: target ? ('available' as const) : ('unavailable' as const),
      target,
    };
  }
}
