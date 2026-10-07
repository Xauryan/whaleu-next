import type { IdentityRuntime } from '../auth/runtime';
import { PrivateViewLifecycle } from '../identity-privacy/overlay';
import { HttpVerificationGateway, type VerificationGateway } from './gateway';

export interface VerificationRuntime {
  readonly gateway: VerificationGateway | undefined;
  readonly privateViews: PrivateViewLifecycle;
}
/** Uses the same lifecycle primitive, with an independent own-account status gateway. */
export function createVerificationRuntime(
  identity: IdentityRuntime,
): VerificationRuntime {
  return {
    gateway: identity.api
      ? new HttpVerificationGateway(identity.api)
      : undefined,
    privateViews: new PrivateViewLifecycle(),
  };
}
