import { ClientError, isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
export interface FollowState {
  readonly profileId: string;
  readonly following: boolean;
}
export function decodeFollowState(value: unknown): FollowState {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => key !== 'profileId' && key !== 'following',
    ) ||
    !isUuid(value.profileId) ||
    typeof value.following !== 'boolean'
  )
    throw new ClientError('protocol', 'Invalid follow response');
  return { profileId: value.profileId, following: value.following };
}
export const followRejectionCodes = [
  'POST_NOT_FOUND',
  'FOLLOW_SELF_NOT_ALLOWED',
  'SAFETY_ACTION_RESTRICTED',
  'SAFETY_ACCESS_SUSPENDED',
] as const;
export type FollowRejectionCode = (typeof followRejectionCodes)[number];
export type FollowReceipt = FollowState & { readonly requestId: string } & (
    | { readonly outcome: 'applied' }
    | { readonly outcome: 'rejected'; readonly code: FollowRejectionCode }
  );
export function decodeFollowReceipt(value: unknown): FollowReceipt {
  if (
    !isRecord(value) ||
    !isUuid(value.requestId) ||
    !isUuid(value.profileId) ||
    typeof value.following !== 'boolean' ||
    !['applied', 'rejected'].includes(String(value.outcome)) ||
    Object.keys(value).some(
      (key) =>
        ![
          'requestId',
          'profileId',
          'following',
          'outcome',
          ...(value.outcome === 'rejected' ? ['code'] : []),
        ].includes(key),
    )
  )
    throw new ClientError('protocol', 'Invalid follow receipt');
  const base = {
    requestId: value.requestId,
    profileId: value.profileId,
    following: value.following,
  };
  if (value.outcome === 'applied') return { ...base, outcome: 'applied' };
  if (!(followRejectionCodes as readonly unknown[]).includes(value.code))
    throw new ClientError('protocol', 'Invalid follow rejection');
  return {
    ...base,
    outcome: 'rejected',
    code: value.code as FollowRejectionCode,
  };
}
