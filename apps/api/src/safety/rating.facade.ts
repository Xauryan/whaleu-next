import { ApplicationError } from '../http/application-error.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Decision } from '../community/community-policy.js';
import { SafetyRepository } from './repository.js';
import { safetyCountProofOwner } from './count-epochs.js';
import { requiredOwnerEpoch } from '../database/required-owner-proof.js';
const navigation = requiredOwnerEpoch(
  safetyCountProofOwner,
  'SAFETY_UNAVAILABLE',
);
/** Negative relationships/coverage retain the same bounded epoch as allows.
 * Anonymous callers never submit hidden author IDs to this facade. */
@Injectable()
export class RatingSafetyFacade {
  constructor(
    @Inject(SafetyRepository) private readonly records: SafetyRepository,
  ) {}
  async requireAllowed(accountId: string, tx: PoolClient): Promise<void> {
    await navigation(tx);
    await this.records.restriction(accountId, tx);
  }
  /** Deletion persists explicit denials, so their coverage expiry must also be
   * retained through deferred constraint waits. Ordinary read behavior is unchanged. */
  async requireDeletionAllowed(
    accountId: string,
    tx: PoolClient,
  ): Promise<void> {
    await navigation(tx);
    try {
      await this.records.restriction(accountId, tx);
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        error.code === 'SAFETY_ACTION_RESTRICTED'
      ) {
        // restriction already holds this owner row lock. Re-read only its
        // coverage deadline; never expose restriction details across owners.
        const head = await this.records.head(accountId, tx);
        registerTransactionDeadline(
          tx,
          head?.valid_until?.getTime() ?? null,
          'SAFETY_UNAVAILABLE',
        );
      }
      throw error;
    }
  }
  /** Editing has the ordinary account restriction policy and may persist a
   * denial receipt. Retain negative coverage through final deferred waits too. */
  async requireEditAllowed(accountId: string, tx: PoolClient): Promise<void> {
    await this.requireDeletionAllowed(accountId, tx);
  }
  navigation(tx: PoolClient): Promise<string> {
    return navigation(tx);
  }
  async named(
    viewer: string,
    author: string,
    purpose: 'rating_list' | 'rating_direct',
    tx: PoolClient,
  ): Promise<Decision> {
    await navigation(tx);
    if (
      !z.uuid().safeParse(viewer).success ||
      !z.uuid().safeParse(author).success ||
      !['rating_list', 'rating_direct'].includes(purpose)
    )
      return { kind: 'unavailable' };
    const directions = await this.records.directions(
      viewer,
      author,
      purpose,
      tx,
    );
    if (!directions) return { kind: 'unavailable' };
    return directions.outgoing ||
      (purpose === 'rating_direct' && directions.incoming)
      ? { kind: 'deny', reason: 'RATING_NOT_FOUND' }
      : { kind: 'allow', value: undefined };
  }
}
