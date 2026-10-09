import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.js';
import { ownerFingerprint } from '../../database/required-owner-proof.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import type { SessionView } from '../../identity/contracts.js';
import { RatingAuthorizationFacade } from '../../authorization/rating-grants.facade.js';
import type { RatingGrantScope } from '../../authorization/rating-grants.facade.js';
import { CampusRatingOriginScopeFacade } from '../../campus/rating-origin-scope.facade.js';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../../community/discovery-continuation.module.js';
import { RatingsAccessService } from '../access.js';
import { RatingsRepository, ratingIso } from '../repository.js';
import { RatingDeletionRepository } from './repository.js';
import { RatingTargetOriginFacade } from './origin.facade.js';
import { RatingAdminDeletionRequests } from './requests.js';
import {
  ratingDeletionContextSchema,
  ratingAdminDeletionContextSchema,
} from './contracts.js';
import type {
  RatingDeletionKind,
  AdminDeleteRatingComment,
  AdminDeleteRatingReply,
} from './contracts.js';

const contextPositionSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('rating-admin-deletion'),
  nonce: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(),
});
@Injectable()
export class RatingDeletionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingDeletionRepository)
    private readonly metadata: RatingDeletionRepository,
    @Inject(RatingsRepository) private readonly records: RatingsRepository,
    @Inject(RatingAuthorizationFacade)
    private readonly grants: RatingAuthorizationFacade,
    @Inject(RatingTargetOriginFacade)
    private readonly origins: RatingTargetOriginFacade,
    @Inject(CampusRatingOriginScopeFacade)
    private readonly campus: CampusRatingOriginScopeFacade,
    @Inject(DiscoveryContinuationFacade)
    private readonly contexts: DiscoveryContinuationFacade,
    @Inject(RatingAdminDeletionRequests)
    private readonly requests: RatingAdminDeletionRequests,
  ) {}
  private async chain(
    kind: RatingDeletionKind,
    id: string,
    locator: { target_id: string; root_id: string },
    tx: PoolClient,
  ) {
    this.records.enable(tx);
    const target = await this.metadata.target(locator.target_id, tx);
    const root = await this.metadata.root(locator.root_id, target.id, tx);
    const subject =
      kind === 'comment'
        ? root
        : await this.metadata.reply(id, root.id, target.id, tx);
    if (subject.id !== id) throw new ApplicationError('RATING_NOT_FOUND');
    return { target, root, subject };
  }
  private view(
    kind: RatingDeletionKind,
    chain: Awaited<ReturnType<RatingDeletionService['chain']>>,
  ) {
    return ratingDeletionContextSchema.parse({
      subjectKind: kind,
      targetId: chain.target.id,
      rootId: chain.root.id,
      subjectId: chain.subject.id,
      regionId: chain.target.region_id,
      targetRevision: chain.target.revision,
      rootRevision: chain.root.revision,
      revision: chain.subject.revision,
      deleted: chain.subject.deleted_at !== null,
    });
  }
  private retain(
    kind: RatingDeletionKind,
    chain: Awaited<ReturnType<RatingDeletionService['chain']>>,
    tx: PoolClient,
  ) {
    this.records.retainComment(chain.root, tx);
    if (kind === 'reply') this.records.retainReply(chain.subject, tx);
  }
  ownerContext(token: string, kind: RatingDeletionKind, id: string) {
    return this.database.transaction(
      async (tx) => {
        const session = await this.access.authenticate(token, tx);
        await this.access.requireDeletionActor(session.accountId, tx);
        const locator = await this.metadata.locator(kind, id, tx);
        const chain = await this.chain(kind, id, locator, tx);
        if (chain.subject.account_id !== session.accountId)
          throw new ApplicationError('RATING_NOT_FOUND');
        this.retain(kind, chain, tx);
        await this.access.recheck(token, tx);
        return this.view(kind, chain);
      },
      { isolationLevel: 'read committed' },
    );
  }
  private async authority(
    actor: string,
    targetId: string,
    tx: PoolClient,
    observedGrant?: RatingGrantScope,
  ) {
    const grant = observedGrant ?? (await this.grants.scope(actor, tx));
    if (grant.kind === 'ordinary')
      throw new ApplicationError('AUTHORIZATION_REQUIRED');
    const origin = await this.origins.observe(targetId, tx);
    let mapping: Awaited<
      ReturnType<CampusRatingOriginScopeFacade['resolve']>
    > | null = null;
    if (grant.kind === 'fixed') {
      if (origin.state !== 'known_school' || origin.campusId === null)
        throw new ApplicationError('RATING_DELETION_AUTHORITY_UNAVAILABLE');
      mapping = await this.campus.resolve(origin.campusId, tx);
      if (mapping.operatingRegionId !== grant.regionId)
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    }
    return { grant, origin, mapping };
  }
  private scope(session: SessionView, kind: RatingDeletionKind, id: string) {
    return discoveryContinuationScope([
      'rating-admin-deletion-v1',
      session.accountId,
      session.sessionId,
      session.expiresAt,
      kind,
      id,
    ]);
  }
  private fingerprint(
    session: SessionView,
    eligibility: string,
    kind: RatingDeletionKind,
    chain: Awaited<ReturnType<RatingDeletionService['chain']>>,
    authority: Awaited<ReturnType<RatingDeletionService['authority']>>,
  ) {
    return ownerFingerprint([
      session.accountId,
      session.sessionId,
      session.expiresAt,
      eligibility,
      this.view(kind, chain),
      authority.grant.fingerprint,
      authority.grant.grant.id,
      authority.origin.fingerprint,
      authority.mapping?.fingerprint ?? null,
    ]);
  }
  adminContext(token: string, kind: RatingDeletionKind, id: string) {
    return this.database.transaction(
      async (tx) => {
        const session = await this.access.authenticate(token, tx);
        const eligibility = await this.access.requireDeletionActor(
          session.accountId,
          tx,
        );
        // Reject ordinary actors before looking up subject existence.
        const grant = await this.grants.scope(session.accountId, tx);
        if (grant.kind === 'ordinary')
          throw new ApplicationError('AUTHORIZATION_REQUIRED');
        // This unlocked immutable locator is only used to plan authority-before-parent locks.
        const locator = await this.metadata.locator(kind, id, tx);
        const authority = await this.authority(
          session.accountId,
          locator.target_id,
          tx,
          grant,
        );
        const chain = await this.chain(kind, id, locator, tx);
        this.retain(kind, chain, tx);
        await this.access.recheck(token, tx);
        const now = (
          await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
        ).rows[0]!.now.getTime();
        const expiresAt = Math.min(now + 5 * 60 * 1000, session.expiresAt);
        registerTransactionDeadline(
          tx,
          expiresAt,
          'RATING_DELETION_CONTEXT_CHANGED',
        );
        const contextRevision = await this.contexts.create(
          this.scope(session, kind, id),
          session.accountId,
          {
            v: 1,
            kind: 'rating-admin-deletion',
            nonce: randomUUID(),
            expiresAt,
            fingerprint: this.fingerprint(
              session,
              eligibility.fingerprint,
              kind,
              chain,
              authority,
            ),
          },
          tx,
        );
        return ratingAdminDeletionContextSchema.parse({
          ...this.view(kind, chain),
          contextRevision,
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
  private async readContext(
    token: string,
    session: SessionView,
    kind: RatingDeletionKind,
    id: string,
    tx: PoolClient,
  ) {
    let result: z.infer<typeof contextPositionSchema>;
    try {
      result = await this.contexts.get(
        token,
        this.scope(session, kind, id),
        tx,
        (value) => contextPositionSchema.parse(value),
      );
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        (error instanceof ApplicationError &&
          error.code === 'DISCOVERY_RESTART_REQUIRED')
      )
        throw new ApplicationError('RATING_DELETION_CONTEXT_CHANGED');
      throw error;
    }
    const row = (
      await tx.query<{ valid: boolean }>(
        'SELECT clock_timestamp()<to_timestamp($1::double precision/1000) valid',
        [result.expiresAt],
      )
    ).rows[0];
    if (!row?.valid)
      throw new ApplicationError('RATING_DELETION_CONTEXT_CHANGED');
    registerTransactionDeadline(
      tx,
      result.expiresAt,
      'RATING_DELETION_CONTEXT_CHANGED',
    );
    return result;
  }
  deleteComment(token: string, id: string, command: AdminDeleteRatingComment) {
    return this.delete(token, 'comment', id, command);
  }
  deleteReply(token: string, id: string, command: AdminDeleteRatingReply) {
    return this.delete(token, 'reply', id, command);
  }
  private delete(
    token: string,
    kind: RatingDeletionKind,
    id: string,
    command: AdminDeleteRatingComment | AdminDeleteRatingReply,
  ) {
    const operation =
      kind === 'comment' ? 'admin_delete_comment' : 'admin_delete_reply';
    return this.requests.execute(
      token,
      command.clientRequestId,
      operation,
      { subjectId: id, ...command },
      async (session, intentHash, tx) => {
        const eligibility = await this.access.requireDeletionActor(
          session.accountId,
          tx,
        );
        const context = await this.readContext(
          command.expectedContextRevision,
          session,
          kind,
          id,
          tx,
        );
        const authority = await this.authority(
          session.accountId,
          command.targetId,
          tx,
        ).catch((error: unknown) => {
          // Replay was resolved before this callback and the old opaque context
          // was just verified. A known lost grant/scope invalidates that intent;
          // it must not leave a recoverable client command pending forever.
          // Unknown authority/source/proof failures remain unavailable.
          if (
            error instanceof ApplicationError &&
            (error.code === 'AUTHORIZATION_REQUIRED' ||
              error.code === 'RATING_SCOPE_UNAVAILABLE')
          )
            throw new ApplicationError('RATING_DELETION_CONTEXT_CHANGED');
          throw error;
        });
        const locator = {
          target_id: command.targetId,
          root_id: 'rootId' in command ? command.rootId : id,
        };
        const chain = await this.chain(kind, id, locator, tx);
        if (
          chain.target.revision !== command.expectedTargetRevision ||
          chain.subject.revision !== command.expectedRevision ||
          ('expectedRootRevision' in command &&
            chain.root.revision !== command.expectedRootRevision)
        ) {
          this.retain(kind, chain, tx);
          throw new ApplicationError('RATING_REVISION_CONFLICT');
        }
        if (
          context.fingerprint !==
          this.fingerprint(
            session,
            eligibility.fingerprint,
            kind,
            chain,
            authority,
          )
        )
          throw new ApplicationError('RATING_DELETION_CONTEXT_CHANGED');
        const outcome =
          chain.subject.deleted_at === null
            ? ('applied' as const)
            : ('noop' as const);
        const revision =
          outcome === 'applied' ? randomUUID() : chain.subject.revision;
        let effective: { id: string; occurred_at: string } | undefined;
        if (outcome === 'noop') {
          effective = (
            await tx.query<{ id: string; occurred_at: string }>(
              `SELECT id,${ratingIso('occurred_at')} occurred_at FROM whaleu_ratings.${kind === 'comment' ? 'comment' : 'reply'}_transitions WHERE ${kind === 'comment' ? 'comment' : 'reply'}_id=$1 AND account_id=$2 AND revision=$3 AND operation=$4`,
              [
                id,
                chain.subject.account_id,
                revision,
                kind === 'comment' ? 'delete_comment' : 'delete_reply',
              ],
            )
          ).rows[0];
          if (!effective) throw new ApplicationError('RATING_UNAVAILABLE');
        }
        const auditId = randomUUID();
        const audit = (
          await tx.query<{ occurred_at: string }>(
            `INSERT INTO whaleu_ratings.admin_delete_audits
        (id,actor_account_id,session_id,request_id,intent_hash,subject_kind,target_id,root_id,subject_id,author_account_id,
        target_revision,root_revision,before_revision,after_revision,scope_kind,grant_id,grant_fingerprint,
        origin_source_id,origin_revision,origin_state,origin_fingerprint,origin_campus_id,operating_region_id,
        topology_snapshot_id,topology_revision,context_revision,outcome,occurred_at,effective_comment_transition_id,effective_reply_transition_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,coalesce($28::timestamptz,clock_timestamp()),$29,$30)
        RETURNING ${ratingIso('occurred_at')} occurred_at`,
            [
              auditId,
              session.accountId,
              session.sessionId,
              command.clientRequestId,
              intentHash,
              kind,
              chain.target.id,
              chain.root.id,
              id,
              chain.subject.account_id,
              chain.target.revision,
              chain.root.revision,
              chain.subject.revision,
              revision,
              authority.grant.kind,
              authority.grant.grant.id,
              authority.grant.fingerprint,
              authority.origin.sourceId,
              authority.origin.revision,
              authority.origin.state,
              authority.origin.fingerprint,
              authority.origin.campusId,
              authority.mapping?.operatingRegionId ?? null,
              authority.mapping?.topologySnapshotId ?? null,
              authority.mapping?.topologyRevision ?? null,
              command.expectedContextRevision,
              outcome,
              effective?.occurred_at ?? null,
              kind === 'comment' ? (effective?.id ?? null) : null,
              kind === 'reply' ? (effective?.id ?? null) : null,
            ],
          )
        ).rows[0];
        if (!audit) throw new ApplicationError('RATING_UNAVAILABLE');
        if (outcome === 'applied') {
          const updated = (
            await tx.query<{
              id: string;
              revision: string;
              deleted_at: string;
            }>(
              `UPDATE whaleu_ratings.${kind === 'comment' ? 'comments' : 'replies'} SET deleted_at=$2::timestamptz,revision=$3,admin_delete_audit_id=$4 WHERE id=$1 RETURNING id,revision,${ratingIso('deleted_at')} deleted_at`,
              [id, audit.occurred_at, revision, auditId],
            )
          ).rows[0];
          if (!updated) throw new ApplicationError('RATING_UNAVAILABLE');
          if (kind === 'comment') this.records.retainComment(updated, tx);
          else {
            this.records.retainComment(chain.root, tx);
            this.records.retainReply(updated, tx);
          }
        } else this.retain(kind, chain, tx);
        return {
          outcome,
          targetId: chain.target.id,
          rootId: chain.root.id,
          subjectId: id,
          revision,
          occurredAt: audit.occurred_at,
        };
      },
    );
  }
  receipt(token: string, id: string) {
    return this.requests.receipt(token, id);
  }
}
