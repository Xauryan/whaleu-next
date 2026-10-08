import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  MaintenanceOperation,
  MaintenanceReceipt,
} from './maintenance.contracts.js';

export interface MaintenanceRequestRow {
  actor_id: string;
  request_id: string;
  intent_hash: string;
  operation: MaintenanceOperation;
  run_id: string;
  previous_request_id: string | null;
  run_started_at: Date;
  upper_account_id: string | null;
  cursor_before: string | null;
  cursor_after: string | null;
  receipt: MaintenanceReceipt;
}
export interface MaintenanceItem {
  ownerId: string;
  eligible: boolean;
  knownBalance: string | null;
  stateRevision: string | null;
  observedLevel: number | null;
  outcome:
    'repaired' | 'unchanged' | 'skipped_unknown_level' | 'skipped_ineligible';
  grantedTitleKeys: string[];
}
export interface MaintenanceDecision {
  actorId: string;
  sessionId: string;
  grantId: string;
  intentHash: string;
  runStartedAt: Date;
  upperAccountId: string | null;
  cursorBefore: string | null;
  cursorAfter: string | null;
  receipt: MaintenanceReceipt;
  item: MaintenanceItem | null;
}
@Injectable()
export class TitleMaintenanceRepository {
  /** Distinct namespace: an owner request UUID is never an administrative request. */
  async requestLock(actor: string, request: string, tx: PoolClient) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      JSON.stringify(['experience-title-maintenance', actor, request]),
    ]);
  }
  async request(
    actor: string,
    request: string,
    tx: PoolClient,
    lock = false,
  ): Promise<MaintenanceRequestRow | null> {
    return (
      (
        await tx.query<MaintenanceRequestRow>(
          `SELECT actor_id,request_id,intent_hash,operation,run_id,previous_request_id,run_started_at,upper_account_id,cursor_before,cursor_after,receipt FROM whaleu_experience.maintenance_requests WHERE actor_id=$1 AND request_id=$2${lock ? ' FOR UPDATE' : ''}`,
          [actor, request],
        )
      ).rows[0] ?? null
    );
  }
  async successor(
    actor: string,
    previous: string,
    tx: PoolClient,
  ): Promise<string | null> {
    return (
      (
        await tx.query<{ request_id: string }>(
          'SELECT request_id FROM whaleu_experience.maintenance_requests WHERE actor_id=$1 AND previous_request_id=$2',
          [actor, previous],
        )
      ).rows[0]?.request_id ?? null
    );
  }
  async missingTitles(
    owner: string,
    keys: readonly string[],
    tx: PoolClient,
  ): Promise<string[]> {
    const owned = new Set(
      (
        await tx.query<{ title_key: string }>(
          'SELECT title_key FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key=ANY($2::text[])',
          [owner, keys],
        )
      ).rows.map((row) => row.title_key),
    );
    return keys.filter((key) => !owned.has(key));
  }
  async save(decision: MaintenanceDecision, tx: PoolClient): Promise<void> {
    const {
      actorId,
      sessionId,
      grantId,
      intentHash,
      runStartedAt,
      upperAccountId,
      cursorBefore,
      cursorAfter,
      receipt,
      item,
    } = decision;
    const at = (
      await tx.query<{ decided_at: Date }>(
        'INSERT INTO whaleu_experience.maintenance_requests(actor_id,request_id,intent_hash,operation,run_id,previous_request_id,run_started_at,upper_account_id,cursor_before,cursor_after,grant_id,session_id,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING decided_at',
        [
          actorId,
          receipt.requestId,
          intentHash,
          receipt.operation,
          receipt.runId,
          receipt.previousRequestId,
          runStartedAt,
          upperAccountId,
          cursorBefore,
          cursorAfter,
          grantId,
          sessionId,
          JSON.stringify(receipt),
        ],
      )
    ).rows[0]!.decided_at;
    if (!item) return;
    await tx.query(
      'INSERT INTO whaleu_experience.maintenance_items(actor_id,request_id,owner_id,eligible,known_balance,state_revision,observed_level,outcome,granted_title_keys,decided_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        actorId,
        receipt.requestId,
        item.ownerId,
        item.eligible,
        item.knownBalance,
        item.stateRevision,
        item.observedLevel,
        item.outcome,
        item.grantedTitleKeys,
        at,
      ],
    );
    for (const key of item.grantedTitleKeys) {
      await tx.query(
        'INSERT INTO whaleu_experience.maintenance_grants(actor_id,request_id,owner_id,title_key) VALUES($1,$2,$3,$4)',
        [actorId, receipt.requestId, item.ownerId, key],
      );
      await tx.query(
        "INSERT INTO whaleu_experience.entitlements(owner_id,title_key,origin,maintenance_actor_id,maintenance_request_id,earned_at) VALUES($1,$2,'maintenance',$3,$4,$5)",
        [item.ownerId, key, actorId, receipt.requestId, at],
      );
    }
  }
}
