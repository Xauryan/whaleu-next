import { ApplicationError } from '../http/application-error.js';
import { z } from 'zod';
import {
  officialUuid as U,
  officialHash as H,
  officialLiteral,
  officialCounter,
} from './profile.js';
export const OFFICIAL_RUNTIME = Symbol('OFFICIAL_RUNTIME');
const artwork = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('keep') }),
  z.strictObject({ action: z.literal('clear') }),
  z.strictObject({ action: z.literal('replace'), appearanceId: U }),
]);
export const officialConfigCommand = z.strictObject({
  requestId: U,
  programId: U,
  expectedRevision: H,
  author: officialLiteral(64),
  cover: artwork,
  title: artwork,
});
export const officialPreviewRequest = z.discriminatedUnion('kind', [
  z.strictObject({
    programId: U,
    kind: z.literal('daily_hot'),
    limit: z.int().min(1).max(30).optional(),
    expectedConfigRevision: H,
  }),
  z.strictObject({
    programId: U,
    kind: z.literal('test'),
    expectedConfigRevision: H,
  }),
]);
export const officialManualPreview = z.strictObject({
  programId: U,
  limit: z.int().min(1).max(10).optional(),
  expectedConfigRevision: H,
});
export const officialDraftCommand = z.strictObject({
  requestId: U,
  programId: U,
  previewId: U,
  manifestHash: H,
  expectedConfigRevision: H,
  acknowledgement: z.literal('synthetic_draft_only'),
});
export const officialPublishCommand = z.strictObject({
  requestId: U,
  draftRef: U,
  confirmationId: U,
  confirmationRevision: H,
  manifestHash: H,
  acknowledgement: z.literal('publish_exact_synthetic_article'),
});
export const officialOriginalCommand = z.union([
  officialConfigCommand,
  officialDraftCommand,
  officialPublishCommand,
]);
export type OriginalCommand = z.infer<typeof officialOriginalCommand>;
export type OfficialOperation =
  | 'config_save'
  | 'test_draft'
  | 'manual_draft'
  | 'manual_publish'
  | 'daily_draft';
export type OfficialEffectStage =
  'material' | 'draft_create' | 'publish_submit';
export type OfficialEffectState =
  | 'pending'
  | 'preparing'
  | 'dispatch_unknown'
  | 'retry_wait'
  | 'material_confirmed'
  | 'draft_confirmed'
  | 'publish_submitted'
  | 'published_confirmed'
  | 'publication_rejected'
  | 'parked_unknown'
  | 'suppressed_unsent';
export const officialArticle = z.strictObject({
  title: officialLiteral(54),
  author: officialLiteral(64),
  items: z
    .array(
      z.strictObject({
        excerpt: officialLiteral(61),
        publishedAt: z.iso.datetime(),
        publicCounts: z.strictObject({
          likes: officialCounter,
          comments: officialCounter,
          subscriptions: officialCounter,
        }),
        locator: z
          .string()
          .regex(
            /^pages\/community-detail\/community-detail\?postId=[0-9a-f-]{36}$/,
          ),
        mediaAppearanceRefs: z.array(U).max(32),
      }),
    )
    .max(30),
  coverAppearanceId: U.nullable(),
  titleAppearanceId: U.nullable(),
});
export type OfficialArticle = z.infer<typeof officialArticle>;
export interface OfficialReceipt {
  requestId: string;
  intentHash: string;
  operation: Exclude<OfficialOperation, 'daily_draft'>;
  programId: string;
  accountRef: string;
  acceptedAt: string;
  outcome: 'admitted' | 'config_applied';
  configRevision: string | null;
}
export interface OfficialStatus {
  state:
    | 'config_applied'
    | 'pending'
    | 'preparing'
    | 'dispatch_unknown'
    | 'parked_unknown'
    | 'draft_confirmed'
    | 'publish_submitted'
    | 'published_confirmed'
    | 'rejected'
    | 'suppressed'
    | 'expired'
    | 'cancelled';
  cancelRequested: boolean;
  acceptedMaterialCount: number;
  draftRef: string | null;
  withdrawal:
    'none' | 'local_withdrawn_remote_unverified' | 'retraction_needed';
  nextAction:
    'wait' | 'recover_same_key' | 'resume_same_key' | 'new_preview' | 'none';
  updatedAt: string;
}
export interface OfficialPreview {
  previewId: string;
  programId: string;
  accountRef: string;
  accountLabel: string;
  kind: 'daily_hot' | 'test' | 'manual_newest';
  selectionAt: string;
  expiresAt: string;
  configRevision: string;
  manifestHash: string;
  eligibleCount: number;
  mode: 'synthetic';
  article: OfficialArticle;
  actions: { createDraft: boolean };
  sourceState: 'complete' | 'known_empty';
}
export const officialReceiptSchema = z.strictObject({
  requestId: U,
  intentHash: H,
  operation: z.enum([
    'config_save',
    'test_draft',
    'manual_draft',
    'manual_publish',
  ]),
  programId: U,
  accountRef: U,
  acceptedAt: z.iso.datetime(),
  outcome: z.enum(['admitted', 'config_applied']),
  configRevision: H.nullable(),
});
export const officialStatusSchema = z.strictObject({
  state: z.enum([
    'config_applied',
    'pending',
    'preparing',
    'dispatch_unknown',
    'parked_unknown',
    'draft_confirmed',
    'publish_submitted',
    'published_confirmed',
    'rejected',
    'suppressed',
    'expired',
    'cancelled',
  ]),
  cancelRequested: z.boolean(),
  acceptedMaterialCount: z.int().min(0).max(32),
  draftRef: U.nullable(),
  withdrawal: z.enum([
    'none',
    'local_withdrawn_remote_unverified',
    'retraction_needed',
  ]),
  nextAction: z.enum([
    'wait',
    'recover_same_key',
    'resume_same_key',
    'new_preview',
    'none',
  ]),
  updatedAt: z.iso.datetime(),
});
export const officialCommandResultSchema = z.strictObject({
  receipt: officialReceiptSchema,
  status: officialStatusSchema,
});
export const officialPreviewSchema = z.strictObject({
  previewId: U,
  programId: U,
  accountRef: U,
  accountLabel: officialLiteral(100),
  kind: z.enum(['daily_hot', 'test', 'manual_newest']),
  selectionAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  configRevision: H,
  manifestHash: H,
  eligibleCount: z.int().min(0).max(30),
  mode: z.literal('synthetic'),
  article: officialArticle,
  actions: z.strictObject({ createDraft: z.boolean() }),
  sourceState: z.enum(['complete', 'known_empty']),
});
export const officialConfigSchema = z.strictObject({
  programId: U,
  accountRef: U,
  accountLabel: officialLiteral(100),
  revision: H,
  author: officialLiteral(64),
  coverAppearanceId: U.nullable(),
  titleAppearanceId: U.nullable(),
  readiness: z.enum(['disabled', 'unavailable', 'synthetic_ready']),
  schedule: z.strictObject({
    zone: z.literal('Etc/UTC'),
    slotTime: z.literal('00:00:00'),
    automatic: z.literal(false),
  }),
});
export const officialCapabilitiesSchema = z.strictObject({
  mode: z.enum(['disabled', 'synthetic']),
  programId: U,
  canManage: z.boolean(),
  canPreview: z.boolean(),
  canTest: z.boolean(),
  canManualCreate: z.boolean(),
  canPublish: z.boolean(),
  reason: z.enum([
    'ready',
    'disabled',
    'scope_unavailable',
    'authority_required',
  ]),
});
export const officialPublishConfirmationSchema = z.strictObject({
  confirmationId: U,
  revision: H,
  draftRef: U,
  programId: U,
  accountRef: U,
  accountLabel: officialLiteral(100),
  manifestHash: H,
  title: officialLiteral(50),
  postCount: z.int().min(1).max(10),
  mode: z.literal('synthetic'),
  expiresAt: z.iso.datetime(),
  action: z.literal('publish_exact_synthetic_article'),
});

export function parseOfficial<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApplicationError('OFFICIAL_REQUEST_INVALID');
  return parsed.data;
}

export const officialCancellationTombstoneSchema = z.strictObject({
  state: z.literal('cancelled_before_admission'),
  requestId: U,
  intentHash: H,
});
