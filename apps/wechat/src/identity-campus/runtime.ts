import type { IdentityRuntime } from '../auth/runtime';
import type { SessionStore } from '../auth/session';
import { PrivateViewLifecycle } from '../identity-privacy/overlay';
import type { Storage } from '../platform/contracts';
import {
  HttpIdentityCampusGateway,
  type IdentityCampusGateway,
} from './gateway';
import { PendingIdentityCampusStore } from './pending';
export interface IdentityCampusRuntime {
  readonly onSelectionChanged?: (accountId: string) => void;
  readonly sessions: SessionStore;
  readonly gateway: IdentityCampusGateway | undefined;
  readonly pending: PendingIdentityCampusStore;
  readonly privateViews: PrivateViewLifecycle;
  readonly newRequestId: () => Promise<string>;
}
export function createIdentityCampusRuntime(
  identity: IdentityRuntime,
  storage: Storage,
  origin: string,
  newRequestId: () => Promise<string>,
  onSelectionChanged?: (accountId: string) => void,
): IdentityCampusRuntime {
  return {
    sessions: identity.sessions,
    ...(onSelectionChanged ? { onSelectionChanged } : {}),
    gateway: identity.api
      ? new HttpIdentityCampusGateway(identity.api)
      : undefined,
    pending: new PendingIdentityCampusStore(storage, origin),
    privateViews: new PrivateViewLifecycle(),
    newRequestId,
  };
}
