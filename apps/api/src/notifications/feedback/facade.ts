import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { ApplicationError } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import { FeedbackNoticeAuthority } from './authority.js';
import { feedbackPublicationNoticeSchema } from './contracts.js';
import type { FeedbackPublicationNotice } from './contracts.js';
import { FeedbackNoticesRepository } from './repository.js';

/** Local simulation only. Called exactly on fresh approved feedback creation in
 * Community's existing transaction; no provider, opt-in guess or independent commit.
 * The publication owner acquires the existing Safety writer gate before actor
 * locks, so multi-recipient account proofs cannot invert concurrent publishers. */
@Injectable()
export class FeedbackNotificationsFacade {
  constructor(
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(FeedbackNoticeAuthority)
    private readonly authority: FeedbackNoticeAuthority,
    @Inject(FeedbackNoticesRepository)
    private readonly repository: FeedbackNoticesRepository,
  ) {}
  async recordPublication(
    input: FeedbackPublicationNotice,
    tx: PoolClient,
  ): Promise<void> {
    try {
      const parsed = feedbackPublicationNoticeSchema.parse(input);
      const candidates =
        await this.authorization.feedbackRecipientAccountIds(tx);
      const recipients: { accountId: string; grantId: string }[] = [];
      for (const accountId of [...new Set(candidates)].sort()) {
        if (!(await this.identity.activeAccount(accountId, tx))) continue;
        const grant = await this.authority.current(accountId, tx);
        if (grant) recipients.push({ accountId, grantId: grant.id });
      }
      // Retain all authoritative account/grant proofs before notification-owner
      // locks; sorted owners make multi-recipient publications deterministic.
      for (const recipient of recipients) {
        await this.repository.owner(recipient.accountId, tx, true);
        await this.repository.append(
          parsed,
          recipient.accountId,
          recipient.grantId,
          tx,
        );
      }
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('SYSTEM_NOTICES_UNAVAILABLE');
    }
  }
}
