import { retainRatingReadBytes } from '../target-cover-current.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { RatingCategoryManagementAuthorityFacade } from '../../authorization/rating-category-management.facade.js';
import { CampusRatingScopedContextFacade } from '../../campus/rating-scoped-context.facade.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  transactionReadEpoch,
  type RequiredTransactionProof,
} from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import type { CategoryIconMediaAssetRepository } from '../../media/category-icon-asset-repository.js';
import {
  CategoryIconRetirementProofRegistry,
  type AuthorizedCategoryIconRetirement,
  type CategoryIconRetirementOwnerPort,
  type CategoryIconRetirementRequest,
} from '../../media/category-icon-retirement-proof.js';
import { RatingsAccessService } from '../access.js';
import { RatingScopedCompilationBudget } from '../scoped/compiler.js';
import { scopedDigest, scopedId } from '../scoped/contracts.js';
import type { CategoryIconPlan } from './icon-plan.js';
import {
  beginCategoryIconMutation,
  finishCategoryIconMutation,
  retainCategoryIconState,
  type CategoryIconMutation,
} from './icon-proof.js';
import { validateCategoryIconRoots } from './icon-references.js';

const requestSchema = z.strictObject({
  requestId: scopedId,
  appearanceIds: z
    .array(scopedId)
    .min(1)
    .max(100000)
    .refine((ids) => new Set(ids).size === ids.length),
});
const rowSchema = z.strictObject({
  appearance_id: scopedId,
  asset_id: scopedId,
  binding_id: scopedId,
  actor_id: scopedId,
  manifest_digest: scopedDigest,
  scope_keys: z
    .array(
      z.union([
        z.literal('global'),
        z.string().regex(/^campus:[0-9a-f-]{36}$/),
      ]),
    )
    .min(1)
    .max(1001)
    .refine((keys) =>
      keys.every((key, index) => index === 0 || keys[index - 1]! < key),
    ),
  global_required: z.boolean(),
  retired: z.boolean(),
  blocker: z
    .enum([
      'recoverable_root',
      'unresolved_root',
      'prepared_command',
      'delivery',
      'worker',
      'retention',
      'unknown',
    ])
    .nullable(),
});
type RetirementRow = z.infer<typeof rowSchema>;
export interface CategoryIconRetirementStatus {
  readonly appearanceId: string;
  readonly state: 'eligible' | 'held' | 'retired';
}
interface ClosureFact {
  readonly tx: PoolClient;
  readonly epoch: object;
  readonly actor: string;
  readonly request: CategoryIconRetirementRequest;
  readonly closureRevision: string;
  readonly mutation: CategoryIconMutation | null;
  readonly expected: readonly CategoryIconRetirementStatus[];
  finished: boolean;
}
function unavailable(): never {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
}
function request(
  raw: CategoryIconRetirementRequest,
): CategoryIconRetirementRequest {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) unavailable();
  return Object.freeze({
    requestId: parsed.data.requestId,
    appearanceIds: Object.freeze([...parsed.data.appearanceIds].sort()),
  });
}
function status(
  rows: readonly RetirementRow[],
): readonly CategoryIconRetirementStatus[] {
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        appearanceId: row.appearance_id,
        state: row.retired
          ? 'retired'
          : row.blocker === null
            ? 'eligible'
            : 'held',
      } as const),
    ),
  );
}
/** Original source/Category fences precede every Media mutation. Ordinary hold
 * writers need ROW EXCLUSIVE, so SHARE NOWAIT also covers an empty hold table.
 * Final proof repeats these fences after every deferred constraint wait. */
async function ownerFence(tx: PoolClient, category = true): Promise<void> {
  await tx.query(
    'LOCK TABLE whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch IN ROW SHARE MODE NOWAIT',
  );
  await tx.query(
    'SELECT epoch FROM whaleu_ratings.scoped_source_epoch WHERE singleton FOR SHARE NOWAIT',
  );
  await tx.query(
    'SELECT epoch FROM whaleu_ratings.scope_protocol_epoch WHERE singleton FOR SHARE NOWAIT',
  );
  if (category) {
    await tx.query(
      'LOCK TABLE whaleu_ratings.category_icon_epoch IN ROW SHARE MODE NOWAIT',
    );
    await tx.query(
      'SELECT epoch FROM whaleu_ratings.category_icon_epoch WHERE singleton FOR SHARE NOWAIT',
    );
  }
  await tx.query(`LOCK TABLE whaleu_ratings.scoped_catalog_heads,whaleu_ratings.scoped_source_heads,
    whaleu_ratings.category_icon_definition_heads,whaleu_ratings.category_icon_preparations,
    whaleu_ratings.scoped_command_preparations,whaleu_ratings.scoped_command_outcomes,
    whaleu_ratings.category_icon_delivery_holds,whaleu_ratings.category_icon_retirement_queue IN SHARE MODE NOWAIT`);
}
async function mediaFence(tx: PoolClient): Promise<void> {
  // Final-only nonblocking fences; no intent/job lock-order inversion or storage
  // effects occur in this owner. Media's own final proof remains independently on.
  await tx.query(`LOCK TABLE whaleu_media.upload_intents,whaleu_media.assets,whaleu_media.bindings,
    whaleu_media.jobs,whaleu_media.cleanup_obligations,whaleu_media.object_attempts,
    whaleu_media.derived_object_attempts,whaleu_media.upload_ingress,
    whaleu_media.upload_ingress_writers IN SHARE MODE NOWAIT`);
}
async function rowsFor(
  actor: string,
  exact: CategoryIconRetirementRequest,
  tx: PoolClient,
  finalPhase = false,
  budgetTx: PoolClient = tx,
): Promise<readonly RetirementRow[]> {
  const result = await tx.query(
    `SELECT q.appearance_id,a.asset_id,a.media_binding_id binding_id,a.actor_id,a.manifest_digest,
    whaleu_ratings.category_icon_retirement_scopes(a.id) scope_keys,
    ((SELECT bool_or(other.global_required) FROM whaleu_ratings.category_icon_retirement_queue other WHERE other.appearance_id=a.id)
      OR 'global'=ANY(whaleu_ratings.category_icon_retirement_scopes(a.id))) global_required,
    EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_terminal_retirements t WHERE t.appearance_id=a.id) retired,
    whaleu_ratings.category_icon_retirement_blocker(a.id,$4) blocker
    FROM whaleu_ratings.category_icon_retirement_queue q
    JOIN whaleu_ratings.category_icon_appearances a ON a.id=q.appearance_id
    JOIN whaleu_ratings.scoped_command_outcomes o ON (o.account_id,o.request_id)=(q.causing_actor_id,q.causing_request_id)
    WHERE q.causing_actor_id=$1 AND q.causing_request_id=$2 AND q.appearance_id=ANY($3::uuid[]) AND o.outcome='applied'
    ORDER BY q.appearance_id LIMIT 100001`,
    [actor, exact.requestId, exact.appearanceIds, finalPhase],
  );
  retainRatingReadBytes(budgetTx, result.rows);
  const parsed = z.array(rowSchema).safeParse(result.rows);
  if (
    !parsed.success ||
    parsed.data.length !== exact.appearanceIds.length ||
    parsed.data.some(
      (row, index) => row.appearance_id !== exact.appearanceIds[index],
    )
  )
    unavailable();
  return parsed.data;
}
async function closure(
  actor: string,
  exact: CategoryIconRetirementRequest,
  tx: PoolClient,
): Promise<string> {
  const result = (
    await tx.query<{ revision: string }>(
      'SELECT whaleu_ratings.category_icon_retirement_closure($1,$2,$3::uuid[]) revision',
      [actor, exact.requestId, exact.appearanceIds],
    )
  ).rows;
  if (
    result.length !== 1 ||
    !scopedDigest.safeParse(result[0]?.revision).success
  )
    unavailable();
  return result[0]!.revision;
}

/** Explicit synthetic-DI owner entrypoint. No cron, route or provider is activated.
 * A queued displacement is an obligation to retry, never a terminal candidate.
 * Only the original command actor with current all-of management authority may
 * inspect these minimal statuses or request this exact cleanup. */
@Injectable()
export class RatingCategoryIconRetirementOwner implements CategoryIconRetirementOwnerPort {
  private readonly active = new WeakMap<PoolClient, ClosureFact>();
  private readonly proof: RequiredTransactionProof<ClosureFact> = {
    maximumFacts: 1,
    failureCode: 'RATING_SCOPE_UNAVAILABLE',
    validate: (facts, tx) =>
      boundedOwnerProof(tx, 'RATING_SCOPE_UNAVAILABLE', async (read) => {
        if (facts.length !== 1) unavailable();
        const fact = facts[0]!;
        if (
          fact.tx !== tx ||
          fact.epoch !== transactionReadEpoch(tx) ||
          !fact.finished
        )
          unavailable();
        await ownerFence(read);
        await mediaFence(read);
        if (
          (await closure(fact.actor, fact.request, read)) !==
          fact.closureRevision
        )
          unavailable();
        const current = await rowsFor(
          fact.actor,
          fact.request,
          read,
          fact.mutation !== null,
          tx,
        );
        if (fact.mutation) {
          if (current.some((row) => !row.retired || row.blocker !== null))
            unavailable();
          const finished = (
            await read.query<{ count: number }>(
              `SELECT count(*)::integer count
          FROM whaleu_ratings.category_icon_terminal_retirements t JOIN whaleu_media.bindings b ON b.id=t.binding_id
          WHERE t.causing_actor_id=$1 AND t.causing_request_id=$2 AND t.appearance_id=ANY($3::uuid[])
            AND t.transaction_id=pg_current_xact_id() AND t.closure_revision=$4
            AND b.detached_at IS NOT NULL AND b.detach_reason='ratings-category-icon-terminal-retirement'`,
              [
                fact.actor,
                fact.request.requestId,
                fact.request.appearanceIds,
                fact.closureRevision,
              ],
            )
          ).rows[0];
          if (finished?.count !== fact.request.appearanceIds.length)
            unavailable();
        } else if (
          JSON.stringify(status(current)) !== JSON.stringify(fact.expected)
        )
          unavailable();
      }),
  };
  constructor(
    @Inject(RatingsAccessService) private readonly access: RatingsAccessService,
    @Inject(RatingCategoryManagementAuthorityFacade)
    private readonly authority: RatingCategoryManagementAuthorityFacade,
    @Inject(CampusRatingScopedContextFacade)
    private readonly campus: CampusRatingScopedContextFacade,
  ) {}

  /** Call inside the original owner mutation after applying roots and before its
   * final proof. SQL checks the original applied outcome at deferred commit. */
  async enqueue(plan: CategoryIconPlan, tx: PoolClient): Promise<void> {
    if (!transactionReadEpoch(tx)) unavailable();
    const budget = new RatingScopedCompilationBudget(),
      before = validateCategoryIconRoots(plan.beforeRoots, budget),
      after = validateCategoryIconRoots(plan.afterRoots, budget),
      retained = new Set(
        after.flatMap((root) =>
          root.value.kind === 'image'
            ? [root.value.appearance.appearanceId]
            : [],
        ),
      ),
      displaced = [
        ...new Set(
          before.flatMap((root) =>
            root.value.kind === 'image' &&
            !retained.has(root.value.appearance.appearanceId)
              ? [root.value.appearance.appearanceId]
              : [],
          ),
        ),
      ].sort();
    if (plan.noop && displaced.length) unavailable();
    if (!displaced.length) return;
    await tx.query(
      `INSERT INTO whaleu_ratings.category_icon_retirement_queue
      (appearance_id,causing_actor_id,causing_request_id,plan_digest,scope_keys,global_required)
      SELECT id,$2,$3,$4,$5::text[],$6 FROM unnest($1::uuid[]) id
      ON CONFLICT(appearance_id,causing_actor_id,causing_request_id) DO NOTHING`,
      [
        displaced,
        plan.accountId,
        plan.requestId,
        plan.digest,
        plan.affectedScopeKeys,
        plan.globalRequired,
      ],
    );
  }

  private async load(
    credential: string,
    raw: CategoryIconRetirementRequest,
    tx: PoolClient,
    mutate: boolean,
  ) {
    const exact = request(raw),
      epoch = transactionReadEpoch(tx);
    if (!epoch || !credential || this.active.get(tx)?.epoch === epoch)
      unavailable();
    await tx.query("SET LOCAL statement_timeout='5s'");
    await tx.query("SET LOCAL lock_timeout='100ms'");
    // NOWAIT equivalent for the original Safety writer gate, before any owner
    // rows. Never wait while holding a later Category or Media lock.
    const gate = (
      await tx.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0)) locked",
      )
    ).rows[0];
    if (gate?.locked !== true) unavailable();
    const session = await this.access.authenticate(credential, tx);
    await this.access.requireDeletionActor(session.accountId, tx);
    const grant = await this.authority.resolve(session.accountId, tx);
    await ownerFence(tx, !mutate);
    // Read only internal queue metadata before authorization. No metadata leaves
    // this owner until every original and still-recoverable scope is covered.
    const rows = await rowsFor(session.accountId, exact, tx),
      keys = [...new Set(rows.flatMap((row) => row.scope_keys))].sort();
    if (keys.length > 1001) unavailable();
    this.authority.require(
      grant,
      keys.filter((key) => key !== 'global').map((key) => key.slice(7)),
      rows.some((row) => row.global_required) || keys.includes('global'),
      tx,
    );
    await this.campus.resolveCategoryManagementDomains(
      { accountId: session.accountId },
      keys.map((key) =>
        key === 'global'
          ? { kind: 'global' as const }
          : { kind: 'campus' as const, campusId: key.slice(7) },
      ),
      grant,
      tx,
    );
    const mutation = mutate ? await beginCategoryIconMutation(tx) : null;
    // Re-read after the epoch acquisition. No prepared/hold decision made from
    // an earlier snapshot is promoted into a terminal capability.
    const current = await rowsFor(session.accountId, exact, tx),
      revision = await closure(session.accountId, exact, tx);
    if (JSON.stringify(rows) !== JSON.stringify(current)) unavailable();
    if (mutation) await retainCategoryIconState(keys, tx);
    await this.access.recheck(credential, tx);
    const fact: ClosureFact = {
      tx,
      epoch,
      actor: session.accountId,
      request: exact,
      closureRevision: revision,
      mutation,
      expected: status(current),
      finished: !mutate,
    };
    this.active.set(tx, fact);
    enableRequiredTransactionProof(tx, this.proof);
    registerRequiredTransactionFact(
      tx,
      this.proof,
      'category-icon-retirement',
      fact,
    );
    return { fact, rows: current };
  }

  async inspectRequest(
    credential: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<readonly CategoryIconRetirementStatus[]> {
    if (!scopedId.safeParse(requestId).success) unavailable();
    const session = await this.access.authenticate(credential, tx);
    await this.access.requireDeletionActor(session.accountId, tx);
    const original = (
      await tx.query<{ scope_keys: string[]; global_required: boolean }>(
        `SELECT ip.affected_scope_keys scope_keys,(ip.media_plan->'plan'->>'globalRequired')::boolean global_required
       FROM whaleu_ratings.requests q JOIN whaleu_ratings.category_icon_preparations ip ON (ip.actor_id,ip.request_id)=(q.account_id,q.request_id)
       JOIN whaleu_ratings.scoped_command_outcomes o ON (o.account_id,o.request_id)=(q.account_id,q.request_id)
       WHERE q.account_id=$1 AND q.request_id=$2 AND q.receipt->'protocolVersion'='5'::jsonb AND o.outcome='applied' AND q.receipt->>'outcome'='applied'`,
        [session.accountId, requestId],
      )
    ).rows[0];
    if (!original) unavailable();
    const grant = await this.authority.resolve(session.accountId, tx);
    this.authority.require(
      grant,
      original.scope_keys
        .filter((key) => key !== 'global')
        .map((key) => key.slice(7)),
      original.global_required,
      tx,
    );
    const rows = (
      await tx.query<{ appearance_id: string }>(
        `SELECT appearance_id FROM whaleu_ratings.category_icon_retirement_queue WHERE causing_actor_id=$1 AND causing_request_id=$2 ORDER BY appearance_id LIMIT 100001`,
        [session.accountId, requestId],
      )
    ).rows;
    if (rows.length > 100000) unavailable();
    if (!rows.length) {
      await this.access.recheck(credential, tx);
      return [];
    }
    return this.inspect(
      credential,
      { requestId, appearanceIds: rows.map((row) => row.appearance_id) },
      tx,
    );
  }
  async inspect(
    credential: string,
    raw: CategoryIconRetirementRequest,
    tx: PoolClient,
  ): Promise<readonly CategoryIconRetirementStatus[]> {
    return (await this.load(credential, raw, tx, false)).fact.expected;
  }

  async authorizeTerminalRetirement(
    credential: string,
    raw: CategoryIconRetirementRequest,
    tx: PoolClient,
  ): Promise<AuthorizedCategoryIconRetirement> {
    const { fact, rows } = await this.load(credential, raw, tx, true);
    if (rows.some((row) => row.retired || row.blocker !== null)) unavailable();
    const appearances = Object.freeze(
      rows.map((row) =>
        Object.freeze({
          appearanceId: row.appearance_id,
          assetId: row.asset_id,
          bindingId: row.binding_id,
          actorAccountId: row.actor_id,
          manifestDigest: row.manifest_digest,
        }),
      ),
    );
    await tx.query(
      `INSERT INTO whaleu_ratings.category_icon_terminal_retirements
      (appearance_id,asset_id,binding_id,actor_id,manifest_digest,closure_revision,causing_actor_id,causing_request_id)
      SELECT a.id,a.asset_id,a.media_binding_id,a.actor_id,a.manifest_digest,$4,$1,$2
      FROM whaleu_ratings.category_icon_appearances a WHERE a.id=ANY($3::uuid[]) ORDER BY a.id`,
      [
        fact.actor,
        fact.request.requestId,
        fact.request.appearanceIds,
        fact.closureRevision,
      ],
    );
    return Object.freeze({
      actorAccountId: fact.actor,
      requestId: fact.request.requestId,
      closureRevision: fact.closureRevision,
      kind: 'terminal-no-recoverable-roots',
      appearances,
    });
  }

  /** Must follow Media finish, including durable cleanup staging. Omitting this
   * step, crossing a savepoint rollback or supplying another batch fails commit. */
  async finish(
    raw: CategoryIconRetirementRequest,
    tx: PoolClient,
  ): Promise<void> {
    const exact = request(raw),
      fact = this.active.get(tx);
    if (
      !fact ||
      fact.epoch !== transactionReadEpoch(tx) ||
      !fact.mutation ||
      fact.finished ||
      JSON.stringify(exact) !== JSON.stringify(fact.request)
    )
      unavailable();
    const rows = await rowsFor(fact.actor, fact.request, tx, true);
    if (
      rows.some((row) => !row.retired || row.blocker !== null) ||
      (await closure(fact.actor, fact.request, tx)) !== fact.closureRevision
    )
      unavailable();
    await finishCategoryIconMutation(fact.mutation, tx);
    fact.finished = true;
  }
}

/** Caller runs this in an authenticated managed READ COMMITTED transaction and
 * supplies the SAME registry instance configured on the Media8 asset repository.
 * The result means durable cleanup is staged; it never claims physical deletion. */
export async function retireCategoryIconAppearances(
  owner: RatingCategoryIconRetirementOwner,
  registry: CategoryIconRetirementProofRegistry,
  assets: CategoryIconMediaAssetRepository,
  credential: string,
  raw: CategoryIconRetirementRequest,
  tx: PoolClient,
): Promise<{
  readonly state: 'cleanup_pending';
  readonly appearanceIds: readonly string[];
}> {
  const exact = request(raw),
    proof = await registry.authorize(credential, exact, tx);
  // The registry independently checks the exact caller/transaction epoch tuple.
  // The owner authenticates again only in its original proof, never by upload ID.
  const actor = (
    await tx.query<{ actor_id: string }>(
      `SELECT causing_actor_id actor_id
    FROM whaleu_ratings.category_icon_terminal_retirements WHERE appearance_id=$1 AND causing_request_id=$2
      AND transaction_id=pg_current_xact_id()`,
      [exact.appearanceIds[0], exact.requestId],
    )
  ).rows[0]?.actor_id;
  if (!actor) unavailable();
  const mutation = await assets.prepareCategoryIconMutation(
    actor,
    [],
    proof,
    tx,
  );
  await assets.finishCategoryIconMutation(mutation, tx);
  await owner.finish(exact, tx);
  return Object.freeze({
    state: 'cleanup_pending',
    appearanceIds: exact.appearanceIds,
  });
}
