import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prepareTextSource } from '../text-source/source.js';

export const FORMATTER = 'plain-cjk-slices-v2' as const;
export const LIMITS = Object.freeze({
  targetScalars: 140,
  minimumScalars: 100,
  maximumScalars: 180,
  minimumTailScalars: 60,
  maximumSpans: 26,
  maximumPlanBytes: 8192,
  maximumRecordBytes: 12288,
  maximumClaims: 3,
  leaseMs: 10_000,
  batchSize: 8,
  concurrentClaims: 2,
});
const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const generationSchema = z.number().int().min(1).max(2_147_483_647);
export const sourceIdentitySchema = z.strictObject({
  kind: z.enum(['post', 'comment', 'reply']),
  id: uuid,
  sourceRevision: z.literal(1),
  sourceHash: hash,
  publicationRequestId: uuid,
});
export type SourceIdentity = z.infer<typeof sourceIdentitySchema>;
export const sourceSnapshotSchema = sourceIdentitySchema.extend({
  text: z.string().max(5000),
  descriptor: z.discriminatedUnion('format', [
    z.strictObject({
      version: z.literal(1),
      format: z.literal('plain'),
      readingFormatting: z.enum(['auto', 'off']),
    }),
    z.strictObject({ version: z.literal(1), format: z.literal('markdown') }),
  ]),
});
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
/** Input is bounded ordinary decoded server data, never executable JS/Proxy data.
 * Valid syntax/hash does not grant read, publication or worker authority. */
export function checkSource(value: unknown): SourceSnapshot | null {
  const parsed = sourceSnapshotSchema.safeParse(value);
  if (!parsed.success) return null;
  const source = parsed.data;
  const prepared = prepareTextSource(
    source.text,
    source.descriptor,
    source.kind,
  );
  return prepared &&
    prepared.canonicalText === source.text &&
    prepared.sourceHash === source.sourceHash
    ? source
    : null;
}
export function sourceIdentity(source: SourceSnapshot): SourceIdentity {
  return {
    kind: source.kind,
    id: source.id,
    sourceRevision: source.sourceRevision,
    sourceHash: source.sourceHash,
    publicationRequestId: source.publicationRequestId,
  };
}
export function eligible(source: SourceSnapshot): boolean {
  return (
    prepareTextSource(source.text, source.descriptor, source.kind)
      ?.readingFormattingEligible === true
  );
}
export function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain + JSON.stringify(value), 'utf8')
    .digest('hex');
}
export function sameIdentity(a: SourceIdentity, b: SourceIdentity): boolean {
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    a.sourceRevision === b.sourceRevision &&
    a.sourceHash === b.sourceHash &&
    a.publicationRequestId === b.publicationRequestId
  );
}
export function jobKey(identity: SourceIdentity, generation: number): string {
  return digest('whaleu-reading-formatting-job:v1\n', [
    identity.kind,
    identity.id,
    identity.sourceRevision,
    identity.sourceHash,
    identity.publicationRequestId,
    FORMATTER,
    generation,
  ]);
}
export const spanSchema = z.strictObject({
  start: z.number().int().min(0).max(5000),
  end: z.number().int().min(0).max(5000),
});
export const planSchema = z.strictObject({
  version: z.literal(1),
  formatter: z.literal(FORMATTER),
  offsetEncoding: z.literal('utf16'),
  mode: z.enum(['unchanged', 'grouped']),
  reason: z.enum([
    'grouped',
    'no_safe_boundary',
    'structure_sensitive',
    'unsupported_unicode',
  ]),
  spans: z.array(spanSchema).min(1).max(LIMITS.maximumSpans),
});
export type ReadingPlan = z.infer<typeof planSchema>;
export function decodeBoundedJson(
  value: unknown,
  maximumBytes: number,
): unknown {
  if (
    typeof value !== 'string' ||
    value.length > maximumBytes ||
    Buffer.byteLength(value, 'utf8') > maximumBytes
  )
    return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
