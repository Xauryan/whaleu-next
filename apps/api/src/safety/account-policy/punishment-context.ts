import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { transactionReadEpoch } from '../../database/transaction-deadlines.js';
import type { SafetyAction } from '../account-moderation/contracts.js';

export interface BoundPunishmentPolicy {
  enforce(
    accountId: string,
    action: SafetyAction,
    tx: PoolClient,
  ): Promise<void>;
}
interface Lease {
  tx: PoolClient;
  token: symbol;
  policy: BoundPunishmentPolicy;
}
const bindings = new WeakMap<PoolClient, Lease>();
const callbackLease = new AsyncLocalStorage<symbol>();
/** Only the database owner binds a provider to its live transaction. A retained
 * callback cannot inherit another app's provider when a pool client is reused.
 * Read-proof checkpoints may refresh their epoch within this same transaction;
 * only the owning database transaction creates and releases this lifetime token. */
export async function withAccountPunishmentPolicy<T>(
  tx: PoolClient,
  policy: BoundPunishmentPolicy,
  operation: () => Promise<T>,
): Promise<T> {
  if (!transactionReadEpoch(tx) || bindings.has(tx))
    throw new Error('Invalid account policy transaction lease');
  const lease = { tx, token: Symbol('account-policy-transaction'), policy };
  bindings.set(tx, lease);
  try {
    return await callbackLease.run(lease.token, operation);
  } finally {
    if (bindings.get(tx)?.token === lease.token) bindings.delete(tx);
  }
}
export function boundAccountPunishmentPolicy(
  tx: PoolClient,
): BoundPunishmentPolicy | undefined {
  const token = callbackLease.getStore();
  const binding = bindings.get(tx);
  if (
    !token ||
    !binding ||
    token !== binding.token ||
    transactionReadEpoch(tx) === undefined
  )
    return undefined;
  return binding.policy;
}
