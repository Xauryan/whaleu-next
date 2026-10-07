import { isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import {
  cursor,
  decodePost,
  exact,
  invalid,
  timestamp,
  uuid4,
  type Post,
} from './contract';
export type UpdateChannel = 'saved' | 'external';
export type SavedOperation = 'set_post_saved' | 'set_post_update_preference';
export interface PostUpdatePreferences {
  readonly postId: string;
  readonly savedUpdatesEnabled: boolean;
  readonly externalUpdatesEnabled: boolean;
  readonly revision: string;
  readonly canSetPreference: boolean;
  readonly reason: string | null;
  readonly inAppCapability: 'unavailable';
  readonly externalCapability: 'unavailable';
}
export interface SavedIntent {
  readonly clientRequestId: string;
  readonly operation: SavedOperation;
  readonly postId: string;
  readonly desired: boolean;
  readonly channel: UpdateChannel | null;
}
export type SavedReceipt = Omit<SavedIntent, 'clientRequestId'> & {
  readonly requestId: string;
} & (
    | { readonly outcome: 'applied' }
    | { readonly outcome: 'rejected'; readonly code: string }
  );
export interface SavedEntry {
  readonly post: Post;
  readonly savedAt: string;
  readonly saveEpochId: string;
}
export interface SavedList {
  readonly items: readonly SavedEntry[];
  readonly nextCursor: string | null;
  readonly visibleSavedCount: number;
}
export type SavedStatus =
  | { readonly postId: string; readonly status: 'unavailable' }
  | {
      readonly postId: string;
      readonly status: 'available';
      readonly saveCount: number;
      readonly isSaved: boolean;
      readonly savedAt: string | null;
      readonly saveEpochId: string | null;
      readonly preferences: PostUpdatePreferences;
    };
export interface SavedStatuses {
  readonly items: readonly SavedStatus[];
}
const codes = [
  'POST_NOT_FOUND',
  'COMMUNITY_SCOPE_UNAVAILABLE',
  'PHONE_VERIFICATION_REQUIRED',
  'COMMUNITY_ACTION_RESTRICTED',
] as const;
const count = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 2147483647;
export const isUpdateChannel = (value: unknown): value is UpdateChannel =>
  value === 'saved' || value === 'external';
function intentFields(
  value: Record<string, unknown>,
): Omit<SavedIntent, 'clientRequestId'> {
  if (
    !isUuid(value.postId) ||
    typeof value.desired !== 'boolean' ||
    !(
      (value.operation === 'set_post_saved' && value.channel === null) ||
      (value.operation === 'set_post_update_preference' &&
        isUpdateChannel(value.channel))
    )
  )
    invalid();
  return {
    operation: value.operation as SavedOperation,
    postId: value.postId,
    desired: value.desired,
    channel: value.channel as UpdateChannel | null,
  };
}
export function decodeSavedIntent(value: unknown): SavedIntent {
  exact(value, [
    'clientRequestId',
    'operation',
    'postId',
    'desired',
    'channel',
  ]);
  if (!uuid4(value.clientRequestId)) invalid();
  return Object.freeze({
    clientRequestId: value.clientRequestId,
    ...intentFields(value),
  });
}
export function decodeSavedReceipt(value: unknown): SavedReceipt {
  if (!isRecord(value)) invalid();
  exact(value, [
    'requestId',
    'operation',
    'postId',
    'desired',
    'channel',
    'outcome',
    ...(value.outcome === 'rejected' ? ['code'] : []),
  ]);
  if (
    !uuid4(value.requestId) ||
    (value.outcome !== 'applied' && value.outcome !== 'rejected')
  )
    invalid();
  const fields = intentFields(value);
  if (value.outcome === 'rejected') {
    if (!(codes as readonly unknown[]).includes(value.code)) invalid();
    return Object.freeze({
      requestId: value.requestId,
      ...fields,
      outcome: 'rejected',
      code: value.code as string,
    });
  }
  return Object.freeze({
    requestId: value.requestId,
    ...fields,
    outcome: 'applied',
  });
}
export function matchSavedReceipt(
  intent: SavedIntent,
  receipt: SavedReceipt,
): void {
  if (
    receipt.requestId !== intent.clientRequestId ||
    receipt.operation !== intent.operation ||
    receipt.postId !== intent.postId ||
    receipt.desired !== intent.desired ||
    receipt.channel !== intent.channel
  )
    invalid();
}
export function decodePostUpdatePreferences(
  value: unknown,
): PostUpdatePreferences {
  exact(value, [
    'postId',
    'savedUpdatesEnabled',
    'externalUpdatesEnabled',
    'revision',
    'canSetPreference',
    'reason',
    'inAppCapability',
    'externalCapability',
  ]);
  if (
    !isUuid(value.postId) ||
    typeof value.savedUpdatesEnabled !== 'boolean' ||
    typeof value.externalUpdatesEnabled !== 'boolean' ||
    typeof value.revision !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value.revision) ||
    value.revision.length > 30 ||
    typeof value.canSetPreference !== 'boolean' ||
    !(
      value.reason === null ||
      [...codes, 'COMMUNITY_UNAVAILABLE'].includes(
        value.reason as (typeof codes)[number],
      )
    ) ||
    (value.canSetPreference ? value.reason !== null : value.reason === null) ||
    value.inAppCapability !== 'unavailable' ||
    value.externalCapability !== 'unavailable'
  )
    invalid();
  return Object.freeze({ ...value }) as unknown as PostUpdatePreferences;
}
export function decodeSavedList(value: unknown): SavedList {
  exact(value, ['items', 'nextCursor', 'visibleSavedCount']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !cursor(value.nextCursor) ||
    !count(value.visibleSavedCount) ||
    value.visibleSavedCount < value.items.length
  )
    invalid();
  const items = value.items.map((raw): SavedEntry => {
    exact(raw, ['post', 'savedAt', 'saveEpochId']);
    const post = decodePost(raw.post);
    if (
      !post.viewer.isSaved ||
      post.saveCount < 1 ||
      !timestamp(raw.savedAt) ||
      !isUuid(raw.saveEpochId)
    )
      invalid();
    return Object.freeze({
      post,
      savedAt: raw.savedAt,
      saveEpochId: raw.saveEpochId,
    });
  });
  if (
    new Set(items.map((item) => item.post.id.toLowerCase())).size !==
      items.length ||
    new Set(items.map((item) => item.saveEpochId.toLowerCase())).size !==
      items.length ||
    (!items.length && value.nextCursor !== null)
  )
    invalid();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
    visibleSavedCount: value.visibleSavedCount,
  });
}
export function decodeSavedStatuses(value: unknown): SavedStatuses {
  exact(value, ['items']);
  if (
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 100
  )
    invalid();
  const items = value.items.map((raw): SavedStatus => {
    if (!isRecord(raw) || !isUuid(raw.postId)) invalid();
    if (raw.status === 'unavailable') {
      exact(raw, ['postId', 'status']);
      return Object.freeze({ postId: raw.postId, status: 'unavailable' });
    }
    exact(raw, [
      'postId',
      'status',
      'saveCount',
      'isSaved',
      'savedAt',
      'saveEpochId',
      'preferences',
    ]);
    if (
      raw.status !== 'available' ||
      !count(raw.saveCount) ||
      typeof raw.isSaved !== 'boolean' ||
      (raw.isSaved
        ? !timestamp(raw.savedAt) ||
          !isUuid(raw.saveEpochId) ||
          raw.saveCount < 1
        : raw.savedAt !== null || raw.saveEpochId !== null)
    )
      invalid();
    const preferences = decodePostUpdatePreferences(raw.preferences);
    if (preferences.postId !== raw.postId) invalid();
    return Object.freeze({
      postId: raw.postId,
      status: 'available',
      saveCount: raw.saveCount,
      isSaved: raw.isSaved,
      savedAt: raw.savedAt as string | null,
      saveEpochId: raw.saveEpochId as string | null,
      preferences,
    });
  });
  if (
    new Set(items.map((item) => item.postId.toLowerCase())).size !==
    items.length
  )
    invalid();
  return Object.freeze({ items: Object.freeze(items) });
}
