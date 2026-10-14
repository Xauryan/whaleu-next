import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  OFFICIAL_PROFILE as P,
  officialUuid,
  officialDigest,
} from './profile.js';

/** Public fictitious values, never provider credentials. No environment lookup. */
export const SYNTHETIC_CALLBACK_PUBLIC_KEYS = Object.freeze({
  1: 'PUBLIC-FIXTURE-ONLY-synthetic-official-v1-epoch-1',
  2: 'PUBLIC-FIXTURE-ONLY-synthetic-official-v1-epoch-2',
});
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const epoch = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const envelopeSchema = z.strictObject({
  profile: z.literal(P.name),
  accountRef: officialUuid,
  keyEpoch: positive,
  eventId: officialUuid,
  officialSubject: z
    .string()
    .regex(
      /^synthetic:official:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  kind: z.enum(['subscribe', 'unsubscribe']),
  sequence: positive,
  occurredAt: epoch,
  issuedAt: epoch,
});
export type SyntheticCallbackEnvelope = z.infer<typeof envelopeSchema>;
export interface SyntheticChallenge {
  accountRef: string;
  keyEpoch: number;
  challenge: string;
  issuedAt: number;
}
export class CallbackRejection extends Error {
  constructor(readonly status: 400 | 401 | 409 | 413 | 415 | 429 | 503) {
    super('Callback unavailable');
  }
}
export function canonicalCallbackBody(e: SyntheticCallbackEnvelope): Buffer {
  return Buffer.from(
    JSON.stringify({
      profile: e.profile,
      accountRef: e.accountRef,
      keyEpoch: e.keyEpoch,
      eventId: e.eventId,
      officialSubject: e.officialSubject,
      kind: e.kind,
      sequence: e.sequence,
      occurredAt: e.occurredAt,
      issuedAt: e.issuedAt,
    }),
    'utf8',
  );
}
export function parseCallbackBody(
  raw: Buffer,
  contentType: string | undefined,
  contentEncoding?: string,
): SyntheticCallbackEnvelope {
  if (raw.length > P.callbackBytes) throw new CallbackRejection(413);
  if (
    contentEncoding !== undefined ||
    !/^application\/json(?:;\s?charset=utf-8)?$/.test(contentType ?? '')
  )
    throw new CallbackRejection(415);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new CallbackRejection(400);
  }
  // Exact fixed flat schema is stricter than the generic 8-depth/32-member budgets.
  const result = envelopeSchema.safeParse(parsed);
  if (
    !result.success ||
    result.data.occurredAt > result.data.issuedAt ||
    !raw.equals(canonicalCallbackBody(result.data))
  )
    throw new CallbackRejection(400);
  return result.data;
}
export function parseSyntheticChallenge(query: unknown): SyntheticChallenge {
  const textInteger = z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .transform(Number)
    .pipe(epoch);
  const result = z
    .strictObject({
      accountRef: officialUuid,
      keyEpoch: textInteger.pipe(positive),
      challenge: z.string().regex(/^[0-9a-f]{32}$/),
      issuedAt: textInteger,
    })
    .safeParse(query);
  if (!result.success) throw new CallbackRejection(400);
  return result.data;
}
export function syntheticChallengeBytes(q: SyntheticChallenge): Buffer {
  return Buffer.from(
    JSON.stringify([q.accountRef, q.keyEpoch, q.challenge, q.issuedAt]),
  );
}
export function syntheticCallbackSignature(
  method: 'GET' | 'POST',
  registrationId: string,
  body: Buffer,
  keyEpoch: 1 | 2,
): string {
  return createHmac('sha256', SYNTHETIC_CALLBACK_PUBLIC_KEYS[keyEpoch])
    .update(
      `${P.name}\n${method}\n/v1/official-account-callbacks/${registrationId}\n`,
    )
    .update(body)
    .digest('hex');
}
export function verifySyntheticSignature(
  method: 'GET' | 'POST',
  registrationId: string,
  body: Buffer,
  signature: string | undefined,
  keyEpoch: number,
): void {
  if (
    (keyEpoch !== 1 && keyEpoch !== 2) ||
    !/^[0-9a-f]{64}$/.test(signature ?? '')
  )
    throw new CallbackRejection(401);
  const expected = Buffer.from(
    syntheticCallbackSignature(method, registrationId, body, keyEpoch),
    'hex',
  );
  const actual = Buffer.from(signature!, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new CallbackRejection(401);
}
export function callbackLogicalHash(e: SyntheticCallbackEnvelope): string {
  return officialDigest([
    e.profile,
    e.accountRef,
    e.eventId,
    e.officialSubject,
    e.kind,
    e.sequence,
    e.occurredAt,
  ]);
}
export function callbackSemanticHash(e: SyntheticCallbackEnvelope): string {
  return officialDigest([
    e.accountRef,
    e.officialSubject,
    e.kind,
    e.sequence,
    e.occurredAt,
  ]);
}
