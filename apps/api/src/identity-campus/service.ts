import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { IdentityService } from '../identity/identity.service.js';
import { LocalPublicationEligibilitySource } from '../verification/publication-eligibility.source.js';
import { LocalSafetyPhoneSource } from '../verification/safety-phone.source.js';
import { SafetyRepository } from '../safety/repository.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { ApplicationError } from '../http/application-error.js';
import {
  IdentitySelectionRepository,
  identitySelectionIntentHash,
  identitySelectionRevision,
} from '../campus/community-policy/identity-selection.repository.js';
import type {
  IdentityCampusIntent,
  IdentityCampusReceipt,
  IdentityCampusState,
} from './contracts.js';

@Injectable()
export class IdentityCampusService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(LocalPublicationEligibilitySource)
    private readonly affiliations: LocalPublicationEligibilitySource,
    @Inject(LocalSafetyPhoneSource)
    private readonly phones: LocalSafetyPhoneSource,
    @Inject(SafetyRepository) private readonly safety: SafetyRepository,
    @Inject(IdentitySelectionRepository)
    private readonly campuses: IdentitySelectionRepository,
  ) {}
  private async eligibility(accountId: string, tx: PoolClient) {
    const affiliation = await this.affiliations.resolve(accountId, tx);
    if (affiliation.status === 'verified')
      registerTransactionDeadline(
        tx,
        affiliation.validUntil,
        'VERIFICATION_UNAVAILABLE',
      );
    const phone = await this.phones.resolve(accountId, tx);
    if (phone.status === 'verified')
      registerTransactionDeadline(
        tx,
        phone.validUntil,
        'VERIFICATION_UNAVAILABLE',
      );
    const safety = await this.safety.selectionEligibility(accountId, tx);
    return { affiliation, phone, safety };
  }
  state(token: string): Promise<IdentityCampusState> {
    return this.database.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      const actor = await this.identity.session(token, tx);
      const { affiliation, phone, safety } = await this.eligibility(
        actor.accountId,
        tx,
      );
      const facts =
        affiliation.status === 'verified'
          ? await this.campuses.own(actor.accountId, affiliation, tx)
          : null;
      const canSelect =
        affiliation.status === 'verified' &&
        facts?.writable === true &&
        facts.options.items.length > 0 &&
        phone.status === 'verified' &&
        safety.status === 'allowed';
      const reason =
        affiliation.status === 'unverified'
          ? 'affiliation_required'
          : affiliation.status === 'unavailable'
            ? 'affiliation_unavailable'
            : facts!.reason;
      const result: IdentityCampusState = {
        affiliation: affiliation.status,
        selection: facts?.selection ?? 'unavailable',
        reason,
        selectedCampus: facts?.selectedCampus ?? null,
        options: facts?.options ?? { status: 'unavailable', items: [] },
        writeEligibility: { phone: phone.status, safety: safety.status },
        canSelect,
        expectedStateRevision:
          canSelect && affiliation.status === 'verified'
            ? identitySelectionRevision(
                actor.accountId,
                facts!,
                affiliation,
                phone,
                safety.fingerprint,
              )
            : null,
        guidance:
          affiliation.status === 'unverified'
            ? 'await_affiliation'
            : canSelect
              ? facts?.selection === 'selection_required' ||
                reason === 'history_unknown'
                ? 'choose'
                : 'reselect'
              : affiliation.status === 'unavailable'
                ? 'unavailable'
                : 'refresh',
      };
      await this.identity.session(token, tx);
      return result;
    });
  }
  select(
    token: string,
    intent: IdentityCampusIntent,
  ): Promise<IdentityCampusReceipt> {
    return this.database.transaction(async (tx) => {
      // FIRST lock, before account/session/request rows. Never upgrade shared gate.
      await lockSafetyPolicy(tx, true);
      const actor = await this.identity.session(token, tx);
      const saved = await this.campuses.receipt(
        actor.accountId,
        intent.requestId,
        tx,
      );
      if (saved) {
        if (
          saved.intent_hash !== identitySelectionIntentHash(intent) ||
          saved.campus_id !== intent.campusId ||
          saved.expected_state_revision !== intent.expectedStateRevision
        )
          throw new ApplicationError('IDENTITY_CAMPUS_REQUEST_CONFLICT');
        await this.identity.session(token, tx);
        return this.campuses.receiptView(saved);
      }
      const { affiliation, phone, safety } = await this.eligibility(
        actor.accountId,
        tx,
      );
      if (phone.status === 'unverified')
        throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
      if (phone.status !== 'verified')
        throw new ApplicationError('VERIFICATION_UNAVAILABLE');
      if (safety.status === 'restricted')
        throw new ApplicationError('SAFETY_ACTION_RESTRICTED');
      if (safety.status !== 'allowed')
        throw new ApplicationError('SAFETY_UNAVAILABLE');
      if (affiliation.status === 'unverified')
        throw new ApplicationError('AFFILIATION_VERIFICATION_REQUIRED');
      if (affiliation.status !== 'verified')
        throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
      const facts = await this.campuses.own(
        actor.accountId,
        affiliation,
        tx,
        true,
      );
      if (!facts.writable)
        throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
      const revision = identitySelectionRevision(
        actor.accountId,
        facts,
        affiliation,
        phone,
        safety.fingerprint,
      );
      if (intent.expectedStateRevision !== revision)
        throw new ApplicationError('IDENTITY_CAMPUS_REVISION_CONFLICT');
      const receipt = await this.campuses.select(
        actor.accountId,
        intent,
        affiliation,
        facts,
        tx,
      );
      await this.identity.session(token, tx);
      return receipt;
    });
  }
  receipt(token: string, requestId: string): Promise<IdentityCampusReceipt> {
    return this.database.transaction(async (tx) => {
      await lockSafetyPolicy(tx);
      const actor = await this.identity.session(token, tx);
      const saved = await this.campuses.receipt(actor.accountId, requestId, tx);
      if (!saved)
        throw new ApplicationError('IDENTITY_CAMPUS_REQUEST_NOT_FOUND');
      await this.identity.session(token, tx);
      return this.campuses.receiptView(saved);
    });
  }
}
