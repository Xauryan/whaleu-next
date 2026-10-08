import { levelFor, titles } from './catalog.js';
import type { PublicExperienceDisplay } from './public-display.contract.js';

export interface DisplayRow {
  appearance_present: boolean;
  title_key: string | null;
  title_owned: boolean;
  title_name: string | null;
  color_id: number | null;
  catalog_color_id: number | null;
  balance_known: boolean;
  balance: string | null;
}

export function projectPublicExperienceDisplay(
  row: DisplayRow,
): PublicExperienceDisplay {
  const result: PublicExperienceDisplay = {
    title: { status: 'unavailable', value: null },
    color: { status: 'unavailable', value: null },
    level: { status: 'unavailable', value: null },
  };
  if (row.appearance_present) {
    if (row.title_key === null) result.title = { status: 'known', value: null };
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
    if (row.color_id === null) result.color = { status: 'known', value: null };
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
