import { requireContentDistributionGrant } from '../../authorization/content-distribution-grant.js';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { observeCategoryInputs, retainCategoryInputs } from './input-proof.js';
import type { CategoryInputFact } from './input-proof.js';
import { currentCategoryCursorScope } from '../current-category-cursor.js';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { IdentityService } from '../../identity/identity.service.js';
import { hashToken } from '../../identity/tokens.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { ApplicationError } from '../../http/application-error.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { requiredOwnerEpoch } from '../../database/required-owner-proof.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import { campusCountProofOwner } from '../../campus/count-epochs.js';
import { safetyCountProofOwner } from '../../safety/count-epochs.js';
import { CommunityRepository } from '../community.repository.js';
import { CommunityAccessService } from '../community-access.service.js';
import { requireAction } from '../community-policy.js';
import type { Category } from '../contracts.js';
import { reclassificationCategorySchema } from './contracts.js';
import type {
  ReclassificationCommand,
  ReclassificationReceipt,
  ReclassificationCategory,
} from './contracts.js';
import {
  categoryIntentHash,
  categoryCommandEnvelope,
  exactCategoryReview,
} from './evidence.js';
import type { CategoryPolicy } from './evidence.js';
import { resolvePostCategory } from './read-proof.js';
import { retainCategoryCommandProof } from './proof.js';
const campusProof = requiredOwnerEpoch(
  campusCountProofOwner,
  'POST_CATEGORY_UNAVAILABLE',
);
const safetyProof = requiredOwnerEpoch(
  safetyCountProofOwner,
  'POST_CATEGORY_UNAVAILABLE',
);

interface Head {
  revision: number;
  event_id: string | null;
  current_category: Category;
}
export interface CategoryManagement {
  blocker?: 'related_sync_unsupported';
  postId: string;
  currentCategory: Category;
  revision: number;
  canChange: boolean;
  targets: ReclassificationCategory[];
}
@Injectable()
export class CategoryReclassificationService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
  ) {}
  private run<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    return this.repository.database
      .transaction(work, { isolationLevel: 'read committed' })
      .catch((error: unknown) => {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (['55P03', '40001', '40P01'].includes(String(error.code)) ||
            ('constraint' in error &&
              error.constraint === 'post_category_causal'))
        )
          throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
        throw error;
      });
  }
  private async state(postId: string, tx: PoolClient): Promise<Head> {
    const row = (
      await tx.query<Head>(
        `SELECT coalesce(h.revision,0)::integer AS revision,h.event_id,coalesce(h.current_category,p.category) AS current_category FROM whaleu_community.posts p LEFT JOIN whaleu_community.post_category_heads h ON h.post_id=p.id WHERE p.id=$1`,
        [postId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('POST_NOT_FOUND');
    return row;
  }
  private async grant(
    actor: string,
    postId: string,
    tx: PoolClient,
  ): Promise<string | null> {
    const grants = await this.authorization.grants(actor, tx);
    const rows = (
      await tx.query<{ id: string; until: string | null }>(
        `SELECT g.id,g.expires_at::text AS until FROM whaleu_authorization.role_grants g WHERE g.id=ANY($1::uuid[]) AND whaleu_community.post_category_grant_allowed($2,g.id,$3) ORDER BY CASE g.role WHEN 'super_admin' THEN 0 ELSE 1 END,g.id LIMIT 1 FOR SHARE`,
        [grants.map((g) => g.id), actor, postId],
      )
    ).rows;
    if (!rows[0]) return null;
    registerTransactionExactDeadline(
      tx,
      rows[0].until,
      'AUTHORIZATION_REQUIRED',
    );
    return rows[0].id;
  }
  private async policies(
    postId: string,
    current: Category,
    target: ReclassificationCategory,
    tx: PoolClient,
  ): Promise<CategoryPolicy[]> {
    return (
      await tx.query<CategoryPolicy>(
        `SELECT s.id,s.definition,s.effective_until::text FROM whaleu_community.post_category_policy_live s JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=$1 WHERE s.original_region_id=(b.scope->>'originalRegionId')::uuid AND whaleu_community.post_category_policy_allows(s.definition,b.envelope->>'category',$2,$3) ORDER BY s.id LIMIT 2`,
        [postId, current, target],
      )
    ).rows;
  }
  private async supported(postId: string, tx: PoolClient): Promise<boolean> {
    return (
      (
        await tx.query<{ ok: boolean }>(
          'SELECT whaleu_community.post_category_supported($1) AS ok',
          [postId],
        )
      ).rows[0]?.ok === true
    );
  }
  private async targetAllowed(
    postId: string,
    policy: CategoryPolicy,
    tx: PoolClient,
  ): Promise<boolean> {
    const row = (
      await tx.query<{ children: boolean; media: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM whaleu_community.root_comments WHERE post_id=$1) OR EXISTS(SELECT 1 FROM whaleu_community.replies WHERE post_id=$1) AS children, EXISTS(SELECT 1 FROM whaleu_community.root_comments c JOIN whaleu_community.content_approval_bindings b ON b.content_kind='comment' AND b.content_id=c.id WHERE c.post_id=$1 AND b.envelope->'images'<>'[]'::jsonb) OR EXISTS(SELECT 1 FROM whaleu_community.replies r JOIN whaleu_community.content_approval_bindings b ON b.content_kind='reply' AND b.content_id=r.id WHERE r.post_id=$1 AND b.envelope->'images'<>'[]'::jsonb) AS media`,
        [postId],
      )
    ).rows[0]!;
    return (
      (!row.children || policy.definition.continueDescendants === true) &&
      (!row.media ||
        policy.definition.descendantMedia === 'retain_current_media_proof')
    );
  }
  @AccountPolicy('privileged_read', 'entry')
  async management(token: string, postId: string): Promise<CategoryManagement> {
    return this.run(async (tx) => {
      const session = await this.identity.session(token, tx);
      await lockSafetyPolicy(tx);
      await campusProof(tx);
      await safetyProof(tx);
      // Child publication takes the same parent's SHARE lock. A selected-parent
      // UPDATE lock keeps advertised descendant/media-dependent targets exact
      // without subscribing this read to unrelated Community activity.
      const post = await this.repository.post(postId, tx, true);
      const currentCategory = await resolvePostCategory(postId, tx);
      if (!currentCategory)
        throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
      if (
        !(await this.access.visible(session.accountId, post, tx, 'direct_post'))
      )
        throw new ApplicationError('POST_NOT_FOUND');
      const state = await this.state(postId, tx);
      if (post.publication_envelope_version === 4) {
        await requireContentDistributionGrant(
          session.accountId,
          post.id,
          null,
          tx,
          'profile_unavailable',
        );
        return {
          postId,
          currentCategory,
          revision: state.revision,
          canChange: false,
          targets: [],
          blocker: 'related_sync_unsupported',
        };
      }

      const grantId = await this.grant(session.accountId, postId, tx);
      await currentCategoryCursorScope('category-management', tx);
      const targets: ReclassificationCategory[] = [];
      if (
        grantId &&
        state.revision < 2147483647 &&
        (await this.supported(postId, tx)) &&
        (await this.access.visible(
          session.accountId,
          post,
          tx,
          'list_projection',
        ))
      ) {
        for (const candidate of reclassificationCategorySchema.options) {
          if (candidate === currentCategory) continue;
          const policies = await this.policies(
            postId,
            currentCategory,
            candidate,
            tx,
          );
          if (
            policies.length === 1 &&
            (await this.targetAllowed(postId, policies[0]!, tx))
          ) {
            targets.push(candidate);
            registerTransactionExactDeadline(
              tx,
              policies[0]!.effective_until,
              'POST_CATEGORY_UNAVAILABLE',
            );
          }
        }
      }
      await retainCategoryCommandProof(
        {
          actor: session.accountId,
          sessionId: session.sessionId,
          tokenHash: hashToken(token),
          postId,
          grantId,
        },
        tx,
      );
      return {
        postId,
        currentCategory,
        revision: state.revision,
        canChange: targets.length > 0,
        targets,
      };
    });
  }
  @AccountPolicy('content_management', 'owner_after_recovery')
  async command(
    token: string,
    command: ReclassificationCommand,
    cancel = false,
  ): Promise<ReclassificationReceipt> {
    return this.run(async (tx) => {
      const session = await this.identity.session(token, tx),
        actor = session.accountId,
        hash = categoryIntentHash(actor, command);
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:post-category-request:v1:'||$1||':'||$2,0))",
        [actor, command.clientRequestId],
      );
      const previous = (
        await tx.query<{
          intent_hash: string;
          receipt: ReclassificationReceipt;
        }>(
          'SELECT intent_hash,receipt FROM whaleu_community.post_category_commands WHERE actor_id=$1 AND request_id=$2',
          [actor, command.clientRequestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        await retainCategoryCommandProof(
          {
            actor,
            sessionId: session.sessionId,
            tokenHash: hashToken(token),
            postId: null,
            grantId: null,
          },
          tx,
        );
        return previous.receipt;
      }
      if (cancel) {
        const target = await tx.query(
          'SELECT id FROM whaleu_community.posts WHERE id=$1',
          [command.postId],
        );
        if (target.rowCount !== 1) throw new ApplicationError('POST_NOT_FOUND');
        const receipt: ReclassificationReceipt = {
          requestId: command.clientRequestId,
          postId: command.postId,
          expectedRevision: command.expectedRevision,
          targetCategory: command.targetCategory,
          outcome: 'rejected',
          code: 'POST_CATEGORY_CANCELLED',
        };
        await tx.query(
          'INSERT INTO whaleu_community.post_category_commands(actor_id,request_id,post_id,session_id,grant_id,intent_hash,command,receipt) VALUES($1,$2,$3,$4,NULL,$5,$6,$7)',
          [
            actor,
            command.clientRequestId,
            command.postId,
            session.sessionId,
            hash,
            command,
            receipt,
          ],
        );
        await retainCategoryCommandProof(
          {
            actor,
            sessionId: session.sessionId,
            tokenHash: hashToken(token),
            postId: null,
            grantId: null,
          },
          tx,
        );
        return receipt;
      }
      await lockSafetyPolicy(tx);
      await campusProof(tx);
      await safetyProof(tx);
      const post = await this.repository.post(command.postId, tx, true),
        state = await this.state(post.id, tx);
      if (post.publication_envelope_version === 4)
        throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
      const base = {
        requestId: command.clientRequestId,
        postId: command.postId,
        expectedRevision: command.expectedRevision,
        targetCategory: command.targetCategory,
      };
      const grantId = await this.grant(actor, post.id, tx);
      if (!grantId) throw new ApplicationError('AUTHORIZATION_REQUIRED');
      let policy: CategoryPolicy | undefined, reviewId: string | undefined;
      let receipt: ReclassificationReceipt;
      const checkpoint = checkpointTransactionDeadlines(tx);
      const inputFacts: CategoryInputFact[] = [];
      if (state.revision !== command.expectedRevision)
        receipt = { ...base, outcome: 'rejected', code: 'POST_CATEGORY_STALE' };
      else {
        inputFacts.push(
          await observeCategoryInputs(
            {
              postId: post.id,
              grantId,
              previousEventId: state.event_id,
              policyId: null,
              reviewId: null,
              fromCategory: state.current_category,
              targetCategory: command.targetCategory,
            },
            tx,
          ),
        );
        if (
          !(await this.supported(post.id, tx)) ||
          !(await this.access.visible(actor, post, tx, 'list_projection'))
        )
          throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
        requireAction(
          await this.access.authority(
            actor,
            await this.repository.space(post.space_id, tx),
            tx,
          ),
          'publish_post',
        );
        const category = await resolvePostCategory(post.id, tx);
        if (!category) throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
        const now = (
          await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
        ).rows[0]!.now.toISOString();
        if (category === command.targetCategory)
          receipt = {
            ...base,
            outcome: 'unchanged',
            revision: state.revision,
            eventId: state.event_id,
            recordedAt: now,
          };
        else {
          const policies = await this.policies(
            post.id,
            category,
            command.targetCategory,
            tx,
          );
          if (
            policies.length !== 1 ||
            !(await this.targetAllowed(post.id, policies[0]!, tx))
          )
            throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
          policy = policies[0]!;
          await tx.query(
            'SELECT id FROM whaleu_community.post_category_policies WHERE id=$1 FOR SHARE',
            [policy.id],
          );
          reviewId = await exactCategoryReview(
            await categoryCommandEnvelope(
              actor,
              command,
              grantId,
              policy.id,
              tx,
            ),
            policy.id,
            tx,
          );
          inputFacts.push(
            await observeCategoryInputs(
              {
                postId: post.id,
                grantId,
                previousEventId: state.event_id,
                policyId: policy.id,
                reviewId,
                fromCategory: state.current_category,
                targetCategory: command.targetCategory,
              },
              tx,
            ),
          );
          receipt = {
            ...base,
            outcome: 'applied',
            revision: state.revision + 1,
            eventId: randomUUID(),
            recordedAt: now,
          };
        }
      }
      await tx.query(
        'INSERT INTO whaleu_community.post_category_commands(actor_id,request_id,post_id,session_id,grant_id,intent_hash,command,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          actor,
          command.clientRequestId,
          post.id,
          session.sessionId,
          grantId,
          hash,
          command,
          receipt,
        ],
      );
      if (receipt.outcome === 'applied') {
        await tx.query(
          `INSERT INTO whaleu_community.post_category_events(id,post_id,revision,previous_event_id,original_category,previous_category,current_category,original_decision_id,original_digest,policy_id,review_id,grant_id,actor_id,request_id,recorded_at) SELECT $1,p.id,$3,$4,p.category,$5,$6,b.decision_id,b.digest,$7,$8,$9,$10,$11,$12 FROM whaleu_community.posts p JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id WHERE p.id=$2`,
          [
            receipt.eventId,
            post.id,
            receipt.revision,
            state.event_id,
            state.current_category,
            command.targetCategory,
            policy!.id,
            reviewId,
            grantId,
            actor,
            command.clientRequestId,
            receipt.recordedAt,
          ],
        );
        const result =
          state.revision === 0
            ? await tx.query(
                'INSERT INTO whaleu_community.post_category_heads(post_id,current_category,revision,event_id) VALUES($1,$2,$3,$4)',
                [
                  post.id,
                  command.targetCategory,
                  receipt.revision,
                  receipt.eventId,
                ],
              )
            : await tx.query(
                'UPDATE whaleu_community.post_category_heads SET current_category=$2,revision=$3,event_id=$4,mutation_transaction=pg_current_xact_id() WHERE post_id=$1 AND revision=$5 AND event_id=$6',
                [
                  post.id,
                  command.targetCategory,
                  receipt.revision,
                  receipt.eventId,
                  state.revision,
                  state.event_id,
                ],
              );
        if (result.rowCount !== 1)
          throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
        // Replace pre-write projections by exact post-write facts; old lineage is
        // immutable and checked by deferred SQL under the same locked parent row.
        restoreTransactionDeadlines(tx, checkpoint);
        for (const fact of inputFacts) retainCategoryInputs(fact, tx);
        if (
          !(await this.access.visible(actor, post, tx, 'list_projection')) ||
          (await resolvePostCategory(post.id, tx)) !== command.targetCategory
        )
          throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
        requireAction(
          await this.access.authority(
            actor,
            await this.repository.space(post.space_id, tx),
            tx,
          ),
          'publish_post',
        );
        registerTransactionExactDeadline(
          tx,
          policy!.effective_until,
          'POST_CATEGORY_UNAVAILABLE',
        );
      }
      if (receipt.outcome === 'applied') {
        const selected = await this.policies(
          post.id,
          state.current_category,
          command.targetCategory,
          tx,
        );
        if (selected.length !== 1 || selected[0]!.id !== policy!.id)
          throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
      }
      await retainCategoryCommandProof(
        {
          actor,
          sessionId: session.sessionId,
          tokenHash: hashToken(token),
          postId: post.id,
          grantId,
        },
        tx,
      );
      return receipt;
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  async recovery(token: string, requestId: string) {
    return this.run(async (tx) => {
      const session = await this.identity.session(token, tx);
      const row = (
        await tx.query<{ receipt: ReclassificationReceipt }>(
          'SELECT receipt FROM whaleu_community.post_category_commands WHERE actor_id=$1 AND request_id=$2',
          [session.accountId, requestId],
        )
      ).rows[0];
      await retainCategoryCommandProof(
        {
          actor: session.accountId,
          sessionId: session.sessionId,
          tokenHash: hashToken(token),
          postId: null,
          grantId: null,
        },
        tx,
      );
      return row
        ? { state: 'recorded' as const, receipt: row.receipt }
        : { state: 'not_recorded' as const };
    });
  }
}
