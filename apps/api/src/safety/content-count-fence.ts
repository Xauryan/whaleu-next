import type { PoolClient } from 'pg';

/** Owner-only final fallback fence, including absent named pairs. Never acquire
 * before a later source/constraint wait or outside the final proof savepoint. */
export async function fenceSmallSafetyContentCount(
  tx: PoolClient,
): Promise<void> {
  await tx.query(`LOCK TABLE whaleu_safety.account_heads,whaleu_safety.blocks
    IN SHARE MODE NOWAIT`);
}
