import type { PoolClient } from 'pg';
import { ApplicationError } from '../../../http/application-error.js';
import { boundedOwnerProof } from '../../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../../database/transaction-deadlines.js';
import type { CurrentTargetRow } from '../../target-definition.repository.js';
interface CommandFact {
  requestId: string;
  intentHash: string;
  contextRevision: string;
  sessionId: string;
  outcome: 'prepared' | 'applied' | 'noop';
}
interface EditFact {
  actor: string;
  targetId: string;
  revision: string;
  definitionRevision: string;
  contentVersion: number;
  appliedTargetRevision: string;
  regionId: string | null;
  categoryId: string;
  catalogId: string;
  navigation: string;
  pool: string;
  command: CommandFact | null;
}
const proof: RequiredTransactionProof<EditFact> = {
  maximumFacts: 2,
  failureCode: 'RATING_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_UNAVAILABLE', async (read) => {
      // Pending raw writers must fail rather than wait inside the final proof.
      await read.query(
        'LOCK TABLE whaleu_ratings.navigation_epoch,whaleu_ratings.random_pool_epoch IN SHARE MODE NOWAIT',
      );
      for (const f of facts) {
        const row = (
          await read.query(
            `SELECT 1 FROM whaleu_ratings.targets t
         JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id
         JOIN whaleu_ratings.target_definition_versions v ON v.target_id=h.target_id AND v.content_version=h.content_version AND v.definition_revision=h.definition_revision
         JOIN whaleu_ratings.target_definition_lifecycles l ON l.target_id=t.id AND l.target_revision=t.revision AND l.content_version=h.content_version AND l.definition_revision=h.definition_revision
         JOIN whaleu_ratings.catalog_heads ch ON ch.scope_key=coalesce(t.region_id::text,'global') AND ch.catalog_id=$9
         JOIN whaleu_ratings.catalogs c ON c.id=ch.catalog_id AND c.region_id IS NOT DISTINCT FROM t.region_id
         JOIN whaleu_ratings.target_memberships m ON m.catalog_id=c.id AND m.target_id=t.id AND m.category_id=t.category_id
         JOIN whaleu_ratings.navigation_epoch ne ON ne.singleton AND ne.version=1 AND ne.epoch=$10::bigint
         JOIN whaleu_ratings.random_pool_epoch pe ON pe.singleton AND pe.version=1 AND pe.epoch=$11::bigint
         WHERE t.id=$1 AND t.creator_id=$2 AND t.revision=$3 AND t.active AND t.region_id IS NOT DISTINCT FROM $7::uuid AND t.category_id=$8
           AND h.definition_revision=$4 AND h.content_version=$5 AND v.applied_target_revision=$6
           AND c.sealed AND c.coverage='complete' AND c.provenance='accepted' AND c.effective_at<=clock_timestamp() AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp())
           AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.target_owner_tombstones d WHERE d.target_id=t.id)`,
            [
              f.targetId,
              f.actor,
              f.revision,
              f.definitionRevision,
              f.contentVersion,
              f.appliedTargetRevision,
              f.regionId,
              f.categoryId,
              f.catalogId,
              f.navigation,
              f.pool,
            ],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('RATING_UNAVAILABLE');
        if (!f.command) continue;
        const cmd = f.command;
        const prepared = (
          await read.query(
            `SELECT 1 FROM whaleu_ratings.target_edit_preparations p
         JOIN whaleu_ratings.command_claims claim ON claim.account_id=p.account_id AND claim.request_id=p.request_id AND claim.operation='edit_target' AND claim.intent_hash=p.intent_hash
         WHERE p.account_id=$1 AND p.request_id=$2 AND p.intent_hash=$3 AND p.session_id=$4 AND p.context_revision=$5 AND p.valid_until>clock_timestamp()
         AND p.target_id=$6 AND (($7='applied' AND p.after_revision=$8 AND p.definition_revision=$9 AND p.content_version=$10)
           OR ($7<>'applied' AND p.before_revision=$8 AND p.before_definition_revision=$9 AND p.before_content_version=$10))`,
            [
              f.actor,
              cmd.requestId,
              cmd.intentHash,
              cmd.sessionId,
              cmd.contextRevision,
              f.targetId,
              cmd.outcome,
              f.revision,
              f.definitionRevision,
              f.contentVersion,
            ],
          )
        ).rows[0];
        if (!prepared) throw new ApplicationError('RATING_UNAVAILABLE');
        if (cmd.outcome === 'prepared') continue;
        const outcome = (
          await read.query(
            `SELECT 1 FROM whaleu_ratings.requests q WHERE q.account_id=$1 AND q.request_id=$2 AND q.operation='edit_target' AND q.intent_hash=$3
         AND q.receipt->>'outcome'=$4 AND q.receipt->>'targetId'=$5 AND q.receipt->>'revision'=$6 AND q.receipt->>'definitionRevision'=$7 AND (q.receipt->>'contentVersion')::integer=$8
         AND (($4='applied' AND EXISTS(SELECT 1 FROM whaleu_ratings.target_edit_transitions a WHERE a.actor_account_id=q.account_id AND a.request_id=q.request_id AND a.target_id=$5::uuid AND a.after_revision=$6::uuid AND a.after_definition_revision=$7::uuid AND a.after_content_version=$8 AND a.mutation_transaction=pg_current_xact_id()))
           OR ($4='noop' AND EXISTS(SELECT 1 FROM whaleu_ratings.target_edit_noops a WHERE a.actor_account_id=q.account_id AND a.request_id=q.request_id AND a.target_id=$5::uuid AND a.revision=$6::uuid AND a.definition_revision=$7::uuid AND a.content_version=$8 AND a.mutation_transaction=pg_current_xact_id())))`,
            [
              f.actor,
              cmd.requestId,
              cmd.intentHash,
              cmd.outcome,
              f.targetId,
              f.revision,
              f.definitionRevision,
              f.contentVersion,
            ],
          )
        ).rows[0];
        if (!outcome) throw new ApplicationError('RATING_UNAVAILABLE');
      }
    }),
};
export async function retainTargetEditSnapshot(
  row: CurrentTargetRow,
  catalogId: string,
  tx: PoolClient,
  command?: CommandFact,
): Promise<void> {
  enableRequiredTransactionProof(tx, proof);
  const epochs = (
    await tx.query<{ navigation: string; pool: string }>(
      `SELECT (SELECT epoch::text FROM whaleu_ratings.navigation_epoch WHERE singleton AND version=1) navigation,
     (SELECT epoch::text FROM whaleu_ratings.random_pool_epoch WHERE singleton AND version=1) pool`,
    )
  ).rows[0];
  if (!epochs || !/^\d+$/.test(epochs.navigation) || !/^\d+$/.test(epochs.pool))
    throw new ApplicationError('RATING_UNAVAILABLE');
  registerRequiredTransactionFact(
    tx,
    proof,
    `owner-edit:${row.id}:${row.revision}`,
    Object.freeze({
      actor: row.creator_id,
      targetId: row.id,
      revision: row.revision,
      definitionRevision: row.definition.definitionRevision,
      contentVersion: row.definition.contentVersion,
      appliedTargetRevision: row.definition.appliedTargetRevision,
      regionId: row.region_id,
      categoryId: row.category_id,
      catalogId,
      ...epochs,
      command: command ? Object.freeze({ ...command }) : null,
    }),
  );
}
