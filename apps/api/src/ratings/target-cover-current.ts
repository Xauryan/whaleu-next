import {
  ratingsMediaMutationActive,
  collectRatingsMediaMutationRead,
} from '../media/ratings-discussion-mutation-proof.js';
import type { PoolClient } from 'pg';
import type { AnyRatingTargetDefinitionDescriptor } from '../community/content-review/rating-target-definition-contracts.js';
import {
  transactionReadEpoch,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { MediaRequiredProof } from '../media/required-proof.js';
import {
  RatingsMediaContentSnapshotFacade,
  ratingsMediaContentKey,
  type MediaSnapshotReadBudget,
} from '../media/ratings-content-snapshot.facade.js';
import { ratingsMediaDescriptorSchema } from '../media/contracts-ratings.js';
import type { RatingsMediaContentFact } from '../media/ratings-content-snapshot.facade.js';
import { RATING_SCOPED_BYTE_LIMIT } from './scoped/constants.js';

const ledgers = new WeakMap<PoolClient, { epoch: object; bytes: number }>();
/** One transaction ledger for cover metadata AND the complete Ratings pool. */
export function retainRatingReadBytes(tx: PoolClient, value: unknown): void {
  retainRatingReadByteCount(
    tx,
    Buffer.byteLength(JSON.stringify(value), 'utf8'),
  );
}
export function retainRatingReadByteCount(tx: PoolClient, bytes: number): void {
  const epoch = transactionReadEpoch(tx);
  if (!epoch) throw new ApplicationError('RATING_UNAVAILABLE');
  let ledger = ledgers.get(tx);
  if (!ledger || ledger.epoch !== epoch) {
    ledger = { epoch, bytes: 0 };
    ledgers.set(tx, ledger);
  }
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new ApplicationError('RATING_UNAVAILABLE');
  ledger.bytes += bytes;
  if (ledger.bytes > RATING_SCOPED_BYTE_LIMIT)
    throw new ApplicationError('RATING_UNAVAILABLE');
}
const snapshots = new RatingsMediaContentSnapshotFacade(),
  mediaProof = new MediaRequiredProof();
const retained = new WeakMap<
  PoolClient,
  {
    epoch: object;
    facts: Map<string, { expected: string; fact: RatingsMediaContentFact }>;
  }
>();
function retainedFacts(tx: PoolClient) {
  const epoch = transactionReadEpoch(tx);
  if (!epoch) throw new ApplicationError('MEDIA_UNAVAILABLE');
  let state = retained.get(tx);
  if (!state || state.epoch !== epoch) {
    state = { epoch, facts: new Map() };
    retained.set(tx, state);
  }
  return state.facts;
}

/** This is the complete exact-content gate, not a nullable decoration. Unknown
 * and denied covers remain unknown and denied targets, including unselected pool
 * entries. A mutation caller may defer only its OWN new fact until its finish;
 * previously registered transaction facts are never removed or overwritten. */
export async function currentRatingTargetCovers(
  definitions: readonly AnyRatingTargetDefinitionDescriptor[],
  tx: PoolClient,
  retain = true,
): Promise<readonly ('allow' | 'deny' | 'unavailable')[]> {
  if (definitions.length > 256)
    throw new ApplicationError('RATING_UNAVAILABLE');
  const references = definitions.flatMap((d) =>
    d.envelope.version === 6 && d.envelope.cover
      ? [
          {
            parent: {
              ownerKind: 'ratings' as const,
              resourceKind: 'target_cover' as const,
              resourceId: d.envelope.cover.appearanceId,
              contentVersion: 1 as const,
            },
            expected: [
              {
                assetId: d.envelope.cover.assetId,
                digest: d.envelope.cover.manifestDigest,
              },
            ],
          },
        ]
      : [],
  );
  if (!references.length) return definitions.map(() => 'allow' as const);
  const budget: MediaSnapshotReadBudget = {
    async rows<T>(
      read: PoolClient,
      sql: string,
      values: unknown[],
      cap: number,
    ) {
      const rows = (await read.query(sql, values)).rows as T[];
      if (rows.length > cap) throw new ApplicationError('MEDIA_UNAVAILABLE');
      retainRatingReadBytes(tx, rows);
      return rows;
    },
  };
  const cache = retainedFacts(tx);
  const missing = retain
    ? references.filter((r) => !cache.has(ratingsMediaContentKey(r.parent)))
    : references;
  if (retain && missing.length && !ratingsMediaMutationActive(tx))
    await mediaProof.capture(tx);
  const fresh = missing.length
    ? await snapshots.readBatch(missing, tx, budget)
    : new Map<string, RatingsMediaContentFact>();
  if (retain && missing.length)
    collectRatingsMediaMutationRead(tx, missing, fresh, budget);
  if (retain)
    for (const r of missing) {
      const key = ratingsMediaContentKey(r.parent),
        fact = fresh.get(key);
      if (fact) cache.set(key, { expected: JSON.stringify(r.expected), fact });
    }
  const facts = new Map<string, RatingsMediaContentFact>();
  for (const r of references) {
    const key = ratingsMediaContentKey(r.parent),
      entry = cache.get(key);
    if (retain && entry) {
      if (entry.expected !== JSON.stringify(r.expected))
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      facts.set(key, entry.fact);
    } else {
      const fact = fresh.get(key);
      if (fact) facts.set(key, fact);
    }
  }
  return Object.freeze(
    definitions.map((d) => {
      if (d.envelope.version !== 6 || d.envelope.cover === null)
        return 'allow' as const;
      const fact = facts.get(
        ratingsMediaContentKey({
          ownerKind: 'ratings',
          resourceKind: 'target_cover',
          resourceId: d.envelope.cover.appearanceId,
          contentVersion: 1,
        }),
      );
      if (
        !fact ||
        fact.decision === 'unknown' ||
        fact.validUntil === null ||
        !Number.isFinite(fact.validUntil)
      )
        return 'unavailable' as const;
      registerTransactionDeadline(tx, fact.validUntil, 'MEDIA_UNAVAILABLE');
      return fact.decision;
    }),
  );
}
export async function retainRatingTargetCoverMediaAfter(
  tx: PoolClient,
): Promise<void> {
  await mediaProof.capture(tx);
}

/** Only called after the Ratings current gate in this same read transaction.
 * A descriptor is an authenticated opaque route, never a download capability. */
export function currentRatingTargetCoverDescriptor(
  definition: AnyRatingTargetDefinitionDescriptor,
  context: { contextId: string; contextToken: string },
  tx: PoolClient,
) {
  if (definition.envelope.version !== 6 || definition.envelope.cover === null)
    return null;
  const cover = definition.envelope.cover,
    key = ratingsMediaContentKey({
      ownerKind: 'ratings',
      resourceKind: 'target_cover',
      resourceId: cover.appearanceId,
      contentVersion: 1,
    }),
    entry = retainedFacts(tx).get(key);
  if (
    !entry ||
    entry.expected !==
      JSON.stringify([
        { assetId: cover.assetId, digest: cover.manifestDigest },
      ]) ||
    entry.fact.decision !== 'allow' ||
    entry.fact.attachments.length !== 1
  )
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  const attachment = entry.fact.attachments[0]!;
  return ratingsMediaDescriptorSchema.parse({
    protocol: 'ratings-target-media-v1',
    kind: 'ratings-target-media',
    targetId: definition.targetId,
    ...context,
    appearanceId: cover.appearanceId,
    bindingId: attachment.bindingId,
    width: attachment.width,
    height: attachment.height,
    variants: ['thumb-v1', 'display-v1'],
  });
}
