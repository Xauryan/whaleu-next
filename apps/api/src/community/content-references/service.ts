import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { SchemaValidationPipe } from '../../http/validation.js';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { CommunityRepository } from '../community.repository.js';
import type { StoredPost } from '../community.repository.js';
import type { CommunitySpace } from '../contracts.js';
import { CommunityAccessService } from '../community-access.service.js';
import { CommunityDistributionService } from '../related-sync/service.js';
import { ContentReferenceRepository } from './repository.js';
import { referenceLookupSchema, referenceResolveSchema } from './contracts.js';
import type {
  ReferenceDestination,
  ReferenceLookup,
  ReferenceLookupResult,
  ReferenceResolve,
  ReferenceTarget,
} from './contracts.js';
import { requireReferenceViewScope } from './view-scope.js';

const invisible = (error: unknown) =>
  error instanceof ApplicationError &&
  [
    'POST_NOT_FOUND',
    'POST_BLOCKED_BY_YOU',
    'COMMENT_NOT_FOUND',
    'REPLY_NOT_FOUND',
    'COMMUNITY_SCOPE_UNAVAILABLE',
  ].includes(error.code);

@Injectable()
export class ContentReferenceService {
  constructor(
    @Inject(CommunityRepository)
    private readonly community: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(CommunityDistributionService)
    private readonly distribution: CommunityDistributionService,
    @Inject(ContentReferenceRepository)
    private readonly references: ContentReferenceRepository,
  ) {}
  @AccountPolicy('browse', 'entry')
  async capability(token: string): Promise<{ available: boolean }> {
    return this.transaction(async (tx) => {
      const actor = await this.access.actor(token, tx);
      const available = await this.references.publicReady(tx, true);
      await this.finalActor(token, actor, tx);
      return { available };
    });
  }
  @AccountPolicy('browse', 'entry')
  async resolve(
    token: string,
    input: ReferenceResolve,
  ): Promise<ReferenceDestination> {
    const request = new SchemaValidationPipe(referenceResolveSchema).transform(
      input,
    );
    const result = await this.transaction(async (tx) => {
      enableSafetyRelationshipProof(tx);
      const actor = await this.access.actor(token, tx);
      await this.requireReady(tx);
      if (!(await this.references.consume(actor, 'resolve', tx))) {
        await this.finalActor(token, actor, tx);
        return { error: 'REFERENCE_RATE_LIMITED' } as const;
      }
      const target = await this.references.resolve(request.code, tx);
      const destination = target
        ? await this.destination(actor, target, request.viewSpaceId, tx)
        : null;
      // Business locks first, policy last, matching publication lock order.
      await this.requireReady(tx, true);
      await this.finalActor(token, actor, tx);
      return destination
        ? { destination }
        : ({ error: 'REFERENCE_NOT_FOUND' } as const);
    });
    if ('error' in result) throw new ApplicationError(result.error);
    return result.destination;
  }
  @AccountPolicy('browse', 'entry')
  async lookup(
    token: string,
    input: ReferenceLookup,
  ): Promise<ReferenceLookupResult> {
    const request = new SchemaValidationPipe(referenceLookupSchema).transform(
      input,
    );
    const targets = [
      ...new Map(
        request.targets.map((target) => [
          `${target.kind}:${target.targetId}`,
          target,
        ]),
      ).values(),
    ].sort((a, b) =>
      `${a.kind}:${a.targetId}`.localeCompare(`${b.kind}:${b.targetId}`),
    );
    const result = await this.transaction(async (tx) => {
      enableSafetyRelationshipProof(tx);
      const actor = await this.access.actor(token, tx);
      await this.requireReady(tx);
      if (!(await this.references.consume(actor, 'lookup', tx))) {
        await this.finalActor(token, actor, tx);
        return null;
      }
      const items: ReferenceLookupResult['items'] = [];
      for (const target of targets) {
        const code = await this.references.canonical(target, tx);
        if (
          code &&
          (await this.destination(actor, target, request.viewSpaceId, tx))
        )
          items.push({ ...target, code });
      }
      await this.requireReady(tx, true);
      await this.finalActor(token, actor, tx);
      return { items };
    });
    if (!result) throw new ApplicationError('REFERENCE_RATE_LIMITED');
    return result;
  }
  private async finalActor(
    token: string,
    actor: string,
    tx: PoolClient,
  ): Promise<void> {
    if ((await this.access.actor(token, tx)) !== actor)
      throw new ApplicationError('SESSION_REVOKED');
  }
  private async requireReady(tx: PoolClient, lock = false): Promise<void> {
    if (!(await this.references.publicReady(tx, lock)))
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  }
  private async destination(
    actor: string,
    target: ReferenceTarget,
    viewSpaceId: string | undefined,
    tx: PoolClient,
  ): Promise<ReferenceDestination | null> {
    try {
      // Stored ancestry, current canonical privacy/category/relationship checks,
      // ordinary reads only. No administrator or author-ID supplied shortcuts.
      const scope = viewSpaceId ? { viewSpaceId } : {};
      const checkScope = (context: {
        post: StoredPost;
        space: CommunitySpace;
      }) =>
        requireReferenceViewScope(
          context.post,
          context.space,
          viewSpaceId,
          this.community,
          this.distribution,
          tx,
        );
      if (target.kind === 'reply') {
        const context = await this.access.accessibleReply(
          target.targetId,
          actor,
          tx,
        );
        await checkScope(context);
        return {
          kind: 'reply',
          postId: context.post.id,
          rootCommentId: context.comment.id,
          replyId: context.reply.id,
          ...scope,
        };
      }
      if (target.kind === 'comment') {
        const context = await this.access.accessibleComment(
          target.targetId,
          actor,
          tx,
        );
        await checkScope(context);
        return {
          kind: 'comment',
          postId: context.post.id,
          rootCommentId: context.comment.id,
          ...scope,
        };
      }
      const context = await this.access.accessiblePost(
        target.targetId,
        actor,
        tx,
      );
      await checkScope(context);
      return { kind: 'post', postId: context.post.id, ...scope };
    } catch (error) {
      if (invisible(error)) return null;
      throw error;
    }
  }
  private async transaction<T>(
    operation: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.community.database.transaction(operation, {
        isolationLevel: 'read committed',
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }
  }
}
