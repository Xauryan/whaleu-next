import { AccountPolicy } from '../../safety/account-policy/decorator.js';
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
import { lockAvatarActor } from '../avatar/current-proof.js';
import { moderationIntentHash, violationNickname } from './evidence.js';
import {
  moderationManagementSchema,
  moderationReceiptSchema,
} from './contracts.js';
import type {
  ModerationCommand,
  ModerationManagement,
  ModerationReceipt,
  ModerationTarget,
} from './contracts.js';
import {
  retainModerationIdentity,
  observeModerationInputs,
  retainModerationInputs,
  retainModerationProfile,
  retainModerationCommand,
} from './proof.js';
import type { InputFact, ProfileFact } from './proof.js';

@Injectable()
export class ProfileModerationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(ProfileModerationTargetFacade)
    private readonly targets: ProfileModerationTargetFacade,
    @Inject(ProfileRepository) private readonly profiles: ProfileRepository,
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
              error.constraint === 'profile_moderation_causal'))
        )
          throw new ApplicationError('PROFILE_MODERATION_UNAVAILABLE');
        throw error;
      });
  }
  private async session(token: string, tx: PoolClient) {
    const session = await this.identity.session(token, tx);
    await retainModerationIdentity(
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
    target: ModerationTarget,
    tx: PoolClient,
  ): Promise<InputFact & { grantId: string }> {
    const grants = await this.authorization.grants(actor, tx);
    const row = (
      await tx.query<{ id: string; fingerprint: string }>(
        `SELECT id,whaleu_profile.moderation_hash(whaleu_profile.moderation_input_facts($2,id,$4,$5)) fingerprint FROM whaleu_authorization.role_grants WHERE id=ANY($1::uuid[]) AND whaleu_profile.moderation_grant_allowed($2,id,$3) ORDER BY CASE role WHEN 'super_admin' THEN 0 ELSE 1 END,id LIMIT 1 FOR SHARE`,
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
    if (!row) throw new ApplicationError('PROFILE_MODERATION_UNAVAILABLE');
    return row;
  }
  @AccountPolicy('privileged_read', 'entry')
  async management(
    token: string,
    target: ModerationTarget,
  ): Promise<ModerationManagement> {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      if (await this.targets.relatedUnsupported(target, session.accountId, tx))
        return moderationManagementSchema.parse({
          target,
          canReset: false,
          availability: 'unavailable',
          blocker: 'related_sync_unsupported',
        });

      const initialInputs = await observeModerationInputs(
        { actor: session.accountId, grantId: null, target },
        tx,
      );
      const resolved = await this.targets.resolve(
        target,
        session.accountId,
        tx,
      );
      const selectedInputs = await this.grant(
        session.accountId,
        resolved.originalRegionId,
        target,
        tx,
      );
      await retainModerationInputs(initialInputs, tx);
      await retainModerationInputs(selectedInputs, tx);
      const profile = await this.profile(resolved.subjectId, tx, false);
      if (profile.revision >= 2147483647)
        throw new ApplicationError('PROFILE_MODERATION_UNAVAILABLE');
      await retainModerationProfile(resolved.subjectId, tx, {
        subject: resolved.subjectId,
        fingerprint: profile.fingerprint,
        avatar: profile.avatar,
      });
      return moderationManagementSchema.parse({
        target,
        displayName: profile.display_name,
        revision: profile.revision,
        canReset: true,
      });
    });
  }
  @AccountPolicy('content_management', 'owner_after_recovery')
  async command(
    token: string,
    command: ModerationCommand,
    cancel = false,
  ): Promise<ModerationReceipt> {
    return this.run(async (tx) => {
      const session = await this.session(token, tx),
        actor = session.accountId,
        hash = moderationIntentHash(actor, command);
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:profile-moderation-request:v1:'||$1||':'||$2,0))",
        [actor, command.clientRequestId],
      );
      const previous = (
        await tx.query<{ intent_hash: string; receipt: ModerationReceipt }>(
          'SELECT intent_hash,receipt FROM whaleu_profile.moderation_commands WHERE actor_id=$1 AND request_id=$2',
          [actor, command.clientRequestId],
        )
      ).rows[0];
      if (previous) {
        if (previous.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        return moderationReceiptSchema.parse(previous.receipt);
      }
      const base = {
        requestId: command.clientRequestId,
        target: command.target,
        expectedProfileRevision: command.expectedProfileRevision,
        action: command.action,
      };
      let receipt: ModerationReceipt;
      let initialProfileHash: string | null = null;
      let initialProfileFingerprint: string | null = null;
      let initialProfileFact: ProfileFact | undefined;
      let grantId: string | null = null,
        subject: string | null = null,
        nickname: string | null = null;
      if (cancel)
        receipt = {
          ...base,
          outcome: 'rejected',
          code: 'PROFILE_MODERATION_CANCELLED',
        };
      else {
        if (await this.targets.relatedUnsupported(command.target, actor, tx))
          throw new ApplicationError('PROFILE_MODERATION_TARGET_NOT_ALLOWED');
        const initialInputs = await observeModerationInputs(
          { actor, grantId: null, target: command.target },
          tx,
        );
        const resolved = await this.targets.resolve(command.target, actor, tx);
        // A fresh stale intent still proves current exact authority first.
        const selectedInputs = await this.grant(
          actor,
          resolved.originalRegionId,
          command.target,
          tx,
        );
        grantId = selectedInputs.grantId;
        await retainModerationInputs(initialInputs, tx);
        await retainModerationInputs(selectedInputs, tx);
        subject = resolved.subjectId;
        const profile = await this.profile(subject, tx, true);
        initialProfileHash = profile.before_hash;
        initialProfileFingerprint = profile.fingerprint;
        initialProfileFact = {
          subject,
          fingerprint: profile.fingerprint,
          avatar: profile.avatar,
        };
        if (profile.revision !== command.expectedProfileRevision)
          receipt = {
            ...base,
            outcome: 'rejected',
            code: 'PROFILE_MODERATION_STALE',
          };
        else {
          const now = (
            await tx.query<{ now: Date }>(
              "SELECT date_trunc('milliseconds',clock_timestamp()) now",
            )
          ).rows[0]!.now;
          nickname = violationNickname();
          receipt = {
            ...base,
            outcome: 'applied',
            revision: profile.revision + 1,
            eventId: randomUUID(),
            recordedAt: now.toISOString(),
          };
        }
      }
      const inserted = await tx.query<{
        before_hash: string | null;
        before_fingerprint: string | null;
      }>(
        `INSERT INTO whaleu_profile.moderation_commands(actor_id,request_id,session_id,token_hash,target_kind,target_id,intent_hash,command,receipt,grant_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING before_hash,before_fingerprint`,
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
        ],
      );
      if (
        inserted.rowCount !== 1 ||
        inserted.rows[0]!.before_hash !== initialProfileHash ||
        inserted.rows[0]!.before_fingerprint !== initialProfileFingerprint
      )
        throw new ApplicationError('PROFILE_MODERATION_UNAVAILABLE');
      if (receipt.outcome === 'applied') {
        // The preceding target+row proof forbids the repository's creation path
        // from manufacturing an absent subject Profile. All normal Profile edits
        // and avatar choices share this exact CAS and actor advisory fence.
        await this.profiles.updateInTransaction(
          subject!,
          command.expectedProfileRevision,
          async () => ({ nickname: nickname! }),
          tx,
        );
        await tx.query(
          `INSERT INTO whaleu_profile.moderation_events(id,actor_id,request_id,subject_id,target_kind,target_id,post_id,root_id,original_region_id,grant_id,before_revision,revision,old_nickname,nickname,recorded_at)
          SELECT $3,actor_id,request_id,subject_id,target_kind,target_id,post_id,root_id,original_region_id,grant_id,before_revision,$4,before_nickname,$5,$6 FROM whaleu_profile.moderation_commands WHERE actor_id=$1 AND request_id=$2`,
          [
            actor,
            command.clientRequestId,
            receipt.eventId,
            receipt.revision,
            nickname,
            receipt.recordedAt,
          ],
        );
        await tx.query(
          `INSERT INTO whaleu_notifications.system_notice_owners(account_id) VALUES($1) ON CONFLICT DO NOTHING`,
          [subject],
        );
        await tx.query(
          'SELECT account_id FROM whaleu_notifications.system_notice_owners WHERE account_id=$1 FOR UPDATE',
          [subject],
        );
        await tx.query(
          `INSERT INTO whaleu_notifications.profile_moderation_notices(id,event_id,recipient_account_id,nickname,created_at) VALUES($1,$2,$3,$4,$5)`,
          [
            randomUUID(),
            receipt.eventId,
            subject,
            nickname,
            receipt.recordedAt,
          ],
        );
      }
      if (subject)
        await retainModerationProfile(
          subject,
          tx,
          receipt.outcome === 'rejected' ? initialProfileFact : undefined,
        );
      retainModerationCommand(actor, command.clientRequestId, tx);
      return moderationReceiptSchema.parse(receipt);
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  async recovery(token: string, requestId: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      const row = (
        await tx.query<{ receipt: ModerationReceipt }>(
          'SELECT receipt FROM whaleu_profile.moderation_commands WHERE actor_id=$1 AND request_id=$2',
          [session.accountId, requestId],
        )
      ).rows[0];
      return row
        ? {
            state: 'recorded' as const,
            receipt: moderationReceiptSchema.parse(row.receipt),
          }
        : { state: 'not_recorded' as const };
    });
  }
}
