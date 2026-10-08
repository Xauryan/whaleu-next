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

@Injectable()
export class PublicProfileFacade {
  constructor(
    @Inject(ProfileRepository) private readonly profiles: ProfileRepository,
    @Inject(ExperiencePublicDisplayFacade)
    private readonly experience: ExperiencePublicDisplayFacade,
  ) {}

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
