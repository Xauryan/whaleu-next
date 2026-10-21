import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { referenceTargetSchema } from './contracts.js';
import type { ReferenceAllocation, ReferenceTarget } from './contracts.js';
import { ContentReferenceRepository } from './repository.js';

@Injectable()
export class ContentReferenceAllocation {
  constructor(
    @Inject(ContentReferenceRepository)
    private readonly references: ContentReferenceRepository,
  ) {}
  /** Trusted publication hook, inside publication_work after successful create
   * and its business locks. Never called by receipt replay, review-only or read.
   * Lock order: existing business owners -> policy -> sequence -> reservations.
   * No initializer/importer exists in the production runtime. */
  async allocateForPublication(
    target: ReferenceTarget,
    tx: PoolClient,
  ): Promise<ReferenceAllocation> {
    try {
      const parsed = referenceTargetSchema.parse(target);
      const observed = await this.references.policy(tx);
      if (observed.state === 'inactive') {
        // Compatible inactive writers share a fence; they do not serialize.
        // If initialization won the race, retry the entire publication rather
        // than upgrading a shared lock and creating an allocator deadlock.
        const fenced = await this.references.policy(tx, 'share');
        if (fenced.state !== 'inactive')
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        return { state: 'inactive' };
      }
      const policy = await this.references.policy(tx, 'update');
      if (policy.state === 'inactive')
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      return {
        state: 'allocated',
        code: await this.references.allocate(parsed, tx),
      };
    } catch {
      // This is deliberately not a permanent invalid-content receipt. The full
      // publication transaction must roll back on unavailable allocation.
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }
  }
}
