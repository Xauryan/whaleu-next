import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
const schema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['active', 'blocked']),
  lifecycle: z.enum(['active', 'cooling', 'erasing', 'completed']),
  lifecycle_generation: z.string().regex(/^(0|[1-9][0-9]*)$/),
  xmin: z.string().regex(/^[0-9]+$/),
});
interface Fact {
  ids: readonly string[];
  fingerprint: string;
}
async function rows(ids: readonly string[], tx: PoolClient, lock = false) {
  return (
    await tx.query(
      `SELECT id,status,lifecycle,lifecycle_generation::text,xmin::text FROM whaleu_identity.accounts WHERE id=ANY($1::uuid[]) ORDER BY id${lock ? ' FOR SHARE NOWAIT' : ''}`,
      [ids],
    )
  ).rows.map((row) => schema.parse(row));
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 8,
  failureCode: 'COMMUNITY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'COMMUNITY_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_identity.accounts IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if (ownerFingerprint(await rows(fact.ids, read)) !== fact.fingerprint)
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }),
};
/** Identity-owned, viewer-independent. Retains missing rows as negative facts. */
export async function processingAccountState(
  ids: readonly string[],
  tx: PoolClient,
) {
  const ordered = [...new Set(ids)].sort();
  if (
    !ordered.length ||
    ordered.length > 3 ||
    ordered.some((id) => !z.uuid().safeParse(id).success)
  )
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  enableRequiredTransactionProof(tx, proof);
  const current = await rows(ordered, tx, true),
    fingerprint = ownerFingerprint(current);
  registerRequiredTransactionFact(
    tx,
    proof,
    `${ordered.join(':')}:${fingerprint}`,
    Object.freeze({ ids: Object.freeze(ordered), fingerprint }),
  );
  return ordered.map(
    (id) =>
      current.find((row) => row.id === id) ?? {
        id,
        status: 'missing' as const,
        lifecycle: 'missing' as const,
      },
  );
}
