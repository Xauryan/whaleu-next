import { currentPromotionProfile } from '../../ratings/group-promotion/profile.js';
import { requireRatingPromotionSession } from '../../identity/rating-promotion-session.js';
import { randomUUID } from 'node:crypto';
import {
  issueRatingGroupPermit,
  prepareRatingGroupPermit,
  type RatingGroupPermitCapsule,
} from './permit.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionExactDeadline } from '../../database/transaction-deadlines.js';
import {
  RatingGroupPromotionService,
  type CampaignRow,
} from '../../ratings/group-promotion/service.js';
import {
  deterministicCopy,
  digest,
  effectIdentity,
  payloadHash,
  qualifiedLiteral,
  validatePayload,
  type Destination,
  type EffectStage,
  type Evidence,
  type FrozenPayload,
  type Program,
  type RatingGroupPromotionRuntime,
  type ReceiptSubscription,
  type SyntheticEffectPort,
} from '../../ratings/group-promotion/contracts.js';
import {
  RatingGroupRepository,
  exactEvidence,
  type Claim,
  type EffectRow,
} from './repository.js';

export async function boundedOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T | null> {
  if (ms <= 0) return null;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(abort.signal),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve(null);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
  }
}
/** Disposable subscriptions, not retained pending receipt promises. */
export function waitReceipt(
  handle: ReceiptSubscription,
  ms: number,
): Promise<Evidence | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (e: Evidence | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        handle.dispose();
      } catch {
        e = null;
      } finally {
        resolve(e);
      }
    };
    const timer = setTimeout(() => finish(null), Math.max(0, ms));
    try {
      handle.subscribe(finish);
    } catch {
      finish(null);
    }
  });
}
function port(
  rt: RatingGroupPromotionRuntime,
  stage: EffectStage,
): SyntheticEffectPort | null {
  return stage === 'generation'
    ? rt.generation
    : stage === 'shortlink'
      ? rt.shortlinks
      : rt.sender;
}
function copyInput(c: CampaignRow, p: Program, label: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: p.timezone,
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(c.created_at);
  return {
    purpose: 'rating_push' as const,
    label,
    date: `${parts.find((x) => x.type === 'month')!.value}/${parts.find((x) => x.type === 'day')!.value}`,
    type: p.type,
  };
}
@Injectable()
export class RatingGroupWorker {
  private active = 0;
  constructor(
    @Inject(RatingGroupPromotionService)
    private readonly app: RatingGroupPromotionService,
    @Inject(RatingGroupRepository) private readonly repo: RatingGroupRepository,
  ) {}
  async maintain(): Promise<{ processed: number }> {
    if (!this.app.runtime) return { processed: 0 };
    const start = performance.now();
    let processed = 0;
    // One campaign and at most 128 recipient enrollments per call. The persisted
    // next-maintenance clock prevents unknown composition from starving peers.
    await this.app.run(async (tx) => {
      const c = (
        await tx.query<CampaignRow>(
          `SELECT * FROM whaleu_ratings.promotion_campaigns WHERE next_maintenance_at<=clock_timestamp() AND expires_at>clock_timestamp() AND cancelled_at IS NULL AND (cursor IS NULL OR EXISTS(SELECT 1 FROM whaleu_ratings.promotion_campaign_recipients r WHERE r.campaign_id=id AND r.stable_destination_id>cursor)) ORDER BY next_maintenance_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        )
      ).rows[0];
      if (!c) return;
      await tx.query(
        `UPDATE whaleu_ratings.promotion_campaigns SET next_maintenance_at=clock_timestamp()+interval '5 seconds' WHERE id=$1`,
        [c.id],
      );
      const { rt, p, source } = await this.currentCampaign(c, tx);
      if (!c.payload_hash) {
        const effects = (
          await tx.query<EffectRow>(
            "SELECT * FROM whaleu_notifications.rating_group_effects WHERE campaign_id=$1 AND stage<>'delivery'",
            [c.id],
          )
        ).rows;
        const generation = effects.find((e) => e.stage === 'generation'),
          shortlink = effects.find((e) => e.stage === 'shortlink');
        const deadline = (
          await tx.query<{ due: boolean }>(`SELECT clock_timestamp()>=$1 due`, [
            c.compose_by,
          ])
        ).rows[0]!.due;
        if (!deadline && c.command.copyMode === 'assisted' && !generation)
          await this.repo.add(
            c,
            p,
            'generation',
            digest(copyInput(c, p, source.label)),
            null,
            tx,
          );
        if (!deadline && c.command.linkMode !== 'native' && !shortlink)
          await this.repo.add(
            c,
            p,
            'shortlink',
            digest({ nativeLocator: source.locator }),
            null,
            tx,
          );
        const unresolved = (e: EffectRow | undefined) =>
          !e || !['confirmed', 'suppressed_unsent'].includes(e.state);
        if (
          !deadline &&
          ((c.command.copyMode === 'assisted' && unresolved(generation)) ||
            (c.command.linkMode !== 'native' && unresolved(shortlink)))
        )
          return;
        let copy = deterministicCopy(p.type),
          provenance =
            c.command.copyMode === 'assisted' ? 'fallback' : 'deterministic';
        if (
          generation?.state === 'confirmed' &&
          qualifiedLiteral(generation.result_text)
        ) {
          copy = generation.result_text;
          provenance = 'generated';
        }
        let locator = source.locator;
        if (shortlink?.state === 'confirmed' && shortlink.result_text) {
          try {
            const value = JSON.parse(shortlink.result_text) as {
              locator: unknown;
              nativeLocatorHash: unknown;
              expiresAt: unknown;
            };
            if (
              typeof value.locator === 'string' &&
              /^synthetic:\/\/rating-promotion\/[a-zA-Z0-9_-]+$/.test(
                value.locator,
              ) &&
              Buffer.byteLength(value.locator) <= 200 &&
              value.nativeLocatorHash === digest(source.locator) &&
              typeof value.expiresAt === 'number' &&
              value.expiresAt > c.expires_at.getTime() + 60000
            )
              locator = value.locator;
          } catch {
            /* malformed result has no locator authority */
          }
        }
        if (
          c.command.linkMode === 'shortlink_required' &&
          locator === source.locator
        )
          return;
        let payload: FrozenPayload = {
          profileVersion: 'rating-group-v1',
          type: p.type,
          copy,
          locator,
          nativeLocatorHash: digest(source.locator),
          sourceBindingHash: c.source_hash,
        };
        validatePayload(payload);
        let qualification: string;
        try {
          qualification = await rt.qualification.current(p, payload, tx);
        } catch (error) {
          if (provenance !== 'generated') throw error;
          payload = { ...payload, copy: deterministicCopy(p.type) };
          provenance = 'fallback';
          qualification = await rt.qualification.current(p, payload, tx);
        }
        c.payload = payload;
        c.payload_hash = payloadHash(payload);
        c.qualification_hash = qualification;
        await tx.query(
          `UPDATE whaleu_ratings.promotion_campaigns SET payload=$2,payload_hash=$3,qualification_hash=$4,copy_provenance=$5 WHERE id=$1 AND payload_hash IS NULL`,
          [c.id, payload, c.payload_hash, qualification, provenance],
        );
      }
      const rows = (
        await tx.query<{ stable_destination_id: string }>(
          `SELECT stable_destination_id FROM whaleu_ratings.promotion_campaign_recipients WHERE campaign_id=$1 AND ($2::uuid IS NULL OR stable_destination_id>$2) ORDER BY stable_destination_id LIMIT 128`,
          [c.id, c.cursor],
        )
      ).rows;
      for (const r of rows) {
        if (performance.now() - start >= 20000) break;
        await this.repo.add(
          c,
          p,
          'delivery',
          c.payload_hash!,
          r.stable_destination_id,
          tx,
        );
        c.cursor = r.stable_destination_id;
        processed++;
      }
      await tx.query(
        'UPDATE whaleu_ratings.promotion_campaigns SET cursor=$2 WHERE id=$1',
        [c.id, c.cursor],
      );
    });
    return { processed };
  }
  async currentCampaign(c: CampaignRow, tx: PoolClient) {
    await this.app.verifyRuntime(tx);
    const rt = this.app.enabled(),
      p = await this.app.program(c.program_id, tx);
    if (
      c.cancelled_at ||
      c.program_revision !== p.revision ||
      c.source_hash !== p.source_hash ||
      c.grant_epoch.toString() !== p.grant_epoch.toString()
    )
      throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
    const valid = (
      await tx.query<{ until: string }>(
        `SELECT expires_at::text until FROM whaleu_ratings.promotion_campaigns WHERE id=$1 AND cancelled_at IS NULL AND expires_at>clock_timestamp()`,
        [c.id],
      )
    ).rows[0];
    if (!valid) throw new ApplicationError('PROMOTION_UNAVAILABLE');
    registerTransactionExactDeadline(tx, valid.until, 'PROMOTION_UNAVAILABLE');
    const same = (
      await tx.query(
        `SELECT 1 FROM whaleu_ratings.promotion_grants WHERE program_id=$1 AND principal_lineage=$2 AND revision=$3 AND active`,
        [p.id, c.actor, c.grant_revision],
      )
    ).rows[0];
    if (!same) throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
    if (c.principal_kind !== 'service')
      await requireRatingPromotionSession(
        c.actor,
        c.originating_session_id,
        tx,
      );
    const authority =
      c.principal_kind === 'service'
        ? await rt.authority.service(p, c.actor, tx)
        : await rt.authority.current(
            c.actor,
            p,
            c.mode === 'test' ? 'test' : 'send',
            tx,
          );
    const source = await rt.source.current(p, tx, c.mode);
    return { rt, p, authority, source };
  }
  async drain(): Promise<{
    claimed: number;
    confirmed: number;
    unknown: number;
  }> {
    const result = { claimed: 0, confirmed: 0, unknown: 0 };
    if (!this.app.runtime || this.active >= 4) return result;
    this.active++;
    const deadline = performance.now() + 10000,
      workerToken = randomUUID();
    let leased = false;
    try {
      leased = await this.app.run(async (tx) => {
        await tx.query(
          `INSERT INTO whaleu_notifications.rating_group_worker_leases(slot,token,lease_until) SELECT n,$1,clock_timestamp()-interval '1 second' FROM generate_series(1,4) n ON CONFLICT DO NOTHING`,
          [workerToken],
        );
        const row = (
          await tx.query<{ slot: number }>(
            `SELECT slot FROM whaleu_notifications.rating_group_worker_leases WHERE lease_until<=clock_timestamp() ORDER BY slot LIMIT 1 FOR UPDATE SKIP LOCKED`,
          )
        ).rows[0];
        if (!row) return false;
        await tx.query(
          `UPDATE whaleu_notifications.rating_group_worker_leases SET token=$2,lease_until=clock_timestamp()+interval '30 seconds' WHERE slot=$1`,
          [row.slot, workerToken],
        );
        return true;
      }, 500);
      if (!leased) return result;
      for (let i = 0; i < 16 && performance.now() < deadline; i++) {
        if (deadline - performance.now() < 7000) break;
        let claim: Claim | null = null;
        for (const stage of ['delivery', 'generation', 'shortlink'] as const) {
          claim = await this.app.run((tx) => this.repo.claim(stage, tx), 500);
          if (claim) break;
        }
        if (!claim) break;
        result.claimed++;
        const state = await this.process(claim, deadline);
        if (state === 'confirmed') result.confirmed++;
        else if (state === 'unknown') result.unknown++;
      }
    } finally {
      this.active--;
      if (leased)
        try {
          await this.app.run(async (tx) => {
            await tx.query(
              `UPDATE whaleu_notifications.rating_group_worker_leases SET lease_until=clock_timestamp() WHERE token=$1`,
              [workerToken],
            );
          }, 500);
        } catch {
          /* bounded lease expiry recovers local capacity, never receiver gates */
        }
    }
    return result;
  }
  private authorityLost(error: unknown): boolean {
    return (
      error instanceof ApplicationError &&
      ['PROMOTION_SOURCE_CHANGED', 'PROMOTION_FORBIDDEN'].includes(error.code)
    );
  }
  private async process(
    claim: Claim,
    deadline: number,
  ): Promise<'confirmed' | 'unknown' | 'not_sent'> {
    const rt = this.app.enabled(),
      adapter = port(rt, claim.effect.stage);
    if (claim.operation === 'reconcile') {
      try {
        await this.app.run((tx) => this.app.verifyRuntime(tx), 500);
        const evidence = adapter
          ? await boundedOperation(
              (signal) => adapter.reconcile(claim.identity, signal),
              Math.min(3000, deadline - performance.now() - 500),
            )
          : null;
        if (
          evidence &&
          adapter?.authenticate(evidence) &&
          exactEvidence(claim.identity, evidence)
        ) {
          const settled = await this.app.run(
            (tx) => this.repo.settle(claim, evidence, tx),
            500,
          );
          if (settled)
            return evidence.kind === 'accepted' ? 'confirmed' : 'not_sent';
        }
      } catch {
        /* unknown remains durable */
      }
      await this.safeUnknown(claim);
      return 'unknown';
    }
    if (!adapter) {
      await this.app.run(
        (tx) => this.repo.noSend(claim, 'provider_unavailable', true, tx),
        500,
      );
      return 'not_sent';
    }
    let prepared: Awaited<ReturnType<SyntheticEffectPort['prepare']>> | null;
    try {
      const input = await this.app.run(async (tx) => {
        await this.repo.current(claim, tx, 7000);
        const c = (
          await tx.query<CampaignRow>(
            'SELECT * FROM whaleu_ratings.promotion_campaigns WHERE id=$1',
            [claim.effect.campaign_id],
          )
        ).rows[0]!;
        const { p, source } = await this.currentCampaign(c, tx);
        if (claim.effect.stage === 'delivery') {
          if (
            !c.payload ||
            payloadHash(c.payload) !== claim.identity.payloadHash
          )
            throw new ApplicationError('PROMOTION_UNAVAILABLE');
          return c.payload;
        }
        if (
          (
            await tx.query<{ expired: boolean }>(
              `SELECT clock_timestamp()>=$1 expired`,
              [c.compose_by],
            )
          ).rows[0]!.expired
        )
          throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
        return claim.effect.stage === 'generation'
          ? copyInput(c, p, source.label)
          : { nativeLocator: source.locator };
      });
      if (
        digest(input) !== claim.identity.inputHash &&
        claim.effect.stage !== 'delivery'
      )
        throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
      prepared = await boundedOperation(
        (signal) => adapter.prepare(claim.identity, input, signal),
        Math.min(3000, deadline - performance.now() - 7000),
      );
      if (
        !prepared ||
        digest(prepared.identity) !== digest(claim.identity) ||
        deadline - performance.now() < 7000
      ) {
        prepared?.dispose?.();
        await this.app.run(
          (tx) => this.repo.noSend(claim, 'start_budget', false, tx),
          500,
        );
        return 'not_sent';
      }
    } catch (error) {
      await this.app.run(
        (tx) =>
          this.repo.noSend(
            claim,
            error instanceof ApplicationError
              ? 'source_or_authority'
              : 'preparation_unavailable',
            this.authorityLost(error),
            tx,
          ),
        500,
      );
      return 'not_sent';
    }
    let finalProof: RatingGroupPermitCapsule;
    try {
      finalProof = await this.app.run(async (tx) => {
        if (deadline - performance.now() < 7000)
          throw new ApplicationError('PROMOTION_UNAVAILABLE');
        await this.repo.current(claim, tx, 7000);
        const c = (
          await tx.query<CampaignRow>(
            'SELECT * FROM whaleu_ratings.promotion_campaigns WHERE id=$1 FOR SHARE',
            [claim.effect.campaign_id],
          )
        ).rows[0]!;
        const { p, authority } = await this.currentCampaign(c, tx);
        if (claim.identity.profileId !== p.profile_id)
          throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
        if (claim.effect.stage !== 'delivery')
          await currentPromotionProfile(
            p,
            claim.effect.stage,
            tx,
            claim.effect.profile_policy_revision,
          );
        let receiverProof = '',
          qualification = '';
        if (claim.effect.stage === 'delivery') {
          const d = (
            await tx.query<Destination>(
              `SELECT r.*,m.enrollment_revision FROM whaleu_ratings.promotion_campaign_recipients s JOIN whaleu_ratings.promotion_program_members_current m ON m.program_id=$1 AND m.stable_destination_id=s.stable_destination_id AND m.enrollment_revision=s.enrollment_revision AND m.registry_revision=s.registry_revision JOIN whaleu_ratings.promotion_receivers r ON r.id=m.stable_destination_id AND r.revision=m.registry_revision WHERE s.campaign_id=$2 AND s.stable_destination_id=$3`,
              [p.id, c.id, claim.identity.destinationId],
            )
          ).rows[0];
          if (
            !d ||
            !c.payload ||
            payloadHash(c.payload) !== claim.identity.payloadHash
          )
            throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
          receiverProof = await rt.authority.receiver(p, d, tx);
          qualification = await rt.qualification.current(p, c.payload, tx);
          if (qualification !== c.qualification_hash)
            throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
        }
        const authorityDigest = digest([
          authority,
          receiverProof,
          qualification,
        ]);
        await this.repo.markPossible(claim, c, authorityDigest, tx);
        return prepareRatingGroupPermit(tx, claim.identity, authorityDigest);
      }, 1000);
    } catch (error) {
      prepared.dispose?.();
      await this.app.run(
        (tx) =>
          this.repo.noSend(
            claim,
            'final_authority_or_budget',
            this.authorityLost(error),
            tx,
          ),
        500,
      );
      return 'not_sent';
    }
    // Nothing asynchronous, no serialization, and no preparation between final
    // commit and the adapter's synchronous one-use boundary.
    let completion: Evidence | ReceiptSubscription | null = null;
    try {
      if (
        deadline - performance.now() >= 7000 &&
        (claim.leaseDeadline ?? 0) - performance.now() >= 7000
      )
        completion = prepared.dispatch(issueRatingGroupPermit(finalProof));
      else prepared.dispose?.();
    } catch {
      /* possible acceptance */
    }
    let evidence: Evidence | null = null;
    try {
      evidence =
        completion && 'subscribe' in completion
          ? await waitReceipt(
              completion,
              Math.min(
                5000,
                deadline - performance.now() - 500,
                (claim.leaseDeadline ?? 0) - performance.now() - 1000,
              ),
            )
          : completion;
      if (
        evidence &&
        adapter.authenticate(evidence) &&
        exactEvidence(claim.identity, evidence)
      ) {
        const settled = await this.app.run(
          (tx) => this.repo.settle(claim, evidence!, tx),
          500,
        );
        if (settled)
          return evidence.kind === 'accepted' ? 'confirmed' : 'not_sent';
      }
    } catch {
      /* failure cannot prove not-sent */
    }
    await this.safeUnknown(claim);
    return 'unknown';
  }
  private async safeUnknown(claim: Claim) {
    try {
      await this.app.run((tx) => this.repo.leaveUnknown(claim, tx), 500);
    } catch {
      /* durable unknown-before-dispatch already wins */
    }
  }
  async admitEvidence(evidence: Evidence): Promise<boolean> {
    const rt = this.app.enabled(),
      adapter = port(rt, evidence.stage);
    if (
      evidence.output !== undefined ||
      !adapter?.authenticate(evidence) ||
      Buffer.byteLength(JSON.stringify(evidence)) > 2048
    )
      return false;
    return this.app.run(async (tx) => {
      const original = (
        await tx.query<{ identity: Claim['identity'] }>(
          `SELECT a.identity FROM whaleu_notifications.rating_group_attempts a JOIN whaleu_notifications.rating_group_permits p ON p.attempt_id=a.id WHERE a.id=$1 AND a.operation='dispatch' AND a.claimed_at>clock_timestamp()-interval '180 days'`,
          [evidence.attemptId],
        )
      ).rows[0];
      if (!original || !exactEvidence(original.identity, evidence))
        return false;
      await tx.query(
        `INSERT INTO whaleu_notifications.rating_group_evidence_inbox(original_attempt_id,evidence) VALUES($1,$2) ON CONFLICT(original_attempt_id) DO UPDATE SET state=CASE WHEN whaleu_notifications.rating_group_evidence_inbox.evidence=EXCLUDED.evidence THEN whaleu_notifications.rating_group_evidence_inbox.state ELSE 'quarantined' END`,
        [evidence.attemptId, evidence],
      );
      return true;
    }, 500);
  }
  async consumeEvidence(): Promise<number> {
    if (!this.app.runtime) return 0;
    const deadline = performance.now() + 3000;
    let n = 0;
    for (let i = 0; i < 16 && performance.now() < deadline; i++) {
      const consumed = await this.app.run(async (tx) => {
        const row = (
          await tx.query<{ original_attempt_id: string; evidence: Evidence }>(
            `SELECT * FROM whaleu_notifications.rating_group_evidence_inbox WHERE state='pending' ORDER BY received_at,original_attempt_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
          )
        ).rows[0];
        if (!row) return false;
        await this.app.verifyRuntime(tx);
        if (
          !port(this.app.enabled(), row.evidence.stage)?.authenticate(
            row.evidence,
          ) ||
          row.evidence.output !== undefined
        ) {
          await tx.query(
            "UPDATE whaleu_notifications.rating_group_evidence_inbox SET state='quarantined' WHERE original_attempt_id=$1",
            [row.original_attempt_id],
          );
          return true;
        }
        const e = (
          await tx.query<EffectRow>(
            `SELECT *,fence::text FROM whaleu_notifications.rating_group_effects WHERE id=$1 FOR UPDATE`,
            [row.evidence.effectId],
          )
        ).rows[0];
        if (
          !e ||
          e.attempt_id !== row.original_attempt_id ||
          !['dispatch_unknown', 'parked_unknown'].includes(e.state)
        ) {
          await tx.query(
            `UPDATE whaleu_notifications.rating_group_evidence_inbox SET state='quarantined' WHERE original_attempt_id=$1`,
            [row.original_attempt_id],
          );
          return true;
        }
        const fence = (BigInt(e.fence) + 1n).toString();
        await tx.query(
          `UPDATE whaleu_notifications.rating_group_effects SET fence=$2,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1`,
          [e.id, fence],
        );
        const claim: Claim = {
          effect: e,
          identity: row.evidence,
          fence,
          leaseRemaining: 30000,
          operation: 'reconcile',
        };
        claim.identity = effectIdentity(row.evidence);
        const settled = await this.repo.settle(claim, row.evidence, tx);
        await tx.query(
          `UPDATE whaleu_notifications.rating_group_evidence_inbox SET state=$2 WHERE original_attempt_id=$1`,
          [row.original_attempt_id, settled ? 'settled' : 'quarantined'],
        );
        return true;
      }, 500);
      if (!consumed) break;
      n++;
    }
    return n;
  }
}
