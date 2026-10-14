import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  ASSISTANCE_LIMITS,
  ASSISTANCE_PROFILE,
  assistanceUsageSchema,
  type AssistanceProviderInput,
} from './contracts.js';

export interface AssistancePermit {
  readonly key: string;
  readonly inputDigest: string;
  readonly profile: typeof ASSISTANCE_PROFILE;
  readonly input: AssistanceProviderInput;
  readonly expiresAt: number;
}
export interface PreparedAssistance {
  readonly key: string;
  readonly inputDigest: string;
  readonly profile: typeof ASSISTANCE_PROFILE;
  /** Synchronous, synthetic-only boundary. Cannot await a network effect. */
  dispatch(permit: AssistancePermit): unknown;
}
export interface AssistanceRuntime {
  readonly mode: 'synthetic-only';
  readonly profile: typeof ASSISTANCE_PROFILE;
  /** An accepted synthetic tokenizer. Never infer provider tokens from characters. */
  measure(input: AssistanceProviderInput): number;
  prepare(key: string, inputDigest: string): Promise<PreparedAssistance>;
  /** Status-only. No transmission of prompt/name or implicit retries. */
  reconcile(key: string, inputDigest: string): Promise<unknown>;
}
export const assistanceAckSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unknown') }),
  z.strictObject({
    status: z.literal('not_accepted'),
    key: z.string().max(200),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    profile: z.literal(ASSISTANCE_PROFILE),
  }),
  z.strictObject({
    status: z.literal('accepted'),
    key: z.string().max(200),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    profile: z.literal(ASSISTANCE_PROFILE),
    text: z.string(),
    usage: assistanceUsageSchema,
  }),
]);
export type AssistanceAck = z.infer<typeof assistanceAckSchema>;
export function decodeAssistanceAck(
  raw: unknown,
  key: string,
  digest: string,
): AssistanceAck {
  try {
    if (typeof raw === 'string') {
      if (
        raw.length > ASSISTANCE_LIMITS.outputEnvelopeBytes ||
        Buffer.byteLength(raw) > ASSISTANCE_LIMITS.outputEnvelopeBytes
      )
        return { status: 'unknown' };
      raw = JSON.parse(raw) as unknown;
    }
    // Synthetic adapters may return a structured envelope. Bound its exact
    // shallow shape before serialization/parsing; never stringify huge trees.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return { status: 'unknown' };
    const fields = Object.getOwnPropertyDescriptors(raw);
    if (
      Object.keys(fields).length > 6 ||
      Object.entries(fields).some(
        ([key, field]) =>
          ![
            'status',
            'key',
            'inputDigest',
            'profile',
            'text',
            'usage',
          ].includes(key) || !('value' in field),
      )
    )
      return { status: 'unknown' };
    for (const [key, field] of Object.entries(fields)) {
      if (key === 'usage') {
        if (
          !field.value ||
          typeof field.value !== 'object' ||
          Array.isArray(field.value)
        )
          return { status: 'unknown' };
        const meters = Object.getOwnPropertyDescriptors(field.value);
        if (
          Object.keys(meters).length !== 3 ||
          Object.entries(meters).some(
            ([name, meter]) =>
              !['inputTokens', 'outputTokens', 'monetaryMinorUnits'].includes(
                name,
              ) ||
              !('value' in meter) ||
              typeof meter.value !== 'number',
          )
        )
          return { status: 'unknown' };
      } else if (
        typeof field.value !== 'string' ||
        field.value.length > ASSISTANCE_LIMITS.outputEnvelopeBytes
      )
        return { status: 'unknown' };
    }
    // Parse only detached data properties. An adapter-owned prototype may carry
    // toJSON/getters; neither serialization nor schema validation may call them.
    const detached = Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [
        name,
        name === 'usage'
          ? Object.fromEntries(
              Object.entries(Object.getOwnPropertyDescriptors(field.value)).map(
                ([meter, value]) => [meter, value.value],
              ),
            )
          : field.value,
      ]),
    );
    const encoded = JSON.stringify(detached);
    if (Buffer.byteLength(encoded) > ASSISTANCE_LIMITS.outputEnvelopeBytes)
      return { status: 'unknown' };
    const value = assistanceAckSchema.parse(detached);
    if (
      value.status !== 'unknown' &&
      (value.key !== key ||
        value.inputDigest !== digest ||
        value.profile !== ASSISTANCE_PROFILE)
    )
      return { status: 'unknown' };
    return value;
  } catch {
    return { status: 'unknown' };
  }
}
export async function boundedAssistance<T>(
  operation: Promise<T>,
  ms: number = ASSISTANCE_LIMITS.reconcileMs,
): Promise<T> {
  if (
    !Number.isSafeInteger(ms) ||
    ms <= 0 ||
    ms > ASSISTANCE_LIMITS.reconcileMs
  )
    throw Error('Synthetic assistance timeout bound is invalid');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error('Synthetic assistance unavailable')),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const consumed = new WeakSet<object>();
export function dispatchAssistance(
  prepared: PreparedAssistance,
  permit: AssistancePermit,
): unknown {
  if (
    consumed.has(permit) ||
    performance.now() >= permit.expiresAt ||
    prepared.key !== permit.key ||
    prepared.inputDigest !== permit.inputDigest ||
    prepared.profile !== permit.profile
  )
    throw Error('Synthetic assistance permit unavailable');
  consumed.add(permit);
  return prepared.dispatch(permit);
}
