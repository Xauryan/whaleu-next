import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from '../../http/application-error.js';
import { CommunityRepository } from '../community.repository.js';
import type { StoredComment } from '../community.repository.js';
import { CommunityAccessService } from '../community-access.service.js';
import { CommunitySerializer } from '../community-serialization.js';
import type { CommentMetadata } from '../community-serialization.js';
import { orderDiscussionRoots, discussionRootSnapshot } from './root-page.js';
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
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
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
        const visible: StoredComment[] = [];
        for (const row of rows.rows)
          if (await this.access.visible(actor, row, tx, 'list_projection'))
            visible.push(row);
        // Only root ordering facts are needed for traversal. Do not read replies,
        // display names, images or preview targets for roots outside this page.
        const metadata = new Map<string, CommentMetadata>();
        if (visible.length) {
          const facts = await tx.query<{
            id: string;
            like_count: number;
            is_liked: boolean;
            is_pinned: boolean;
          }>(
            `SELECT root.id,
          (SELECT count(*)::integer FROM whaleu_community.comment_likes likes
            WHERE likes.comment_id=root.id) AS like_count,
          EXISTS(SELECT 1 FROM whaleu_community.comment_likes likes
            WHERE likes.comment_id=root.id AND likes.account_id=$2) AS is_liked,
          EXISTS(SELECT 1 FROM whaleu_community.comment_pins pins
            WHERE pins.comment_id=root.id) AS is_pinned
          FROM unnest($1::uuid[]) AS root(id) ORDER BY root.id`,
            [visible.map((row) => row.id), actor],
          );
          for (const fact of facts.rows) {
            if (
              !Number.isSafeInteger(fact.like_count) ||
              fact.like_count < 0 ||
              typeof fact.is_liked !== 'boolean' ||
              typeof fact.is_pinned !== 'boolean' ||
              metadata.has(fact.id)
            )
              throw new ApplicationError('COMMUNITY_UNAVAILABLE');
            metadata.set(fact.id, {
              likeCount: fact.like_count,
              isLiked: fact.is_liked,
              isPinned: fact.is_pinned,
            });
          }
          if (metadata.size !== visible.length)
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        }
        const ordered = orderDiscussionRoots(
          visible.map((row) => {
            const facts = metadata.get(row.id);
            if (!facts) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
            return {
              row,
              id: row.id,
              createdAt: row.created_at.toISOString(),
              ...facts,
            };
          }),
          query,
        );
        const snapshot = discussionRootSnapshot(ordered, query.sort);
        if (seek && seek.snapshot !== snapshot)
          throw new ApplicationError('DISCUSSION_RESTART_REQUIRED');
        const offset = seek?.offset ?? 0;
        const items: CommentView[] = [];
        for (const selected of ordered.slice(offset, offset + query.limit))
          items.push(
            await this.serializer.comment(
              selected.row,
              post,
              actor,
              authority,
              tx,
              query.previewLimit,
              metadata.get(selected.id)!,
            ),
          );
        return {
          items,
          nextCursor:
            offset + query.limit < ordered.length
              ? encodeDiscussionCursor({
                  v: 3,
                  scope,
                  limit: query.limit,
                  snapshot,
                  offset: offset + query.limit,
                })
              : null,
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
  comment(token: string, id: string) {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const actor = await this.access.actor(token, tx);
        const { post, comment, authority } =
          await this.access.accessibleComment(id, actor, tx);
        return this.serializer.comment(comment, post, actor, authority, tx);
      },
      { isolationLevel: 'read committed' },
    );
  }
  reply(token: string, id: string) {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const actor = await this.access.actor(token, tx);
        const { post, comment, reply, authority } =
          await this.access.accessibleReply(id, actor, tx);
        return this.serializer.reply(
          reply,
          post,
          comment,
          actor,
          authority,
          tx,
        );
      },
      { isolationLevel: 'read committed' },
    );
  }
  replies(token: string, id: string, query: PageQuery) {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const actor = await this.access.actor(token, tx);
        const { post, comment, authority } =
          await this.access.accessibleComment(id, actor, tx);
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
      },
      { isolationLevel: 'read committed' },
    );
  }
  context(
    token: string,
    postId: string,
    query: { commentId?: string; replyId?: string },
  ) {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
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
        const rows = await this.serializer.visibleReplies(
          comment.id,
          actor,
          tx,
        );
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
            await this.serializer.reply(
              row,
              post,
              comment,
              actor,
              authority,
              tx,
            ),
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
      },
      { isolationLevel: 'read committed' },
    );
  }
}
