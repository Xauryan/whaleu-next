import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { registerTransactionExactDeadline } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { hashToken } from '../identity/tokens.js';
import { ProfileAdminParticipantFacade } from '../profile/admin-participant.facade.js';
import { ProfileVisibilityFacade } from '../safety/profile-visibility.facade.js';
import { enableSafetyRelationshipProof } from '../safety/relationship-proof.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { AccountPolicy } from '../safety/account-policy/decorator.js';
import { enforceAccountPunishment } from '../safety/account-moderation/policy.js';
import { SchoolAdminManagementRepository } from '../authorization/school-admin-management/repository.js';
import { retainManagementIdentity } from '../authorization/school-admin-management/proof.js';
import { CampusStudentVerificationFacade } from '../campus/student-verification.facade.js';
import {
  SchoolIdentityVerificationFacade,
  schoolIdentityCorrectionIds,
} from '../verification/school-identity.facade.js';
import { lockStudentAccount } from '../verification/student/current-proof.js';
import { SchoolUidLedger } from '../school-uid/ledger.js';
import { SchoolUidCoverageFacade } from '../school-uid/coverage.facade.js';
import { SchoolUidProjectionFacade } from '../school-uid/projection.facade.js';
import { SchoolIdentityRepository } from './repository.js';
import { retainSchoolIdentityProof } from './proof.js';
import {
  schoolIdentityCommandHash,
  schoolIdentityManagementSchema,
  schoolIdentityReceiptSchema,
} from './contracts.js';
import type {
  SchoolIdentityCommand,
  SchoolIdentityReceipt,
  SchoolIdentityManagement,
} from './contracts.js';
import type { SchoolUidLookup } from '../school-uid/contracts.js';
const unavailable = 'SCHOOL_IDENTITY_UNAVAILABLE' as const;
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
export class SchoolIdentityService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(ProfileAdminParticipantFacade)
    private readonly profiles: ProfileAdminParticipantFacade,
    @Inject(ProfileVisibilityFacade)
    private readonly safety: ProfileVisibilityFacade,
    @Inject(SchoolAdminManagementRepository)
    private readonly roles: SchoolAdminManagementRepository,
    @Inject(CampusStudentVerificationFacade)
    private readonly campuses: CampusStudentVerificationFacade,
    @Inject(SchoolIdentityVerificationFacade)
    private readonly verification: SchoolIdentityVerificationFacade,
    @Inject(SchoolUidLedger) private readonly ledger: SchoolUidLedger,
    @Inject(SchoolUidCoverageFacade)
    private readonly coverage: SchoolUidCoverageFacade,
    @Inject(SchoolUidProjectionFacade)
    private readonly projection: SchoolUidProjectionFacade,
    @Inject(SchoolIdentityRepository)
    private readonly repository: SchoolIdentityRepository,
  ) {}
  private run<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    return this.db
      .transaction(
        async (tx) => {
          const now = (
            await tx.query<{
              until: string;
              statement_timeout: string;
              lock_timeout: string;
            }>(
              "SELECT (clock_timestamp()+interval '15 seconds')::text until,current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout",
            )
          ).rows[0]!;
          await tx.query(
            "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
            [
              boundedTimeout(now.statement_timeout, 5000),
              boundedTimeout(now.lock_timeout, 3000),
            ],
          );
          registerTransactionExactDeadline(tx, now.until, unavailable);
          return work(tx);
        },
        { isolationLevel: 'read committed' },
      )
      .catch((error: unknown) => {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (['55P03', '57014', '40001', '40P01'].includes(String(error.code)) ||
            ('constraint' in error &&
              /school_identity|school_uid/.test(String(error.constraint))))
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
    destinationCampus: string | null,
    write: boolean,
    tx: PoolClient,
  ) {
    const selected = await this.roles.candidateSuper(actor, tx);
    const observedTarget = await this.profiles.observe(targetProfile, tx);
    if (!observedTarget)
      throw new ApplicationError('SCHOOL_IDENTITY_TARGET_NOT_ALLOWED');
    const initial = await this.repository.inputs(
      actor,
      selected,
      targetProfile,
      destinationCampus,
      tx,
    );
    const generation = await this.verification.observeGeneration(
      tx,
      write ? observedTarget.accountId : undefined,
    );
    const observed = await this.verification.observe(
      observedTarget.accountId,
      tx,
    );
    const absence = write
      ? await this.coverage.observeNativeAbsence(observedTarget.accountId, tx)
      : null;
    const target = await this.profiles.resolve(targetProfile, tx);
    if (
      !target ||
      target.accountId !== observedTarget.accountId ||
      !(await this.identity.activeAccount(target.accountId, tx))
    )
      throw new ApplicationError('SCHOOL_IDENTITY_TARGET_NOT_ALLOWED');
    enableSafetyRelationshipProof(tx);
    if (
      (await this.safety.read(actor, target.accountId, tx)).status !==
      'available'
    )
      throw new ApplicationError('SCHOOL_IDENTITY_TARGET_NOT_ALLOWED');
    await this.roles.lockGrants(actor, target.accountId, selected, false, tx);
    if (write) await lockStudentAccount(target.accountId, tx);
    let destination: Awaited<
      ReturnType<SchoolIdentityRepository['destination']>
    > = null;
    if (destinationCampus) {
      await this.campuses.resolve(destinationCampus, tx);
      destination = await this.repository.destination(destinationCampus, tx);
      if (!destination) throw new ApplicationError(unavailable);
    }
    if (observed) await this.verification.lock(observed, tx);
    const locked = write
      ? await this.ledger.lockAccount(target.accountId, tx)
      : null;
    const stateVersion = await this.repository.stateVersion(
      targetProfile,
      actor,
      tx,
    );
    const school = observed
      ? await this.repository.school(
          observed.affiliation.issuer_institution_id,
          tx,
        )
      : null;
    const uid = await this.projection.boundByManagement(target.accountId, tx);
    const completable = observed
      ? await this.repository.completionAllowed(
          target.accountId,
          observed.affiliation.id,
          tx,
        )
      : false;
    const management = schoolIdentityManagementSchema.parse({
      target: { profileId: target.profileId, displayName: target.displayName },
      stateVersion,
      current: { schoolUid: uid, school },
      destination: destination
        ? {
            campusId: destination.campusId,
            campusName: destination.campusName,
            school: { code: destination.code, name: destination.name },
            destinationVersion: destination.destinationVersion,
          }
        : null,
      actions: {
        correctSchool: !!observed && !!school,
        completeUid:
          !!observed && !!school && completable && uid.status !== 'assigned',
      },
    });
    return {
      selected,
      initial,
      generation,
      target,
      observed,
      absence,
      destination,
      locked,
      management,
      completable,
    };
  }
  @AccountPolicy('privileged_read', 'entry')
  management(
    token: string,
    target: string,
    campus?: string,
  ): Promise<SchoolIdentityManagement> {
    return this.run(async (tx) => {
      await lockSafetyPolicy(tx);
      const session = await this.session(token, tx);
      const r = await this.resolve(
        session.accountId,
        target,
        campus ?? null,
        false,
        tx,
      );
      retainSchoolIdentityProof(
        {
          actor: session.accountId,
          selected: r.selected,
          target,
          campus: campus ?? null,
          initial: r.initial,
          generation: r.generation,
          commandId: null,
          causeId: null,
        },
        tx,
      );
      return r.management;
    });
  }
  private receiptBase(command: SchoolIdentityCommand) {
    const { clientRequestId, ...intent } = command;
    return { ...intent, requestId: clientRequestId };
  }
  private async replay(
    actor: string,
    command: SchoolIdentityCommand,
    tx: PoolClient,
  ) {
    const old = await this.repository.request(
      actor,
      command.clientRequestId,
      tx,
    );
    if (!old) return null;
    if (old.intent_hash !== schoolIdentityCommandHash(command))
      throw new ApplicationError('SCHOOL_IDENTITY_REQUEST_CONFLICT');
    return schoolIdentityReceiptSchema.parse(old.receipt);
  }
  @AccountPolicy('noncontent_management', 'owner_after_recovery')
  async command(
    token: string,
    command: SchoolIdentityCommand,
    cancel = false,
  ): Promise<SchoolIdentityReceipt> {
    const existing = await this.run(async (tx) => {
      const session = await this.session(token, tx);
      await this.repository.requestLock(
        session.accountId,
        command.clientRequestId,
        tx,
      );
      const replay = await this.replay(session.accountId, command, tx);
      if (replay) return replay;
      if (!cancel) return null;
      const receipt = schoolIdentityReceiptSchema.parse({
        ...this.receiptBase(command),
        outcome: 'rejected',
        code: 'SCHOOL_IDENTITY_CANCELLED',
      });
      const id = randomUUID();
      await this.repository.save(
        {
          id,
          actor: session.accountId,
          sessionId: session.sessionId,
          tokenHash: hashToken(token),
          command,
          hash: schoolIdentityCommandHash(command),
          receipt,
          account: null,
          grant: null,
          initial: null,
        },
        tx,
      );
      retainSchoolIdentityProof(
        {
          actor: session.accountId,
          selected: null,
          target: command.targetProfileId,
          campus: null,
          initial: null,
          generation: null,
          commandId: id,
          causeId: null,
        },
        tx,
      );
      return receipt;
    });
    if (existing) return existing;
    return this.run(async (tx) => {
      await lockSafetyPolicy(tx, true);
      const session = await this.session(token, tx),
        actor = session.accountId;
      await this.repository.requestLock(actor, command.clientRequestId, tx);
      const replay = await this.replay(actor, command, tx);
      if (replay) return replay;
      await enforceAccountPunishment(actor, 'noncontent_management', tx);
      const campus =
        command.action === 'correct_school'
          ? command.destinationCampusId
          : null;
      const r = await this.resolve(
          actor,
          command.targetProfileId,
          campus,
          true,
          tx,
        ),
        commandId = randomUUID();
      const stale =
        r.management.stateVersion !== command.expectedStateVersion ||
        (command.action === 'correct_school' &&
          r.destination?.destinationVersion !==
            command.expectedDestinationVersion);
      const base = {
        id: commandId,
        actor,
        sessionId: session.sessionId,
        tokenHash: hashToken(token),
        command,
        hash: schoolIdentityCommandHash(command),
        account: r.target.accountId,
        grant: r.selected,
        initial: r.initial,
      };
      if (stale) {
        const receipt = schoolIdentityReceiptSchema.parse({
          ...this.receiptBase(command),
          outcome: 'rejected',
          code: 'SCHOOL_IDENTITY_STALE',
        });
        await this.repository.save({ ...base, receipt }, tx);
        retainSchoolIdentityProof(
          {
            actor,
            selected: r.selected,
            target: command.targetProfileId,
            campus,
            initial: r.initial,
            generation: r.generation,
            commandId,
            causeId: null,
          },
          tx,
        );
        return receipt;
      }
      if (!r.observed)
        throw new ApplicationError('SCHOOL_IDENTITY_TARGET_NOT_ALLOWED');
      const sameSchool =
        command.action === 'correct_school' &&
        r.destination?.institutionId ===
          r.observed.affiliation.issuer_institution_id;
      const unchanged =
        sameSchool ||
        (command.action === 'complete_uid' &&
          r.management.current.schoolUid.status === 'assigned');
      if (command.action === 'complete_uid' && !unchanged && !r.completable)
        throw new ApplicationError('SCHOOL_IDENTITY_TARGET_NOT_ALLOWED');
      if (!unchanged)
        await this.ledger.lockInstitutions(
          [
            ...new Set([
              command.action === 'correct_school'
                ? r.destination!.institutionId
                : r.observed.affiliation.issuer_institution_id,
              ...(r.locked?.head ? [r.locked.head.institution_id] : []),
            ]),
          ],
          tx,
        );
      const causeId = randomUUID(),
        uidEventId = unchanged ? undefined : randomUUID();
      const correcting = command.action === 'correct_school' && !unchanged;
      if (correcting && !r.destination) throw new ApplicationError(unavailable);
      const ids = correcting
        ? schoolIdentityCorrectionIds()
        : {
            assertionId: r.observed.affiliation.id,
            snapshotId: r.observed.head.snapshot_id,
            eventId: r.observed.eventId,
          };
      const now = (
        await tx.query<{ now: Date }>(
          "SELECT date_trunc('milliseconds',clock_timestamp()) now",
        )
      ).rows[0]!.now;
      const receipt = schoolIdentityReceiptSchema.parse({
        ...this.receiptBase(command),
        outcome: unchanged ? 'unchanged' : 'applied',
        eventId: uidEventId ?? commandId,
        recordedAt: now.toISOString(),
      });
      await this.repository.save(
        {
          ...base,
          receipt,
          oldSnapshotId: r.observed.head.snapshot_id,
          newSnapshotId: ids.snapshotId,
          newAssertionId: ids.assertionId,
          verificationEventId: ids.eventId,
          ...(uidEventId ? { uidEventId } : {}),
          causeId,
        },
        tx,
      );
      await this.ledger.registerCause(
        {
          id: causeId,
          kind: unchanged ? 'unchanged' : command.action,
          account: r.target.accountId,
          actor,
          sourceId: commandId,
          institutionId: correcting
            ? r.destination!.institutionId
            : r.observed.affiliation.issuer_institution_id,
          assertionId: ids.assertionId,
          snapshotId: ids.snapshotId,
          verificationEventId: ids.eventId,
          oldSnapshotId: r.observed.head.snapshot_id,
          oldRevision: r.observed.head.revision,
          ...(r.absence ? { coverageObservationId: r.absence.id } : {}),
        },
        tx,
      );
      await this.verification.registerGeneration(causeId, r.generation, tx);
      if (correcting)
        await this.verification.append(
          {
            causeId,
            commandId,
            actorAccountId: actor,
            accountId: r.target.accountId,
            destinationInstitutionId: r.destination!.institutionId,
            destinationRegionId: r.destination!.regionId,
            observation: r.observed,
            ids,
          },
          tx,
        );
      if (uidEventId) {
        const produced = await this.ledger.produce(
          { causeId, eventId: uidEventId, coverageObservation: r.absence },
          tx,
        );
        if (produced.outcome === 'deferred_unavailable')
          throw new ApplicationError('SCHOOL_UID_UNAVAILABLE');
      }
      retainSchoolIdentityProof(
        {
          actor,
          selected: r.selected,
          target: command.targetProfileId,
          campus,
          initial: r.initial,
          generation: r.generation,
          commandId,
          causeId,
        },
        tx,
      );
      return receipt;
    });
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  recovery(token: string, request: string) {
    return this.run(async (tx) => {
      const session = await this.session(token, tx);
      await this.repository.requestLock(session.accountId, request, tx);
      const row = await this.repository.request(session.accountId, request, tx);
      return row
        ? {
            state: 'recorded' as const,
            receipt: schoolIdentityReceiptSchema.parse(row.receipt),
          }
        : { state: 'not_recorded' as const };
    });
  }
  @AccountPolicy('privileged_read', 'entry')
  lookup(
    token: string,
    schoolCode: string,
    uid: string,
  ): Promise<SchoolUidLookup> {
    return this.run(async (tx) => {
      await lockSafetyPolicy(tx);
      const session = await this.session(token, tx),
        actor = session.accountId;
      const selected = await this.roles.candidateSuper(actor, tx);
      // Retain role absence/phantom and lineage before waiting, even a missing lookup.
      const grants = (
        await tx.query<{ facts: unknown }>(
          'SELECT whaleu_authorization.school_admin_management_input_facts($1,$2,NULL,false) facts',
          [actor, selected],
        )
      ).rows[0]!.facts;
      await this.retainLookupAuthority(actor, selected, grants, tx);
      await this.roles.lockGrants(actor, actor, selected, false, tx);
      const account = await this.projection.lookupAccount(schoolCode, uid, tx);
      if (!account) {
        await this.retainLookupAuthority(actor, selected, grants, tx);
        return { status: 'unavailable' };
      }
      const profiles = await this.profiles.batch([account], tx),
        target = profiles.get(account);
      if (!target || target.status !== 'available') {
        await this.retainLookupAuthority(actor, selected, grants, tx);
        return { status: 'unavailable' };
      }
      let r: Awaited<ReturnType<SchoolIdentityService['resolve']>>;
      try {
        r = await this.resolve(actor, target.profileId, null, false, tx);
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          error.code === 'SCHOOL_IDENTITY_TARGET_NOT_ALLOWED'
        )
          return { status: 'unavailable' };
        throw error;
      }
      retainSchoolIdentityProof(
        {
          actor,
          selected: r.selected,
          target: target.profileId,
          campus: null,
          initial: r.initial,
          generation: r.generation,
          commandId: null,
          causeId: null,
        },
        tx,
      );
      if (
        r.management.current.schoolUid.status !== 'assigned' ||
        r.management.current.schoolUid.school.code !== schoolCode ||
        r.management.current.schoolUid.uid !== uid
      )
        return { status: 'unavailable' };
      return {
        status: 'found',
        target: {
          profileId: target.profileId,
          displayName: target.displayName,
        },
      };
    });
  }
  private async retainLookupAuthority(
    actor: string,
    selected: string,
    initial: unknown,
    tx: PoolClient,
  ) {
    await retainLookupAuthority(actor, selected, initial, tx);
  }
}
import { retainLookupAuthority } from './lookup-proof.js';
