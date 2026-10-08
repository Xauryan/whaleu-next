import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { supportedPostgresVersion } from '../../database/database.js';
import { hotScoreInputsSchema } from './contracts.js';
import type { HotScoreInputs } from './contracts.js';
import { HOT_SCORE_NUMERIC_SQL } from './formula.js';

export class HotScoreNumericError extends Error {
  constructor() {
    super('Internal score numeric evaluation unavailable');
  }
}
@Injectable()
export class HotScoreEvaluator {
  async evaluate(input: HotScoreInputs, tx: PoolClient): Promise<string> {
    const parsed = hotScoreInputsSchema.safeParse(input);
    if (!parsed.success) throw new HotScoreNumericError();
    const data = parsed.data;
    try {
      const row = (
        await tx.query<{ score: string; server_version: number }>(
          HOT_SCORE_NUMERIC_SQL,
          [
            data.views,
            data.postLikes,
            data.subscriptions,
            data.eligibleComments,
            data.uniqueEligibleAccounts,
          ],
        )
      ).rows[0];
      if (
        !row ||
        !supportedPostgresVersion(row.server_version) ||
        typeof row.score !== 'string' ||
        !/^(0|[1-9][0-9]{0,19})\.[0-9]{4}$/.test(row.score)
      )
        throw new HotScoreNumericError();
      return row.score;
    } catch {
      throw new HotScoreNumericError();
    }
  }
}
