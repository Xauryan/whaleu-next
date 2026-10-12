import { batchCategoryChildContextAllowed } from './category-reclassification/child-context.js';
import { resolvePostCategory } from './category-reclassification/read-proof.js';
import { ownerPostVisibilityAllowed } from './owner-visibility/read-proof.js';
import type { VisibilityPurpose } from './community-policy.js';
import type { MediaReadPurpose } from '../media/owner-proof.js';
import { FeedbackProjectionService } from './feedback/projection.js';
import { TextReviewRuntime } from './text-review/runtime.js';
import { mediaAttachmentDescriptorSchema } from '../media/contracts.js';
import { SavedRepository } from './saved/repository.js';
import { FormationService } from './formation/service.js';
import { TradingRepository } from './trading/repository.js';
import { encodeDiscussionCursor, replyCursor } from './discussion/cursor.js';
import { PollReadService } from './polls/poll-read.service.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { AuthorDisplayService } from '../profile/author-display.service.js';
import {
  MEDIA_ATTACHMENT,
  actionAllowed,
  requireDecision,
  requirePublication,
} from './community-policy.js';
import type { Authority, MediaAttachmentPort } from './community-policy.js';
import type {
  AuthorView,
  CommentView,
  CommunitySpace,
  MediaView,
  PostView,
  ReplyView,
} from './contracts.js';
import { CommunityRepository } from './community.repository.js';
import type {
  StoredPost,
  StoredComment,
  StoredReply,
} from './community.repository.js';
import { CommunityAccessService } from './community-access.service.js';

/** Trusted Community-owned facts captured while ordering root comments. */
export interface CommentMetadata {
  readonly likeCount: number;
  readonly isLiked: boolean;
  readonly isPinned: boolean;
}
@Injectable()
export class CommunitySerializer {
  constructor(
    @Inject(SavedRepository) private readonly saved: SavedRepository,
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(AuthorDisplayService)
    private readonly profiles: AuthorDisplayService,
    @Inject(MEDIA_ATTACHMENT) private readonly media: MediaAttachmentPort,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(PollReadService) private readonly polls: PollReadService,
    @Inject(FormationService) private readonly formations: FormationService,
    @Inject(TradingRepository) private readonly trading: TradingRepository,
    @Optional()
    @Inject(TextReviewRuntime)
    private readonly reviews?: TextReviewRuntime,
    @Optional()
    @Inject(FeedbackProjectionService)
    private readonly feedbackProjection?: FeedbackProjectionService,
  ) {}
  async author(
    content: StoredPost | StoredComment,
    post: StoredPost,
    tx: PoolClient,
  ): Promise<AuthorView> {
    if (content.author_mode === 'anonymous') {
      const result = await tx.query<{ id: string; display_name: string }>(
        'SELECT id,display_name FROM whaleu_community.thread_personas WHERE post_id=$1 AND account_id=$2',
        [post.id, content.account_id],
      );
      const persona = result.rows[0];
      if (!persona) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      return {
        kind: 'anonymous',
        personaId: persona.id,
        displayName: persona.display_name,
        avatar: null,
        isPostAuthor:
          post.author_mode === 'anonymous' &&
          content.account_id === post.account_id,
      };
    }
    const display = await this.profiles.findPublic(content.account_id, tx);
    if (!display) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return {
      kind: 'named',
      profileId: display.profileId,
      displayName: display.displayName,
      avatar: null,
      experienceDisplay: display.experienceDisplay,
    };
  }
  async images(
    kind: 'post' | 'comment' | 'reply',
    id: string,
    tx: PoolClient,
    viewer: string | null,
    purpose: MediaReadPurpose = 'list-projection',
  ): Promise<MediaView[]> {
    const assets = await this.repository.images(kind, id, tx);
    if (!assets.length) return [];
    const views = requireDecision(
      await this.media.display(assets, tx, {
        viewerAccountId: viewer,
        parent: {
          ownerKind: 'community',
          resourceKind: kind,
          resourceId: id,
          contentVersion: 1,
        },
        purpose,
      }),
      'MEDIA_UNAVAILABLE',
    );
    if (
      views.length !== assets.length ||
      views.some((view, index) => view.assetId !== assets[index]?.assetId)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return views.map((view) => {
      const parsed = mediaAttachmentDescriptorSchema.safeParse(view);
      if (!parsed.success) throw new ApplicationError('MEDIA_UNAVAILABLE');
      return parsed.data;
    });
  }

  async post(
    post: StoredPost,
    space: CommunitySpace,
    viewer: string | null,
    authority: Authority | null,
    tx: PoolClient,
    purpose: MediaReadPurpose = 'list-projection',
  ): Promise<PostView> {
    const currentCategory = await resolvePostCategory(post.id, tx);
    if (currentCategory === null) throw new ApplicationError('POST_NOT_FOUND');
    const publicEligible = await ownerPostVisibilityAllowed(
      post.id,
      post.account_id,
      viewer,
      'list_projection',
      tx,
    );
    const likes = await tx.query<{ count: number; liked: boolean }>(
      'SELECT count(*)::integer AS count,coalesce(bool_or(account_id=$2::uuid),false) AS liked FROM whaleu_community.post_likes WHERE post_id=$1',
      [post.id, viewer],
    );
    const comments = await tx.query<StoredComment>(
      "SELECT * FROM whaleu_community.root_comments WHERE post_id=$1 AND visibility='approved' AND deleted_at IS NULL LIMIT 1025 FOR SHARE",
      [post.id],
    );
    if (comments.rows.length > 1024)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    await batchCategoryChildContextAllowed(
      comments.rows.map((row) => ({
        kind: 'comment' as const,
        id: row.id,
        postId: row.post_id,
      })),
      tx,
    );
    let commentCount = 0,
      replyCount = 0;
    for (const comment of comments.rows)
      if (
        await this.access.visible(
          viewer,
          comment,
          tx,
          purpose === 'list-projection'
            ? 'list_projection'
            : 'detail_projection',
        )
      ) {
        commentCount++;
        replyCount += (
          await this.visibleReplies(
            comment.id,
            viewer,
            tx,
            purpose === 'list-projection'
              ? 'list_projection'
              : 'detail_projection',
          )
        ).length;
        if (replyCount > 1024)
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      }
    let canComment = false;
    const reviewAvailable =
      authority?.runtime &&
      post.comments_policy === 'open' &&
      !!this.reviews &&
      (await this.reviews.available(space, tx, post.category));
    // Ordinary interaction authority omits publication facts; refresh only
    // this optional hint, retaining every original publication check.
    const commentAuthority =
      authority?.runtime && reviewAvailable && viewer
        ? await this.access.advisory(viewer, space, tx, {
            publication: true,
            targetPostId: post.id,
          })
        : authority;
    if (
      publicEligible &&
      commentAuthority &&
      (!commentAuthority.runtime || reviewAvailable)
    )
      for (const mode of ['named', 'anonymous'] as const) {
        if (
          commentAuthority.runtime &&
          mode !== 'named' &&
          post.category !== 'feedback'
        )
          continue;
        if (
          post.author_mode === 'anonymous' &&
          viewer === post.account_id &&
          mode !== 'anonymous'
        )
          continue;
        try {
          requirePublication(
            commentAuthority,
            space,
            currentCategory,
            mode,
            'publish_comment',
            post.author_mode,
          );
          canComment =
            post.comments_policy === 'open' ||
            viewer === post.account_id ||
            commentAuthority.canManage;
        } catch {
          /* Advisory only; every write rechecks. */
        }
        if (canComment) break;
      }
    const saved = await this.saved.projection(post.id, viewer, tx);
    const poll = await this.polls.project(
      post.id,
      viewer,
      publicEligible ? authority : null,
      tx,
    );
    const formation = await this.formations.project(
      post,
      viewer,
      authority,
      tx,
    );
    const feedback =
      post.category === 'feedback'
        ? await this.feedbackProjection?.project(post, space, tx)
        : undefined;
    if (post.category === 'feedback' && !feedback)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return {
      ...(feedback ? { feedback } : {}),
      saveCount: saved.saveCount,
      trading: await this.trading.project(post, viewer, authority, tx),
      component: poll
        ? { kind: 'poll', poll }
        : formation
          ? { kind: 'formation', formation }
          : { kind: 'none' },
      id: post.id,
      space: { id: space.id, kind: space.kind, name: space.name },
      category: currentCategory,
      text: post.text,
      images: await this.images('post', post.id, tx, viewer, purpose),
      author: await this.author(post, post, tx),
      publishedAt: post.published_at.toISOString(),
      likeCount: likes.rows[0]!.count,
      commentCount,
      replyCount,
      discussionCount: commentCount + replyCount,
      viewer: {
        isSelf: viewer === post.account_id,
        isLiked: likes.rows[0]!.liked,
        canDelete:
          viewer === post.account_id && actionAllowed(authority, 'delete'),
        canComment,
        isSaved: saved.isSaved,
        canSave: publicEligible && actionAllowed(authority, 'save_post'),
        canSetUpdatePreference:
          publicEligible &&
          actionAllowed(authority, 'set_post_update_preference'),
      },
      commentsPolicy: post.comments_policy,
      allowAnonymousDm:
        post.author_mode === 'named' &&
        post.publication_envelope_version === 2 &&
        post.allow_anonymous_dm === true,
    };
  }
  async comment(
    comment: StoredComment,
    post: StoredPost,
    viewer: string,
    authority: Authority | null,
    tx: PoolClient,
    previewLimit = 2,
    metadata?: CommentMetadata,
  ): Promise<CommentView> {
    const likes = metadata
      ? { count: metadata.likeCount, liked: metadata.isLiked }
      : await this.likes('comment', comment.id, viewer, tx);
    const replies = await this.visibleReplies(comment.id, viewer, tx);
    const isPinned =
      metadata?.isPinned ??
      !!(
        await tx.query(
          'SELECT 1 FROM whaleu_community.comment_pins WHERE comment_id=$1',
          [comment.id],
        )
      ).rowCount;
    return {
      id: comment.id,
      postId: post.id,
      text: comment.text,
      images: await this.images(
        'comment',
        comment.id,
        tx,
        viewer,
        'direct-content',
      ),
      likeCount: likes.count,
      replyCount: replies.length,
      isPinned,
      replyPreview: await this.replyPage(
        replies,
        post,
        comment,
        viewer,
        authority,
        tx,
        previewLimit,
        undefined,
        20,
      ),
      author: await this.author(comment, post, tx),
      createdAt: comment.created_at.toISOString(),
      viewer: {
        isSelf: viewer === comment.account_id,
        isLiked: likes.liked,
        canPin:
          viewer === post.account_id &&
          (await ownerPostVisibilityAllowed(
            post.id,
            post.account_id,
            viewer,
            'list_projection',
            tx,
          )) &&
          actionAllowed(authority, 'pin'),
        canDelete:
          viewer === comment.account_id && actionAllowed(authority, 'delete'),
      },
    };
  }
  async likes(
    kind: 'comment' | 'reply',
    id: string,
    viewer: string,
    tx: PoolClient,
  ) {
    return (
      await tx.query<{ count: number; liked: boolean }>(
        `SELECT count(*)::integer AS count,coalesce(bool_or(account_id=$2::uuid),false) AS liked FROM whaleu_community.${kind}_likes WHERE ${kind}_id=$1`,
        [id, viewer],
      )
    ).rows[0]!;
  }
  async visibleReplies(
    rootId: string,
    viewer: string | null,
    tx: PoolClient,
    purpose: VisibilityPurpose = 'detail_projection',
  ): Promise<StoredReply[]> {
    const rows = await tx.query<StoredReply>(
      "SELECT * FROM whaleu_community.replies WHERE root_comment_id=$1 AND visibility='approved' AND deleted_at IS NULL ORDER BY sequence LIMIT 1025 FOR SHARE",
      [rootId],
    );
    if (rows.rows.length > 1024)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    await batchCategoryChildContextAllowed(
      rows.rows.map((row) => ({
        kind: 'reply' as const,
        id: row.id,
        postId: row.post_id,
      })),
      tx,
    );
    const visible: StoredReply[] = [];
    for (const reply of rows.rows)
      if (await this.access.visible(viewer, reply, tx, purpose))
        visible.push(reply);
    return visible;
  }
  async reply(
    reply: StoredReply,
    post: StoredPost,
    root: StoredComment,
    viewer: string,
    authority: Authority | null,
    tx: PoolClient,
  ): Promise<ReplyView> {
    let target: ReplyView['target'];
    if (reply.target_reply_id) {
      const original = await this.repository.reply(
        reply.target_reply_id,
        tx,
        true,
      );
      target =
        original.post_id === post.id &&
        original.root_comment_id === root.id &&
        (await this.access.visible(viewer, original, tx, 'detail_projection'))
          ? {
              kind: 'reply',
              id: original.id,
              status: 'available',
              author: await this.author(original, post, tx),
            }
          : { status: 'unavailable' };
    } else
      target = {
        kind: 'comment',
        id: root.id,
        status: 'available',
        author: await this.author(root, post, tx),
      };
    const likes = await this.likes('reply', reply.id, viewer, tx);
    return {
      id: reply.id,
      postId: post.id,
      rootCommentId: root.id,
      target,
      text: reply.text,
      images: await this.images(
        'reply',
        reply.id,
        tx,
        viewer,
        'direct-content',
      ),
      author: await this.author(reply, post, tx),
      createdAt: reply.created_at.toISOString(),
      likeCount: likes.count,
      viewer: {
        isSelf: viewer === reply.account_id,
        canDelete:
          viewer === reply.account_id && actionAllowed(authority, 'delete'),
        isLiked: likes.liked,
      },
    };
  }
  async replyPage(
    rows: StoredReply[],
    post: StoredPost,
    root: StoredComment,
    viewer: string,
    authority: Authority | null,
    tx: PoolClient,
    limit: number,
    cursor?: string,
    continuationLimit = limit,
  ) {
    const scope = `replies:${post.id}:${root.id}`;
    const after = replyCursor(cursor, scope, limit);
    const candidates = after
      ? rows.filter((row) => BigInt(row.sequence) > BigInt(after))
      : rows;
    const page = candidates.slice(0, limit),
      last = page.at(-1);
    const items: ReplyView[] = [];
    for (const row of page)
      items.push(await this.reply(row, post, root, viewer, authority, tx));
    return {
      items,
      nextCursor:
        candidates.length > limit && last
          ? encodeDiscussionCursor({
              v: 1,
              scope,
              limit: continuationLimit,
              sequence: last.sequence,
            })
          : null,
    };
  }
}
