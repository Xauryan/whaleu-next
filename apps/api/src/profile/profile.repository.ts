import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import { preferenceDefaults, preferencesSchema } from './contracts.js';
import type { Preferences } from './contracts.js';

export interface StoredProfile {
  readonly accountId: string;
  readonly nickname: string | null;
  readonly bio: string;
  readonly selectedCampusId: string | null;
  readonly revision: number;
  readonly preferences: Preferences;
}
export type ProfileChanges = Partial<
  Pick<StoredProfile, 'nickname' | 'bio' | 'selectedCampusId' | 'preferences'>
>;
const projection =
  'account_id AS "accountId", nickname, bio, selected_campus_id AS "selectedCampusId", revision, preferences';

export function initialProfile(accountId: string): StoredProfile {
  return {
    accountId,
    nickname: null,
    bio: '',
    selectedCampusId: null,
    revision: 0,
    preferences: { ...preferenceDefaults },
  };
}

@Injectable()
export class ProfileRepository {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async get(accountId: string): Promise<StoredProfile> {
    const result = await this.database.query<StoredProfile>(
      `SELECT ${projection} FROM whaleu_profile.profiles WHERE account_id = $1`,
      [accountId],
    );
    return result.rows[0] ?? initialProfile(accountId);
  }

  update(
    accountId: string,
    expectedRevision: number,
    change: (
      current: StoredProfile,
      transaction: PoolClient,
    ) => Promise<ProfileChanges>,
  ): Promise<StoredProfile> {
    return this.database.transaction(async (transaction) => {
      await transaction.query(
        'INSERT INTO whaleu_profile.profiles(account_id) VALUES ($1) ON CONFLICT (account_id) DO NOTHING',
        [accountId],
      );
      const result = await transaction.query<StoredProfile>(
        `SELECT ${projection} FROM whaleu_profile.profiles WHERE account_id = $1 FOR UPDATE`,
        [accountId],
      );
      const current = result.rows[0]!;
      if (
        current.revision !== expectedRevision ||
        current.revision === 2147483647
      )
        throw new ApplicationError('PROFILE_REVISION_CONFLICT');
      const next = { ...current, ...(await change(current, transaction)) };
      // Decode the fixed preference contract even when this operation changes another field.
      preferencesSchema.parse(next.preferences);
      const updated = await transaction.query<StoredProfile>(
        `UPDATE whaleu_profile.profiles SET nickname=$2, bio=$3, selected_campus_id=$4,
         preferences=$5::jsonb, revision=revision+1, updated_at=clock_timestamp()
         WHERE account_id=$1 RETURNING ${projection}`,
        [
          accountId,
          next.nickname,
          next.bio,
          next.selectedCampusId,
          JSON.stringify(next.preferences),
        ],
      );
      return updated.rows[0]!;
    });
  }
}
