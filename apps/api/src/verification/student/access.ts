import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { SchoolConfigurationAccess } from '../../school-configuration/access.js';
import { IdentityService } from '../../identity/identity.service.js';
import { CampusStudentVerificationFacade } from '../../campus/student-verification.facade.js';
import { SafetyRepository } from '../../safety/repository.js';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { ownerFingerprint } from '../../database/required-owner-proof.js';
import { requireStudentCurrent } from './current-proof.js';
import type { StudentApplicationRow } from './contracts.js';
@Injectable()
export class StudentVerificationAccess {
  constructor(
    @Inject(SchoolConfigurationAccess)
    readonly school: SchoolConfigurationAccess,
    @Inject(CampusStudentVerificationFacade)
    readonly campuses: CampusStudentVerificationFacade,
    @Inject(IdentityService) readonly identity: IdentityService,
    @Inject(SafetyRepository) readonly safety: SafetyRepository,
  ) {}
  authenticate(token: string, tx: PoolClient) {
    return this.school.authenticate(token, tx);
  }
  async row(
    id: string,
    tx: PoolClient,
    lock = false,
  ): Promise<StudentApplicationRow> {
    const row = (
      await tx.query<StudentApplicationRow>(
        `SELECT * FROM whaleu_verification.student_applications WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
        [id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('STUDENT_VERIFICATION_NOT_FOUND');
    return row;
  }
  async campus(row: StudentApplicationRow, tx: PoolClient) {
    const campus = await this.campuses.resolve(row.campus_id, tx);
    if (
      campus.institutionId !== row.institution_id ||
      campus.regionId !== row.region_id ||
      campus.version !== row.campus_version
    )
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    return campus;
  }
  async applicant(row: StudentApplicationRow, tx: PoolClient) {
    if (!(await this.identity.activeAccount(row.account_id, tx)))
      throw new ApplicationError('ACCOUNT_BLOCKED');
    await this.safety.restriction(row.account_id, tx);
  }
  async reviewer(token: string, region: string, tx: PoolClient) {
    const auth = await this.school.management(token, region, tx);
    await requireStudentCurrent(null, auth.session.accountId, tx);
    return auth;
  }
  async authorizePrepare(
    actorAccountId: string,
    applicationId: string,
    revision: number,
    tx: PoolClient,
  ) {
    const row = await this.row(applicationId, tx);
    if (
      row.account_id !== actorAccountId ||
      row.state !== 'draft' ||
      row.revision !== revision
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.applicant(row, tx);
    await this.campus(row, tx);
    return {
      actorAccountId,
      applicationId,
      revision,
      authorityVersion: ownerFingerprint([
        row.id,
        row.account_id,
        row.revision,
        row.state,
        row.campus_version,
      ]),
    };
  }
  async authorizeRead(
    token: string,
    target: {
      applicationId: string;
      revision: number;
      reviewRegionId: string | null;
    },
    tx: PoolClient,
  ) {
    const actor = await this.authenticate(token, tx),
      row = await this.row(target.applicationId, tx);
    if (
      row.evidence_revision !== target.revision ||
      !row.evidence_id ||
      !row.evidence_expires_at
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() now'))
      .rows[0]!.now;
    if (row.evidence_expires_at <= now)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (actor.accountId !== row.account_id) {
      if (row.state !== 'pending' || target.reviewRegionId !== row.region_id)
        throw new ApplicationError('AUTHORIZATION_REQUIRED');
      await this.school.authorizeAccount(
        actor.accountId,
        target.reviewRegionId,
        tx,
      );
      await this.applicant(row, tx);
    }
    await this.campus(row, tx);
    registerTransactionDeadline(
      tx,
      row.evidence_expires_at.getTime(),
      'MEDIA_UNAVAILABLE',
    );
    await requireStudentCurrent(row.id, actor.accountId, tx);
    return {
      accountId: actor.accountId,
      sessionId: actor.sessionId,
      actorAccountId: row.account_id,
      authorityVersion: ownerFingerprint([
        row.id,
        row.revision,
        row.state,
        row.evidence_id,
        row.campus_version,
      ]),
    };
  }
  async retainCurrent(applicationId: string, tx: PoolClient) {
    const row = await this.row(applicationId, tx);
    await requireStudentCurrent(applicationId, row.account_id, tx);
  }
}
