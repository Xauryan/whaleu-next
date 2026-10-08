export const EXPERIENCE_RULE_VERSION = 'local-experience-v1' as const;
export const EXPERIENCE_TIMEZONE = 'Asia/Shanghai' as const;
export const rewardActions = [
  'publish',
  'comment',
  'like_save',
  'received_like_save',
  'received_comment',
] as const;
export type RewardAction = (typeof rewardActions)[number];
export type ExperienceAction =
  RewardAction | 'delete_post' | 'delete_comment' | 'delete_reply';
export type RecordAction = ExperienceAction | 'sign_in';
export const rules = {
  publish: { amount: 10, dailyLimit: 1, refundLimit: 1 },
  comment: { amount: 3, dailyLimit: 5, refundLimit: 3 },
  like_save: { amount: 1, dailyLimit: 10, refundLimit: 0 },
  received_like_save: { amount: 2, dailyLimit: 10, refundLimit: 0 },
  received_comment: { amount: 3, dailyLimit: 5, refundLimit: 0 },
} as const;
export const signInRewards = [2, 4, 6, 8, 10, 12, 15] as const;
export const thresholds = [
  0, 15, 40, 80, 140, 220, 330, 470, 650, 880, 1150, 1480, 1880, 2350, 2900,
  3500, 4150, 4850, 5600, 6400, 7250, 8150, 9100, 10100, 11150, 12250, 13400,
  14600, 15850, 17150,
] as const;
const titleNames = [
  '萌新小白',
  '初来乍到',
  '崭露头角',
  '小有名气',
  '活跃分子',
  '社区新星',
  '人气达人',
  '校园红人',
  '意见领袖',
  '社区元老',
  '校园名人',
  '风云人物',
  '传奇人物',
  '校园之光',
  '一代宗师',
];
export interface TitleDefinition {
  key: string;
  name: string;
  kind: 'default' | 'level';
  unlockLevel: number | null;
}
export const titles: TitleDefinition[] = [
  {
    key: 'default_jingxiaoyu',
    name: '鲸小语',
    kind: 'default',
    unlockLevel: null,
  },
  ...titleNames.map((name, i): TitleDefinition => ({
    key: `level_${i * 2 + 1}`,
    name,
    kind: 'level',
    unlockLevel: i * 2 + 1,
  })),
];
const colorNames = [
  '天空蓝',
  '翡翠绿',
  '阳光橙',
  '玫瑰红',
  '神秘紫',
  '薄荷青',
  '珊瑚粉',
  '星空靛',
  '琥珀金',
  '极光绿',
  '烈焰橙',
  '皇室紫',
  '樱花粉',
  '钻石蓝',
  '传说金',
];
export const colors = [
  ...Array.from({ length: 11 }, (_, id) => ({
    id,
    name: `基础色 ${id}`,
    unlockLevel: 0,
  })),
  ...colorNames.map((name, i) => ({
    id: i + 11,
    name,
    unlockLevel: (i + 1) * 2,
  })),
];
export function levelFor(balance: bigint): number {
  if (balance < 0n) throw new Error('Balance must be nonnegative');
  let level = 1;
  for (let i = 1; i < thresholds.length; i++) {
    if (balance < BigInt(thresholds[i]!)) break;
    level = i + 1;
  }
  return level;
}
export function progressFor(balance: bigint) {
  const level = levelFor(balance),
    current = BigInt(thresholds[level - 1]!);
  const next =
    thresholds[level] === undefined ? null : BigInt(thresholds[level]!);
  return {
    currentThreshold: current.toString(),
    nextThreshold: next?.toString() ?? null,
    pointsIntoLevel: (balance - current).toString(),
    pointsToNextLevel: next === null ? null : (next - balance).toString(),
    percent:
      next === null
        ? 100
        : Math.floor(
            (Number(balance - current) * 100) / Number(next - current),
          ),
  };
}
export function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
}
/** Shared by preview and mutation. A confirmed day previews tomorrow, a gap resets. */
export function signInPreview(
  lastDay: string | null,
  streak: number,
  day: string,
) {
  const signedIn = lastDay === day;
  const nextStreak =
    signedIn || lastDay === previousDay(day) ? Math.min(streak + 1, 7) : 1;
  return {
    signedIn,
    lastDay,
    streak,
    nextStreak,
    nextReward: signInRewards[nextStreak - 1]!,
  };
}
export function bucketAction(action: ExperienceAction): RewardAction {
  return action === 'delete_post'
    ? 'publish'
    : action === 'delete_comment' || action === 'delete_reply'
      ? 'comment'
      : action;
}
export function actionDelta(
  action: ExperienceAction,
  balance: bigint,
  used: number,
  refunded: number,
) {
  const rule = rules[bucketAction(action)];
  if (action.startsWith('delete_')) {
    const nominal = -BigInt(rule.amount);
    const delta = balance < -nominal ? -balance : nominal;
    const refund = used > 0 && refunded < rule.refundLimit;
    return {
      nominal,
      delta,
      outcome: 'deducted' as const,
      used: used - Number(refund),
      refunded: refunded + Number(refund),
      gross: 0,
    };
  }
  const capped = used >= rule.dailyLimit;
  return {
    nominal: BigInt(rule.amount),
    delta: BigInt(capped ? 0 : rule.amount),
    outcome: capped ? ('capped' as const) : ('awarded' as const),
    used: used + Number(!capped),
    refunded,
    gross: capped ? 0 : rule.amount,
  };
}
export function experienceCatalog() {
  return {
    ruleVersion: EXPERIENCE_RULE_VERSION,
    timezone: EXPERIENCE_TIMEZONE,
    levels: thresholds.map((threshold, i) => ({
      level: i + 1,
      threshold: String(threshold),
    })),
    rules: rewardActions.map((action) => ({ action, ...rules[action] })),
    signInRewards: [...signInRewards],
    titles: titles.map((x) => ({ ...x })),
    colors: colors.map((x) => ({ ...x })),
  };
}
