import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from '../../http/application-error.js';
import { CommunityRepository } from '../community.repository.js';
import type { StoredComment } from '../community.repository.js';
import { CommunityAccessService } from '../community-access.service.js';
import { CommunitySerializer } from '../community-serialization.js';
import type { CommentView, PageQuery } from '../contracts.js';
import type { CommentsQuery } from './contracts.js';
import { rootCursor, encodeDiscussionCursor } from './cursor.js';
@Injectable()
export class DiscussionReadService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(CommunitySerializer)
    private readonly serializer: CommunitySerializer,
  ) {}
  comments(token: string, postId: string, query: CommentsQuery) {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const { post, space } = await this.access.accessiblePost(
        postId,
        actor,
        tx,
      );
      const authority = await this.access.advisory(actor, space, tx);
      const scope = `comments:${post.id}:${createHash('sha256').update(actor).digest('hex')}:${query.sort}:${query.order}:${query.previewLimit}`;
      const seek = rootCursor(query.cursor, scope, query.limit);
      const rows = await tx.query<StoredComment>(
        "SELECT * FROM whaleu_community.root_comments WHERE post_id=$1 AND visibility='approved' AND deleted_at IS NULL ORDER BY id LIMIT 1025 FOR SHARE",
        [post.id],
      );
      if (rows.rows.length > 1024)
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      const items: CommentView[] = [];
      for (const row of rows.rows)
        if (await this.access.visible(actor, row, tx, 'list_projection'))
          items.push(
            await this.serializer.comment(
              row,
              post,
              actor,
              authority,
              tx,
              query.previewLimit,
            ),
          );
      items.sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        if (query.sort === 'likes' && a.likeCount !== b.likeCount)
          return (a.likeCount - b.likeCount) * (query.order === 'asc' ? 1 : -1);
        const direction =
          query.sort === 'likes' || query.order === 'desc' ? -1 : 1;
        return (
          (a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) *
          direction
        );
      });
      const snapshot = createHash('sha256')
        .update(
          JSON.stringify(
            items.map((x) => [
              x.id,
              x.createdAt,
              x.likeCount,
              x.isPinned,
              x.replyCount,
            ]),
          ),
        )
        .digest('hex');
      if (seek && seek.snapshot !== snapshot)
        throw new ApplicationError('DISCUSSION_RESTART_REQUIRED');
      const offset = seek?.offset ?? 0;
      return {
        items: items.slice(offset, offset + query.limit),
        nextCursor:
          offset + query.limit < items.length
            ? encodeDiscussionCursor({
                v: 2,
                scope,
                limit: query.limit,
                snapshot,
                offset: offset + query.limit,
              })
            : null,
      };
    });
  }
  comment(token: string, id: string) {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const { post, comment, authority } = await this.access.accessibleComment(
        id,
        actor,
        tx,
      );
      return this.serializer.comment(comment, post, actor, authority, tx);
    });
  }
  reply(token: string, id: string) {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const { post, comment, reply, authority } =
        await this.access.accessibleReply(id, actor, tx);
      return this.serializer.reply(reply, post, comment, actor, authority, tx);
    });
  }
  replies(token: string, id: string, query: PageQuery) {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const { post, comment, authority } = await this.access.accessibleComment(
        id,
        actor,
        tx,
      );
      return this.serializer.replyPage(
        await this.serializer.visibleReplies(id, actor, tx),
        post,
        comment,
        actor,
        authority,
        tx,
        query.limit,
        query.cursor,
      );
    });
  }
  context(
    token: string,
    postId: string,
    query: { commentId?: string; replyId?: string },
  ) {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      // Gate the explicit parent before resolving any independently supplied child.
      await this.access.accessiblePost(postId, actor, tx);
      const child = query.replyId
        ? await this.access.accessibleReply(query.replyId, actor, tx)
        : await this.access.accessibleComment(query.commentId!, actor, tx);
      if (child.post.id !== postId)
        throw new ApplicationError(
          query.replyId ? 'REPLY_NOT_FOUND' : 'COMMENT_NOT_FOUND',
        );
      const { post, comment, authority } = child;
      const rows = await this.serializer.visibleReplies(comment.id, actor, tx);
      const index = query.replyId
        ? rows.findIndex((row) => row.id === query.replyId)
        : 0;
      if (index < 0) throw new ApplicationError('REPLY_NOT_FOUND');
      const window = rows.slice(
        Math.max(0, index - 2),
        query.replyId ? index + 3 : 2,
      );
      const items = [];
      for (const row of window)
        items.push(
          await this.serializer.reply(row, post, comment, actor, authority, tx),
        );
      return {
        comment: await this.serializer.comment(
          comment,
          post,
          actor,
          authority,
          tx,
        ),
        reply: query.replyId
          ? await this.serializer.reply(
              rows[index]!,
              post,
              comment,
              actor,
              authority,
              tx,
            )
          : null,
        replies: {
          items,
          // Located windows do not advance ordinary earliest-first traversal.
          nextCursor: null,
        },
      };
    });
  }
}
