import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { ApplicationError } from '../http/application-error.js';
import {
  EXPERIENCE_RULE_VERSION,
  EXPERIENCE_TIMEZONE,
  colors,
  levelFor,
  progressFor,
  rewardActions,
  rules,
  signInPreview,
} from './catalog.js';
import type { TitleDefinition } from './catalog.js';
import type {
  AppearanceIntent,
  AppearanceRejection,
  AppearanceView,
  ExperiencePageQuery,
  ExperienceReceipt,
  ExperienceSummary,
} from './contracts.js';
import { ExperienceClock, ExperienceRepository } from './repository.js';
import { ExperienceSettlementService } from './settlement.js';
import { lockExperienceEnrollment, lockExperienceOwner } from './ingress.js';
function intentHash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
@Injectable()
export class ExperienceService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(ExperienceRepository)
    private readonly records: ExperienceRepository,
    @Inject(ExperienceClock) private readonly clock: ExperienceClock,
    @Inject(ExperienceSettlementService)
    private readonly settlement: ExperienceSettlementService,
  ) {}
  private read<T>(
    token: string,
    fn: (owner: string, tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async (tx) => {
      const owner = (await this.identity.session(token, tx)).accountId;
      await lockExperienceOwner(tx, owner, false, true);
      return fn(owner, tx);
    });
  }
  summary(token: string): Promise<ExperienceSummary> {
    return this.read(token, async (owner, tx) => {
      const state = await this.records.state(owner, tx),
        clock = await this.clock.now(tx),
        pending = await this.records.pending(owner, tx);
      const tasks: ExperienceSummary['tasks'] = [];
      for (const action of rewardActions) {
        const bucket = state
          ? await this.records.bucket(owner, clock.day, action, tx)
          : null;
        const rule = rules[action];
        tasks.push({
          action,
          amount: rule.amount,
          dailyLimit: rule.dailyLimit,
          rewardedCount: bucket?.rewarded_count ?? null,
          refundCount: bucket?.refund_count ?? null,
          remaining: bucket ? rule.dailyLimit - bucket.rewarded_count : null,
          grossPositiveAwarded: bucket?.gross_positive_awarded ?? null,
        });
      }
      return {
        ruleVersion: EXPERIENCE_RULE_VERSION,
        timezone: EXPERIENCE_TIMEZONE,
        serverDay: clock.day,
        baseline: state ? 'known' : 'baseline_unknown',
        coverage: {
          history: state?.history_coverage ?? 'partial',
          entitlements: state?.entitlement_coverage ?? 'partial',
        },
        balance: state?.balance ?? null,
        level: state ? levelFor(BigInt(state.balance)) : null,
        progress: state ? progressFor(BigInt(state.balance)) : null,
        signIn: state
          ? signInPreview(state.last_signin_day, state.streak, clock.day)
          : {
              signedIn: null,
              lastDay: null,
              streak: null,
              nextStreak: null,
              nextReward: null,
            },
        tasks,
        pending: {
          count: pending,
          reason: pending === 0 ? null : state ? 'queued' : 'baseline_unknown',
        },
        stateRevision: state?.revision ?? null,
      };
    });
  }
  recordsPage(token: string, query: ExperiencePageQuery) {
    return this.read(token, async (owner, tx) => ({
      ...(await this.records.recordPage(owner, query, tx)),
      coverage:
        (await this.records.state(owner, tx))?.history_coverage ??
        ('partial' as const),
    }));
  }
  receipt(token: string, id: string): Promise<ExperienceReceipt> {
    return this.read(token, async (owner, tx) => {
      const found = await this.records.request(owner, id, tx);
      if (!found) throw new ApplicationError('EXPERIENCE_REQUEST_NOT_FOUND');
      return found.receipt;
    });
  }
  signIn(token: string, requestId: string): Promise<ExperienceReceipt> {
    return this.database.transaction(async (tx) => {
      const owner = (await this.identity.session(token, tx)).accountId,
        hash = intentHash({ operation: 'sign_in' });
      await this.records.requestLock(owner, requestId, tx);
      const existing = await this.records.request(owner, requestId, tx);
      if (existing) {
        if (existing.intent_hash !== hash || existing.operation !== 'sign_in')
          throw new ApplicationError('EXPERIENCE_REQUEST_CONFLICT');
        return existing.receipt;
      }
      await lockExperienceEnrollment(tx);
      await lockExperienceOwner(tx, owner);
      const state = await this.records.state(owner, tx);
      if (!state) throw new ApplicationError('EXPERIENCE_BASELINE_UNAVAILABLE');
      if (await this.records.first(owner, tx))
        throw new ApplicationError('EXPERIENCE_PENDING');
      const receipt: ExperienceReceipt = {
        requestId,
        operation: 'sign_in',
        ...(await this.settlement.signIn(state, tx)),
      };
      await this.records.saveReceipt(owner, hash, receipt, tx);
      return receipt;
    });
  }
  appearance(token: string): Promise<AppearanceView> {
    return this.read(token, (owner, tx) => this.appearanceView(owner, tx));
  }
  private async appearanceView(
    owner: string,
    tx: PoolClient,
  ): Promise<AppearanceView> {
    const state = await this.records.state(owner, tx),
      selected = (
        await tx.query<{
          title_key: string | null;
          color_id: number | null;
          revision: string;
        }>(
          'SELECT title_key,color_id,revision::text FROM whaleu_experience.appearance WHERE owner_id=$1',
          [owner],
        )
      ).rows[0];
    const owned = (
      await tx.query<{
        title_key: string;
        name: string;
        kind: TitleDefinition['kind'];
        unlock_level: number | null;
        earned_at: Date | null;
        recorded_at: Date;
      }>(
        'SELECT e.title_key,t.name,t.kind,t.unlock_level,e.earned_at,e.recorded_at FROM whaleu_experience.entitlements e JOIN whaleu_experience.title_catalog t ON t.title_key=e.title_key WHERE e.owner_id=$1 ORDER BY t.unlock_level NULLS FIRST,e.title_key',
        [owner],
      )
    ).rows;
    const level = state ? levelFor(BigInt(state.balance)) : null;
    return {
      coverage: state?.entitlement_coverage ?? 'partial',
      titles: owned.map((r) => ({
        key: r.title_key,
        name: r.name,
        kind: r.kind,
        unlockLevel: r.unlock_level,
        earnedAt: r.earned_at?.toISOString() ?? null,
        recordedAt: r.recorded_at.toISOString(),
      })),
      titleKey: selected?.title_key ?? null,
      colorId: selected?.color_id ?? null,
      eligibleColorIds: colors
        .filter((c) => c.id <= 10 || (level !== null && c.unlockLevel <= level))
        .map((c) => c.id),
      revision: selected?.revision ?? '0',
    };
  }
  selectAppearance(
    token: string,
    input: AppearanceIntent,
  ): Promise<ExperienceReceipt> {
    return this.database.transaction(async (tx) => {
      const owner = (await this.identity.session(token, tx)).accountId;
      const hash = intentHash({
        operation: 'appearance',
        expectedRevision: input.expectedRevision,
        titleKey: input.titleKey,
        colorId: input.colorId,
      });
      await this.records.requestLock(owner, input.requestId, tx);
      const prior = await this.records.request(owner, input.requestId, tx);
      if (prior) {
        if (prior.intent_hash !== hash || prior.operation !== 'appearance')
          throw new ApplicationError('EXPERIENCE_REQUEST_CONFLICT');
        return prior.receipt;
      }
      await lockExperienceOwner(tx, owner, true);
      const view = await this.appearanceView(owner, tx);
      let code: AppearanceRejection | null = null;
      if (view.revision !== input.expectedRevision)
        code = 'EXPERIENCE_APPEARANCE_CONFLICT';
      else if (
        input.titleKey !== null &&
        !view.titles.some((x) => x.key === input.titleKey)
      )
        code = 'EXPERIENCE_TITLE_INELIGIBLE';
      else if (
        input.colorId !== null &&
        input.colorId !== view.colorId &&
        !view.eligibleColorIds.includes(input.colorId)
      )
        code = 'EXPERIENCE_COLOR_INELIGIBLE';
      let receipt: ExperienceReceipt;
      if (code)
        receipt = {
          requestId: input.requestId,
          operation: 'appearance',
          outcome: 'rejected',
          code,
        };
      else {
        await tx.query(
          'INSERT INTO whaleu_experience.appearance(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
          [owner],
        );
        const changed =
          input.titleKey !== view.titleKey || input.colorId !== view.colorId;
        const revision = (
          BigInt(view.revision) + BigInt(Number(changed))
        ).toString();
        if (changed)
          await tx.query(
            'UPDATE whaleu_experience.appearance SET title_key=$2,color_id=$3,revision=$4 WHERE owner_id=$1',
            [owner, input.titleKey, input.colorId, revision],
          );
        receipt = {
          requestId: input.requestId,
          operation: 'appearance',
          outcome: 'applied',
          titleKey: input.titleKey,
          colorId: input.colorId,
          revision,
        };
      }
      await this.records.saveReceipt(owner, hash, receipt, tx);
      return receipt;
    });
  }
  unlocks(token: string) {
    return this.read(token, async (owner, tx) => ({
      items: await this.records.notices(owner, tx),
    }));
  }
  acknowledge(token: string, id: string) {
    return this.database.transaction(async (tx) => {
      const owner = (await this.identity.session(token, tx)).accountId;
      await lockExperienceOwner(tx, owner);
      return this.records.acknowledge(owner, id, tx);
    });
  }
}
