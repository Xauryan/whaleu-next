import { SessionStore } from '../src/auth/session';
import {
  ExperienceController,
  initialExperienceView,
} from '../src/experience/controller';
import { ExperienceRuntime } from '../src/experience/runtime';
import { PendingExperienceStore } from '../src/experience/pending';
import {
  experienceThresholds,
  type ExperienceAppearance,
  type ExperienceCatalog,
  type ExperienceSummary,
  type SignInReceipt,
  type ExperienceRecords,
  type ExperienceUnlocks,
} from '../src/experience/contract';
import type { ExperienceGateway } from '../src/experience/gateway';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
export const requestId = '77777777-7777-4777-8777-777777777777';
export const recordId = '88888888-8888-4888-8888-888888888888';
export const noticeId = '99999999-9999-4999-8999-999999999999';
export const otherAccount = '33333333-3333-4333-8333-333333333333';
export const at = '2026-10-08T01:00:00.000Z';
const actions = [
  'publish',
  'comment',
  'like_save',
  'received_like_save',
  'received_comment',
] as const;
export function catalog(): ExperienceCatalog {
  return {
    ruleVersion: 'local-experience-v1',
    timezone: 'Asia/Shanghai',
    levels: experienceThresholds.map((v, i) => ({
      level: i + 1,
      threshold: String(v),
    })),
    rules: actions.map((action, i) => ({
      action,
      amount: [10, 3, 1, 2, 3][i]!,
      dailyLimit: [1, 5, 10, 10, 5][i]!,
      refundLimit: [1, 3, 0, 0, 0][i]!,
    })),
    signInRewards: [2, 4, 6, 8, 10, 12, 15],
    titles: [
      {
        key: 'default_jingxiaoyu',
        name: '鲸小语',
        kind: 'default',
        unlockLevel: null,
      },
      ...Array.from({ length: 15 }, (_, i) => ({
        key: `level_${i * 2 + 1}`,
        name: i === 0 ? '萌新小白' : `合成头衔${i}`,
        kind: 'level' as const,
        unlockLevel: i * 2 + 1,
      })),
    ],
    colors: Array.from({ length: 26 }, (_, id) => ({
      id,
      name: `颜色 ${id}`,
      unlockLevel: id < 11 ? 0 : (id - 10) * 2,
    })),
  };
}
export function summary(
  overrides: Partial<ExperienceSummary> = {},
): ExperienceSummary {
  return {
    ruleVersion: 'local-experience-v1',
    timezone: 'Asia/Shanghai',
    serverDay: '2026-10-08',
    baseline: 'known',
    coverage: { history: 'complete', entitlements: 'complete' },
    balance: '0',
    level: 1,
    progress: {
      currentThreshold: '0',
      nextThreshold: '15',
      pointsIntoLevel: '0',
      pointsToNextLevel: '15',
      percent: 0,
    },
    signIn: {
      signedIn: false,
      lastDay: null,
      streak: 0,
      nextStreak: 1,
      nextReward: 2,
    },
    tasks: catalog().rules.map((r) => ({
      action: r.action,
      amount: r.amount,
      dailyLimit: r.dailyLimit,
      rewardedCount: 0,
      refundCount: 0,
      remaining: r.dailyLimit,
      grossPositiveAwarded: '0',
    })),
    pending: { count: 0, reason: null },
    stateRevision: '0',
    ...overrides,
  };
}
export function unknownSummary(): ExperienceSummary {
  const s = summary();
  return {
    ...s,
    baseline: 'baseline_unknown',
    coverage: { history: 'partial', entitlements: 'partial' },
    balance: null,
    level: null,
    progress: null,
    stateRevision: null,
    signIn: {
      signedIn: null,
      lastDay: null,
      streak: null,
      nextStreak: null,
      nextReward: null,
    },
    tasks: s.tasks.map((t) => ({
      ...t,
      rewardedCount: null,
      refundCount: null,
      remaining: null,
      grossPositiveAwarded: null,
    })),
  };
}
export function appearance(
  overrides: Partial<ExperienceAppearance> = {},
): ExperienceAppearance {
  return {
    coverage: 'complete',
    titles: catalog()
      .titles.slice(0, 2)
      .map((t) => ({ ...t, earnedAt: at, recordedAt: at })),
    titleKey: null,
    colorId: null,
    eligibleColorIds: Array.from({ length: 11 }, (_, i) => i),
    revision: '0',
    ...overrides,
  };
}
export function receipt(overrides: Partial<SignInReceipt> = {}): SignInReceipt {
  return {
    requestId,
    operation: 'sign_in',
    outcome: 'awarded',
    rewardDay: '2026-10-08',
    appliedDelta: '2',
    balance: '2',
    streak: 1,
    stateRevision: '1',
    ...overrides,
  };
}
export class FakeExperienceGateway implements ExperienceGateway {
  readonly calls: Array<{ method: string; body?: unknown }> = [];
  currentSummary = summary();
  currentAppearance = appearance();
  currentRecords: ExperienceRecords = {
    items: [],
    coverage: 'complete',
    nextCursor: null,
  };
  currentUnlocks: ExperienceUnlocks = { items: [] };
  summaryImpl: ExperienceGateway['summary'] = async () => this.currentSummary;
  catalogImpl: ExperienceGateway['catalog'] = async () => catalog();
  recordsImpl: ExperienceGateway['records'] = async () => this.currentRecords;
  appearanceImpl: ExperienceGateway['appearance'] = async () =>
    this.currentAppearance;
  signInImpl: ExperienceGateway['signIn'] = async (intent) => {
    this.currentSummary = summary({
      balance: '2',
      progress: {
        currentThreshold: '0',
        nextThreshold: '15',
        pointsIntoLevel: '2',
        pointsToNextLevel: '13',
        percent: 13,
      },
      signIn: {
        signedIn: true,
        lastDay: '2026-10-08',
        streak: 1,
        nextStreak: 2,
        nextReward: 4,
      },
      stateRevision: '1',
    });
    return receipt({ requestId: intent.requestId });
  };
  selectAppearanceImpl: ExperienceGateway['selectAppearance'] = async (i) => {
    this.currentAppearance = appearance({
      ...this.currentAppearance,
      titleKey: i.titleKey,
      colorId: i.colorId,
      revision: String(BigInt(i.expectedRevision) + 1n),
    });
    return {
      requestId: i.requestId,
      operation: 'appearance',
      outcome: 'applied',
      titleKey: i.titleKey,
      colorId: i.colorId,
      revision: this.currentAppearance.revision,
    };
  };
  receiptImpl: ExperienceGateway['receipt'] = async (id) =>
    receipt({ requestId: id });
  unlocksImpl: ExperienceGateway['unlocks'] = async () => this.currentUnlocks;
  acknowledgeImpl: ExperienceGateway['acknowledge'] = async (id) => ({
    noticeId: id,
    acknowledged: true,
  });
  summary(c: Parameters<ExperienceGateway['summary']>[0]) {
    this.calls.push({ method: 'summary' });
    return this.summaryImpl(c);
  }
  catalog(c: Parameters<ExperienceGateway['catalog']>[0]) {
    this.calls.push({ method: 'catalog' });
    return this.catalogImpl(c);
  }
  records(a: string | null, c: Parameters<ExperienceGateway['summary']>[0]) {
    this.calls.push({ method: 'records', body: a });
    return this.recordsImpl(a, c);
  }
  appearance(c: Parameters<ExperienceGateway['summary']>[0]) {
    this.calls.push({ method: 'appearance' });
    return this.appearanceImpl(c);
  }
  signIn(
    i: Parameters<ExperienceGateway['signIn']>[0],
    c: Parameters<ExperienceGateway['summary']>[0],
  ) {
    this.calls.push({ method: 'signIn', body: i });
    return this.signInImpl(i, c);
  }
  selectAppearance(
    i: Parameters<ExperienceGateway['selectAppearance']>[0],
    c: Parameters<ExperienceGateway['summary']>[0],
  ) {
    this.calls.push({ method: 'selectAppearance', body: i });
    return this.selectAppearanceImpl(i, c);
  }
  receipt(id: string, c: Parameters<ExperienceGateway['summary']>[0]) {
    this.calls.push({ method: 'receipt', body: id });
    return this.receiptImpl(id, c);
  }
  unlocks(c: Parameters<ExperienceGateway['summary']>[0]) {
    this.calls.push({ method: 'unlocks' });
    return this.unlocksImpl(c);
  }
  acknowledge(id: string, c: Parameters<ExperienceGateway['summary']>[0]) {
    this.calls.push({ method: 'acknowledge', body: id });
    return this.acknowledgeImpl(id, c);
  }
}
export function setup(loggedIn = true) {
  const sessions = new SessionStore();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const storage = new MemoryStorage(),
    gateway = new FakeExperienceGateway();
  let ids = 0;
  const runtime = new ExperienceRuntime(
    sessions,
    gateway,
    new PendingExperienceStore(storage, 'https://api.example.invalid'),
    async () =>
      ids++ === 0
        ? requestId
        : `77777777-7777-4777-8777-${String(ids).padStart(12, '0')}`,
  );
  let view = initialExperienceView();
  const controller = new ExperienceController(runtime, (v) => {
    view = v;
  });
  return {
    sessions,
    storage,
    gateway,
    runtime,
    controller,
    view: () => view,
    ids: () => ids,
  };
}
