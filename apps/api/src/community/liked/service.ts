import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { CommunityAccessService } from '../community-access.service.js';
import { CommunitySerializer } from '../community-serialization.js';
import { CommunityRepository } from '../community.repository.js';
import type {
  StoredComment,
  StoredPost,
  StoredReply,
} from '../community.repository.js';
import type { LikedPage, LikedPageQuery } from './contracts.js';
import {
  compareLikedAnchors,
  decodeLikedCursor,
  encodeLikedCursor,
} from './cursor.js';
import type { LikedAnchor } from './cursor.js';
import { LikedHistoryRepository } from './repository.js';
import type { LikedCandidate } from './repository.js';

interface VisibleLike {
  candidate: LikedCandidate;
  post: StoredPost;
  target: StoredPost | StoredComment;
  anchor: LikedAnchor;
}
@Injectable()
export class LikedHistoryService {
  constructor(
    @Inject(CommunityRepository)
    private readonly community: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(CommunitySerializer)
    private readonly serializer: CommunitySerializer,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(LikedHistoryRepository)
    private readonly likes: LikedHistoryRepository,
  ) {}

  private async lockedContent(candidates: LikedCandidate[], tx: PoolClient) {
    const posts = new Map<string, StoredPost>();
    const roots = new Map<string, StoredComment>();
    const replies = new Map<string, StoredReply>();
    // Acquire every parent before roots, then every exact reply. No row-locking
    // like candidate query or nested per-candidate parent acquisition is allowed.
    for (const id of [
      ...new Set(candidates.map((item) => item.post_id)),
    ].sort())
      posts.set(id, await this.community.post(id, tx));
    for (const id of [
      ...new Set(
        candidates.flatMap((item) =>
          item.root_comment_id ? [item.root_comment_id] : [],
        ),
      ),
    ].sort())
      roots.set(id, await this.community.comment(id, tx, true));
    for (const id of [
      ...new Set(
        candidates
          .filter((item) => item.kind === 'reply')
          .map((item) => item.target_id),
      ),
    ].sort())
      replies.set(id, await this.community.reply(id, tx, true));
    return { posts, roots, replies };
  }

  list(token: string, query: LikedPageQuery): Promise<LikedPage> {
    return this.community.database.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      const session = await this.identity.session(token, tx);
      const actor = session.accountId;
      const seek = decodeLikedCursor(
        query.cursor,
        actor,
        session.sessionId,
        query.limit,
      );
      const candidates = await this.likes.candidates(actor, tx);
      if (candidates.length > 1024)
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      const { posts, roots, replies } = await this.lockedContent(
        candidates,
        tx,
      );
      // An unseen new target while locks were being acquired cannot be silently
      // left out of the count. This request must retry from a fresh bounded set.
      const finalCandidates = await this.likes.candidates(actor, tx);
      const keys = new Set(
        candidates.map((item) => `${item.kind}:${item.target_id}`),
      );
      if (
        finalCandidates.length > 1024 ||
        finalCandidates.some(
          (item) => !keys.has(`${item.kind}:${item.target_id}`),
        )
      )
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      const visible: VisibleLike[] = [];
      const postVisibility = new Map<string, boolean>();
      const rootVisibility = new Map<string, boolean>();
      for (const candidate of finalCandidates) {
        // Re-read the exact current record only AFTER its full parent chain is
        // locked. A concurrent delete/re-like must never return the stale ID.
        const current = await this.likes.current(actor, candidate, tx);
        if (!current) continue;
        const post = posts.get(candidate.post_id)!;
        if (!postVisibility.has(post.id)) {
          try {
            await this.access.accessiblePost(post.id, actor, tx);
            postVisibility.set(post.id, true);
          } catch (error) {
            if (
              !(error instanceof ApplicationError) ||
              error.code !== 'POST_NOT_FOUND'
            )
              throw error;
            postVisibility.set(post.id, false);
          }
        }
        if (!postVisibility.get(post.id)) continue;
        let target: StoredPost | StoredComment = post;
        if (candidate.root_comment_id) {
          const root = roots.get(candidate.root_comment_id)!;
          if (root.post_id !== post.id)
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          if (!rootVisibility.has(root.id))
            rootVisibility.set(
              root.id,
              await this.access.visible(actor, root, tx, 'direct_post'),
            );
          if (!rootVisibility.get(root.id)) continue;
          target = root;
        }
        if (candidate.kind === 'reply') {
          const reply = replies.get(candidate.target_id)!;
          if (
            reply.post_id !== post.id ||
            reply.root_comment_id !== candidate.root_comment_id
          )
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          if (!(await this.access.visible(actor, reply, tx, 'direct_post')))
            continue;
          target = reply;
        }
        visible.push({
          candidate,
          post,
          target,
          anchor: {
            targetKind: candidate.kind,
            at: current.liked_at?.toISOString() ?? null,
            id: current.like_id,
          },
        });
      }
      visible.sort((a, b) => compareLikedAnchors(a.anchor, b.anchor));
      const index = seek
        ? visible.findIndex(
            (item) =>
              item.anchor.targetKind === seek.targetKind &&
              item.anchor.id === seek.id &&
              item.anchor.at === seek.at,
          )
        : -1;
      if (seek && index === -1)
        throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      const remaining = visible.slice(index + 1);
      const page = remaining.slice(0, query.limit);
      const items: LikedPage['items'] = [];
      for (const { candidate, post, target, anchor } of page)
        items.push({
          kind: candidate.kind,
          targetId: target.id,
          postId: post.id,
          rootCommentId: candidate.root_comment_id,
          likedAt: anchor.at,
          likeId: anchor.id,
          preview: {
            text: target.text,
            images: await this.serializer.images(candidate.kind, target.id, tx),
            author: await this.serializer.author(target, post, tx),
            createdAt: ('published_at' in target
              ? target.published_at
              : target.created_at
            ).toISOString(),
            isSelf: target.account_id === actor,
          },
        });
      await this.identity.session(token, tx);
      const last = page.at(-1);
      return {
        items,
        visibleLikedCount: visible.length,
        nextCursor:
          remaining.length > query.limit && last
            ? encodeLikedCursor(
                last.anchor,
                actor,
                session.sessionId,
                query.limit,
              )
            : null,
      };
    });
  }
}
