import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { LocalSafetyPhoneSource } from '../verification/safety-phone.source.js';
import type { Decision } from './community-policy.js';
import { requireDecision } from './community-policy.js';

/** Common narrow phone proof, with no community-space or publication identity.
 * The verified deadline remains mandatory through the transaction final proof. */
export async function readPhoneContinuation(
  phones: Pick<LocalSafetyPhoneSource, 'resolve'>,
  accountId: string,
  tx: PoolClient,
): Promise<Decision<{ phoneVerified: boolean }>> {
  const phone = await phones.resolve(accountId, tx);
  if (phone.status === 'unavailable') return { kind: 'unavailable' };
  if (phone.status === 'verified')
    registerTransactionDeadline(
      tx,
      phone.validUntil,
      'PHONE_VERIFICATION_REQUIRED',
    );
  return {
    kind: 'allow',
    value: { phoneVerified: phone.status === 'verified' },
  };
}
@Injectable()
export class CommunityPhoneContinuation {
  constructor(
    @Inject(LocalSafetyPhoneSource)
    private readonly phones: LocalSafetyPhoneSource,
  ) {}
  async verified(accountId: string, tx: PoolClient): Promise<boolean> {
    return requireDecision(
      await readPhoneContinuation(this.phones, accountId, tx),
    ).phoneVerified;
  }
}
