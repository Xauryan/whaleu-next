import type {
  IdentityProvider,
  ProviderIdentity,
} from '../../identity/contracts.js';
import {
  ProviderIdentityDigests,
  type IdentityDigest,
} from '../../identity/registration/digests.js';
import { ApplicationError } from '../../http/application-error.js';
import { z } from 'zod';

export interface ReauthenticationScope {
  readonly purpose: 'acceptance';
  readonly attemptId: string;
  readonly requestId: string;
  readonly accountId: string;
  readonly generation: string;
  readonly appId: string;
  /** Internal pre-exchange mapping only. Never store in a request or receipt. */
  readonly subject: string;
}
const scopeSchema = z.strictObject({
  purpose: z.literal('acceptance'),
  attemptId: z.uuid(),
  requestId: z.uuid(),
  accountId: z.uuid(),
  generation: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((value) => BigInt(value) <= 9223372036854775807n),
  appId: z.string().regex(/^wx[a-f0-9]{16}$/),
  subject: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
function checkedScope(scope: ReauthenticationScope): ReauthenticationScope {
  const result = scopeSchema.safeParse(scope);
  if (!result.success)
    throw new ApplicationError('REAL_DELETION_SCOPE_UNAVAILABLE');
  return Object.freeze(result.data);
}
declare const verifiedProviderBrand: unique symbol;
export interface VerifiedRequestProvider {
  readonly [verifiedProviderBrand]: true;
}
export interface ProviderCapture extends IdentityDigest {
  readonly keyCheck: string;
}
interface VerifiedState {
  readonly scope: ReauthenticationScope;
  readonly identity: ProviderIdentity;
  readonly digests: readonly ProviderCapture[];
  consumed: boolean;
}
/** Scoped to the existing server adapter, not IdentityService.login. This class
 * never creates an account/session and cannot turn a recovery exchange into a
 * bearer. Network work belongs outside a DB transaction; the consuming authority
 * must re-lock/recheck the original mapping, attempt deadline and session. */
export class RequestProviderReauthentication {
  readonly #proofs = new WeakMap<VerifiedRequestProvider, VerifiedState>();
  constructor(
    private readonly provider: IdentityProvider,
    private readonly digests: ProviderIdentityDigests,
  ) {}
  async exchange(
    code: string,
    scope: ReauthenticationScope,
  ): Promise<VerifiedRequestProvider> {
    // Copy before the network await: caller mutation cannot retarget an in-flight proof.
    const bound = checkedScope(scope);
    const identity = await this.provider.exchange(code);
    if (
      identity.provider !== 'wechat' ||
      identity.appId !== bound.appId ||
      identity.subject !== bound.subject
    )
      throw new ApplicationError('REAL_DELETION_SCOPE_UNAVAILABLE');
    const proof = Object.freeze({}) as VerifiedRequestProvider;
    this.#proofs.set(proof, {
      scope: bound,
      identity: Object.freeze({ ...identity }),
      digests: Object.freeze(
        this.digests.epochs.map((epoch) =>
          Object.freeze({
            ...this.digests.digest(identity, epoch),
            keyCheck: this.digests.keyCheck(epoch),
          }),
        ),
      ),
      consumed: false,
    });
    return proof;
  }
  /** Once per attempted accepting transaction. A failed SQL transaction does not
   * permit reusing consumed provider proof: retry requires a new fresh exchange.
   * Already committed command receipts must be recovered BEFORE this method. */
  consume(
    proof: VerifiedRequestProvider,
    scope: ReauthenticationScope,
  ): Readonly<{
    identity: ProviderIdentity;
    digests: readonly ProviderCapture[];
  }> {
    const state = this.#proofs.get(proof);
    if (
      !state ||
      state.consumed ||
      Object.keys(state.scope).some(
        (key) =>
          state.scope[key as keyof ReauthenticationScope] !==
          scope[key as keyof ReauthenticationScope],
      )
    )
      throw new ApplicationError('REAL_DELETION_SCOPE_UNAVAILABLE');
    state.consumed = true;
    return Object.freeze({ identity: state.identity, digests: state.digests });
  }
}
