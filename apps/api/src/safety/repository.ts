import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { VisibilityPurpose } from '../community/community-policy.js';
export interface SafetyHead {
  state_version?: string;
  block_coverage: string;
  restriction_coverage: string;
  provenance: string;
  actions_allowed: boolean | null;
  valid_until: Date | null;
}
export interface StoredBlock {
  id: string;
  blocker_id: string;
  blocked_id: string;
  active: boolean;
  revision: string;
  display_snapshot: string | null;
  updated_at: Date;
}
@Injectable()
export class SafetyRepository {
  async head(accountId: string, tx: PoolClient): Promise<SafetyHead | null> {
    return (
      (
        await tx.query<SafetyHead>(
          'SELECT block_coverage,restriction_coverage,provenance,actions_allowed,valid_until,xmin::text state_version FROM whaleu_safety.account_heads WHERE account_id=$1 FOR SHARE',
          [accountId],
        )
      ).rows[0] ?? null
    );
  }
  async restriction(accountId: string, tx: PoolClient): Promise<number | null> {
    const head = await this.head(accountId, tx);
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now.getTime();
    if (
      !head ||
      head.restriction_coverage !== 'complete' ||
      head.block_coverage !== 'complete' ||
      head.provenance === 'unknown' ||
      (head.valid_until && head.valid_until.getTime() <= now)
    )
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    if (!head.actions_allowed)
      throw new ApplicationError('SAFETY_ACTION_RESTRICTED');
    registerTransactionDeadline(
      tx,
      head.valid_until?.getTime() ?? null,
      'SAFETY_UNAVAILABLE',
    );
    return head.valid_until?.getTime() ?? null;
  }
  /** Narrow own-account selector state, never moderation evidence or phone values. */
  async selectionEligibility(
    accountId: string,
    tx: PoolClient,
  ): Promise<{
    status: 'allowed' | 'restricted' | 'unavailable';
    fingerprint: SafetyHead | null;
  }> {
    let status: 'allowed' | 'restricted' | 'unavailable' = 'allowed';
    try {
      await this.restriction(accountId, tx);
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      if (error.code === 'SAFETY_ACTION_RESTRICTED') status = 'restricted';
      else if (error.code === 'SAFETY_UNAVAILABLE') status = 'unavailable';
      else throw error;
    }
    if (status === 'unavailable') return { status, fingerprint: null };
    const head = await this.head(accountId, tx);
    if (!head) throw new ApplicationError('SAFETY_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      head.valid_until?.getTime() ?? null,
      'SAFETY_UNAVAILABLE',
    );
    return { status, fingerprint: head };
  }
  async directions(
    viewer: string,
    author: string,
    purpose: VisibilityPurpose,
    tx: PoolClient,
  ): Promise<{ outgoing: boolean; incoming: boolean } | null> {
    const ids =
      purpose === 'list_projection'
        ? [viewer]
        : [...new Set([viewer, author])].sort();
    for (const id of ids) {
      const head = await this.head(id, tx);
      const now = (
        await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
      ).rows[0]!.now.getTime();
      if (
        !head ||
        (head.valid_until !== null && head.valid_until.getTime() <= now) ||
        head.block_coverage !== 'complete' ||
        head.provenance === 'unknown'
      )
        return null;
      registerTransactionDeadline(
        tx,
        head.valid_until?.getTime() ?? null,
        'COMMUNITY_UNAVAILABLE',
      );
    }
    const row = (
      await tx.query<{ outgoing: boolean; incoming: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM whaleu_safety.blocks WHERE blocker_id=$1 AND blocked_id=$2 AND active) AS outgoing,
      EXISTS(SELECT 1 FROM whaleu_safety.blocks WHERE blocker_id=$2 AND blocked_id=$1 AND active) AS incoming`,
        [viewer, author],
      )
    ).rows[0]!;
    return row;
  }
  async own(actor: string, id: string, tx: PoolClient): Promise<StoredBlock> {
    const row = (
      await tx.query<StoredBlock>(
        'SELECT * FROM whaleu_safety.blocks WHERE blocker_id=$1 AND id=$2',
        [actor, id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('BLOCK_NOT_FOUND');
    return row;
  }
  async rate(
    actor: string,
    action: 'block_named' | 'unblock_named' | 'read_own_blocks',
    tx: PoolClient,
  ) {
    // New policy, not inherited legacy numbers: 30 fresh mutations/action/minute,
    // 120 own reads/minute. One bounded row per account/action, no growing windows.
    const result = await tx.query<{ hits: number }>(
      `INSERT INTO whaleu_safety.rate_buckets(account_id,action,window_start,hits) VALUES($1,$2,date_trunc('minute',clock_timestamp()),1)
      ON CONFLICT(account_id,action) DO UPDATE SET window_start=date_trunc('minute',clock_timestamp()),hits=CASE WHEN whaleu_safety.rate_buckets.window_start=date_trunc('minute',clock_timestamp()) THEN LEAST(whaleu_safety.rate_buckets.hits+1,1000000) ELSE 1 END RETURNING hits`,
      [actor, action],
    );
    if (result.rows[0]!.hits > (action === 'read_own_blocks' ? 120 : 30))
      throw new ApplicationError('RATE_LIMITED');
  }
}
