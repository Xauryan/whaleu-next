import type { CountProofOwner } from '../../database/count-proof.js';
export const accountModerationProofOwner: CountProofOwner = {
  order: 1464356112,
  async capture(tx) {
    return (
      await tx.query<{ slot: number; version: number; epoch: string }>(
        'SELECT slot,version,epoch::text FROM whaleu_safety.account_moderation_epochs ORDER BY slot',
      )
    ).rows;
  },
  async fence(tx) {
    await tx.query(
      'LOCK TABLE whaleu_safety.account_moderation_epochs IN SHARE MODE NOWAIT',
    );
    return true;
  },
};
