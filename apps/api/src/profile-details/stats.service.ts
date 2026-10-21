import { performance } from 'node:perf_hooks';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { PublicProfileFacade } from '../profile/public-profile.facade.js';
import { ProfileVisibilityFacade } from '../safety/profile-visibility.facade.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { enableSafetyRelationshipProof } from '../safety/relationship-proof.js';
import { AccountPolicy } from '../safety/account-policy/decorator.js';
import { ApplicationError } from '../http/application-error.js';
import {
  unavailableProfileStats,
  unavailableSocialCount,
} from './stats.contracts.js';
import type { OwnProfileStats, ProfileSocialCount } from './stats.contracts.js';
export const PROFILE_STATS_CANDIDATE_LIMIT = 1024;
// Scan-loop budget, not a hard total lock deadline: mandatory commit-time
// owner proofs retain their own bounded budgets after the callback returns.
export const PROFILE_STATS_BUDGET_MS = 1000;
class OptionalStatsUnavailable extends Error {}
@Injectable()
export class ProfileStatsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PublicProfileFacade) private readonly profiles: PublicProfileFacade,
    @Inject(ProfileVisibilityFacade)
    private readonly visibility: ProfileVisibilityFacade,
  ) {}
  @AccountPolicy('browse', 'entry')
  async own(token: string): Promise<OwnProfileStats> {
    try {
      return await this.database.transaction(
        async (tx) => {
          await lockSafetyPolicy(tx);
          enableSafetyRelationshipProof(tx);
          const actor = (await this.identity.session(token, tx)).accountId;
          const started = performance.now();
          const checkBudget = () => {
            if (performance.now() - started > PROFILE_STATS_BUDGET_MS)
              throw new OptionalStatsUnavailable();
          };
          // No partial graph total: inserts/deletes must wait until this snapshot and
          // all current target/relationship checks finish. Contention is optional,
          // never a reason to block a profile header indefinitely or invent zero.
          await tx.query("SET LOCAL statement_timeout='100ms'");
          await tx.query("SET LOCAL lock_timeout='25ms'");
          await tx.query(
            'LOCK TABLE whaleu_community.user_follows IN SHARE MODE NOWAIT',
          );
          const eligible = new Map<string, boolean>();
          const count = async (
            direction: 'following' | 'followers',
          ): Promise<ProfileSocialCount> => {
            const column =
              direction === 'following' ? 'follower_id' : 'followed_id';
            const target =
              direction === 'following' ? 'followed_id' : 'follower_id';
            const rows = (
              await tx.query<{ target: string }>(
                `SELECT ${target} AS target FROM whaleu_community.user_follows WHERE ${column}=$1 ORDER BY ${target} LIMIT $2`,
                [actor, PROFILE_STATS_CANDIDATE_LIMIT + 1],
              )
            ).rows;
            if (rows.length > PROFILE_STATS_CANDIDATE_LIMIT)
              return unavailableSocialCount();
            let value = 0;
            for (const row of rows) {
              if (performance.now() - started > PROFILE_STATS_BUDGET_MS)
                throw new OptionalStatsUnavailable();
              let allowed = eligible.get(row.target);
              if (allowed === undefined) {
                allowed = await this.eligible(
                  actor,
                  row.target,
                  tx,
                  checkBudget,
                );
                eligible.set(row.target, allowed);
              }
              if (allowed) value++;
            }
            return { status: 'known', value };
          };
          const following = await count('following'),
            followers = await count('followers');
          if (performance.now() - started > PROFILE_STATS_BUDGET_MS)
            throw new OptionalStatsUnavailable();
          return {
            accountId: actor,
            following,
            followers,
            receivedInteractions: unavailableSocialCount(),
          };
        },
        { isolationLevel: 'read committed' },
      );
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
      const optional =
        error instanceof OptionalStatsUnavailable ||
        ['55P03', '57014'].includes(String(code)) ||
        (error instanceof ApplicationError &&
          ['SAFETY_UNAVAILABLE', 'COMMUNITY_UNAVAILABLE'].includes(error.code));
      if (!optional) throw error;
      // The failed transaction has rolled back every lock/proof. Mandatory actor
      // authentication and sanctions are checked anew, never downgraded to guest.
      return this.database.transaction(async (tx) => {
        await lockSafetyPolicy(tx);
        const actor = (await this.identity.session(token, tx)).accountId;
        return unavailableProfileStats(actor);
      });
    }
  }
  private async eligible(
    actor: string,
    target: string,
    tx: PoolClient,
    checkBudget: () => void,
  ) {
    checkBudget();
    if (!(await this.identity.activeAccount(target, tx))) return false;
    checkBudget();
    const reference = await this.profiles.ownReference(target, tx);
    checkBudget();
    if (!reference || !(await this.profiles.find(reference, tx))) return false;
    checkBudget();
    const visible =
      (await this.visibility.read(actor, target, tx)).status === 'available';
    checkBudget();
    return visible;
  }
}
