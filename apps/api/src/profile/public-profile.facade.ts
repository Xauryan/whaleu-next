import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ExperiencePublicDisplayFacade } from '../experience/public-display.facade.js';
import { ApplicationError } from '../http/application-error.js';
import { preferencesSchema } from './contracts.js';
import { ProfileRepository } from './profile.repository.js';

/** Internal owner projection. accountId never belongs in a public response. */
export interface PublicProfileRecord {
  accountId: string;
  profileId: string;
  displayName: string;
  bio: string;
  hideProfilePosts: boolean;
}

interface DmProfileFact {
  profileId: string;
  fingerprint: string;
}
async function dmProfileState(profileId: string, tx: PoolClient, lock = false) {
  const row =
    (
      await tx.query<{
        account_id: string;
        public_id: string;
        revision: number;
        state_version: string;
      }>(
        `SELECT account_id,public_id,revision,xmin::text state_version FROM whaleu_profile.profiles WHERE public_id=$1${lock ? ' FOR SHARE' : ''}`,
        [profileId],
      )
    ).rows[0] ?? null;
  return ownerFingerprint(row);
}
const dmProfileProof: RequiredTransactionProof<DmProfileFact> = {
  maximumFacts: 128,
  failureCode: 'DM_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'DM_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_profile.profiles IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if ((await dmProfileState(fact.profileId, read)) !== fact.fingerprint)
          throw new ApplicationError('DM_UNAVAILABLE');
    }),
};

@Injectable()
export class PublicProfileFacade {
  constructor(
    @Inject(ProfileRepository) private readonly profiles: ProfileRepository,
    @Inject(ExperiencePublicDisplayFacade)
    private readonly experience: ExperiencePublicDisplayFacade,
  ) {}

  /** DM entry retains absence and revision across command-savepoint rollback. */
  async dmFind(
    profileId: string,
    tx: PoolClient,
  ): Promise<PublicProfileRecord | null> {
    enableRequiredTransactionProof(tx, dmProfileProof);
    const fingerprint = await dmProfileState(profileId, tx, true);
    registerRequiredTransactionFact(
      tx,
      dmProfileProof,
      `${profileId}:${fingerprint}`,
      Object.freeze({ profileId, fingerprint }),
    );
    return this.find(profileId, tx);
  }

  async find(
    profileId: string,
    tx: PoolClient,
  ): Promise<PublicProfileRecord | null> {
    const row = await this.profiles.publicProfile(profileId, tx);
    if (!row) return null;
    const preferences = preferencesSchema.safeParse(row.preferences);
    if (!preferences.success)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return {
      accountId: row.accountId,
      profileId: row.profileId,
      displayName: row.displayName,
      bio: row.bio,
      hideProfilePosts: preferences.data.hideProfilePosts,
    };
  }

  ownReference(accountId: string, tx: PoolClient): Promise<string | null> {
    return this.profiles.publicReference(accountId, tx);
  }

  experienceDisplay(accountId: string, tx: PoolClient) {
    return this.experience.read(accountId, tx);
  }
}
