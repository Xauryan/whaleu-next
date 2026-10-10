import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  registerTransactionDeadline,
} from '../../database/transaction-deadlines.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import {
  canonicalRatingScopedEnvelope,
  type RatingScopedEnvelope,
} from '../../community/content-review/rating-scoped-contracts.js';
import { RatingScopedContentReviewFacade } from '../../community/content-review/rating-scoped-content-review.facade.js';
import { ApplicationError } from '../../http/application-error.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { AuthorDisplayService } from '../../profile/author-display.service.js';
import { RatingsAccessService } from '../access.js';
import { RatingsRepository, ratingIso } from '../repository.js';
import { RatingDiscussionRepository } from '../discussion-repository.js';
import { RatingDiscussionProjection } from '../discussion-projection.js';
import { RatingLikesRepository } from '../likes/repository.js';
import { RatingSubscriptionsRepository } from '../subscriptions/repository.js';
import { RatingEffectsCapture } from '../effects/capture.js';
import { assertRatingCommandClaim } from '../management/requests.js';
import {
  RatingScopedContextService,
  type ResolvedRatingScope,
} from './context.service.js';
import { RatingScopedRepository } from './repository.js';
import { RatingScopedSourceFacade } from './source.facade.js';
import { RatingScopedReleaseRepository } from './release.repository.js';
import {
  ratingScopedIntentSchema,
  ratingScopedReceiptSchema,
  ratingScopedPreparationSchema,
  ratingScopedClosureSchema,
  type RatingScopedIntent,
  type RatingScopedReceipt,
} from './contracts.js';
import { ratingScopedCommandHash } from './protocol-registry.js';
interface Preparation {
  account_id: string;
  request_id: string;
  operation: RatingScopedIntent['operation'];
  intent_hash: string;
  intent: RatingScopedIntent;
  context_id: string;
  session_id: string;
  context_revision: string;
  target_id: string;
  subject_id: string;
  target_revision: string;
  subject_revision: string;
  definition_revision: string;
  content_version: number;
  before_state: Record<string, unknown>;
  envelope: RatingScopedEnvelope | null;
  policy_source_id: string | null;
  policy_source_revision: string | null;
  valid_until: Date;
}
/** Stable identifiers allow an approval owner to reconstruct the exact v5 content
 * envelope without a second content-preparation protocol or mutable retry bytes. */
export function ratingScopedArtifactId(hash: string, kind: string): string {
  const b = createHash('sha256')
    .update(`whaleu:rating-scoped-artifact:v1\n${hash}\n${kind}`)
    .digest()
    .subarray(0, 16);
  b[6] = (b[6]! & 15) | 64;
  b[8] = (b[8]! & 63) | 128;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
@Injectable()
export class RatingScopedCommands {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingScopedContextService)
    private readonly contexts: RatingScopedContextService,
    @Inject(RatingScopedRepository)
    private readonly scoped: RatingScopedRepository,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingDiscussionRepository)
    private readonly replies: RatingDiscussionRepository,
    @Inject(RatingDiscussionProjection)
    private readonly discussion: RatingDiscussionProjection,
    @Inject(RatingLikesRepository)
    private readonly likes: RatingLikesRepository,
    @Inject(RatingSubscriptionsRepository)
    private readonly subscriptions: RatingSubscriptionsRepository,
    @Inject(RatingEffectsCapture)
    private readonly effects: RatingEffectsCapture,
    @Inject(AuthorDisplayService)
    private readonly authors: AuthorDisplayService,
    @Inject(RatingScopedContentReviewFacade)
    private readonly review: RatingScopedContentReviewFacade,
    @Inject(RatingScopedSourceFacade)
    private readonly sources: RatingScopedSourceFacade,
    @Inject(RatingScopedReleaseRepository)
    private readonly releases: RatingScopedReleaseRepository,
  ) {}
  private async enter(token: string, tx: PoolClient) {
    await lockSafetyPolicy(tx, true);
    await tx.query("SET LOCAL statement_timeout='5s'");
    this.records.enable(tx);
    this.scoped.enable(tx);
    return this.access.authenticate(token, tx);
  }
  private async request(actor: string, i: RatingScopedIntent, tx: PoolClient) {
    const hash = ratingScopedCommandHash(i);
    await assertRatingCommandClaim(
      actor,
      i.payload.clientRequestId,
      i.operation,
      hash,
      tx,
    );
    await tx.query(
      'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [actor, i.payload.clientRequestId, i.operation, hash],
    );
    const q = (
      await tx.query<{
        operation: string;
        intent_hash: string;
        receipt: unknown;
      }>(
        'SELECT operation,intent_hash,receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',
        [actor, i.payload.clientRequestId],
      )
    ).rows[0]!;
    if (q.operation !== i.operation || q.intent_hash !== hash)
      throw new ApplicationError('REQUEST_CONFLICT');
    return q.receipt === null
      ? null
      : ratingScopedReceiptSchema.parse(q.receipt);
  }
  private async preparation(actor: string, id: string, tx: PoolClient) {
    return (
      await tx.query<Preparation>(
        'SELECT * FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2 FOR SHARE',
        [actor, id],
      )
    ).rows[0];
  }
  private async scope(token: string, i: RatingScopedIntent, tx: PoolClient) {
    const s = await this.contexts.resolve(
      token,
      { contextId: i.context.id, contextToken: i.context.token },
      tx,
      {
        purpose:
          i.operation === 'create_target_scoped'
            ? 'create_target'
            : i.operation === 'edit_target_scoped'
              ? 'edit_target'
              : 'interact',
        write: true,
      },
    );
    if (
      canonicalJson(i.context) !==
      canonicalJson({
        id: s.context.id,
        tokenDigest: s.context.tokenDigest,
        token: s.context.token,
        selector: s.context.selector,
        scopeRevision: s.scopeRevision,
        protocolGeneration: s.protocolGeneration,
        catalogRevision: s.catalogRevision,
        headRevision: s.headRevision,
        sourceDigest: s.sourceDigest,
      })
    )
      throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
    return s;
  }
  private async makePreparation(
    token: string,
    i: RatingScopedIntent,
    tx: PoolClient,
  ) {
    const scope = await this.scope(token, i, tx),
      actor = scope.actor,
      hash = ratingScopedCommandHash(i),
      old = await this.preparation(actor, i.payload.clientRequestId, tx);
    if (old) {
      if (
        old.intent_hash !== hash ||
        canonicalJson(old.intent) !== canonicalJson(i) ||
        old.session_id !== scope.session.sessionId
      )
        throw new ApplicationError('REQUEST_CONFLICT');
      return { p: old, scope };
    }
    const cat = await this.scoped.category(
      scope,
      i.payload['categoryId'],
      tx,
      true,
    );
    if (cat.revision !== i.payload.expectedCategoryRevision)
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    const target =
      i.operation === 'create_target_scoped'
        ? null
        : await this.scoped.target(scope, i.payload.targetId, tx, true);
    if (
      target &&
      (target.row.revision !==
        ('expectedTargetRevision' in i.payload
          ? i.payload.expectedTargetRevision
          : null) ||
        target.category.id !== cat.id)
    )
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    if (
      i.operation === 'edit_target_scoped' &&
      (target!.row.creator_id !== actor ||
        target!.row.definition.definitionRevision !==
          i.payload.expectedDefinitionRevision ||
        target!.row.definition.contentVersion !==
          i.payload.expectedContentVersion ||
        cat.kind !== 'general')
    )
      throw new ApplicationError('RATING_NOT_FOUND');
    const policy =
      i.operation === 'create_target_scoped'
        ? await this.sources.requireCreationPolicy(scope.catalog.scopeKey, tx)
        : null;
    if (
      policy &&
      (cat.kind !== 'general' ||
        policy.payload['genericKind'] !== cat.kind ||
        policy.payload['enabled'] !== true)
    )
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const targetId = target?.row.id ?? ratingScopedArtifactId(hash, 'target'),
      targetRevision =
        i.operation === 'create_target_scoped' ||
        i.operation === 'edit_target_scoped'
          ? ratingScopedArtifactId(hash, 'target-revision')
          : target!.row.revision,
      subjectId = ratingScopedArtifactId(hash, 'subject'),
      subjectRevision = ratingScopedArtifactId(hash, 'subject-revision'),
      definitionRevision =
        i.operation === 'create_target_scoped'
          ? targetRevision
          : i.operation === 'edit_target_scoped'
            ? ratingScopedArtifactId(hash, 'definition')
            : target!.row.definition.definitionRevision,
      contentVersion =
        i.operation === 'create_target_scoped'
          ? 1
          : i.operation === 'edit_target_scoped'
            ? target!.row.definition.contentVersion + 1
            : target!.row.definition.contentVersion;
    let root = null,
      parent = null;
    if ('rootId' in i.payload) {
      root = await this.records.comment(i.payload.rootId, targetId, tx, true);
      if (
        root.revision !==
          ('expectedRootRevision' in i.payload
            ? i.payload.expectedRootRevision
            : i.payload.expectedRevision) ||
        !(await this.discussion.content(
          root,
          'comment',
          actor,
          'rating_direct',
          tx,
        )) ||
        !(await this.discussion.canReply(root, actor, tx))
      )
        throw new ApplicationError('RATING_NOT_FOUND');
    }
    if (i.operation === 'create_reply_scoped' && i.payload.replyTo) {
      parent = await this.replies.reply(
        i.payload.replyTo.replyId,
        i.payload.rootId,
        targetId,
        tx,
        true,
      );
      if (
        parent.revision !== i.payload.replyTo.expectedRevision ||
        !(await this.discussion.content(
          parent,
          'reply',
          actor,
          'rating_direct',
          tx,
        ))
      )
        throw new ApplicationError('RATING_NOT_FOUND');
    }
    if (i.operation === 'set_reply_like_scoped') {
      parent = await this.replies.reply(
        i.payload.replyId,
        i.payload.rootId,
        targetId,
        tx,
        true,
      );
      if (
        parent.revision !== i.payload.expectedRevision ||
        !(await this.discussion.content(
          parent,
          'reply',
          actor,
          'rating_direct',
          tx,
        ))
      )
        throw new ApplicationError('RATING_NOT_FOUND');
    }
    const origin =
      target?.row.envelope.version === 5
        ? target.row.envelope.targetOrigin
        : {
            regionId: target
              ? target.row.region_id
              : (scope.campusProof.origin?.regionId ?? null),
            originCampusId: target
              ? null
              : (scope.campusProof.identity?.campusId ?? null),
          };
    const base = {
      version: 5,
      accountId: actor,
      clientRequestId: i.payload.clientRequestId,
      targetId,
      targetRevision,
      categoryId: cat.id,
      categoryRevision: cat.revision,
      scope: {
        selector: scope.selector,
        scopeKey: scope.catalog.scopeKey,
        catalogRevision: scope.catalogRevision,
        headRevision: scope.headRevision,
        scopeRevision: scope.scopeRevision,
        contextId: scope.contextId,
        contextDigest: scope.context.tokenDigest,
        protocolGeneration: scope.protocolGeneration,
        sourceDigest: scope.sourceDigest,
        topologySnapshotId: scope.campusProof.topologySnapshotId,
      },
      targetOrigin: origin,
      assetIds: [],
    };
    let envelope: RatingScopedEnvelope | null = null;
    if (
      i.operation === 'create_target_scoped' ||
      i.operation === 'edit_target_scoped'
    )
      envelope = canonicalRatingScopedEnvelope({
        ...base,
        purpose:
          i.operation === 'create_target_scoped'
            ? 'publish_rating_target_scoped'
            : 'edit_rating_target_scoped',
        definitionRevision,
        contentVersion,
        name: i.payload.name,
        description: i.payload.description,
        ...(i.operation === 'edit_target_scoped'
          ? {
              previousTargetRevision: target!.row.revision,
              previousDefinitionRevision:
                target!.row.definition.definitionRevision,
            }
          : {}),
      });
    if (
      i.operation === 'create_comment_scoped' ||
      i.operation === 'create_reply_scoped'
    )
      envelope = canonicalRatingScopedEnvelope({
        ...base,
        purpose:
          i.operation === 'create_comment_scoped'
            ? 'publish_rating_comment_scoped'
            : 'publish_rating_reply_scoped',
        subjectId,
        subjectRevision,
        targetDefinitionRevision: target!.row.definition.definitionRevision,
        targetContentVersion: target!.row.definition.contentVersion,
        body: i.payload.body,
        authorMode: i.payload.authorMode,
        ...(i.operation === 'create_reply_scoped'
          ? {
              rootId: root!.id,
              rootRevision: root!.revision,
              replyTo: parent
                ? { replyId: parent.id, revision: parent.revision }
                : null,
            }
          : {}),
      });
    const beforeState = {
      target: target
        ? {
            id: target.row.id,
            revision: target.row.revision,
            creatorId: target.row.creator_id,
            regionId: target.row.region_id,
            categoryId: target.row.category_id,
            definitionRevision: target.row.definition.definitionRevision,
            contentVersion: target.row.definition.contentVersion,
          }
        : null,
      definition: target?.row.definition ?? null,
      name: target?.row.name ?? null,
      description: target?.row.description ?? null,
      root: root ? { id: root.id, revision: root.revision } : null,
      parent: parent ? { id: parent.id, revision: parent.revision } : null,
      origin,
    };
    const p = (
      await tx.query<Preparation>(
        `INSERT INTO whaleu_ratings.scoped_command_preparations(account_id,request_id,operation,intent_hash,intent,context_id,session_id,context_revision,target_id,subject_id,target_revision,subject_revision,definition_revision,content_version,before_state,envelope,policy_source_id,policy_source_revision,valid_until) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,least($19::timestamptz,clock_timestamp()+interval '5 minutes')) RETURNING *`,
        [
          actor,
          i.payload.clientRequestId,
          i.operation,
          hash,
          canonicalJson(i),
          scope.contextId,
          scope.session.sessionId,
          randomBytes(32).toString('base64url'),
          targetId,
          subjectId,
          targetRevision,
          subjectRevision,
          definitionRevision,
          contentVersion,
          canonicalJson(beforeState),
          envelope ? canonicalJson(envelope) : null,
          policy?.id ?? null,
          policy?.revision ?? null,
          scope.context.expiresAt,
        ],
      )
    ).rows[0]!;
    return { p, scope };
  }
  prepare(token: string, raw: RatingScopedIntent) {
    const i = ratingScopedIntentSchema.parse(raw);
    return this.db.transaction(
      async (tx) => {
        const session = await this.enter(token, tx);
        await assertRatingCommandClaim(
          session.accountId,
          i.payload.clientRequestId,
          i.operation,
          ratingScopedCommandHash(i),
          tx,
        );
        const old = (
          await tx.query<{ receipt: unknown }>(
            'SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
            [session.accountId, i.payload.clientRequestId],
          )
        ).rows[0]?.receipt;
        if (old) {
          await this.access.recheck(token, tx);
          return ratingScopedReceiptSchema.parse(old);
        }
        const { p } = await this.makePreparation(token, i, tx);
        await this.access.recheck(token, tx);
        return ratingScopedPreparationSchema.parse({
          intent: p.intent,
          contextRevision: p.context_revision,
          targetId: p.target_id,
          targetRevision: p.target_revision,
          definitionRevision: p.definition_revision,
          contentVersion: p.content_version,
          validUntil: p.valid_until.toISOString(),
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
  private async outcome(
    actor: string,
    i: RatingScopedIntent,
    value:
      | { outcome: 'applied' | 'noop'; result: unknown }
      | { outcome: 'closed'; code: string },
    tx: PoolClient,
  ) {
    const hash = ratingScopedCommandHash(i),
      receipt = ratingScopedReceiptSchema.parse({
        protocolVersion: 2,
        requestId: i.payload.clientRequestId,
        operation: i.operation,
        intentHash: hash,
        ...value,
      });
    await tx.query(
      'INSERT INTO whaleu_ratings.scoped_command_outcomes(account_id,request_id,operation,intent_hash,intent,outcome,result,code) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)',
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
      'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
      [actor, i.payload.clientRequestId, canonicalJson(receipt)],
    );
    return receipt;
  }
  status(token: string, requestId: string) {
    return this.db.transaction(
      async (tx) => {
        const session = await this.access.authenticate(token, tx),
          r = (
            await tx.query<{ receipt: unknown }>(
              `SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2 AND whaleu_ratings.rating_scoped_operation_rule(operation,2) IS NOT NULL`,
              [session.accountId, requestId],
            )
          ).rows[0];
        if (!r?.receipt) throw new ApplicationError('REQUEST_NOT_FOUND');
        const result = ratingScopedReceiptSchema.parse(r.receipt);
        await this.access.recheck(token, tx);
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }
  cancel(token: string, raw: RatingScopedIntent) {
    const i = ratingScopedIntentSchema.parse(raw);
    if (
      i.operation !== 'create_target_scoped' &&
      i.operation !== 'edit_target_scoped'
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    return this.db.transaction(
      async (tx) => {
        const session = await this.enter(token, tx),
          prior = await this.request(session.accountId, i, tx);
        const receipt =
          prior ??
          (await this.outcome(
            session.accountId,
            i,
            {
              outcome: 'closed',
              code:
                i.operation === 'create_target_scoped'
                  ? 'RATING_CREATION_CANCELLED'
                  : 'RATING_EDIT_CANCELLED',
            },
            tx,
          ));
        await this.access.recheck(token, tx);
        return receipt;
      },
      { isolationLevel: 'read committed' },
    );
  }
  submit(
    token: string,
    raw: RatingScopedIntent,
    preparationContextRevision?: string,
  ) {
    const i = ratingScopedIntentSchema.parse(raw);
    return this.db.transaction(
      async (tx) => {
        const session = await this.enter(token, tx),
          prior = await this.request(session.accountId, i, tx);
        if (prior) {
          await this.access.recheck(token, tx);
          return prior;
        }
        const checkpoint = checkpointTransactionDeadlines(tx);
        await tx.query('SAVEPOINT scoped_command');
        let result: RatingScopedReceipt;
        try {
          const { p, scope } = await this.makePreparation(token, i, tx);
          if (
            (i.operation === 'create_target_scoped' ||
              i.operation === 'edit_target_scoped') &&
            p.context_revision !== preparationContextRevision
          )
            throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
          if (p.valid_until.getTime() <= Date.now())
            throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
          registerTransactionDeadline(
            tx,
            p.valid_until.getTime(),
            'RATING_SCOPED_CONTEXT_CHANGED',
          );
          await tx.query(
            `INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof) VALUES($1,$2,'execution',$3,$4,$5::jsonb)`,
            [
              scope.actor,
              p.request_id,
              p.context_id,
              p.target_revision,
              canonicalJson({
                intentHash: p.intent_hash,
                operation: p.operation,
                contextId: p.context_id,
                contextRevision: p.context_revision,
              }),
            ],
          );
          const applied = await this.apply(scope, p, tx);
          result = await this.outcome(scope.actor, i, applied, tx);
          await this.scoped.retainAfter(scope, tx);
        } catch (error) {
          if (
            !(error instanceof ApplicationError) ||
            !ratingScopedClosureSchema.safeParse(error.code).success
          )
            throw error;
          await tx.query('ROLLBACK TO SAVEPOINT scoped_command');
          restoreTransactionDeadlines(tx, checkpoint);
          result = await this.outcome(
            session.accountId,
            i,
            { outcome: 'closed', code: error.code },
            tx,
          );
        }
        await tx.query('RELEASE SAVEPOINT scoped_command');
        await this.access.recheck(token, tx);
        return result;
      },
      { isolationLevel: 'read committed' },
    );
  }
  private async apply(
    scope: ResolvedRatingScope,
    p: Preparation,
    tx: PoolClient,
  ): Promise<{ outcome: 'applied' | 'noop'; result: unknown }> {
    const i = p.intent,
      a = scope.actor,
      req = p.request_id;
    switch (i.operation) {
      case 'set_score_scoped': {
        const { outcome, ...result } = await this.records.setScore(
          p.target_id,
          a,
          { ...i.payload, regionId: scope.catalog.regionId },
          tx,
        );
        return { outcome, result };
      }
      case 'create_comment_scoped':
      case 'create_reply_scoped': {
        const e = p.envelope;
        if (
          !e ||
          (e.purpose !== 'publish_rating_comment_scoped' &&
            e.purpose !== 'publish_rating_reply_scoped')
        )
          throw new ApplicationError('RATING_UNAVAILABLE');
        if (i.payload.authorMode === 'anonymous')
          await this.access.requireAnonymous(a, tx);
        const accepted = await this.review.accepted(e, tx);
        let personaId: string | null = null;
        if (i.payload.authorMode === 'anonymous')
          personaId = (await this.records.persona(p.target_id, a, tx))
            .public_id;
        else await this.authors.prepare(a, tx);
        const input = {
          id: p.subject_id,
          targetId: p.target_id,
          actor: a,
          authorMode: i.payload.authorMode,
          personaId,
          body: i.payload.body,
          revision: p.subject_revision,
          requestId: req,
          envelope: e,
        };
        const { outcome, ...result } =
          i.operation === 'create_comment_scoped'
            ? await this.records.insertComment(input, tx)
            : await this.replies.insert(
                {
                  ...input,
                  rootId: i.payload.rootId,
                  replyToId: i.payload.replyTo?.replyId ?? null,
                },
                tx,
              );
        await this.review.bind(
          accepted,
          {
            kind: i.operation === 'create_comment_scoped' ? 'comment' : 'reply',
            subjectId: p.subject_id,
            envelope: e,
          },
          tx,
        );
        await this.effects.captureCreated(a, req, tx);
        return { outcome, result };
      }
      case 'set_comment_like_scoped':
      case 'set_reply_like_scoped': {
        const { outcome, ...r } = await this.likes.set(
          i.operation === 'set_comment_like_scoped'
            ? i.payload.rootId
            : i.payload.replyId,
          a,
          req,
          i.payload.expectedLikeRevision,
          i.payload.liked,
          tx,
        );
        if (outcome === 'applied' && r.liked) {
          await this.authors.prepare(a, tx);
          await this.effects.captureLiked(a, req, tx);
        }
        return {
          outcome,
          result: {
            ...r,
            targetId: p.target_id,
            rootId: i.payload.rootId,
            replyId:
              i.operation === 'set_reply_like_scoped'
                ? i.payload.replyId
                : null,
          },
        };
      }
      case 'set_target_subscription_scoped': {
        const { transitionId, outcome, ...r } = await this.subscriptions.set(
          p.target_id,
          a,
          req,
          i.payload.expectedSubscriptionRevision,
          i.payload.subscribed,
          tx,
        );
        if (transitionId) {
          if (r.subscribed) await this.authors.prepare(a, tx);
          const transition = (
            await tx.query<{
              id: string;
              target_id: string;
              account_id: string;
              request_id: string;
              delta: 1 | -1;
              target_order: string;
              occurred_at: string;
            }>(
              `SELECT id,target_id,account_id,request_id,delta,target_order::text,${ratingIso('occurred_at')} occurred_at FROM whaleu_ratings.subscription_transitions WHERE id=$1`,
              [transitionId],
            )
          ).rows[0]!;
          await this.effects.captureSubscription(tx, transition);
        }
        return { outcome, result: { ...r, targetId: p.target_id } };
      }
      case 'edit_target_scoped':
        return this.edit(scope, p, tx);
      case 'create_target_scoped':
        return this.create(scope, p, tx);
    }
  }
  editContext(
    token: string,
    targetId: string,
    query: { contextId: string; contextToken: string },
  ) {
    return this.db.transaction(
      async (tx) => {
        this.records.enable(tx);
        this.scoped.enable(tx);
        const scope = await this.contexts.resolve(token, query, tx, {
            purpose: 'edit_target',
          }),
          target = await this.scoped.target(scope, targetId, tx);
        if (
          target.row.creator_id !== scope.actor ||
          target.category.kind !== 'general'
        )
          throw new ApplicationError('RATING_NOT_FOUND');
        await this.scoped.retainAfter(scope, tx);
        await this.access.recheck(token, tx);
        return {
          context: {
            contextId: scope.contextId,
            selector: scope.selector,
            catalogRevision: scope.catalogRevision,
            protocolGeneration: scope.protocolGeneration,
          },
          targetId,
          revision: target.row.revision,
          definitionRevision: target.row.definition.definitionRevision,
          contentVersion: target.row.definition.contentVersion,
          categoryId: target.category.id,
          categoryRevision: target.category.revision,
          name: target.row.name,
          description: target.row.description,
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
  private async edit(
    scope: ResolvedRatingScope,
    p: Preparation,
    tx: PoolClient,
  ) {
    const i = p.intent;
    if (
      i.operation !== 'edit_target_scoped' ||
      p.envelope?.purpose !== 'edit_rating_target_scoped'
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    const current = await this.scoped.target(scope, p.target_id, tx, true);
    if (
      current.row.creator_id !== scope.actor ||
      current.row.revision !== i.payload.expectedTargetRevision ||
      current.row.definition.definitionRevision !==
        i.payload.expectedDefinitionRevision ||
      current.row.definition.contentVersion !== i.payload.expectedContentVersion
    )
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    const now = (
      await tx.query<{ now: string }>(
        `SELECT ${ratingIso('clock_timestamp()')} now`,
      )
    ).rows[0]!.now;
    if (
      current.row.name === i.payload.name &&
      current.row.description === i.payload.description
    )
      return {
        outcome: 'noop' as const,
        result: {
          targetId: p.target_id,
          revision: current.row.revision,
          definitionRevision: current.row.definition.definitionRevision,
          contentVersion: current.row.definition.contentVersion,
          occurredAt: now,
        },
      };
    const accepted = await this.review.accepted(p.envelope, tx);
    await tx.query(
      `INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof) VALUES($1,$2,'target_edit',$3,$4,$5::jsonb)`,
      [
        scope.actor,
        p.request_id,
        p.target_id,
        p.target_revision,
        canonicalJson({
          definitionRevision: p.definition_revision,
          contentVersion: p.content_version,
          occurredAt: now,
        }),
      ],
    );
    await tx.query(
      `INSERT INTO whaleu_ratings.target_definition_versions(target_id,content_version,definition_revision,applied_target_revision,name,description,envelope,publication_transaction,published_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,pg_current_xact_id(),$8)`,
      [
        p.target_id,
        p.content_version,
        p.definition_revision,
        p.target_revision,
        i.payload.name,
        i.payload.description,
        canonicalJson(p.envelope),
        now,
      ],
    );
    await tx.query(
      'UPDATE whaleu_ratings.targets SET revision=$2 WHERE id=$1',
      [p.target_id, p.target_revision],
    );
    await tx.query(
      'UPDATE whaleu_ratings.target_definition_heads SET content_version=$2,definition_revision=$3 WHERE target_id=$1',
      [p.target_id, p.content_version, p.definition_revision],
    );
    await this.review.bind(
      accepted,
      {
        kind: 'target',
        definition: {
          targetId: p.target_id,
          contentVersion: p.content_version,
          definitionRevision: p.definition_revision,
          appliedTargetRevision: p.target_revision,
          envelope: p.envelope,
        },
      },
      tx,
    );
    return {
      outcome: 'applied' as const,
      result: {
        targetId: p.target_id,
        revision: p.target_revision,
        definitionRevision: p.definition_revision,
        contentVersion: p.content_version,
        occurredAt: now,
      },
    };
  }
  private async create(
    scope: ResolvedRatingScope,
    p: Preparation,
    tx: PoolClient,
  ) {
    const i = p.intent;
    if (
      i.operation !== 'create_target_scoped' ||
      p.envelope?.purpose !== 'publish_rating_target_scoped'
    )
      throw new ApplicationError('RATING_UNAVAILABLE');
    const policy = await this.sources.requireCreationPolicy(
      scope.catalog.scopeKey,
      tx,
    );
    if (
      policy.id !== p.policy_source_id ||
      policy.revision !== p.policy_source_revision
    )
      throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
    const accepted = await this.review.accepted(p.envelope, tx),
      now = (
        await tx.query<{ now: string }>(
          `SELECT ${ratingIso('clock_timestamp()')} now`,
        )
      ).rows[0]!.now,
      sourceId = randomUUID(),
      baselineId = randomUUID(),
      originId = randomUUID(),
      reference = `rating-scoped-create:${scope.actor}:${p.request_id}`;
    await tx.query(
      `INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof) VALUES($1,$2,'target_initial',$3,$4,$5::jsonb)`,
      [
        scope.actor,
        p.request_id,
        p.target_id,
        p.target_revision,
        canonicalJson({ sourceId, baselineId, originId, occurredAt: now }),
      ],
    );
    await tx.query(
      `INSERT INTO whaleu_ratings.target_sources(id,target_id,origin,coverage,provenance,source_reference,policy_reference,effective_at) VALUES($1,$2,'new_native','complete','accepted',$3,$4,$5)`,
      [sourceId, p.target_id, reference, policy.policy_reference, now],
    );
    await tx.query(
      `INSERT INTO whaleu_ratings.targets(id,revision,category_id,creator_id,region_id,source_id,name,description,active,envelope,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,$9::jsonb,$10)`,
      [
        p.target_id,
        p.target_revision,
        i.payload['categoryId'],
        scope.actor,
        p.envelope.targetOrigin.regionId,
        sourceId,
        i.payload.name,
        i.payload.description,
        canonicalJson(p.envelope),
        now,
      ],
    );
    await tx.query(
      `INSERT INTO whaleu_ratings.score_baselines(target_id,id,kind,source_id,source_reference,policy_reference) VALUES($1,$2,'fresh_zero',$3,$4,$5)`,
      [p.target_id, baselineId, sourceId, reference, policy.policy_reference],
    );
    const known = p.envelope.targetOrigin.originCampusId !== null;
    await tx.query(
      `INSERT INTO whaleu_ratings.target_origin_sources(id,target_id,revision,state,origin_campus_id,coverage_state,provenance_state,source_reference,policy_reference,source_version,effective_at,expiry_kind,valid_until) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,1,$9,'at',$10)`,
      [
        originId,
        p.target_id,
        known ? 'known_school' : 'unknown',
        p.envelope.targetOrigin.originCampusId,
        known ? 'complete' : 'missing',
        known ? 'accepted' : 'unknown',
        reference,
        policy.policy_reference,
        now,
        policy.valid_until,
      ],
    );
    await tx.query(
      'INSERT INTO whaleu_ratings.target_origin_heads VALUES($1,$2,1)',
      [p.target_id, originId],
    );
    await this.review.bind(
      accepted,
      {
        kind: 'target',
        definition: {
          targetId: p.target_id,
          contentVersion: 1,
          definitionRevision: p.definition_revision,
          appliedTargetRevision: p.target_revision,
          envelope: p.envelope,
        },
      },
      tx,
    );
    // This SQL owner derivative checks the accepted native policy and exact fresh
    // execution/initial causes; it cannot issue arbitrary placement or omission.
    await tx.query('SELECT whaleu_ratings.scoped_native_placement($1,$2)', [
      scope.actor,
      p.request_id,
    ]);
    const release = await this.releases.publish(
      scope.campusProof,
      {
        kind: 'create_target_scoped',
        accountId: scope.actor,
        requestId: p.request_id,
      },
      tx,
    );
    const catalog = release.outputs.find(
      (o) => o.scopeKey === scope.catalog.scopeKey,
    );
    if (!catalog) throw new ApplicationError('RATING_UNAVAILABLE');
    await tx.query(
      `INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof) VALUES($1,$2,'catalog_release',$3,$4,$5::jsonb)`,
      [
        scope.actor,
        p.request_id,
        release.releaseId,
        catalog.headRevision,
        canonicalJson({ catalogId: catalog.id, scopeKey: catalog.scopeKey }),
      ],
    );
    return {
      outcome: 'applied' as const,
      result: {
        targetId: p.target_id,
        revision: p.target_revision,
        catalogRevision: catalog.id,
        occurredAt: now,
      },
    };
  }
}
