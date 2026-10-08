import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { SafetyRepository } from './repository.js';
/** Current account restriction coverage only; no phone, student or home-region gate. */
@Injectable()
export class SafetyAnnouncementReadFacade {
  constructor(
    @Inject(SafetyRepository) private readonly records: SafetyRepository,
  ) {}
  async requireAnnouncementReadAllowed(
    accountId: string,
    tx: PoolClient,
  ): Promise<void> {
    await this.records.restriction(accountId, tx);
  }
}
