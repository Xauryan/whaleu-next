import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../community/content-review/contracts.js';

export const schoolEntryKeys = [
  'treehole',
  'trading',
  'errand',
  'review',
  'official_account',
  'admin',
] as const;
export const publicSchoolEntryKeys = [
  'treehole',
  'trading',
  'errand',
  'official_account',
  'admin',
] as const;
export const schoolEntryKeySchema = z.enum(schoolEntryKeys);
export type SchoolEntryKey = z.infer<typeof schoolEntryKeySchema>;
export const schoolIdSchema = z.uuid();
export const schoolRevisionSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export const schoolDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const plain = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine(
      (value) =>
        // eslint-disable-next-line no-control-regex -- Explicitly reject control bytes in public operations data.
        !/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(
          value,
        ),
    );
/** Copy-only, known group providers. Never fetch, follow redirects or navigate a webview. */
export const schoolJoinUrlSchema = z
  .string()
  .max(1000)
  .refine((value) => {
    if (value === '') return true;
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        /^https:\/\/(?:qun\.qq\.com|jq\.qq\.com|qm\.qq\.com|weixin\.qq\.com)(?:[/?#]|$)/u.test(
          value,
        ) &&
        !url.username &&
        !url.password &&
        !url.port &&
        ['qun.qq.com', 'jq.qq.com', 'qm.qq.com', 'weixin.qq.com'].includes(
          url.hostname,
        ) &&
        // eslint-disable-next-line no-control-regex -- Explicitly reject control bytes in public operations data.
        !/[\s\\\u0000-\u001f\u007f]/u.test(value)
      );
    } catch {
      return false;
    }
  });
export const schoolGroupDataSchema = z.strictObject({
  kind: z.literal('group'),
  enabled: z.boolean(),
  name: plain(100),
  description: plain(500),
  joinUrl: schoolJoinUrlSchema,
  qqGroupNumber: z.string().regex(/^(?:[1-9][0-9]{4,31})?$/),
  maxGroupNumber: z.number().int().min(1).max(999).nullable(),
});
export const schoolOfficialDataSchema = z.strictObject({
  kind: z.literal('official_account'),
  enabled: z.boolean(),
  name: plain(100),
  description: plain(500),
});
export const schoolAdminDataSchema = z.strictObject({
  kind: z.literal('admin'),
  enabled: z.boolean(),
  wechatId: plain(100).refine((value) => !/\s/u.test(value)),
});
export const schoolEntryDataSchema = z.discriminatedUnion('kind', [
  schoolGroupDataSchema,
  schoolOfficialDataSchema,
  schoolAdminDataSchema,
]);
export type SchoolEntryData = z.infer<typeof schoolEntryDataSchema>;
export const schoolQrChangeSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('keep') }),
  z.strictObject({ action: z.literal('remove') }),
  z.strictObject({ action: z.literal('replace'), assetId: schoolIdSchema }),
]);
export const saveSchoolEntrySchema = z.strictObject({
  clientRequestId: z.uuidv4(),
  expectedRevision: schoolRevisionSchema.max(Number.MAX_SAFE_INTEGER - 1),
  entry: schoolEntryDataSchema,
  qrcode: schoolQrChangeSchema,
});
export type SaveSchoolEntry = z.infer<typeof saveSchoolEntrySchema>;
export const schoolBrowseQuerySchema = z.strictObject({
  campusId: schoolIdSchema,
});
export const schoolManagementQuerySchema = z.strictObject({
  regionId: schoolIdSchema.optional(),
});
export const schoolEmptyQuerySchema = z.strictObject({});
export const schoolEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
export function assertSchoolEntryKind(
  key: SchoolEntryKey,
  data: SchoolEntryData,
): void {
  const expected =
    key === 'admin' || key === 'official_account' ? key : 'group';
  if (data.kind !== expected) throw new Error('School entry kind mismatch');
}
export function schoolCommandHash(
  actorId: string,
  regionId: string,
  key: SchoolEntryKey,
  input: SaveSchoolEntry,
): string {
  return createHash('sha256')
    .update('whaleu-school-configuration-command:v1\n')
    .update(
      canonicalJson({
        actorId,
        regionId,
        key,
        command: saveSchoolEntrySchema.parse(input),
      }),
    )
    .digest('hex');
}
export function schoolSnapshotHash(
  regionId: string,
  key: SchoolEntryKey,
  revision: number,
  data: SchoolEntryData,
  bindingId: string | null,
): string {
  return createHash('sha256')
    .update('whaleu-school-configuration-snapshot:v1\n')
    .update(canonicalJson({ regionId, key, revision, data, bindingId }))
    .digest('hex');
}
export const schoolSaveReceiptSchema = z.strictObject({
  requestId: z.uuidv4(),
  requestHash: schoolDigestSchema,
  regionId: schoolIdSchema,
  entryKey: schoolEntryKeySchema,
  revision: schoolRevisionSchema.min(1),
  outcome: z.literal('saved'),
});
export type SchoolSaveReceipt = z.infer<typeof schoolSaveReceiptSchema>;
export const schoolCancelCommandSchema = z.strictObject({
  requestHash: schoolDigestSchema,
});
export const schoolRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('cancelled'),
    requestId: z.uuidv4(),
    requestHash: schoolDigestSchema,
  }),
  z.strictObject({ state: z.literal('not_recorded'), requestId: z.uuidv4() }),
  z.strictObject({
    state: z.literal('recorded'),
    requestId: z.uuidv4(),
    receipt: schoolSaveReceiptSchema,
  }),
]);
export const schoolEntryViewSchema = z.strictObject({
  entryKey: schoolEntryKeySchema,
  revision: schoolRevisionSchema,
  state: z.enum(['unconfigured', 'disabled', 'partial', 'configured']),
  data: schoolEntryDataSchema.nullable(),
  qrcode: z.strictObject({ status: z.enum(['none', 'configured']) }),
});
export type SchoolEntryView = z.infer<typeof schoolEntryViewSchema>;
export const schoolPublicViewSchema = z.strictObject({
  context: z.strictObject({
    campusId: schoolIdSchema,
    campusName: z.string(),
    region: z.strictObject({ id: schoolIdSchema, name: z.string() }).nullable(),
  }),
  entries: z.array(schoolEntryViewSchema).length(5),
});
export const schoolManagementViewSchema = z.strictObject({
  context: z.strictObject({
    regionId: schoolIdSchema,
    regionName: z.string(),
    management: z.enum(['fixed', 'global']),
  }),
  entries: z.array(schoolEntryViewSchema).length(6),
});
export const schoolCapabilitiesSchema = z.strictObject({
  management: z.enum(['none', 'fixed', 'global']),
  region: z.strictObject({ id: schoolIdSchema, name: z.string() }).nullable(),
});

/** An order-scoped public errand group. No physical-campus mapping is fabricated. */
export const errandSchoolServiceSchema = z.strictObject({
  context: z.strictObject({
    orderId: schoolIdSchema,
    targetRegion: z.strictObject({ id: schoolIdSchema, name: z.string() }),
  }),
  entry: schoolEntryViewSchema.extend({ entryKey: z.literal('errand') }),
});
