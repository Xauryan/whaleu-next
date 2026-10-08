import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  registerTransactionDeadline,
} from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import type { ApplicationErrorCode } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import { LocalReportEligibilitySource } from '../../verification/report-eligibility.source.js';
import { AuthorizationReportWeightSource } from '../../authorization/report-weight.source.js';
import type { ActiveGrant } from '../../authorization/contracts.js';
import { CommunityReportTargetFacade } from '../../community/report-target.facade.js';
import type { ResolvedReportTarget } from '../../community/report-target.facade.js';
import { SafetyRepository } from '../repository.js';
import { lockSafetyPolicy } from '../locks.js';
import { enableSafetyRelationshipProof } from '../relationship-proof.js';
import { ReportsRepository } from './repository.js';
import type { ReportCase, PostJury } from './repository.js';
import { JurySettlementService } from './settlement.js';
import {
  terminalReportCodes,
  capabilityUnavailableCodes,
} from './contracts.js';
import type {
  ReportRequest,
  JuryVoteRequest,
  ReportReceipt,
  ReportTarget,
  ReportProgress,
  ReportCapability,
  ReportRejectionCode,
} from './contracts.js';
const terminal = new Set<string>(terminalReportCodes);
const unavailable = new Set<string>(capabilityUnavailableCodes);
@Injectable()
export class ReportingService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(SafetyRepository) private readonly safety: SafetyRepository,
    @Inject(LocalReportEligibilitySource)
    private readonly eligibility: LocalReportEligibilitySource,
    @Inject(AuthorizationReportWeightSource)
    private readonly weighting: AuthorizationReportWeightSource,
    @Inject(CommunityReportTargetFacade)
    private readonly targets: CommunityReportTargetFacade,
    @Inject(ReportsRepository) private readonly records: ReportsRepository,
    @Inject(JurySettlementService)
    private readonly settlement: JurySettlementService,
  ) {}
  private async transaction<T>(
    work: (tx: PoolClient) => Promise<T>,
    emittingRead = false,
  ): Promise<T> {
    try {
      return await this.database.transaction(
        async (tx) => {
          // Only current progress is an emitting read. Mutations and immutable
          // recovery receipts must not inherit an unchanged-relationship proof.
          if (emittingRead) enableSafetyRelationshipProof(tx);
          await lockSafetyPolicy(tx);
          return work(tx);
        },
        emittingRead ? { isolationLevel: 'read committed' } : {},
      );
    } catch (error) {
      if (
        error instanceof ApplicationError ||
        error instanceof BadRequestException
      )
        throw error;
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    }
  }
  private async eligible(actor: string, tx: PoolClient) {
    await this.safety.restriction(actor, tx);
    const eligibility = await this.eligibility.resolve(actor, tx);
    for (const kind of ['phone', 'affiliation'] as const) {
      const fact = eligibility[kind],
        code =
          kind === 'phone'
            ? 'PHONE_VERIFICATION_REQUIRED'
            : 'AFFILIATION_VERIFICATION_REQUIRED';
      if (fact.status === 'unavailable')
        throw new ApplicationError('VERIFICATION_UNAVAILABLE');
      if (fact.status !== 'verified') throw new ApplicationError(code);
      registerTransactionDeadline(tx, fact.validUntil, code);
    }
  }
  report(token: string, body: ReportRequest) {
    return this.mutate(
      token,
      body.clientRequestId,
      'report',
      { target: body.target },
      body,
    );
  }
  vote(token: string, body: JuryVoteRequest) {
    return this.mutate(
      token,
      body.clientRequestId,
      'vote',
      { postId: body.postId, juryId: body.juryId, vote: body.vote },
      undefined,
      body,
    );
  }
  private mutate(
    token: string,
    requestId: string,
    operation: 'report' | 'vote',
    intent: unknown,
    report?: ReportRequest,
    vote?: JuryVoteRequest,
  ): Promise<ReportReceipt> {
    return this.transaction(async (tx) => {
      const actor = (await this.identity.session(token, tx)).accountId;
      const hash = createHash('sha256')
        .update(JSON.stringify({ operation, intent }))
        .digest('hex');
      await tx.query(
        'INSERT INTO whaleu_safety.report_requests(account_id,client_request_id,operation,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [actor, requestId, operation, hash],
      );
      const row = (
        await tx.query<{ payload_hash: string; receipt: ReportReceipt | null }>(
          'SELECT payload_hash,receipt FROM whaleu_safety.report_requests WHERE account_id=$1 AND client_request_id=$2 FOR UPDATE',
          [actor, requestId],
        )
      ).rows[0]!;
      if (row.payload_hash !== hash)
        throw new ApplicationError('REQUEST_CONFLICT');
      if (row.receipt) {
        await this.records.rate(actor, 'read', tx);
        return row.receipt;
      }
      await this.records.rate(actor, operation, tx);
      await this.records.targetRate(
        actor,
        report?.target ?? { kind: 'post', id: vote!.postId },
        tx,
      );
      // Session bounds are outside the optional work checkpoint and always survive it.
      const checkpoint = checkpointTransactionDeadlines(tx);
      await tx.query('SAVEPOINT report_work');
      let receipt: ReportReceipt;
      try {
        await this.eligible(actor, tx);
        // All actor authority locks precede ancestor locks; only selected weight is relied upon.
        const grants =
          report?.target.kind === 'post'
            ? await this.weighting.grants(actor, tx)
            : [];
        const target = await this.targets.resolveVisible(
          report?.target ?? { kind: 'post', id: vote!.postId },
          actor,
          tx,
          true,
        );
        if (!target.native) throw new ApplicationError('SAFETY_UNAVAILABLE');
        const id = report
          ? await this.acceptReport(actor, requestId, target, grants, tx)
          : await this.acceptVote(actor, requestId, target, vote!, tx);
        receipt = { requestId, operation, outcome: 'accepted', receiptId: id };
      } catch (error) {
        if (!(error instanceof ApplicationError) || !terminal.has(error.code))
          throw error;
        await tx.query('ROLLBACK TO SAVEPOINT report_work');
        restoreTransactionDeadlines(tx, checkpoint);
        receipt = {
          requestId,
          operation,
          outcome: 'rejected',
          code: error.code as ReportRejectionCode,
        };
      }
      await tx.query('RELEASE SAVEPOINT report_work');
      await tx.query(
        'UPDATE whaleu_safety.report_requests SET receipt=$3::jsonb WHERE account_id=$1 AND client_request_id=$2',
        [actor, requestId, JSON.stringify(receipt)],
      );
      return receipt;
    });
  }
  private async acceptReport(
    actor: string,
    requestId: string,
    target: ResolvedReportTarget,
    grants: ActiveGrant[],
    tx: PoolClient,
  ) {
    if (target.ownerAccountId === actor)
      throw new ApplicationError('REPORT_SELF_NOT_ALLOWED');
    let record = await this.records.case(target.target, tx, true);
    if (record && (await this.records.reported(record.id, actor, tx)))
      throw new ApplicationError('REPORT_ALREADY_REPORTED');
    if (record?.state !== 'open' && record !== null)
      throw new ApplicationError('REPORTING_CLOSED');
    const weight =
      target.target.kind === 'post'
        ? this.weighting.resolve(grants, target.scope, tx)
        : { weight: 1, grantId: null, scopeEvidence: null };
    if (!record) {
      record = (
        await tx.query<ReportCase>(
          `INSERT INTO whaleu_safety.report_cases(id,kind,target_id,post_id,root_id,reply_id,owner_account_id,provenance,content_digest) VALUES($1,$2,$3,$4,$5,$6,$7,'native_publication',$8) RETURNING *`,
          [
            randomUUID(),
            target.target.kind,
            target.target.id,
            target.postId,
            target.rootId,
            target.replyId,
            target.ownerAccountId,
            target.version,
          ],
        )
      ).rows[0]!;
    }
    if (record.content_digest !== target.version)
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    const id = randomUUID();
    await tx.query(
      'INSERT INTO whaleu_safety.reports(id,case_id,account_id,request_id,weight,grant_id,scope_evidence) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        record.id,
        actor,
        requestId,
        weight.weight,
        weight.grantId,
        weight.scopeEvidence,
      ],
    );
    record = (
      await tx.query<ReportCase>(
        'UPDATE whaleu_safety.report_cases SET report_count=report_count+1,effective_weight=effective_weight+$2 WHERE id=$1 RETURNING *',
        [record.id, weight.weight],
      )
    ).rows[0]!;
    if (target.target.kind === 'post' && record.effective_weight >= 5) {
      const jury = (
        await tx.query<PostJury>(
          `WITH stamp AS(SELECT date_trunc('milliseconds',clock_timestamp()) AS now) INSERT INTO whaleu_safety.post_juries(id,case_id,post_id,content_digest,created_at,deadline) SELECT $1,$2,$3,$4,now,now+interval '24 hours' FROM stamp RETURNING *`,
          [randomUUID(), record.id, target.postId, target.version],
        )
      ).rows[0]!;
      await tx.query(
        "INSERT INTO whaleu_safety.jury_work(jury_id,provenance,due_at,next_attempt_at) VALUES($1,'native_publication',$2,$2)",
        [jury.id, jury.deadline],
      );
      await tx.query(
        "UPDATE whaleu_safety.report_cases SET state='jury' WHERE id=$1",
        [record.id],
      );
    } else if (target.target.kind !== 'post') {
      await tx.query(
        'INSERT INTO whaleu_safety.review_obligations(case_id,content_digest) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [record.id, record.content_digest],
      );
      if (record.report_count === 10)
        await this.settlement.removeDiscussion(record, target, tx);
    }
    return id;
  }
  private async acceptVote(
    actor: string,
    requestId: string,
    target: ResolvedReportTarget,
    vote: JuryVoteRequest,
    tx: PoolClient,
  ) {
    const record = await this.records.case(target.target, tx, true),
      jury = await this.records.jury(target.postId, tx, true);
    if (!record || !jury || jury.id !== vote.juryId)
      throw new ApplicationError('JURY_NOT_FOUND');
    const counts = await this.records.ballots(jury.id, actor, tx);
    if (counts.own) throw new ApplicationError('JURY_ALREADY_VOTED');
    if (
      target.ownerAccountId === actor ||
      (await this.records.reported(record.id, actor, tx))
    )
      throw new ApplicationError('JURY_INELIGIBLE');
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now;
    if (
      jury.state !== 'pending' ||
      jury.deadline <= now ||
      counts.keep + counts.remove >= 11
    )
      throw new ApplicationError('JURY_CLOSED');
    if (jury.content_digest !== target.version)
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    registerTransactionDeadline(tx, jury.deadline.getTime(), 'JURY_CLOSED');
    const id = randomUUID();
    await tx.query(
      'INSERT INTO whaleu_safety.jury_ballots(id,jury_id,account_id,request_id,vote) VALUES($1,$2,$3,$4,$5)',
      [id, jury.id, actor, requestId, vote.vote],
    );
    if ((await this.settlement.settle(jury, tx)) === 'changed')
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    return id;
  }
  receipt(token: string, requestId: string): Promise<ReportReceipt> {
    return this.transaction(async (tx) => {
      const actor = (await this.identity.session(token, tx)).accountId;
      await this.records.rate(actor, 'read', tx);
      const row = (
        await tx.query<{ receipt: ReportReceipt }>(
          'SELECT receipt FROM whaleu_safety.report_requests WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL',
          [actor, requestId],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
      return row.receipt;
    });
  }
  private capability(
    code: ApplicationErrorCode | null,
    at: string,
  ): ReportCapability {
    if (code === null) return { status: 'allow', code: null, evaluatedAt: at };
    if (unavailable.has(code))
      return {
        status: 'unavailable',
        code: code as (typeof capabilityUnavailableCodes)[number],
        evaluatedAt: at,
      };
    return {
      status: 'deny',
      code: code as Exclude<
        ReportRejectionCode,
        'REPORT_TARGET_UNAVAILABLE' | 'JURY_NOT_FOUND'
      >,
      evaluatedAt: at,
    };
  }
  progress(token: string, target: ReportTarget): Promise<ReportProgress> {
    return this.transaction(async (tx) => {
      const actor = (await this.identity.session(token, tx)).accountId;
      await this.records.rate(actor, 'read', tx);
      // Optional authority failures never erase active-session or later visibility bounds.
      const checkpoint = checkpointTransactionDeadlines(tx);
      await tx.query('SAVEPOINT capability_work');
      let eligibilityError: ApplicationErrorCode | null = null,
        grants: ActiveGrant[] = [];
      try {
        await this.eligible(actor, tx);
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          (!terminal.has(error.code) && !unavailable.has(error.code))
        )
          throw error;
        await tx.query('ROLLBACK TO SAVEPOINT capability_work');
        restoreTransactionDeadlines(tx, checkpoint);
        eligibilityError = error.code;
      }
      const advisoryBounds = checkpointTransactionDeadlines(tx);
      restoreTransactionDeadlines(tx, checkpoint);
      await tx.query('RELEASE SAVEPOINT capability_work');
      let weightingError: ApplicationErrorCode | null = null;
      if (target.kind === 'post') {
        await tx.query('SAVEPOINT weighting_advisory');
        try {
          grants = await this.weighting.grants(actor, tx);
        } catch (error) {
          if (
            !(error instanceof ApplicationError) ||
            error.code !== 'AUTHORIZATION_UNAVAILABLE'
          )
            throw error;
          await tx.query('ROLLBACK TO SAVEPOINT weighting_advisory');
          weightingError = error.code;
        }
        await tx.query('RELEASE SAVEPOINT weighting_advisory');
      }

      const resolved = await this.targets.resolveVisible(
        target,
        actor,
        tx,
        false,
      );
      if (!resolved.native) throw new ApplicationError('SAFETY_UNAVAILABLE');
      const record = await this.records.case(target, tx),
        hasReported = record
          ? await this.records.reported(record.id, actor, tx)
          : false,
        isSelf = resolved.ownerAccountId === actor;
      const at = (
        await tx.query<{ now: Date }>(
          "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
        )
      ).rows[0]!.now.toISOString();
      for (const [code, until] of advisoryBounds)
        if (!checkpoint.has(code) && until <= Date.parse(at))
          eligibilityError = code;
      let reportCode: ApplicationErrorCode | null = isSelf
        ? 'REPORT_SELF_NOT_ALLOWED'
        : hasReported
          ? 'REPORT_ALREADY_REPORTED'
          : record && record.state !== 'open'
            ? 'REPORTING_CLOSED'
            : (eligibilityError ?? weightingError);
      if (!reportCode && target.kind === 'post') {
        const scoped = checkpointTransactionDeadlines(tx);
        try {
          const weight = this.weighting.resolve(grants, resolved.scope, tx);
          const selected = grants.find((g) => g.id === weight.grantId);
          if (
            selected?.validUntil !== null &&
            selected?.validUntil !== undefined &&
            selected.validUntil <= Date.parse(at)
          )
            throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
        } catch (error) {
          restoreTransactionDeadlines(tx, scoped);
          if (
            !(error instanceof ApplicationError) ||
            !unavailable.has(error.code)
          )
            throw error;
          reportCode = error.code;
        } finally {
          restoreTransactionDeadlines(tx, scoped);
        }
      }
      const base = {
        id: target.id,
        reportCount: record?.report_count ?? 0,
        hasReported,
        isSelf,
        reportCapability: this.capability(reportCode, at),
      };
      if (target.kind !== 'post')
        return {
          ...base,
          kind: target.kind,
          review: record ? 'provider_disabled' : null,
        };
      const jury = await this.records.jury(target.id, tx);
      if (!jury)
        return {
          ...base,
          kind: 'post',
          effectiveWeight: record?.effective_weight ?? 0,
          jury: null,
        };
      const counts = await this.records.ballots(jury.id, actor, tx),
        due = jury.deadline.getTime() <= Date.parse(at);
      const state =
        jury.state === 'kept' ? 'kept' : due ? 'settlement_pending' : 'pending';
      const voteCode: ApplicationErrorCode | null =
        isSelf || hasReported
          ? 'JURY_INELIGIBLE'
          : counts.own
            ? 'JURY_ALREADY_VOTED'
            : jury.state !== 'pending' || due
              ? 'JURY_CLOSED'
              : jury.content_digest !== resolved.version
                ? 'SAFETY_UNAVAILABLE'
                : eligibilityError;
      return {
        ...base,
        kind: 'post',
        effectiveWeight: record!.effective_weight,
        jury: {
          juryId: jury.id,
          state,
          createdAt: jury.created_at.toISOString(),
          deadline: jury.deadline.toISOString(),
          keepVotes: counts.keep,
          removeVotes: counts.remove,
          ownVote: counts.own,
          voteCapability: this.capability(voteCode, at),
        },
      };
    }, true);
  }
}
