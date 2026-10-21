import type { ApiClient } from '../api/client';
import {
  cursor,
  decodeAuthor,
  decodeMedia,
  displayDiscussionText,
  exact,
  invalid,
  timestamp,
  type AuthorMode,
} from '../community/contract';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from './contract';
import type { DiscoveryContinuation, LikedItem } from './discovery-contract';

export type OwnPublicationKind = 'topic' | 'reply';
export interface OwnPublicationItem {
  readonly kind: 'post' | 'comment' | 'reply';
  readonly targetId: string;
  readonly postId: string;
  readonly rootCommentId: string | null;
  readonly createdAt: string;
  readonly preview: LikedItem['preview'];
}
export interface OwnPublicationPage {
  readonly items: readonly OwnPublicationItem[];
  readonly continuation: DiscoveryContinuation;
  readonly nextCursor: string | null;
}
export interface OwnPublicationsGateway {
  read(
    kind: OwnPublicationKind,
    identity: AuthorMode,
    after: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<OwnPublicationPage>;
}
export function decodeOwnPublicationPage(raw: unknown): OwnPublicationPage {
  exact(raw, ['items', 'continuation', 'nextCursor']);
  if (
    !Array.isArray(raw.items) ||
    raw.items.length > 50 ||
    !cursor(raw.nextCursor) ||
    !['more', 'scan_pending', 'end'].includes(String(raw.continuation)) ||
    (raw.continuation === 'end'
      ? raw.nextCursor !== null
      : raw.nextCursor === null) ||
    (raw.continuation === 'more' && raw.items.length === 0)
  )
    invalid();
  const items = raw.items.map((value): OwnPublicationItem => {
    exact(value, [
      'kind',
      'targetId',
      'postId',
      'rootCommentId',
      'createdAt',
      'preview',
    ]);
    if (
      !['post', 'comment', 'reply'].includes(String(value.kind)) ||
      !isUuid(value.targetId) ||
      !isUuid(value.postId) ||
      !timestamp(value.createdAt)
    )
      invalid();
    if (
      value.kind === 'post'
        ? value.targetId !== value.postId || value.rootCommentId !== null
        : !isUuid(value.rootCommentId) ||
          value.targetId === value.postId ||
          value.rootCommentId === value.postId ||
          (value.kind === 'comment'
            ? value.rootCommentId !== value.targetId
            : value.rootCommentId === value.targetId)
    )
      invalid();
    const preview = value.preview;
    exact(preview, ['text', 'images', 'author', 'createdAt', 'isSelf']);
    if (
      !displayDiscussionText(preview.text) ||
      !Array.isArray(preview.images) ||
      preview.images.length > (value.kind === 'post' ? 9 : 3) ||
      !timestamp(preview.createdAt) ||
      preview.createdAt !== value.createdAt ||
      preview.isSelf !== true
    )
      invalid();
    const images = preview.images.map(decodeMedia);
    if (
      new Set(images.map((item) => item.assetId)).size !== images.length ||
      (!preview.text.trim() && !images.length)
    )
      invalid();
    return Object.freeze({
      kind: value.kind as OwnPublicationItem['kind'],
      targetId: value.targetId,
      postId: value.postId,
      rootCommentId: value.rootCommentId as string | null,
      createdAt: value.createdAt,
      preview: Object.freeze({
        text: preview.text,
        images: Object.freeze(images),
        author: decodeAuthor(preview.author),
        createdAt: preview.createdAt,
        isSelf: true,
      }),
    });
  });
  if (
    new Set(items.map((item) => `${item.kind}:${item.targetId}`)).size !==
    items.length
  )
    invalid();
  return Object.freeze({
    items: Object.freeze(items),
    continuation: raw.continuation as DiscoveryContinuation,
    nextCursor: raw.nextCursor as string | null,
  });
}
export function validateOwnPublicationScope(
  page: OwnPublicationPage,
  kind: OwnPublicationKind,
  identity: AuthorMode,
  limit = 20,
): void {
  if (
    !['topic', 'reply'].includes(kind) ||
    !['named', 'anonymous'].includes(identity) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    page.items.length > limit ||
    page.items.some(
      (item) =>
        (kind === 'topic' ? item.kind !== 'post' : item.kind === 'post') ||
        item.preview.author.kind !== identity ||
        !item.preview.isSelf,
    )
  )
    invalid();
}
export class HttpOwnPublicationsGateway implements OwnPublicationsGateway {
  constructor(private readonly api: ApiClient) {}
  async read(
    kind: OwnPublicationKind,
    identity: AuthorMode,
    after: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<OwnPublicationPage> {
    validateOwnPublicationScope(
      { items: [], continuation: 'end', nextCursor: null },
      kind,
      identity,
      limit,
    );
    if (!cursor(after)) invalid();
    const page = await this.api.request(
      {
        path: '/v1/me/community/publications',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeOwnPublicationPage,
      },
      {
        query: { kind, identity, limit, ...(after ? { cursor: after } : {}) },
        cancellation: cancel,
      },
    );
    validateOwnPublicationScope(page, kind, identity, limit);
    return page;
  }
}
