import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';

/** Fresh-only boundary. Call after namespace conflict and historical recovery.
 * Read equality does not authorize a legacy write: adopted scopes also need an
 * exact accepted native_v1_compat_write policy. Cleanup never calls this gate. */
export async function requireLegacyRatingFreshScope(
  regionId: string | null,
  tx: PoolClient,
  operation?: string,
): Promise<void> {
  const installed = (
    await tx.query<{ installed: boolean }>(
      "SELECT to_regclass('whaleu_ratings.scope_protocol_heads') IS NOT NULL installed",
    )
  ).rows[0];
  if (!installed) throw new ApplicationError('RATING_UNAVAILABLE');
  if (!installed.installed) return;
  const row = (
    await tx.query<{ phase: string }>(
      `SELECT v.phase FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON (v.id,v.logical_scope_key)=(h.version_id,h.logical_scope_key) WHERE h.logical_scope_key=$1`,
      [regionId ?? 'global'],
    )
  ).rows[0];
  if (row?.phase !== 'adopted') return;
  try {
    const observed = (
      await tx.query<{ observation: { validUntil: string } | null }>(
        'SELECT whaleu_ratings.legacy_bridge_observation($1,$2) observation',
        [regionId ?? 'global', operation ?? null],
      )
    ).rows[0]?.observation;
    if (!observed) throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const deadline = Date.parse(observed.validUntil);
    if (!Number.isFinite(deadline))
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    registerTransactionDeadline(tx, deadline, 'RATING_SCOPE_UNAVAILABLE');
  } catch (error) {
    if (
      error instanceof ApplicationError ||
      (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23514')
    )
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    throw error;
  }
}
