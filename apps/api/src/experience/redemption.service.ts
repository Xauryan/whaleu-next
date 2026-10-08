import { Inject, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { DatabaseService } from '../database/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { ApplicationError } from '../http/application-error.js';
import { ExperienceClock, ExperienceRepository } from './repository.js';
import { RedemptionRepository } from './redemption.repository.js';
import {
  RedemptionProvider,
  RedemptionAttemptBudget,
  redemptionFingerprints,
  redeemableTitleKey,
  validRedemptionKey,
} from './redemption.provider.js';
import { lockExperienceOwner } from './ingress.js';
import type { RedemptionIntent, RedemptionReceipt } from './contracts.js';
@Injectable()
export class ExperienceRedemptionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(ExperienceRepository)
    private readonly records: ExperienceRepository,
    @Inject(ExperienceClock) private readonly clock: ExperienceClock,
    @Inject(RedemptionRepository)
    private readonly redemption: RedemptionRepository,
    @Inject(RedemptionProvider) private readonly provider: RedemptionProvider,
    @Inject(RedemptionAttemptBudget)
    private readonly budget: RedemptionAttemptBudget,
  ) {}
  capability(token: string) {
    return this.database.transaction(async (tx) => {
      await this.identity.session(token, tx);
      const key = this.provider.key();
      return {
        status:
          this.provider.available() &&
          key &&
          validRedemptionKey(key) &&
          this.budget.available()
            ? ('available' as const)
            : ('unavailable' as const),
      };
    });
  }
  redeem(token: string, input: RedemptionIntent): Promise<RedemptionReceipt> {
    return this.database.transaction(async (tx) => {
      const owner = (await this.identity.session(token, tx)).accountId;
      await this.records.requestLock(owner, input.requestId, tx);
      const prior = await this.records.request(owner, input.requestId, tx);
      if (prior && prior.operation !== 'redeem_title')
        throw new ApplicationError('EXPERIENCE_REQUEST_CONFLICT');
      if (!prior && (!this.provider.available() || !this.budget.available()))
        throw new ApplicationError('EXPERIENCE_REDEMPTION_UNAVAILABLE');
      const material = this.provider.key(
        prior?.intent_key_version ?? undefined,
      );
      const fingerprint =
        material && redemptionFingerprints(owner, input.code, material);
      if (
        !fingerprint ||
        (prior && fingerprint.version !== prior.intent_key_version)
      )
        throw new ApplicationError('EXPERIENCE_REDEMPTION_UNAVAILABLE');
      if (prior) {
        const expected = Buffer.from(prior.intent_hash, 'hex'),
          actual = Buffer.from(fingerprint.intent, 'hex');
        if (
          expected.length !== actual.length ||
          !timingSafeEqual(expected, actual)
        )
          throw new ApplicationError('EXPERIENCE_REQUEST_CONFLICT');
        return prior.receipt as RedemptionReceipt;
      }
      if (!(await this.budget.permit(owner)))
        throw new ApplicationError('EXPERIENCE_REDEMPTION_RATE_LIMITED');
      await lockExperienceOwner(tx, owner, true);
      const key = await this.provider.lookup(fingerprint.lookup);
      if (key !== null && key !== redeemableTitleKey)
        throw new ApplicationError('EXPERIENCE_REDEMPTION_UNAVAILABLE');
      const outcome =
        key === null
          ? 'invalid'
          : (await this.redemption.owned(owner, key, tx))
            ? 'already_owned'
            : 'granted';
      const at = (await this.clock.now(tx)).at;
      await this.redemption.decide(
        owner,
        input.requestId,
        key,
        outcome,
        at,
        tx,
      );
      const receipt: RedemptionReceipt =
        outcome === 'granted'
          ? {
              requestId: input.requestId,
              operation: 'redeem_title',
              outcome: 'granted',
              titleKey: key!,
            }
          : {
              requestId: input.requestId,
              operation: 'redeem_title',
              outcome: 'rejected',
              code:
                outcome === 'invalid'
                  ? 'EXPERIENCE_REDEMPTION_INVALID'
                  : 'EXPERIENCE_TITLE_ALREADY_OWNED',
            };
      await this.records.saveReceipt(
        owner,
        fingerprint.intent,
        receipt,
        tx,
        fingerprint.version,
      );
      return receipt;
    });
  }
}
