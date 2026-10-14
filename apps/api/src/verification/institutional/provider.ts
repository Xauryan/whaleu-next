import { z } from 'zod';
import { safeStudentNumber } from '../policy.js';
import {
  INSTITUTIONAL_PURPOSE,
  institutionalResponseSchema,
} from './contracts.js';
export const INSTITUTIONAL_PROVIDER = Symbol('INSTITUTIONAL_PROVIDER');
export interface InstitutionalProviderContext {
  readonly accountId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly claimId: string;
  readonly sessionId: string;
  readonly issuerNamespace: string;
  readonly adapterId: string;
  readonly audience: string;
  readonly bindingVersion: string;
  readonly policyReference: string;
  readonly institutionId: string;
  readonly originRegionId: string;
  readonly supportedNumber: boolean;
  readonly requestExpiresAt: string;
  readonly claimDeadline: string;
}
const timestamp = z.string().min(10).max(80);
const payloadSchema = z.strictObject({
  accountId: z.uuid(),
  requestId: z.uuid(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/),
  claimId: z.uuid(),
  sessionId: z.uuid(),
  issuerNamespace: z.string().min(1).max(200),
  adapterId: z.string().min(1).max(200),
  audience: z.string().min(1).max(200),
  bindingVersion: z.string().min(1).max(100),
  policyReference: z.string().min(1).max(200),
  institutionId: z.uuid(),
  originRegionId: z.uuid(),
  purpose: z.literal(INSTITUTIONAL_PURPOSE),
  subject: z
    .string()
    .min(1)
    .max(200)
    .refine((s) => s.trim() === s && !/[\p{Cc}\p{Cf}]/u.test(s)),
  eligibleStudent: z.literal(true),
  studentNumber: z.string().refine(safeStudentNumber).nullable(),
  authenticatedAt: timestamp,
  responseUseExpiresAt: timestamp,
  factExpiresAt: timestamp,
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type InstitutionalVerifiedPayload = z.infer<typeof payloadSchema>;
export type InstitutionalProviderResult =
  | { readonly state: 'accepted'; readonly capability: object }
  | {
      readonly state:
        | 'rejected'
        | 'challenge_required'
        | 'provider_unavailable'
        | 'outcome_unknown';
    };
/** Only an explicitly composed trusted adapter supplies payloads. Runtime configuration,
 * HTTP callers and native callbacks cannot enroll adapters or mint result capabilities. */
export interface InstitutionalTransport {
  readonly adapterId: string;
  exchange(
    response: string,
    context: InstitutionalProviderContext,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export interface InstitutionalProvider {
  available(adapterId: string): boolean;
  verifyResponse(
    response: string,
    context: InstitutionalProviderContext,
  ): Promise<InstitutionalProviderResult>;
  consume(
    capability: object,
    context: InstitutionalProviderContext,
  ): InstitutionalVerifiedPayload | null;
}
/** Runtime-private capability admission rejects structurally forged/cast objects. */
export class TrustedInstitutionalVerifier implements InstitutionalProvider {
  readonly #accepted = new WeakMap<
    object,
    {
      context: InstitutionalProviderContext;
      payload: InstitutionalVerifiedPayload;
    }
  >();
  constructor(private readonly transport: InstitutionalTransport) {}
  available(adapterId: string) {
    return adapterId === this.transport.adapterId;
  }
  async verifyResponse(
    response: string,
    context: InstitutionalProviderContext,
  ): Promise<InstitutionalProviderResult> {
    if (!this.available(context.adapterId))
      return { state: 'provider_unavailable' };
    if (!institutionalResponseSchema.safeParse(response).success)
      return { state: 'rejected' };
    const cancellation = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        this.transport.exchange(response, context, cancellation.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            cancellation.abort();
            reject(new Error('Institutional verification timed out'));
          }, 5000);
        }),
      ]);
      if (
        raw &&
        typeof raw === 'object' &&
        'state' in raw &&
        ['rejected', 'challenge_required', 'provider_unavailable'].includes(
          String(raw.state),
        )
      )
        return {
          state: raw.state as
            'rejected' | 'challenge_required' | 'provider_unavailable',
        };
      const decoded = payloadSchema.safeParse(raw);
      if (!decoded.success) return { state: 'rejected' };
      const p = decoded.data;
      for (const key of [
        'accountId',
        'requestId',
        'requestHash',
        'claimId',
        'sessionId',
        'issuerNamespace',
        'adapterId',
        'audience',
        'bindingVersion',
        'policyReference',
        'institutionId',
        'originRegionId',
      ] as const)
        if (p[key] !== context[key]) return { state: 'rejected' };
      if (p.studentNumber !== null && !context.supportedNumber)
        return { state: 'rejected' };
      const capability = Object.freeze(Object.create(null)) as object;
      this.#accepted.set(capability, {
        context: Object.freeze({ ...context }),
        payload: Object.freeze(p),
      });
      return { state: 'accepted', capability };
    } catch {
      return { state: 'outcome_unknown' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  consume(
    capability: object,
    context: InstitutionalProviderContext,
  ): InstitutionalVerifiedPayload | null {
    const entry = this.#accepted.get(capability);
    this.#accepted.delete(capability);
    if (!entry || JSON.stringify(entry.context) !== JSON.stringify(context))
      return null;
    return entry.payload;
  }
}
/** No live institutional protocol or native handoff is asserted by this binding. */
export class UnavailableInstitutionalProvider implements InstitutionalProvider {
  available(_adapterId: string) {
    return false;
  }
  async verifyResponse(
    _response: string,
    _context: InstitutionalProviderContext,
  ): Promise<InstitutionalProviderResult> {
    return { state: 'provider_unavailable' };
  }
  consume(_capability: object, _context: InstitutionalProviderContext): null {
    return null;
  }
}
