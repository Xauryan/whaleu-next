import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { boundedOwnerProof } from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';

const proof: RequiredTransactionProof<string> = {
  maximumFacts: 16,
  failureCode: 'COMMUNITY_UNAVAILABLE',
  validate: (versions, tx) =>
    boundedOwnerProof(tx, 'COMMUNITY_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.post_category_read_epoch IN SHARE MODE NOWAIT',
      );
      const row = (
        await read.query<{ version: string }>(
          'SELECT version::text FROM whaleu_community.post_category_read_epoch WHERE singleton=true',
        )
      ).rows[0];
      if (!row || versions.some((version) => version !== row.version))
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }),
};

/** Classification changes invalidate navigation, including an empty candidate
 * window. Ordinary likes/comments do not change this dedicated category epoch.
 * Use only for read scopes, never as an authorization capability. */
export async function currentCategoryCursorScope(
  scope: string,
  tx: PoolClient,
): Promise<string> {
  enableRequiredTransactionProof(tx, proof);
  const row = (
    await tx.query<{ version: string }>(
      'SELECT version::text FROM whaleu_community.post_category_read_epoch WHERE singleton=true',
    )
  ).rows[0];
  if (
    !row ||
    !/^(0|[1-9][0-9]*)$/.test(row.version) ||
    BigInt(row.version) > 9223372036854775807n
  )
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  registerRequiredTransactionFact(tx, proof, row.version, row.version);
  return createHash('sha256')
    .update(JSON.stringify(['current-category-scope-v1', scope, row.version]))
    .digest('hex');
}
