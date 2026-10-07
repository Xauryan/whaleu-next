import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { VerificationRepository } from './verification.repository.js';
/** Internal affiliation provenance only. No phone values or student numbers. */
export type PublicationAffiliation =
  | {
      status: 'verified';
      assertionId: string;
      snapshotId: string;
      institutionId: string;
      originRegionId: string;
      validUntil: number | null;
    }
  | { status: 'unverified' | 'unavailable' };
@Injectable()
export class LocalPublicationEligibilitySource {
  constructor(
    @Inject(VerificationRepository)
    private readonly repository: VerificationRepository,
  ) {}
  resolve(accountId: string, tx: PoolClient): Promise<PublicationAffiliation> {
    return this.repository.publicationAffiliation(accountId, tx);
  }
}
