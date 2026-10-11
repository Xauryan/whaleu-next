import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  transactionReadEpoch,
  type RequiredTransactionProof,
} from '../../database/transaction-deadlines.js';

function unavailable(): never {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
}
async function epoch(tx: PoolClient) {
  const rows = (
    await tx.query<{ epoch: string; version: number }>(
      'SELECT epoch::text,version FROM whaleu_ratings.category_icon_epoch WHERE singleton',
    )
  ).rows;
  if (
    rows.length !== 1 ||
    rows[0]!.version !== 1 ||
    !/^(0|[1-9][0-9]*)$/.test(rows[0]!.epoch)
  )
    unavailable();
  return rows[0]!.epoch;
}
async function snapshot(keys: readonly string[], tx: PoolClient) {
  const state = (
    await tx.query<{ state: unknown }>(
      `SELECT jsonb_build_object(
 'epoch',(SELECT epoch::text FROM whaleu_ratings.category_icon_epoch WHERE singleton AND version=1),
 'heads',whaleu_ratings.scoped_head_tuples($1::text[]),
 'extensions',(SELECT coalesce(jsonb_agg(jsonb_build_object('scopeKey',h.scope_key,'releaseId',h.release_id,'digest',m.digest,'rows',m.row_count) ORDER BY h.scope_key),'[]'::jsonb)
 FROM whaleu_ratings.scoped_catalog_heads h LEFT JOIN whaleu_ratings.category_icon_release_manifests m ON m.release_id=h.release_id WHERE h.scope_key=ANY($1::text[]))) state`,
      [keys],
    )
  ).rows[0]?.state;
  if (state === undefined) unavailable();
  return ownerFingerprint(state);
}
async function fence(tx: PoolClient) {
  await tx.query(
    'LOCK TABLE whaleu_ratings.category_icon_epoch IN ROW SHARE MODE NOWAIT',
  );
  await tx.query(
    'SELECT epoch FROM whaleu_ratings.category_icon_epoch WHERE singleton FOR SHARE NOWAIT',
  );
  await tx.query(
    'LOCK TABLE whaleu_ratings.scoped_catalog_heads IN SHARE MODE NOWAIT',
  );
}
interface ReadFact {
  readonly keys: readonly string[];
  readonly fingerprint: string;
}
const readProof: RequiredTransactionProof<ReadFact> = {
  maximumFacts: 1001,
  failureCode: 'RATING_SCOPE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_SCOPE_UNAVAILABLE', async (read) => {
      await fence(read);
      for (const fact of facts)
        if (fact.fingerprint !== (await snapshot(fact.keys, read)))
          unavailable();
    }),
};
const mutationBrand: unique symbol = Symbol('category-icon-mutation');
export interface CategoryIconMutation {
  readonly [mutationBrand]: true;
}
interface MutationState {
  readonly tx: PoolClient;
  readonly epoch: object;
  readonly keys: Set<string>;
  phase: 'collecting' | 'finished';
  fingerprint: string | null;
  target?: {
    actor: string;
    request: string;
    hash: string;
    operation: 'create_target_scoped' | 'edit_target_scoped';
    scopeKeys: readonly string[];
    publication: string | null;
  };
}
const active = new WeakMap<PoolClient, MutationState>();
const issued = new WeakMap<CategoryIconMutation, MutationState>();
const mutationProof: RequiredTransactionProof<MutationState> = {
  maximumFacts: 8,
  failureCode: 'RATING_SCOPE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_SCOPE_UNAVAILABLE', async (read) => {
      await fence(read);
      for (const fact of facts)
        if (
          fact.tx !== tx ||
          fact.epoch !== transactionReadEpoch(tx) ||
          fact.phase !== 'finished' ||
          fact.fingerprint !== (await snapshot([...fact.keys].sort(), read))
        )
          unavailable();
    }),
};
/** Invoke after the original owner locks and before reading mutable icon inputs.
 * A rollback changes transactionReadEpoch, invalidating every issued capability.
 * This collector never clears or overwrites an earlier independently read fact. */
export async function beginCategoryIconMutation(
  tx: PoolClient,
): Promise<CategoryIconMutation> {
  const readEpoch = transactionReadEpoch(tx),
    previous = active.get(tx);
  if (!readEpoch || previous?.epoch === readEpoch) unavailable();
  await tx.query(
    'LOCK TABLE whaleu_ratings.category_icon_epoch IN ROW EXCLUSIVE MODE',
  );
  await tx.query(
    'SELECT epoch FROM whaleu_ratings.category_icon_epoch WHERE singleton FOR UPDATE NOWAIT',
  );
  await epoch(tx);
  const state: MutationState = {
    tx,
    epoch: readEpoch,
    keys: new Set(),
    phase: 'collecting',
    fingerprint: null,
  };
  const capability = Object.freeze({ [mutationBrand]: true as const });
  active.set(tx, state);
  issued.set(capability, state);
  enableRequiredTransactionProof(tx, mutationProof);
  registerRequiredTransactionFact(
    tx,
    mutationProof,
    `category-icon-mutation:${randomUUID()}`,
    state,
  );
  return capability;
}
export async function retainCategoryIconState(
  keys: readonly string[],
  tx: PoolClient,
): Promise<void> {
  const exact = [...new Set(keys)].sort();
  if (!exact.length || exact.length > 1001 || exact.length !== keys.length)
    unavailable();
  const state = active.get(tx);
  if (state && state.epoch === transactionReadEpoch(tx)) {
    if (state.phase !== 'collecting') unavailable();
    for (const key of exact) state.keys.add(key);
    if (state.keys.size > 1001) unavailable();
    return;
  }
  enableRequiredTransactionProof(tx, readProof);
  registerRequiredTransactionFact(
    tx,
    readProof,
    exact.join('\n'),
    Object.freeze({
      keys: Object.freeze(exact),
      fingerprint: await snapshot(exact, tx),
    }),
  );
}
/** Called only after source/head/definition/review/media/cleanup writes finish. */
export async function finishCategoryIconMutation(
  capability: CategoryIconMutation,
  tx: PoolClient,
): Promise<void> {
  const state = issued.get(capability);
  if (
    !state ||
    state.tx !== tx ||
    state.epoch !== transactionReadEpoch(tx) ||
    state.phase !== 'collecting' ||
    !state.keys.size ||
    (state.target?.operation === 'create_target_scoped' &&
      state.target.publication === null)
  )
    unavailable();
  if (state.target) {
    const target = state.target;
    const exact = (
      await tx.query<{ valid: boolean }>(
        `SELECT EXISTS(
      SELECT 1 FROM whaleu_ratings.scoped_command_causes e
      JOIN whaleu_ratings.scoped_command_preparations p USING(account_id,request_id)
      JOIN whaleu_ratings.scoped_command_outcomes o USING(account_id,request_id)
      JOIN whaleu_ratings.requests q USING(account_id,request_id)
      WHERE e.account_id=$1 AND e.request_id=$2 AND e.cause_kind='execution'
        AND e.mutation_transaction=pg_current_xact_id() AND o.mutation_transaction=pg_current_xact_id()
        AND e.proof->>'intentHash'=$3 AND p.intent_hash=$3 AND o.intent_hash=$3 AND q.intent_hash=$3
        AND p.operation=$4 AND o.operation=$4 AND q.operation=$4
        AND o.outcome IN ('applied','noop') AND q.receipt->>'outcome'=o.outcome
        AND q.receipt->>'intentHash'=$3 AND q.receipt->>'operation'=$4
        AND ($4<>'create_target_scoped' OR (o.outcome='applied' AND EXISTS(
          SELECT 1 FROM whaleu_ratings.scoped_command_causes publication
          WHERE (publication.account_id,publication.request_id)=(e.account_id,e.request_id)
            AND publication.cause_kind='catalog_release' AND publication.artifact_id=$5::uuid
            AND publication.mutation_transaction=pg_current_xact_id())))) valid`,
        [
          target.actor,
          target.request,
          target.hash,
          target.operation,
          target.publication,
        ],
      )
    ).rows[0]?.valid;
    if (exact !== true) unavailable();
  }
  state.fingerprint = await snapshot([...state.keys].sort(), tx);
  state.phase = 'finished';
}

/** The original target execution opts in before its own Category read. This
 * never adopts or removes an already registered independent read obligation. */
export async function beginCategoryIconTargetMutation(
  input: {
    actor: string;
    request: string;
    hash: string;
    operation: 'create_target_scoped' | 'edit_target_scoped';
    scopeKeys: readonly string[];
  },
  tx: PoolClient,
): Promise<CategoryIconMutation> {
  const scopeKeys = [...new Set(input.scopeKeys)].sort();
  if (!scopeKeys.length || scopeKeys.length !== input.scopeKeys.length)
    unavailable();
  const capability = await beginCategoryIconMutation(tx);
  issued.get(capability)!.target = {
    ...input,
    scopeKeys: Object.freeze(scopeKeys),
    publication: null,
  };
  return capability;
}
/** Only the exact original create execution may carry one publication through
 * its pre-read collector. Other publishers still own separate capabilities. */
export async function consumeCategoryIconTargetPublication(
  releaseId: string,
  keys: readonly string[],
  cause: { kind: string; accountId?: string; requestId?: string } | undefined,
  tx: PoolClient,
): Promise<boolean> {
  const state = active.get(tx);
  if (!state || state.epoch !== transactionReadEpoch(tx)) return false;
  const target = state.target;
  if (
    !target ||
    state.phase !== 'collecting' ||
    target.publication !== null ||
    target.operation !== 'create_target_scoped' ||
    cause?.kind !== target.operation ||
    cause.accountId !== target.actor ||
    cause.requestId !== target.request ||
    keys.length !== target.scopeKeys.length ||
    keys.some((key, index) => key !== target.scopeKeys[index])
  )
    unavailable();
  const exact = (
    await tx.query<{ valid: boolean }>(
      `SELECT EXISTS(
    SELECT 1 FROM whaleu_ratings.scoped_command_causes e
    JOIN whaleu_ratings.scoped_command_preparations p ON (p.account_id,p.request_id)=(e.account_id,e.request_id)
    WHERE e.account_id=$1 AND e.request_id=$2 AND e.cause_kind='execution'
      AND e.mutation_transaction=pg_current_xact_id() AND e.proof->>'intentHash'=$3
      AND p.intent_hash=$3 AND p.operation=$4) valid`,
      [target.actor, target.request, target.hash, target.operation],
    )
  ).rows[0]?.valid;
  if (exact !== true) unavailable();
  target.publication = releaseId;
  return true;
}
