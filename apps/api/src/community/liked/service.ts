import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  DiscoveryCursorRepository,
  discoveryCursorBucket,
} from '../discovery-cursors.js';
import { DISCOVERY_SCAN_BATCH } from '../profile-discovery.facade.js';
import {
  CommunityDiscoveryCounts,
  bindDiscoveryCount,
} from '../discovery-counts.js';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
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
  likedCursorScope,
  likedAnchorSchema,
} from './cursor.js';
import type { LikedAnchor } from './cursor.js';
import { LikedHistoryRepository } from './repository.js';
import type { LikedCandidate } from './repository.js';

const positionSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('liked'),
  after: likedAnchorSchema,
  visible: likedAnchorSchema.nullable(),
});
const candidateAnchor = (item: LikedCandidate): LikedAnchor => ({
  targetKind: item.kind,
  at: item.liked_at?.toISOString() ?? null,
  id: item.like_id,
});
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
    @Inject(DiscoveryCursorRepository)
    private readonly cursors: DiscoveryCursorRepository,
    @Inject(CommunityDiscoveryCounts)
    private readonly counts: CommunityDiscoveryCounts,
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
    return this.community.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx);
        enableSafetyRelationshipProof(tx);
        const session = await this.identity.session(token, tx);
        const actor = session.accountId;
        const scope = likedCursorScope(actor, session.sessionId, query.limit);
        const position = query.cursor
          ? await this.cursors.get(query.cursor, scope, tx, (value) =>
              positionSchema.parse(value),
            )
          : null;
        const count = await this.counts.liked(actor, tx);
        const seek = position?.after ?? null;
        const guard = position?.visible ?? null;
        if (guard && seek && compareLikedAnchors(seek, guard) < 0)
          throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
        const candidates = await this.likes.candidates(
          actor,
          seek,
          DISCOVERY_SCAN_BATCH + 1,
          tx,
        );
        const guardCandidate = guard
          ? await this.likes.guard(actor, guard, tx)
          : null;
        if (guard && !guardCandidate)
          throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
        const { posts, roots, replies } = await this.lockedContent(
          [...candidates, ...(guardCandidate ? [guardCandidate] : [])],
          tx,
        );
        const finalCandidates = await this.likes.candidates(
          actor,
          seek,
          DISCOVERY_SCAN_BATCH + 1,
          tx,
        );
        const keys = new Set(
          candidates.map((item) => `${item.kind}:${item.target_id}`),
        );
        if (
          finalCandidates.some(
            (item) => !keys.has(`${item.kind}:${item.target_id}`),
          )
        )
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        const postVisibility = new Map<string, boolean>();
        const rootVisibility = new Map<string, boolean>();
        const visible = async (candidate: LikedCandidate) => {
          // Re-read the exact current record only AFTER its full parent chain is
          // locked. A concurrent delete/re-like must never return the stale ID.
          const current = await this.likes.current(actor, candidate, tx);
          if (!current) return null;
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
          if (!postVisibility.get(post.id)) return null;
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
            if (!rootVisibility.get(root.id)) return null;
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
              return null;
            target = reply;
          }
          return {
            candidate,
            post,
            target,
            anchor: {
              targetKind: candidate.kind,
              at: current.liked_at?.toISOString() ?? null,
              id: current.like_id,
            },
          };
        };
        if (guard && guardCandidate) {
          const current = await visible(guardCandidate);
          if (!current || compareLikedAnchors(current.anchor, guard) !== 0)
            throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
        }
        const items: LikedPage['items'] = [];
        let consumed = 0;
        let lastVisible = guard;
        for (const candidate of finalCandidates.slice(
          0,
          DISCOVERY_SCAN_BATCH,
        )) {
          consumed++;
          const entry = await visible(candidate);
          if (!entry) continue;
          const { post, target, anchor } = entry;
          if (compareLikedAnchors(anchor, candidateAnchor(candidate)) !== 0)
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          items.push({
            kind: candidate.kind,
            targetId: target.id,
            postId: post.id,
            rootCommentId: candidate.root_comment_id,
            likedAt: anchor.at,
            likeId: anchor.id,
            preview: {
              text: target.text,
              images: await this.serializer.images(
                candidate.kind,
                target.id,
                tx,
              ),
              author: await this.serializer.author(target, post, tx),
              createdAt: ('published_at' in target
                ? target.published_at
                : target.created_at
              ).toISOString(),
              isSelf: target.account_id === actor,
            },
          });
          lastVisible = anchor;
          if (items.length === query.limit) break;
        }
        const exhausted = consumed === finalCandidates.length;
        const next = exhausted
          ? null
          : candidateAnchor(finalCandidates[consumed - 1]!);
        if (next && seek && compareLikedAnchors(next, seek) <= 0)
          throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
        await this.identity.session(token, tx);
        const result: LikedPage = {
          items,
          visibleLikedCount: count.value,
          visibleLikedCountStatus: count.status,
          continuation: exhausted
            ? 'end'
            : items.length === query.limit
              ? 'more'
              : 'scan_pending',
          nextCursor: next
            ? await this.cursors.create(
                scope,
                discoveryCursorBucket(actor),
                { v: 1, kind: 'liked', after: next, visible: lastVisible },
                tx,
              )
            : null,
        };
        bindDiscoveryCount(tx, count, () => {
          result.visibleLikedCount = null;
          result.visibleLikedCountStatus = 'unavailable';
        });
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
