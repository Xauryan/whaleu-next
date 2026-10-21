import { z } from 'zod';
export const followRequestSchema = z.strictObject({ requestId: z.uuid() });
export interface FollowState {
  profileId: string;
  following: boolean;
}
export const followRejectionCodes = [
  'POST_NOT_FOUND',
  'FOLLOW_SELF_NOT_ALLOWED',
  'SAFETY_ACTION_RESTRICTED',
  'SAFETY_ACCESS_SUSPENDED',
] as const;
export type FollowRejectionCode = (typeof followRejectionCodes)[number];
export type FollowReceipt = FollowState & { requestId: string } & (
    { outcome: 'applied' } | { outcome: 'rejected'; code: FollowRejectionCode }
  );
