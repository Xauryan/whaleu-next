import { DiscussionPages } from './pages.js';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { Inject, Injectable } from '@nestjs/common';
import { ApplicationError } from '../../http/application-error.js';
import { CommunityRepository } from '../community.repository.js';
import { CommunityAccessService } from '../community-access.service.js';
import { CommunitySerializer } from '../community-serialization.js';
import type { CommentView, PageQuery } from '../contracts.js';
import type { CommentsQuery } from './contracts.js';
@Injectable()
export class DiscussionReadService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(CommunitySerializer)
    private readonly serializer: CommunitySerializer,
    @Inject(DiscussionPages) private readonly pages: DiscussionPages,
  ) {}
  @AccountPolicy('browse', 'entry')
  comments(token: string, postId: string, query: CommentsQuery) {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const { accountId: actor, sessionId } = await this.access.mediaSession(
          token,
          tx,
        );
        const { post, space } = await this.access.accessiblePost(
          postId,
          actor,
          tx,
        );
        const authority = await this.access.advisory(actor, space, tx);
        const page = await this.pages.roots(post, actor, sessionId, query, tx);
        const items: CommentView[] = [];
        for (const selected of page.rows)
          items.push(
            await this.serializer.comment(
              selected.row,
              post,
              actor,
              authority,
              tx,
              query.previewLimit,
              selected.metadata,
              sessionId,
            ),
          );
        const result = { items, nextCursor: page.nextCursor };
        this.pages.copyCursor(page, result);
        await this.pages.flush(tx);
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('browse', 'entry')
  comment(token: string, id: string) {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const { accountId: actor, sessionId } = await this.access.mediaSession(
          token,
          tx,
        );
        const { post, comment, authority } =
          await this.access.accessibleComment(id, actor, tx);
        const result = await this.serializer.comment(
          comment,
          post,
          actor,
          authority,
          tx,
          2,
          undefined,
          sessionId,
        );
        await this.pages.flush(tx);
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('browse', 'entry')
  reply(token: string, id: string) {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const { accountId: actor } = await this.access.mediaSession(token, tx);
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
  @AccountPolicy('browse', 'entry')
  replies(token: string, id: string, query: PageQuery) {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const { accountId: actor, sessionId } = await this.access.mediaSession(
          token,
          tx,
        );
        const { post, comment, authority } =
          await this.access.accessibleComment(id, actor, tx);
        const page = await this.pages.replies(
          post,
          comment,
          actor,
          sessionId,
          tx,
          query.limit,
          query.cursor,
        );
        const items = [];
        for (const row of page.rows)
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
        const result = { items, nextCursor: page.nextCursor };
        this.pages.copyCursor(page, result);
        await this.pages.flush(tx);
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('browse', 'entry')
  context(
    token: string,
    postId: string,
    query: { commentId?: string; replyId?: string },
  ) {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const { accountId: actor, sessionId } = await this.access.mediaSession(
          token,
          tx,
        );
        // Gate the explicit parent before resolving any independently supplied child.
        await this.access.accessiblePost(postId, actor, tx);
        const replyChild = query.replyId
          ? await this.access.accessibleReply(query.replyId, actor, tx)
          : null;
        const child =
          replyChild ??
          (await this.access.accessibleComment(query.commentId!, actor, tx));
        if (child.post.id !== postId)
          throw new ApplicationError(
            query.replyId ? 'REPLY_NOT_FOUND' : 'COMMENT_NOT_FOUND',
          );
        const { post, comment, authority } = child;
        const target = replyChild?.reply;
        const window = await this.pages.context(
          post,
          comment,
          actor,
          tx,
          target,
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
        const result = {
          comment: await this.serializer.comment(
            comment,
            post,
            actor,
            authority,
            tx,
            2,
            undefined,
            sessionId,
          ),
          reply: query.replyId
            ? await this.serializer.reply(
                target!,
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
        await this.pages.flush(tx);
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
