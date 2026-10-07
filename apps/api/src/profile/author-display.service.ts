import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ProfileRepository } from './profile.repository.js';
/** Public display only; never exports account facts, campus selection or preferences. */
@Injectable()
export class AuthorDisplayService {
  constructor(
    @Inject(ProfileRepository) private readonly repository: ProfileRepository,
  ) {}
  prepare(accountId: string, transaction: PoolClient) {
    return this.repository.authorDisplay(accountId, transaction);
  }
  find(accountId: string, transaction: PoolClient) {
    return this.repository.existingAuthorDisplay(accountId, transaction);
  }
}
