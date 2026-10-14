import { createHmac, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RatingGroupPromotionService } from './service.js';
import { commandHash, type Command } from './contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import { retainPromotion } from './proof.js';
/** Manual bounded admission only. No timer, cron route, startup scheduler or
 * inferred daily cadence. Schedules and service grants are accepted fixtures. */
@Injectable()
export class RatingPromotionScheduler {
  constructor(
    @Inject(RatingGroupPromotionService)
    private readonly app: RatingGroupPromotionService,
  ) {}
  async admitDue(): Promise<{ admitted: number; skipped: number }> {
    const result = { admitted: 0, skipped: 0 };
    if (!this.app.runtime) return result;
    for (let n = 0; n < 8; n++) {
      const outcome = await this.app.run(async (tx) => {
        const schedule = (
          await tx.query<{
            program_id: string;
            lineage: string;
            principal_lineage: string;
            grant_revision: string;
            program_revision: string;
            next_ordinal: string;
            due_at: Date;
            late: boolean;
            future_ordinal: string;
            anchor: Date;
            period_seconds: number;
          }>(
            `SELECT *,next_ordinal::text,next_due_at due_at,next_due_at+interval '15 minutes'<=clock_timestamp() late,(floor(extract(epoch FROM (clock_timestamp()-anchor))/period_seconds)+1)::bigint::text future_ordinal FROM whaleu_ratings.promotion_schedules WHERE enabled AND next_due_at<=clock_timestamp() ORDER BY next_due_at,program_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          )
        ).rows[0];
        if (!schedule) return null;
        await this.app.verifyRuntime(tx);
        const p = await this.app.program(schedule.program_id, tx, true);
        const ordinal = schedule.late
          ? schedule.future_ordinal
          : (BigInt(schedule.next_ordinal) + 1n).toString();
        await tx.query(
          `UPDATE whaleu_ratings.promotion_schedules SET next_ordinal=$2,next_due_at=anchor+$2::bigint*period_seconds*interval '1 second' WHERE program_id=$1`,
          [p.id, ordinal],
        );
        if (schedule.late) {
          await tx.query(
            `INSERT INTO whaleu_ratings.promotion_slots(program_lineage,schedule_lineage,slot_ordinal,due_at,outcome) VALUES($1,$2,$3,$4,'skipped') ON CONFLICT DO NOTHING`,
            [
              p.lineage,
              schedule.lineage,
              schedule.next_ordinal,
              schedule.due_at,
            ],
          );
          return 'skipped' as const;
        }
        const rt = this.app.enabled();
        if (schedule.program_revision !== p.revision)
          throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
        await rt.authority.service(p, schedule.principal_lineage, tx);
        await rt.source.current(p, tx);
        if (
          !(
            await tx.query(
              `SELECT 1 FROM whaleu_ratings.promotion_grants WHERE program_id=$1 AND principal_lineage=$2 AND kind='service' AND revision=$3 AND active AND valid_until>clock_timestamp()`,
              [p.id, schedule.principal_lineage, schedule.grant_revision],
            )
          ).rows[0]
        )
          throw new ApplicationError('PROMOTION_UNAVAILABLE');
        await this.app.reserveAdmission(
          p.id,
          schedule.principal_lineage,
          false,
          tx,
        );
        const recipients = (
          await tx.query<{ n: number }>(
            `SELECT count(*)::int n FROM (SELECT stable_destination_id FROM whaleu_ratings.promotion_program_members_current WHERE program_id=$1 AND audience_kind IN('school_treehole','default_treehole') ORDER BY stable_destination_id LIMIT 10001) m`,
            [p.id],
          )
        ).rows[0]!.n;
        if (recipients > 10000)
          throw new ApplicationError('PROMOTION_QUOTA_EXCEEDED');
        const previewId = randomUUID(),
          requestId = randomUUID(),
          campaignId = randomUUID();
        const preview = {
          type: p.type,
          mode: 'normal' as const,
          expectedProgramRevision: p.revision,
        };
        const command: Command = {
          ...preview,
          previewId,
          programId: p.id,
          principalLineage: schedule.principal_lineage,
          requestId,
          sourceBindingHash: p.source_hash,
          audienceEpoch: p.audience_epoch,
          copyMode: 'deterministic',
          linkMode: 'native',
        };
        const hash = commandHash(command),
          ticket = createHmac('sha256', rt.ticketSecret)
            .update(
              `scheduled:${p.lineage}:${schedule.lineage}:${schedule.next_ordinal}:${hash}`,
            )
            .digest('base64url');
        await tx.query(
          `INSERT INTO whaleu_ratings.promotion_previews(id,program_id,actor,command,source_hash,audience_epoch,grant_revision,grant_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            previewId,
            p.id,
            schedule.principal_lineage,
            preview,
            p.source_hash,
            p.audience_epoch,
            schedule.grant_revision,
            p.grant_epoch,
          ],
        );
        await tx.query(
          `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) INSERT INTO whaleu_ratings.promotion_intents(request_id,program_id,actor,preview_id,command,request_hash,ticket,issued_at,expires_at) SELECT $1,$2,$3,$4,$5,$6,$7,now,now+interval '15 minutes' FROM instant`,
          [
            requestId,
            p.id,
            schedule.principal_lineage,
            previewId,
            command,
            hash,
            ticket,
          ],
        );
        await tx.query(
          `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) INSERT INTO whaleu_ratings.promotion_campaigns(id,request_id,program_id,actor,request_hash,command,program_revision,source_hash,audience_epoch,grant_revision,grant_epoch,created_at,expires_at,compose_by,mode,recipient_count,principal_kind)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now,$12::timestamptz+interval '30 minutes',now+interval '2 minutes','normal',$13,'service' FROM instant`,
          [
            campaignId,
            requestId,
            p.id,
            schedule.principal_lineage,
            hash,
            command,
            p.revision,
            p.source_hash,
            p.audience_epoch,
            schedule.grant_revision,
            p.grant_epoch,
            schedule.due_at,
            recipients,
          ],
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.promotion_campaign_recipients SELECT $1,stable_destination_id,enrollment_revision,registry_revision,audience_kind,school_scope_id FROM whaleu_ratings.promotion_program_members_current WHERE program_id=$2 AND audience_kind IN('school_treehole','default_treehole') ORDER BY stable_destination_id`,
          [campaignId, p.id],
        );
        await tx.query(
          'UPDATE whaleu_ratings.promotion_campaigns SET snapshot_sealed=true WHERE id=$1',
          [campaignId],
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.promotion_admissions(campaign_id,program_id,actor,is_test) VALUES($1,$2,$3,false)`,
          [campaignId, p.id, schedule.principal_lineage],
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.promotion_slots(program_lineage,schedule_lineage,slot_ordinal,due_at,outcome,campaign_id) VALUES($1,$2,$3,$4,'admitted',$5)`,
          [
            p.lineage,
            schedule.lineage,
            schedule.next_ordinal,
            schedule.due_at,
            campaignId,
          ],
        );
        retainPromotion(
          {
            programId: p.id,
            revision: p.revision,
            sourceHash: p.source_hash,
            grantEpoch: p.grant_epoch,
            audienceEpoch: p.audience_epoch,
          },
          tx,
        );
        return 'admitted' as const;
      });
      if (!outcome) break;
      result[outcome]++;
    }
    return result;
  }
}
