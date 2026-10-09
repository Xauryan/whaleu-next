import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ExperiencePublicDisplayFacade } from '../experience/public-display.facade.js';
import { ProfileRepository } from './profile.repository.js';
/** Public display only; never exports account facts, campus selection or preferences. */
@Injectable()
export class AuthorDisplayService {
  constructor(
    @Inject(ProfileRepository) private readonly repository: ProfileRepository,
    @Inject(ExperiencePublicDisplayFacade)
    private readonly experience: ExperiencePublicDisplayFacade,
  ) {}
  prepare(accountId: string, transaction: PoolClient) {
    return this.repository.authorDisplay(accountId, transaction);
  }
  find(accountId: string, transaction: PoolClient) {
    return this.repository.existingAuthorDisplay(accountId, transaction);
  }
  findRatingPublic(accountId: string, transaction: PoolClient) {
    return this.repository.ratingAuthorDisplay(accountId, transaction);
  }
  /** Named-public callers have already applied their own visibility policy. */
  async findPublic(accountId: string, transaction: PoolClient) {
    const display = await this.repository.existingAuthorDisplay(
      accountId,
      transaction,
    );
    if (!display) return null;
    return {
      profileId: display.profileId,
      displayName: display.displayName,
      experienceDisplay: await this.experience.read(accountId, transaction),
    };
  }
}
