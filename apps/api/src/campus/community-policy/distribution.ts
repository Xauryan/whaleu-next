import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
  transactionReadEpoch,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';

const uuid = z.uuid().refine((id) => id === id.toLowerCase());
const groupSchema = z.strictObject({
  status: z.literal('known'),
  topologySnapshotId: uuid,
  topologyRevision: z.number().int().positive(),
  groupId: uuid,
  memberRegionIds: z.array(uuid),
  sourceGeneration: z.string().regex(/^[a-f0-9]{64}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  validUntil: z.string().nullable(),
});
export type DistributionGroup =
  | { status: 'unavailable'; fingerprint: string }
  | (Omit<z.infer<typeof groupSchema>, 'validUntil'> & {
      validUntil: number | null;
    });
interface Fact {
  regionId: string;
  generation: string;
  fingerprint: string;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 256,
  failureCode: 'COMMUNITY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'COMMUNITY_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_campus.community_distribution_generation IN SHARE MODE NOWAIT',
      );
      const generation = (
        await read.query<{ generation: string }>(
          "SELECT whaleu_community.related_sync_generation_fingerprint('distribution') AS generation",
        )
      ).rows[0]?.generation;
      if (!generation || facts.some((fact) => fact.generation !== generation))
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }),
};
const cache = new WeakMap<
  PoolClient,
  { epoch: object; values: Map<string, DistributionGroup> }
>();
/** Campus-owned complete group enumeration. SQL and application share one parser,
 * original source generation, negative observations and exact deadline protocol. */
export async function communityDistributionGroup(
  regionId: string,
  tx: PoolClient,
): Promise<DistributionGroup> {
  const epoch = transactionReadEpoch(tx);
  if (!epoch) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  let current = cache.get(tx);
  if (current?.epoch !== epoch) {
    current = { epoch, values: new Map() };
    cache.set(tx, current);
  }
  const previous = current!.values.get(regionId);
  if (previous) return previous;
  const row = (
    await tx.query<{ fact: unknown }>(
      'SELECT whaleu_campus.community_distribution_group($1) AS fact',
      [regionId],
    )
  ).rows[0]?.fact;
  const known = groupSchema.safeParse(row);
  const unavailable = z
    .strictObject({
      status: z.literal('unavailable'),
      sourceGeneration: z.string().regex(/^[a-f0-9]{64}$/),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .safeParse(row);
  if (!known.success && !unavailable.success)
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  const source = known.success ? known.data : unavailable.data!;
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    `${regionId}:${source.fingerprint}`,
    Object.freeze({
      regionId,
      generation: source.sourceGeneration,
      fingerprint: source.fingerprint,
    }),
  );
  let result: DistributionGroup;
  if (known.success) {
    const members = known.data.memberRegionIds;
    if (
      !members.includes(regionId) ||
      members.some((id, i) => i > 0 && id <= members[i - 1]!)
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    registerTransactionExactDeadline(
      tx,
      known.data.validUntil,
      'COMMUNITY_UNAVAILABLE',
    );
    result = Object.freeze({
      ...known.data,
      memberRegionIds: Object.freeze([...members]) as string[],
      validUntil:
        known.data.validUntil === null
          ? null
          : Date.parse(known.data.validUntil),
    });
  } else
    result = Object.freeze({
      status: 'unavailable',
      fingerprint: source.fingerprint,
    });
  current!.values.set(regionId, result);
  return result;
}
