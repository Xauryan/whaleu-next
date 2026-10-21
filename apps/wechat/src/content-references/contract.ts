import { ClientError, isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';
import { isContentReferenceCode } from './text';
export interface ReferenceTarget {
  readonly kind: 'post' | 'comment' | 'reply';
  readonly targetId: string;
}
export type ReferenceDestination =
  | {
      readonly kind: 'post';
      readonly postId: string;
      readonly viewSpaceId?: string;
    }
  | {
      readonly kind: 'comment';
      readonly postId: string;
      readonly rootCommentId: string;
      readonly viewSpaceId?: string;
    }
  | {
      readonly kind: 'reply';
      readonly postId: string;
      readonly rootCommentId: string;
      readonly replyId: string;
      readonly viewSpaceId?: string;
    };
export interface ReferenceCode extends ReferenceTarget {
  readonly code: string;
}
export function invalidReference(): never {
  throw new ClientError('protocol', 'Invalid content reference response');
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
    invalidReference();
}
export function referenceTargetKey(target: ReferenceTarget): string {
  return `${target.kind}:${target.targetId}`;
}
export function decodeReferenceTarget(value: unknown): ReferenceTarget {
  exact(value, ['kind', 'targetId']);
  if (
    !['post', 'comment', 'reply'].includes(String(value.kind)) ||
    !isUuid(value.targetId)
  )
    invalidReference();
  return {
    kind: value.kind as ReferenceTarget['kind'],
    targetId: value.targetId,
  };
}
export function decodeReferenceCapability(value: unknown): {
  available: boolean;
} {
  exact(value, ['available']);
  if (typeof value.available !== 'boolean') invalidReference();
  return { available: value.available };
}
export function decodeReferenceDestination(
  value: unknown,
): ReferenceDestination {
  if (!isRecord(value)) invalidReference();
  const keys =
    value.kind === 'post'
      ? ['kind', 'postId']
      : value.kind === 'comment'
        ? ['kind', 'postId', 'rootCommentId']
        : value.kind === 'reply'
          ? ['kind', 'postId', 'rootCommentId', 'replyId']
          : [];
  if (!keys.length) invalidReference();
  if (Object.prototype.hasOwnProperty.call(value, 'viewSpaceId'))
    keys.push('viewSpaceId');
  exact(value, keys);
  if (keys.some((key) => key !== 'kind' && !isUuid(value[key])))
    invalidReference();
  return { ...value } as ReferenceDestination;
}
export function decodeReferenceLookup(value: unknown): {
  items: ReferenceCode[];
} {
  exact(value, ['items']);
  if (!Array.isArray(value.items) || value.items.length > 30)
    invalidReference();
  const seen = new Set<string>();
  const codes = new Set<string>();
  return {
    items: value.items.map((item: unknown) => {
      exact(item, ['kind', 'targetId', 'code']);
      const target = decodeReferenceTarget({
        kind: item.kind,
        targetId: item.targetId,
      });
      const key = referenceTargetKey(target);
      if (
        !isContentReferenceCode(item.code) ||
        seen.has(key) ||
        codes.has(item.code)
      )
        invalidReference();
      seen.add(key);
      codes.add(item.code);
      return { ...target, code: item.code };
    }),
  };
}
/** IDs remain UUIDs. Numeric width never chooses destination kind or traversal. */
export function referenceDestinationPath(raw: ReferenceDestination): string {
  const value = decodeReferenceDestination(raw);
  return (
    `/pages/community-detail/community-detail?postId=${value.postId}` +
    (value.kind !== 'post' ? `&rootCommentId=${value.rootCommentId}` : '') +
    (value.kind === 'reply' ? `&replyId=${value.replyId}` : '') +
    (value.viewSpaceId ? `&viewSpaceId=${value.viewSpaceId}` : '')
  );
}
