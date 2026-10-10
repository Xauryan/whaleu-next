import { retainRatingReadBytes } from '../target-cover-current.js';
import { RatingCompatReadFacade } from '../scoped/compat-read.facade.js';
import { Inject, Injectable } from '@nestjs/common';
import { RatingCategoryContentReviewFacade } from '../../community/content-review/rating-category-content-review.facade.js';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { ratingPublicIdSchema, ratingSummarySchema } from '../contracts.js';
import type { RatingSummary } from '../contracts.js';
import { ratingIso, qualifyRatingCategoryRows } from '../repository.js';
import type {
  CategoryRow,
  RatingCatalog,
  CurrentTargetRow,
} from '../repository.js';
import {
  currentRatingTargetRow,
  ratingCurrentTargetColumns,
  ratingCurrentTargetDefinitionJoins,
  type CurrentTargetRead,
} from '../target-definition.repository.js';
import type { AnyRatingTargetDefinitionDescriptor } from '../../community/content-review/rating-target-definition-contracts.js';

/** Whole-request admission, independent of the unchanged per-item proof limits. */
export const RATING_COMPLETE_POOL_BATCH_SIZE = 128;
export const RATING_COMPLETE_POOL_TARGET_LIMIT = 10_000;
export const RATING_COMPLETE_POOL_PATH_LIMIT = 50_000;
export const RATING_COMPLETE_POOL_SCOPE_LIMIT = 201;
export const RATING_COMPLETE_POOL_BYTE_LIMIT = 64 * 1024 * 1024;
export const RATING_COMPLETE_POOL_PREPARATION_MS = 15_000;

declare const poolHandleBrand: unique symbol;
export interface RatingCompletePoolHandle {
  readonly [poolHandleBrand]: true;
}
export interface RatingPoolTargetPath {
  readonly id: string;
  readonly envelope: unknown;
  readonly definition: AnyRatingTargetDefinitionDescriptor;
  readonly row: CurrentTargetRow;
  readonly catalog: RatingCatalog;
  readonly summary: RatingSummary;
}
export interface RatingCompletePoolBatch {
  readonly items: readonly RatingPoolTargetPath[];
  readonly done: boolean;
}
interface PoolState {
  tx: PoolClient;
  readEpoch: object;
  epoch: string;
  expires: number;
  catalogs: readonly RatingCatalog[];
  categoryId: string | null;
  prepared: boolean;
  completed: boolean;
  done: boolean;
  busy: boolean;
  afterCatalog: string | null;
  afterTarget: string | null;
  paths: number;
  bytes: number;
  targets: Set<string>;
  streamKey: object;
  nextOrdinal: number;
  preciseUntil: string | null;
  categoryEligibility: Map<string, boolean>;
  statementTimeout: string;
  lockTimeout: string;
}
const handles = new WeakMap<RatingCompletePoolHandle, PoolState>();
const activeHandles = new WeakMap<PoolClient, RatingCompletePoolHandle>();
const batches = new WeakMap<
  RatingCompletePoolBatch,
  { state: PoolState; ordinal: number }
>();
function unavailable(): never {
  throw new ApplicationError('RATING_UNAVAILABLE');
}
function assertState(state: PoolState | undefined, tx: PoolClient): PoolState {
  if (
    !state ||
    state.tx !== tx ||
    transactionReadEpoch(tx) !== state.readEpoch ||
    performance.now() >= state.expires
  )
    unavailable();
  return state;
}
/** Review accepts only an immutable batch produced by this Ratings owner in
 * this transaction/read lifetime. A spread/copied object is not a certificate. */
export function assertRatingCompletePoolBatch(
  batch: RatingCompletePoolBatch,
  tx: PoolClient,
): Readonly<{ streamKey: object; ordinal: number }> {
  const issued = batches.get(batch);
  const state = assertState(issued?.state, tx);
  return Object.freeze({
    streamKey: state.streamKey,
    ordinal: issued!.ordinal,
  });
}
function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
function timeoutMilliseconds(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/.exec(value);
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    min: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  if (!match) unavailable();
  const result = Number(match[1]) * units[match[2] ?? 'ms']!;
  if (!Number.isFinite(result)) unavailable();
  return result;
}
async function prepareTimeout(state: PoolState): Promise<void> {
  assertState(state, state.tx);
  const remaining = Math.floor(state.expires - performance.now());
  if (remaining < 1) unavailable();
  await state.tx.query(
    "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
    [
      `${Math.min(remaining, 2000, timeoutMilliseconds(state.statementTimeout) || 2000)}ms`,
      `${Math.min(remaining, 100, timeoutMilliseconds(state.lockTimeout) || 100)}ms`,
    ],
  );
}
async function poolQuery<T extends QueryResultRow>(
  state: PoolState,
  sql: string,
  values?: unknown[],
): Promise<QueryResult<T>> {
  await prepareTimeout(state);
  try {
    const result = await state.tx.query<T>(sql, values);
    assertState(state, state.tx);
    return result;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('RATING_UNAVAILABLE');
  }
}
async function readPoolEpoch(tx: PoolClient): Promise<string> {
  const rows = (
    await tx.query<{ singleton: boolean; version: number; epoch: string }>(
      'SELECT singleton,version,epoch::text FROM whaleu_ratings.random_pool_epoch',
    )
  ).rows;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.singleton !== true ||
    row.version !== 1 ||
    !/^(0|[1-9][0-9]*)$/.test(row.epoch) ||
    BigInt(row.epoch) > 9223372036854775807n
  )
    unavailable();
  return row.epoch;
}
interface PoolFact {
  readonly handle: RatingCompletePoolHandle;
  readonly epoch: string;
  readonly readEpoch: object;
  readonly expires: number;
}
const proof: RequiredTransactionProof<PoolFact> = {
  maximumFacts: 1,
  failureCode: 'RATING_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_UNAVAILABLE', async (read) => {
      if (
        facts.length !== 1 ||
        facts[0]!.readEpoch !== transactionReadEpoch(tx) ||
        performance.now() >= facts[0]!.expires
      )
        unavailable();
      const state = assertState(handles.get(facts[0]!.handle), tx);
      if (!state.prepared || !state.done || !state.completed || state.busy)
        unavailable();
      // Writers take ROW EXCLUSIVE on this fixed one-row owner epoch before any
      // business-row mutation. No business read/lock occurs after this fence.
      await read.query(
        'LOCK TABLE whaleu_ratings.random_pool_epoch IN SHARE MODE NOWAIT',
      );
      if (
        (await readPoolEpoch(read)) !== facts[0]!.epoch ||
        performance.now() >= facts[0]!.expires
      )
        unavailable();
    }),
};

interface CatalogRead {
  ordinal: number;
  id: string | null;
  region_id: string | null;
  valid: boolean;
  precise_until: string | null;
}
interface AncestorRead extends CategoryRow {
  catalog_id: string;
}
interface PathRead {
  catalog_id: string;
  category_id: string;
  target_id: string;
  valid_path: boolean;
  target: CurrentTargetRead | null;
  summary: Record<string, unknown> | null;
}
/** Same fresh-zero/source/creation causal definition and pure summary schema as
 * RatingsRepository.summary(). The epoch replaces O(N) row-lock/fact retention. */
export function ratingCompletePoolSummary(
  row: Record<string, unknown> | null,
): RatingSummary {
  if (!row) return { status: 'unavailable' };
  const count = Number(row['count']),
    sum = Number(row['sum']);
  return ratingSummarySchema.parse({
    status: 'known',
    count,
    sum,
    average: count === 0 ? null : Math.round((sum * 10) / count) / 10,
    distribution: {
      '1': Number(row['b1']),
      '2': Number(row['b2']),
      '3': Number(row['b3']),
      '4': Number(row['b4']),
      '5': Number(row['b5']),
    },
    revision: row['revision'],
  });
}

@Injectable()
export class RatingCompletePoolRepository {
  constructor(
    @Inject(RatingCategoryContentReviewFacade)
    private readonly categoryReview: RatingCategoryContentReviewFacade = new RatingCategoryContentReviewFacade(),
    @Inject(RatingCompatReadFacade)
    private readonly compat?: RatingCompatReadFacade,
  ) {}
  /** Capture before resolving catalog/category/membership/score inputs. */
  async capture(tx: PoolClient): Promise<RatingCompletePoolHandle> {
    const readEpoch = transactionReadEpoch(tx);
    if (!readEpoch) unavailable();
    const existing = activeHandles.get(tx);
    if (existing && handles.get(existing)?.readEpoch === readEpoch)
      unavailable();
    enableRequiredTransactionProof(tx, proof);
    const settings = (
      await tx.query<{
        isolation: string;
        statement_timeout: string;
        lock_timeout: string;
        now: Date;
      }>(
        "SELECT current_setting('transaction_isolation') isolation,current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout,clock_timestamp() now",
      )
    ).rows[0];
    if (
      settings?.isolation !== 'read committed' ||
      !(settings.now instanceof Date) ||
      !Number.isFinite(settings.now.getTime())
    )
      unavailable();
    registerTransactionDeadline(
      tx,
      settings.now.getTime() + RATING_COMPLETE_POOL_PREPARATION_MS,
      'RATING_UNAVAILABLE',
    );
    const expires = performance.now() + RATING_COMPLETE_POOL_PREPARATION_MS;
    timeoutMilliseconds(settings.statement_timeout);
    timeoutMilliseconds(settings.lock_timeout);
    const handle = Object.freeze({}) as RatingCompletePoolHandle;
    const state: PoolState = {
      tx,
      readEpoch,
      epoch: '',
      expires,
      catalogs: [],
      categoryId: null,
      prepared: false,
      completed: false,
      done: false,
      busy: false,
      afterCatalog: null,
      afterTarget: null,
      paths: 0,
      bytes: 0,
      targets: new Set(),
      streamKey: Object.freeze({}),
      nextOrdinal: 0,
      preciseUntil: null,
      categoryEligibility: new Map(),
      statementTimeout: settings.statement_timeout,
      lockTimeout: settings.lock_timeout,
    };
    await prepareTimeout(state);
    state.epoch = await readPoolEpoch(tx);
    assertState(state, tx);
    registerRequiredTransactionFact(
      tx,
      proof,
      `pool:${state.epoch}`,
      Object.freeze({ handle, epoch: state.epoch, readEpoch, expires }),
    );
    handles.set(handle, state);
    activeHandles.set(tx, handle);
    return handle;
  }

  /** Regions must already have been admitted by Campus and Access owners.
   * A missing catalog stays an explicit unknown through this LEFT JOIN. */
  async prepare(
    handle: RatingCompletePoolHandle,
    regionIds: readonly (string | null)[],
    categoryId: string,
    tx: PoolClient,
  ): Promise<void> {
    const state = assertState(handles.get(handle), tx);
    if (
      state.prepared ||
      state.busy ||
      !regionIds.length ||
      regionIds.length > RATING_COMPLETE_POOL_SCOPE_LIMIT ||
      new Set(regionIds).size !== regionIds.length ||
      !ratingPublicIdSchema.safeParse(categoryId).success ||
      regionIds.some(
        (id) => id !== null && !ratingPublicIdSchema.safeParse(id).success,
      )
    )
      unavailable();
    state.busy = true;
    try {
      const rows = (
        await poolQuery<CatalogRead>(
          state,
          `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now),scopes AS
          (SELECT region_id,ordinal::integer FROM unnest($1::uuid[]) WITH ORDINALITY s(region_id,ordinal))
         SELECT s.ordinal,c.id,c.region_id,${ratingIso('least(c.valid_until,whaleu_ratings.category_catalog_compat_until(c.id))')} precise_until,
          coalesce(c.region_id IS NOT DISTINCT FROM s.region_id AND h.region_id IS NOT DISTINCT FROM s.region_id
          AND whaleu_ratings.category_catalog_compat_current(c.id)
          AND c.sealed AND c.coverage='complete' AND c.provenance='accepted'
          AND isfinite(c.effective_at) AND c.effective_at<=instant.now
          AND (c.valid_until IS NULL OR (isfinite(c.valid_until) AND c.valid_until>instant.now)),false) valid
         FROM scopes s LEFT JOIN whaleu_ratings.catalog_heads h ON h.scope_key=coalesce(s.region_id::text,'global')
         LEFT JOIN whaleu_ratings.catalogs c ON c.id=h.catalog_id CROSS JOIN instant ORDER BY s.ordinal`,
          [regionIds],
        )
      ).rows;
      assertState(state, tx);
      if (
        rows.length !== regionIds.length ||
        rows.some(
          (row, i) =>
            row.ordinal !== i + 1 ||
            !row.valid ||
            !ratingPublicIdSchema.safeParse(row.id).success ||
            row.region_id !== regionIds[i],
        )
      )
        unavailable();
      for (const row of rows) {
        if (row.precise_until !== null) {
          const until = Date.parse(row.precise_until);
          if (!Number.isFinite(until)) unavailable();
          // Downward millisecond rounding is conservative; SQL above evaluates
          // exact microsecond lower/upper bounds at one materialized instant.
          registerTransactionDeadline(tx, until, 'RATING_UNAVAILABLE');
          if (
            state.preciseUntil === null ||
            row.precise_until < state.preciseUntil
          )
            state.preciseUntil = row.precise_until;
        }
      }
      const catalogs = rows.map((row) =>
        Object.freeze({ id: row.id!, regionId: row.region_id }),
      );
      const ancestors = (
        await poolQuery<AncestorRead>(
          state,
          `WITH RECURSIVE path AS (
          SELECT c.*,1 depth FROM whaleu_ratings.categories c WHERE c.catalog_id=ANY($1::uuid[]) AND c.id=$2
          UNION ALL SELECT c.*,p.depth+1 FROM whaleu_ratings.categories c JOIN path p
            ON c.catalog_id=p.catalog_id AND c.id=p.parent_id WHERE p.depth<3)
         SELECT *,ordinal::text FROM path ORDER BY catalog_id,level`,
          [catalogs.map((catalog) => catalog.id), categoryId],
        )
      ).rows;
      assertState(state, tx);
      if (ancestors.length > catalogs.length * 3) unavailable();
      const admitted: RatingCatalog[] = [];
      for (const catalog of catalogs) {
        const path = ancestors.filter((row) => row.catalog_id === catalog.id);
        // Authoritative absence or a hidden/inactive ancestor is a known deny.
        if (!path.length || path.some((row) => !row.active || row.hidden))
          continue;
        const leaf = path.at(-1)!;
        if (
          leaf.id !== categoryId ||
          path.length !== leaf.level ||
          path.some(
            (row, i) =>
              row.level !== i + 1 ||
              !ratingPublicIdSchema.safeParse(row.id).success ||
              (i === 0
                ? row.parent_id !== null
                : row.parent_id !== path[i - 1]!.id),
          )
        )
          unavailable();
        const decisions = await qualifyRatingCategoryRows(
          this.categoryReview,
          catalog,
          path,
          tx,
          this.compat,
        );
        const allowed = decisions.every((decision) => decision === 'allow');
        state.categoryEligibility.set(`${catalog.id}:${categoryId}`, allowed);
        if (allowed) admitted.push(catalog);
      }
      if (!admitted.length) throw new ApplicationError('RATING_NOT_FOUND');
      state.catalogs = Object.freeze(
        admitted.sort((a, b) => a.id.localeCompare(b.id)),
      );
      state.categoryId = categoryId;
      state.prepared = true;
    } finally {
      state.busy = false;
    }
  }

  async next(
    handle: RatingCompletePoolHandle,
    tx: PoolClient,
  ): Promise<RatingCompletePoolBatch> {
    const state = assertState(handles.get(handle), tx);
    if (!state.prepared || state.done || state.busy) unavailable();
    state.busy = true;
    try {
      const rows = (
        await poolQuery<PathRead>(
          state,
          `WITH RECURSIVE instant AS MATERIALIZED (SELECT clock_timestamp() now),tree AS (
          SELECT c.catalog_id,c.id,c.level,1 depth,true valid_path FROM whaleu_ratings.categories c
            WHERE c.catalog_id=ANY($1::uuid[]) AND c.id=$2 AND c.active AND NOT c.hidden
          UNION ALL SELECT c.catalog_id,c.id,c.level,p.depth+1,p.valid_path AND c.level=p.level+1
            FROM whaleu_ratings.categories c JOIN tree p ON c.catalog_id=p.catalog_id AND c.parent_id=p.id
            WHERE p.depth<3 AND c.active AND NOT c.hidden
        ), paths AS MATERIALIZED (
          SELECT m.catalog_id,m.category_id,m.target_id,c.valid_path
          FROM tree c JOIN whaleu_ratings.target_memberships m ON m.catalog_id=c.catalog_id AND m.category_id=c.id
          WHERE ($3::uuid IS NULL OR (m.catalog_id,m.target_id)>($3::uuid,$4::uuid))
          ORDER BY m.catalog_id,m.target_id LIMIT $5
        ) SELECT p.*,to_jsonb(current_target) target,q.summary FROM paths p
        LEFT JOIN whaleu_ratings.targets t ON t.id=p.target_id
        ${ratingCurrentTargetDefinitionJoins}
        LEFT JOIN LATERAL (SELECT ${ratingCurrentTargetColumns}) current_target ON t.id IS NOT NULL
        LEFT JOIN LATERAL (
          SELECT to_jsonb(s) summary FROM whaleu_ratings.score_summaries s
          JOIN whaleu_ratings.score_baselines b ON b.target_id=s.target_id
          JOIN whaleu_ratings.target_sources o ON o.id=b.source_id AND o.target_id=b.target_id
          JOIN whaleu_ratings.target_creations c ON c.target_id=b.target_id CROSS JOIN instant
          WHERE s.target_id=p.target_id AND b.kind='fresh_zero' AND o.origin='new_native'
            AND o.coverage='complete' AND o.provenance='accepted' AND o.effective_at<=instant.now
            AND b.creation_transaction=c.creation_transaction AND c.source_id=o.id
        ) q ON true ORDER BY p.catalog_id,p.target_id`,
          [
            state.catalogs.map((catalog) => catalog.id),
            state.categoryId,
            state.afterCatalog,
            state.afterTarget,
            RATING_COMPLETE_POOL_BATCH_SIZE,
          ],
        )
      ).rows;
      assertState(state, tx);
      if (rows.length > RATING_COMPLETE_POOL_BATCH_SIZE) unavailable();
      // Validate the full category ancestry for every scanned path before any
      // sampling. Results are immutable-source cached within this owner epoch;
      // revoking an unselected category still invalidates the whole draw.
      for (const catalog of state.catalogs) {
        const missing = [
          ...new Set(
            rows
              .filter(
                (path) =>
                  path.catalog_id === catalog.id &&
                  !state.categoryEligibility.has(
                    `${catalog.id}:${path.category_id}`,
                  ),
              )
              .map((path) => path.category_id),
          ),
        ];
        if (!missing.length) continue;
        const categoryRows = (
          await poolQuery<AncestorRead & { leaf_id: string }>(
            state,
            `WITH RECURSIVE path AS (
          SELECT c.*,c.id leaf_id,1 depth FROM whaleu_ratings.categories c WHERE c.catalog_id=$1 AND c.id=ANY($2::uuid[])
          UNION ALL SELECT c.*,p.leaf_id,p.depth+1 FROM whaleu_ratings.categories c JOIN path p ON c.catalog_id=p.catalog_id AND c.id=p.parent_id WHERE p.depth<3)
          SELECT *,ordinal::text FROM path ORDER BY leaf_id,level`,
            [catalog.id, missing],
          )
        ).rows;
        const unique = [
          ...new Map(categoryRows.map((row) => [row.id, row])).values(),
        ];
        state.bytes += Buffer.byteLength(JSON.stringify(categoryRows), 'utf8');
        retainRatingReadBytes(tx, categoryRows);
        if (
          categoryRows.length > missing.length * 3 ||
          state.bytes > RATING_COMPLETE_POOL_BYTE_LIMIT
        )
          unavailable();
        const decisions = await qualifyRatingCategoryRows(
          this.categoryReview,
          catalog,
          unique,
          tx,
          this.compat,
        );
        const byId = new Map(
          unique.map((row, index) => [row.id, decisions[index]]),
        );
        for (const id of missing) {
          const path = categoryRows.filter((row) => row.leaf_id === id),
            leaf = path.at(-1);
          if (
            !leaf ||
            leaf.id !== id ||
            path.length !== leaf.level ||
            path.some(
              (row, index) =>
                row.level !== index + 1 ||
                (index === 0
                  ? row.parent_id !== null
                  : row.parent_id !== path[index - 1]!.id),
            )
          )
            unavailable();
          state.categoryEligibility.set(
            `${catalog.id}:${id}`,
            path.every(
              (row) =>
                row.active && !row.hidden && byId.get(row.id) === 'allow',
            ),
          );
        }
      }
      const items: RatingPoolTargetPath[] = [];
      for (const path of rows) {
        const catalog = state.catalogs.find(
          (item) => item.id === path.catalog_id,
        );
        const current = path.target;
        if (
          !catalog ||
          !path.valid_path ||
          !current ||
          current.id !== path.target_id ||
          current.category_id !== path.category_id ||
          (current.region_id !== null &&
            current.region_id !== catalog.regionId) ||
          typeof current.active !== 'boolean' ||
          typeof current.owner_deleted !== 'boolean'
        )
          unavailable();
        if (
          state.afterCatalog !== null &&
          (path.catalog_id < state.afterCatalog ||
            (path.catalog_id === state.afterCatalog &&
              path.target_id <= state.afterTarget!))
        )
          unavailable();
        state.afterCatalog = path.catalog_id;
        state.afterTarget = path.target_id;
        state.paths++;
        state.targets.add(current.id);
        state.bytes += Buffer.byteLength(JSON.stringify(path), 'utf8');
        retainRatingReadBytes(tx, path);
        if (
          state.paths > RATING_COMPLETE_POOL_PATH_LIMIT ||
          state.targets.size > RATING_COMPLETE_POOL_TARGET_LIMIT ||
          state.bytes > RATING_COMPLETE_POOL_BYTE_LIMIT
        )
          unavailable();
        if (
          !current.active ||
          current.owner_deleted ||
          state.categoryEligibility.get(`${catalog.id}:${path.category_id}`) !==
            true
        )
          continue;
        const row = currentRatingTargetRow(current);
        const summary = ratingCompletePoolSummary(path.summary);
        items.push(
          freezeTree({
            id: row.id,
            envelope: row.envelope,
            definition: row.definition,
            row,
            catalog,
            summary,
          }),
        );
      }
      state.done = rows.length < RATING_COMPLETE_POOL_BATCH_SIZE;
      const batch = Object.freeze({
        items: Object.freeze(items),
        done: state.done,
      });
      batches.set(batch, { state, ordinal: state.nextOrdinal++ });
      return batch;
    } finally {
      state.busy = false;
    }
  }

  /** Pre-sample completeness/equality check. The final registered owner proof
   * separately rejects in-flight writers and fences new writes through commit. */
  async complete(
    handle: RatingCompletePoolHandle,
    tx: PoolClient,
  ): Promise<void> {
    const state = assertState(handles.get(handle), tx);
    if (!state.prepared || !state.done || state.busy) unavailable();
    await prepareTimeout(state);
    if ((await readPoolEpoch(tx)) !== state.epoch) unavailable();
    const current = (
      await poolQuery<{ valid: boolean }>(
        state,
        'SELECT ($1::timestamptz IS NULL OR $1::timestamptz>clock_timestamp()) valid',
        [state.preciseUntil],
      )
    ).rows[0];
    if (current?.valid !== true) unavailable();
    await tx.query(
      "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
      [state.statementTimeout, state.lockTimeout],
    );
    assertState(state, tx);
    state.completed = true;
  }
}
