import { AccountPolicy } from '../safety/account-policy/decorator.js';
import { batchCategoryChildContextAllowed } from './category-reclassification/child-context.js';
import { currentCategoryCursorScope } from './current-category-cursor.js';
import { CURRENT_CATEGORY_POSTS_SQL } from './current-category-sql.js';
import {
  resolvePostCategory,
  resolvePostCategories,
} from './category-reclassification/read-proof.js';
import { retainOwnerRestoreCapability } from './owner-visibility/capability.js';
import {
  ownerPostVisibilityAllowed,
  readOwnerPostVisibility,
} from './owner-visibility/read-proof.js';
import { requireFeedbackSpace } from './feedback/topic.js';
import { TextReviewRuntime } from './text-review/runtime.js';
import { enableSafetyRelationshipProof } from '../safety/relationship-proof.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ApplicationError } from '../http/application-error.js';
import { CommunityRepository } from './community.repository.js';
import type {
  StoredPost,
  StoredComment,
  Seek,
} from './community.repository.js';
import { CommunityAccessService } from './community-access.service.js';
import { CommunitySerializer } from './community-serialization.js';
import {
  requirePublication,
  requireCommentControl,
} from './community-policy.js';
import type {
  CommentCapabilities,
  Capabilities,
  Category,
  FeedPage,
  FeedQuery,
  PageQuery,
  PostView,
  CommentView,
  OwnPublication,
  OwnTradingQuery,
} from './contracts.js';
import { decodeCursor, encodeCursor } from './cursor.js';
@Injectable()
export class FeedService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(CommunitySerializer)
    private readonly serializer: CommunitySerializer,
    @Optional()
    @Inject(TextReviewRuntime)
    private readonly reviews?: TextReviewRuntime,
  ) {}
  @AccountPolicy('browse', 'entry')
  spaces(campusId: string) {
    return this.repository.spaces(campusId);
  }
  @AccountPolicy('browse', 'entry')
  capabilities(
    token: string,
    spaceId: string,
    category: Category,
  ): Promise<Capabilities> {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const space = await this.repository.space(spaceId, tx);
      if (category === 'feedback') await requireFeedbackSpace(space, tx);
      const decision = await this.access.authorization.resolve(
        actor,
        space,
        tx,
        { publication: true },
      );
      const result: Capabilities = {
        publish: {
          availability: 'unavailable',
          reason: 'COMMUNITY_UNAVAILABLE',
        },
        authorModes: [],
        canDisableComments: false,
        postImageLimit: 9,
        commentImageLimit: 3,
        mediaAvailability: 'unavailable',
        commentRules: {
          unverifiedRequiresNamed: true,
          ownAnonymousPostForcesAnonymous: true,
        },
      };
      if (decision.kind === 'deny')
        result.publish = { availability: 'denied', reason: decision.reason };
      if (decision.kind !== 'allow') return result;
      for (const mode of ['named', 'anonymous'] as const)
        try {
          requirePublication(
            decision.value,
            space,
            category,
            mode,
            'publish_post',
          );
          result.authorModes.push(mode);
        } catch (error) {
          if (error instanceof ApplicationError)
            result.publish = {
              availability:
                error.code === 'COMMUNITY_UNAVAILABLE'
                  ? 'unavailable'
                  : 'denied',
              reason: error.code,
            };
          else throw error;
        }
      const reviewAvailable =
        category !== 'trading' &&
        result.authorModes.includes('named') &&
        !!this.reviews &&
        (await this.reviews.available(space, tx, category));
      if (decision.value.runtime && reviewAvailable && category !== 'feedback')
        result.authorModes = ['named'];
      if (result.authorModes.length)
        result.publish =
          decision.value.runtime && !reviewAvailable
            ? {
                availability: 'unavailable',
                reason: 'CONTENT_REVIEW_UNAVAILABLE',
              }
            : { availability: 'allowed', reason: null };
      result.canDisableComments =
        result.authorModes.length > 0 &&
        (decision.value.canDisableComments ?? decision.value.canManage) &&
        !(decision.value.runtime && reviewAvailable);
      return result;
    });
  }
  @AccountPolicy('browse', 'entry')
  feed(token: string | null, query: FeedQuery): Promise<FeedPage> {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        await lockSafetyPolicy(tx);
        const actor = token ? await this.access.actor(token, tx) : null;
        const space = await this.repository.space(query.spaceId, tx);
        if (query.category === 'feedback')
          await requireFeedbackSpace(space, tx);
        const authority = await this.access.advisory(actor, space, tx);
        if (query.cursor) {
          if (!actor) throw new ApplicationError('AUTHENTICATION_REQUIRED');
          const current = await this.access.authority(actor, space, tx, {
            phoneOnly: true,
          });
          if (!current.phoneVerified)
            throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
        }
        const scope = await currentCategoryCursorScope(
          `feed:${space.id}:${query.category ?? '*'}` +
            (query.tradingSubtype ? `:trading:${query.tradingSubtype}` : ''),
          tx,
        );
        let seek = decodeCursor(query.cursor, scope, query.limit);
        const items: PostView[] = [];
        let scanned = 0;
        // Read candidates in bounded batches; filtering never turns an invisible row into a public cursor.
        while (items.length <= query.limit) {
          const rows = await tx.query<StoredPost>(
            `SELECT p.* FROM whaleu_community.posts p JOIN ${CURRENT_CATEGORY_POSTS_SQL} classified ON classified.id=p.id WHERE classified.space_id=$1 AND ($2::text IS NULL OR classified.current_category=$2) AND p.deleted_at IS NULL AND p.visibility='approved' AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM whaleu_community.trading_listings t WHERE t.post_id=p.id AND t.subtype=$5)) AND ($2::text IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_community.trading_listings t WHERE t.post_id=p.id AND t.urgency='urgent')) AND ($3::timestamptz IS NULL OR (classified.published_at,classified.id)<($3::timestamptz,$4::uuid)) ORDER BY classified.published_at DESC,classified.id DESC LIMIT 32 FOR SHARE OF p`,
            [
              space.id,
              query.category ?? null,
              seek?.at ?? null,
              seek?.id ?? null,
              query.tradingSubtype ?? null,
            ],
          );
          scanned += rows.rows.length;
          if (scanned > 1024)
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          if (!rows.rows.length) break;
          await resolvePostCategories(
            rows.rows.map((post) => post.id),
            tx,
          );
          for (const post of rows.rows) {
            seek = { at: post.published_at.toISOString(), id: post.id };
            const currentCategory = await resolvePostCategory(post.id, tx);
            if (
              (await this.access.visible(actor, post, tx, 'list_projection')) &&
              currentCategory !== null &&
              (!query.category || query.category === currentCategory)
            )
              items.push(
                await this.serializer.post(post, space, actor, authority, tx),
              );
            if (items.length > query.limit) break;
          }
          if (rows.rows.length < 32) break;
        }
        const hasMore = items.length > query.limit;
        const page = items.slice(0, query.limit);
        const last = page.at(-1);
        if (!actor)
          return {
            items: page,
            nextCursor: null,
            continuation: hasMore ? 'login_required' : 'end',
          };
        const continuationAuthority = await this.access.advisory(
          actor,
          space,
          tx,
          { phoneOnly: true },
        );
        if (hasMore && continuationAuthority === null)
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        if (!continuationAuthority?.phoneVerified)
          return {
            items: page,
            nextCursor: null,
            continuation: hasMore ? 'phone_verification_required' : 'end',
          };
        return {
          items: page,
          nextCursor:
            hasMore && last
              ? encodeCursor(
                  { at: last.publishedAt, id: last.id },
                  scope,
                  query.limit,
                )
              : null,
          continuation: hasMore ? 'available' : 'end',
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('browse', 'entry')
  commentCapabilities(token: string, id: string): Promise<CommentCapabilities> {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const actor = await this.access.actor(token, tx);
        const { post, space } = await this.access.accessiblePost(id, actor, tx);
        if (
          !(await ownerPostVisibilityAllowed(
            post.id,
            post.account_id,
            actor,
            'list_projection',
            tx,
          ))
        )
          return {
            lastAuthorMode: null,
            availability: 'denied',
            reason: 'POST_NOT_FOUND',
            authorModes: [],
            forcedAuthorMode: null,
          };
        const lastMode =
          (
            await tx.query<{ author_mode: 'named' | 'anonymous' }>(
              `SELECT author_mode FROM (
          SELECT author_mode,created_at,interaction_sequence AS sequence FROM whaleu_community.root_comments WHERE post_id=$1 AND account_id=$2 AND deleted_at IS NULL
          UNION ALL
          SELECT r.author_mode,r.created_at,r.sequence FROM whaleu_community.replies r JOIN whaleu_community.root_comments c ON c.id=r.root_comment_id WHERE r.post_id=$1 AND r.account_id=$2 AND r.deleted_at IS NULL AND c.deleted_at IS NULL
        ) modes ORDER BY sequence DESC LIMIT 1`,
              [post.id, actor],
            )
          ).rows[0]?.author_mode ?? null;
        const result: CommentCapabilities = {
          lastAuthorMode: lastMode,
          availability: 'unavailable',
          reason: 'COMMUNITY_UNAVAILABLE',
          authorModes: [],
          forcedAuthorMode:
            post.author_mode === 'anonymous' && post.account_id === actor
              ? 'anonymous'
              : null,
        };
        const decision = await this.access.authorization.resolve(
          actor,
          space,
          tx,
          { publication: true, targetPostId: post.id },
        );
        if (decision.kind === 'deny') {
          result.availability = 'denied';
          result.reason = decision.reason;
        }
        if (decision.kind !== 'allow') return result;
        const currentCategory = await resolvePostCategory(post.id, tx);
        if (currentCategory === null)
          throw new ApplicationError('POST_NOT_FOUND');
        for (const mode of ['named', 'anonymous'] as const) {
          if (result.forcedAuthorMode && mode !== result.forcedAuthorMode)
            continue;
          try {
            requirePublication(
              decision.value,
              space,
              currentCategory,
              mode,
              'publish_comment',
              post.author_mode,
            );
            requireCommentControl(
              decision.value,
              post.account_id === actor,
              post.comments_policy === 'restricted',
            );
            result.authorModes.push(mode);
          } catch (error) {
            if (error instanceof ApplicationError) {
              result.availability =
                error.code === 'COMMUNITY_UNAVAILABLE'
                  ? 'unavailable'
                  : 'denied';
              result.reason = error.code;
            } else throw error;
          }
        }
        const reviewAvailable =
          result.authorModes.length > 0 &&
          post.comments_policy === 'open' &&
          !!this.reviews &&
          (await this.reviews.available(space, tx, post.category));
        if (
          decision.value.runtime &&
          reviewAvailable &&
          post.category !== 'feedback'
        )
          result.authorModes = ['named'];
        if (result.authorModes.length) {
          result.availability =
            decision.value.runtime && !reviewAvailable
              ? 'unavailable'
              : 'allowed';
          result.reason =
            decision.value.runtime && !reviewAvailable
              ? 'CONTENT_REVIEW_UNAVAILABLE'
              : null;
        }
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('browse', 'entry')
  detail(token: string, id: string): Promise<PostView> {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const actor = await this.access.actor(token, tx);
        const { post, space } = await this.access.accessiblePost(
          id,
          actor,
          tx,
          false,
          true,
        );
        return this.serializer.post(
          post,
          space,
          actor,
          await this.access.advisory(actor, space, tx),
          tx,
          'direct-content',
        );
      },
      { isolationLevel: 'read committed' },
    );
  }
  comments(
    token: string,
    id: string,
    query: PageQuery,
  ): Promise<{ items: CommentView[]; nextCursor: string | null }> {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const actor = await this.access.actor(token, tx);
        const { post, space } = await this.access.accessiblePost(id, actor, tx);
        const authority = await this.access.advisory(actor, space, tx);
        const scope = `comments:${id}`;
        let seek = decodeCursor(query.cursor, scope, query.limit);
        const items: CommentView[] = [];
        let scanned = 0;
        while (items.length <= query.limit) {
          const rows = await tx.query<StoredComment>(
            `SELECT * FROM whaleu_community.root_comments WHERE post_id=$1 AND deleted_at IS NULL AND visibility='approved' AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 32 FOR SHARE`,
            [id, seek?.at ?? null, seek?.id ?? null],
          );
          scanned += rows.rows.length;
          if (scanned > 1024)
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          if (!rows.rows.length) break;
          await batchCategoryChildContextAllowed(
            rows.rows.map((row) => ({
              kind: 'comment' as const,
              id: row.id,
              postId: row.post_id,
            })),
            tx,
          );
          for (const comment of rows.rows) {
            seek = { at: comment.created_at.toISOString(), id: comment.id };
            if (
              await this.access.visible(actor, comment, tx, 'detail_projection')
            )
              items.push(
                await this.serializer.comment(
                  comment,
                  post,
                  actor,
                  authority,
                  tx,
                ),
              );
            if (items.length > query.limit) break;
          }
          if (rows.rows.length < 32) break;
        }
        const hasMore = items.length > query.limit;
        const page = items.slice(0, query.limit);
        const last = page.at(-1);
        return {
          items: page,
          nextCursor:
            hasMore && last
              ? encodeCursor(
                  { at: last.createdAt, id: last.id },
                  scope,
                  query.limit,
                )
              : null,
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('browse', 'entry')
  ownTrading(
    token: string,
    query: OwnTradingQuery,
  ): Promise<{ items: PostView[]; nextCursor: string | null }> {
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const actor = await this.access.actor(token, tx);
        const scope = `own-trading:${query.tradingSubtype ?? '*'}`;
        let seek = decodeCursor(query.cursor, scope, query.limit);
        const items: PostView[] = [];
        let scanned = 0;
        while (items.length <= query.limit) {
          const rows = await tx.query<StoredPost>(
            `SELECT p.* FROM whaleu_community.posts p
          JOIN whaleu_community.trading_listings t ON t.post_id=p.id
          WHERE p.account_id=$1 AND p.category='trading' AND p.deleted_at IS NULL AND p.visibility='approved'
          AND ($2::text IS NULL OR t.subtype=$2)
          AND ($3::timestamptz IS NULL OR (p.published_at,p.id)<($3::timestamptz,$4::uuid))
          ORDER BY p.published_at DESC,p.id DESC LIMIT 32 FOR SHARE OF p`,
            [
              actor,
              query.tradingSubtype ?? null,
              seek?.at ?? null,
              seek?.id ?? null,
            ],
          );
          scanned += rows.rows.length;
          if (scanned > 1024)
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          if (!rows.rows.length) break;
          for (const post of rows.rows) {
            seek = { at: post.published_at.toISOString(), id: post.id };
            try {
              const { space } = await this.access.projectionPost(
                post.id,
                actor,
                tx,
              );
              items.push(
                await this.serializer.post(
                  post,
                  space,
                  actor,
                  await this.access.advisory(actor, space, tx),
                  tx,
                ),
              );
            } catch (error) {
              if (
                !(error instanceof ApplicationError) ||
                error.code !== 'POST_NOT_FOUND'
              )
                throw error;
            }
            if (items.length > query.limit) break;
          }
          if (rows.rows.length < 32) break;
        }
        const page = items.slice(0, query.limit),
          last = page.at(-1);
        return {
          items: page,
          nextCursor:
            items.length > query.limit && last
              ? encodeCursor(
                  { at: last.publishedAt, id: last.id },
                  scope,
                  query.limit,
                )
              : null,
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('browse', 'entry')
  own(
    token: string,
    query: PageQuery,
  ): Promise<{ items: OwnPublication[]; nextCursor: string | null }> {
    return this.repository.database.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const scope = await currentCategoryCursorScope('own', tx);
      const seek: Seek | null = decodeCursor(query.cursor, scope, query.limit);
      const rows = await tx.query<StoredPost>(
        `SELECT p.* FROM whaleu_community.posts p WHERE p.account_id=$1 AND ($2::timestamptz IS NULL OR (p.published_at,p.id)<($2::timestamptz,$3::uuid)) ORDER BY p.published_at DESC,p.id DESC LIMIT $4 FOR SHARE OF p`,
        [actor, seek?.at ?? null, seek?.id ?? null, query.limit + 1],
      );
      const visibility = new Map<
        string,
        Awaited<ReturnType<typeof readOwnerPostVisibility>>
      >();
      // Read overlay only after the parent SHARE locks complete: a joined
      // statement snapshot could otherwise precede a concurrent writer's commit.
      for (const post of rows.rows.slice(0, query.limit))
        visibility.set(post.id, await readOwnerPostVisibility(post.id, tx));
      const categories = await resolvePostCategories(
        rows.rows.slice(0, query.limit).map((post) => post.id),
        tx,
      );
      const items: OwnPublication[] = rows.rows
        .slice(0, query.limit)
        .filter((post) => categories.get(post.id) != null)
        .map((post) => ({
          id: post.id,
          spaceId: post.space_id,
          category: categories.get(post.id)!,
          status: post.deleted_at
            ? 'deleted'
            : post.visibility === 'hidden'
              ? 'hidden'
              : 'published',
          ownerVisibility: {
            ownerHidden: visibility.get(post.id)!.ownerHidden,
            version: visibility.get(post.id)!.version,
            canChange:
              post.deleted_at === null &&
              visibility.get(post.id)!.version < 2147483647,
          },
          publishedAt: post.published_at.toISOString(),
        }));
      for (const item of items)
        await retainOwnerRestoreCapability(actor, item.ownerVisibility, tx);
      // Advance over suppressed metadata too, so an invalid overlay cannot
      // trap private-history pagination or expose its original category.
      const last = rows.rows.slice(0, query.limit).at(-1);
      return {
        items,
        nextCursor:
          rows.rows.length > query.limit && last
            ? encodeCursor(
                { at: last.published_at.toISOString(), id: last.id },
                scope,
                query.limit,
              )
            : null,
      };
    });
  }
}
