import type { PoolClient } from 'pg';
import type { VisibilityPurpose } from '../community/community-policy.js';
import { ApplicationError } from '../http/application-error.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';

type Purpose = VisibilityPurpose | 'public_profile';
interface RequiredRelationship {
  readonly viewer: string;
  readonly author: string;
  readonly purpose: Purpose;
}
/** Fixed by the existing successful read envelopes: 50 selected cards each
 * with <=1024 allowed comments, <=1024 allowed replies, <=20 roster members
 * and two parent projections; 128 scanned like chains plus one guard, depth3;
 * one mandatory public target, rounded up for repeated parent projections.
 * This is not a new per-history author ceiling. */
export const MAX_REQUIRED_RELATIONSHIPS = 110_000;
export const REQUIRED_RELATIONSHIP_BATCH = 256;
export const REQUIRED_RELATIONSHIP_BUDGET_MS = 500;
const proof: RequiredTransactionProof<RequiredRelationship> = {
  maximumFacts: MAX_REQUIRED_RELATIONSHIPS,
  failureCode: 'SAFETY_UNAVAILABLE',
  validate: validateRelationships,
};

/** Opt-in only for profile discovery and own liked READ COMMITTED reads.
 * Mutation consumers retain their existing authorization/receipt behavior. */
export function enableSafetyRelationshipProof(tx: PoolClient): void {
  enableRequiredTransactionProof(tx, proof);
}

/** Record only an observed allow, preserving earlier allow requirements even
 * when a later read denies. Anonymous, guest and self checks never enter here. */
export function requireAllowedSafetyRelationship(
  viewer: string,
  author: string,
  purpose: Purpose,
  tx: PoolClient,
): void {
  if (viewer === author) return;
  registerRequiredTransactionFact(tx, proof, `${viewer}:${author}:${purpose}`, {
    viewer,
    author,
    purpose,
  });
}

function statementMilliseconds(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/.exec(value);
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    min: 60000,
    h: 3600000,
    d: 86400000,
  };
  if (!match) throw new ApplicationError('SAFETY_UNAVAILABLE');
  const number = Number(match[1]) * units[match[2] ?? 'ms']!;
  if (!Number.isFinite(number))
    throw new ApplicationError('SAFETY_UNAVAILABLE');
  return number;
}

async function validateRelationships(
  facts: readonly RequiredRelationship[],
  tx: PoolClient,
): Promise<void> {
  if (!facts.length) return;
  const expires = performance.now() + REQUIRED_RELATIONSHIP_BUDGET_MS;
  const settings = (
    await tx.query<{
      isolation: string;
      statement_timeout: string;
      lock_timeout: string;
    }>(`SELECT current_setting('transaction_isolation') AS isolation,
    current_setting('statement_timeout') AS statement_timeout,
    current_setting('lock_timeout') AS lock_timeout`)
  ).rows[0];
  if (!settings || settings.isolation !== 'read committed')
    throw new ApplicationError('SAFETY_UNAVAILABLE');
  const inherited = statementMilliseconds(settings.statement_timeout);
  const lockInherited = statementMilliseconds(settings.lock_timeout);
  const budget = async () => {
    const remaining = Math.floor(expires - performance.now());
    if (remaining <= 0) throw new ApplicationError('SAFETY_UNAVAILABLE');
    await tx.query(
      `SELECT set_config('statement_timeout',$1,true),
      set_config('lock_timeout',$2,true)`,
      [
        `${Math.min(remaining, inherited || 100, 100)}ms`,
        `${Math.min(remaining, lockInherited || 1, 1)}ms`,
      ],
    );
    if (performance.now() >= expires)
      throw new ApplicationError('SAFETY_UNAVAILABLE');
  };
  try {
    await budget();
    // Includes absent pairs and raw SQL transitions. NOWAIT adds no new source
    // wait after deferred constraints; every later owner read is nonlocking.
    await tx.query('LOCK TABLE whaleu_safety.blocks IN SHARE MODE NOWAIT');
    for (
      let offset = 0;
      offset < facts.length;
      offset += REQUIRED_RELATIONSHIP_BATCH
    ) {
      const batch = facts.slice(offset, offset + REQUIRED_RELATIONSHIP_BATCH);
      await budget();
      const rows = (
        await tx.query<{
          ordinal: number;
          outgoing: boolean;
          incoming: boolean;
        }>(
          `SELECT r.ordinality::integer AS ordinal,
          coalesce(outgoing.active,false) AS outgoing,
          coalesce(incoming.active,false) AS incoming
        FROM unnest($1::uuid[],$2::uuid[],$3::boolean[])
          WITH ORDINALITY AS r(viewer,author,bilateral,ordinality)
        LEFT JOIN whaleu_safety.blocks outgoing
          ON outgoing.blocker_id=r.viewer AND outgoing.blocked_id=r.author
        LEFT JOIN whaleu_safety.blocks incoming
          ON r.bilateral AND incoming.blocker_id=r.author AND incoming.blocked_id=r.viewer
        ORDER BY r.ordinality`,
          [
            batch.map((fact) => fact.viewer),
            batch.map((fact) => fact.author),
            batch.map((fact) => fact.purpose !== 'list_projection'),
          ],
        )
      ).rows;
      if (rows.length !== batch.length)
        throw new ApplicationError('SAFETY_UNAVAILABLE');
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!,
          fact = batch[index]!;
        if (
          row.ordinal !== index + 1 ||
          typeof row.outgoing !== 'boolean' ||
          typeof row.incoming !== 'boolean'
        )
          throw new ApplicationError('SAFETY_UNAVAILABLE');
        if (
          row.outgoing ||
          (fact.purpose !== 'list_projection' && row.incoming)
        )
          throw new ApplicationError(
            fact.purpose === 'public_profile'
              ? 'SAFETY_UNAVAILABLE'
              : 'COMMUNITY_UNAVAILABLE',
          );
      }
    }
    if (performance.now() >= expires)
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    await tx.query(
      `SELECT set_config('statement_timeout',$1,true),
      set_config('lock_timeout',$2,true)`,
      [settings.statement_timeout, settings.lock_timeout],
    );
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === '55P03' || error.code === '57014')
    )
      throw new ApplicationError('SAFETY_UNAVAILABLE');
    throw error;
  }
}
