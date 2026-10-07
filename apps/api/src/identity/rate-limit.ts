import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.js';
import type { RuntimeConfig } from '../config/config.js';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';

@Injectable()
export class IdentityRateLimiter {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}
  async consume(
    operation: 'login' | 'refresh' | 'logout',
    address: string,
  ): Promise<void> {
    const key = this.config.AUTH_RATE_LIMIT_KEY;
    if (!key) throw new ApplicationError('AUTH_NOT_CONFIGURED');
    const hash = (value: string) =>
      createHmac('sha256', Buffer.from(key, 'hex')).update(value).digest('hex');
    const allowed = await this.database.transaction(async (client) => {
      // Bounded opportunistic cleanup; a separate retention job is still required for session history.
      await client.query(`DELETE FROM whaleu_identity.rate_buckets WHERE (bucket_hash, window_start) IN
        (SELECT bucket_hash,window_start FROM whaleu_identity.rate_buckets
          WHERE window_start < clock_timestamp() - interval '2 minutes' LIMIT 100)`);
      for (const [bucket, limit] of [
        [hash(`global:${operation}`), 300],
        [
          hash(`${operation}:${address.slice(0, 128)}`),
          operation === 'login' ? 20 : 60,
        ],
      ] as const) {
        const result = await client.query<{ hits: number }>(
          `INSERT INTO whaleu_identity.rate_buckets (bucket_hash,window_start,hits)
          VALUES ($1,date_trunc('minute',clock_timestamp()),1)
          ON CONFLICT (bucket_hash,window_start) DO UPDATE SET hits=LEAST(whaleu_identity.rate_buckets.hits+1,1000000) RETURNING hits`,
          [bucket],
        );
        if (result.rows[0]!.hits > limit) return false;
      }
      return true;
    });
    if (!allowed) throw new ApplicationError('RATE_LIMITED');
  }
}
