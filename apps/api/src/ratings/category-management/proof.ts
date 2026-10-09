import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
export interface CategoryHeadFact {
  regionId: string | null;
  catalogId: string | null;
}
interface CommandFact {
  actor: string;
  requestId: string;
  intentHash: string;
  sessionId: string;
  contextRevision: string;
  releaseId: string;
  outcome: 'prepared' | 'applied';
}
interface Fact {
  heads: readonly CategoryHeadFact[];
  navigation: string;
  pool: string;
  command: CommandFact | null;
}
async function epochs(tx: PoolClient) {
  const row = (
    await tx.query<{ navigation: string; pool: string }>(
      `SELECT (SELECT epoch::text FROM whaleu_ratings.navigation_epoch WHERE singleton AND version=1) navigation,(SELECT epoch::text FROM whaleu_ratings.random_pool_epoch WHERE singleton AND version=1) pool`,
    )
  ).rows[0];
  if (!row || !/^\d+$/.test(row.navigation) || !/^\d+$/.test(row.pool))
    throw new ApplicationError('RATING_UNAVAILABLE');
  return row;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 2,
  failureCode: 'RATING_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_ratings.navigation_epoch,whaleu_ratings.random_pool_epoch IN SHARE MODE NOWAIT',
      );
      const current = await epochs(read);
      for (const fact of facts) {
        if (
          fact.navigation !== current.navigation ||
          fact.pool !== current.pool
        )
          throw new ApplicationError('RATING_UNAVAILABLE');
        const heads = (
          await read.query<{ ordinal: number; valid: boolean }>(
            `SELECT w.ordinal::integer,
        CASE WHEN w.catalog_id IS NULL THEN h.catalog_id IS NULL ELSE coalesce(h.catalog_id=w.catalog_id AND c.region_id IS NOT DISTINCT FROM w.region_id
        AND c.sealed AND c.coverage='complete' AND c.provenance='accepted' AND c.effective_at<=clock_timestamp() AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp())
        AND whaleu_ratings.category_catalog_compat_current(c.id),false) END valid
        FROM unnest($1::uuid[],$2::uuid[]) WITH ORDINALITY w(region_id,catalog_id,ordinal)
        LEFT JOIN whaleu_ratings.catalog_heads h ON h.scope_key=coalesce(w.region_id::text,'global') LEFT JOIN whaleu_ratings.catalogs c ON c.id=h.catalog_id ORDER BY w.ordinal`,
            [
              fact.heads.map((row) => row.regionId),
              fact.heads.map((row) => row.catalogId),
            ],
          )
        ).rows;
        if (
          heads.length !== fact.heads.length ||
          heads.some(
            (row, index) => row.ordinal !== index + 1 || row.valid !== true,
          )
        )
          throw new ApplicationError('RATING_UNAVAILABLE');
        if (!fact.command) continue;
        const command = fact.command;
        const row = (
          await read.query(
            `SELECT 1 FROM whaleu_ratings.category_command_preparations p
        JOIN whaleu_ratings.command_claims claim ON claim.account_id=p.account_id AND claim.request_id=p.request_id AND claim.operation='create_categories' AND claim.intent_hash=p.intent_hash
        WHERE p.account_id=$1 AND p.request_id=$2 AND p.intent_hash=$3 AND p.session_id=$4 AND p.context_revision=$5 AND p.release_id=$6 AND p.valid_until>clock_timestamp()
        AND ($7='prepared' OR EXISTS(SELECT 1 FROM whaleu_ratings.category_command_transitions t JOIN whaleu_ratings.requests q ON q.account_id=t.actor_account_id AND q.request_id=t.request_id
          WHERE t.release_id=p.release_id AND t.actor_account_id=p.account_id AND t.request_id=p.request_id AND t.intent_hash=p.intent_hash AND t.context_revision=p.context_revision
          AND t.mutation_transaction=pg_current_xact_id() AND q.operation='create_categories' AND q.intent_hash=p.intent_hash AND q.receipt->>'outcome'='applied' AND q.receipt->>'releaseId'=p.release_id::text))`,
            [
              command.actor,
              command.requestId,
              command.intentHash,
              command.sessionId,
              command.contextRevision,
              command.releaseId,
              command.outcome,
            ],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('RATING_UNAVAILABLE');
      }
    }),
};
/** The writer chooses before OR after, never keeps a stale replaced head fact. */
export async function retainCategoryHeads(
  heads: readonly CategoryHeadFact[],
  tx: PoolClient,
  command?: CommandFact,
) {
  if (heads.length === 0 || heads.length > 33)
    throw new ApplicationError('RATING_UNAVAILABLE');
  enableRequiredTransactionProof(tx, proof);
  const fact = Object.freeze({
    heads: Object.freeze(heads.map((row) => Object.freeze({ ...row }))),
    ...(await epochs(tx)),
    command: command ? Object.freeze({ ...command }) : null,
  });
  registerRequiredTransactionFact(tx, proof, ownerFingerprint(fact), fact);
}
