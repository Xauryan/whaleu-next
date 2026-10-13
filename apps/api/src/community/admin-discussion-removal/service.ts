import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { hashToken } from '../../identity/tokens.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { ApplicationError } from '../../http/application-error.js';
import { requiredOwnerEpoch } from '../../database/required-owner-proof.js';
import { campusCountProofOwner } from '../../campus/count-epochs.js';
import { safetyCountProofOwner } from '../../safety/count-epochs.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { CommunityRepository } from '../community.repository.js';
import { CommunityAccessService } from '../community-access.service.js';
import { requireAction } from '../community-policy.js';
import { ownerPostVisibilityAllowed } from '../owner-visibility/read-proof.js';
import { adminDiscussionRemovalIntentHash } from './evidence.js';
import {
  adminDiscussionRemovalManagementSchema,
  adminDiscussionRemovalReceiptSchema,
} from './contracts.js';
import type {
  AdminDiscussionRemovalCommand,
  AdminDiscussionRemovalManagement,
  AdminDiscussionRemovalReceipt,
  AdminDiscussionRemovalTarget,
} from './contracts.js';
import {
  retainAdminDiscussionRemovalIdentity,
  observeAdminDiscussionRemovalInputs,
  retainAdminDiscussionRemovalInputs,
  retainAdminDiscussionRemovalCommand,
} from './proof.js';
import type { InputFact } from './proof.js';

const campusProof = requiredOwnerEpoch(
  campusCountProofOwner,
  'ADMIN_DISCUSSION_REMOVAL_UNAVAILABLE',
);
const safetyProof = requiredOwnerEpoch(
  safetyCountProofOwner,
  'ADMIN_DISCUSSION_REMOVAL_UNAVAILABLE',
);

/** Content administration is independent from public Profile moderation. In
 * particular an anonymous discussion target never becomes a public account locator. */
@Injectable()
export class AdminDiscussionRemovalService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
  ) {}
  private run<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    return this.database
      .transaction(work, { isolationLevel: 'read committed' })
      .catch((error: unknown) => {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (['55P03', '40001', '40P01'].includes(String(error.code)) ||
            ('constraint' in error &&
              error.constraint === 'admin_discussion_removal_causal'))
        )
          throw new ApplicationError('ADMIN_DISCUSSION_REMOVAL_UNAVAILABLE');
        throw error;
      });
  }
  private async session(token: string, tx: PoolClient) {
    const session = await this.identity.session(token, tx);
    await retainAdminDiscussionRemovalIdentity(
      {
        actor: session.accountId,
        sessionId: session.sessionId,
        tokenHash: hashToken(token),
      },
      tx,
    );
    return session;
  }
  private async resolve(
    target: AdminDiscussionRemovalTarget,
    actor: string,
    tx: PoolClient,
  ) {
    await lockSafetyPolicy(tx);
    await campusProof(tx);
    await safetyProof(tx);
    const resolved =
      target.kind === 'comment'
        ? await this.access
            .accessibleComment(target.id, actor, tx, true)
            .then((value) => ({ ...value, child: value.comment }))
        : await this.access
            .accessibleReply(target.id, actor, tx, true)
            .then((value) => ({ ...value, child: value.reply }));
    const { post, space, comment, child } = resolved;
    if (child.account_id === actor)
      throw new ApplicationError('ADMIN_DISCUSSION_REMOVAL_OWN_CONTENT');
    if (
      !(await ownerPostVisibilityAllowed(
        post.id,
        post.account_id,
        actor,
        'list_projection',
        tx,
      )) ||
      !(await this.access.visible(actor, post, tx, 'list_projection'))
    )
      throw new ApplicationError('POST_NOT_FOUND');
    if (space.kind !== 'regional' || !space.operatingRegionId)
      throw new ApplicationError('ADMIN_DISCUSSION_REMOVAL_TARGET_NOT_ALLOWED');
    const row = (
      await tx.query<{
        subject_id: string;
        post_id: string;
        root_id: string;
        region_id: string;
        target_version: string;
      }>(
        'SELECT t.*,whaleu_community.admin_discussion_removal_target_version($1,$2) target_version FROM whaleu_community.admin_discussion_removal_target($1,$2) t WHERE whaleu_community.admin_discussion_removal_supported($3,$1,$2)',
        [target.kind, target.id, actor],
      )
    ).rows[0];
    if (
      !row ||
      row.subject_id !== child.account_id ||
      row.post_id !== post.id ||
      row.root_id !== comment.id ||
      row.region_id !== space.operatingRegionId
    )
      throw new ApplicationError('ADMIN_DISCUSSION_REMOVAL_TARGET_NOT_ALLOWED');
    requireAction(
      await this.access.authority(actor, space, tx),
      'publish_post',
    );
    return Object.freeze(row);
  }
  private async grant(
    actor: string,
    region: string,
    target: AdminDiscussionRemovalTarget,
    requestId: string | null,
    tx: PoolClient,
  ): Promise<InputFact & { grantId: string }> {
    const grants = await this.authorization.grants(actor, tx);
    const row = (
      await tx.query<{ id: string }>(
        "SELECT id FROM whaleu_authorization.role_grants WHERE id=ANY($1::uuid[]) AND whaleu_profile.moderation_grant_allowed($2,id,$3) ORDER BY CASE role WHEN 'super_admin' THEN 0 ELSE 1 END,id LIMIT 1 FOR SHARE",
        [grants.map((g) => g.id), actor, region],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    const observed = await observeAdminDiscussionRemovalInputs(
      { actor, grantId: row.id, target, requestId },
      tx,
    );
    return Object.freeze({ ...observed, grantId: row.id });
  }
  async management(
    token: string,
    target: AdminDiscussionRemovalTarget,
  ): Promise<AdminDiscussionRemovalManagement> {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      const initial = await observeAdminDiscussionRemovalInputs(
        { actor: session.accountId, grantId: null, target, requestId: null },
        tx,
      );
      const resolved = await this.resolve(target, session.accountId, tx);
      const selected = await this.grant(
        session.accountId,
        resolved.region_id,
        target,
        null,
        tx,
      );
      await retainAdminDiscussionRemovalInputs(initial, tx);
      await retainAdminDiscussionRemovalInputs(selected, tx);
      return adminDiscussionRemovalManagementSchema.parse({
        target,
        targetVersion: resolved.target_version,
        canRemove: true,
      });
    });
  }
  async command(
    token: string,
    command: AdminDiscussionRemovalCommand,
    cancel = false,
  ): Promise<AdminDiscussionRemovalReceipt> {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        actor = session.accountId;
      const hash = adminDiscussionRemovalIntentHash(actor, command);
      // Terminal outcomes and cancellation authenticate only the active account,
      // session and presented token. They never resolve a deleted source again.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:admin-discussion-removal-request:v1:'||$1||':'||$2,0))",
        [actor, command.clientRequestId],
      );
      const previous = (
        await tx.query<{
          intent_hash: string;
          receipt: AdminDiscussionRemovalReceipt;
        }>(
          'SELECT intent_hash,receipt FROM whaleu_community.admin_discussion_removal_commands WHERE actor_id=$1 AND request_id=$2',
          [actor, command.clientRequestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        return adminDiscussionRemovalReceiptSchema.parse(previous.receipt);
      }
      const base = {
        requestId: command.clientRequestId,
        target: command.target,
        expectedTargetVersion: command.expectedTargetVersion,
        action: command.action,
      };
      let receipt: AdminDiscussionRemovalReceipt;
      let grantId: string | null = null;
      let postId: string | null = null;
      let rootId: string | null = null;
      let targetVersion: string | null = null;
      if (cancel)
        receipt = {
          ...base,
          outcome: 'rejected',
          code: 'ADMIN_DISCUSSION_REMOVAL_CANCELLED',
        };
      else {
        const initial = await observeAdminDiscussionRemovalInputs(
          {
            actor,
            grantId: null,
            target: command.target,
            requestId: command.clientRequestId,
          },
          tx,
        );
        const resolved = await this.resolve(command.target, actor, tx);
        const selected = await this.grant(
          actor,
          resolved.region_id,
          command.target,
          command.clientRequestId,
          tx,
        );
        await retainAdminDiscussionRemovalInputs(initial, tx);
        await retainAdminDiscussionRemovalInputs(selected, tx);
        grantId = selected.grantId;
        postId = resolved.post_id;
        rootId = resolved.root_id;
        targetVersion = resolved.target_version;
        if (targetVersion !== command.expectedTargetVersion)
          receipt = {
            ...base,
            outcome: 'rejected',
            code: 'ADMIN_DISCUSSION_REMOVAL_STALE',
          };
        else {
          const now = (
            await tx.query<{ now: Date }>(
              "SELECT date_trunc('milliseconds',clock_timestamp()) now",
            )
          ).rows[0]!.now;
          receipt = {
            ...base,
            outcome: 'applied',
            eventId: randomUUID(),
            recordedAt: now.toISOString(),
          };
        }
      }
      const inserted = await tx.query<{ before_target_version: string | null }>(
        `INSERT INTO whaleu_community.admin_discussion_removal_commands(actor_id,request_id,session_id,token_hash,target_kind,target_id,grant_id,intent_hash,command,receipt)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING before_target_version`,
        [
          actor,
          command.clientRequestId,
          session.sessionId,
          hashToken(token),
          command.target.kind,
          command.target.id,
          grantId,
          hash,
          command,
          receipt,
        ],
      );
      if (
        inserted.rowCount !== 1 ||
        inserted.rows[0]!.before_target_version !== targetVersion
      )
        throw new ApplicationError('ADMIN_DISCUSSION_REMOVAL_UNAVAILABLE');
      if (receipt.outcome === 'applied') {
        if (command.target.kind === 'comment')
          await tx.query(
            'DELETE FROM whaleu_community.comment_pins WHERE post_id=$1 AND comment_id=$2',
            [postId, command.target.id],
          );
        const changed = await tx.query(
          command.target.kind === 'comment'
            ? 'UPDATE whaleu_community.root_comments SET deleted_at=$2 WHERE id=$1 AND deleted_at IS NULL'
            : 'UPDATE whaleu_community.replies SET deleted_at=$2 WHERE id=$1 AND deleted_at IS NULL',
          [command.target.id, receipt.recordedAt],
        );
        if (changed.rowCount !== 1)
          throw new ApplicationError('ADMIN_DISCUSSION_REMOVAL_UNAVAILABLE');
        await tx.query(
          `INSERT INTO whaleu_community.admin_discussion_removal_events(id,actor_id,request_id,subject_id,target_kind,target_id,post_id,root_id,original_region_id,grant_id,recorded_at)
           SELECT $3,actor_id,request_id,subject_id,target_kind,target_id,post_id,root_id,original_region_id,grant_id,$4 FROM whaleu_community.admin_discussion_removal_commands WHERE actor_id=$1 AND request_id=$2`,
          [actor, command.clientRequestId, receipt.eventId, receipt.recordedAt],
        );
        await this.repository.event(
          `admin-discussion-removal:${receipt.eventId}`,
          'admin_discussion_removed',
          command.target.id,
          tx,
          {
            cause: 'admin_discussion_removal',
            eventId: receipt.eventId,
            kind: command.target.kind,
            postId,
            rootCommentId: rootId,
            obligations: ['content_invalidation', 'media_cleanup'],
          },
        );
      }
      retainAdminDiscussionRemovalCommand(actor, command.clientRequestId, tx);
      return adminDiscussionRemovalReceiptSchema.parse(receipt);
    });
  }
  async recovery(token: string, requestId: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      const row = (
        await tx.query<{ receipt: AdminDiscussionRemovalReceipt }>(
          'SELECT receipt FROM whaleu_community.admin_discussion_removal_commands WHERE actor_id=$1 AND request_id=$2',
          [session.accountId, requestId],
        )
      ).rows[0];
      return row
        ? {
            state: 'recorded' as const,
            receipt: adminDiscussionRemovalReceiptSchema.parse(row.receipt),
          }
        : { state: 'not_recorded' as const };
    });
  }
}
