import { Injectable } from '@nestjs/common';
import { ApplicationError } from '../http/application-error.js';
import type { PoolClient } from 'pg';
import { emptyProfileDetails } from './contracts.js';
import type { ProfileDetails, ProfileDetailsPatch } from './contracts.js';
@Injectable()
export class ProfileDetailsRepository {
  async lock(accountId: string, tx: PoolClient, write = false) {
    await tx.query(
      `SELECT pg_advisory_xact_lock${write ? '' : '_shared'}(hashtextextended($1,0))`,
      [`whaleu:profile-details:${accountId}`],
    );
  }
  async read(accountId: string, tx: PoolClient): Promise<ProfileDetails> {
    const row = (
      await tx.query<Omit<ProfileDetails, 'gender'> & { gender: unknown }>(
        `SELECT account_id AS "accountId", revision, region, gender, age, show_region AS "showRegion", show_gender AS "showGender", show_age AS "showAge" FROM whaleu_profile.details WHERE account_id=$1 FOR SHARE`,
        [accountId],
      )
    ).rows[0];
    if (!row) return emptyProfileDetails(accountId);
    if (row.gender === null || row.gender === 'female' || row.gender === 'male')
      return { ...row, gender: row.gender };
    // During a rolling migration never disclose or re-enable a legacy option.
    return { ...row, gender: null, showGender: false };
  }

  async update(
    accountId: string,
    patch: ProfileDetailsPatch,
    tx: PoolClient,
  ): Promise<ProfileDetails> {
    await this.lock(accountId, tx, true);
    const current = await this.read(accountId, tx);
    if (current.revision !== patch.expectedRevision)
      throw new ApplicationError('PROFILE_DETAILS_REVISION_CONFLICT');
    const revision = current.revision + 1;
    await tx.query(
      `INSERT INTO whaleu_profile.details(account_id,revision,region,gender,age,show_region,show_gender,show_age) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,region=excluded.region,gender=excluded.gender,age=excluded.age,show_region=excluded.show_region,show_gender=excluded.show_gender,show_age=excluded.show_age,updated_at=clock_timestamp()`,
      [
        accountId,
        revision,
        patch.region,
        patch.gender,
        patch.age,
        patch.showRegion,
        patch.showGender,
        patch.showAge,
      ],
    );
    return {
      accountId,
      revision,
      region: patch.region,
      gender: patch.gender,
      age: patch.age,
      showRegion: patch.showRegion,
      showGender: patch.showGender,
      showAge: patch.showAge,
    };
  }
}
