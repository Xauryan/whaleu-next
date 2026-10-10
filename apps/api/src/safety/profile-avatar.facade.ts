import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { requiredOwnerEpoch } from '../database/required-owner-proof.js';
import { safetyCountProofOwner } from './count-epochs.js';
import { SafetyRepository } from './repository.js';
const current = requiredOwnerEpoch(safetyCountProofOwner, 'SAFETY_UNAVAILABLE');
/** Profile media writes require the current actor gate, independently of any
 * Community space/publication entitlement or phone verification. */
@Injectable()
export class ProfileAvatarSafetyFacade {
  constructor(
    @Inject(SafetyRepository) private readonly records: SafetyRepository,
  ) {}
  async requireAllowed(actor: string, tx: PoolClient): Promise<void> {
    await current(tx);
    await this.records.restriction(actor, tx);
  }
}
