import { currentPromotionProfile } from '../../ratings/group-promotion/profile.js';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  digest,
  effectIdentity,
  effectKey,
  type EffectIdentity,
  type EffectStage,
  type EffectState,
  type Evidence,
  type Program,
} from '../../ratings/group-promotion/contracts.js';
import type { CampaignRow } from '../../ratings/group-promotion/service.js';
export interface EffectRow {
  id: string;
  campaign_id: string;
  stage: EffectStage;
  stable_destination_id: string | null;
  original_key: string;
  profile_id: string;
  account_lineage: string;
  input_hash: string;
  payload_hash: string | null;
  state: EffectState;
  fence: string;
  attempt_id: string | null;
  lease_until: Date | null;
  dispatches: number;
  preparations: number;
  reconciliations: number;
  result_text: string | null;
  profile_policy_revision: string | null;
  created_at: Date;
}
export interface Claim {
  effect: EffectRow;
  identity: EffectIdentity;
  fence: string;
  leaseRemaining: number;
  leaseDeadline?: number;
  operation: 'dispatch' | 'reconcile';
}
@Injectable()
export class RatingGroupRepository {
  async add(
    c: CampaignRow,
    p: Program,
    stage: EffectStage,
    inputHash: string,
    destination: string | null,
    tx: PoolClient,
  ) {
    const profile = stage === 'delivery' ? p.account_lineage : p.profile_id;
    const profileRevision =
      stage === 'delivery' ? null : await currentPromotionProfile(p, stage, tx);
    await tx.query(
      `INSERT INTO whaleu_notifications.rating_group_effects(id,campaign_id,stage,stable_destination_id,original_key,profile_id,account_lineage,input_hash,payload_hash,profile_policy_revision)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        c.id,
        stage,
        destination,
        effectKey(c.id, stage, profile, inputHash, destination),
        p.profile_id,
        p.account_lineage,
        inputHash,
        stage === 'delivery' ? c.payload_hash : null,
        profileRevision,
      ],
    );
  }
  async claim(stage: EffectStage, tx: PoolClient): Promise<Claim | null> {
    const e = (
      await tx.query<EffectRow>(
        `SELECT *,fence::text FROM whaleu_notifications.rating_group_effects WHERE stage=$1 AND state IN('pending','retry_wait','dispatch_unknown','preparing') AND next_action_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
   AND (state<>'dispatch_unknown' OR (reconciliations<24 AND (recovery_requested OR (reconciliations<12 AND created_at>clock_timestamp()-interval '24 hours'))))
   ORDER BY next_action_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [stage],
      )
    ).rows[0];
    if (!e) return null;
    const operation = e.state === 'dispatch_unknown' ? 'reconcile' : 'dispatch';
    if (operation === 'dispatch' && e.preparations >= 3) {
      await tx.query(
        `UPDATE whaleu_notifications.rating_group_effects SET state='suppressed_unsent',reason='preparation_exhausted' WHERE id=$1`,
        [e.id],
      );
      return null;
    }
    const fence = (BigInt(e.fence) + 1n).toString(),
      attemptId = randomUUID();
    let identity: EffectIdentity;
    if (operation === 'reconcile') {
      const original = (
        await tx.query<{ identity: EffectIdentity }>(
          `SELECT identity FROM whaleu_notifications.rating_group_attempts WHERE id=$1`,
          [e.attempt_id],
        )
      ).rows[0];
      if (!original) throw new ApplicationError('PROMOTION_UNAVAILABLE');
      identity = original.identity;
    } else
      identity = {
        effectId: e.id,
        attemptId,
        key: e.original_key,
        stage: e.stage,
        profileId: e.profile_id,
        accountLineage: e.account_lineage,
        destinationId: e.stable_destination_id,
        inputHash: e.input_hash,
        payloadHash: e.payload_hash,
        fence,
      };
    const lease = (
      await tx.query<{ lease_until: Date; lease_exact: string }>(
        `UPDATE whaleu_notifications.rating_group_effects SET state=$2,fence=$3,attempt_id=$4,lease_until=clock_timestamp()+interval '30 seconds',preparations=preparations+$5,reconciliations=reconciliations+$6,recovery_requested=false WHERE id=$1 RETURNING lease_until,lease_until::text lease_exact`,
        [
          e.id,
          operation === 'dispatch' ? 'preparing' : 'dispatch_unknown',
          fence,
          identity.attemptId,
          operation === 'dispatch' ? 1 : 0,
          operation === 'reconcile' ? 1 : 0,
        ],
      )
    ).rows[0]!;
    await tx.query(
      `INSERT INTO whaleu_notifications.rating_group_attempts(id,effect_id,original_key,ordinal,fence,operation,identity,lease_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        attemptId,
        e.id,
        e.original_key,
        operation === 'dispatch' ? e.dispatches + 1 : e.reconciliations + 1,
        fence,
        operation,
        identity,
        lease.lease_exact,
      ],
    );
    return {
      effect: {
        ...e,
        attempt_id: identity.attemptId,
        fence,
        lease_until: lease.lease_until,
        preparations: e.preparations + (operation === 'dispatch' ? 1 : 0),
        reconciliations:
          e.reconciliations + (operation === 'reconcile' ? 1 : 0),
      },
      identity,
      fence,
      leaseRemaining: 30000,
      operation,
    };
  }
  async current(claim: Claim, tx: PoolClient, minLeaseMs = 0) {
    const row = (
      await tx.query(
        `SELECT extract(epoch FROM (lease_until-clock_timestamp()))::float8*1000 remaining FROM whaleu_notifications.rating_group_effects WHERE id=$1 AND attempt_id=$2 AND fence=$3 AND lease_until>clock_timestamp()+$4::int*interval '1 millisecond' FOR UPDATE`,
        [claim.effect.id, claim.identity.attemptId, claim.fence, minLeaseMs],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('PROMOTION_UNAVAILABLE');
    claim.leaseDeadline = performance.now() + Number(row['remaining']);
  }
  async noSend(
    claim: Claim,
    reason: string,
    terminal: boolean,
    tx: PoolClient,
  ) {
    await tx.query(
      `UPDATE whaleu_notifications.rating_group_effects SET state=$4,reason=$5,lease_until=NULL,next_action_at=clock_timestamp()+CASE WHEN preparations=1 THEN interval '5 seconds' ELSE interval '30 seconds' END WHERE id=$1 AND attempt_id=$2 AND fence=$3 AND state='preparing'`,
      [
        claim.effect.id,
        claim.identity.attemptId,
        claim.fence,
        terminal || claim.effect.preparations >= 3
          ? 'suppressed_unsent'
          : 'retry_wait',
        reason,
      ],
    );
  }
  async markPossible(
    claim: Claim,
    c: CampaignRow,
    authority: string,
    tx: PoolClient,
  ) {
    await this.current(
      claim,
      tx,
      claim.effect.stage === 'delivery' ? 7000 : 1000,
    );
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('rating-promotion-emission-capacity-v1',0))`,
    );
    await tx.query(
      `DELETE FROM whaleu_notifications.rating_group_emission_slots WHERE lease_until<=clock_timestamp()`,
    );
    const capacity = (
      await tx.query<{ all: number; account: number }>(
        `SELECT count(*)::int all,count(*) FILTER(WHERE account_lineage=$1)::int account FROM whaleu_notifications.rating_group_emission_slots`,
        [claim.identity.accountLineage],
      )
    ).rows[0]!;
    if (capacity.all >= 32 || capacity.account >= 8)
      throw new ApplicationError('PROMOTION_QUOTA_EXCEEDED');
    await tx.query(
      `INSERT INTO whaleu_notifications.rating_group_emission_slots(effect_id,attempt_id,account_lineage) VALUES($1,$2,$3)`,
      [
        claim.effect.id,
        claim.identity.attemptId,
        claim.identity.accountLineage,
      ],
    );
    if (claim.effect.stage === 'delivery') {
      const lineage = await tx.query(
        `SELECT id FROM whaleu_ratings.promotion_receiver_lineages WHERE id=$1 AND NOT retired FOR UPDATE`,
        [claim.identity.destinationId],
      );
      if (lineage.rowCount !== 1)
        throw new ApplicationError('PROMOTION_UNAVAILABLE');
      const gate = (
        await tx.query(
          `SELECT 1 FROM whaleu_notifications.rating_group_receiver_gates WHERE stable_destination_id=$1`,
          [claim.identity.destinationId],
        )
      ).rows[0];
      if (gate) throw new ApplicationError('PROMOTION_UNAVAILABLE');
      const old = (
        await tx.query(
          `SELECT 1 FROM whaleu_notifications.rating_group_counters WHERE stable_destination_id=$1 AND campaign_id=$2`,
          [claim.identity.destinationId, c.id],
        )
      ).rows[0];
      if (!old) {
        const quota = (
          await tx.query<{ n: number; recent: boolean }>(
            `SELECT count(*) FILTER(WHERE utc_day=(clock_timestamp() AT TIME ZONE 'UTC')::date)::int n,coalesce(bool_or(reserved_at>clock_timestamp()-interval '30 minutes'),false) recent FROM whaleu_notifications.rating_group_counters WHERE stable_destination_id=$1 AND reserved_at>clock_timestamp()-interval '1 day'`,
            [claim.identity.destinationId],
          )
        ).rows[0]!;
        if (quota.n >= (c.mode === 'test' ? 20 : 2) || quota.recent)
          throw new ApplicationError('PROMOTION_QUOTA_EXCEEDED');
        await tx.query(
          `INSERT INTO whaleu_notifications.rating_group_counters(stable_destination_id,campaign_id) VALUES($1,$2)`,
          [claim.identity.destinationId, c.id],
        );
      }
      await tx.query(
        `INSERT INTO whaleu_notifications.rating_group_receiver_gates(stable_destination_id,effect_id,original_attempt_id,fence) VALUES($1,$2,$3,$4)`,
        [
          claim.identity.destinationId,
          claim.effect.id,
          claim.identity.attemptId,
          claim.identity.fence,
        ],
      );
    } else {
      await tx.query(
        `INSERT INTO whaleu_ratings.promotion_cost_reservations(effect_id,attempt_id,microcredits) VALUES($1,$2,$3)`,
        [
          claim.effect.id,
          claim.identity.attemptId,
          claim.effect.stage === 'generation' ? 500000 : 100000,
        ],
      );
    }
    await tx.query(
      `INSERT INTO whaleu_notifications.rating_group_permits(attempt_id,effect_id,original_key,prepared_hash,authority_digest) VALUES($1,$2,$3,$4,$5)`,
      [
        claim.identity.attemptId,
        claim.effect.id,
        claim.identity.key,
        digest(claim.identity),
        authority,
      ],
    );
    const marked = await tx.query(
      `UPDATE whaleu_notifications.rating_group_effects SET state='dispatch_unknown',dispatches=dispatches+1,reason='unknown' WHERE id=$1 AND attempt_id=$2 AND fence=$3`,
      [claim.effect.id, claim.identity.attemptId, claim.fence],
    );
    if (marked.rowCount !== 1)
      throw new ApplicationError('PROMOTION_UNAVAILABLE');
  }
  async leaveUnknown(claim: Claim, tx: PoolClient) {
    await tx.query(
      `DELETE FROM whaleu_notifications.rating_group_emission_slots WHERE effect_id=$1 AND attempt_id=$2`,
      [claim.effect.id, claim.identity.attemptId],
    );
    await tx.query(
      `UPDATE whaleu_notifications.rating_group_effects SET lease_until=NULL,next_action_at=clock_timestamp()+$4::int*interval '1 second',state=CASE WHEN reconciliations>=24 OR (reconciliations>=12 AND NOT recovery_requested) THEN 'parked_unknown' ELSE state END WHERE id=$1 AND attempt_id=$2 AND fence=$3 AND state='dispatch_unknown'`,
      [
        claim.effect.id,
        claim.identity.attemptId,
        claim.fence,
        [10, 30, 120, 300][claim.effect.reconciliations] ?? 1800,
      ],
    );
  }
  async settle(claim: Claim, e: Evidence, tx: PoolClient) {
    await this.current(claim, tx, 1000);
    if (!exactEvidence(claim.identity, e)) return false;
    const original = (
      await tx.query<{ possible_dispatch_at: Date; valid_until: Date }>(
        `SELECT p.possible_dispatch_at,c.expires_at valid_until FROM whaleu_notifications.rating_group_attempts a JOIN whaleu_notifications.rating_group_permits p ON p.attempt_id=a.id JOIN whaleu_notifications.rating_group_effects x ON x.id=a.effect_id JOIN whaleu_ratings.promotion_campaigns c ON c.id=x.campaign_id WHERE a.id=$1 AND a.claimed_at>clock_timestamp()-interval '180 days'`,
        [e.attemptId],
      )
    ).rows[0];
    const now = (
      await tx.query<{ now: number }>(
        `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::float8 now`,
      )
    ).rows[0]!.now;
    if (
      !original ||
      e.acceptedAt < original.possible_dispatch_at.getTime() - 1 ||
      e.acceptedAt >= original.valid_until.getTime() ||
      e.observedAt > now ||
      e.acceptedAt > e.observedAt
    )
      return false;
    const metadata = { ...e };
    delete metadata.output;
    await tx.query(
      `INSERT INTO whaleu_notifications.rating_group_evidence(id,effect_id,original_attempt_id,original_key,profile_id,account_lineage,receipt_id,kind,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(original_attempt_id,kind) DO NOTHING`,
      [
        randomUUID(),
        e.effectId,
        e.attemptId,
        e.key,
        e.profileId,
        e.accountLineage,
        e.receiptId,
        e.kind,
        metadata,
      ],
    );
    const cap = claim.effect.stage === 'delivery' ? 3 : 2;
    const settled = await tx.query(
      `UPDATE whaleu_notifications.rating_group_effects SET state=$4,confirmed_at=CASE WHEN $4='confirmed' THEN to_timestamp($5::float8/1000) ELSE NULL END,result_text=CASE WHEN EXISTS(SELECT 1 FROM whaleu_ratings.promotion_campaigns c WHERE c.id=campaign_id AND c.payload_purged_at IS NULL AND c.expires_at+interval '24 hours'>clock_timestamp()) THEN $6 ELSE NULL END,lease_until=NULL,reason=$7,next_action_at=clock_timestamp()+CASE WHEN dispatches=1 THEN interval '5 seconds' ELSE interval '30 seconds' END WHERE id=$1 AND attempt_id=$2 AND fence=$3`,
      [
        e.effectId,
        e.attemptId,
        claim.fence,
        e.kind === 'accepted'
          ? 'confirmed'
          : claim.effect.dispatches + Number(claim.operation === 'dispatch') >=
              cap
            ? 'suppressed_unsent'
            : 'retry_wait',
        e.acceptedAt,
        e.output ?? null,
        e.kind,
      ],
    );
    if (settled.rowCount !== 1)
      throw new ApplicationError('PROMOTION_UNAVAILABLE');
    await tx.query(
      `DELETE FROM whaleu_notifications.rating_group_emission_slots WHERE effect_id=$1 AND attempt_id=$2`,
      [e.effectId, e.attemptId],
    );
    await tx.query(
      `DELETE FROM whaleu_notifications.rating_group_receiver_gates WHERE effect_id=$1 AND original_attempt_id=$2 AND fence=$3`,
      [e.effectId, e.attemptId, e.fence],
    );
    await tx.query(
      `UPDATE whaleu_ratings.promotion_cost_reservations SET settled=true WHERE effect_id=$1 AND attempt_id=$2`,
      [e.effectId, e.attemptId],
    );
    return true;
  }
}
export function exactEvidence(i: EffectIdentity, e: Evidence): boolean {
  const { kind, receiptId, acceptedAt, observedAt, proofHash } = e;
  return (
    digest(i) === digest(effectIdentity(e)) &&
    Object.keys(e).every((key) =>
      [
        ...Object.keys(i),
        'kind',
        'receiptId',
        'acceptedAt',
        'observedAt',
        'proofHash',
        'output',
      ].includes(key),
    ) &&
    ['accepted', 'not_accepted'].includes(kind) &&
    typeof receiptId === 'string' &&
    receiptId.length > 0 &&
    receiptId.length <= 200 &&
    /^[a-f0-9]{64}$/.test(proofHash) &&
    Number.isSafeInteger(acceptedAt) &&
    Number.isSafeInteger(observedAt) &&
    Buffer.byteLength(JSON.stringify(e)) <= 2048
  );
}
