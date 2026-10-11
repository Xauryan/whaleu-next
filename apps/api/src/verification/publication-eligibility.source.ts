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
  recordedInstitution(
    accountId: string,
    assertionId: string,
    publishedAt: Date,
    tx: PoolClient,
  ): Promise<string | null> {
    return this.repository.recordedPublicationInstitution(
      accountId,
      assertionId,
      publishedAt,
      tx,
    );
  }
  resolve(accountId: string, tx: PoolClient): Promise<PublicationAffiliation> {
    return this.repository.publicationAffiliation(accountId, tx);
  }
}
