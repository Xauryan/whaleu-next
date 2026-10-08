import { ClientError, isRecord } from '../api/errors';
import { isUuid } from '../profile/contract';

export const ruleVersion = 'local-experience-v1' as const;
export const timezone = 'Asia/Shanghai' as const;
export const rewardActions = [
  'publish',
  'comment',
  'like_save',
  'received_like_save',
  'received_comment',
] as const;
export type RewardAction = (typeof rewardActions)[number];
export type ExperienceAction =
  RewardAction | 'delete_post' | 'delete_comment' | 'delete_reply' | 'sign_in';
export type Coverage = 'complete' | 'partial';
export interface ExperienceTask {
  readonly action: RewardAction;
  readonly amount: number;
  readonly dailyLimit: number;
  readonly rewardedCount: number | null;
  readonly refundCount: number | null;
  readonly remaining: number | null;
  readonly grossPositiveAwarded: string | null;
}
export interface ExperienceSummary {
  readonly ruleVersion: typeof ruleVersion;
  readonly timezone: typeof timezone;
  readonly serverDay: string;
  readonly baseline: 'known' | 'baseline_unknown';
  readonly coverage: {
    readonly history: Coverage;
    readonly entitlements: Coverage;
  };
  readonly balance: string | null;
  readonly level: number | null;
  readonly progress: {
    readonly currentThreshold: string;
    readonly nextThreshold: string | null;
    readonly pointsIntoLevel: string;
    readonly pointsToNextLevel: string | null;
    readonly percent: number;
  } | null;
  readonly signIn: {
    readonly signedIn: boolean | null;
    readonly lastDay: string | null;
    readonly streak: number | null;
    readonly nextStreak: number | null;
    readonly nextReward: number | null;
  };
  readonly tasks: readonly ExperienceTask[];
  readonly pending: {
    readonly count: number;
    readonly reason: 'baseline_unknown' | 'queued' | null;
  };
  readonly stateRevision: string | null;
}
export interface ExperienceTitle {
  readonly key: string;
  readonly name: string;
  readonly kind: 'default' | 'level';
  readonly unlockLevel: number | null;
}
export interface ExperienceColor {
  readonly id: number;
  readonly name: string;
  readonly unlockLevel: number;
}
export interface ExperienceCatalog {
  readonly ruleVersion: typeof ruleVersion;
  readonly timezone: typeof timezone;
  readonly levels: readonly {
    readonly level: number;
    readonly threshold: string;
  }[];
  readonly rules: readonly {
    readonly action: RewardAction;
    readonly amount: number;
    readonly dailyLimit: number;
    readonly refundLimit: number;
  }[];
  readonly signInRewards: readonly number[];
  readonly titles: readonly ExperienceTitle[];
  readonly colors: readonly ExperienceColor[];
}
export interface ExperienceRecord {
  readonly recordId: string;
  readonly action: ExperienceAction;
  readonly nominalDelta: string | null;
  readonly appliedDelta: string | null;
  readonly balanceAfter: string | null;
  readonly outcome: 'awarded' | 'capped' | 'deducted' | 'historical';
  readonly occurredAt: string | null;
  readonly appliedAt: string | null;
  readonly recordedAt: string;
}
export interface ExperienceRecords {
  readonly items: readonly ExperienceRecord[];
  readonly nextCursor: string | null;
  readonly coverage: Coverage;
}
export interface OwnedExperienceTitle extends ExperienceTitle {
  readonly earnedAt: string | null;
  readonly recordedAt: string;
}
export interface ExperienceAppearance {
  readonly coverage: Coverage;
  readonly titles: readonly OwnedExperienceTitle[];
  readonly titleKey: string | null;
  readonly colorId: number | null;
  readonly eligibleColorIds: readonly number[];
  readonly revision: string;
}
export interface SignInIntent {
  readonly requestId: string;
}
export interface AppearanceIntent {
  readonly requestId: string;
  readonly expectedRevision: string;
  readonly titleKey: string | null;
  readonly colorId: number | null;
}
export type ExperienceOperation = 'sign_in' | 'appearance';
export type ExperienceIntent =
  | ({ readonly operation: 'sign_in' } & SignInIntent)
  | ({ readonly operation: 'appearance' } & AppearanceIntent);
export interface SignInReceipt {
  readonly requestId: string;
  readonly operation: 'sign_in';
  readonly outcome: 'awarded' | 'already_signed_in';
  readonly rewardDay: string;
  readonly appliedDelta: string;
  readonly balance: string;
  readonly streak: number;
  readonly stateRevision: string;
}
export type AppearanceRejection =
  | 'EXPERIENCE_APPEARANCE_CONFLICT'
  | 'EXPERIENCE_TITLE_INELIGIBLE'
  | 'EXPERIENCE_COLOR_INELIGIBLE';
export type AppearanceReceipt =
  | {
      readonly requestId: string;
      readonly operation: 'appearance';
      readonly outcome: 'applied';
      readonly titleKey: string | null;
      readonly colorId: number | null;
      readonly revision: string;
    }
  | {
      readonly requestId: string;
      readonly operation: 'appearance';
      readonly outcome: 'rejected';
      readonly code: AppearanceRejection;
    };
export type ExperienceReceipt = SignInReceipt | AppearanceReceipt;
export interface ExperienceUnlock {
  readonly noticeId: string;
  readonly fromLevel: number;
  readonly toLevel: number;
  readonly titleKeys: readonly string[];
  readonly colorIds: readonly number[];
  readonly createdAt: string;
}
export interface ExperienceUnlocks {
  readonly items: readonly ExperienceUnlock[];
}
export interface ExperienceAcknowledgement {
  readonly noticeId: string;
  readonly acknowledged: true;
}
export function invalidExperience(): never {
  throw new ClientError('protocol', 'Invalid experience response');
}
export function exactExperience(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalidExperience();
}
export const experienceUuid = (v: unknown): v is string =>
  isUuid(v) && v === v.toLowerCase();
export const experienceRequestId = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    v,
  );
export const decimal = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^(0|[1-9][0-9]{0,18})$/.test(v) &&
  (v.length < 19 || v <= '9223372036854775807');
const signedDecimal = (v: unknown): v is string =>
  decimal(v) ||
  (typeof v === 'string' &&
    /^-[1-9][0-9]{0,18}$/.test(v) &&
    (v.length < 20 || v.slice(1) <= '9223372036854775808'));
const integer = (
  v: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const coverage = (v: unknown): v is Coverage =>
  v === 'complete' || v === 'partial';
const label = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 100 &&
  v.trim().length > 0 &&
  Array.from(v).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
const titleKey = (v: unknown): v is string =>
  v === 'default_jingxiaoyu' ||
  (typeof v === 'string' &&
    /^level_(1|3|5|7|9|11|13|15|17|19|21|23|25|27|29)$/.test(v));
const colorId = (v: unknown): v is number => integer(v, 0, 25);
export const experienceDay = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(`${v}T00:00:00.000Z`)) &&
  new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v;
const timestamp = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const nullable = (v: unknown, check: (x: unknown) => boolean) =>
  v === null || check(v);
const unique = (v: readonly unknown[]) => new Set(v).size === v.length;
const frozen = <T>(v: T): T => {
  if (v !== null && typeof v === 'object') {
    for (const item of Object.values(v)) frozen(item);
    Object.freeze(v);
  }
  return v;
};
const clone = <T>(v: unknown): T => frozen(JSON.parse(JSON.stringify(v)) as T);
const ruleValues: Readonly<
  Record<RewardAction, readonly [number, number, number]>
> = {
  publish: [10, 1, 1],
  comment: [3, 5, 3],
  like_save: [1, 10, 0],
  received_like_save: [2, 10, 0],
  received_comment: [3, 5, 0],
};
const isAction = (v: unknown): v is RewardAction =>
  (rewardActions as readonly unknown[]).includes(v);
const isRecordAction = (v: unknown): v is ExperienceAction =>
  isAction(v) ||
  ['delete_post', 'delete_comment', 'delete_reply', 'sign_in'].includes(
    v as string,
  );
const signInRewards = [2, 4, 6, 8, 10, 12, 15];
export const experienceThresholds = [
  0, 15, 40, 80, 140, 220, 330, 470, 650, 880, 1150, 1480, 1880, 2350, 2900,
  3500, 4150, 4850, 5600, 6400, 7250, 8150, 9100, 10100, 11150, 12250, 13400,
  14600, 15850, 17150,
] as const;
export function decodeExperienceSummary(value: unknown): ExperienceSummary {
  exactExperience(value, [
    'ruleVersion',
    'timezone',
    'serverDay',
    'baseline',
    'coverage',
    'balance',
    'level',
    'progress',
    'signIn',
    'tasks',
    'pending',
    'stateRevision',
  ]);
  exactExperience(value.coverage, ['history', 'entitlements']);
  exactExperience(value.signIn, [
    'signedIn',
    'lastDay',
    'streak',
    'nextStreak',
    'nextReward',
  ]);
  exactExperience(value.pending, ['count', 'reason']);
  if (
    value.ruleVersion !== ruleVersion ||
    value.timezone !== timezone ||
    !experienceDay(value.serverDay) ||
    !['known', 'baseline_unknown'].includes(value.baseline as string) ||
    !coverage(value.coverage.history) ||
    !coverage(value.coverage.entitlements) ||
    !Array.isArray(value.tasks) ||
    value.tasks.length !== 5 ||
    !integer(value.pending.count) ||
    !['baseline_unknown', 'queued', null].includes(
      value.pending.reason as null,
    ) ||
    (value.pending.count === 0) !== (value.pending.reason === null)
  )
    invalidExperience();
  const known = value.baseline === 'known';
  if (
    value.pending.count > 0 &&
    value.pending.reason !== (known ? 'queued' : 'baseline_unknown')
  )
    invalidExperience();
  if (known) {
    if (
      !decimal(value.balance) ||
      !integer(value.level, 1, 30) ||
      !decimal(value.stateRevision) ||
      typeof value.signIn.signedIn !== 'boolean' ||
      !nullable(value.signIn.lastDay, experienceDay) ||
      !integer(value.signIn.streak, 0, 7) ||
      !integer(value.signIn.nextStreak, 1, 7) ||
      value.signIn.nextReward !== signInRewards[value.signIn.nextStreak - 1]
    )
      invalidExperience();
    if (
      value.signIn.signedIn &&
      (value.signIn.lastDay !== value.serverDay ||
        value.signIn.streak < 1 ||
        value.signIn.nextStreak !== Math.min(7, value.signIn.streak + 1))
    )
      invalidExperience();
    if (!value.signIn.signedIn && value.signIn.lastDay === value.serverDay)
      invalidExperience();
    if ((value.signIn.lastDay === null) !== (value.signIn.streak === 0))
      invalidExperience();
    const yesterday = new Date(
      Date.parse(`${value.serverDay}T00:00:00.000Z`) - 86400000,
    )
      .toISOString()
      .slice(0, 10);
    const nextStreak =
      value.signIn.signedIn || value.signIn.lastDay === yesterday
        ? Math.min(value.signIn.streak + 1, 7)
        : 1;
    if (value.signIn.nextStreak !== nextStreak) invalidExperience();
    if (
      typeof value.signIn.lastDay === 'string' &&
      value.signIn.lastDay > value.serverDay
    )
      invalidExperience();
    exactExperience(value.progress, [
      'currentThreshold',
      'nextThreshold',
      'pointsIntoLevel',
      'pointsToNextLevel',
      'percent',
    ]);
    const p = value.progress;
    if (
      p.currentThreshold !== String(experienceThresholds[value.level - 1]) ||
      p.nextThreshold !==
        (value.level === 30 ? null : String(experienceThresholds[value.level]))
    )
      invalidExperience();
    if (
      !decimal(p.currentThreshold) ||
      !decimal(p.pointsIntoLevel) ||
      !nullable(p.nextThreshold, decimal) ||
      !nullable(p.pointsToNextLevel, decimal) ||
      typeof p.percent !== 'number' ||
      !Number.isFinite(p.percent) ||
      p.percent < 0 ||
      p.percent > 100 ||
      BigInt(p.currentThreshold) + BigInt(p.pointsIntoLevel) !==
        BigInt(value.balance)
    )
      invalidExperience();
    if (value.level === 30) {
      if (
        p.nextThreshold !== null ||
        p.pointsToNextLevel !== null ||
        p.percent !== 100
      )
        invalidExperience();
    } else if (
      !decimal(p.nextThreshold) ||
      !decimal(p.pointsToNextLevel) ||
      BigInt(p.nextThreshold) <= BigInt(value.balance) ||
      BigInt(value.balance) + BigInt(p.pointsToNextLevel) !==
        BigInt(p.nextThreshold) ||
      BigInt(p.nextThreshold) <= BigInt(p.currentThreshold) ||
      p.percent !==
        Number(
          (BigInt(p.pointsIntoLevel) * 100n) /
            (BigInt(p.nextThreshold) - BigInt(p.currentThreshold)),
        )
    )
      invalidExperience();
  } else if (
    value.balance !== null ||
    value.level !== null ||
    value.progress !== null ||
    value.stateRevision !== null ||
    Object.values(value.signIn).some((v) => v !== null)
  )
    invalidExperience();
  for (const raw of value.tasks) {
    exactExperience(raw, [
      'action',
      'amount',
      'dailyLimit',
      'rewardedCount',
      'refundCount',
      'remaining',
      'grossPositiveAwarded',
    ]);
    if (!isAction(raw.action)) invalidExperience();
    const [amount, limit, refund] = ruleValues[raw.action];
    if (raw.amount !== amount || raw.dailyLimit !== limit) invalidExperience();
    if (known) {
      if (
        !integer(raw.rewardedCount, 0, limit) ||
        !integer(raw.refundCount, 0, refund) ||
        !integer(raw.remaining, 0, limit) ||
        raw.remaining !== limit - raw.rewardedCount ||
        !decimal(raw.grossPositiveAwarded) ||
        BigInt(raw.grossPositiveAwarded) > BigInt((limit + refund) * amount)
      )
        invalidExperience();
    } else if (
      [
        raw.rewardedCount,
        raw.refundCount,
        raw.remaining,
        raw.grossPositiveAwarded,
      ].some((v) => v !== null)
    )
      invalidExperience();
  }
  if (!unique(value.tasks.map((t) => t.action))) invalidExperience();
  return clone<ExperienceSummary>(value);
}
function checkTitle(value: unknown, owned = false): void {
  exactExperience(
    value,
    owned
      ? ['key', 'name', 'kind', 'unlockLevel', 'earnedAt', 'recordedAt']
      : ['key', 'name', 'kind', 'unlockLevel'],
  );
  if (
    !titleKey(value.key) ||
    !label(value.name) ||
    (value.key === 'default_jingxiaoyu'
      ? value.kind !== 'default' || value.unlockLevel !== null
      : value.kind !== 'level' ||
        value.unlockLevel !== Number(value.key.slice(6)))
  )
    invalidExperience();
  if (
    owned &&
    (!nullable(value.earnedAt, timestamp) || !timestamp(value.recordedAt))
  )
    invalidExperience();
}
export function decodeExperienceCatalog(value: unknown): ExperienceCatalog {
  exactExperience(value, [
    'ruleVersion',
    'timezone',
    'levels',
    'rules',
    'signInRewards',
    'titles',
    'colors',
  ]);
  if (
    value.ruleVersion !== ruleVersion ||
    value.timezone !== timezone ||
    !Array.isArray(value.levels) ||
    value.levels.length !== 30 ||
    !Array.isArray(value.rules) ||
    value.rules.length !== 5 ||
    !Array.isArray(value.signInRewards) ||
    JSON.stringify(value.signInRewards) !== JSON.stringify(signInRewards) ||
    !Array.isArray(value.titles) ||
    value.titles.length !== 16 ||
    !Array.isArray(value.colors) ||
    value.colors.length !== 26
  )
    invalidExperience();
  let previous = -1n;
  value.levels.forEach((v, i) => {
    exactExperience(v, ['level', 'threshold']);
    if (
      v.level !== i + 1 ||
      v.threshold !== String(experienceThresholds[i]) ||
      !decimal(v.threshold) ||
      BigInt(v.threshold) <= previous ||
      (i === 0 && v.threshold !== '0')
    )
      invalidExperience();
    previous = BigInt(v.threshold);
  });
  value.rules.forEach((v) => {
    exactExperience(v, ['action', 'amount', 'dailyLimit', 'refundLimit']);
    if (!isAction(v.action)) invalidExperience();
    const r = ruleValues[v.action];
    if (v.amount !== r[0] || v.dailyLimit !== r[1] || v.refundLimit !== r[2])
      invalidExperience();
  });
  value.titles.forEach((v) => checkTitle(v));
  value.colors.forEach((v) => {
    exactExperience(v, ['id', 'name', 'unlockLevel']);
    if (
      !colorId(v.id) ||
      !label(v.name) ||
      v.unlockLevel !== (v.id < 11 ? 0 : (v.id - 10) * 2)
    )
      invalidExperience();
  });
  if (
    !unique(value.rules.map((v) => v.action)) ||
    !unique(value.titles.map((v) => v.key)) ||
    !unique(value.colors.map((v) => v.id))
  )
    invalidExperience();
  return clone<ExperienceCatalog>(value);
}
export function decodeExperienceRecords(value: unknown): ExperienceRecords {
  exactExperience(value, ['items', 'nextCursor', 'coverage']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !coverage(value.coverage) ||
    !nullable(value.nextCursor, experienceCursor)
  )
    invalidExperience();
  for (const v of value.items) {
    exactExperience(v, [
      'recordId',
      'action',
      'nominalDelta',
      'appliedDelta',
      'balanceAfter',
      'outcome',
      'occurredAt',
      'appliedAt',
      'recordedAt',
    ]);
    if (
      !experienceUuid(v.recordId) ||
      !isRecordAction(v.action) ||
      !nullable(v.nominalDelta, signedDecimal) ||
      !nullable(v.appliedDelta, signedDecimal) ||
      !nullable(v.balanceAfter, decimal) ||
      !['awarded', 'capped', 'deducted', 'historical'].includes(
        v.outcome as string,
      ) ||
      !nullable(v.occurredAt, timestamp) ||
      !nullable(v.appliedAt, timestamp) ||
      !timestamp(v.recordedAt)
    )
      invalidExperience();
    if (v.outcome !== 'historical') {
      const deletion = String(v.action).startsWith('delete_');
      const expectedNominal =
        v.action === 'delete_post'
          ? '-10'
          : deletion
            ? '-3'
            : isAction(v.action)
              ? String(ruleValues[v.action][0])
              : null;
      if (
        (deletion && v.outcome !== 'deducted') ||
        (!deletion && v.outcome === 'deducted') ||
        (expectedNominal !== null && v.nominalDelta !== expectedNominal) ||
        (v.action === 'sign_in' &&
          !signInRewards.some((amount) => String(amount) === v.nominalDelta))
      )
        invalidExperience();
      if (
        !signedDecimal(v.nominalDelta) ||
        !signedDecimal(v.appliedDelta) ||
        !decimal(v.balanceAfter) ||
        !timestamp(v.appliedAt)
      )
        invalidExperience();
      if (
        v.outcome === 'capped' &&
        (v.appliedDelta !== '0' || BigInt(v.nominalDelta) <= 0n)
      )
        invalidExperience();
      if (
        v.outcome === 'awarded' &&
        (BigInt(v.appliedDelta) <= 0n || v.nominalDelta !== v.appliedDelta)
      )
        invalidExperience();
      if (
        v.outcome === 'deducted' &&
        (BigInt(v.nominalDelta) >= 0n ||
          BigInt(v.appliedDelta) > 0n ||
          BigInt(v.appliedDelta) < BigInt(v.nominalDelta))
      )
        invalidExperience();
    }
  }
  if (
    !unique(value.items.map((v) => v.recordId)) ||
    (value.items.length === 0 && value.nextCursor !== null)
  )
    invalidExperience();
  return clone<ExperienceRecords>(value);
}
export const experienceCursor = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export function decodeExperienceAppearance(
  value: unknown,
): ExperienceAppearance {
  exactExperience(value, [
    'coverage',
    'titles',
    'titleKey',
    'colorId',
    'eligibleColorIds',
    'revision',
  ]);
  if (
    !coverage(value.coverage) ||
    !Array.isArray(value.titles) ||
    value.titles.length > 16 ||
    !nullable(value.titleKey, titleKey) ||
    !nullable(value.colorId, colorId) ||
    !Array.isArray(value.eligibleColorIds) ||
    !value.eligibleColorIds.every(colorId) ||
    !unique(value.eligibleColorIds) ||
    !decimal(value.revision)
  )
    invalidExperience();
  value.titles.forEach((v) => checkTitle(v, true));
  if (
    !unique(value.titles.map((v) => v.key)) ||
    (value.titleKey !== null &&
      !value.titles.some((v) => v.key === value.titleKey)) ||
    Array.from({ length: 11 }, (_, i) => i).some(
      (id) => !(value.eligibleColorIds as number[]).includes(id),
    )
  )
    invalidExperience();
  return clone<ExperienceAppearance>(value);
}
export function decodeSignInIntent(value: unknown): SignInIntent {
  exactExperience(value, ['requestId']);
  if (!experienceRequestId(value.requestId)) invalidExperience();
  return clone<SignInIntent>(value);
}
export function decodeAppearanceIntent(value: unknown): AppearanceIntent {
  exactExperience(value, [
    'requestId',
    'expectedRevision',
    'titleKey',
    'colorId',
  ]);
  if (
    !experienceRequestId(value.requestId) ||
    !decimal(value.expectedRevision) ||
    !nullable(value.titleKey, titleKey) ||
    !nullable(value.colorId, colorId)
  )
    invalidExperience();
  return clone<AppearanceIntent>(value);
}
export function decodeExperienceIntent(value: unknown): ExperienceIntent {
  if (!isRecord(value)) invalidExperience();
  if (value.operation === 'sign_in') {
    exactExperience(value, ['operation', 'requestId']);
    return frozen({
      operation: 'sign_in',
      ...decodeSignInIntent({ requestId: value.requestId }),
    });
  }
  exactExperience(value, [
    'operation',
    'requestId',
    'expectedRevision',
    'titleKey',
    'colorId',
  ]);
  if (value.operation !== 'appearance') invalidExperience();
  return frozen({
    operation: 'appearance',
    ...decodeAppearanceIntent({
      requestId: value.requestId,
      expectedRevision: value.expectedRevision,
      titleKey: value.titleKey,
      colorId: value.colorId,
    }),
  });
}
export function decodeExperienceReceipt(value: unknown): ExperienceReceipt {
  if (!isRecord(value)) invalidExperience();
  if (value.operation === 'sign_in') {
    exactExperience(value, [
      'requestId',
      'operation',
      'outcome',
      'rewardDay',
      'appliedDelta',
      'balance',
      'streak',
      'stateRevision',
    ]);
    if (
      !experienceRequestId(value.requestId) ||
      !['awarded', 'already_signed_in'].includes(value.outcome as string) ||
      !experienceDay(value.rewardDay) ||
      !decimal(value.appliedDelta) ||
      !decimal(value.balance) ||
      !integer(value.streak, 1, 7) ||
      !decimal(value.stateRevision) ||
      (value.outcome === 'already_signed_in'
        ? value.appliedDelta !== '0'
        : value.appliedDelta !== String(signInRewards[value.streak - 1])) ||
      BigInt(value.balance) < BigInt(value.appliedDelta)
    )
      invalidExperience();
  } else if (value.operation === 'appearance' && value.outcome === 'applied') {
    exactExperience(value, [
      'requestId',
      'operation',
      'outcome',
      'titleKey',
      'colorId',
      'revision',
    ]);
    if (
      !experienceRequestId(value.requestId) ||
      !nullable(value.titleKey, titleKey) ||
      !nullable(value.colorId, colorId) ||
      !decimal(value.revision)
    )
      invalidExperience();
  } else {
    exactExperience(value, ['requestId', 'operation', 'outcome', 'code']);
    if (
      !experienceRequestId(value.requestId) ||
      value.operation !== 'appearance' ||
      value.outcome !== 'rejected' ||
      ![
        'EXPERIENCE_APPEARANCE_CONFLICT',
        'EXPERIENCE_TITLE_INELIGIBLE',
        'EXPERIENCE_COLOR_INELIGIBLE',
      ].includes(value.code as string)
    )
      invalidExperience();
  }
  return clone<ExperienceReceipt>(value);
}
export function matchExperienceReceipt(
  intent: ExperienceIntent,
  receipt: ExperienceReceipt,
): void {
  if (
    intent.requestId !== receipt.requestId ||
    intent.operation !== receipt.operation
  )
    invalidExperience();
  if (
    intent.operation === 'appearance' &&
    receipt.operation === 'appearance' &&
    receipt.outcome === 'applied' &&
    (intent.titleKey !== receipt.titleKey ||
      intent.colorId !== receipt.colorId ||
      BigInt(receipt.revision) < BigInt(intent.expectedRevision) ||
      BigInt(receipt.revision) > BigInt(intent.expectedRevision) + 1n)
  )
    invalidExperience();
}
export function decodeExperienceUnlocks(value: unknown): ExperienceUnlocks {
  exactExperience(value, ['items']);
  if (!Array.isArray(value.items) || value.items.length > 50)
    invalidExperience();
  value.items.forEach((v) => {
    exactExperience(v, [
      'noticeId',
      'fromLevel',
      'toLevel',
      'titleKeys',
      'colorIds',
      'createdAt',
    ]);
    if (
      !experienceUuid(v.noticeId) ||
      !integer(v.fromLevel, 1, 29) ||
      !integer(v.toLevel, 2, 30) ||
      v.toLevel <= v.fromLevel ||
      !Array.isArray(v.titleKeys) ||
      !v.titleKeys.every(titleKey) ||
      !unique(v.titleKeys) ||
      !Array.isArray(v.colorIds) ||
      !v.colorIds.every((n) => integer(n, 11, 25)) ||
      !unique(v.colorIds) ||
      !timestamp(v.createdAt)
    )
      invalidExperience();
  });
  if (!unique(value.items.map((v) => v.noticeId))) invalidExperience();
  return clone<ExperienceUnlocks>(value);
}
export function decodeExperienceAcknowledgement(
  value: unknown,
): ExperienceAcknowledgement {
  exactExperience(value, ['noticeId', 'acknowledged']);
  if (!experienceUuid(value.noticeId) || value.acknowledged !== true)
    invalidExperience();
  return clone<ExperienceAcknowledgement>(value);
}
