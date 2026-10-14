import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { PoolClient } from 'pg';
import {
  canonicalJson,
  contentScopeSchema,
} from '../../community/content-review/contracts.js';
import { CommunityRepository } from '../../community/community.repository.js';
import { CommunityAccessService } from '../../community/community-access.service.js';
import { requirePublication } from '../../community/community-policy.js';
import { ApplicationError } from '../../http/application-error.js';
import { ratingScopedDigest } from '../scoped/protocol-registry.js';
import { RatingCategoryScopedManagementService } from '../category-management/scoped-service.js';
import { RatingScopedContextService } from '../scoped/context.service.js';
import { RatingsAccessService } from '../access.js';
import { RatingTargetLinkFacade } from '../target-link/facade.js';
import type { AssistanceRequest } from './contracts.js';

/** Composition only: generation never selects another owner's grants or Review SQL. */
@Injectable()
export class RatingAssistanceQualification {
  constructor(
    @Inject(RatingCategoryScopedManagementService)
    private readonly categories: RatingCategoryScopedManagementService,
    @Inject(RatingScopedContextService)
    private readonly contexts: RatingScopedContextService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(ModuleRef) private readonly modules: ModuleRef,
  ) {}
  async qualify(token: string, request: AssistanceRequest, tx: PoolClient) {
    if (request.purpose === 'category_description')
      return this.categories.qualifyAssistance(token, request, tx);
    const session = await this.access.authenticate(token, tx);
    await this.access.resolveAccount(session.accountId, null, tx, {
      phone: true,
    });
    const scope = await this.contexts.resolve(
      token,
      { contextId: request.context.id, contextToken: request.context.token },
      tx,
    );
    if (
      scope.context.mode !== 'public' ||
      !['read', 'interact'].includes(scope.context.purpose)
    )
      throw new ApplicationError('RATING_ASSISTANCE_UNAVAILABLE');
    const facts = {
      ...scope.context,
      catalogRevision: scope.catalogRevision,
      headRevision: scope.headRevision,
    };
    for (const [key, value] of Object.entries(request.context)) {
      if (
        key !== 'token' &&
        canonicalJson(value) !== canonicalJson(facts[key as keyof typeof facts])
      )
        throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
    }
    const records = this.modules.get(CommunityRepository, { strict: false });
    const community = this.modules.get(CommunityAccessService, {
      strict: false,
    });
    const target = this.modules.get(RatingTargetLinkFacade, { strict: false });
    const space = await records.space(request.payload.destination.spaceId, tx);
    const authority = await community.authority(session.accountId, space, tx, {
      publication: true,
    });
    requirePublication(
      authority,
      space,
      'discussion',
      request.payload.destination.authorMode,
      'publish_post',
    );
    const bound = await target.qualify(scope, request.payload, tx);
    if (!authority.publicationScope)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const sourceBinding = {
      target: bound.binding,
      destinationScope: contentScopeSchema.parse(authority.publicationScope),
    };
    await this.access.recheck(token, tx);
    return {
      accountId: session.accountId,
      sessionId: session.sessionId,
      input: { name: bound.currentName, context: bound.purpose },
      sourceRevision: ratingScopedDigest(
        'assistance-target-source',
        sourceBinding,
      ),
      sourceBinding,
    };
  }
}
