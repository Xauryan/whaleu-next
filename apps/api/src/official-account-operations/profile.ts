import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../community/content-review/contracts.js';

/** Development safety bounds. These are not provider quotas or activation. */
export const OFFICIAL_PROFILE = Object.freeze({
  name: 'synthetic-official-v1' as const,
  dailyDefault: 30,
  dailyMaximum: 30,
  cityMaximum: 10,
  manualDefault: 10,
  manualMaximum: 10,
  batch: 32,
  examined: 128,
  transactionMs: 5000,
  statementMs: 1500,
  lockMs: 500,
  finalProofMs: 500,
  finalStatementMs: 100,
  finalLockMs: 1,
  manifestBytes: 262144,
  renderBytes: 262144,
  requestBytes: 262144,
  assets: 32,
  assetBytes: 2097152,
  aggregateBytes: 16777216,
  pixels: 16000000,
  edge: 4096,
  previewMs: 300000,
  dailyWindowMs: 26 * 3600000,
  unresolved: 20,
  dailyIntake: 100,
  claims: 10,
  accountConcurrency: 1,
  globalConcurrency: 2,
  leaseMs: 30000,
  prepareMs: 5000,
  leaseGuardMs: 1000,
  permitMs: 100,
  attempts: 3,
  reconciliationClaims: 3,
  reconciliationTotal: 30,
  totalClaims: 33,
  drainMs: 10000,
  callbackBytes: 65536,
  callbackDepth: 8,
  callbackMembers: 32,
  callbackStringBytes: 1024,
  callbackBurst: 10,
  callbackPerMinute: 60,
  callbackSkewMs: 300000,
  callbackOverlapMs: 600000,
  payloadLifetimeMs: 86400000,
  purgeBatch: 20,
  reconstructionBytes: 16384,
  maintenanceBatches: 4,
  maintenanceMs: 20000,
  affectedRegions: 8,
});
export const officialUuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const officialHash = z.string().regex(/^[0-9a-f]{64}$/);
export const officialCounter = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export function validLiteral(value: string): boolean {
  return (
    !value.includes('\0') &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      value,
    )
  );
}
export const officialLiteral = (maximum: number) =>
  z
    .string()
    .refine(validLiteral)
    .refine((value) => [...value].length <= maximum);
export function scalarExcerpt(value: string): string {
  if (!validLiteral(value)) throw new Error('Invalid literal');
  const scalars = [...value];
  return scalars.length > 60 ? scalars.slice(0, 60).join('') + '…' : value;
}
export function scalarTitle(value: string, test = false): string {
  if (!validLiteral(value)) throw new Error('Invalid literal');
  const scalars = [...value];
  const title =
    scalars.length > 50 ? scalars.slice(0, 49).join('') + '…' : value;
  return (test ? '【测试】' : '') + title;
}
export function escapeOfficialLiteral(value: string): string {
  if (!validLiteral(value)) throw new Error('Invalid literal');
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}
export function officialDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** Persisted manifests cross JSONB storage; object member order is not identity. */
export function officialCanonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function boundedOfficialJson(
  value: unknown,
  maximum: number = OFFICIAL_PROFILE.manifestBytes,
): string {
  const result = JSON.stringify(value);
  if (!validLiteral(result) || Buffer.byteLength(result, 'utf8') > maximum)
    throw new Error('Official payload budget');
  return result;
}
/** Numeric comparison without IEEE-754 conversion; accepted score has four decimal places. */
export function compareOfficialScore(a: string, b: string): number {
  const parse = (v: string) => {
    if (!/^(0|[1-9][0-9]{0,19})\.[0-9]{4}$/.test(v))
      throw new Error('Invalid unified score');
    return BigInt(v.replace('.', ''));
  };
  const x = parse(a),
    y = parse(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A total monotonic preparation/read deadline, never a provider admission. */
export async function boundedOfficialRead<T>(
  run: Promise<T>,
  milliseconds = 5000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Official preparation deadline')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
