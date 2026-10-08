import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { RedeemableTitleKey } from './redemption.provider.js';
@Injectable()
export class RedemptionRepository {
  async owned(owner: string, key: RedeemableTitleKey, tx: PoolClient) {
    return (
      (
        await tx.query(
          'SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key=$2',
          [owner, key],
        )
      ).rowCount !== 0
    );
  }
  async decide(
    owner: string,
    request: string,
    title: RedeemableTitleKey | null,
    outcome: 'granted' | 'invalid' | 'already_owned',
    at: Date,
    tx: PoolClient,
  ) {
    await tx.query(
      "INSERT INTO whaleu_experience.redemption_decisions(owner_id,request_id,title_key,outcome,decided_at,authority_kind) VALUES($1,$2,$3,$4,$5,'synthetic_fixture')",
      [owner, request, title, outcome, at],
    );
    if (outcome === 'granted')
      await tx.query(
        "INSERT INTO whaleu_experience.entitlements(owner_id,title_key,origin,redemption_request_id,earned_at) VALUES($1,$2,'redemption',$3,$4)",
        [owner, title, request, at],
      );
  }
}
