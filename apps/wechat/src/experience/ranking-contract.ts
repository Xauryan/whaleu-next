import { ClientError, isRecord } from '../api/errors';
import { boundedText } from '../community/contract';
import { isUuid } from '../profile/contract';
import {
  decodePublicExperienceDisplay,
  type PublicExperienceDisplay,
} from './public-display';

export interface ExperienceRankingItem {
  readonly profileId: string;
  readonly displayName: string;
  readonly experienceDisplay: PublicExperienceDisplay;
}
export interface ExperienceRanking {
  readonly scope: 'global';
  readonly population: 'known_participants';
  readonly populationCompleteness: 'incomplete';
  readonly selectionStatus:
    'limit_reached' | 'available_candidates_exhausted' | 'scan_limited';
  readonly items: readonly ExperienceRankingItem[];
}
function invalid(): never {
  throw new ClientError('protocol', 'Invalid public experience list');
}
function exact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalid();
}
export function decodeExperienceRanking(raw: unknown): ExperienceRanking {
  exact(raw, [
    'scope',
    'population',
    'populationCompleteness',
    'selectionStatus',
    'items',
  ]);
  if (
    raw.scope !== 'global' ||
    raw.population !== 'known_participants' ||
    raw.populationCompleteness !== 'incomplete' ||
    ![
      'limit_reached',
      'available_candidates_exhausted',
      'scan_limited',
    ].includes(raw.selectionStatus as string) ||
    !Array.isArray(raw.items) ||
    raw.items.length > 50
  )
    invalid();
  // This native entry always requests 50. A status cannot claim the limit early.
  if ((raw.selectionStatus === 'limit_reached') !== (raw.items.length === 50))
    invalid();
  const seen = new Set<string>();
  const items = raw.items.map((item: unknown) => {
    exact(item, ['profileId', 'displayName', 'experienceDisplay']);
    if (
      !isUuid(item.profileId) ||
      seen.has(item.profileId) ||
      !boundedText(item.displayName, 1, 100)
    )
      invalid();
    seen.add(item.profileId);
    return Object.freeze({
      profileId: item.profileId,
      displayName: item.displayName,
      experienceDisplay: decodePublicExperienceDisplay(item.experienceDisplay),
    });
  });
  return Object.freeze({
    scope: 'global',
    population: 'known_participants',
    populationCompleteness: 'incomplete',
    selectionStatus:
      raw.selectionStatus as ExperienceRanking['selectionStatus'],
    items: Object.freeze(items),
  });
}
