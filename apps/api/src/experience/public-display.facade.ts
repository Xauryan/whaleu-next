import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { levelFor, titles } from './catalog.js';
import type { PublicExperienceDisplay } from './public-display.contract.js';

interface DisplayRow {
  appearance_present: boolean;
  title_key: string | null;
  title_owned: boolean;
  title_name: string | null;
  color_id: number | null;
  catalog_color_id: number | null;
  balance_known: boolean;
  balance: string | null;
}

/** Caller authorizes the named subject and owns the transaction. Cosmetics are
 * one committed statement snapshot, not a permission or freshness proof. */
@Injectable()
export class ExperiencePublicDisplayFacade {
  async read(
    accountId: string,
    tx: PoolClient,
  ): Promise<PublicExperienceDisplay> {
    // Do not lock owners: callers can hold content locks and later visit more
    // content, while source enrollment acquires content before sorted owners.
    const row = (
      await tx.query<DisplayRow>(
        `SELECT a.owner_id IS NOT NULL AS appearance_present,
                a.title_key,e.title_key IS NOT NULL AS title_owned,
                t.name AS title_name,a.color_id,c.color_id AS catalog_color_id,
                s.owner_id IS NOT NULL AND b.owner_id IS NOT NULL AS balance_known,
                s.balance::text AS balance
           FROM (VALUES ($1::uuid)) AS requested(account_id)
           LEFT JOIN whaleu_experience.appearance a ON a.owner_id=requested.account_id
           LEFT JOIN whaleu_experience.entitlements e ON e.owner_id=a.owner_id AND e.title_key=a.title_key
           LEFT JOIN whaleu_experience.title_catalog t ON t.title_key=e.title_key
           LEFT JOIN whaleu_experience.color_catalog c ON c.color_id=a.color_id
           LEFT JOIN whaleu_experience.account_states s ON s.owner_id=requested.account_id
           LEFT JOIN whaleu_experience.baselines b ON b.owner_id=s.owner_id`,
        [accountId],
      )
    ).rows[0];
    if (!row) throw new Error('Public experience projection returned no row');

    const result: PublicExperienceDisplay = {
      title: { status: 'unavailable', value: null },
      color: { status: 'unavailable', value: null },
      level: { status: 'unavailable', value: null },
    };
    if (row.appearance_present) {
      if (row.title_key === null)
        result.title = { status: 'known', value: null };
      else {
        const title = titles.find((entry) => entry.key === row.title_key);
        // Ownership requires the exact selected owner/key. A missing earned
        // date is irrelevant; only the supported catalog supplies public text.
        if (row.title_owned && title && title.name === row.title_name)
          result.title = {
            status: 'known',
            value: { key: title.key, name: title.name },
          };
      }
      if (row.color_id === null)
        result.color = { status: 'known', value: null };
      else if (
        Number.isInteger(row.color_id) &&
        row.color_id >= 0 &&
        row.color_id <= 25 &&
        row.catalog_color_id === row.color_id
      )
        // Retained colors do not have to remain eligible at the current level.
        result.color = { status: 'known', value: row.color_id };
    }
    if (row.balance_known && row.balance !== null)
      result.level = { status: 'known', value: levelFor(BigInt(row.balance)) };
    return result;
  }
}
