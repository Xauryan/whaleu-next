import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { RatingCategoryIconRetirementOwner } from './icon-retirement.js';
import { RatingCategoryScopedManagementService } from './scoped-service.js';
import { RatingCategoryIconAuthority } from './icon-authority.js';
import { negotiateCategoryIconProtocol } from './icon-negotiation.js';
import {
  CategoryIconUploadScopes,
  type CategoryIconUploadScopeRecoveryInput,
} from './icon-upload-scopes.js';
import {
  ratingCategoryIconUploadScopeSchema,
  ratingCategoryIconRecoveryClosureSchema,
  type RatingCategoryIconUploadScopeInput,
} from './icon-contracts.js';
import type { CategoryIconMutation } from './icon-proof.js';
import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
  type RequiredTransactionProof,
} from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { RatingCategoryManagementAuthorityFacade } from '../../authorization/rating-category-management.facade.js';
import { CampusRatingScopedContextFacade } from '../../campus/rating-scoped-context.facade.js';
import { RatingsAccessService } from '../access.js';
import { assertRatingCommandClaim } from '../management/requests.js';
import { RatingScopedReleaseRepository } from '../scoped/release.repository.js';
import { ratingScopedDigest } from '../scoped/protocol-registry.js';
import type { RatingNavigationSelector } from '../scoped/contracts.js';
import { RatingCategoryManagementReader } from './scoped-reader.repository.js';
import { RatingCategorySourceIssuer } from './source-issuer.js';
import type { CategoryManagementPlan } from './plan.js';
import { RatingScopedCompilationBudget } from '../scoped/compiler.js';
import { RatingCategoryIconRepository } from './icon-repository.js';
import { RatingCategoryIconMediaService } from './icon-media.service.js';
import { RatingCategoryIconReviewFacade } from '../../community/content-review/rating-category-icon-review.facade.js';
import type { RatingCategoryIconEnvelope } from '../../community/content-review/rating-category-icon-contracts.js';
import {
  categoryIconCapabilities,
  requireCategoryIconCapabilities,
  categoryIconSnapshot,
} from './icon-capability.js';
import {
  beginCategoryIconMutation,
  finishCategoryIconMutation,
  retainCategoryIconState,
} from './icon-proof.js';
import {
  planCategoryIconManagement,
  type CategoryIconPlan,
  type CategoryIconTrustedUpload,
} from './icon-plan.js';
import {
  categoryIconReplacements,
  categoryIconTextIntent,
  categoryIconTextHash as importTextHash,
  ratingManagedCategoryIconSchema,
} from './icon-contracts.js';
import {
  plannedCategoryIconContents,
  plannedCategoryIconEnvelopes,
} from './icon-review-plan.js';
import {
  categoryIconContentDigest,
  type CategoryIconReleaseCoverage,
  type CategoryIconContent,
} from './icon-extension.js';
import * as C from './icon-service-contracts.js';
interface Prepared {
  account_id: string;
  request_id: string;
  intent_hash: string;
  intent: C.RatingCategoryScopedIntent;
  session_id: string;
  context_revision: string;
  category_plan: CategoryManagementPlan;
  valid_until: Date;
  media_plan: {
    plan: CategoryIconPlan;
    reviewEnvelopes: readonly RatingCategoryIconEnvelope[];
    coverage: readonly {
      content: CategoryIconContent;
      binding: {
        id: string;
        definition_id: string;
        definition_digest: string;
        approval_digest: string;
        envelope: RatingCategoryIconEnvelope;
      } | null;
    }[];
  };
}
async function fenceSnapshot(keys: readonly string[], tx: PoolClient) {
  return ownerFingerprint(
    (
      await tx.query(
        `SELECT jsonb_build_object('source',(SELECT epoch::text FROM whaleu_ratings.scoped_source_epoch WHERE singleton),'protocol',(SELECT epoch::text FROM whaleu_ratings.scope_protocol_epoch WHERE singleton),'heads',whaleu_ratings.scoped_head_tuples($1::text[]),'vector',whaleu_ratings.scoped_current_source_vector($1::text[])) state`,
        [keys],
      )
    ).rows[0].state,
  );
}
const proof: RequiredTransactionProof<{
  keys: readonly string[];
  fingerprint: string;
}> = {
  maximumFacts: 1,
  failureCode: 'RATING_SCOPE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_SCOPE_UNAVAILABLE', async (read) => {
      if (facts.length !== 1)
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      await read.query(
        'LOCK TABLE whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch IN ROW SHARE MODE NOWAIT',
      );
      await read.query(
        'SELECT epoch FROM whaleu_ratings.scoped_source_epoch WHERE singleton FOR SHARE NOWAIT',
      );
      await read.query(
        'SELECT epoch FROM whaleu_ratings.scope_protocol_epoch WHERE singleton FOR SHARE NOWAIT',
      );
      await read.query(
        'LOCK TABLE whaleu_ratings.scoped_catalog_heads IN SHARE MODE NOWAIT',
      );
      if (facts[0]!.fingerprint !== (await fenceSnapshot(facts[0]!.keys, read)))
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    }),
};
async function retain(keys: readonly string[], tx: PoolClient) {
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    'category-management',
    Object.freeze({ keys, fingerprint: await fenceSnapshot(keys, tx) }),
  );
}
const queryScope = (s: RatingNavigationSelector) =>
  s.kind === 'global' ? 'global' : `campus:${s.campusId}`;

@Injectable()
export class RatingCategoryIconManagementService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingCategoryManagementAuthorityFacade)
    private readonly authority: RatingCategoryManagementAuthorityFacade,
    @Inject(CampusRatingScopedContextFacade)
    private readonly campus: CampusRatingScopedContextFacade,
    @Inject(RatingCategoryManagementReader)
    private readonly reader: RatingCategoryManagementReader,
    @Inject(RatingCategorySourceIssuer)
    private readonly issuer: RatingCategorySourceIssuer,
    @Inject(RatingScopedReleaseRepository)
    private readonly releases: RatingScopedReleaseRepository,
    @Inject(RatingCategoryIconRepository)
    private readonly icons: RatingCategoryIconRepository,
    @Inject(RatingCategoryIconMediaService)
    private readonly media: RatingCategoryIconMediaService,
    @Inject(RatingCategoryIconReviewFacade)
    private readonly iconReview: RatingCategoryIconReviewFacade,
    @Inject(RatingCategoryScopedManagementService)
    private readonly legacy: RatingCategoryScopedManagementService,
    @Inject(RatingCategoryIconAuthority)
    private readonly iconAuthority: RatingCategoryIconAuthority,
    @Inject(RatingCategoryIconRetirementOwner)
    private readonly retirement: RatingCategoryIconRetirementOwner,
  ) {}
  @AccountPolicy('privileged_read', 'entry')
  retirementStatus(
    token: string,
    input: { requestId: string; appearanceIds?: readonly string[] },
  ) {
    return this.media
      .inspectRetirement(token, input)
      .then((items) => ({ items }));
  }
  @AccountPolicy('noncontent_management', 'owner_after_recovery')
  cleanupRetirement(
    token: string,
    input: { requestId: string; appearanceIds: readonly string[] },
  ) {
    return this.media.retire(token, input);
  }
  private run<T>(fn: (tx: PoolClient) => Promise<T>) {
    return this.db.transaction(fn, { isolationLevel: 'read committed' });
  }
  private async enter(token: string, tx: PoolClient, write = false) {
    await lockSafetyPolicy(tx, write);
    await tx.query("SET LOCAL statement_timeout='5s'");
    return this.access.authenticate(token, tx);
  }
  private async management(
    actor: string,
    selector: RatingNavigationSelector,
    tx: PoolClient,
  ) {
    await this.access.requireDeletionActor(actor, tx);
    const authority = await this.authority.resolve(actor, tx),
      domain = await this.campus.resolveCategoryManagementDomain(
        { accountId: actor },
        selector,
        authority,
        tx,
      );
    return { authority, domain };
  }
  @AccountPolicy('privileged_read', 'entry')
  context(
    token: string,
    input: { selector: RatingNavigationSelector },
    transaction?: PoolClient,
  ) {
    const work = async (tx: PoolClient) => {
      const session = await this.enter(token, tx),
        { authority, domain } = await this.management(
          session.accountId,
          input.selector,
          tx,
        ),
        key = queryScope(input.selector),
        snapshot = await this.reader.snapshot(key, tx);
      const policies = snapshot.sources.filter(
        (s) =>
          s.source_kind === C.RATING_CATEGORY_MANAGEMENT_POLICY &&
          s.current &&
          s.scope_keys.includes(key) &&
          s.payload['enabled'] === true,
      );
      if (policies.length !== 1)
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      const policy = policies[0]!,
        operations = C.ratingCategoryScopedOperations.filter(
          (op) =>
            Array.isArray(policy.payload['operations']) &&
            policy.payload['operations'].includes(op),
        );
      if (!operations.length)
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      const logical = domain.view?.regionId ?? 'global',
        protocol = (
          await tx.query<{ versionId: string; generation: string }>(
            `SELECT p.id "versionId",p.generation FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions p ON p.id=h.version_id WHERE h.logical_scope_key=$1 AND p.phase='adopted'`,
            [logical],
          )
        ).rows[0];
      if (!protocol) throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      const iconCapabilities = await categoryIconCapabilities(
        [protocol.versionId],
        [key],
        tx,
      );
      requireCategoryIconCapabilities(iconCapabilities);
      const mediaSnapshot = await categoryIconSnapshot([key], tx);
      const head = snapshot.heads.find((h) => h.scopeKey === key)!,
        id = randomUUID(),
        raw = randomBytes(32).toString('base64url'),
        tokenDigest = createHash('sha256').update(raw).digest('hex'),
        now = (await tx.query<{ at: Date }>('SELECT clock_timestamp() at'))
          .rows[0]!.at;
      const expires = new Date(
        Math.min(
          now.getTime() + 300000,
          snapshot.validUntil,
          domain.validUntil ?? Infinity,
          authority.validUntil ?? Infinity,
          policy.valid_until.getTime(),
        ),
      );
      const commandContext = {
        id,
        token: raw,
        tokenDigest,
        selector: input.selector,
        scopeRevision: ratingScopedDigest('category-context', {
          snapshot: snapshot.snapshotRevision,
          authority: authority.fingerprint,
          inventory: domain.inventoryFingerprint,
        }),
        protocolGeneration: protocol.generation,
        catalogRevision: head.catalogRevision,
        headRevision: head.headRevision,
        sourceDigest: snapshot.sourceDigest,
      };
      const context = {
        protocolVersion: 5,
        mediaSnapshot,
        capabilities: ['category_icon'],
        ...commandContext,
        actorId: session.accountId,
        purpose: 'manage_categories',
        mode: 'management',
        heads: [head],
        managementSnapshot: snapshot.snapshotRevision,
        expiresAt: expires.toISOString(),
        operations,
      };
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_contexts(id,account_id,session_id,token_digest,context,authority,protocol_tuples,issued_at,valid_until) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9)`,
        [
          id,
          session.accountId,
          session.sessionId,
          tokenDigest,
          canonicalJson(context),
          canonicalJson({
            topologySnapshotId: domain.topologySnapshotId,
            inventoryFingerprint: domain.inventoryFingerprint,
            authorizationMode: 'category_management',
            authorizationFingerprint: authority.fingerprint,
            categoryIconCapabilities: iconCapabilities,
            contextAuthority: 'ratings-category-icon-context-v1',
          }),
          canonicalJson([{ scopeKey: logical, ...protocol }]),
          now,
          expires,
        ],
      );
      registerTransactionDeadline(
        tx,
        expires.getTime(),
        'RATING_SCOPE_UNAVAILABLE',
      );
      await retain([key], tx);
      await this.access.recheck(token, tx);
      return C.ratingCategoryManagementContextSchema.parse({
        protocolVersion: 5,
        mediaSnapshot,
        capabilities: ['category_icon'],
        commandContext,
        expiresAt: expires.toISOString(),
        snapshotRevision: snapshot.snapshotRevision,
        campusIds: authority.campusIds,
        canManageGlobal: authority.global,
        operations,
      });
    };
    return transaction ? work(transaction) : this.run(work);
  }
  @AccountPolicy('privileged_read', 'entry')
  entryContext(token: string, input: { selector: RatingNavigationSelector }) {
    return this.run(async (tx) => {
      const session = await this.enter(token, tx),
        { domain } = await this.management(
          session.accountId,
          input.selector,
          tx,
        );
      const protocol = (
        await tx.query<{ id: string }>(
          `SELECT p.id FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions p ON p.id=h.version_id WHERE h.logical_scope_key=$1 AND p.phase='adopted'`,
          [domain.view?.regionId ?? 'global'],
        )
      ).rows[0];
      if (!protocol) throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      const kind = await negotiateCategoryIconProtocol(
        [protocol.id],
        [queryScope(input.selector)],
        tx,
      );
      return kind === 'icon'
        ? { kind, context: await this.context(token, input, tx) }
        : { kind, context: await this.legacy.context(token, input, tx) };
    });
  }
  @AccountPolicy('content_management', 'owner_after_recovery')
  uploadScope(token: string, raw: RatingCategoryIconUploadScopeInput) {
    const input = ratingCategoryIconUploadScopeSchema.parse(raw);
    return this.run(async (tx) => {
      const session = await this.enter(token, tx);
      let mutation: CategoryIconMutation | undefined;
      const scopes = new CategoryIconUploadScopes(
        {
          authorize: (actor, id, value, read) =>
            this.iconAuthority.authorize(actor, id, value, read, async () => {
              mutation = await beginCategoryIconMutation(read);
            }),
        },
        this.media.recovery,
      );
      const result = await scopes.create(
        session.accountId,
        session.sessionId,
        input,
        tx,
      );
      if (mutation) await finishCategoryIconMutation(mutation, tx);
      await this.access.recheck(token, tx);
      return result;
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  recoverUploadScope(
    token: string,
    input: CategoryIconUploadScopeRecoveryInput,
  ) {
    return this.run(async (tx) => {
      const session = await this.enter(token, tx),
        scopes = new CategoryIconUploadScopes(
          this.iconAuthority,
          this.media.recovery,
        );
      const result = await scopes.recover(session.accountId, input, tx);
      await this.access.recheck(token, tx);
      return result;
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  cancelUploadScope(
    token: string,
    input: CategoryIconUploadScopeRecoveryInput,
  ) {
    return this.run(async (tx) => {
      const session = await this.enter(token, tx),
        mutation = await beginCategoryIconMutation(tx),
        scopes = new CategoryIconUploadScopes(
          this.iconAuthority,
          this.media.recovery,
        );
      const result = await scopes.cancel(session.accountId, input, tx);
      await retainCategoryIconState(['global'], tx);
      await finishCategoryIconMutation(mutation, tx);
      await this.access.recheck(token, tx);
      return result;
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  recover(token: string, requestId: string) {
    return this.run(async (tx) => {
      const session = await this.enter(token, tx),
        row = (
          await tx.query<{ receipt: unknown }>(
            `SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2`,
            [session.accountId, requestId],
          )
        ).rows[0];
      if (!row?.receipt) throw new ApplicationError('REQUEST_NOT_FOUND');
      const receipt = C.ratingCategoryScopedReceiptSchema.parse(row.receipt);
      await this.access.recheck(token, tx);
      return receipt;
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  cancelByHash(token: string, raw: unknown) {
    const input = ratingCategoryIconRecoveryClosureSchema.parse(raw);
    return this.run(async (tx) => {
      const session = await this.enter(token, tx);
      await assertRatingCommandClaim(
        session.accountId,
        input.requestId,
        input.operation,
        input.intentHash,
        tx,
      );
      await tx.query(
        `INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [session.accountId, input.requestId, input.operation, input.intentHash],
      );
      const row = (
        await tx.query<{
          operation: string;
          intent_hash: string;
          receipt: unknown;
        }>(
          `SELECT operation,intent_hash,receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE`,
          [session.accountId, input.requestId],
        )
      ).rows[0]!;
      if (
        row.operation !== input.operation ||
        row.intent_hash !== input.intentHash
      )
        throw new ApplicationError('REQUEST_CONFLICT');
      if (row.receipt) {
        await this.access.recheck(token, tx);
        return C.ratingCategoryScopedReceiptSchema.parse(row.receipt);
      }
      const mutation = await beginCategoryIconMutation(tx);
      await tx.query(
        `INSERT INTO whaleu_ratings.category_icon_recovery_fences(actor_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)`,
        [session.accountId, input.requestId, input.operation, input.intentHash],
      );
      const receipt = C.ratingCategoryScopedReceiptSchema.parse({
        protocolVersion: 5,
        requestId: input.requestId,
        operation: input.operation,
        intentHash: input.intentHash,
        outcome: 'closed',
        code: 'RATING_CATEGORY_CANCELLED',
      });
      await tx.query(
        `UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2 AND receipt IS NULL`,
        [session.accountId, input.requestId, canonicalJson(receipt)],
      );
      await retainCategoryIconState(['global'], tx);
      await finishCategoryIconMutation(mutation, tx);
      await this.access.recheck(token, tx);
      return receipt;
    });
  }
  private async load(
    token: string,
    query: { contextId: string; contextToken: string },
    tx: PoolClient,
  ) {
    const session = await this.access.authenticate(token, tx),
      row = (
        await tx.query<{
          session_id: string;
          context: Record<string, unknown>;
          authority: Record<string, unknown>;
          valid_until: Date;
          record_digest: string;
          current: boolean;
        }>(
          `SELECT *,whaleu_ratings.scoped_context_current(id,$2,$3,clock_timestamp()) current FROM whaleu_ratings.scoped_contexts WHERE id=$1 AND account_id=$2 AND token_digest=$4 FOR SHARE`,
          [
            query.contextId,
            session.accountId,
            session.sessionId,
            createHash('sha256').update(query.contextToken).digest('hex'),
          ],
        )
      ).rows[0];
    if (
      !row?.current ||
      row.session_id !== session.sessionId ||
      row.context['purpose'] !== 'manage_categories' ||
      row.context['mode'] !== 'management' ||
      row.context['protocolVersion'] !== 5
    )
      throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
    const selector = row.context['selector'] as RatingNavigationSelector,
      { authority, domain } = await this.management(
        session.accountId,
        selector,
        tx,
      ),
      key = queryScope(selector),
      snapshot = await this.reader.snapshot(key, tx);
    if (
      snapshot.snapshotRevision !== row.context['managementSnapshot'] ||
      authority.fingerprint !== row.authority['authorizationFingerprint'] ||
      domain.inventoryFingerprint !== row.authority['inventoryFingerprint']
    )
      throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
    registerTransactionDeadline(
      tx,
      row.valid_until.getTime(),
      'RATING_SCOPED_CONTEXT_CHANGED',
    );
    const mediaSnapshot = await categoryIconSnapshot([key], tx);
    if (row.context['mediaSnapshot'] !== mediaSnapshot)
      throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
    return {
      session,
      row,
      selector,
      authority,
      domain,
      key,
      snapshot,
      mediaSnapshot,
    };
  }
  @AccountPolicy('privileged_read', 'entry')
  list(token: string, query: { contextId: string; contextToken: string }) {
    return this.run(async (tx) => {
      await this.enter(token, tx);
      const s = await this.load(token, query, tx);
      const roots = await this.icons.roots(
        tx,
        new RatingScopedCompilationBudget(),
      );
      await retainCategoryIconState([s.key], tx);
      const result = C.ratingManagedCategoriesSchema.parse({
        items: s.snapshot.categories
          .filter((r) => r.scopeKey === s.key)
          .map((r) => this.view(r, s.snapshot, roots)),
        mediaSnapshot: s.mediaSnapshot,
        snapshotRevision: s.snapshot.snapshotRevision,
        complete: true,
      });
      await retain([s.key], tx);
      await this.access.recheck(token, tx);
      return result;
    });
  }
  @AccountPolicy('privileged_read', 'entry')
  detail(
    token: string,
    query: { contextId: string; contextToken: string },
    id: string,
  ) {
    return this.run(async (tx) => {
      await this.enter(token, tx);
      const s = await this.load(token, query, tx),
        row = s.snapshot.categories.find(
          (r) => r.scopeKey === s.key && r.expected.body.id === id,
        );
      if (!row) throw new ApplicationError('RATING_NOT_FOUND');
      const roots = await this.icons.roots(
        tx,
        new RatingScopedCompilationBudget(),
      );
      await retainCategoryIconState([s.key], tx);
      const view = this.view(row, s.snapshot, roots);
      await retain([s.key], tx);
      await this.access.recheck(token, tx);
      return view;
    });
  }
  private view(
    row: import('./plan.js').ManagedCategoryRecord,
    snapshot: import('./plan.js').CategorySnapshot,
    roots: readonly import('./icon-references.js').CategoryIconRoot[],
  ) {
    const base = roots.find(
      (root) =>
        root.kind === 'base' &&
        root.categoryId === row.expected.body.id &&
        root.source.id === row.expected.baseSourceId &&
        root.source.revision === row.expected.baseSourceRevision,
    );
    const override =
      row.scopeKey === 'global'
        ? undefined
        : roots.find(
            (root) =>
              root.kind === 'override' &&
              root.categoryId === row.expected.body.id &&
              root.campusId === row.scopeKey.slice(7) &&
              root.baseSource.id === row.expected.baseSourceId &&
              root.baseSource.revision === row.expected.baseSourceRevision,
          );
    const state = (
      value:
        import('./icon-references.js').CategoryIconRoot['value'] | undefined,
    ) =>
      value?.kind === 'image'
        ? { state: 'image', appearanceId: value.appearance.appearanceId }
        : {
            state:
              value?.kind === 'absent'
                ? 'absent'
                : value?.kind === 'inherit'
                  ? 'inherit'
                  : 'unavailable',
            appearanceId: null,
          };
    const inherited = !override || override.value.kind === 'inherit';
    return ratingManagedCategoryIconSchema.parse({
      ...this.reader.view(row, snapshot),
      icon: {
        base: state(base?.value),
        override: {
          mode: inherited ? 'inherit' : 'set',
          state: inherited
            ? { state: 'inherit', appearanceId: null }
            : state(override.value),
        },
        effective: state(inherited ? base?.value : override.value),
      },
    });
  }
  @AccountPolicy('privileged_read', 'entry')
  systemOptions(
    token: string,
    query: { contextId: string; contextToken: string },
  ) {
    return this.run(async (tx) => {
      await this.enter(token, tx);
      const s = await this.load(token, query, tx);
      const items = s.authority.global
        ? s.snapshot.sources
            .filter(
              (r) =>
                r.source_kind === C.RATING_CATEGORY_SYSTEM_REGISTRY &&
                r.current &&
                r.payload['enabled'] === true &&
                r.payload['kind'] === 'general' &&
                r.payload['consumer'] === 'ratings_general_v1',
            )
            .map((r) => ({
              systemKey: r.payload['systemKey'],
              kind: r.payload['kind'],
              maximumDepth: r.payload['maximumDepth'],
              allowCampusOverride: r.payload['allowCampusOverride'] === true,
              allowDisable: r.payload['allowDisable'] === true,
            }))
        : [];
      await retain([s.key], tx);
      await this.access.recheck(token, tx);
      return C.ratingCategorySystemOptionsSchema.parse({ items });
    });
  }
  @AccountPolicy('privileged_read', 'entry')
  history(
    token: string,
    query: {
      contextId: string;
      contextToken: string;
      cursor?: string | undefined;
    },
    id: string,
  ) {
    return this.run(async (tx) => {
      await this.enter(token, tx);
      const s = await this.load(token, query, tx);
      if (
        !s.snapshot.categories.some(
          (r) => r.scopeKey === s.key && r.expected.body.id === id,
        )
      )
        throw new ApplicationError('RATING_NOT_FOUND');
      const rows = (
        await tx.query<{
          requestId: string;
          operation: string;
          outcome: string;
          releaseId: string | null;
          occurredAt: Date;
          cursor: string;
        }>(
          `SELECT whaleu_ratings.category_management_artifact(o.intent_hash,'category-history:'||o.account_id::text||':'||o.request_id::text) cursor,o.request_id "requestId",o.operation,o.outcome,o.result->>'releaseId' "releaseId",o.occurred_at "occurredAt" FROM whaleu_ratings.scoped_command_outcomes o JOIN whaleu_ratings.scoped_command_preparations p ON (p.account_id,p.request_id)=(o.account_id,o.request_id) WHERE p.command_family='category' AND p.category_plan->'categoryIds' @> to_jsonb(ARRAY[$1::text]) AND p.category_plan->'affectedScopeKeys' @> to_jsonb(ARRAY[$4::text]) AND ($2::uuid IS NULL OR (o.occurred_at,o.account_id,o.request_id)<(SELECT previous.occurred_at,previous.account_id,previous.request_id FROM whaleu_ratings.scoped_command_outcomes previous JOIN whaleu_ratings.scoped_command_preparations prior ON (prior.account_id,prior.request_id)=(previous.account_id,previous.request_id) WHERE whaleu_ratings.category_management_artifact(previous.intent_hash,'category-history:'||previous.account_id::text||':'||previous.request_id::text)=$2 AND prior.category_plan->'categoryIds' @> to_jsonb(ARRAY[$1::text]) AND prior.category_plan->'affectedScopeKeys' @> to_jsonb(ARRAY[$4::text]) AND previous.operation IN (SELECT jsonb_array_elements_text($3::jsonb)) LIMIT 1)) ORDER BY o.occurred_at DESC,o.account_id DESC,o.request_id DESC LIMIT 101`,
          [
            id,
            query.cursor ?? null,
            canonicalJson(C.ratingCategoryScopedOperations),
            s.key,
          ],
        )
      ).rows;
      await retain([s.key], tx);
      await this.access.recheck(token, tx);
      return C.ratingCategoryManagementHistorySchema.parse({
        items: rows.slice(0, 100).map(({ cursor: _cursor, ...r }) => ({
          ...r,
          occurredAt: r.occurredAt.toISOString(),
        })),
        nextCursor: rows.length > 100 ? rows[99]!.cursor : null,
      });
    });
  }
  private async claim(
    actor: string,
    i: C.RatingCategoryScopedIntent,
    tx: PoolClient,
    request = false,
  ) {
    const hash = C.ratingCategoryScopedIntentHash(i);
    await assertRatingCommandClaim(
      actor,
      i.payload.clientRequestId,
      i.operation,
      hash,
      tx,
    );
    if (request)
      await tx.query(
        'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [actor, i.payload.clientRequestId, i.operation, hash],
      );
    const old = (
      await tx.query<{
        operation: string;
        intent_hash: string;
        receipt: unknown;
      }>(
        `SELECT operation,intent_hash,receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE`,
        [actor, i.payload.clientRequestId],
      )
    ).rows[0];
    if (old && (old.operation !== i.operation || old.intent_hash !== hash))
      throw new ApplicationError('REQUEST_CONFLICT');
    return old?.receipt
      ? C.ratingCategoryScopedReceiptSchema.parse(old.receipt)
      : null;
  }
  private async prepared(actor: string, id: string, tx: PoolClient) {
    return (
      await tx.query<Prepared>(
        "SELECT p.*,ip.media_plan FROM whaleu_ratings.scoped_command_preparations p JOIN whaleu_ratings.category_icon_preparations ip ON (ip.actor_id,ip.request_id)=(p.account_id,p.request_id) WHERE p.account_id=$1 AND p.request_id=$2 AND p.command_family='category' FOR SHARE OF p,ip",
        [actor, id],
      )
    ).rows[0];
  }
  private preview(p: Prepared) {
    const plan = p.media_plan.plan,
      v = plan.textPlan;
    const state = (
      value:
        import('./icon-references.js').CategoryIconRoot['value'] | undefined,
    ) =>
      value?.kind === 'image'
        ? {
            state: 'image' as const,
            appearanceId: value.appearance.appearanceId,
          }
        : {
            state:
              value?.kind === 'absent'
                ? ('absent' as const)
                : value?.kind === 'inherit'
                  ? ('inherit' as const)
                  : ('unavailable' as const),
            appearanceId: null,
          };
    const iconChanges = plan.afterRoots.flatMap((root) => {
      const before = plan.beforeRoots.find(
        (old) =>
          old.categoryId === root.categoryId &&
          old.kind === root.kind &&
          (root.kind === 'base' ||
            (old.kind === 'override' && old.campusId === root.campusId)),
      );
      const first = state(before?.value),
        last = state(root.value);
      return canonicalJson(first) === canonicalJson(last)
        ? []
        : [
            {
              categoryId: root.categoryId,
              kind: root.kind,
              campusId: root.kind === 'base' ? null : root.campusId,
              before: first,
              after: last,
            },
          ];
    });
    return C.ratingCategoryScopedPreparationSchema.parse({
      protocolVersion: 5,
      mediaSnapshot: plan.beforeSnapshot,
      requestId: p.request_id,
      contextRevision: p.context_revision,
      categoryIds: plan.categoryIds,
      affectedScopeKeys: plan.affectedScopeKeys,
      changedSourceCount: v.sourceIssues.length,
      affectedTargetCount: v.affectedTargetCount,
      previewDigest: plan.digest,
      summary: `${plan.categoryIds.length} categories; ${plan.affectedScopeKeys.length} scopes; ${v.sourceIssues.length} exact source changes; ${iconChanges.length} icon changes`,
      changes: v.changes,
      changedIconCount: iconChanges.length,
      iconChanges,
      expiresAt: p.valid_until.toISOString(),
    });
  }
  private async plan(
    i: C.RatingCategoryScopedIntent,
    s: Awaited<ReturnType<RatingCategoryIconManagementService['load']>>,
    tx: PoolClient,
    budget: RatingScopedCompilationBudget,
    preparedUploads?: readonly CategoryIconTrustedUpload[],
  ) {
    const roots = await this.icons.roots(tx, budget);
    const uploads: CategoryIconTrustedUpload[] = [];
    for (const replacement of categoryIconReplacements(i)) {
      const row = (
        await tx.query<{
          id: string;
          scope_revision: string;
          expires_at: Date;
          input: unknown;
          category_id: string;
          identity_id: string;
          origin: CategoryIconTrustedUpload['origin'];
          current: boolean;
        }>(
          `SELECT u.*,whaleu_ratings.category_icon_upload_scope_current(u.id,$2,clock_timestamp()) current
         FROM whaleu_ratings.category_icon_upload_scopes u WHERE u.id=$1 AND u.actor_id=$2 AND u.command_request_id=$3 FOR SHARE`,
          [
            replacement.uploadScopeId,
            s.session.accountId,
            i.payload.clientRequestId,
          ],
        )
      ).rows[0];
      if (!row?.current) throw new ApplicationError('MEDIA_NOT_READY');
      const prior = preparedUploads?.find(
        (upload) =>
          upload.uploadScopeId === row.id &&
          upload.assetId === replacement.assetId,
      );
      const asset = preparedUploads
        ? prior
        : await this.media.assets.describeCategoryIconReady(
            {
              actor: s.session.accountId,
              scopeId: row.id,
              scopeRevision: row.scope_revision,
              expiresAt: row.expires_at.getTime(),
            },
            replacement.assetId,
            tx,
          );
      if (!asset) throw new ApplicationError('MEDIA_NOT_READY');
      uploads.push({
        uploadScopeId: row.id,
        scopeRevision: row.scope_revision,
        assetId: asset.assetId,
        manifestDigest: asset.manifestDigest,
        actorId: s.session.accountId,
        categoryId: row.category_id,
        identityId: row.identity_id,
        origin: row.origin,
        textHash: importTextHash(i),
        expiresAt: row.expires_at.getTime(),
      });
      registerTransactionDeadline(
        tx,
        row.expires_at.getTime(),
        'MEDIA_NOT_READY',
      );
    }
    const markedScopeKeys = (
      await tx.query<{ scope_key: string }>(
        `SELECT h.scope_key FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_releases r ON r.id=h.release_id WHERE r.cause->>'categoryIconExtension'='ratings-category-icon-v1' AND r.cause->>'categoryIconDigest' ~ '^[a-f0-9]{64}$' AND r.cause->'categoryIconScopeKeys' ? h.scope_key ORDER BY h.scope_key LIMIT 1002`,
      )
    ).rows.map((row) => row.scope_key);
    if (markedScopeKeys.length > 1001)
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const plan = planCategoryIconManagement(
      s.session.accountId,
      i,
      s.snapshot,
      { revision: s.mediaSnapshot, roots, markedScopeKeys },
      uploads,
      budget,
    );
    this.authority.require(
      s.authority,
      plan.affectedScopeKeys
        .filter((key) => key !== 'global')
        .map((key) => key.slice(7)),
      plan.globalRequired,
      tx,
    );
    await retainCategoryIconState(plan.affectedScopeKeys, tx);
    const protocolIds = (
      await tx.query<{ id: string }>(
        `SELECT DISTINCT p.id FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions p ON p.id=h.version_id
      WHERE h.logical_scope_key=ANY(ARRAY(SELECT coalesce(c.region_id::text,'global') FROM whaleu_ratings.scoped_catalog_heads current_head JOIN whaleu_ratings.scoped_catalogs c ON c.id=current_head.catalog_id WHERE current_head.scope_key=ANY($1::text[])))`,
        [plan.affectedScopeKeys],
      )
    ).rows.map((row) => row.id);
    requireCategoryIconCapabilities(
      await categoryIconCapabilities(protocolIds, plan.affectedScopeKeys, tx),
    );
    return plan;
  }
  private async reviewPlan(
    plan: CategoryIconPlan,
    s: Awaited<ReturnType<RatingCategoryIconManagementService['load']>>,
    tx: PoolClient,
    budget: RatingScopedCompilationBudget,
  ): Promise<Prepared['media_plan']> {
    const contents = plannedCategoryIconContents(plan, s.snapshot, budget);
    const coverage: Prepared['media_plan']['coverage'][number][] = [],
      fresh: CategoryIconContent[] = [];
    for (const content of contents) {
      const scope =
        content.selector.kind === 'global'
          ? 'global'
          : `campus:${content.selector.campusId}`;
      const candidates = (
        await tx.query<
          NonNullable<Prepared['media_plan']['coverage'][number]['binding']> & {
            content: CategoryIconContent;
          }
        >(
          `SELECT b.*,b.envelope->'content' content FROM whaleu_ratings.category_icon_review_bindings b WHERE b.id IN (
         SELECT p.review_binding_id FROM whaleu_ratings.scoped_catalog_heads h
         JOIN whaleu_ratings.category_icon_projections p ON p.catalog_id=h.catalog_id AND p.release_id=h.release_id
         WHERE h.scope_key=$1 AND p.category_id=$2 AND p.projection->'content'=$3::jsonb
         UNION
         SELECT head.review_binding_id FROM whaleu_ratings.scoped_catalog_heads h
         JOIN whaleu_ratings.category_icon_release_manifests m ON m.release_id=h.release_id
         JOIN LATERAL jsonb_array_elements(m.management_coverage) entry ON entry->>'scopeKey'=h.scope_key
         JOIN whaleu_ratings.category_icon_management_review_heads head ON head.root_definition_id=(entry->'content'->'icon'->>'definitionId')::uuid AND head.selector=entry->'content'->'selector' AND head.review_binding_id=(entry->'review'->>'id')::uuid
         WHERE h.scope_key=$1 AND entry->>'categoryId'=$2::text AND entry->'content'=$3::jsonb
         ) ORDER BY b.id LIMIT 2`,
          [scope, content.categoryId, canonicalJson(content)],
        )
      ).rows;
      if (candidates.length > 1)
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      const row = candidates[0];
      if (
        row &&
        canonicalJson(row.content) === canonicalJson(content) &&
        row.definition_digest === categoryIconContentDigest(content)
      ) {
        const current = await this.iconReview.current(
          {
            definitionId: row.definition_id,
            definitionDigest: row.definition_digest,
            envelope: row.envelope,
          },
          tx,
        );
        if (current.kind !== 'allow')
          throw new ApplicationError(
            current.kind === 'deny'
              ? 'CONTENT_REJECTED'
              : 'CONTENT_REVIEW_UNAVAILABLE',
          );
        coverage.push({
          content,
          binding: {
            id: row.id,
            definition_id: row.definition_id,
            definition_digest: row.definition_digest,
            approval_digest: row.approval_digest,
            envelope: row.envelope,
          },
        });
      } else {
        coverage.push({ content, binding: null });
        fresh.push(content);
      }
    }
    const context = {
      id: String(s.row.context['id']),
      digest: s.row.record_digest,
      protocolGeneration: String(s.row.context['protocolGeneration']),
      topologySnapshotId: s.domain.topologySnapshotId,
      sourceDigest: String(s.row.context['sourceDigest']),
    };
    const mediaPlan = {
      plan,
      coverage,
      reviewEnvelopes: plannedCategoryIconEnvelopes(plan, fresh, context),
    };
    budget.observe({ categoryIconPreparedReview: mediaPlan });
    return mediaPlan;
  }
  @AccountPolicy('content_management', 'owner_after_recovery')
  prepare(token: string, raw: C.RatingCategoryScopedIntent) {
    const i = C.ratingCategoryScopedIntentSchema.parse(raw);
    return this.run(async (tx) => {
      const session = await this.enter(token, tx),
        prior = await this.claim(session.accountId, i, tx);
      if (prior) {
        await this.access.recheck(token, tx);
        return prior;
      }
      const s = await this.load(
        token,
        { contextId: i.context.id, contextToken: i.context.token },
        tx,
      );
      this.intentContext(i, s);
      const mutation = await beginCategoryIconMutation(tx),
        budget = new RatingScopedCompilationBudget();
      const old = await this.prepared(
        session.accountId,
        i.payload.clientRequestId,
        tx,
      );
      const plan = await this.plan(i, s, tx, budget),
        mediaPlan = await this.reviewPlan(plan, s, tx, budget);
      if (old) {
        if (
          old.intent_hash !== C.ratingCategoryScopedIntentHash(i) ||
          old.session_id !== session.sessionId ||
          old.valid_until.getTime() <= Date.now() ||
          canonicalJson(mediaPlan) !== canonicalJson(old.media_plan)
        )
          throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
        registerTransactionDeadline(
          tx,
          old.valid_until.getTime(),
          'RATING_SCOPED_CONTEXT_CHANGED',
        );
        await finishCategoryIconMutation(mutation, tx);
        await retain(plan.affectedScopeKeys, tx);
        await this.access.recheck(token, tx);
        return this.preview(old);
      }
      const expiry = new Date(
          Math.min(
            s.row.valid_until.getTime(),
            Date.parse(plan.textPlan.validUntil),
            ...plan.uploads.map((upload) => upload.expiresAt),
          ),
        ),
        contextRevision = randomBytes(32).toString('base64url');
      registerTransactionDeadline(
        tx,
        expiry.getTime(),
        'RATING_SCOPED_CONTEXT_CHANGED',
      );
      const before = (
        await tx.query<{ heads: unknown; vector: unknown; compat: unknown }>(
          `SELECT whaleu_ratings.category_management_heads($1::text[]) heads,
        whaleu_ratings.scoped_current_source_vector($1::text[]) vector,whaleu_ratings.category_management_compat_heads($1::text[]) compat`,
          [plan.affectedScopeKeys],
        )
      ).rows[0]!;
      await tx.query(
        `INSERT INTO whaleu_ratings.category_icon_preparations(actor_id,request_id,outer_hash,text_hash,text_intent,media_plan,plan_digest,before_snapshot,affected_scope_keys,before_heads,before_vector,before_compat_heads,noop)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9::text[],$10::jsonb,$11::jsonb,$12::jsonb,$13)`,
        [
          session.accountId,
          i.payload.clientRequestId,
          plan.outerHash,
          plan.textHash,
          canonicalJson(categoryIconTextIntent(i)),
          canonicalJson(mediaPlan),
          plan.digest,
          plan.beforeSnapshot,
          plan.affectedScopeKeys,
          canonicalJson(before.heads),
          canonicalJson(before.vector),
          canonicalJson(before.compat),
          plan.noop,
        ],
      );
      const p = (
        await tx.query<Omit<Prepared, 'media_plan'>>(
          `INSERT INTO whaleu_ratings.scoped_command_preparations(account_id,request_id,operation,intent_hash,intent,context_id,session_id,context_revision,before_state,envelope,policy_source_id,policy_source_revision,valid_until,command_family,category_plan)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,NULL,$10,$11,$12,'category',$13::jsonb) RETURNING *`,
          [
            session.accountId,
            i.payload.clientRequestId,
            i.operation,
            plan.outerHash,
            canonicalJson(i),
            i.context.id,
            session.sessionId,
            contextRevision,
            canonicalJson({
              heads: plan.textPlan.beforeHeads,
              vector: plan.textPlan.beforeVector,
              digest: plan.textPlan.beforeDigest,
            }),
            plan.textPlan.policySourceId,
            plan.textPlan.policySourceRevision,
            expiry,
            canonicalJson(plan.textPlan),
          ],
        )
      ).rows[0]!;
      await finishCategoryIconMutation(mutation, tx);
      await retain(plan.affectedScopeKeys, tx);
      await this.access.recheck(token, tx);
      return this.preview({ ...p, media_plan: mediaPlan });
    });
  }
  private intentContext(
    i: C.RatingCategoryScopedIntent,
    s: Awaited<ReturnType<RatingCategoryIconManagementService['load']>>,
  ) {
    const stored = s.row.context;
    const picked = Object.fromEntries(
      Object.keys(i.context).map((k) => [
        k,
        k === 'token' ? i.context.token : stored[k],
      ]),
    );
    if (
      canonicalJson(i.context) !== canonicalJson(picked) ||
      i.payload.expectedSnapshot !== s.snapshot.snapshotRevision ||
      i.mediaSnapshot !== s.mediaSnapshot
    )
      throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
  }
  private async outcome(
    actor: string,
    i: C.RatingCategoryScopedIntent,
    value:
      | { outcome: 'applied' | 'noop'; result: unknown }
      | { outcome: 'closed'; code: string },
    tx: PoolClient,
  ) {
    const hash = C.ratingCategoryScopedIntentHash(i),
      receipt = C.ratingCategoryScopedReceiptSchema.parse({
        protocolVersion: 5,
        requestId: i.payload.clientRequestId,
        operation: i.operation,
        intentHash: hash,
        ...value,
      });
    await tx.query(
      `INSERT INTO whaleu_ratings.scoped_command_outcomes(account_id,request_id,operation,intent_hash,intent,outcome,result,code) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)`,
      [
        actor,
        i.payload.clientRequestId,
        i.operation,
        hash,
        canonicalJson(i),
        value.outcome,
        'result' in value ? canonicalJson(value.result) : null,
        'code' in value ? value.code : null,
      ],
    );
    await tx.query(
      'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2 AND receipt IS NULL',
      [actor, i.payload.clientRequestId, canonicalJson(receipt)],
    );
    return receipt;
  }
  @AccountPolicy('content_management', 'owner_after_recovery')
  commit(
    token: string,
    raw: {
      intent: C.RatingCategoryScopedIntent;
      preparationContextRevision: string;
    },
  ) {
    const input = C.ratingCategoryScopedCommitSchema.parse(raw),
      i = input.intent;
    return this.run(async (tx) => {
      const session = await this.enter(token, tx, true),
        prior = await this.claim(session.accountId, i, tx, true);
      if (prior) {
        await this.access.recheck(token, tx);
        return prior;
      }
      const checkpoint = checkpointTransactionDeadlines(tx);
      await tx.query('SAVEPOINT category_icon_management');
      let receipt: C.RatingCategoryScopedReceipt;
      try {
        const p = await this.prepared(
          session.accountId,
          i.payload.clientRequestId,
          tx,
        );
        if (
          !p ||
          p.context_revision !== input.preparationContextRevision ||
          p.intent_hash !== C.ratingCategoryScopedIntentHash(i) ||
          canonicalJson(p.intent) !== canonicalJson(i) ||
          p.session_id !== session.sessionId ||
          p.valid_until.getTime() <= Date.now()
        )
          throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
        const s = await this.load(
          token,
          { contextId: i.context.id, contextToken: i.context.token },
          tx,
        );
        this.intentContext(i, s);
        const mutation = await beginCategoryIconMutation(tx),
          budget = new RatingScopedCompilationBudget(),
          plan = await this.plan(i, s, tx, budget, p.media_plan.plan.uploads);
        if (canonicalJson(plan) !== canonicalJson(p.media_plan.plan))
          throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
        const mediaPlan = await this.reviewPlan(plan, s, tx, budget);
        if (canonicalJson(mediaPlan) !== canonicalJson(p.media_plan))
          throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
        registerTransactionDeadline(
          tx,
          p.valid_until.getTime(),
          'RATING_SCOPED_CONTEXT_CHANGED',
        );
        const domains = await this.campus.resolveCategoryManagementDomains(
          { accountId: session.accountId },
          plan.affectedScopeKeys.map((key) =>
            key === 'global'
              ? ({ kind: 'global' } as const)
              : ({ kind: 'campus', campusId: key.slice(7) } as const),
          ),
          s.authority,
          tx,
        );
        await tx.query(
          `INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof) VALUES($1,$2,'category_execution',$3,$3,$4::jsonb)`,
          [
            session.accountId,
            p.request_id,
            i.context.id,
            canonicalJson({
              intentHash: plan.outerHash,
              textHash: plan.textHash,
              planDigest: plan.textPlan.previewDigest,
              mediaPlanDigest: plan.digest,
              contextRevision: p.context_revision,
              executionDigest: ratingScopedDigest('category-icon-execution', {
                accountId: session.accountId,
                requestId: p.request_id,
                intentHash: plan.outerHash,
                textHash: plan.textHash,
                mediaPlanDigest: plan.digest,
              }),
            }),
          ],
        );
        let releaseId: string | null = null,
          mediaReleaseDigest: string | null = null;
        let heads = (
          await tx.query<{
            heads: {
              scopeKey: string;
              catalogRevision: string;
              headRevision: string;
            }[];
          }>(
            `SELECT before_heads heads FROM whaleu_ratings.category_icon_preparations WHERE actor_id=$1 AND request_id=$2`,
            [session.accountId, p.request_id],
          )
        ).rows[0]!.heads;
        if (!plan.noop) {
          // All original owner domains are authorized before Media locks. Ready
          // metadata from prepare is reaccepted here, never reused as authority.
          const mediaMutation =
            await this.media.assets.prepareCategoryIconMutation(
              session.accountId,
              plan.newAppearances.map((appearance) => appearance.assetId),
              null,
              tx,
            );
          const approvals = [];
          for (const envelope of mediaPlan.reviewEnvelopes)
            approvals.push(await this.iconReview.accepted(envelope, tx));
          await this.issuer.issue(plan.textPlan, tx);
          for (const appearance of plan.newAppearances) {
            const upload = plan.uploads.find(
              (candidate) => candidate.assetId === appearance.assetId,
            )!;
            const accepted = await this.media.assets.acceptCategoryIconOwned(
              {
                actor: session.accountId,
                scopeId: upload.uploadScopeId,
                scopeRevision: upload.scopeRevision,
                expiresAt: upload.expiresAt,
              },
              appearance.assetId,
              mediaMutation,
              tx,
            );
            const binding = await this.media.assets.bindCategoryIcon(
              accepted,
              {
                ownerKind: 'ratings',
                resourceKind: 'category_icon',
                resourceId: appearance.appearanceId,
                contentVersion: 1,
              },
              mediaMutation,
              tx,
            );
            await tx.query(
              `INSERT INTO whaleu_ratings.category_icon_appearances(id,category_id,identity_id,actor_id,asset_id,media_binding_id,manifest_digest,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
              [
                appearance.appearanceId,
                appearance.categoryId,
                appearance.identityId,
                appearance.actorId,
                appearance.assetId,
                binding,
                appearance.manifestDigest,
                canonicalJson(appearance.origin),
              ],
            );
          }
          await this.icons.applyRoots(plan, tx);
          await this.retirement.enqueue(plan, tx);
          const fresh = new Map<
            string,
            { id: string; definitionDigest: string; approvalDigest: string }
          >();
          for (const [index, envelope] of mediaPlan.reviewEnvelopes.entries()) {
            const binding = await this.iconReview.bind(
              approvals[index]!,
              {
                definitionId: envelope.definitionId,
                definitionDigest: envelope.definitionDigest,
                envelope,
              },
              tx,
            );
            fresh.set(envelope.definitionDigest, {
              id: binding.id,
              definitionDigest: binding.definition_digest,
              approvalDigest: binding.approval_digest,
            });
          }
          const coverage: CategoryIconReleaseCoverage[] =
            mediaPlan.coverage.map((item) => ({
              scopeKey:
                item.content.selector.kind === 'global'
                  ? 'global'
                  : `campus:${item.content.selector.campusId}`,
              categoryId: item.content.categoryId,
              content: item.content,
              review: item.binding
                ? {
                    id: item.binding.id,
                    definitionDigest: item.binding.definition_digest,
                    approvalDigest: item.binding.approval_digest,
                  }
                : fresh.get(categoryIconContentDigest(item.content))!,
            }));
          await this.media.assets.finishCategoryIconMutation(mediaMutation, tx);
          const release = await this.releases.publishMany(
            domains,
            {
              kind: 'category_icon_management',
              accountId: session.accountId,
              requestId: p.request_id,
            },
            tx,
            { roots: plan.afterRoots, coverage, budget },
          );
          releaseId = release.releaseId;
          mediaReleaseDigest = release.mediaReleaseDigest ?? null;
          if (!mediaReleaseDigest)
            throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
          heads = release.outputs.map((output) => ({
            scopeKey: output.scopeKey,
            catalogRevision: output.id,
            headRevision: output.headRevision,
          }));
          await tx.query(
            `INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof) VALUES($1,$2,'category_release',$3,$3,$4::jsonb)`,
            [
              session.accountId,
              p.request_id,
              releaseId,
              canonicalJson({
                intentHash: plan.outerHash,
                textHash: plan.textHash,
                planDigest: plan.textPlan.previewDigest,
                mediaPlanDigest: plan.digest,
                mediaReleaseDigest,
                heads,
              }),
            ],
          );
        }
        const occurredAt = (
          await tx.query<{ at: Date }>('SELECT clock_timestamp() at')
        ).rows[0]!.at.toISOString();
        receipt = await this.outcome(
          session.accountId,
          i,
          {
            outcome: plan.noop ? 'noop' : 'applied',
            result: {
              releaseId,
              mediaReleaseDigest,
              categoryIds: plan.categoryIds,
              heads,
              occurredAt,
            },
          },
          tx,
        );
        await finishCategoryIconMutation(mutation, tx);
        await retain(plan.affectedScopeKeys, tx);
        await tx.query('RELEASE SAVEPOINT category_icon_management');
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          !C.ratingCategoryScopedReceiptSchema.options[1].shape.code.safeParse(
            error.code,
          ).success
        )
          throw error;
        await tx.query('ROLLBACK TO SAVEPOINT category_icon_management');
        restoreTransactionDeadlines(tx, checkpoint);
        receipt = await this.outcome(
          session.accountId,
          i,
          { outcome: 'closed', code: error.code },
          tx,
        );
      }
      await this.access.recheck(token, tx);
      return receipt;
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  cancel(token: string, raw: C.RatingCategoryScopedIntent) {
    const i = C.ratingCategoryScopedIntentSchema.parse(raw);
    return this.run(async (tx) => {
      const session = await this.enter(token, tx),
        prior = await this.claim(session.accountId, i, tx, true),
        receipt =
          prior ??
          (await this.outcome(
            session.accountId,
            i,
            { outcome: 'closed', code: 'RATING_CATEGORY_CANCELLED' },
            tx,
          ));
      await this.access.recheck(token, tx);
      return receipt;
    });
  }
}
