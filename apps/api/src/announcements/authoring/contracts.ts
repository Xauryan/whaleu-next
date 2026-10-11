import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../community/content-review/contracts.js';
import {
  announcementTextSchema,
  announcementIdSchema,
  announcementCursorSchema,
} from '../contracts.js';
import {
  announcementMediaBindingsSchema,
  announcementMediaChangesSchema,
} from '../media/contracts.js';
export const id = announcementIdSchema;
export const key = z.uuidv4().transform((v) => v.toLowerCase());
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const revision = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);
const text = (limit: number) =>
  announcementTextSchema.refine((v) => Array.from(v).length <= limit);
export const contentInputSchema = z.strictObject({
  versionLabel: text(100),
  bodyText: text(10000),
  announcementDate: z.iso.date().nullable(),
  popupEnabled: z.boolean(),
  highlight: z.boolean(),
  popupTitle: text(200).nullable(),
  popupBodyText: text(10000).nullable(),
});
export const contentSchema = contentInputSchema.extend({
  title: text(200),
  type: z.literal('minor'),
});
export const audienceInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fixed') }),
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({
    kind: z.literal('regions'),
    regionIds: z
      .array(id)
      .min(1)
      .max(64)
      .refine((v) => new Set(v).size === v.length),
  }),
]);
export const audienceSchema = z
  .strictObject({
    kind: z.enum(['all', 'regions']),
    regionIds: z.array(id).max(64),
    campusIds: z.array(id).max(4096),
  })
  .refine((v) =>
    v.kind === 'all'
      ? v.regionIds.length === 0 && v.campusIds.length === 0
      : v.regionIds.length > 0 && v.campusIds.length > 0,
  );
const cas = {
  clientRequestId: key,
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 2),
};
export const commandSchema = z
  .union([
    z
      .strictObject({
        ...cas,
        action: z.literal('create'),
        content: contentInputSchema,
        audience: audienceInputSchema,
      })
      .refine((v) => v.expectedRevision === 0),
    z
      .strictObject({
        ...cas,
        action: z.enum(['save', 'update']),
        content: contentInputSchema,
        audience: audienceInputSchema,
        mediaChanges: announcementMediaChangesSchema,
      })
      .refine((v) => v.expectedRevision > 0),
    z
      .strictObject({ ...cas, action: z.enum(['publish', 'cancel_draft']) })
      .refine((v) => v.expectedRevision > 0),
    z
      .strictObject({
        ...cas,
        action: z.literal('set_enabled'),
        enabled: z.boolean(),
      })
      .refine((v) => v.expectedRevision > 0),
  ])
  .refine(
    (v) => Buffer.byteLength(canonicalJson(v), 'utf8') <= 60000,
    'Announcement command exceeds the 60000-byte UTF-8 budget',
  );
export type AnnouncementCommand = z.infer<typeof commandSchema>;
export type AnnouncementContent = z.infer<typeof contentSchema>;
export type AnnouncementAudience = z.infer<typeof audienceSchema>;
export type AnnouncementAudienceInput = z.infer<typeof audienceInputSchema>;
export const receiptSchema = z.strictObject({
  requestId: key,
  requestHash: digest,
  announcementId: id,
  revision,
  outcome: z.enum([
    'create',
    'save',
    'publish',
    'update',
    'set_enabled',
    'cancel_draft',
  ]),
});
export const recoverySchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('not_recorded'), requestId: key }),
  z.strictObject({
    state: z.literal('recorded'),
    requestId: key,
    receipt: receiptSchema,
  }),
  z.strictObject({
    state: z.literal('cancelled'),
    requestId: key,
    requestHash: digest,
  }),
]);
export const managedSchema = z.strictObject({
  source: z.literal('native'),
  id,
  revision,
  revisionId: id,
  state: z.enum(['draft', 'active', 'inactive', 'cancelled']),
  content: contentSchema,
  audience: audienceSchema,
  mediaBindings: announcementMediaBindingsSchema,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export const managementQuerySchema = z.strictObject({
  cursor: announcementCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const regionsQuerySchema = z.strictObject({
  search: text(100).default(''),
});
export function commandHash(
  actorId: string,
  announcementId: string,
  command: AnnouncementCommand,
) {
  return createHash('sha256')
    .update('whaleu-announcement-command:v1\n')
    .update(canonicalJson({ actorId, announcementId, command }))
    .digest('hex');
}
export function snapshotHash(value: Record<string, unknown>) {
  return createHash('sha256')
    .update('whaleu-announcement-snapshot:v1\n')
    .update(canonicalJson(value))
    .digest('hex');
}
