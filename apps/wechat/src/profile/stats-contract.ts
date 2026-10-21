import { ClientError, isRecord } from '../api/errors';
import { isUuid } from './contract';

export interface UnavailableProfileCount {
  readonly status: 'unavailable';
  readonly value: null;
}
export type ProfileCount =
  | { readonly status: 'known'; readonly value: number }
  | UnavailableProfileCount;
export interface OwnProfileStats {
  readonly accountId: string;
  readonly following: ProfileCount;
  readonly followers: ProfileCount;
  readonly receivedInteractions: UnavailableProfileCount;
}
export const unavailableProfileCount = (): UnavailableProfileCount => ({
  status: 'unavailable',
  value: null,
});
const exact = (
  raw: unknown,
  keys: readonly string[],
): raw is Record<string, unknown> =>
  isRecord(raw) &&
  Object.keys(raw).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(raw, key));
function invalid(): never {
  throw new ClientError('protocol', 'Invalid own profile statistics');
}
function decodeCount(raw: unknown): ProfileCount {
  if (!exact(raw, ['status', 'value'])) invalid();
  if (raw.status === 'unavailable' && raw.value === null)
    return Object.freeze(unavailableProfileCount());
  if (
    raw.status === 'known' &&
    typeof raw.value === 'number' &&
    Number.isSafeInteger(raw.value) &&
    raw.value >= 0
  )
    return Object.freeze({ status: 'known', value: raw.value });
  return invalid();
}
/** Counts describe currently visible relationships, never lifetime or anonymous activity. */
export function decodeOwnProfileStats(raw: unknown): OwnProfileStats {
  if (
    !exact(raw, [
      'accountId',
      'following',
      'followers',
      'receivedInteractions',
    ]) ||
    !isUuid(raw.accountId)
  )
    invalid();
  const following = decodeCount(raw.following);
  const followers = decodeCount(raw.followers);
  const receivedInteractions = decodeCount(raw.receivedInteractions);
  // A complete safe received-interaction total is not part of this contract.
  if (receivedInteractions.status !== 'unavailable') invalid();
  return Object.freeze({
    accountId: raw.accountId,
    following,
    followers,
    receivedInteractions,
  });
}
