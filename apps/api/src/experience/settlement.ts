import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  actionDelta,
  bucketAction,
  colors,
  levelFor,
  signInPreview,
  titles,
} from './catalog.js';
import type { ExperienceAction, RecordAction } from './catalog.js';
import { ExperienceClock, ExperienceRepository } from './repository.js';
import type { AccountState } from './repository.js';
@Injectable()
export class ExperienceSettlementService {
  constructor(
    @Inject(ExperienceRepository)
    private readonly records: ExperienceRepository,
    @Inject(ExperienceClock) private readonly clock: ExperienceClock,
  ) {}
  /** Caller holds the single owner guard. No mutable community queries occur here. */
  async source(
    input: {
      unitId: string;
      beneficiaryId: string;
      action: ExperienceAction;
      occurredAt: string | null;
    },
    state: AccountState,
    tx: PoolClient,
  ) {
    const clock = await this.clock.now(tx),
      action = bucketAction(input.action);
    const bucket = await this.records.bucket(
      input.beneficiaryId,
      clock.day,
      action,
      tx,
    );
    const change = actionDelta(
      input.action,
      BigInt(state.balance),
      bucket.rewarded_count,
      bucket.refund_count,
    );
    const settlement = await this.apply(
      {
        owner: input.beneficiaryId,
        unit: input.unitId,
        action: input.action,
        nominal: change.nominal,
        delta: change.delta,
        outcome: change.outcome,
        occurredAt: input.occurredAt,
        clock,
        state,
        bucket: {
          action,
          before: bucket.rewarded_count,
          after: change.used,
          refundBefore: bucket.refund_count,
          refundAfter: change.refunded,
        },
      },
      tx,
    );
    await tx.query(
      'INSERT INTO whaleu_experience.daily_buckets(owner_id,reward_day,action,rewarded_count,refund_count,gross_positive_awarded) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,reward_day,action) DO UPDATE SET rewarded_count=EXCLUDED.rewarded_count,refund_count=EXCLUDED.refund_count,gross_positive_awarded=EXCLUDED.gross_positive_awarded',
      [
        input.beneficiaryId,
        clock.day,
        action,
        change.used,
        change.refunded,
        (
          BigInt(bucket.gross_positive_awarded) + BigInt(change.gross)
        ).toString(),
      ],
    );
    return settlement;
  }
  async signIn(state: AccountState, tx: PoolClient) {
    const clock = await this.clock.now(tx),
      preview = signInPreview(state.last_signin_day, state.streak, clock.day);
    if (preview.signedIn)
      return {
        outcome: 'already_signed_in' as const,
        rewardDay: clock.day,
        appliedDelta: '0',
        balance: state.balance,
        streak: state.streak,
        stateRevision: state.revision,
      };
    const result = await this.apply(
      {
        owner: state.owner_id,
        unit: null,
        action: 'sign_in',
        nominal: BigInt(preview.nextReward),
        delta: BigInt(preview.nextReward),
        outcome: 'awarded',
        occurredAt: clock.at.toISOString(),
        clock,
        state,
        bucket: null,
      },
      tx,
    );
    await tx.query(
      'INSERT INTO whaleu_experience.signin_days(owner_id,reward_day,settlement_id,streak) VALUES($1,$2,$3,$4)',
      [state.owner_id, clock.day, result.settlementId, preview.nextStreak],
    );
    await tx.query(
      'UPDATE whaleu_experience.account_states SET last_signin_day=$2,streak=$3 WHERE owner_id=$1',
      [state.owner_id, clock.day, preview.nextStreak],
    );
    return {
      outcome: 'awarded' as const,
      rewardDay: clock.day,
      appliedDelta: String(preview.nextReward),
      balance: result.balance,
      streak: preview.nextStreak,
      stateRevision: result.revision,
    };
  }
  private async apply(
    input: {
      owner: string;
      unit: string | null;
      action: RecordAction;
      nominal: bigint;
      delta: bigint;
      outcome: 'awarded' | 'capped' | 'deducted';
      occurredAt: string | null;
      clock: { at: Date; day: string };
      state: AccountState;
      bucket: {
        action: string;
        before: number;
        after: number;
        refundBefore: number;
        refundAfter: number;
      } | null;
    },
    tx: PoolClient,
  ) {
    const id = randomUUID(),
      before = BigInt(input.state.balance),
      after = before + input.delta,
      revision = (BigInt(input.state.revision) + 1n).toString();
    await tx.query(
      'INSERT INTO whaleu_experience.settlements(id,unit_id,owner_id,action,outcome,nominal_delta,applied_delta,balance_before,balance_after,state_revision,applied_at,reward_day,bucket_action,bucket_before,bucket_after,refund_before,refund_after) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
      [
        id,
        input.unit,
        input.owner,
        input.action,
        input.outcome,
        input.nominal.toString(),
        input.delta.toString(),
        before.toString(),
        after.toString(),
        revision,
        input.clock.at,
        input.clock.day,
        input.bucket?.action ?? null,
        input.bucket?.before ?? null,
        input.bucket?.after ?? null,
        input.bucket?.refundBefore ?? null,
        input.bucket?.refundAfter ?? null,
      ],
    );
    await tx.query(
      'UPDATE whaleu_experience.account_states SET balance=$2,revision=$3 WHERE owner_id=$1',
      [input.owner, after.toString(), revision],
    );
    await tx.query(
      "INSERT INTO whaleu_experience.records(id,owner_id,settlement_id,action,origin,outcome,nominal_delta,applied_delta,balance_after,occurred_at,applied_at) VALUES($1,$2,$3,$4,'settlement',$5,$6,$7,$8,$9,$10)",
      [
        randomUUID(),
        input.owner,
        id,
        input.action,
        input.outcome,
        input.nominal.toString(),
        input.delta.toString(),
        after.toString(),
        input.occurredAt,
        input.clock.at,
      ],
    );
    const fromLevel = levelFor(before),
      toLevel = levelFor(after);
    if (toLevel > fromLevel) {
      const granted: string[] = [];
      for (const title of titles)
        if (title.kind === 'level' && title.unlockLevel! <= toLevel) {
          const added = await tx.query(
            "INSERT INTO whaleu_experience.entitlements(owner_id,title_key,origin,settlement_id,earned_at) VALUES($1,$2,'level',$3,$4) ON CONFLICT(owner_id,title_key) DO NOTHING RETURNING title_key",
            [input.owner, title.key, id, input.clock.at],
          );
          if (added.rowCount) granted.push(title.key);
        }
      await tx.query(
        'INSERT INTO whaleu_experience.unlock_notices(id,owner_id,settlement_id,from_level,to_level,title_keys,color_ids,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          randomUUID(),
          input.owner,
          id,
          fromLevel,
          toLevel,
          granted,
          colors
            .filter(
              (c) =>
                c.id > 10 &&
                c.unlockLevel > fromLevel &&
                c.unlockLevel <= toLevel,
            )
            .map((c) => c.id),
          input.clock.at,
        ],
      );
    }
    return { settlementId: id, balance: after.toString(), revision };
  }
}
