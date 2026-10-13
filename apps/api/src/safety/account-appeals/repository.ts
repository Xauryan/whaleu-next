import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { ApplicationError } from '../../http/application-error.js';
import type {
  AppealSubmitCommand,
  AppealDecisionCommand,
  AppealSubmitReceipt,
  AppealDecisionReceipt,
  PunishmentReference,
} from '../account-moderation/contracts.js';
import type { AppealSeek } from './cursor.js';
export interface AppealCase {
  id: string;
  subject_id: string;
  punishment_id: string;
  kind: PunishmentReference['kind'];
  revision: string;
  text: string;
  submitted_at: Date;
  outcome: 'upheld' | 'released' | 'closed_no_longer_effective' | null;
  decision_reason: string | null;
  decided_at: Date | null;
  state_version: string;
}
export interface AppealRequest {
  intent_hash: string;
  receipt: AppealSubmitReceipt | AppealDecisionReceipt;
}
export interface AppealSession {
  actorId: string;
  sessionId: string;
  tokenHash: string;
}
@Injectable()
export class AccountAppealsRepository {
  constructor(@Inject(APP_CONFIG) private readonly config: RuntimeConfig) {}
  async rate(
    actor: string,
    action: 'submit' | 'decide' | 'read',
    tx: PoolClient,
  ): Promise<void> {
    const cap =
      action === 'read'
        ? this.config.SAFETY_REPORT_READS_PER_MINUTE
        : this.config.SAFETY_REPORTS_PER_MINUTE;
    const result = await tx.query<{ hits: number }>(
      `INSERT INTO whaleu_safety.account_appeal_rate_buckets(account_id,action,window_start,hits)
      VALUES($1,$2,date_trunc('minute',clock_timestamp()),1)
      ON CONFLICT(account_id,action) DO UPDATE SET window_start=date_trunc('minute',clock_timestamp()),
      hits=CASE WHEN whaleu_safety.account_appeal_rate_buckets.window_start=date_trunc('minute',clock_timestamp())
      THEN LEAST(whaleu_safety.account_appeal_rate_buckets.hits+1,1000000) ELSE 1 END RETURNING hits`,
      [actor, action],
    );
    if (result.rows[0]!.hits > cap) throw new ApplicationError('RATE_LIMITED');
  }
  async requestLock(
    actor: string,
    request: string,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('account-appeal-request:'||$1||':'||$2,0))",
      [actor, request],
    );
  }
  async caseLock(punishment: string, tx: PoolClient): Promise<void> {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('account-appeal-case:'||$1,0))",
      [punishment],
    );
  }
  async request(
    actor: string,
    request: string,
    tx: PoolClient,
  ): Promise<AppealRequest | null> {
    return (
      (
        await tx.query<AppealRequest>(
          'SELECT intent_hash,receipt FROM whaleu_safety.account_appeal_commands WHERE actor_id=$1 AND request_id=$2',
          [actor, request],
        )
      ).rows[0] ?? null
    );
  }
  async save(
    input: {
      session: AppealSession;
      command: AppealSubmitCommand | AppealDecisionCommand;
      hash: string;
      receipt: AppealSubmitReceipt | AppealDecisionReceipt;
      grantId?: string;
      appealId?: string;
    },
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO whaleu_safety.account_appeal_commands(actor_id,request_id,session_id,token_hash,action,intent,intent_hash,receipt,grant_id,appeal_id,identity_fingerprint,grant_fingerprint)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
      whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts($1,$3,$4)),
      CASE WHEN $9::uuid IS NULL THEN NULL ELSE whaleu_safety.account_appeal_grant_fingerprint($1,$9) END)`,
      [
        input.session.actorId,
        input.command.clientRequestId,
        input.session.sessionId,
        input.session.tokenHash,
        input.command.action,
        input.command,
        input.hash,
        input.receipt,
        input.grantId ?? null,
        input.appealId ?? null,
      ],
    );
  }
  async open(punishment: string, tx: PoolClient): Promise<string | null> {
    return (
      (
        await tx.query<{ appeal_id: string }>(
          'SELECT appeal_id FROM whaleu_safety.account_appeal_open_cases WHERE punishment_id=$1',
          [punishment],
        )
      ).rows[0]?.appeal_id ?? null
    );
  }
  async create(
    id: string,
    actor: string,
    command: AppealSubmitCommand,
    at: string,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO whaleu_safety.account_appeals(id,subject_id,punishment_id,kind,revision,text,submitted_at,source_request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        actor,
        command.punishment.punishmentId,
        command.punishment.kind,
        command.punishment.revision,
        command.text,
        at,
        command.clientRequestId,
      ],
    );
    await tx.query(
      'INSERT INTO whaleu_safety.account_appeal_open_cases(punishment_id,appeal_id) VALUES($1,$2)',
      [command.punishment.punishmentId, id],
    );
  }
  async case(
    id: string,
    owner: string | null,
    tx: PoolClient,
  ): Promise<AppealCase | null> {
    return (
      (
        await tx.query<AppealCase>(
          `SELECT c.*,c.revision::text,d.outcome,d.reason decision_reason,d.recorded_at decided_at,
      whaleu_safety.account_appeal_state_version(c.id) state_version FROM whaleu_safety.account_appeals c
      LEFT JOIN whaleu_safety.account_appeal_decisions d ON d.appeal_id=c.id
      WHERE c.id=$1 AND ($2::uuid IS NULL OR c.subject_id=$2)`,
          [id, owner],
        )
      ).rows[0] ?? null
    );
  }
  async page(
    owner: string | null,
    limit: number,
    seek: AppealSeek | null,
    tx: PoolClient,
  ): Promise<AppealCase[]> {
    return (
      await tx.query<AppealCase>(
        `SELECT c.*,c.revision::text,d.outcome,d.reason decision_reason,d.recorded_at decided_at,
      whaleu_safety.account_appeal_state_version(c.id) state_version FROM whaleu_safety.account_appeals c
      LEFT JOIN whaleu_safety.account_appeal_decisions d ON d.appeal_id=c.id
      WHERE ($1::uuid IS NULL OR c.subject_id=$1)
      AND ($2::timestamptz IS NULL OR (c.submitted_at,c.id)<($2::timestamptz,$3::uuid))
      ORDER BY c.submitted_at DESC,c.id DESC LIMIT $4`,
        [owner, seek?.at ?? null, seek?.id ?? null, limit + 1],
      )
    ).rows;
  }
  async decide(
    input: {
      id: string;
      appeal: AppealCase;
      session: AppealSession;
      grantId: string;
      command: AppealDecisionCommand;
      outcome: NonNullable<AppealCase['outcome']>;
      at: string;
      releaseEventId: string | null;
    },
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO whaleu_safety.account_appeal_decisions(id,appeal_id,actor_id,session_id,grant_id,source_request_id,outcome,reason,recorded_at,expected_state_version,release_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.id,
        input.appeal.id,
        input.session.actorId,
        input.session.sessionId,
        input.grantId,
        input.command.clientRequestId,
        input.outcome,
        input.command.reason,
        input.at,
        input.command.expectedStateVersion,
        input.releaseEventId,
      ],
    );
    await tx.query(
      'DELETE FROM whaleu_safety.account_appeal_open_cases WHERE punishment_id=$1 AND appeal_id=$2',
      [input.appeal.punishment_id, input.appeal.id],
    );
    await tx.query(
      `INSERT INTO whaleu_notifications.account_appeal_notices(id,decision_id,appeal_id,recipient_account_id,kind,outcome,reason,created_at)
      VALUES($1,$1,$2,$3,'account_appeal_decided',$4,$5,$6)`,
      [
        input.id,
        input.appeal.id,
        input.appeal.subject_id,
        input.outcome,
        input.command.reason,
        input.at,
      ],
    );
  }
}
