import type { SafetyChanges } from '../community/safety-changes';
import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import type { IdentityRuntime } from '../auth/runtime';
import type { SessionStore } from '../auth/session';
import { ClientError } from '../api/errors';
import { systemClock } from '../platform/clock';
import type { Clock, Storage } from '../platform/contracts';
import { HttpMessagingGateway, type MessagingGateway } from './gateway';
import { PendingMessagingStore } from './pending';
export interface MessagingRuntime {
  readonly privateViews?: PrivateViewLifecycle;
  readonly safetyChanges?: SafetyChanges;
  readonly sessions: SessionStore;
  readonly gateway: MessagingGateway | undefined;
  readonly pending: PendingMessagingStore;
  readonly newRequestId: () => Promise<string>;
  readonly clock: Clock;
  assertStorage(): void;
}
export function createMessagingRuntime(
  identity: IdentityRuntime,
  storage: Storage,
  origin: string,
  newRequestId: () => Promise<string>,
  clock: Clock = systemClock,
  lifecycle: Pick<MessagingRuntime, 'privateViews' | 'safetyChanges'> = {},
): MessagingRuntime {
  const pending = new PendingMessagingStore(storage, origin);
  let owner = identity.sessions.snapshot(),
    storageFailed = false;
  const scrub = (exceptAccountId?: string) => {
    try {
      pending.scrubBodies(exceptAccountId);
      storageFailed = false;
    } catch {
      storageFailed = true;
    }
  };
  scrub(owner.credentials?.accountId);
  identity.sessions.subscribe(() => {
    const current = identity.sessions.snapshot();
    if (
      current.epoch !== owner.epoch ||
      current.credentials?.accountId !== owner.credentials?.accountId
    )
      scrub();
    owner = current;
  });
  return {
    ...lifecycle,
    sessions: identity.sessions,
    gateway: identity.api ? new HttpMessagingGateway(identity.api) : undefined,
    pending,
    newRequestId,
    clock,
    assertStorage() {
      if (storageFailed)
        throw new ClientError(
          'storage',
          'Private-message storage could not be cleared',
        );
    },
  };
}
