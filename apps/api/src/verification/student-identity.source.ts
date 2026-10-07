import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  StudentIdentitySource,
  VerifiedStudentIdentity,
} from '../identity-privacy/contracts.js';
import { VerificationRepository } from './verification.repository.js';

/** Narrow module facade. All raw facts/provenance remain owned by verification. */
@Injectable()
export class LocalStudentIdentitySource implements StudentIdentitySource {
  constructor(
    @Inject(VerificationRepository)
    private readonly records: VerificationRepository,
  ) {}
  async resolve(
    accountId: string,
    transaction: PoolClient,
  ): Promise<VerifiedStudentIdentity> {
    const result = await this.records.read(accountId, transaction);
    const status = result.summary.studentNumber.status;
    if (status === 'verified' && result.studentNumber !== null)
      return {
        status: 'verified',
        studentNumber: result.studentNumber,
        validUntil: result.studentNumberValidUntil,
      };
    return { status: status === 'unavailable' ? 'unavailable' : 'unverified' };
  }
}
