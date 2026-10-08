import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { SafetyRepository } from './repository.js';

/** Directory reads require canonical account restriction coverage. No person
 * projection is returned and no manager-wide named-block policy is invented. */
@Injectable()
export class SafetyDirectoryReadFacade {
  constructor(
    @Inject(SafetyRepository) private readonly records: SafetyRepository,
  ) {}
  async requireAllowed(accountId: string, tx: PoolClient): Promise<void> {
    await this.records.restriction(accountId, tx);
  }
}
