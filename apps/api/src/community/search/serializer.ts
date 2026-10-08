import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CommunitySerializer } from '../community-serialization.js';
import type { StoredComment, StoredPost } from '../community.repository.js';
import type { CommunitySpace } from '../contracts.js';
import type { TradingSubtype } from '../trading/contracts.js';
import type { SearchHit } from './contracts.js';
import type { SearchCandidate } from './repository.js';
import { searchSnippet, SEARCH_SUMMARY_CODEPOINTS } from './snippet.js';

/** Search's narrow projection. Reuse the public author/persona owner, never the
 * full post/comment/reply serializer, counts, media, targets or components. */
@Injectable()
export class SearchHitSerializer {
  constructor(
    @Inject(CommunitySerializer) private readonly authors: CommunitySerializer,
  ) {}

  async hit(
    candidate: SearchCandidate,
    post: StoredPost,
    content: StoredPost | StoredComment,
    space: Readonly<CommunitySpace>,
    query: string,
    listing: { subtype: TradingSubtype; urgency: 'normal' | 'urgent' } | null,
    tx: PoolClient,
  ): Promise<SearchHit> {
    const base = {
      contentId: candidate.id,
      postId: post.id,
      space: { id: space.id, kind: space.kind, name: space.name },
      category: post.category,
      tradingSubtype: listing?.subtype ?? null,
      tradingUrgency: listing?.urgency ?? null,
      createdAt: candidate.at,
      author: await this.authors.author(content, post, tx),
      postSummary: [...post.text].slice(0, SEARCH_SUMMARY_CODEPOINTS).join(''),
      snippet: searchSnippet(content.text, query),
    };
    if (candidate.kind === 'post')
      return {
        ...base,
        kind: 'post',
        rootCommentId: null,
        replyId: null,
        target: { kind: 'post', postId: post.id },
      };
    const rootCommentId = candidate.rootCommentId!;
    if (candidate.kind === 'comment')
      return {
        ...base,
        kind: 'comment',
        rootCommentId,
        replyId: null,
        target: { kind: 'comment', postId: post.id, rootCommentId },
      };
    return {
      ...base,
      kind: 'reply',
      rootCommentId,
      replyId: candidate.id,
      target: {
        kind: 'reply',
        postId: post.id,
        rootCommentId,
        replyId: candidate.id,
      },
    };
  }
}
