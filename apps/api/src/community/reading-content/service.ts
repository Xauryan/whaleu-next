import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { CommunityRepository } from '../community.repository.js';
import type {
  StoredPost,
  StoredComment,
  StoredReply,
} from '../community.repository.js';
import type { PostView, CommentView, ReplyView } from '../contracts.js';
import { TextSourceReadService } from '../text-source/read.service.js';
import { readingBodyMatches } from './contracts.js';
import type {
  ReadingBody,
  ReadingNode,
  ReadingCommentNode,
} from './contracts.js';

@Injectable()
export class ReadingContentService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(TextSourceReadService)
    private readonly sources: TextSourceReadService,
  ) {}
  /** Only existing authenticated/current read owners call these projections.
   * Canonical Stored* rows and approval bindings retain their same-TX locks. */
  private async body(
    kind: 'post' | 'comment' | 'reply',
    row: StoredPost | StoredComment | StoredReply,
    tx: PoolClient,
  ): Promise<ReadingBody> {
    // No catch: authorization, Review, source, Media or Campus failure must not
    // become a legacy body. Optional formatting alone may fall back to source.
    const value = await this.sources.authorizedReading(kind, row, tx);
    return value === null
      ? { classification: 'legacyPlain' }
      : { classification: 'reviewedSource', value };
  }
  async post(
    content: PostView,
    row: StoredPost,
    tx: PoolClient,
  ): Promise<ReadingNode<PostView>> {
    if (
      content.id !== row.id ||
      content.text !== row.text ||
      content.space.id !== row.space_id
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const body = await this.body('post', row, tx);
    if (!readingBodyMatches(body, 'post', content))
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return { content, body };
  }
  async reply(
    content: ReplyView,
    row: StoredReply,
    tx: PoolClient,
  ): Promise<ReadingNode<ReplyView>> {
    if (
      content.id !== row.id ||
      content.text !== row.text ||
      content.postId !== row.post_id ||
      content.rootCommentId !== row.root_comment_id
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const body = await this.body('reply', row, tx);
    if (!readingBodyMatches(body, 'reply', content))
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return { content, body };
  }
  async comment(
    content: CommentView,
    row: StoredComment,
    tx: PoolClient,
  ): Promise<ReadingCommentNode> {
    if (
      content.id !== row.id ||
      content.text !== row.text ||
      content.postId !== row.post_id
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const body = await this.body('comment', row, tx);
    if (!readingBodyMatches(body, 'comment', content))
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const replyPreviewBodies: ReadingCommentNode['replyPreviewBodies'] = [];
    const seen = new Set<string>();
    for (const preview of content.replyPreview.items) {
      if (
        seen.has(preview.id) ||
        preview.postId !== row.post_id ||
        preview.rootCommentId !== row.id
      )
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      seen.add(preview.id);
      // The preview already passed DiscussionPages current visibility and
      // serialization in this transaction. Retrieve its canonical identity; the
      // source-aware bridge resolves its immutable approval binding, never text
      // syntax or optional keys on the public DTO.
      const stored = await this.repository.reply(preview.id, tx, true);
      const item = await this.reply(preview, stored, tx);
      replyPreviewBodies.push({ id: preview.id, body: item.body });
    }
    return { content, body, replyPreviewBodies };
  }
}
