import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import { IdentityService } from '../identity/identity.service.js';
import type { OwnVerificationSummary } from './contracts.js';
import { VerificationRepository } from './verification.repository.js';

@Injectable()
export class VerificationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(VerificationRepository)
    private readonly records: VerificationRepository,
  ) {}
  async ownSummary(token: string): Promise<OwnVerificationSummary> {
    try {
      return await this.database.transaction(async (transaction) => {
        const actor = await this.identity.session(token, transaction);
        const result = await this.records.read(actor.accountId, transaction);
        await this.identity.session(token, transaction);
        return result.summary;
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    }
  }
}
