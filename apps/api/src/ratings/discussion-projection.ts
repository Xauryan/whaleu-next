import {
  canonicalRatingDiscussionMediaEnvelope,
  ratingDiscussionAttachmentSetDigest,
} from '../community/content-review/rating-discussion-media-contracts.js';
import {
  currentRatingDiscussionMedia,
  currentRatingDiscussionDescriptors,
} from './discussion-media-current.js';
import {
  ratingDiscussionMediaRootSchema,
  ratingDiscussionMediaReplySchema,
  type RatingDiscussionMediaRoot,
  type RatingDiscussionMediaReply,
} from './discussion-media-projection-contracts.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { RatingContentReviewFacade } from '../community/content-review/rating-content-review.facade.js';
import { canonicalRatingEnvelope } from '../community/content-review/rating-contracts.js';
import { canonicalRatingScopedEnvelope } from '../community/content-review/rating-scoped-contracts.js';
import { RatingSafetyFacade } from '../safety/rating.facade.js';
import { AuthorDisplayService } from '../profile/author-display.service.js';
import { RatingsRepository } from './repository.js';
import { qualifyCurrentRatingTarget } from './target-projection.facade.js';
import type { RatingCatalog, CommentRow } from './repository.js';
import { RatingDiscussionRepository } from './discussion-repository.js';
import type { ReplyRow } from './discussion-repository.js';
import { ratingCommentSchema } from './contracts.js';
import type { RatingComment } from './contracts.js';
import { ratingReplySchema } from './discussion-contracts.js';
import type { RatingReply } from './discussion-contracts.js';
@Injectable()
export class RatingDiscussionProjection {
  constructor(
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingDiscussionRepository)
    private readonly replies: RatingDiscussionRepository,
    @Inject(RatingContentReviewFacade)
    private readonly review: RatingContentReviewFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
    @Inject(AuthorDisplayService)
    private readonly authors: AuthorDisplayService,
  ) {}
  async target(
    catalog: RatingCatalog,
    id: string,
    tx: PoolClient,
    write = false,
  ) {
    return qualifyCurrentRatingTarget(
      this.records,
      this.review,
      catalog,
      id,
      tx,
      write,
    );
  }
  async canReply(row: CommentRow, actor: string, tx: PoolClient) {
    if (row.author_mode === 'anonymous') return true;
    const d = await this.safety.named(
      actor,
      row.account_id,
      'rating_direct',
      tx,
    );
    if (d.kind === 'unavailable')
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    return d.kind === 'allow';
  }
  async author(
    row: CommentRow,
    actor: string,
    purpose: 'rating_list' | 'rating_direct',
    tx: PoolClient,
  ): Promise<RatingComment['author'] | null> {
    if (row.author_mode === 'anonymous') {
      if (!row.persona_id || !row.persona_name)
        throw new ApplicationError('RATING_UNAVAILABLE');
      return {
        mode: 'anonymous',
        targetId: row.target_id,
        personaId: row.persona_id,
        displayName: row.persona_name,
      };
    }
    const d = await this.safety.named(actor, row.account_id, purpose, tx);
    if (d.kind === 'deny') return null;
    if (d.kind !== 'allow') throw new ApplicationError('SAFETY_UNAVAILABLE');
    const profile = await this.authors.findRatingPublic(row.account_id, tx);
    if (!profile) throw new ApplicationError('RATING_UNAVAILABLE');
    return { mode: 'named', ...profile };
  }
  async content(
    row: CommentRow,
    kind: 'comment' | 'reply',
    actor: string,
    purpose: 'rating_list' | 'rating_direct',
    tx: PoolClient,
  ) {
    if (row.deleted_at !== null) return null;
    const contentEnvelope =
      (row.envelope as { version?: number })?.version === 7
        ? canonicalRatingDiscussionMediaEnvelope(row.envelope)
        : (row.envelope as { version?: number })?.version === 5
          ? canonicalRatingScopedEnvelope(row.envelope)
          : canonicalRatingEnvelope(row.envelope);
    if (
      contentEnvelope.version === 5 &&
      contentEnvelope.purpose !== 'publish_rating_comment_scoped' &&
      contentEnvelope.purpose !== 'publish_rating_reply_scoped'
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    const d = await this.review.current(kind, row.id, contentEnvelope, tx);
    if (d.kind === 'deny') return null;
    if (d.kind !== 'allow')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    if (contentEnvelope.version === 7) {
      const media = await currentRatingDiscussionMedia(
        contentEnvelope,
        actor,
        tx,
      );
      if (media === 'deny') return null;
      if (media !== 'allow') throw new ApplicationError('MEDIA_UNAVAILABLE');
    }
    return this.author(row, actor, purpose, tx);
  }
  async root(
    row: CommentRow,
    actor: string,
    purpose: 'rating_list' | 'rating_direct',
    tx: PoolClient,
  ): Promise<RatingComment | null> {
    if ((row.envelope as { version?: number })?.version === 7)
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const author = await this.content(row, 'comment', actor, purpose, tx);
    if (!author) return null;
    const isMine = row.account_id === actor;
    return ratingCommentSchema.parse({
      id: row.id,
      targetId: row.target_id,
      body: row.body,
      revision: row.revision,
      createdAt: row.created_at,
      author,
      isMine,
      allowedActions: { delete: isMine },
    });
  }
  async reply(
    row: ReplyRow,
    actor: string,
    rootCanReply: boolean,
    purpose: 'rating_list' | 'rating_direct',
    tx: PoolClient,
  ): Promise<RatingReply | null> {
    if ((row.envelope as { version?: number })?.version === 7)
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const author = await this.content(row, 'reply', actor, purpose, tx);
    if (!author) return null;
    let replyTo: RatingReply['replyTo'] = { kind: 'root' };
    if (row.reply_to_id) {
      const quoted = await this.replies.reply(
        row.reply_to_id,
        row.root_id,
        row.target_id,
        tx,
        false,
        true,
      );
      const quoteAuthor = await this.content(
        quoted,
        'reply',
        actor,
        purpose,
        tx,
      );
      replyTo = quoteAuthor
        ? {
            kind: 'reply',
            status: 'available',
            replyId: quoted.id,
            revision: quoted.revision,
            author: quoteAuthor,
          }
        : { kind: 'reply', status: 'unavailable' };
    }
    const isMine = row.account_id === actor;
    return ratingReplySchema.parse({
      id: row.id,
      targetId: row.target_id,
      rootId: row.root_id,
      body: row.body,
      revision: row.revision,
      createdAt: row.created_at,
      author,
      isMine,
      allowedActions: {
        reply: rootCanReply && (await this.canReply(row, actor, tx)),
        delete: isMine,
      },
      replyTo,
    });
  }
  async rootMedia(
    row: CommentRow,
    actor: string,
    purpose: 'rating_list' | 'rating_direct',
    tx: PoolClient,
  ): Promise<RatingDiscussionMediaRoot | null> {
    if ((row.envelope as { version?: number })?.version !== 7) {
      const legacy = await this.root(row, actor, purpose, tx);
      return legacy
        ? ratingDiscussionMediaRootSchema.parse({
            ...legacy,
            protocolVersion: 4,
            images: [],
            attachmentSetDigest: ratingDiscussionAttachmentSetDigest([]),
          })
        : null;
    }
    const author = await this.content(row, 'comment', actor, purpose, tx);
    if (!author) return null;
    const envelope = canonicalRatingDiscussionMediaEnvelope(row.envelope);
    if (envelope.purpose !== 'publish_rating_comment_media_scoped')
      throw new ApplicationError('RATING_UNAVAILABLE');
    const isMine = row.account_id === actor;
    return ratingDiscussionMediaRootSchema.parse({
      protocolVersion: 4,
      id: row.id,
      targetId: row.target_id,
      body: row.body,
      revision: row.revision,
      createdAt: row.created_at,
      author,
      isMine,
      allowedActions: { delete: isMine },
      attachmentSetDigest: envelope.attachmentSetDigest,
      images: currentRatingDiscussionDescriptors(envelope, actor, tx),
    });
  }
  async replyMedia(
    row: ReplyRow,
    actor: string,
    rootCanReply: boolean,
    purpose: 'rating_list' | 'rating_direct',
    tx: PoolClient,
  ): Promise<RatingDiscussionMediaReply | null> {
    const author = await this.content(row, 'reply', actor, purpose, tx);
    if (!author) return null;
    const envelope =
      (row.envelope as { version?: number })?.version === 7
        ? canonicalRatingDiscussionMediaEnvelope(row.envelope)
        : null;
    if (envelope && envelope.purpose !== 'publish_rating_reply_media_scoped')
      throw new ApplicationError('RATING_UNAVAILABLE');
    let replyTo: RatingReply['replyTo'] = { kind: 'root' };
    if (row.reply_to_id) {
      replyTo = { kind: 'reply', status: 'unavailable' };
      try {
        const quoted = await this.replies.reply(
          row.reply_to_id,
          row.root_id,
          row.target_id,
          tx,
          false,
          true,
        );
        const quoteAuthor = await this.content(
          quoted,
          'reply',
          actor,
          purpose,
          tx,
        );
        if (quoteAuthor)
          replyTo = {
            kind: 'reply',
            status: 'available',
            replyId: quoted.id,
            revision: quoted.revision,
            author: quoteAuthor,
          };
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          ![
            'RATING_NOT_FOUND',
            'RATING_UNAVAILABLE',
            'RATING_SCOPE_UNAVAILABLE',
            'MEDIA_UNAVAILABLE',
            'CONTENT_REVIEW_UNAVAILABLE',
            'SAFETY_UNAVAILABLE',
          ].includes(error.code)
        )
          throw error;
        // The quoted subject is an optional reference, never a true ancestor.
      }
    }
    const isMine = row.account_id === actor;
    return ratingDiscussionMediaReplySchema.parse({
      protocolVersion: 4,
      id: row.id,
      targetId: row.target_id,
      rootId: row.root_id,
      body: row.body,
      revision: row.revision,
      createdAt: row.created_at,
      author,
      isMine,
      allowedActions: {
        reply: rootCanReply && (await this.canReply(row, actor, tx)),
        delete: isMine,
      },
      replyTo,
      attachmentSetDigest:
        envelope?.attachmentSetDigest ??
        ratingDiscussionAttachmentSetDigest([]),
      images: envelope
        ? currentRatingDiscussionDescriptors(envelope, actor, tx)
        : [],
    });
  }
}
