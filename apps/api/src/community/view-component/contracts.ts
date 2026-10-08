import { createHash } from 'node:crypto';
import { z } from 'zod';

const uuid = z.uuid().transform((id) => id.toLowerCase());
const requestUuid = z.uuidv4().transform((id) => id.toLowerCase());
export const viewEpochRequestSchema = z.strictObject({ version: z.literal(1) });
export const viewReportSchema = z
  .strictObject({
    version: z.literal(1),
    epochId: requestUuid,
    batchId: requestUuid,
    kind: z.enum(['list_exposure', 'detail_visit']),
    postIds: z.array(uuid).min(1).max(50),
  })
  .refine(
    (input) => input.kind !== 'detail_visit' || input.postIds.length === 1,
  );
export type ViewReport = z.infer<typeof viewReportSchema>;
export type ViewKind = ViewReport['kind'];
export interface ViewReportingEpoch {
  version: 1;
  epochId: string;
  issuedAt: string;
  collectionUntil: string;
  expiresAt: string;
  serverNow: string;
}
export interface ViewReportReceipt {
  version: 1;
  epochId: string;
  batchId: string;
  kind: ViewKind;
  payloadFingerprint: string;
  acceptedCount: number;
}
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
