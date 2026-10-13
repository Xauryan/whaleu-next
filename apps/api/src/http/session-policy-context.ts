import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import type { SessionView } from '../identity/contracts.js';

/** Application-composition hook, set only by the registered server handler.
 * Identity stays responsible for authenticating the presented session. The
 * observer is additional policy, never a replacement Identity credential. */
export interface SessionPolicyContext {
  readonly observe: (session: SessionView, tx: PoolClient) => Promise<void>;
}
export const sessionPolicyContext =
  new AsyncLocalStorage<SessionPolicyContext>();
export async function observeAuthenticatedSession(
  session: SessionView,
  tx?: PoolClient,
): Promise<void> {
  if (tx) await sessionPolicyContext.getStore()?.observe(session, tx);
}
