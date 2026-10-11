import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import {
  activityReviewDigest,
  activityReviewEnvelopeSchema,
} from './contracts.js';
import type { ActivityReviewEnvelope } from './contracts.js';
import { requireActivityCurrent } from './current-proof.js';
export const ACTIVITY_REVIEW_RUNTIME = Symbol('ACTIVITY_REVIEW_RUNTIME');
/** Explicit local simulation, never registered with an allow-default provider. */
export interface ActivityReviewRuntime {
  readonly mode: 'simulation';
  readonly policyId: string;
  readonly issuer: string;
  readonly validFrom: Date;
  readonly validUntil: Date;
  evaluate(
    envelope: Readonly<ActivityReviewEnvelope>,
  ): Promise<{ result: 'allow' | 'reject' | 'failed'; provenanceRef: string }>;
}
interface ReviewRow {
  id: string;
  digest: string;
  result: 'allow' | 'reject' | 'failed';
  state: 'allow' | 'held' | 'revoked';
  evaluated_at: Date;
  consume_until: Date;
  valid_from: Date;
  valid_until: Date;
  policy_key: string;
  provenance: string;
  coverage: string;
  envelope: unknown;
  exact_time_valid: boolean;
  exact_consume_valid: boolean;
}
@Injectable()
export class ActivityReviewService {
  async row(jobId: string, tx: PoolClient) {
    return (
      (
        await tx.query<ReviewRow>(
          `SELECT d.*,h.state,p.valid_from,p.valid_until,p.policy_key,p.provenance,j.envelope,(d.evaluated_at<=clock_timestamp() AND e.occurred_at>=d.evaluated_at AND e.occurred_at<=clock_timestamp() AND p.valid_from<=d.evaluated_at AND p.valid_until>clock_timestamp()) exact_time_valid,(d.consume_until>clock_timestamp()) exact_consume_valid FROM whaleu_activities.review_decisions d JOIN whaleu_activities.review_heads h ON h.decision_id=d.id JOIN whaleu_activities.review_events e ON(e.id,e.decision_id,e.revision,e.state)=(h.event_id,h.decision_id,h.revision,h.state) JOIN whaleu_activities.review_policies p ON p.id=d.policy_id JOIN whaleu_activities.review_jobs j ON j.id=d.job_id WHERE d.job_id=$1`,
          [jobId],
        )
      ).rows[0] ?? null
    );
  }
  async status(
    jobId: string,
    tx: PoolClient,
  ): Promise<'pending' | 'ready' | 'rejected' | 'unavailable'> {
    const row = await this.row(jobId, tx);
    if (!row) return 'pending';
    try {
      await this.require(row, true, tx);
      return 'ready';
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        error.code === 'CONTENT_REJECTED'
      )
        return 'rejected';
      return 'unavailable';
    }
  }
  async accepted(
    jobId: string,
    envelope: ActivityReviewEnvelope,
    tx: PoolClient,
  ) {
    const row = await this.row(jobId, tx);
    if (
      !row ||
      row.exact_time_valid !== true ||
      row.exact_consume_valid !== true ||
      row.digest !== activityReviewDigest(envelope) ||
      canonicalJson(row.envelope) !== canonicalJson(envelope)
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    await this.require(row, true, tx);
    return row.id;
  }
  async published(decisionId: string, activityId: string, tx: PoolClient) {
    const job = (
      await tx.query<{ job_id: string }>(
        `SELECT d.job_id FROM whaleu_activities.review_decisions d JOIN whaleu_activities.review_jobs j ON j.id=d.job_id WHERE d.id=$1 AND j.activity_id=$2`,
        [decisionId, activityId],
      )
    ).rows[0];
    if (!job) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const row = await this.row(job.job_id, tx);
    if (!row) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    await this.require(row, false, tx);
    return activityReviewEnvelopeSchema.parse(row.envelope);
  }
  private async require(row: ReviewRow, consume: boolean, tx: PoolClient) {
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]!.now.getTime();
    const envelope = activityReviewEnvelopeSchema.parse(row.envelope);
    if (
      row.exact_time_valid !== true ||
      (consume && row.exact_consume_valid !== true) ||
      row.digest !== activityReviewDigest(envelope) ||
      row.policy_key !== 'activity-simulation-v1' ||
      row.provenance !== 'simulation' ||
      row.coverage !== 'complete' ||
      row.evaluated_at.getTime() > now ||
      row.valid_from.getTime() > row.evaluated_at.getTime() ||
      row.valid_until.getTime() <= now ||
      (consume && row.consume_until.getTime() <= now)
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      Math.min(
        row.valid_until.getTime(),
        consume ? row.consume_until.getTime() : Infinity,
      ),
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    await requireActivityCurrent('review', row.id, tx);
    if (row.result === 'reject' || row.state === 'revoked')
      throw new ApplicationError('CONTENT_REJECTED');
    if (row.result !== 'allow' || row.state !== 'allow')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  }
}
@Injectable()
export class ActivityReviewProcessor {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ACTIVITY_REVIEW_RUNTIME)
    private readonly runtime: ActivityReviewRuntime | null,
  ) {}
  /** Queue consumer invoked explicitly by a controlled local simulation harness.
   * It consumes real submissions, not seeded approvals; no public HTTP issuer. */
  async processOne() {
    const runtime = this.runtime;
    if (!runtime || runtime.mode !== 'simulation')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const job = await this.db.transaction(
      async (tx) =>
        (
          await tx.query<{ id: string; digest: string; envelope: unknown }>(
            `SELECT j.id,j.digest,j.envelope FROM whaleu_activities.review_jobs j LEFT JOIN whaleu_activities.review_decisions d ON d.job_id=j.id LEFT JOIN whaleu_activities.publication_cancel_fences c ON(c.actor_id,c.client_request_id)=(j.actor_id,j.client_request_id) WHERE d.id IS NULL AND c.actor_id IS NULL ORDER BY j.created_at,j.id LIMIT 1`,
          )
        ).rows[0] ?? null,
      { isolationLevel: 'read committed' },
    );
    if (!job) return { state: 'idle' as const };
    const envelope = activityReviewEnvelopeSchema.parse(job.envelope);
    if (job.digest !== activityReviewDigest(envelope))
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const freeze = (v: unknown): void => {
      if (v && typeof v === 'object') {
        Object.values(v).forEach(freeze);
        Object.freeze(v);
      }
    };
    freeze(envelope);
    const decision = await runtime.evaluate(envelope);
    if (
      !['allow', 'reject', 'failed'].includes(decision.result) ||
      !decision.provenanceRef.trim()
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return this.db.transaction(
      async (tx) => {
        await tx.query("SET LOCAL lock_timeout='500ms'");
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:activity-review:v1:'||$1,0))",
          [job.id],
        );
        const current = (
          await tx.query(
            `SELECT j.id FROM whaleu_activities.review_jobs j WHERE j.id=$1 AND j.digest=$2 AND NOT EXISTS(SELECT 1 FROM whaleu_activities.review_decisions WHERE job_id=j.id) AND NOT EXISTS(SELECT 1 FROM whaleu_activities.publication_cancel_fences c WHERE(c.actor_id,c.client_request_id)=(j.actor_id,j.client_request_id))`,
            [job.id, job.digest],
          )
        ).rowCount;
        if (!current) return { state: 'superseded' as const };
        await tx.query(
          `INSERT INTO whaleu_activities.review_policies(id,policy_key,issuer,provenance,valid_from,valid_until) VALUES($1,'activity-simulation-v1',$2,'simulation',$3,$4) ON CONFLICT(id) DO NOTHING`,
          [
            runtime.policyId,
            runtime.issuer,
            runtime.validFrom,
            runtime.validUntil,
          ],
        );
        const policy = (
          await tx.query<{
            valid_from: Date;
            valid_until: Date;
            issuer: string;
          }>(
            `SELECT valid_from,valid_until,issuer FROM whaleu_activities.review_policies WHERE id=$1 AND valid_from<=clock_timestamp() AND valid_until>clock_timestamp()`,
            [runtime.policyId],
          )
        ).rows[0];
        if (
          !policy ||
          policy.issuer !== runtime.issuer ||
          policy.valid_from.getTime() !== runtime.validFrom.getTime() ||
          policy.valid_until.getTime() !== runtime.validUntil.getTime()
        )
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
        const id = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_activities.review_decisions(id,job_id,policy_id,digest,result,coverage,provenance_ref,consume_until) VALUES($1,$2,$3,$4,$5,'complete',$6,clock_timestamp()+interval '10 minutes')`,
          [
            id,
            job.id,
            runtime.policyId,
            job.digest,
            decision.result,
            decision.provenanceRef,
          ],
        );
        const eventId = randomUUID(),
          state = decision.result === 'allow' ? 'allow' : 'held';
        await tx.query(
          `INSERT INTO whaleu_activities.review_events(id,decision_id,revision,state,provenance_ref) VALUES($1,$2,1,$3,$4)`,
          [eventId, id, state, decision.provenanceRef],
        );
        await tx.query(
          `INSERT INTO whaleu_activities.review_heads(decision_id,state,event_id) VALUES($1,$2,$3)`,
          [id, state, eventId],
        );
        return { state: 'reviewed' as const, result: decision.result };
      },
      { isolationLevel: 'read committed' },
    );
  }
}
