import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { RuntimeConfig } from '../../config/config.js';
import { textSourceCapabilitySchema } from '../text-source/protocol.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  registerOptionalTransactionProof,
} from '../../database/transaction-deadlines.js';
import { inspectReadingSchema } from './readiness.js';
import { FORMATTER } from './contracts.js';
export const readingFormatterCapabilitySchema = z.strictObject({
  version: z.literal(FORMATTER),
  schema: z.enum(['installed', 'missing', 'unavailable']),
  worker: z.strictObject({
    requestedMode: z.enum(['disabled', 'manual_only', 'automatic']),
    readiness: z.literal('not_observed'),
  }),
});
export const readingCapabilitySchema = z
  .strictObject({
    ...textSourceCapabilitySchema.shape,
    version: z.literal(2),
    formatter: readingFormatterCapabilitySchema,
  })
  .superRefine((value, context) => {
    if (
      !textSourceCapabilitySchema.safeParse({
        ...value,
        version: 1,
        formatter: 'not_configured',
      }).success
    )
      context.addIssue({
        code: 'custom',
        message: 'Inconsistent source capability',
      });
  });
export type ReadingCapability = z.infer<typeof readingCapabilitySchema>;
/** Optional diagnostics only. Never creates processing authority or weakens the
 * earlier source-publication capability's mandatory actor/Review proofs. */
export async function observeReadingFormatter(
  tx: PoolClient,
  requestedMode: RuntimeConfig['COMMUNITY_READING_FORMATTING_PROCESSING'],
): Promise<ReadingCapability['formatter']> {
  const result: ReadingCapability['formatter'] = {
    version: FORMATTER,
    schema: 'unavailable',
    worker: { requestedMode, readiness: 'not_observed' },
  };
  const checkpoint = checkpointTransactionDeadlines(tx);
  await tx.query('SAVEPOINT optional_reading_capability');
  try {
    await tx.query("SET LOCAL lock_timeout='5ms'");
    const current = await inspectReadingSchema(tx);
    result.schema = current.status === 'ready' ? 'installed' : 'missing';
    if (current.status === 'ready')
      registerOptionalTransactionProof(tx, {
        validate: async () => {
          // Only optional M2 facts are recoverable here. The managed finalizer
          // owns rollback; failed rollback and earlier mandatory proofs stay fatal.
          try {
            await tx.query(
              'LOCK TABLE whaleu_community.reading_format_heads,whaleu_community.reading_format_jobs,whaleu_community.reading_format_results,whaleu_community.reading_format_slots IN SHARE MODE NOWAIT',
            );
            const final = await inspectReadingSchema(tx);
            return (
              final.status === 'ready' && final.catalog === current.catalog
            );
          } catch {
            return false;
          }
        },
        invalidate: () => {
          result.schema = 'unavailable';
        },
      });
    await tx.query('RELEASE SAVEPOINT optional_reading_capability');
  } catch {
    await tx.query('ROLLBACK TO SAVEPOINT optional_reading_capability');
    restoreTransactionDeadlines(tx, checkpoint);
    await tx.query('RELEASE SAVEPOINT optional_reading_capability');
    result.schema = 'unavailable';
  }
  return result;
}
