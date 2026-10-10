import type { PoolClient } from 'pg';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
  type RequiredTransactionProof,
} from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { scopedId } from './contracts.js';
import { ratingDiscussionCapabilitySchema } from './discussion-media-contracts.js';

function unavailable(): never {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
}
async function epochs(tx: PoolClient): Promise<string> {
  const rows = (
    await tx.query<{ kind: string; epoch: string }>(`
    SELECT 'discussion' kind,epoch::text FROM whaleu_ratings.discussion_media_capability_epoch WHERE singleton
    UNION ALL SELECT 'source',epoch::text FROM whaleu_ratings.scoped_source_epoch WHERE singleton AND version=1
    UNION ALL SELECT 'protocol',epoch::text FROM whaleu_ratings.scope_protocol_epoch WHERE singleton AND version=1
    ORDER BY kind
  `)
  ).rows;
  if (
    rows.length !== 3 ||
    rows.some((row) => !/^(0|[1-9][0-9]*)$/.test(row.epoch))
  )
    unavailable();
  return ownerFingerprint(rows);
}
const proof: RequiredTransactionProof<string> = {
  maximumFacts: 1,
  failureCode: 'RATING_SCOPE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_SCOPE_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_ratings.discussion_media_capability_epoch,whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch IN SHARE MODE NOWAIT',
      );
      if (facts.length !== 1 || facts[0] !== (await epochs(read)))
        unavailable();
    }),
};
/** All requested adopted scopes must be covered. Absence, expiry and ambiguous
 * input are unavailable; neither target cover capability nor the parent source
 * by itself grants discussion writes. No network/provider calls occur here. */
export async function requireDiscussionMediaCapabilities(
  protocolIds: readonly string[],
  tx: PoolClient,
) {
  if (
    protocolIds.length < 1 ||
    protocolIds.length > 1001 ||
    new Set(protocolIds).size !== protocolIds.length ||
    protocolIds.some((id) => !scopedId.safeParse(id).success)
  )
    unavailable();
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    'discussion-media-capability',
    await epochs(tx),
  );
  const rows = (
    await tx.query<{
      id: string;
      protocol_version_id: string;
      generation: string;
      adoption_digest: string;
      valid_until: Date;
      source_valid_until: Date;
      current: boolean;
    }>(
      `SELECT c.id,c.protocol_version_id,c.generation,c.adoption_digest,c.valid_until,s.valid_until source_valid_until,
      whaleu_ratings.discussion_media_capability_current(c.id,clock_timestamp()) current
    FROM whaleu_ratings.discussion_media_capability_sources c
    JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(c.source_id,c.source_revision)
    WHERE c.protocol_version_id=ANY($1::uuid[]) ORDER BY c.protocol_version_id,c.id`,
      [protocolIds],
    )
  ).rows;
  if (
    rows.length !== protocolIds.length ||
    new Set(rows.map((row) => row.protocol_version_id)).size !==
      protocolIds.length
  )
    unavailable();
  return Object.freeze(
    protocolIds.map((protocolVersionId) => {
      const row = rows.find(
        (entry) => entry.protocol_version_id === protocolVersionId,
      );
      if (
        !row ||
        row.current !== true ||
        !(row.valid_until instanceof Date) ||
        !(row.source_valid_until instanceof Date)
      )
        unavailable();
      const deadline = Math.min(
        row.valid_until.getTime(),
        row.source_valid_until.getTime(),
      );
      if (!Number.isSafeInteger(deadline)) unavailable();
      registerTransactionDeadline(tx, deadline, 'RATING_SCOPE_UNAVAILABLE');
      return Object.freeze({
        protocolVersionId,
        ...ratingDiscussionCapabilitySchema.parse({
          id: row.id,
          generation: row.generation,
          // The independently domain-separated adoption digest includes the full
          // version tuple and compatibility evidence, not just the shared source.
          sourceDigest: row.adoption_digest,
          validUntil: new Date(deadline).toISOString(),
        }),
      });
    }),
  );
}
