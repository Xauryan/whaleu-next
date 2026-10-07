import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ProfileRepository } from './profile.repository.js';
/** Internal profile projection for a separately authorized and audited identity view. */
@Injectable()
export class AccountIdentityProfileService {
  constructor(
    @Inject(ProfileRepository) private readonly repository: ProfileRepository,
  ) {}
  find(
    accountId: string,
    transaction: PoolClient,
  ): Promise<{ nickname: string | null } | null> {
    return this.repository.identityProfile(accountId, transaction);
  }
}
