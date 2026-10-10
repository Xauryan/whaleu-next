import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  transactionReadEpoch,
  type RequiredTransactionProof,
  registerTransactionDeadline,
} from '../../database/transaction-deadlines.js';
/** An additive capability source bound to the existing adopted protocol tuple.
 * It never changes the Category compiler or upgrades an old v2 source payload. */
export async function targetCoverCapabilities(
  protocolIds: readonly string[],
  tx: PoolClient,
) {
  await retainTargetCoverCapabilityEpoch(tx);
  const rows = (
    await tx.query<{
      id: string;
      protocol_version_id: string;
      source_digest: string;
      valid_until: Date;
      current: boolean;
    }>(
      `SELECT c.id,c.protocol_version_id,c.source_digest,c.valid_until,
    whaleu_ratings.target_cover_capability_current(c.id,clock_timestamp()) current
    FROM whaleu_ratings.target_cover_capability_sources c WHERE c.protocol_version_id=ANY($1::uuid[]) ORDER BY c.protocol_version_id,c.id`,
      [protocolIds],
    )
  ).rows;
  // Preserve absence and invalid registrations as facts. Only complete current
  // registrations grant a media operation; text-only v3 reads remain possible.
  for (const r of rows)
    if (r.current && r.valid_until instanceof Date)
      registerTransactionDeadline(
        tx,
        r.valid_until.getTime(),
        'RATING_SCOPE_UNAVAILABLE',
      );
  return protocolIds
    .slice()
    .sort()
    .map((protocolVersionId) => {
      const r = rows.find(
        (row) => row.protocol_version_id === protocolVersionId,
      );
      return r
        ? {
            id: r.id,
            protocolVersionId,
            sourceDigest: r.source_digest,
            validUntil: r.valid_until.toISOString(),
            current: r.current === true,
          }
        : { protocolVersionId, current: false };
    });
}

/** Called for every actual covered definition, before random eligibility/draw.
 * A missing scope capability aborts the complete read; it never filters a path. */
export function requireTargetCoverRead(
  scope: import('./context.service.js').ResolvedRatingReadScope,
  definition: import('../../community/content-review/rating-target-definition-contracts.js').AnyRatingTargetDefinitionDescriptor,
): void {
  if (definition.envelope.version !== 6 || definition.envelope.cover === null)
    return;
  if (
    !('context' in scope) ||
    (scope.context.protocolVersion !== 3 &&
      scope.context.protocolVersion !== 4) ||
    !scope.targetCoverCapable
  )
    throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
}

const capabilityProof: RequiredTransactionProof<string> = {
  maximumFacts: 1,
  failureCode: 'RATING_SCOPE_UNAVAILABLE',
  validate: async (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_SCOPE_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_ratings.target_cover_capability_epoch,whaleu_ratings.target_cover_capability_sources IN SHARE MODE NOWAIT',
      );
      const current = (
        await read.query<{ epoch: string }>(
          'SELECT epoch::text FROM whaleu_ratings.target_cover_capability_epoch WHERE singleton',
        )
      ).rows[0]?.epoch;
      if (facts.length !== 1 || facts[0] !== current)
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    }),
};
export async function retainTargetCoverCapabilityEpoch(
  tx: PoolClient,
): Promise<void> {
  enableRequiredTransactionProof(tx, capabilityProof);
  const epoch = (
    await tx.query<{ epoch: string }>(
      'SELECT epoch::text FROM whaleu_ratings.target_cover_capability_epoch WHERE singleton',
    )
  ).rows[0]?.epoch;
  if (!epoch || !/^(0|[1-9][0-9]*)$/.test(epoch))
    throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
  registerRequiredTransactionFact(
    tx,
    capabilityProof,
    'target-cover-capability',
    epoch,
  );
}
const capabilities = new WeakMap<
  PoolClient,
  { epoch: object; scopes: Set<string> }
>();
/** Additional restriction on original text-only operations, not a new v2
 * capability. Complete target projections separately require protocol3. */
export async function requireCurrentTargetCoverScope(
  scope: import('./context.service.js').ResolvedRatingReadScope,
  definitions: readonly import('../../community/content-review/rating-target-definition-contracts.js').AnyRatingTargetDefinitionDescriptor[],
  tx: PoolClient,
): Promise<void> {
  if (
    !definitions.some(
      (d) => d.envelope.version === 6 && d.envelope.cover !== null,
    )
  )
    return;
  await retainTargetCoverCapabilityEpoch(tx);
  const epoch = transactionReadEpoch(tx);
  if (!epoch) throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
  let state = capabilities.get(tx);
  if (!state || state.epoch !== epoch) {
    state = { epoch, scopes: new Set() };
    capabilities.set(tx, state);
  }
  const key = `${scope.catalog.regionId ?? 'global'}:${scope.protocolGeneration}`;
  if (state.scopes.has(key)) return;
  if (
    'context' in scope &&
    (scope.context.protocolVersion === 3 || scope.context.protocolVersion === 4)
  ) {
    if (!scope.targetCoverCapable)
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
  } else {
    const row = (
      await tx.query<{ valid_until: Date }>(
        `SELECT c.valid_until FROM whaleu_ratings.target_cover_capability_sources c
 JOIN whaleu_ratings.scope_protocol_versions v ON v.id=c.protocol_version_id
 WHERE v.logical_scope_key=$1 AND v.generation=$2 AND whaleu_ratings.target_cover_capability_current(c.id,clock_timestamp())`,
        [scope.catalog.regionId ?? 'global', scope.protocolGeneration],
      )
    ).rows;
    if (row.length !== 1 || !(row[0]!.valid_until instanceof Date))
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      row[0]!.valid_until.getTime(),
      'RATING_SCOPE_UNAVAILABLE',
    );
  }
  state.scopes.add(key);
}
