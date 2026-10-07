import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { BlockState } from './contracts.js';
import { SafetyRepository } from './repository.js';

export type ProfileRelationship =
  | { status: 'available' }
  | { status: 'blocked_by_you'; relationship: BlockState & { blocked: true } }
  | { status: 'unavailable' };

/** Real named-profile policy, independent of content approval. Never exports
 * incoming actor IDs or a general-purpose private-account relationship oracle. */
@Injectable()
export class ProfileVisibilityFacade {
  constructor(
    @Inject(SafetyRepository) private readonly records: SafetyRepository,
  ) {}

  async read(
    viewer: string | null,
    target: string,
    tx: PoolClient,
  ): Promise<ProfileRelationship> {
    if (!viewer || viewer === target) return { status: 'available' };
    const directions = await this.records.directions(
      viewer,
      target,
      'public_profile',
      tx,
    );
    if (!directions) throw new ApplicationError('SAFETY_UNAVAILABLE');
    if (directions.outgoing) {
      const relationship = await this.records.outgoingReference(
        viewer,
        target,
        tx,
      );
      if (!relationship) throw new ApplicationError('SAFETY_UNAVAILABLE');
      return { status: 'blocked_by_you', relationship };
    }
    return { status: directions.incoming ? 'unavailable' : 'available' };
  }
}
