import { StudentVerificationNotices } from './notices.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { ownerFingerprint } from '../../database/required-owner-proof.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { VerificationRepository } from '../verification.repository.js';
import { VerificationEvidenceMediaService } from '../evidence/facade.js';
import { StudentVerificationAccess } from './access.js';
import { lockStudentAccount, requireStudentCurrent } from './current-proof.js';
import { appendStudentSnapshot, lockStudentLedger } from './ledger.js';
import type {
  ReserveStudent,
  SubmitStudent,
  WithdrawStudent,
  DecideStudent,
  StudentApplicationRow,
  StudentReceipt,
} from './contracts.js';
@Injectable()
export class StudentVerificationService {
  constructor(
    @Inject(StudentVerificationNotices)
    readonly notices: StudentVerificationNotices,
    @Inject(DatabaseService) readonly db: DatabaseService,
    @Inject(StudentVerificationAccess)
    readonly access: StudentVerificationAccess,
    @Inject(VerificationRepository) readonly records: VerificationRepository,
    @Inject(VerificationEvidenceMediaService)
    readonly media: VerificationEvidenceMediaService,
  ) {}
  private async run<T>(work: (tx: PoolClient) => Promise<T>, write = false) {
    try {
      return await this.db.transaction(
        async (tx) => {
          await tx.query("SET LOCAL lock_timeout='500ms'");
          if (write) await lockSafetyPolicy(tx, true);
          return work(tx);
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    }
  }
  private async request(
    actor: string,
    id: string,
    tx: PoolClient,
    hash: string,
  ) {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:student-request:v1:'||$1||':'||$2,0))",
      [actor, id],
    );
    const fence = (
      await tx.query<{ command_hash: string }>(
        'SELECT command_hash FROM whaleu_verification.student_cancel_fences WHERE actor_id=$1 AND client_request_id=$2',
        [actor, id],
      )
    ).rows[0];
    if (fence)
      throw new ApplicationError(
        fence.command_hash === hash
          ? 'STUDENT_VERIFICATION_CANCELLED'
          : 'STUDENT_VERIFICATION_CONFLICT',
      );
    return (
      await tx.query<{ command_hash: string; receipt: StudentReceipt }>(
        'SELECT command_hash,receipt FROM whaleu_verification.student_requests WHERE actor_id=$1 AND client_request_id=$2',
        [actor, id],
      )
    ).rows[0];
  }
  private replay(
    prior: { command_hash: string; receipt: StudentReceipt } | undefined,
    hash: string,
  ) {
    if (prior && prior.command_hash !== hash)
      throw new ApplicationError('STUDENT_VERIFICATION_CONFLICT');
    return prior?.receipt;
  }
  private async record(
    actor: string,
    key: string,
    hash: string,
    row: StudentApplicationRow,
    tx: PoolClient,
  ): Promise<StudentReceipt> {
    const receipt = {
      requestId: key,
      applicationId: row.id,
      revision: row.revision,
      state: row.state,
    };
    await tx.query(
      'INSERT INTO whaleu_verification.student_requests(actor_id,client_request_id,application_id,command_hash,receipt) VALUES($1,$2,$3,$4,$5::jsonb)',
      [actor, key, row.id, hash, JSON.stringify(receipt)],
    );
    return receipt;
  }
  private async eligible(
    account: string,
    tx: PoolClient,
    institution?: string,
  ) {
    if (
      (
        await tx.query(
          "SELECT 1 FROM whaleu_verification.student_applications WHERE account_id=$1 AND state='approved' LIMIT 1",
          [account],
        )
      ).rowCount
    )
      throw new ApplicationError('STUDENT_VERIFICATION_ALREADY_VERIFIED');
    const summary = (await this.records.read(account, tx)).summary;
    if (summary.affiliation.status === 'verified')
      throw new ApplicationError('STUDENT_VERIFICATION_ALREADY_VERIFIED');
    if (
      summary.affiliation.status === 'unavailable' ||
      summary.application.status === 'unavailable'
    )
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    if (institution && summary.studentNumber.status === 'verified') {
      const existing = (
        await tx.query<{ issuer_institution_id: string }>(
          `SELECT a.issuer_institution_id FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.id=h.snapshot_id AND s.account_id=h.account_id JOIN whaleu_verification.assertions a ON a.id=s.student_number_assertion_id AND a.account_id=s.account_id WHERE h.account_id=$1`,
          [account],
        )
      ).rows[0];
      if (existing?.issuer_institution_id !== institution)
        throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    }
  }
  private async expire(
    row: StudentApplicationRow,
    actor: string,
    tx: PoolClient,
    retire = true,
  ): Promise<StudentApplicationRow> {
    if (row.state !== 'pending' || !row.evidence_expires_at) return row;
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() now'))
      .rows[0]!.now;
    if (row.evidence_expires_at > now) return row;
    const updated = (
      await tx.query<StudentApplicationRow>(
        "UPDATE whaleu_verification.student_applications SET state='expired',revision=revision+1 WHERE id=$1 AND state='pending' AND revision=$2 RETURNING *",
        [row.id, row.revision],
      )
    ).rows[0];
    if (!updated) throw new ApplicationError('STUDENT_VERIFICATION_CONFLICT');
    await appendStudentSnapshot(
      {
        account: row.account_id,
        actor,
        operationId: randomUUID(),
        state: 'none',
      },
      tx,
    );
    if (retire) await this.media.retireEvidence(row.id, row.evidence_id!, tx);
    return updated;
  }
  private async project(row: StudentApplicationRow, tx: PoolClient) {
    const detail = (
      await tx.query<{
        campus_name: string;
        institution_name: string;
        profile_id: string | null;
        reason: string | null;
      }>(
        `SELECT c.full_name campus_name,i.name institution_name,p.public_id profile_id,d.reason FROM whaleu_campus.campuses c JOIN whaleu_campus.institutions i ON i.id=c.institution_id LEFT JOIN whaleu_profile.profiles p ON p.account_id=$2 LEFT JOIN whaleu_verification.student_decisions d ON d.id=$3 WHERE c.id=$1`,
        [row.campus_id, row.account_id, row.decision_id],
      )
    ).rows[0];
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() now'))
      .rows[0]!.now;
    return {
      id: row.id,
      revision: row.revision,
      state: row.state,
      campusId: row.campus_id,
      campusName: detail?.campus_name ?? '',
      institutionName: detail?.institution_name ?? '',
      regionId: row.region_id,
      profileId: detail?.profile_id ?? null,
      submittedAt: row.submitted_at?.toISOString() ?? null,
      reason: detail?.reason ?? null,
      evidenceRevision: row.evidence_revision,
      evidenceAvailable:
        !!row.evidence_id &&
        !!row.evidence_expires_at &&
        row.evidence_expires_at > now &&
        !['withdrawn', 'expired'].includes(row.state),
      evidenceExpiresAt: row.evidence_expires_at?.toISOString() ?? null,
    };
  }
  noticeList(token: string, page: number) {
    return this.run(async (tx) => {
      const actor = await this.access.authenticate(token, tx);
      return this.notices.list(actor.accountId, page, tx);
    });
  }
  noticeTarget(token: string, id: string, markRead = false) {
    return this.run(async (tx) => {
      const actor = await this.access.authenticate(token, tx);
      return this.notices.open(actor.accountId, id, tx, markRead);
    });
  }
  capabilities(token: string) {
    return this.run(async (tx) => {
      const result = await this.access.school.capabilities(token, tx);
      const actor = await this.access.authenticate(token, tx);
      await requireStudentCurrent(null, actor.accountId, tx);
      return result;
    });
  }
  recover(token: string, key: string) {
    return this.run(async (tx) => {
      const actor = await this.access.identity.session(token, tx);
      const row = (
        await tx.query<{ receipt: StudentReceipt }>(
          'SELECT receipt FROM whaleu_verification.student_requests WHERE actor_id=$1 AND client_request_id=$2',
          [actor.accountId, key],
        )
      ).rows[0];
      const cancelled =
        (
          await tx.query(
            'SELECT 1 FROM whaleu_verification.student_cancel_fences WHERE actor_id=$1 AND client_request_id=$2',
            [actor.accountId, key],
          )
        ).rowCount === 1;
      return {
        requestId: key,
        state: row
          ? ('recorded' as const)
          : cancelled
            ? ('cancelled' as const)
            : ('not_recorded' as const),
        receipt: row?.receipt ?? null,
      };
    });
  }
  cancelRequest(token: string, key: string, hash: string) {
    return this.run(async (tx) => {
      const actor = await this.access.identity.session(token, tx);
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:student-request:v1:'||$1||':'||$2,0))",
        [actor.accountId, key],
      );
      const old = (
        await tx.query<{ command_hash: string; receipt: StudentReceipt }>(
          'SELECT command_hash,receipt FROM whaleu_verification.student_requests WHERE actor_id=$1 AND client_request_id=$2',
          [actor.accountId, key],
        )
      ).rows[0];
      if (old) {
        if (old.command_hash !== hash)
          throw new ApplicationError('STUDENT_VERIFICATION_CONFLICT');
        return {
          requestId: key,
          state: 'recorded' as const,
          receipt: old.receipt,
        };
      }
      await tx.query(
        'INSERT INTO whaleu_verification.student_cancel_fences(actor_id,client_request_id,command_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [actor.accountId, key, hash],
      );
      const fence = (
        await tx.query<{ command_hash: string }>(
          'SELECT command_hash FROM whaleu_verification.student_cancel_fences WHERE actor_id=$1 AND client_request_id=$2',
          [actor.accountId, key],
        )
      ).rows[0];
      if (fence?.command_hash !== hash)
        throw new ApplicationError('STUDENT_VERIFICATION_CONFLICT');
      return { requestId: key, state: 'cancelled' as const, receipt: null };
    });
  }
  own(token: string) {
    return this.run(async (tx) => {
      const actor = await this.access.identity.session(token, tx);
      await lockStudentAccount(actor.accountId, tx);
      let row = (
        await tx.query<StudentApplicationRow>(
          'SELECT * FROM whaleu_verification.student_applications WHERE account_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE',
          [actor.accountId],
        )
      ).rows[0];
      if (row) row = await this.expire(row, actor.accountId, tx);
      const summary = (await this.records.read(actor.accountId, tx)).summary;
      await requireStudentCurrent(row?.id ?? null, actor.accountId, tx);
      return {
        application: row ? await this.project(row, tx) : null,
        canApply:
          summary.affiliation.status !== 'verified' &&
          summary.affiliation.status !== 'unavailable' &&
          summary.application.status !== 'unavailable' &&
          (!row || !['draft', 'pending', 'approved'].includes(row.state)),
      };
    });
  }
  detail(token: string, id: string, region?: string) {
    return this.run(async (tx) => {
      const actor = region
        ? (await this.access.reviewer(token, region, tx)).session
        : await this.access.identity.session(token, tx);
      let row = await this.access.row(id, tx);
      if (region) {
        if (row.region_id !== region)
          throw new ApplicationError('STUDENT_VERIFICATION_NOT_FOUND');
      } else if (row.account_id !== actor.accountId)
        throw new ApplicationError('STUDENT_VERIFICATION_NOT_FOUND');
      await lockStudentAccount(row.account_id, tx);
      row = await this.access.row(id, tx, true);
      row = await this.expire(row, actor.accountId, tx);
      await requireStudentCurrent(row.id, actor.accountId, tx);
      const detail = await this.project(row, tx);
      if (region && row.state !== 'pending') detail.evidenceAvailable = false;
      return detail;
    });
  }
  queue(token: string, region: string, page: number, cursor?: string) {
    return this.run(async (tx) => {
      const actor = await this.access.reviewer(token, region, tx);
      let anchor: { created_at: Date; id: string } | undefined;
      if (cursor) {
        anchor = (
          await tx.query<{ created_at: Date; id: string }>(
            'SELECT created_at,id FROM whaleu_verification.student_applications WHERE id=$1 AND region_id=$2',
            [cursor, region],
          )
        ).rows[0];
        if (!anchor)
          throw new ApplicationError('STUDENT_VERIFICATION_CONFLICT');
      }
      const rows = (
        await tx.query<StudentApplicationRow>(
          `SELECT * FROM whaleu_verification.student_applications WHERE region_id=$1 AND state='pending' AND ($2::uuid IS NULL OR (created_at,id)>(SELECT created_at,id FROM whaleu_verification.student_applications WHERE id=$2 AND region_id=$1)) ORDER BY created_at,id LIMIT 21`,
          [region, anchor?.id ?? null],
        )
      ).rows;
      const items = [],
        pending: StudentApplicationRow[] = [],
        expired: { applicationId: string; bindingId: string }[] = [];
      for (const original of rows.slice(0, 20)) {
        await lockStudentAccount(original.account_id, tx);
        let row = await this.access.row(original.id, tx, true);
        const before = row.state;
        row = await this.expire(row, actor.session.accountId, tx, false);
        if (before === 'pending' && row.state === 'expired' && row.evidence_id)
          expired.push({ applicationId: row.id, bindingId: row.evidence_id });
        await requireStudentCurrent(row.id, actor.session.accountId, tx);
        if (row.state === 'pending') pending.push(row);
      }
      await this.media.retireEvidenceBatch(expired, tx);
      for (const row of pending) items.push(await this.project(row, tx));
      return {
        items,
        page,
        hasNext: rows.length > 20,
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }

  reserve(token: string, input: ReserveStudent) {
    return this.run(async (tx) => {
      const actor = await this.access.authenticate(token, tx);
      const hash = ownerFingerprint(['reserve', input]);
      const replay = this.replay(
        await this.request(actor.accountId, input.clientRequestId, tx, hash),
        hash,
      );
      if (replay) return replay;
      await lockStudentAccount(actor.accountId, tx);
      const old = (
        await tx.query<StudentApplicationRow>(
          "SELECT * FROM whaleu_verification.student_applications WHERE account_id=$1 AND state IN ('draft','pending') FOR UPDATE",
          [actor.accountId],
        )
      ).rows[0];
      if (old) {
        const current = await this.expire(old, actor.accountId, tx);
        if (['draft', 'pending'].includes(current.state))
          throw new ApplicationError('STUDENT_VERIFICATION_CONFLICT');
      }
      await this.eligible(actor.accountId, tx);
      const campus = await this.access.campuses.resolve(input.campusId, tx);
      await this.eligible(actor.accountId, tx, campus.institutionId);
      const row = (
        await tx.query<StudentApplicationRow>(
          "INSERT INTO whaleu_verification.student_applications(id,account_id,client_request_id,campus_id,institution_id,region_id,campus_version,state) VALUES($1,$2,$3,$4,$5,$6,$7,'draft') RETURNING *",
          [
            randomUUID(),
            actor.accountId,
            input.clientRequestId,
            campus.campusId,
            campus.institutionId,
            campus.regionId,
            campus.version,
          ],
        )
      ).rows[0]!;
      await requireStudentCurrent(row.id, actor.accountId, tx);
      return this.record(actor.accountId, input.clientRequestId, hash, row, tx);
    }, true);
  }
  submit(token: string, id: string, input: SubmitStudent) {
    return this.run(async (tx) => {
      const actor = await this.access.authenticate(token, tx),
        hash = ownerFingerprint(['submit', id, input]);
      const replay = this.replay(
        await this.request(actor.accountId, input.clientRequestId, tx, hash),
        hash,
      );
      if (replay) return replay;
      await lockStudentAccount(actor.accountId, tx);
      const row = await this.access.row(id, tx, true);
      if (row.account_id !== actor.accountId)
        throw new ApplicationError('STUDENT_VERIFICATION_NOT_FOUND');
      if (row.state !== 'draft' || row.revision !== input.expectedRevision)
        throw new ApplicationError('STUDENT_VERIFICATION_CONFLICT');
      await this.eligible(actor.accountId, tx);
      await this.access.campus(row, tx);
      const evidence = await this.media.acceptAndBind(
        actor.accountId,
        id,
        input.expectedRevision,
        input.evidence,
        tx,
      );
      registerTransactionDeadline(tx, evidence.expiresAt, 'MEDIA_UNAVAILABLE');
      const updated = (
        await tx.query<StudentApplicationRow>(
          "UPDATE whaleu_verification.student_applications a SET state='pending',revision=a.revision+1,evidence_id=b.binding_id,evidence_revision=$2,evidence_expires_at=b.evidence_expires_at,evidence_policy_ref=b.evidence_policy_ref,submitted_at=clock_timestamp() FROM whaleu_media.verification_evidence_bindings b WHERE a.id=$1 AND a.revision=$2 AND b.binding_id=$3 AND b.application_id=a.id RETURNING a.*",
          [id, input.expectedRevision, evidence.bindingId],
        )
      ).rows[0]!;
      await appendStudentSnapshot(
        {
          account: row.account_id,
          actor: actor.accountId,
          operationId: input.clientRequestId,
          state: 'pending',
        },
        tx,
      );
      await this.notices.record(updated, tx);
      await requireStudentCurrent(id, actor.accountId, tx);
      return this.record(
        actor.accountId,
        input.clientRequestId,
        hash,
        updated,
        tx,
      );
    }, true);
  }
  withdraw(token: string, id: string, input: WithdrawStudent) {
    return this.run(async (tx) => {
      const actor = await this.access.identity.session(token, tx),
        hash = ownerFingerprint(['withdraw', id, input]);
      const replay = this.replay(
        await this.request(actor.accountId, input.clientRequestId, tx, hash),
        hash,
      );
      if (replay) return replay;
      await lockStudentAccount(actor.accountId, tx);
      const row = await this.access.row(id, tx, true);
      if (row.account_id !== actor.accountId)
        throw new ApplicationError('STUDENT_VERIFICATION_NOT_FOUND');
      if (
        !['draft', 'pending'].includes(row.state) ||
        row.revision !== input.expectedRevision
      )
        throw new ApplicationError('STUDENT_VERIFICATION_CONFLICT');
      const updated = (
        await tx.query<StudentApplicationRow>(
          "UPDATE whaleu_verification.student_applications SET state='withdrawn',revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING *",
          [id, input.expectedRevision],
        )
      ).rows[0]!;
      if (row.state === 'pending')
        await appendStudentSnapshot(
          {
            account: row.account_id,
            actor: actor.accountId,
            operationId: input.clientRequestId,
            state: 'none',
          },
          tx,
        );
      if (row.evidence_id)
        await this.media.retireEvidence(id, row.evidence_id, tx);
      await requireStudentCurrent(id, actor.accountId, tx);
      return this.record(
        actor.accountId,
        input.clientRequestId,
        hash,
        updated,
        tx,
      );
    }, true);
  }
  decide(token: string, region: string, id: string, input: DecideStudent) {
    return this.run(async (tx) => {
      const actor = await this.access.reviewer(token, region, tx),
        hash = ownerFingerprint(['decide', region, id, input]);
      const replay = this.replay(
        await this.request(
          actor.session.accountId,
          input.clientRequestId,
          tx,
          hash,
        ),
        hash,
      );
      if (replay) return replay;
      let row = await this.access.row(id, tx);
      if (row.region_id !== region)
        throw new ApplicationError('STUDENT_VERIFICATION_NOT_FOUND');
      if (row.account_id === actor.session.accountId)
        throw new ApplicationError('STUDENT_VERIFICATION_SELF_REVIEW');
      await lockStudentAccount(row.account_id, tx);
      row = await this.access.row(id, tx, true);
      if (row.state !== 'pending' || row.revision !== input.expectedRevision)
        throw new ApplicationError('STUDENT_VERIFICATION_CONFLICT');
      await this.access.applicant(row, tx);
      await this.access.campus(row, tx);
      await this.eligible(row.account_id, tx, row.institution_id);
      const evidence = await this.media.evidenceCurrent(row, tx);
      registerTransactionDeadline(tx, evidence.expiresAt, 'MEDIA_UNAVAILABLE');
      const locked = await lockStudentLedger(row.account_id, tx),
        decision = randomUUID(),
        assertion = input.decision === 'approved' ? randomUUID() : null,
        ids = { snapshot: randomUUID(), event: randomUUID() };
      await tx.query(
        `INSERT INTO whaleu_verification.student_decisions(id,application_id,account_id,actor_account_id,grant_id,client_request_id,expected_revision,decision,reason,institution_id,region_id,evidence_digest,evidence_policy_ref,evidence_expires_at,policy_reference,assertion_id,snapshot_id,event_id,ledger_revision) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,a.evidence_policy_ref,a.evidence_expires_at,'student-document-review/v1',$13,$14,$15,$16 FROM whaleu_verification.student_applications a WHERE a.id=$2`,
        [
          decision,
          id,
          row.account_id,
          actor.session.accountId,
          actor.grant.id,
          input.clientRequestId,
          input.expectedRevision,
          input.decision,
          input.decision === 'rejected' ? input.reason : null,
          row.institution_id,
          row.region_id,
          evidence.manifestDigest,
          assertion,
          ids.snapshot,
          ids.event,
          locked.head.revision + 1,
        ],
      );
      if (assertion)
        await tx.query(
          `INSERT INTO whaleu_verification.assertions(id,account_id,fact_kind,assertion_state,coverage_state,provenance_state,method,source_reference,policy_reference,source_account_id,issuer_institution_id,source_issuer_institution_id,origin_region_id,verified_at,expiry_kind,previous_assertion_id) SELECT assertion_id,account_id,'affiliation','verified','complete','accepted','document_review','student_decision:'||id::text,policy_reference,account_id,institution_id,institution_id,region_id,decided_at,'policy_exempt',$2 FROM whaleu_verification.student_decisions WHERE id=$1`,
          [decision, locked.prior.affiliation_assertion_id],
        );
      const updated = (
        await tx.query<StudentApplicationRow>(
          'UPDATE whaleu_verification.student_applications SET state=$3,decision_id=$4,revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING *',
          [id, input.expectedRevision, input.decision, decision],
        )
      ).rows[0]!;
      await appendStudentSnapshot(
        {
          account: row.account_id,
          actor: actor.session.accountId,
          operationId: input.clientRequestId,
          state: input.decision === 'approved' ? 'none' : 'rejected',
          decisionId: decision,
          ...(assertion ? { assertionId: assertion } : {}),
          ids,
          locked,
        },
        tx,
      );
      await this.notices.record(updated, tx);
      await requireStudentCurrent(id, actor.session.accountId, tx);
      await requireStudentCurrent(id, row.account_id, tx);
      return this.record(
        actor.session.accountId,
        input.clientRequestId,
        hash,
        updated,
        tx,
      );
    }, true);
  }
}
