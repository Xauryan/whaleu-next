import { isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import { exact, invalid, uuid4 } from './contract';

export interface PostLikeIntent {
  readonly requestId: string;
  readonly operation: 'set_post_like';
  readonly postId: string;
  readonly liked: boolean;
}
export type PostLikeReceipt = PostLikeIntent &
  (
    | { readonly outcome: 'applied' }
    | { readonly outcome: 'rejected'; readonly code: PostLikeRejection }
  );
export type PostLikeRejection =
  | 'POST_NOT_FOUND'
  | 'COMMUNITY_SCOPE_UNAVAILABLE'
  | 'PHONE_VERIFICATION_REQUIRED'
  | 'COMMUNITY_ACTION_RESTRICTED';
const codes: readonly PostLikeRejection[] = [
  'POST_NOT_FOUND',
  'COMMUNITY_SCOPE_UNAVAILABLE',
  'PHONE_VERIFICATION_REQUIRED',
  'COMMUNITY_ACTION_RESTRICTED',
];
function fields(value: Record<string, unknown>): PostLikeIntent {
  if (
    !uuid4(value.requestId) ||
    !isUuid(value.postId) ||
    value.operation !== 'set_post_like' ||
    typeof value.liked !== 'boolean'
  )
    invalid();
  return {
    requestId: value.requestId,
    operation: 'set_post_like',
    postId: value.postId,
    liked: value.liked,
  };
}
export function decodePostLikeIntent(value: unknown): PostLikeIntent {
  exact(value, ['requestId', 'operation', 'postId', 'liked']);
  return Object.freeze(fields(value));
}
/** Historical acknowledgement only; current membership and counts require a new read. */
export function decodePostLikeReceipt(value: unknown): PostLikeReceipt {
  if (!isRecord(value)) invalid();
  exact(value, [
    'requestId',
    'operation',
    'postId',
    'liked',
    'outcome',
    ...(value.outcome === 'rejected' ? ['code'] : []),
  ]);
  const intent = fields(value);
  if (value.outcome === 'rejected') {
    if (!(codes as readonly unknown[]).includes(value.code)) invalid();
    return Object.freeze({
      ...intent,
      outcome: 'rejected',
      code: value.code as PostLikeRejection,
    });
  }
  if (value.outcome !== 'applied') invalid();
  return Object.freeze({ ...intent, outcome: 'applied' });
}
export function matchPostLikeReceipt(
  intent: PostLikeIntent,
  receipt: PostLikeReceipt,
): void {
  if (
    receipt.requestId !== intent.requestId ||
    receipt.operation !== intent.operation ||
    receipt.postId !== intent.postId ||
    receipt.liked !== intent.liked
  )
    invalid();
}
