import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import { ownerFingerprint } from '../../database/required-owner-proof.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { RatingCategoryManagementAuthorityFacade } from '../../authorization/rating-category-management.facade.js';
import { CampusRatingScopedContextFacade } from '../../campus/rating-scoped-context.facade.js';
import { RatingsAccessService } from '../access.js';
import { RatingScopedContextService } from '../scoped/context.service.js';
import { RatingScopedRepository } from '../scoped/repository.js';
import { RatingScopedCompilationBudget } from '../scoped/compiler.js';
import { ratingScopedArtifactId } from '../scoped/commands.service.js';
import { RatingCategoryManagementReader } from './scoped-reader.repository.js';
import { RatingCategoryIconRepository } from './icon-repository.js';
import {
  CategoryIconMediaCredentials,
  type CategoryIconMediaAuthority,
} from './icon-media-authority.js';
import {
  categoryIconUploadScopeRequestHash,
  ratingCategoryIconUploadScopeSchema,
  type RatingCategoryIconUploadScopeInput,
} from './icon-contracts.js';
import {
  ratingCategoryScopedIntentSchema,
  ratingCategoryScopedIntentHash,
} from './scoped-contracts.js';
import { planCategoryManagement } from './plan.js';
import { categoryIconAffectedScopes } from './icon-references.js';
import {
  categoryIconCapabilities,
  requireCategoryIconCapabilities,
  categoryIconSnapshot,
} from './icon-capability.js';
import { retainCategoryIconState } from './icon-proof.js';
import type {
  CategoryIconUploadScopeAuthority,
  AuthorizedCategoryIconUploadScope,
} from './icon-upload-scopes.js';
import type { PrepareCategoryIconMediaInput } from '../../media/contracts-category-icon.js';
import { categoryIconMediaRequestHash } from '../../media/contracts-category-icon.js';
import type { AuthorizedCategoryIconMediaEdit } from '../../media/category-icon-prepare-scope.js';
import type {
  AuthorizedCategoryIconMediaRead,
  CategoryIconMediaReadRequest,
} from '../../media/category-icon-owner-proof.js';
import { currentCategoryIconManagementRoot } from './icon-root-current.js';
import type { RatingCategoryIconEnvelope } from '../../community/content-review/rating-category-icon-contracts.js';
const unavailable = (): never => {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
};
@Injectable()
export class RatingCategoryIconAuthority
  implements CategoryIconMediaAuthority, CategoryIconUploadScopeAuthority
{
  constructor(
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingCategoryManagementAuthorityFacade)
    private readonly authority: RatingCategoryManagementAuthorityFacade,
    @Inject(CampusRatingScopedContextFacade)
    private readonly campus: CampusRatingScopedContextFacade,
    @Inject(RatingCategoryManagementReader)
    private readonly reader: RatingCategoryManagementReader,
    @Inject(RatingCategoryIconRepository)
    private readonly icons: RatingCategoryIconRepository,
    @Inject(CategoryIconMediaCredentials)
    private readonly credentials: CategoryIconMediaCredentials,
    @Inject(RatingScopedContextService)
    private readonly contexts: RatingScopedContextService,
    @Inject(RatingScopedRepository)
    private readonly scoped: RatingScopedRepository,
  ) {}
  private async management(
    actor: string,
    sessionId: string,
    query: { contextId: string; contextToken: string },
    tx: PoolClient,
    onLocked?: () => Promise<void>,
  ) {
    const row = (
      await tx.query<{
        context: Record<string, unknown>;
        authority: Record<string, unknown>;
        protocol_tuples: { versionId: string }[];
        valid_until: Date;
        current: boolean;
      }>(
        `SELECT *,whaleu_ratings.scoped_context_current(id,$2,$3,clock_timestamp()) current FROM whaleu_ratings.scoped_contexts WHERE id=$1 AND account_id=$2 AND session_id=$3 AND token_digest=$4 FOR SHARE`,
        [
          query.contextId,
          actor,
          sessionId,
          createHash('sha256').update(query.contextToken).digest('hex'),
        ],
      )
    ).rows[0];
    if (
      !row?.current ||
      row.context['protocolVersion'] !== 5 ||
      row.context['purpose'] !== 'manage_categories' ||
      row.context['mode'] !== 'management'
    )
      return unavailable();
    await this.access.requireDeletionActor(actor, tx);
    const selector = row.context[
        'selector'
      ] as RatingCategoryIconUploadScopeInput['context']['selector'],
      grant = await this.authority.resolve(actor, tx),
      domain = await this.campus.resolveCategoryManagementDomain(
        { accountId: actor },
        selector,
        grant,
        tx,
      );
    const key =
        selector.kind === 'global' ? 'global' : `campus:${selector.campusId}`,
      snapshot = await this.reader.snapshot(key, tx);
    if (
      snapshot.snapshotRevision !== row.context['managementSnapshot'] ||
      grant.fingerprint !== row.authority['authorizationFingerprint'] ||
      domain.inventoryFingerprint !== row.authority['inventoryFingerprint'] ||
      (await categoryIconSnapshot([key], tx)) !== row.context['mediaSnapshot']
    )
      unavailable();
    if (onLocked) await onLocked();
    requireCategoryIconCapabilities(
      await categoryIconCapabilities(
        row.protocol_tuples.map((tuple) => tuple.versionId),
        [key],
        tx,
      ),
    );
    registerTransactionDeadline(
      tx,
      row.valid_until.getTime(),
      'RATING_SCOPE_UNAVAILABLE',
    );
    return { row, selector, grant, domain, key, snapshot };
  }
  async authorize(
    actor: string,
    sessionId: string,
    raw: RatingCategoryIconUploadScopeInput,
    tx: PoolClient,
    onLocked?: () => Promise<void>,
  ): Promise<AuthorizedCategoryIconUploadScope> {
    const input = ratingCategoryIconUploadScopeSchema.parse(raw),
      s = await this.management(
        actor,
        sessionId,
        { contextId: input.context.id, contextToken: input.context.token },
        tx,
        onLocked,
      );
    const picked = Object.fromEntries(
      Object.keys(input.context).map((key) => [
        key,
        key === 'token' ? input.context.token : s.row.context[key],
      ]),
    );
    if (
      canonicalJson(input.context) !== canonicalJson(picked) ||
      input.mediaSnapshot !== s.row.context['mediaSnapshot']
    )
      unavailable();
    const text = ratingCategoryScopedIntentSchema.parse({
        protocolVersion: 2,
        operation: input.operation,
        context: input.context,
        payload: input.payload,
      }),
      textHash = ratingCategoryScopedIntentHash(text),
      plan = planCategoryManagement(actor, text, textHash, s.snapshot);
    const budget = new RatingScopedCompilationBudget(),
      roots = await this.icons.roots(tx, budget);
    let categoryId: string, identityId: string;
    if (input.slot.kind === 'new') {
      categoryId = ratingScopedArtifactId(
        textHash,
        `category:${input.slot.key}`,
      );
      identityId = categoryId;
      if (
        !plan.sourceIssues.some(
          (issue) =>
            issue.kind === 'scoped_category_base' &&
            issue.payload['categoryId'] === categoryId,
        )
      )
        unavailable();
    } else {
      categoryId = input.slot.categoryId;
      const category =
        s.snapshot.categories.find(
          (row) =>
            row.scopeKey === s.key && row.expected.body.id === categoryId,
        ) ?? unavailable();
      identityId = category.expected.body.identityId;
    }
    const keys =
      input.slot.kind === 'override'
        ? plan.affectedScopeKeys
        : categoryIconAffectedScopes(
            plan.affectedScopeKeys,
            roots,
            new Set([categoryId]),
            budget,
          );
    const global = plan.globalRequired || keys.includes('global');
    this.authority.require(
      s.grant,
      keys.filter((key) => key !== 'global').map((key) => key.slice(7)),
      global,
      tx,
    );
    await retainCategoryIconState(keys, tx);
    const origin =
      input.slot.kind === 'override'
        ? { kind: 'override' as const, campusId: input.slot.campusId }
        : { kind: 'base' as const };
    const expiresAt = new Date(
      Math.min(s.row.valid_until.getTime(), Date.parse(plan.validUntil)),
    );
    await tx.query(
      `INSERT INTO whaleu_ratings.category_icon_upload_authorizations(actor_id,client_request_id,request_hash,session_id,context_id,text_intent,text_plan,scope_keys,global_required,category_id,identity_id,origin,expires_at)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::text[],$9,$10,$11,$12::jsonb,$13)`,
      [
        actor,
        input.clientRequestId,
        categoryIconUploadScopeRequestHash(input),
        sessionId,
        input.context.id,
        canonicalJson(text),
        canonicalJson(plan),
        keys,
        global,
        categoryId,
        identityId,
        canonicalJson(origin),
        expiresAt,
      ],
    );
    return {
      categoryId,
      identityId,
      origin,
      contextId: input.context.id,
      expiresAt,
    };
  }
  async authorizePrepare(
    actor: string,
    input: PrepareCategoryIconMediaInput,
    tx: PoolClient,
  ): Promise<AuthorizedCategoryIconMediaEdit> {
    const credential = this.credentials.require(tx);
    if (credential.session.accountId !== actor) unavailable();
    const row = (
      await tx.query<{
        input: RatingCategoryIconUploadScopeInput;
        id: string;
        scope_revision: string;
        request_hash: string;
        expires_at: Date;
        session_id: string;
        current: boolean;
      }>(
        `SELECT u.*,whaleu_ratings.category_icon_upload_scope_current(u.id,$2,clock_timestamp()) current FROM whaleu_ratings.category_icon_upload_scopes u WHERE id=$1 AND actor_id=$2 FOR SHARE`,
        [input.editScopeId, actor],
      )
    ).rows[0];
    if (
      !row?.current ||
      row.session_id !== credential.session.sessionId ||
      row.scope_revision !== input.scopeRevision ||
      row.request_hash !== categoryIconMediaRequestHash(actor, input)
    )
      return unavailable();
    const s = await this.management(
      actor,
      credential.session.sessionId,
      {
        contextId: row.input.context.id,
        contextToken: row.input.context.token,
      },
      tx,
    );
    const authorization =
      (
        await tx.query<{ scope_keys: string[]; global_required: boolean }>(
          `SELECT scope_keys,global_required FROM whaleu_ratings.category_icon_upload_authorizations WHERE actor_id=$1 AND client_request_id=$2`,
          [actor, row.input.clientRequestId],
        )
      ).rows[0] ?? unavailable();
    this.authority.require(
      s.grant,
      authorization.scope_keys
        .filter((key) => key !== 'global')
        .map((key) => key.slice(7)),
      authorization.global_required,
      tx,
    );
    await retainCategoryIconState(authorization.scope_keys, tx);
    registerTransactionDeadline(
      tx,
      row.expires_at.getTime(),
      'MEDIA_NOT_READY',
    );
    return {
      actorAccountId: actor,
      serverScopeId: row.id,
      scopeRevision: row.scope_revision,
      expiresAt: row.expires_at.getTime(),
      ownerKind: 'ratings',
      resourceKind: 'category_icon',
      targetKind: 'edit',
      contentVersion: 1,
      audience: 'content-gated',
      purpose: 'ratings-category-icon-image',
      slot: 'icon',
      ordinal: 0,
    };
  }
  async authorizeCurrent(
    token: string,
    request: CategoryIconMediaReadRequest,
    tx: PoolClient,
  ): Promise<AuthorizedCategoryIconMediaRead> {
    const credential = this.credentials.require(tx);
    if (credential.token !== token) unavailable();
    const session = credential.session;
    if (request.purpose === 'management-preview') {
      const s = await this.management(
          session.accountId,
          session.sessionId,
          request,
          tx,
        ),
        budget = new RatingScopedCompilationBudget(),
        roots = await this.icons.roots(tx, budget);
      const matching = roots.filter(
        (root) =>
          root.categoryId === request.categoryId &&
          root.value.kind === 'image' &&
          root.value.appearance.appearanceId === request.appearanceId,
      );
      if (!matching.length) unavailable();
      const keys = categoryIconAffectedScopes(
        [s.key],
        roots,
        new Set([request.categoryId]),
        budget,
      );
      const system = s.snapshot.categories.some(
        (row) =>
          row.expected.body.id === request.categoryId &&
          (row.expected.body.isSystem ||
            row.expected.body.originKind === 'global'),
      );
      this.authority.require(
        s.grant,
        keys.filter((key) => key !== 'global').map((key) => key.slice(7)),
        system || keys.includes('global'),
        tx,
      );
      const current = await currentCategoryIconManagementRoot(
        {
          categoryId: request.categoryId,
          appearanceId: request.appearanceId,
          selector: s.selector,
        },
        tx,
        budget,
      );
      await this.access.recheck(token, tx);
      return {
        principal: {
          kind: 'authenticatedRatings',
          accountId: session.accountId,
          sessionId: session.sessionId,
        },
        actorAccountId: current.appearance.actorId,
        categoryId: request.categoryId,
        parent: current.parent,
        assetId: current.appearance.assetId,
        manifestDigest: current.appearance.manifestDigest,
        bindingId: current.binding.bindingId,
        ownerRevision: current.ownerRevision,
        reviewRevision: current.reviewRevision,
        qualification: current.qualification,
      };
    }
    const scope = await this.contexts.resolve(token, request, tx, {
      purpose: 'read',
      protocolVersion: 5,
    });
    await this.scoped.category(scope, request.categoryId, tx);
    const row =
      (
        await tx.query<{
          release_id: string;
          effective_revision: string;
          extension_digest: string;
          definition_id: string;
          envelope: RatingCategoryIconEnvelope;
          id: string;
          actor_id: string;
          asset_id: string;
          manifest_digest: string;
          media_binding_id: string;
        }>(
          `SELECT p.release_id,p.effective_revision,p.extension_digest,b.definition_id,b.envelope,a.* FROM whaleu_ratings.category_icon_projections p
    JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=p.review_binding_id JOIN whaleu_ratings.category_icon_appearances a ON a.id=p.appearance_id
    WHERE p.catalog_id=$1 AND p.category_id=$2 AND a.id=$3`,
          [scope.catalog.id, request.categoryId, request.appearanceId],
        )
      ).rows[0] ?? unavailable();
    const content = row.envelope.content;
    if (
      content.icon.kind !== 'image' ||
      content.icon.appearance.appearanceId !== request.appearanceId ||
      content.icon.appearance.assetId !== row.asset_id ||
      content.icon.appearance.manifestDigest !== row.manifest_digest
    )
      unavailable();
    await this.scoped.retainAfter(scope, tx);
    await this.access.recheck(token, tx);
    return {
      principal: {
        kind: 'authenticatedRatings',
        accountId: session.accountId,
        sessionId: session.sessionId,
      },
      actorAccountId: row.actor_id,
      categoryId: request.categoryId,
      parent: {
        ownerKind: 'ratings',
        resourceKind: 'category_icon',
        resourceId: request.appearanceId,
        contentVersion: 1,
      },
      assetId: row.asset_id,
      manifestDigest: row.manifest_digest,
      bindingId: row.media_binding_id,
      ownerRevision: ownerFingerprint({
        scope: scope.scopeRevision,
        release: row.release_id,
        revision: row.effective_revision,
        extension: row.extension_digest,
      }),
      reviewRevision: ownerFingerprint(row.envelope),
      qualification: {
        releaseId: row.release_id,
        catalogId: scope.catalog.id,
        effectiveRevision: row.effective_revision,
        identityId: content.identityId,
        baseSource: content.baseSource,
        overrideSource: content.overrideSource,
        definitionId: row.definition_id,
        extensionDigest: row.extension_digest,
      },
    };
  }
}
