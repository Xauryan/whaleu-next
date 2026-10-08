import { z } from 'zod';
import type { RecordAction, RewardAction, TitleDefinition } from './catalog.js';
export const experienceIdSchema = z.uuidv4().transform((x) => x.toLowerCase());
export const decimalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((x) => BigInt(x) <= 9223372036854775807n);
export const experienceEmptySchema = z.strictObject({});
export const signInSchema = z.strictObject({ requestId: experienceIdSchema });
export const appearanceSchema = z.strictObject({
  requestId: experienceIdSchema,
  expectedRevision: decimalSchema,
  titleKey: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9_]+$/)
    .nullable(),
  colorId: z.number().int().min(0).max(25).nullable(),
});
export const experiencePageSchema = z.strictObject({
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .default('20')
    .transform(Number),
  cursor: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});
export type AppearanceIntent = z.infer<typeof appearanceSchema>;
export type ExperiencePageQuery = z.infer<typeof experiencePageSchema>;
export type AppearanceRejection =
  | 'EXPERIENCE_APPEARANCE_CONFLICT'
  | 'EXPERIENCE_TITLE_INELIGIBLE'
  | 'EXPERIENCE_COLOR_INELIGIBLE';
export type ExperienceReceipt =
  | {
      requestId: string;
      operation: 'sign_in';
      outcome: 'awarded' | 'already_signed_in';
      rewardDay: string;
      appliedDelta: string;
      balance: string;
      streak: number;
      stateRevision: string;
    }
  | {
      requestId: string;
      operation: 'appearance';
      outcome: 'applied';
      titleKey: string | null;
      colorId: number | null;
      revision: string;
    }
  | {
      requestId: string;
      operation: 'appearance';
      outcome: 'rejected';
      code: AppearanceRejection;
    };
export interface ExperienceSummary {
  ruleVersion: 'local-experience-v1';
  timezone: 'Asia/Shanghai';
  serverDay: string;
  baseline: 'known' | 'baseline_unknown';
  coverage: {
    history: 'complete' | 'partial';
    entitlements: 'complete' | 'partial';
  };
  balance: string | null;
  level: number | null;
  progress: {
    currentThreshold: string;
    nextThreshold: string | null;
    pointsIntoLevel: string;
    pointsToNextLevel: string | null;
    percent: number;
  } | null;
  signIn: {
    signedIn: boolean | null;
    lastDay: string | null;
    streak: number | null;
    nextStreak: number | null;
    nextReward: number | null;
  };
  tasks: {
    action: RewardAction;
    amount: number;
    dailyLimit: number;
    rewardedCount: number | null;
    refundCount: number | null;
    remaining: number | null;
    grossPositiveAwarded: string | null;
  }[];
  pending: { count: number; reason: 'baseline_unknown' | 'queued' | null };
  stateRevision: string | null;
}
export interface ExperienceRecord {
  recordId: string;
  action: RecordAction;
  nominalDelta: string | null;
  appliedDelta: string | null;
  balanceAfter: string | null;
  outcome: 'awarded' | 'capped' | 'deducted' | 'historical';
  occurredAt: string | null;
  appliedAt: string | null;
  recordedAt: string;
}
export interface ExperienceRecords {
  items: ExperienceRecord[];
  nextCursor: string | null;
  coverage: 'complete' | 'partial';
}
export interface AppearanceView {
  coverage: 'complete' | 'partial';
  titles: (TitleDefinition & { earnedAt: string | null; recordedAt: string })[];
  titleKey: string | null;
  colorId: number | null;
  eligibleColorIds: number[];
  revision: string;
}
export interface UnlockNotice {
  noticeId: string;
  fromLevel: number;
  toLevel: number;
  titleKeys: string[];
  colorIds: number[];
  createdAt: string;
}
