import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { AccountIdentityProfileService } from '../profile/account-identity-profile.service.js';
import { STUDENT_IDENTITY_SOURCE } from './contracts.js';
import type {
  PrivateIdentity,
  PrivateIdentitySnapshot,
  StudentIdentitySource,
} from './contracts.js';

@Injectable()
export class PrivateIdentityRepository {
  constructor(
    @Inject(STUDENT_IDENTITY_SOURCE)
    private readonly students: StudentIdentitySource,
    @Inject(AccountIdentityProfileService)
    private readonly profiles: AccountIdentityProfileService,
  ) {}
  async resolve(
    accountId: string,
    transaction: PoolClient,
  ): Promise<PrivateIdentity | null> {
    return (await this.snapshot(accountId, transaction)).identity;
  }
  async snapshot(
    accountId: string,
    transaction: PoolClient,
  ): Promise<PrivateIdentitySnapshot> {
    // accountId is supplied only by the trusted content-owner facade; its account FK
    // is authoritative. Profile facts stay owned by the profile module.
    const profile = await this.profiles.find(accountId, transaction);
    const student = await this.students.resolve(accountId, transaction);
    // Runtime boundary rejects malformed adapters rather than fabricating or emitting unsafe data.
    if (
      !student ||
      !['verified', 'unverified', 'unavailable'].includes(student.status)
    )
      throw new ApplicationError('IDENTITY_VIEW_UNAVAILABLE');
    if (
      student.status === 'verified' &&
      ((student.validUntil !== null &&
        (typeof student.validUntil !== 'number' ||
          !Number.isFinite(student.validUntil))) ||
        typeof student.studentNumber !== 'string' ||
        student.studentNumber.length < 1 ||
        student.studentNumber.length > 100 ||
        [...student.studentNumber].some((character) => {
          const code = character.codePointAt(0)!;
          return code <= 31 || (code >= 127 && code <= 159);
        }) ||
        student.studentNumber.trim() !== student.studentNumber)
    )
      throw new ApplicationError('IDENTITY_VIEW_UNAVAILABLE');
    return {
      validUntil: student.status === 'verified' ? student.validUntil : null,
      identity: {
        accountId,
        nickname: profile?.nickname ?? null,
        avatar: null,
        studentNumber:
          student.status === 'verified' ? student.studentNumber : null,
        studentNumberStatus: student.status,
      },
    };
  }
}
