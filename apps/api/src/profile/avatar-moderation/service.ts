import { AccountPolicy } from '../../safety/account-policy/decorator.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { MediaRequiredProof } from '../../media/required-proof.js';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { hashToken } from '../../identity/tokens.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { ApplicationError } from '../../http/application-error.js';
import { ProfileModerationTargetFacade } from '../../community/profile-moderation-target.facade.js';
import { ProfileRepository } from '../profile.repository.js';
import { ProfileAvatarService } from '../avatar/service.js';
import { avatarModerationClearAppearanceId } from '../avatar/repository.js';
import type { AvatarDefinition } from '../avatar/repository.js';
import {
  avatarModerationClearDigest,
  avatarModerationClearEnvelopeSchema,
} from '../avatar/contracts.js';
import { lockAvatarActor } from '../avatar/current-proof.js';
import {
  withAvatarModerationMediaMutation,
  avatarModerationTargetAuthorization,
  avatarModerationOriginalMediaEpoch,
} from '../../media/avatar-moderation-proof.js';
import { avatarModerationIntentHash } from './evidence.js';
import {
  avatarModerationManagementSchema,
  avatarModerationReceiptSchema,
} from './contracts.js';
import type {
  AvatarModerationCommand,
  AvatarModerationManagement,
  AvatarModerationReceipt,
  AvatarModerationTarget,
} from './contracts.js';
import {
  retainAvatarModerationIdentity,
  observeAvatarModerationInputs,
  retainAvatarModerationInputs,
  retainAvatarModerationProfile,
  retainAvatarModerationCommand,
} from './proof.js';
import type { InputFact, ProfileFact } from './proof.js';

@Injectable()
export class ProfileAvatarModerationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(ProfileModerationTargetFacade)
    private readonly targets: ProfileModerationTargetFacade,
    @Inject(ProfileRepository) private readonly profiles: ProfileRepository,
    @Inject(ProfileAvatarService) private readonly avatar: ProfileAvatarService,
  ) {}
  private run<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    return this.database
      .transaction(work, { isolationLevel: 'read committed' })
      .catch((error: unknown) => {
        if (
          error instanceof ApplicationError &&
          error.code === 'PROFILE_MODERATION_TARGET_NOT_ALLOWED'
        )
          throw new ApplicationError(
            'PROFILE_AVATAR_MODERATION_TARGET_NOT_ALLOWED',
          );
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (['55P03', '40001', '40P01'].includes(String(error.code)) ||
            ('constraint' in error &&
              error.constraint === 'profile_avatar_moderation_causal'))
        )
          throw new ApplicationError('PROFILE_AVATAR_MODERATION_UNAVAILABLE');
        throw error;
      });
  }
  private async session(token: string, tx: PoolClient) {
    const session = await this.identity.session(token, tx);
    await retainAvatarModerationIdentity(
      {
        actor: session.accountId,
        sessionId: session.sessionId,
        tokenHash: hashToken(token),
      },
      tx,
    );
    return session;
  }
  private async grant(
    actor: string,
    region: string,
    target: AvatarModerationTarget,
    tx: PoolClient,
  ): Promise<InputFact & { grantId: string }> {
    const grants = await this.authorization.grants(actor, tx);
    const row = (
      await tx.query<{ id: string; fingerprint: string }>(
        `SELECT id,whaleu_profile.moderation_hash(whaleu_profile.avatar_moderation_input_facts($2,id,$4,$5)) fingerprint FROM whaleu_authorization.role_grants WHERE id=ANY($1::uuid[]) AND whaleu_profile.moderation_grant_allowed($2,id,$3) ORDER BY CASE role WHEN 'super_admin' THEN 0 ELSE 1 END,id LIMIT 1 FOR SHARE`,
        [grants.map((g) => g.id), actor, region, target.kind, target.id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    return Object.freeze({
      actor,
      target,
      grantId: row.id,
      fingerprint: row.fingerprint,
    });
  }
  private async profile(subject: string, tx: PoolClient, write: boolean) {
    if (write) await lockAvatarActor(subject, tx);
    else
      await tx.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('whaleu:profile-avatar:actor:v1:'||$1,0))",
        [subject],
      );
    const row = (
      await tx.query<{
        revision: number;
        display_name: string;
        fingerprint: string;
        avatar: string;
        before_hash: string;
      }>(
        `SELECT revision,coalesce(nickname,'鲸鱼用户') display_name,whaleu_profile.moderation_hash(jsonb_build_array(to_jsonb(p),p.xmin::text,p.ctid::text)) fingerprint,whaleu_profile.moderation_hash(to_jsonb(p)) before_hash,whaleu_profile.moderation_hash(whaleu_profile.moderation_avatar_facts(p.account_id)) avatar FROM whaleu_profile.profiles p WHERE account_id=$1 AND public_id IS NOT NULL FOR ${write ? 'UPDATE' : 'SHARE'}`,
        [subject],
      )
    ).rows[0];
    if (!row)
      throw new ApplicationError('PROFILE_AVATAR_MODERATION_UNAVAILABLE');
    return row;
  }
  /** Removal proves ownership/pointer, never that the old image remains approved.
   * A held/revoked old image must still be removable. This grants no preview. */
  private async custom(
    subject: string,
    definition: AvatarDefinition | null,
    tx: PoolClient,
  ): Promise<boolean> {
    if (!definition || definition.source.kind !== 'custom') return false;
    const row = (
      await tx.query<{ valid: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM whaleu_media.bindings b JOIN whaleu_media.assets a ON a.id=b.asset_id JOIN whaleu_profile.avatar_edits e ON e.id=a.resource_id AND e.actor_id=a.actor_id WHERE b.id=$1 AND b.asset_id=$2 AND b.manifest_digest=$3 AND b.owner_kind='profile' AND b.resource_kind='avatar' AND b.resource_id=$4 AND b.content_version=1 AND b.slot='avatar' AND b.ordinal=0 AND b.detached_at IS NULL AND a.actor_id=$5 AND a.owner_kind='profile' AND a.resource_kind='avatar' AND a.slot='avatar' AND e.id=$6 AND NOT EXISTS(SELECT 1 FROM whaleu_media.bindings extra WHERE extra.asset_id=a.id AND extra.id<>b.id)) valid`,
        [
          definition.binding_id,
          definition.source.assetId,
          definition.source.manifestDigest,
          definition.id,
          subject,
          definition.source.editId,
        ],
      )
    ).rows[0];
    if (row?.valid !== true)
      throw new ApplicationError('PROFILE_AVATAR_MODERATION_UNAVAILABLE');
    return true;
  }
  @AccountPolicy('privileged_read', 'entry')
  async management(
    token: string,
    target: AvatarModerationTarget,
  ): Promise<AvatarModerationManagement> {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      if (await this.targets.relatedUnsupported(target, session.accountId, tx))
        return avatarModerationManagementSchema.parse({
          target,
          canClearCustomAvatar: false,
          availability: 'unavailable',
          blocker: 'related_sync_unsupported',
        });

      const initial = await observeAvatarModerationInputs(
        { actor: session.accountId, grantId: null, target },
        tx,
      );
      const resolved = await this.targets.resolve(
        target,
        session.accountId,
        tx,
      );
      const selected = await this.grant(
        session.accountId,
        resolved.originalRegionId,
        target,
        tx,
      );
      await retainAvatarModerationInputs(initial, tx);
      await retainAvatarModerationInputs(selected, tx);
      const profile = await this.profile(resolved.subjectId, tx, false);
      if (profile.revision >= 2147483647)
        throw new ApplicationError('PROFILE_AVATAR_MODERATION_UNAVAILABLE');
      const definition = await this.avatar.repository.current(
        resolved.subjectId,
        tx,
      );
      const applicable = await this.custom(resolved.subjectId, definition, tx);
      if (applicable) await new MediaRequiredProof().capture(tx);
      await retainAvatarModerationProfile(resolved.subjectId, tx, {
        subject: resolved.subjectId,
        fingerprint: profile.fingerprint,
        avatar: profile.avatar,
      });
      return avatarModerationManagementSchema.parse({
        target,
        displayName: profile.display_name,
        revision: profile.revision,
        canClearCustomAvatar: applicable,
        expectedAppearanceId: applicable ? definition!.id : null,
      });
    });
  }
  @AccountPolicy('content_management', 'owner_after_recovery')
  async command(
    token: string,
    command: AvatarModerationCommand,
    cancel = false,
  ): Promise<AvatarModerationReceipt> {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        actor = session.accountId,
        hash = avatarModerationIntentHash(actor, command);
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:profile-avatar-moderation-request:v1:'||$1||':'||$2,0))",
        [actor, command.clientRequestId],
      );
      const previous = (
        await tx.query<{
          intent_hash: string;
          receipt: AvatarModerationReceipt;
        }>(
          'SELECT intent_hash,receipt FROM whaleu_profile.avatar_moderation_commands WHERE actor_id=$1 AND request_id=$2',
          [actor, command.clientRequestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        return avatarModerationReceiptSchema.parse(previous.receipt);
      }
      const base = {
        requestId: command.clientRequestId,
        target: command.target,
        expectedProfileRevision: command.expectedProfileRevision,
        expectedAppearanceId: command.expectedAppearanceId,
        action: command.action,
      };
      const insert = async (
        receipt: AvatarModerationReceipt,
        grantId: string | null,
        beforeHash: string | null,
        beforeFingerprint: string | null,
        beforeAvatar: string | null,
      ) => {
        const result = await tx.query<{
          before_hash: string | null;
          before_fingerprint: string | null;
          avatar_hash: string | null;
        }>(
          `INSERT INTO whaleu_profile.avatar_moderation_commands(actor_id,request_id,session_id,token_hash,target_kind,target_id,intent_hash,command,receipt,grant_id,media_before_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING before_hash,before_fingerprint,avatar_hash`,
          [
            actor,
            command.clientRequestId,
            session.sessionId,
            hashToken(token),
            command.target.kind,
            command.target.id,
            hash,
            command,
            receipt,
            grantId,
            cancel ? null : avatarModerationOriginalMediaEpoch(tx),
          ],
        );
        if (
          result.rowCount !== 1 ||
          result.rows[0]!.before_hash !== beforeHash ||
          result.rows[0]!.before_fingerprint !== beforeFingerprint ||
          result.rows[0]!.avatar_hash !== beforeAvatar
        )
          throw new ApplicationError('PROFILE_AVATAR_MODERATION_UNAVAILABLE');
      };
      if (cancel) {
        const receipt: AvatarModerationReceipt = {
          ...base,
          outcome: 'rejected',
          code: 'PROFILE_AVATAR_MODERATION_CANCELLED',
        };
        await insert(receipt, null, null, null, null);
        retainAvatarModerationCommand(actor, command.clientRequestId, tx);
        return receipt;
      }
      // Existing Media writers acquire this gate before the subject avatar lock.
      // Acquire it before source observations too; no shared-to-exclusive upgrade
      // is allowed after the subject CAS fence. Terminal replay/cancel above stay
      // session-only and never wait on source/Media policy availability.
      await lockSafetyPolicy(tx, true);
      return withAvatarModerationMediaMutation(tx, command.target, async () => {
        const initial = await observeAvatarModerationInputs(
          { actor, grantId: null, target: command.target },
          tx,
        );
        const resolved = await avatarModerationTargetAuthorization(
          tx,
          command.target,
          () =>
            this.targets.resolveAvatarCommand(
              command.target,
              actor,
              command.clientRequestId,
              tx,
            ),
        );
        const selected = await this.grant(
          actor,
          resolved.originalRegionId,
          command.target,
          tx,
        );
        await retainAvatarModerationInputs(
          { ...initial, requestId: command.clientRequestId },
          tx,
        );
        await retainAvatarModerationInputs(
          { ...selected, requestId: command.clientRequestId },
          tx,
        );
        const subject = resolved.subjectId,
          profile = await this.profile(subject, tx, true);
        const initialProfile: ProfileFact = {
          subject,
          fingerprint: profile.fingerprint,
          avatar: profile.avatar,
        };
        const previousDefinition = await this.avatar.repository.current(
          subject,
          tx,
        );
        const applicable = await this.custom(subject, previousDefinition, tx);
        let receipt: AvatarModerationReceipt;
        if (profile.revision !== command.expectedProfileRevision)
          receipt = {
            ...base,
            outcome: 'rejected',
            code: 'PROFILE_AVATAR_MODERATION_STALE',
          };
        else if (
          !applicable ||
          previousDefinition?.id !== command.expectedAppearanceId
        )
          receipt = {
            ...base,
            outcome: 'rejected',
            code: 'PROFILE_AVATAR_MODERATION_NOT_APPLICABLE',
          };
        else {
          if (await this.targets.relatedUnsupported(command.target, actor, tx))
            throw new ApplicationError(
              'PROFILE_AVATAR_MODERATION_TARGET_NOT_ALLOWED',
            );
          const now = (
            await tx.query<{ now: Date }>(
              "SELECT date_trunc('milliseconds',clock_timestamp()) now",
            )
          ).rows[0]!.now;
          receipt = {
            ...base,
            outcome: 'applied',
            revision: profile.revision + 1,
            eventId: randomUUID(),
            recordedAt: now.toISOString(),
          };
        }
        await insert(
          receipt,
          selected.grantId,
          profile.before_hash,
          profile.fingerprint,
          profile.avatar,
        );
        if (receipt.outcome === 'applied') {
          const replacement =
            await this.avatar.assets.prepareProfileReplacement(
              subject,
              {
                ownerKind: 'profile',
                resourceKind: 'avatar',
                resourceId: previousDefinition!.id,
                contentVersion: 1,
              },
              null,
              tx,
            );
          await this.profiles.updateInTransaction(
            subject,
            command.expectedProfileRevision,
            async () => ({}),
            tx,
          );
          const appearanceId = avatarModerationClearAppearanceId(
            actor,
            command.clientRequestId,
            subject,
          );
          const envelope = avatarModerationClearEnvelopeSchema.parse({
            version: 1,
            purpose: 'moderate_profile_avatar_clear',
            accountId: subject,
            moderatorAccountId: actor,
            clientRequestId: command.clientRequestId,
            eventId: receipt.eventId,
            target: command.target,
            originalRegionId: resolved.originalRegionId,
            expectedRevision: command.expectedProfileRevision,
            appearanceId,
            previousAppearanceId: previousDefinition!.id,
            slot: 'avatar',
            source: { kind: 'clear' },
          });
          await this.avatar.repository.replace(
            {
              id: appearanceId,
              actor_id: subject,
              authority: 'scoped_moderation_clear',
              source: { kind: 'clear' },
              envelope,
              digest: avatarModerationClearDigest(envelope),
              binding_id: null,
            },
            tx,
          );
          await this.avatar.assets.finishProfileReplacement(replacement, tx);
          await tx.query(
            `INSERT INTO whaleu_profile.avatar_moderation_events(id,actor_id,request_id,subject_id,target_kind,target_id,post_id,root_id,original_region_id,grant_id,before_revision,revision,previous_appearance_id,appearance_id,old_binding_id,recorded_at) SELECT $3,actor_id,request_id,subject_id,target_kind,target_id,post_id,root_id,original_region_id,grant_id,before_revision,$4,$5,$6,$7,$8 FROM whaleu_profile.avatar_moderation_commands WHERE actor_id=$1 AND request_id=$2`,
            [
              actor,
              command.clientRequestId,
              receipt.eventId,
              receipt.revision,
              previousDefinition!.id,
              appearanceId,
              previousDefinition!.binding_id,
              receipt.recordedAt,
            ],
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
            'INSERT INTO whaleu_notifications.profile_avatar_moderation_notices(id,event_id,recipient_account_id,created_at) VALUES($1,$2,$3,$4)',
            [randomUUID(), receipt.eventId, subject, receipt.recordedAt],
          );
        }
        await retainAvatarModerationProfile(
          subject,
          tx,
          receipt.outcome === 'rejected' ? initialProfile : undefined,
        );
        retainAvatarModerationCommand(actor, command.clientRequestId, tx);
        return avatarModerationReceiptSchema.parse(receipt);
      });
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  async recovery(token: string, requestId: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      const row = (
        await tx.query<{ receipt: AvatarModerationReceipt }>(
          'SELECT receipt FROM whaleu_profile.avatar_moderation_commands WHERE actor_id=$1 AND request_id=$2',
          [session.accountId, requestId],
        )
      ).rows[0];
      return row
        ? {
            state: 'recorded' as const,
            receipt: avatarModerationReceiptSchema.parse(row.receipt),
          }
        : { state: 'not_recorded' as const };
    });
  }
}
