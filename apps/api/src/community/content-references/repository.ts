import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { ReferenceTarget } from './contracts.js';

export interface ReferencePolicy {
  state: 'inactive' | 'allocating' | 'ready';
  public_enabled: boolean;
}
export interface ReferenceCanonical extends ReferenceTarget {
  code: string;
}
/** All methods use their caller's transaction. No content, body, author or
 * account identifier is stored in the immutable reservation namespace. */
@Injectable()
export class ContentReferenceRepository {
  async policy(
    tx: PoolClient,
    lock: 'none' | 'share' | 'update' = 'none',
  ): Promise<ReferencePolicy> {
    const row = (
      await tx.query<ReferencePolicy>(
        `SELECT state,public_enabled FROM whaleu_community.content_reference_policy WHERE singleton ${lock === 'update' ? 'FOR UPDATE' : lock === 'share' ? 'FOR SHARE' : ''}`,
      )
    ).rows[0];
    if (
      !row ||
      !['inactive', 'allocating', 'ready'].includes(row.state) ||
      typeof row.public_enabled !== 'boolean'
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return row;
  }
  async publicReady(tx: PoolClient, lock = false): Promise<boolean> {
    const policy = await this.policy(tx, lock ? 'share' : 'none');
    return policy.state === 'ready' && policy.public_enabled;
  }
  async resolve(code: string, tx: PoolClient): Promise<ReferenceTarget | null> {
    return (
      (
        await tx.query<ReferenceTarget>(
          `SELECT target_kind AS kind,target_id AS "targetId" FROM whaleu_community.content_reference_reservations WHERE code=$1`,
          [code],
        )
      ).rows[0] ?? null
    );
  }
  async canonical(
    target: ReferenceTarget,
    tx: PoolClient,
  ): Promise<string | null> {
    return (
      (
        await tx.query<{ code: string }>(
          'SELECT code FROM whaleu_community.content_reference_canonicals WHERE target_kind=$1 AND target_id=$2',
          [target.kind, target.targetId],
        )
      ).rows[0]?.code ?? null
    );
  }
  /** Must be called after the allocator's exclusive policy lock. Every alias
   * and canonical shares the same PK, independent of its width or target kind. */
  async allocate(target: ReferenceTarget, tx: PoolClient): Promise<string> {
    const prior = await this.canonical(target, tx);
    if (prior) return prior;
    const name = target.kind === 'post' ? 'post' : 'child';
    const sequence = (
      await tx.query<{ next_code: string; maximum: string }>(
        'SELECT next_code::text,maximum::text FROM whaleu_community.content_reference_sequences WHERE name=$1 FOR UPDATE',
        [name],
      )
    ).rows[0];
    if (!sequence) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const start = Number(sequence.next_code),
      maximum = Number(sequence.maximum);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(maximum) ||
      start > maximum
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    // A bounded index probe per candidate. Reconciliation must set high-water
    // marks before allocation; a dense unreconciled range fails, never wraps.
    const code = (
      await tx.query<{ code: string }>(
        `SELECT candidate::text AS code FROM generate_series($1::bigint,$2::bigint) candidate
       WHERE NOT EXISTS (SELECT 1 FROM whaleu_community.content_reference_reservations WHERE code=candidate::text AND (target_kind<>$3 OR target_id<>$4::uuid))
       ORDER BY candidate LIMIT 1`,
        [start, Math.min(maximum, start + 4095), target.kind, target.targetId],
      )
    ).rows[0]?.code;
    if (!code) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    // An existing same-target alias can become canonical without rewriting its
    // immutable reservation. The composite FK rejects any conflicting winner.
    await tx.query(
      'INSERT INTO whaleu_community.content_reference_reservations(code,target_kind,target_id) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING',
      [code, target.kind, target.targetId],
    );
    await tx.query(
      'INSERT INTO whaleu_community.content_reference_canonicals(code,target_kind,target_id) VALUES($1,$2,$3)',
      [code, target.kind, target.targetId],
    );
    await tx.query(
      'UPDATE whaleu_community.content_reference_sequences SET next_code=$2::bigint+1 WHERE name=$1',
      [name, code],
    );
    return code;
  }
  /** Atomic per-viewer limiter. Denied/missing outcomes must be returned from
   * the transaction, then translated into errors AFTER commit, so misses count.
   * Authentication/authority dependency faults fail closed, not as empty data. */
  async consume(
    viewer: string,
    operation: 'resolve' | 'lookup',
    tx: PoolClient,
  ): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO whaleu_community.content_reference_budgets AS budget(viewer_id,operation,window_start,used)
       VALUES($1,$2,date_trunc('minute',statement_timestamp()),1)
       ON CONFLICT(viewer_id,operation) DO UPDATE SET
         window_start=GREATEST(budget.window_start,EXCLUDED.window_start),
         used=CASE WHEN budget.window_start<EXCLUDED.window_start THEN 1 ELSE budget.used+1 END
       WHERE budget.window_start<EXCLUDED.window_start OR budget.used<$3
       RETURNING used`,
      [viewer, operation, operation === 'resolve' ? 60 : 120],
    );
    return result.rowCount === 1;
  }
}
