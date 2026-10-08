import { createHash } from 'node:crypto';
import { z } from 'zod';

export const VIEW_LIMITS = {
  liveEpochs: 25,
  receipts: 2048,
  events: 20000,
  collectionMs: 3600000,
  lifetimeMs: 86400000,
  detailMs: 300000,
  transactionMs: 5000,
  cleanupRows: 256,
  cleanupLagMs: 120000,
} as const;

const uuid = z.uuid().transform((id) => id.toLowerCase());
const requestUuid = z.uuidv4().transform((id) => id.toLowerCase());
const canonicalUuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const viewEpochRequestSchema = z
  .strictObject({ version: z.literal(1) })
  .meta({ id: 'ViewEpochRequest' });
const reportShape = {
  version: z.literal(1),
  epochId: requestUuid,
  batchId: requestUuid,
};
export const viewReportSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...reportShape,
      kind: z.literal('list_exposure'),
      postIds: z.array(uuid).min(1).max(50),
    }),
    z.strictObject({
      ...reportShape,
      kind: z.literal('detail_visit'),
      postIds: z.array(uuid).length(1),
    }),
  ])
  .describe(
    'UUID inputs are normalized to lowercase. Repeated post IDs are intentional events, not duplicates to remove.',
  )
  .meta({ id: 'ViewReport' });
export type ViewReport = z.output<typeof viewReportSchema>;
export type ViewKind = ViewReport['kind'];

export const viewReportingEpochSchema = z
  .strictObject({
    version: z.literal(1),
    epochId: canonicalUuid,
    issuedAt: z.iso.datetime({ precision: 3 }),
    collectionUntil: z.iso.datetime({ precision: 3 }),
    expiresAt: z.iso.datetime({ precision: 3 }),
    serverNow: z.iso.datetime({ precision: 3 }),
  })
  .refine((epoch) => {
    const issuedAt = Date.parse(epoch.issuedAt);
    const collectionUntil = Date.parse(epoch.collectionUntil);
    const expiresAt = Date.parse(epoch.expiresAt);
    const serverNow = Date.parse(epoch.serverNow);
    return (
      collectionUntil - issuedAt === VIEW_LIMITS.collectionMs &&
      expiresAt - issuedAt === VIEW_LIMITS.lifetimeMs &&
      issuedAt <= serverNow &&
      serverNow < collectionUntil
    );
  })
  .describe(
    'Canonical UTC timestamps with millisecond precision. Runtime validation additionally requires a one-hour collection window, a 24-hour lifetime, and issuedAt <= serverNow < collectionUntil; JSON Schema does not express this date arithmetic.',
  )
  .meta({ id: 'ViewReportingEpoch' });
export type ViewReportingEpoch = z.output<typeof viewReportingEpochSchema>;

const receiptShape = {
  version: z.literal(1),
  epochId: canonicalUuid,
  batchId: canonicalUuid,
  payloadFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
};
export const viewReportReceiptSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      ...receiptShape,
      kind: z.literal('list_exposure'),
      acceptedCount: z.int().min(0).max(50),
    }),
    z.strictObject({
      ...receiptShape,
      kind: z.literal('detail_visit'),
      acceptedCount: z.int().min(0).max(1),
    }),
  ])
  .describe(
    'Immutable aggregate acknowledgement, never a per-target disclosure or a current public count. Clients must additionally match the request identity, kind, fingerprint, and event count; JSON Schema cannot express these request-dependent checks.',
  )
  .meta({ id: 'ViewReportReceipt' });
export type ViewReportReceipt = z.output<typeof viewReportReceiptSchema>;

export function viewPostMultiset(
  postIds: readonly string[],
): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of postIds) {
    const id = value.toLowerCase();
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
export function viewPayloadFingerprint(
  kind: ViewKind,
  postIds: readonly string[],
): string {
  return createHash('sha256')
    .update(JSON.stringify([1, kind, viewPostMultiset(postIds)]))
    .digest('hex');
}
