import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { SafetyPhoneEligibility } from './contracts.js';
import { VerificationRepository } from './verification.repository.js';

/** Narrow verification-owned facade; callers keep and recheck the deadline at commit. */
@Injectable()
export class LocalSafetyPhoneSource {
  constructor(
    @Inject(VerificationRepository)
    private readonly records: VerificationRepository,
  ) {}

  resolve(
    accountId: string,
    transaction: PoolClient,
  ): Promise<SafetyPhoneEligibility> {
    return this.records.phone(accountId, transaction);
  }
}
