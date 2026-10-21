import { isRecord } from '../../api/errors';
export type SocialNoticeKind = 'likes' | 'followers' | 'comments';
export function socialNoticeKind(query: unknown): SocialNoticeKind | null {
  if (!isRecord(query) || Object.keys(query).length !== 1) return null;
  return query.kind === 'likes' ||
    query.kind === 'followers' ||
    query.kind === 'comments'
    ? query.kind
    : null;
}
