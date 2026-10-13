import { requireContentDistributionGrant } from '../../authorization/content-distribution-grant.js';
import { punishmentReferenceSchema } from '../../safety/account-moderation/contracts.js';
import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { enforceAccountPunishment } from '../../safety/account-moderation/policy.js';
import { requireUnprotectedAccountPunishmentTarget } from '../../authorization/account-punishment-target-protection.js';
import {
  removalPunishmentOptions,
  removalPunishmentOwner,
} from './punishment.js';
import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
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
import { adminPostRemovalIntentHash } from './evidence.js';
import {
  adminPostRemovalManagementSchema,
  adminPostRemovalReceiptSchema,
} from './contracts.js';
import type {
  AdminPostRemovalCommand,
  AdminPostRemovalManagement,
  AdminPostRemovalReceipt,
  AdminPostRemovalTarget,
} from './contracts.js';
import {
  retainAdminPostRemovalIdentity,
  observeAdminPostRemovalInputs,
  retainAdminPostRemovalInputs,
  retainAdminPostRemovalCommand,
} from './proof.js';
import type { InputFact } from './proof.js';

const campusProof = requiredOwnerEpoch(
  campusCountProofOwner,
  'ADMIN_POST_REMOVAL_UNAVAILABLE',
);
const safetyProof = requiredOwnerEpoch(
  safetyCountProofOwner,
  'ADMIN_POST_REMOVAL_UNAVAILABLE',
);

/** Content administration is independent from public Profile moderation. In
 * particular an anonymous post never becomes a public account locator. */
@Injectable()
export class AdminPostRemovalService {
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
        // These exact issuer outcomes abort the complete removal transaction.
        // Preserve their public retry/selection semantics instead of leaking SQL.
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === '23514' &&
          'constraint' in error
        ) {
          if (error.constraint === 'account_punishment_permanent')
            throw new ApplicationError('SAFETY_MODERATION_PERMANENT');
          if (error.constraint === 'account_punishment_stale')
            throw new ApplicationError('SAFETY_MODERATION_STALE');
          if (error.constraint === 'account_punishment_duration')
            throw new BadRequestException('Invalid punishment duration');
          if (error.constraint === 'account_punishment_causal')
            throw new ApplicationError('SAFETY_MODERATION_UNAVAILABLE');
        }
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (['55P03', '40001', '40P01'].includes(String(error.code)) ||
            ('constraint' in error &&
              error.constraint === 'admin_post_removal_causal'))
        )
          throw new ApplicationError('ADMIN_POST_REMOVAL_UNAVAILABLE');
        throw error;
      });
  }
  private async session(token: string, tx: PoolClient) {
    const session = await this.identity.session(token, tx);
    await retainAdminPostRemovalIdentity(
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
    target: AdminPostRemovalTarget,
    actor: string,
    tx: PoolClient,
  ) {
    await lockSafetyPolicy(tx);
    await campusProof(tx);
    await safetyProof(tx);
    const { post, space } = await this.access.accessiblePost(
      target.id,
      actor,
      tx,
      true,
    );
    if (post.account_id === actor)
      throw new ApplicationError('ADMIN_POST_REMOVAL_OWN_POST');
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
      throw new ApplicationError('ADMIN_POST_REMOVAL_TARGET_NOT_ALLOWED');
    const row = (
      await tx.query<{
        subject_id: string;
        post_id: string;
        region_id: string;
        target_version: string;
      }>(
        'SELECT t.*,whaleu_community.admin_post_removal_target_version($1) target_version FROM whaleu_community.admin_post_removal_target($1) t WHERE whaleu_community.admin_post_removal_supported($2,$1)',
        [target.id, actor],
      )
    ).rows[0];
    if (
      !row ||
      row.subject_id !== post.account_id ||
      row.post_id !== post.id ||
      row.region_id !== space.operatingRegionId
    )
      throw new ApplicationError('ADMIN_POST_REMOVAL_TARGET_NOT_ALLOWED');
    requireAction(
      await this.access.authority(actor, space, tx),
      'publish_post',
    );
    return Object.freeze(row);
  }
  private async grant(
    actor: string,
    region: string,
    target: AdminPostRemovalTarget,
    requestId: string | null,
    tx: PoolClient,
    viewSpaceId?: string,
  ): Promise<InputFact & { grantId: string }> {
    if (viewSpaceId) {
      const parent = (
        await tx.query<{ post_id: string }>(
          'SELECT post_id FROM whaleu_community.admin_post_removal_target($1)',
          [target.id],
        )
      ).rows[0];
      if (!parent)
        throw new ApplicationError('ADMIN_POST_REMOVAL_TARGET_NOT_ALLOWED');
      const selected = await requireContentDistributionGrant(
        actor,
        parent.post_id,
        viewSpaceId,
        tx,
      );
      const observed = await observeAdminPostRemovalInputs(
        { actor, grantId: selected.grantId, target, requestId, viewSpaceId },
        tx,
      );
      return Object.freeze({ ...observed, grantId: selected.grantId });
    }
    const grants = await this.authorization.grants(actor, tx);
    const row = (
      await tx.query<{ id: string }>(
        "SELECT id FROM whaleu_authorization.role_grants WHERE id=ANY($1::uuid[]) AND whaleu_profile.moderation_grant_allowed($2,id,$3) ORDER BY CASE role WHEN 'super_admin' THEN 0 ELSE 1 END,id LIMIT 1 FOR SHARE",
        [grants.map((g) => g.id), actor, region],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    const observed = await observeAdminPostRemovalInputs(
      { actor, grantId: row.id, target, requestId },
      tx,
    );
    return Object.freeze({ ...observed, grantId: row.id });
  }
  private async version(
    actor: string,
    grantId: string,
    target: AdminPostRemovalTarget,
    viewSpaceId: string,
    tx: PoolClient,
  ): Promise<string> {
    const row = (
      await tx.query<{ version: string }>(
        'SELECT whaleu_community.related_removal_target_version($1,$2,$3,$4,$5) version',
        [actor, grantId, target.kind, target.id, viewSpaceId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('ADMIN_POST_REMOVAL_UNAVAILABLE');
    return row.version;
  }
  @AccountPolicy('privileged_read', 'entry')
  async management(
    token: string,
    target: AdminPostRemovalTarget,
    withPunishment = false,
    viewSpaceId?: string,
  ): Promise<AdminPostRemovalManagement> {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      const initial = await observeAdminPostRemovalInputs(
        {
          actor: session.accountId,
          grantId: null,
          target,
          requestId: null,
          ...(viewSpaceId ? { viewSpaceId } : {}),
        },
        tx,
      );
      const resolved = await this.resolve(target, session.accountId, tx);
      const selected = await this.grant(
        session.accountId,
        resolved.region_id,
        target,
        null,
        tx,
        viewSpaceId,
      );
      await retainAdminPostRemovalInputs(initial, tx);
      await retainAdminPostRemovalInputs(selected, tx);
      return adminPostRemovalManagementSchema.parse({
        target,
        targetVersion: viewSpaceId
          ? await this.version(
              session.accountId,
              selected.grantId,
              target,
              viewSpaceId,
              tx,
            )
          : resolved.target_version,
        ...(viewSpaceId ? { version: 3, viewSpaceId } : {}),
        canRemove: true,
        ...(withPunishment && !viewSpaceId
          ? {
              punishmentOptions: await removalPunishmentOptions(
                resolved.subject_id,
                tx,
              ),
            }
          : {}),
      });
    });
  }
  @AccountPolicy('content_management', 'owner_after_recovery')
  async command(
    token: string,
    command: AdminPostRemovalCommand,
    cancel = false,
  ): Promise<AdminPostRemovalReceipt> {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        actor = session.accountId;
      const hash = adminPostRemovalIntentHash(actor, command);
      // Terminal outcomes and cancellation authenticate only the active account,
      // session and presented token. They never resolve a deleted source again.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:admin-post-removal-request:v1:'||$1||':'||$2,0))",
        [actor, command.clientRequestId],
      );
      const previous = (
        await tx.query<{
          intent_hash: string;
          receipt: AdminPostRemovalReceipt;
        }>(
          'SELECT intent_hash,receipt FROM whaleu_community.admin_post_removal_commands WHERE actor_id=$1 AND request_id=$2',
          [actor, command.clientRequestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        return adminPostRemovalReceiptSchema.parse(previous.receipt);
      }
      const base = {
        requestId: command.clientRequestId,
        target: command.target,
        expectedTargetVersion: command.expectedTargetVersion,
        action: command.action,
        ...('version' in command && command.version === 3
          ? { version: 3 as const, viewSpaceId: command.viewSpaceId }
          : 'version' in command && command.version === 2
            ? { version: 2 as const, selection: command.punishment }
            : {}),
      };
      let receipt: AdminPostRemovalReceipt;
      let grantId: string | null = null;
      let subject: string | null = null;
      let targetVersion: string | null = null;
      if (cancel)
        receipt = {
          ...base,
          outcome: 'rejected',
          code: 'ADMIN_POST_REMOVAL_CANCELLED',
        };
      else {
        await enforceAccountPunishment(actor, 'content_management', tx);
        const initial = await observeAdminPostRemovalInputs(
          {
            actor,
            grantId: null,
            target: command.target,
            requestId: command.clientRequestId,
            ...('version' in command && command.version === 3
              ? { viewSpaceId: command.viewSpaceId }
              : {}),
          },
          tx,
        );
        // Retain the first negative role observation before content or grant waits.
        if ('version' in command && command.version === 2) {
          const subjectRow = (
            await tx.query<{ subject_id: string }>(
              'SELECT subject_id FROM whaleu_community.admin_post_removal_target($1)',
              [command.target.id],
            )
          ).rows[0];
          if (subjectRow)
            await requireUnprotectedAccountPunishmentTarget(
              subjectRow.subject_id,
              tx,
            );
        }
        const resolved = await this.resolve(command.target, actor, tx);
        const selected = await this.grant(
          actor,
          resolved.region_id,
          command.target,
          command.clientRequestId,
          tx,
          'version' in command && command.version === 3
            ? command.viewSpaceId
            : undefined,
        );
        await retainAdminPostRemovalInputs(initial, tx);
        await retainAdminPostRemovalInputs(selected, tx);
        grantId = selected.grantId;
        subject = resolved.subject_id;
        targetVersion =
          'version' in command && command.version === 3
            ? await this.version(
                actor,
                grantId,
                command.target,
                command.viewSpaceId,
                tx,
              )
            : resolved.target_version;
        if (targetVersion !== command.expectedTargetVersion)
          receipt = {
            ...base,
            outcome: 'rejected',
            code: 'ADMIN_POST_REMOVAL_STALE',
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
            ...('version' in command && command.version === 2
              ? {
                  version: 2 as const,
                  selection: command.punishment,
                  punishment: {
                    punishmentId: randomUUID(),
                    kind: command.punishment.kind,
                    revision: (
                      BigInt(command.punishment.expectedRevision) + 1n
                    ).toString(),
                  },
                }
              : {}),
          };
        }
      }
      const inserted = await tx.query<{ before_target_version: string | null }>(
        `INSERT INTO whaleu_community.admin_post_removal_commands(actor_id,request_id,session_id,token_hash,target_id,grant_id,intent_hash,command,receipt)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING before_target_version`,
        [
          actor,
          command.clientRequestId,
          session.sessionId,
          hashToken(token),
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
        throw new ApplicationError('ADMIN_POST_REMOVAL_UNAVAILABLE');
      if (receipt.outcome === 'applied') {
        if (
          'version' in command &&
          command.version === 2 &&
          'punishment' in receipt
        ) {
          const recordedPunishment = punishmentReferenceSchema.parse(
            receipt.punishment,
          );
          const issued = await removalPunishmentOwner.issueExact(
            {
              actorId: actor,
              sessionId: session.sessionId,
              tokenHash: hashToken(token),
              grantId: grantId!,
              requestId: command.clientRequestId,
              subjectId: subject!,
              sourceKind: command.target.kind,
              sourceId: command.target.id,
              sourceEventId: receipt.eventId,
              recordedAt: receipt.recordedAt,
            },
            command.punishment,
            tx,
          );
          if (
            issued.punishmentId !== recordedPunishment.punishmentId ||
            issued.revision !== recordedPunishment.revision
          )
            throw new ApplicationError('SAFETY_MODERATION_UNAVAILABLE');
        }

        await tx.query(
          'DELETE FROM whaleu_community.comment_pins WHERE post_id=$1',
          [command.target.id],
        );
        const changed = await tx.query(
          'UPDATE whaleu_community.posts SET deleted_at=$2 WHERE id=$1 AND deleted_at IS NULL',
          [command.target.id, receipt.recordedAt],
        );
        if (changed.rowCount !== 1)
          throw new ApplicationError('ADMIN_POST_REMOVAL_UNAVAILABLE');
        await tx.query(
          `INSERT INTO whaleu_community.admin_post_removal_events(id,actor_id,request_id,subject_id,target_id,original_region_id,grant_id,recorded_at)
           SELECT $3,actor_id,request_id,subject_id,target_id,original_region_id,grant_id,$4 FROM whaleu_community.admin_post_removal_commands WHERE actor_id=$1 AND request_id=$2`,
          [actor, command.clientRequestId, receipt.eventId, receipt.recordedAt],
        );
        await this.repository.event(
          `admin-post-removal:${receipt.eventId}`,
          'admin_post_removed',
          command.target.id,
          tx,
          {
            cause: 'admin_post_removal',
            eventId: receipt.eventId,
            kind: 'post',
            postId: command.target.id,
            obligations: ['content_invalidation', 'media_cleanup'],
          },
        );
        await tx.query(
          'INSERT INTO whaleu_notifications.system_notice_owners(account_id) VALUES($1) ON CONFLICT DO NOTHING',
          [subject],
        );
        await tx.query(
          'SELECT account_id FROM whaleu_notifications.system_notice_owners WHERE account_id=$1 FOR UPDATE',
          [subject],
        );
        await tx.query(
          'INSERT INTO whaleu_notifications.admin_post_removal_notices(id,event_id,recipient_account_id,created_at) VALUES($1,$2,$3,$4)',
          [randomUUID(), receipt.eventId, subject, receipt.recordedAt],
        );
      }
      retainAdminPostRemovalCommand(actor, command.clientRequestId, tx);
      return adminPostRemovalReceiptSchema.parse(receipt);
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  async recovery(token: string, requestId: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      const row = (
        await tx.query<{ receipt: AdminPostRemovalReceipt }>(
          'SELECT receipt FROM whaleu_community.admin_post_removal_commands WHERE actor_id=$1 AND request_id=$2',
          [session.accountId, requestId],
        )
      ).rows[0];
      return row
        ? {
            state: 'recorded' as const,
            receipt: adminPostRemovalReceiptSchema.parse(row.receipt),
          }
        : { state: 'not_recorded' as const };
    });
  }
}
