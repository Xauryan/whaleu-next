import type { IdentityRuntime } from '../auth/runtime';
import type { CommunityRuntime } from '../community/runtime';
import type { Storage } from '../platform/contracts';
import type { VerificationRuntime } from './runtime';
import { HttpInstitutionalGateway } from './institutional-gateway';
import { PendingInstitutionalStore } from './institutional-pending';
import { UnavailableInstitutionalNativePort } from './institutional-port';
import type { InstitutionalRuntime } from './institutional-controller';
/** Synthetic adapters are injected only by tests; no production switch can enable one. */
export function createInstitutionalRuntime(
  identity: IdentityRuntime,
  community: CommunityRuntime,
  verification: VerificationRuntime,
  storage: Storage,
  origin: string,
): InstitutionalRuntime | undefined {
  if (!identity.api) return undefined;
  return {
    sessions: identity.sessions,
    gateway: new HttpInstitutionalGateway(identity.api),
    journal: new PendingInstitutionalStore(storage, origin),
    port: new UnavailableInstitutionalNativePort(),
    origin,
    ...(community.profiles ? { profiles: community.profiles } : {}),
    privateViews: verification.privateViews,
    newRequestId: community.newRequestId,
  };
}
