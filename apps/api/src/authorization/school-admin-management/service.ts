import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { registerTransactionExactDeadline } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import { hashToken } from '../../identity/tokens.js';
import { ProfileAdminParticipantFacade } from '../../profile/admin-participant.facade.js';
import { LocalPublicationEligibilitySource } from '../../verification/publication-eligibility.source.js';
import { SchoolAdminScopeFacade } from '../../campus/school-admin-scope.facade.js';
import { SchoolAdminTitleEntitlementWriter } from '../../experience/school-admin-title.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { SchoolAdminManagementRepository } from './repository.js';
import { schoolAdminManagementIntentHash } from './evidence.js';
import {
  schoolAdminManagementReceiptSchema,
  schoolAdminManagementSchema,
} from './contracts.js';
import type {
  SchoolAdminManagement,
  SchoolAdminManagementCommand,
  SchoolAdminManagementReceipt,
} from './contracts.js';
import {
  observeManagementInputs,
  retainManagementInputs,
  retainManagementCommand,
  retainManagementIdentity,
} from './proof.js';
const unavailable = 'SCHOOL_ADMIN_MANAGEMENT_UNAVAILABLE' as const;
function boundedTimeout(value: string, maximum: number): string {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/.exec(value);
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    min: 60000,
    h: 3600000,
    d: 86400000,
  };
  if (!match) throw new ApplicationError(unavailable);
  const current = Number(match[1]) * units[match[2] ?? 'ms']!;
  if (!Number.isFinite(current)) throw new ApplicationError(unavailable);
  return `${Math.max(1, Math.min(current || maximum, maximum))}ms`;
}
@Injectable()
export class SchoolAdminManagementService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(ProfileAdminParticipantFacade)
    private readonly profiles: ProfileAdminParticipantFacade,
    @Inject(LocalPublicationEligibilitySource)
    private readonly verification: LocalPublicationEligibilitySource,
    @Inject(SchoolAdminScopeFacade)
    private readonly scope: SchoolAdminScopeFacade,
    @Inject(SchoolAdminTitleEntitlementWriter)
    private readonly titles: SchoolAdminTitleEntitlementWriter,
    @Inject(SchoolAdminManagementRepository)
    private readonly repository: SchoolAdminManagementRepository,
  ) {}
  private run<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    return this.database
      .transaction(
        async (tx) => {
          const settings = (
            await tx.query<{
              statement_timeout: string;
              lock_timeout: string;
              until: string;
            }>(
              "SELECT current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout,(clock_timestamp()+interval '15 seconds')::text until",
            )
          ).rows[0]!;
          await tx.query(
            "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
            [
              boundedTimeout(settings.statement_timeout, 5000),
              boundedTimeout(settings.lock_timeout, 3000),
            ],
          );
          registerTransactionExactDeadline(tx, settings.until, unavailable);
          return work(tx);
        },
        { isolationLevel: 'read committed' },
      )
      .catch((error: unknown) => {
        if (
          error instanceof ApplicationError &&
          [
            'ERRAND_UNAVAILABLE',
            'IDENTITY_CAMPUS_UNAVAILABLE',
            'COMMUNITY_SCOPE_UNAVAILABLE',
          ].includes(error.code)
        )
          throw new ApplicationError(unavailable);
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (['55P03', '57014', '40001', '40P01'].includes(String(error.code)) ||
            ('constraint' in error &&
              String(error.constraint).includes('school_admin')))
        )
          throw new ApplicationError(unavailable);
        throw error;
      });
  }
  private async session(token: string, tx: PoolClient) {
    const session = await this.identity.session(token, tx);
    await retainManagementIdentity(
      {
        actor: session.accountId,
        sessionId: session.sessionId,
        tokenHash: hashToken(token),
      },
      tx,
    );
    return session;
  }
  private async resolve(
    actor: string,
    targetProfile: string,
    request: string | null,
    includeEligibility: boolean,
    write: boolean,
    tx: PoolClient,
  ) {
    // A strict, current super candidate is checked before any public target read.
    // The complete role set is observed before locking, then locked canonically.
    const selected = await this.repository.candidateSuper(actor, tx);
    const initial = await observeManagementInputs(
      { actor, selected: null, targetProfile, request, includeEligibility },
      tx,
    );
    const target = await this.profiles.resolve(targetProfile, tx);
    if (!target)
      throw new ApplicationError('SCHOOL_ADMIN_MANAGEMENT_TARGET_NOT_ALLOWED');
    const active = await this.identity.activeAccount(target.accountId, tx);
    const locked = await this.repository.lockGrants(
      actor,
      target.accountId,
      selected,
      write,
      tx,
    );
    const selectedFact = await observeManagementInputs(
      { actor, selected, targetProfile, request, includeEligibility },
      tx,
    );
    retainManagementInputs(initial, tx);
    retainManagementInputs(selectedFact, tx);
    const schoolGrants = locked.targetGrants.filter(
      (grant) => grant.role === 'school_admin',
    );
    if (schoolGrants.length > 1) throw new ApplicationError(unavailable);
    const school = schoolGrants[0] ?? null;
    // Future/expired unrevoked globals are unsupported too: never infer a safe
    // downgrade from a filtered active-grant list or a highest-role label.
    const protectedTarget = locked.targetGrants.some(
      (grant) => grant.role !== 'school_admin',
    );
    let currentAssignment: SchoolAdminManagement['currentAssignment'] = null;
    if (school) {
      if (!school.regionId) throw new ApplicationError(unavailable);
      const region = await this.repository.region(school.regionId, tx);
      if (!region) throw new ApplicationError(unavailable);
      const now = (
        await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
      ).rows[0]!.now;
      if (school.current && includeEligibility && !write)
        registerTransactionExactDeadline(tx, school.expiresExact, unavailable);
      if (school.validFrom > now && !write)
        registerTransactionExactDeadline(
          tx,
          school.validFromExact,
          unavailable,
        );
      currentAssignment = {
        regionId: school.regionId,
        name: region.name,
        status: !region.active
          ? 'unavailable'
          : school.validFrom > now
            ? 'future'
            : school.expiresAt !== null && school.expiresAt <= now
              ? 'expired'
              : 'active',
      };
    }
    const stateVersion = await this.repository.stateVersion(targetProfile, tx);
    let eligibility: SchoolAdminManagement['eligibility'] = {
      status: 'unavailable',
      reason: active ? 'source_unavailable' : 'target_inactive',
      regions: [],
      defaultRegionId: null,
    };
    if (protectedTarget)
      eligibility = {
        ...eligibility,
        status: 'protected',
        reason: 'global_role_protected',
      };
    else if (includeEligibility && active) {
      const affiliation = await this.verification.resolve(target.accountId, tx);
      if (affiliation.status === 'verified') {
        const row = (
          await tx.query<{ until: string | null }>(
            'SELECT expires_at::text until FROM whaleu_verification.assertions WHERE id=$1',
            [affiliation.assertionId],
          )
        ).rows[0];
        if (!row) throw new ApplicationError(unavailable);
        registerTransactionExactDeadline(tx, row.until, unavailable);
        const scope = await this.scope.resolve(
          target.accountId,
          affiliation,
          tx,
        );
        eligibility = {
          status: scope.status,
          reason:
            scope.status === 'known'
              ? scope.regions.length
                ? null
                : 'no_eligible_regions'
              : 'source_unavailable',
          regions: scope.regions,
          defaultRegionId:
            currentAssignment &&
            scope.regions.some(
              (region) => region.id === currentAssignment.regionId,
            )
              ? currentAssignment.regionId
              : scope.defaultRegionId,
        };
      } else
        eligibility = {
          ...eligibility,
          status: affiliation.status,
          reason:
            affiliation.status === 'unverified'
              ? 'affiliation_not_verified'
              : 'source_unavailable',
        };
    }
    const eligible =
      eligibility.status === 'known' && eligibility.regions.length > 0;
    const management = schoolAdminManagementSchema.parse({
      target: { profileId: target.profileId, displayName: target.displayName },
      stateVersion,
      currentAssignment,
      eligibility,
      actions: {
        appoint: eligible && school === null,
        reassign: eligible && school !== null,
        revoke: !protectedTarget && school !== null,
      },
    });
    return {
      target,
      initial,
      selected,
      school,
      active,
      protectedTarget,
      management,
    };
  }
  management(
    token: string,
    targetProfile: string,
  ): Promise<SchoolAdminManagement> {
    return this.run(async (tx) => {
      await lockSafetyPolicy(tx);
      const session = await this.session(token, tx);
      return (
        await this.resolve(
          session.accountId,
          targetProfile,
          null,
          true,
          false,
          tx,
        )
      ).management;
    });
  }
  async command(
    token: string,
    command: SchoolAdminManagementCommand,
    cancel = false,
  ): Promise<SchoolAdminManagementReceipt> {
    // Recovery/cancel gets a separate active-only transaction. Fresh apply starts
    // again with the outer gate BEFORE any Identity or request row lock. Recheck
    // the same key under that gate, so a concurrent cancellation wins safely.
    const existing = await this.run(async (tx) => {
      const session = await this.session(token, tx),
        actor = session.accountId;
      const hash = schoolAdminManagementIntentHash(actor, command);
      await this.repository.requestLock(actor, command.clientRequestId, tx);
      const previous = await this.repository.request(
        actor,
        command.clientRequestId,
        tx,
      );
      if (previous) {
        if (previous.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        return schoolAdminManagementReceiptSchema.parse(previous.receipt);
      }
      if (!cancel) return null;
      const receipt = schoolAdminManagementReceiptSchema.parse({
        ...this.receiptBase(command),
        outcome: 'rejected',
        code: 'SCHOOL_ADMIN_MANAGEMENT_CANCELLED',
      });
      await this.repository.save(
        {
          actor,
          sessionId: session.sessionId,
          tokenHash: hashToken(token),
          command,
          hash,
          receipt,
          subject: null,
          actorGrant: null,
          initial: null,
          oldGrant: null,
          newGrant: null,
        },
        tx,
      );
      retainManagementCommand(actor, command.clientRequestId, tx);
      return receipt;
    });
    if (existing) return existing;
    return this.run(async (tx) => {
      await lockSafetyPolicy(tx, true);
      const session = await this.session(token, tx),
        actor = session.accountId;
      const hash = schoolAdminManagementIntentHash(actor, command);
      await this.repository.requestLock(actor, command.clientRequestId, tx);
      const previous = await this.repository.request(
        actor,
        command.clientRequestId,
        tx,
      );
      if (previous) {
        if (previous.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        return schoolAdminManagementReceiptSchema.parse(previous.receipt);
      }
      const resolved = await this.resolve(
        actor,
        command.targetProfileId,
        command.clientRequestId,
        command.action !== 'revoke',
        true,
        tx,
      );
      if (resolved.protectedTarget)
        throw new ApplicationError('SCHOOL_ADMIN_MANAGEMENT_INELIGIBLE');
      let receipt: SchoolAdminManagementReceipt;
      let newGrant: string | null = null;
      if (resolved.management.stateVersion !== command.expectedStateVersion)
        receipt = {
          ...this.receiptBase(command),
          outcome: 'rejected',
          code: 'SCHOOL_ADMIN_MANAGEMENT_STALE',
        };
      else {
        let changed: boolean;
        if (command.action === 'revoke') changed = resolved.school !== null;
        else {
          if (
            !resolved.active ||
            resolved.management.eligibility.status !== 'known' ||
            !resolved.management.eligibility.regions.some(
              (region) => region.id === command.regionId,
            )
          )
            throw new ApplicationError('SCHOOL_ADMIN_MANAGEMENT_INELIGIBLE');
          if (command.action === 'reassign' && !resolved.school)
            throw new ApplicationError('SCHOOL_ADMIN_MANAGEMENT_INELIGIBLE');
          if (
            command.action === 'appoint' &&
            resolved.school &&
            (!resolved.school.current ||
              resolved.school.regionId !== command.regionId)
          )
            throw new ApplicationError('SCHOOL_ADMIN_MANAGEMENT_INELIGIBLE');
          changed =
            !resolved.school ||
            !resolved.school.current ||
            resolved.school.regionId !== command.regionId;
          if (changed) newGrant = randomUUID();
          else if (resolved.school)
            registerTransactionExactDeadline(
              tx,
              resolved.school.expiresExact,
              unavailable,
            );
        }
        const titleGranted =
          command.action === 'revoke'
            ? false
            : await this.titles.missing(resolved.target.accountId, tx);
        const now = (
          await tx.query<{ now: Date }>(
            "SELECT date_trunc('milliseconds',clock_timestamp()) now",
          )
        ).rows[0]!.now;
        receipt = {
          ...this.receiptBase(command),
          outcome: changed ? 'applied' : 'unchanged',
          eventId: randomUUID(),
          recordedAt: now.toISOString(),
          titleGranted,
        };
      }
      await this.repository.save(
        {
          actor,
          sessionId: session.sessionId,
          tokenHash: hashToken(token),
          command,
          hash,
          receipt,
          subject: resolved.target.accountId,
          actorGrant: resolved.selected,
          initial: resolved.initial.facts,
          oldGrant: resolved.school?.id ?? null,
          newGrant,
        },
        tx,
      );
      if (receipt.outcome !== 'rejected') {
        if (receipt.outcome === 'applied' && resolved.school)
          await this.repository.revoke(
            resolved.school.id,
            actor,
            receipt.recordedAt,
            tx,
          );
        if (newGrant && command.action !== 'revoke')
          await this.repository.appoint(
            newGrant,
            resolved.target.accountId,
            command.regionId,
            actor,
            command.clientRequestId,
            tx,
          );
        if (command.action !== 'revoke')
          await this.titles.write(
            {
              actor,
              requestId: command.clientRequestId,
              owner: resolved.target.accountId,
              recordedAt: receipt.recordedAt,
              titleGranted: receipt.titleGranted,
            },
            tx,
          );
      }
      retainManagementCommand(actor, command.clientRequestId, tx);
      return schoolAdminManagementReceiptSchema.parse(receipt);
    });
  }
  private receiptBase(command: SchoolAdminManagementCommand) {
    return {
      requestId: command.clientRequestId,
      targetProfileId: command.targetProfileId,
      expectedStateVersion: command.expectedStateVersion,
      action: command.action,
      ...(command.action === 'revoke' ? {} : { regionId: command.regionId }),
    };
  }
  recovery(token: string, request: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      const row = await this.repository.request(session.accountId, request, tx);
      return row
        ? {
            state: 'recorded' as const,
            receipt: schoolAdminManagementReceiptSchema.parse(row.receipt),
          }
        : { state: 'not_recorded' as const };
    });
  }
}
