import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { projectPublicExperienceDisplay } from './public-display.projection.js';
import type { DisplayRow } from './public-display.projection.js';
import type { PublicExperienceDisplay } from './public-display.contract.js';

export const RANKING_CANDIDATE_BUDGET = 256;
export interface RankingCandidate {
  accountId: string;
  experienceDisplay: PublicExperienceDisplay;
}
export interface RankingWindow {
  candidates: RankingCandidate[];
  hasMore: boolean;
}

/** Experience-only, single-statement snapshot. Never enrolls or settles owners. */
@Injectable()
export class ExperienceRankingSourceFacade {
  async read(tx: PoolClient): Promise<RankingWindow> {
    const { rows } = await tx.query<DisplayRow & { account_id: string }>(
      `SELECT s.owner_id AS account_id,
              a.owner_id IS NOT NULL AS appearance_present,
              a.title_key,e.title_key IS NOT NULL AS title_owned,
              t.name AS title_name,a.color_id,c.color_id AS catalog_color_id,
              true AS balance_known,s.balance::text AS balance
         FROM whaleu_experience.account_states s
         INNER JOIN whaleu_experience.baselines b ON b.owner_id=s.owner_id
         LEFT JOIN whaleu_experience.appearance a ON a.owner_id=s.owner_id
         LEFT JOIN whaleu_experience.entitlements e ON e.owner_id=a.owner_id AND e.title_key=a.title_key
         LEFT JOIN whaleu_experience.title_catalog t ON t.title_key=e.title_key
         LEFT JOIN whaleu_experience.color_catalog c ON c.color_id=a.color_id
        ORDER BY s.balance DESC,s.owner_id ASC
        LIMIT $1`,
      [RANKING_CANDIDATE_BUDGET + 1],
    );
    if (rows.length > RANKING_CANDIDATE_BUDGET + 1)
      throw new ApplicationError('EXPERIENCE_RANKING_UNAVAILABLE');
    const seen = new Set<string>();
    const candidates = rows.slice(0, RANKING_CANDIDATE_BUDGET).map((row) => {
      if (
        !row.account_id ||
        seen.has(row.account_id) ||
        !row.balance_known ||
        row.balance === null ||
        !/^(?:0|[1-9][0-9]*)$/.test(row.balance) ||
        BigInt(row.balance) > 9223372036854775807n
      )
        throw new ApplicationError('EXPERIENCE_RANKING_UNAVAILABLE');
      seen.add(row.account_id);
      return {
        accountId: row.account_id,
        experienceDisplay: projectPublicExperienceDisplay(row),
      };
    });
    return { candidates, hasMore: rows.length > RANKING_CANDIDATE_BUDGET };
  }
}
