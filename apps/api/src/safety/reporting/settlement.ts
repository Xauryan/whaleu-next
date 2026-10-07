import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { CommunityReportTargetFacade } from '../../community/report-target.facade.js';
import type { ResolvedReportTarget } from '../../community/report-target.facade.js';
import { CommunityModerationRemovalFacade } from '../../community/moderation-removal.facade.js';
import { SystemNoticesService } from '../../notifications/system-notices/service.js';
import { ReportsRepository } from './repository.js';
import type { PostJury, ReportCase } from './repository.js';
export function juryOutcome(
  keep: number,
  remove: number,
  due: boolean,
): 'kept' | 'removed' | null {
  if (keep >= 6) return 'kept';
  if (remove >= 6) return 'removed';
  return due ? (remove > keep ? 'removed' : 'kept') : null;
}
@Injectable()
export class JurySettlementService {
  constructor(
    @Inject(CommunityReportTargetFacade)
    private readonly targets: CommunityReportTargetFacade,
    @Inject(CommunityModerationRemovalFacade)
    private readonly removal: CommunityModerationRemovalFacade,
    @Inject(ReportsRepository) private readonly records: ReportsRepository,
    @Inject(SystemNoticesService)
    private readonly notices: SystemNoticesService,
  ) {}
  /** Caller has acquired shared policy gate and post UPDATE before the jury lock. */
  async settle(
    jury: PostJury,
    tx: PoolClient,
  ): Promise<'completed' | 'pending' | 'changed'> {
    if (jury.state !== 'pending') return 'completed';
    const counts = await this.records.ballots(jury.id, null, tx);
    const now = (
      await tx.query<{ now: Date }>(
        "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
      )
    ).rows[0]!.now;
    const outcome = juryOutcome(
      counts.keep,
      counts.remove,
      jury.deadline <= now,
    );
    if (!outcome) return 'pending';
    const current = await this.targets.lockForSettlement(
      { kind: 'post', id: jury.post_id },
      jury.content_digest,
      tx,
    );
    if (current.status === 'changed') return 'changed';
    const record = (
      await tx.query<ReportCase>(
        'SELECT * FROM whaleu_safety.report_cases WHERE id=$1 FOR UPDATE',
        [jury.case_id],
      )
    ).rows[0]!;
    const decisionId = randomUUID();
    let final: 'kept' | 'removed' | 'superseded' =
      current.status === 'removed' ? 'superseded' : outcome;
    if (final === 'removed') {
      const result = await this.removal.remove(
        {
          target: { kind: 'post', id: jury.post_id },
          expectedVersion: jury.content_digest,
          cause: 'post_jury',
          decisionId,
        },
        tx,
      );
      if (result === 'changed') return 'changed';
      if (result === 'already_removed') final = 'superseded';
    }
    const reason =
      final === 'superseded'
        ? 'target_unavailable'
        : counts.keep >= 6 || counts.remove >= 6
          ? 'six_votes'
          : 'deadline';
    const decision = (
      await tx.query<{ decided_at: Date }>(
        `INSERT INTO whaleu_safety.report_decisions(id,case_id,owner_account_id,cause,outcome,reason,keep_votes,remove_votes) VALUES($1,$2,$3,'post_jury',$4,$5,$6,$7) RETURNING decided_at`,
        [
          decisionId,
          jury.case_id,
          record.owner_account_id,
          final,
          reason,
          counts.keep,
          counts.remove,
        ],
      )
    ).rows[0]!;
    await tx.query(
      'UPDATE whaleu_safety.post_juries SET state=$2,decision_id=$3 WHERE id=$1',
      [jury.id, final, decisionId],
    );
    await tx.query(
      'UPDATE whaleu_safety.report_cases SET state=$2 WHERE id=$1',
      [jury.case_id, final],
    );
    await tx.query(
      "UPDATE whaleu_safety.jury_work SET state='completed',error_code=NULL WHERE jury_id=$1",
      [jury.id],
    );
    if (final === 'removed')
      await this.notices.appendPostJuryRemoval(
        {
          decisionId,
          ownerAccountId: record.owner_account_id,
          keepVotes: counts.keep,
          removeVotes: counts.remove,
          occurredAt: decision.decided_at,
        },
        tx,
      );
    return 'completed';
  }
  async removeDiscussion(
    record: ReportCase,
    target: ResolvedReportTarget,
    tx: PoolClient,
  ) {
    const decisionId = randomUUID();
    const result = await this.removal.remove(
      {
        target: target.target,
        expectedVersion: record.content_digest,
        cause: 'discussion_report_threshold',
        decisionId,
      },
      tx,
    );
    if (result !== 'removed') throw new ApplicationError('SAFETY_UNAVAILABLE');
    await tx.query(
      `INSERT INTO whaleu_safety.report_decisions(id,case_id,owner_account_id,cause,outcome,reason,keep_votes,remove_votes) VALUES($1,$2,$3,'discussion_report_threshold','removed','ten_reports',0,0)`,
      [decisionId, record.id, record.owner_account_id],
    );
    await tx.query(
      "UPDATE whaleu_safety.report_cases SET state='removed' WHERE id=$1",
      [record.id],
    );
  }
}
