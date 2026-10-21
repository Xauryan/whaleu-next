import { CommunitySocialSourceCapture } from '../social-source/capture.js';
import { enforceAccountPunishment } from '../../safety/account-moderation/policy.js';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { PublicProfileFacade } from '../../profile/public-profile.facade.js';
import { ProfileVisibilityFacade } from '../../safety/profile-visibility.facade.js';
import { SafetyRepository } from '../../safety/repository.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import {
  AccountPolicy,
  AccountPolicyFor,
  booleanAccountPolicy,
} from '../../safety/account-policy/decorator.js';
import { ApplicationError } from '../../http/application-error.js';
import { followRejectionCodes } from './contracts.js';
import type {
  FollowState,
  FollowReceipt,
  FollowRejectionCode,
} from './contracts.js';

interface StoredFollowReceipt {
  profile_id: string;
  following: boolean;
  outcome: 'applied' | 'rejected';
  code: FollowRejectionCode | null;
}

/** Serialize the actor's edge set, including absent edges, before any read/write.
 * Reads hold a shared lock through serialization; writes atomically advance the
 * cursor epoch and receipt. Request replays never reapply an old desired state. */
export async function lockFollowing(
  actor: string,
  tx: PoolClient,
  write = false,
) {
  await tx.query(
    `SELECT pg_advisory_xact_lock${write ? '' : '_shared'}(hashtextextended($1,0))`,
    [`whaleu:following:${actor}`],
  );
}
export async function followingRevision(actor: string, tx: PoolClient) {
  await lockFollowing(actor, tx);
  return (
    (
      await tx.query<{ revision: string }>(
        'SELECT revision::text FROM whaleu_community.follow_heads WHERE account_id=$1',
        [actor],
      )
    ).rows[0]?.revision ?? '0'
  );
}
@Injectable()
export class FollowingService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PublicProfileFacade) private readonly profiles: PublicProfileFacade,
    @Inject(ProfileVisibilityFacade)
    private readonly visibility: ProfileVisibilityFacade,
    @Inject(SafetyRepository) private readonly safety: SafetyRepository,
    @Inject(CommunitySocialSourceCapture)
    private readonly social: CommunitySocialSourceCapture,
  ) {}
  async eligibleAuthor(
    actor: string,
    target: string,
    tx: PoolClient,
  ): Promise<boolean> {
    return (
      (await this.identity.activeAccount(target, tx)) &&
      (await this.visibility.read(actor, target, tx)).status === 'available'
    );
  }
  async eligibleFeedAuthor(
    actor: string,
    target: string,
    tx: PoolClient,
  ): Promise<boolean> {
    // Feed scanning can already hold its own edge-set gate. Any additional
    // author lifecycle fence must therefore be nonblocking, before profiles.
    if (!(await this.lockTargetAccount(target, tx))) return false;
    const reference = await this.profiles.ownReference(target, tx);
    if (!reference) return false;
    const profile = await this.profiles.find(reference, tx);
    return (
      !!profile &&
      !profile.hideProfilePosts &&
      (await this.eligibleAuthor(actor, target, tx))
    );
  }
  /** ID-only discovery must not use PublicProfileFacade.find: that projection
   * owns a profile row lock, which belongs after the lifecycle fence. */
  private async locateTarget(
    actor: string,
    profileId: string,
    following: boolean,
    tx: PoolClient,
  ): Promise<string | null> {
    return (
      (
        await tx.query<{ account_id: string }>(
          following
            ? 'SELECT account_id FROM whaleu_profile.profiles WHERE public_id=$1'
            : 'SELECT followed_id AS account_id FROM whaleu_community.user_follows WHERE follower_id=$1 AND followed_profile_id=$2',
          following ? [profileId] : [actor, profileId],
        )
      ).rows[0]?.account_id ?? null
    );
  }
  private async lockTargetAccount(account: string, tx: PoolClient) {
    const row = (
      await tx.query<{ status: string; lifecycle: string }>(
        'SELECT status,lifecycle FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE NOWAIT',
        [account],
      )
    ).rows[0];
    return row?.status === 'active' && row.lifecycle === 'active';
  }
  private async previous(actor: string, requestId: string, tx: PoolClient) {
    return (
      (
        await tx.query<StoredFollowReceipt>(
          'SELECT profile_id,following,outcome,code FROM whaleu_community.follow_requests WHERE account_id=$1 AND request_id=$2',
          [actor, requestId],
        )
      ).rows[0] ?? null
    );
  }
  private async target(
    actor: string,
    profileId: string,
    located: string | null,
    active: boolean,
    tx: PoolClient,
  ) {
    if (!located || !active) throw new ApplicationError('POST_NOT_FOUND');
    const profile = await this.profiles.find(profileId, tx);
    if (profile && profile.accountId !== located)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (!profile || !(await this.eligibleAuthor(actor, profile.accountId, tx)))
      throw new ApplicationError('POST_NOT_FOUND');
    return profile;
  }
  @AccountPolicy('browse', 'entry')
  status(token: string, profileId: string): Promise<FollowState> {
    return this.database.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      enableSafetyRelationshipProof(tx);
      const actor = (await this.identity.session(token, tx)).accountId;
      const located = await this.locateTarget(actor, profileId, true, tx);
      const active = located
        ? await this.lockTargetAccount(located, tx)
        : false;
      await lockFollowing(actor, tx);
      const profile = await this.target(actor, profileId, located, active, tx);
      const following =
        (
          await tx.query(
            'SELECT 1 FROM whaleu_community.user_follows WHERE follower_id=$1 AND followed_id=$2',
            [actor, profile.accountId],
          )
        ).rowCount === 1;
      return { profileId, following };
    });
  }
  @AccountPolicyFor(
    (args) =>
      booleanAccountPolicy(args[2], 'interaction', 'protective_cleanup'),
    'owner_after_recovery',
  )
  set(
    token: string,
    profileId: string,
    following: boolean,
    requestId: string,
  ): Promise<FollowReceipt> {
    return this.database.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      enableSafetyRelationshipProof(tx);
      const actor = (await this.identity.session(token, tx)).accountId;
      // An immutable receipt can be recovered even after its target disappears.
      // Probe without a target lock, then reread under the actor edge-set gate.
      const observed = await this.previous(actor, requestId, tx);
      const located = observed
        ? null
        : await this.locateTarget(actor, profileId, following, tx);
      const active = located
        ? await this.lockTargetAccount(located, tx)
        : false;
      await lockFollowing(actor, tx, true);
      const previous = await this.previous(actor, requestId, tx);
      if (previous) {
        if (
          previous.profile_id !== profileId ||
          previous.following !== following
        )
          throw new BadRequestException('Request identity conflicts');
        // Historical acknowledgement, not a current-state oracle. No target data.
        return previous.outcome === 'applied'
          ? { requestId, profileId, following, outcome: 'applied' }
          : {
              requestId,
              profileId,
              following,
              outcome: 'rejected',
              code: previous.code!,
            };
      }
      // A concurrent positive command may have changed an initially absent
      // edge. Do not acquire its account lock late while holding the edge gate.
      if (
        !following &&
        (await this.locateTarget(actor, profileId, false, tx)) !== located
      )
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      const record = async (receipt: FollowReceipt): Promise<FollowReceipt> => {
        await tx.query(
          'INSERT INTO whaleu_community.follow_requests(account_id,request_id,profile_id,following,outcome,code) VALUES($1,$2,$3,$4,$5,$6)',
          [
            actor,
            requestId,
            profileId,
            following,
            receipt.outcome,
            receipt.outcome === 'rejected' ? receipt.code : null,
          ],
        );
        return receipt;
      };
      let target: string | null = null;
      // Only known policy decisions observed before any edge mutation can settle
      // a rejected intent. Owner proof/deadlines remain enrolled through commit.
      try {
        await enforceAccountPunishment(
          actor,
          following ? 'interaction' : 'protective_cleanup',
          tx,
        );
        if (following) {
          target = (await this.target(actor, profileId, located, active, tx))
            .accountId;
          if (target === actor)
            return record({
              requestId,
              profileId,
              following,
              outcome: 'rejected',
              code: 'FOLLOW_SELF_NOT_ALLOWED',
            });
          await this.safety.restriction(actor, tx);
        }
      } catch (error) {
        if (
          !(error instanceof ApplicationError) ||
          !(followRejectionCodes as readonly string[]).includes(error.code)
        )
          throw error;
        return record({
          requestId,
          profileId,
          following,
          outcome: 'rejected',
          code: error.code as FollowRejectionCode,
        });
      }
      const changed = following
        ? await tx.query(
            'INSERT INTO whaleu_community.user_follows(follower_id,followed_id,followed_profile_id,source_request_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            [actor, target!, profileId, requestId],
          )
        : await tx.query(
            'DELETE FROM whaleu_community.user_follows WHERE follower_id=$1 AND followed_profile_id=$2',
            [actor, profileId],
          );
      if (changed?.rowCount)
        await tx.query(
          'INSERT INTO whaleu_community.follow_heads(account_id,revision) VALUES($1,1) ON CONFLICT(account_id) DO UPDATE SET revision=follow_heads.revision+1',
          [actor],
        );
      const receipt = await record({
        requestId,
        profileId,
        following,
        outcome: 'applied',
      });
      if (following && changed.rowCount)
        await this.social.follow(actor, target!, profileId, requestId, tx);
      return receipt;
    });
  }
}
