import { Inject, Injectable } from '@nestjs/common';
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
} from './contracts.js';
import { CommunityRepository } from './community.repository.js';
import type { StoredPost, StoredComment } from './community.repository.js';
import { CommunityAccessService } from './community-access.service.js';
@Injectable()
export class CommunitySerializer {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(AuthorDisplayService)
    private readonly profiles: AuthorDisplayService,
    @Inject(MEDIA_ATTACHMENT) private readonly media: MediaAttachmentPort,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
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
    const display = await this.profiles.find(content.account_id, tx);
    if (!display) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return {
      kind: 'named',
      profileId: display.profileId,
      displayName: display.displayName,
      avatar: null,
    };
  }
  async images(
    kind: 'post' | 'comment',
    id: string,
    tx: PoolClient,
  ): Promise<MediaView[]> {
    const assets = await this.repository.images(kind, id, tx);
    if (!assets.length) return [];
    const views = requireDecision(
      await this.media.display(assets, tx),
      'MEDIA_UNAVAILABLE',
    );
    if (
      views.length !== assets.length ||
      views.some(
        (view, index) =>
          view.assetId !== assets[index]?.assetId ||
          !Number.isInteger(view.width) ||
          !Number.isInteger(view.height) ||
          view.width < 1 ||
          view.height < 1 ||
          view.width > 20000 ||
          view.height > 20000 ||
          !safeUrl(view.displayUrl) ||
          !safeUrl(view.thumbnailUrl) ||
          !safeExpiration(view.expiresAt),
      )
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return views.map(
      ({ assetId, width, height, displayUrl, thumbnailUrl, expiresAt }) => ({
        assetId,
        width,
        height,
        displayUrl,
        thumbnailUrl,
        expiresAt,
      }),
    );
  }
  async post(
    post: StoredPost,
    space: CommunitySpace,
    viewer: string | null,
    authority: Authority | null,
    tx: PoolClient,
  ): Promise<PostView> {
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
    let commentCount = 0;
    for (const comment of comments.rows)
      if (await this.access.visible(viewer, comment, tx)) commentCount++;
    let canComment = false;
    if (authority)
      for (const mode of ['named', 'anonymous'] as const) {
        if (
          post.author_mode === 'anonymous' &&
          viewer === post.account_id &&
          mode !== 'anonymous'
        )
          continue;
        try {
          requirePublication(
            authority,
            space,
            post.category,
            mode,
            'publish_comment',
            post.author_mode,
          );
          canComment =
            post.comments_policy === 'open' ||
            viewer === post.account_id ||
            authority.canManage;
        } catch {
          /* Advisory only; every write rechecks. */
        }
        if (canComment) break;
      }
    return {
      id: post.id,
      space: { id: space.id, kind: space.kind, name: space.name },
      category: post.category,
      text: post.text,
      images: await this.images('post', post.id, tx),
      author: await this.author(post, post, tx),
      publishedAt: post.published_at.toISOString(),
      likeCount: likes.rows[0]!.count,
      commentCount,
      viewer: {
        isSelf: viewer === post.account_id,
        isLiked: likes.rows[0]!.liked,
        canDelete:
          viewer === post.account_id && actionAllowed(authority, 'delete'),
        canComment,
      },
      commentsPolicy: post.comments_policy,
    };
  }
  async comment(
    comment: StoredComment,
    post: StoredPost,
    viewer: string,
    authority: Authority | null,
    tx: PoolClient,
  ): Promise<CommentView> {
    return {
      id: comment.id,
      postId: post.id,
      text: comment.text,
      images: await this.images('comment', comment.id, tx),
      author: await this.author(comment, post, tx),
      createdAt: comment.created_at.toISOString(),
      viewer: {
        isSelf: viewer === comment.account_id,
        canDelete:
          viewer === comment.account_id && actionAllowed(authority, 'delete'),
      },
    };
  }
}
function safeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !/\s/u.test(value) &&
      [...value].every((character) => {
        const code = character.codePointAt(0)!;
        return code >= 32 && !(code >= 127 && code <= 159);
      })
    );
  } catch {
    return false;
  }
}

function safeExpiration(value: string | null): boolean {
  if (value === null) return true;
  const epoch = Date.parse(value);
  return (
    Number.isFinite(epoch) &&
    epoch > Date.now() &&
    new Date(epoch).toISOString() === value
  );
}
