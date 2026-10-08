import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { DatabaseService } from '../database/database.js';

interface Counter {
  total_hits: number;
  expires_at: Date;
  blocked_until: Date | null;
}

/** Shared fixed-window attempt accounting, committed before business work starts.
 * The official guard owns request policy; this adapter owns atomic storage only.
 * A block lasts from the first rejected attempt and is never extended by retries.
 */
@Injectable()
export class PostgresThrottlerStorage implements ThrottlerStorage {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ) {
    if (
      !key ||
      key.length > 1024 ||
      !throttlerName ||
      throttlerName.length > 128 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000000 ||
      [ttl, blockDuration].some(
        (value) =>
          !Number.isSafeInteger(value) || value < 1 || value > 86400000,
      )
    )
      throw new Error('Invalid shared throttler configuration');
    const storageKey = createHash('sha256')
      .update(JSON.stringify([throttlerName, key]))
      .digest('hex');
    return this.database.transaction(
      async (tx) => {
        await tx.query(`SET LOCAL lock_timeout='1s';
        SET LOCAL statement_timeout='2s'; SET LOCAL transaction_timeout='3s'`);
        // A conflicting first insert waits, then SELECT takes the current row.
        // Time is evaluated only after that lock, never before a concurrent wait.
        await tx.query(
          `INSERT INTO whaleu_runtime.request_throttle_counters
        (storage_key,total_hits,expires_at) VALUES ($1,0,clock_timestamp())
        ON CONFLICT (storage_key) DO NOTHING`,
          [storageKey],
        );
        const row = (
          await tx.query<Counter>(
            `SELECT total_hits,expires_at,blocked_until
          FROM whaleu_runtime.request_throttle_counters
          WHERE storage_key=$1 FOR UPDATE`,
            [storageKey],
          )
        ).rows[0];
        if (!row) throw new Error('Shared throttler row is unavailable');
        const now = (
          await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
        ).rows[0]!.now.getTime();
        let hits = row.total_hits;
        let expires = row.expires_at.getTime();
        let blocked = row.blocked_until?.getTime() ?? null;
        if (
          !Number.isFinite(now) ||
          !Number.isFinite(expires) ||
          (blocked !== null && !Number.isFinite(blocked))
        )
          throw new Error('Shared throttler clock is unavailable');
        if (blocked === null || blocked <= now) {
          if (expires <= now || blocked !== null) {
            hits = 0;
            expires = now + ttl;
            blocked = null;
          }
          hits = Math.min(hits + 1, 1000001);
          if (hits > limit) blocked = now + blockDuration;
          await tx.query(
            `UPDATE whaleu_runtime.request_throttle_counters
          SET total_hits=$2,expires_at=$3,blocked_until=$4 WHERE storage_key=$1`,
            [
              storageKey,
              hits,
              new Date(expires),
              blocked === null ? null : new Date(blocked),
            ],
          );
        }
        return {
          totalHits: hits,
          timeToExpire: Math.max(0, Math.ceil((expires - now) / 1000)),
          isBlocked: blocked !== null && blocked > now,
          timeToBlockExpire:
            blocked === null
              ? 0
              : Math.max(0, Math.ceil((blocked - now) / 1000)),
        };
      },
      { isolationLevel: 'read committed' },
    );
  }

  /** Bounded, cross-process-safe retention, also called without request traffic. */
  async cleanup(): Promise<number> {
    return this.database.transaction(
      async (tx) => {
        await tx.query(`SET LOCAL lock_timeout='100ms';
        SET LOCAL statement_timeout='2s'; SET LOCAL transaction_timeout='3s'`);
        const result = await tx.query(
          `WITH expired AS MATERIALIZED (
        SELECT storage_key FROM whaleu_runtime.request_throttle_counters
        WHERE GREATEST(expires_at,COALESCE(blocked_until,expires_at))
          <= clock_timestamp()
        ORDER BY GREATEST(expires_at,COALESCE(blocked_until,expires_at)),storage_key
        FOR UPDATE SKIP LOCKED LIMIT 256
      ) DELETE FROM whaleu_runtime.request_throttle_counters c USING expired e
        WHERE c.storage_key=e.storage_key
          AND GREATEST(c.expires_at,COALESCE(c.blocked_until,c.expires_at))
            <= clock_timestamp()`,
        );
        return result.rowCount ?? 0;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
