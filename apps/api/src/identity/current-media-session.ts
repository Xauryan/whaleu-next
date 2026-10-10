import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import type { SessionView } from './contracts.js';
import type { IdentityService } from './identity.service.js';

const currentSession: unique symbol = Symbol('current-media-session');
export interface CurrentMediaSession extends SessionView {
  readonly [currentSession]: true;
}
const issued = new WeakMap<
  CurrentMediaSession,
  { tx: PoolClient; epoch: object }
>();
/** Narrow internal current-session capability. Identity authenticates the real
 * presented bearer, holds account/session/token locks and enrolls its deadline.
 * Neither client session IDs nor stored grant fields can mint this capability. */
export async function authenticateMediaSession(
  identity: IdentityService,
  token: string,
  tx: PoolClient,
): Promise<CurrentMediaSession> {
  const epoch = transactionReadEpoch(tx);
  if (!epoch) throw new ApplicationError('MEDIA_UNAVAILABLE');
  const view = await identity.session(token, tx);
  const capability = Object.freeze({
    ...view,
    [currentSession]: true as const,
  });
  issued.set(capability, { tx, epoch });
  return capability;
}
export function requireCurrentMediaSession(
  capability: CurrentMediaSession,
  tx: PoolClient,
): void {
  const evidence = issued.get(capability);
  if (
    !evidence ||
    evidence.tx !== tx ||
    evidence.epoch !== transactionReadEpoch(tx)
  )
    throw new ApplicationError('MEDIA_UNAVAILABLE');
}
