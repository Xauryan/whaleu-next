import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { SafetyPhoneEligibility } from './contracts.js';
import { VerificationRepository } from './verification.repository.js';
export interface ReportEligibility {
  phone: SafetyPhoneEligibility;
  affiliation: SafetyPhoneEligibility;
}
/** The facade deliberately never queries student-number data or profile campus. */
@Injectable()
export class LocalReportEligibilitySource {
  constructor(
    @Inject(VerificationRepository)
    private readonly repository: VerificationRepository,
  ) {}
  resolve(accountId: string, tx: PoolClient): Promise<ReportEligibility> {
    return this.repository.reportEligibility(accountId, tx);
  }
}
