import { Inject, Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  checkpointTransactionDeadlines,
  registerOptionalTransactionDeadline,
  registerOptionalTransactionProof,
  restoreTransactionDeadlines,
} from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { APP_CONFIG } from '../config/config.js';
import type { RuntimeConfig } from '../config/config.js';
import { ContentReviewCountFacade } from './content-review/count-snapshot.facade.js';
import { captureCountProof } from './count-proof.js';
import { fenceSmallCommunityCount } from './small-count-fence.js';
import { fenceSmallSafetyContentCount } from '../safety/content-count-fence.js';
import { fenceSmallCampusContentCount } from '../campus/content-count-fence.js';
import { LikedHistoryRepository } from './liked/repository.js';
import type { LikedCandidate } from './liked/repository.js';
import type { LikedAnchor } from './liked/cursor.js';
import { compareLikedAnchors, likedAnchorSchema } from './liked/cursor.js';
import type { TradingSubtype } from './trading/contracts.js';

export const DISCOVERY_COUNT_BATCH = 256;
/** No history-size ceiling. An optional attempt has a finite elapsed budget. */
export const DISCOVERY_COUNT_BUDGET_MS = 1500;
const MAX_CONCURRENT_COUNTS = 2;
const COUNT_SOURCE_STATEMENT_MS = 100;
export const SMALL_COUNT_PROOF_CANDIDATES = 1024;
export const SMALL_COUNT_PROOF_BUDGET_MS = 500;
interface CountScanResult {
  value: number;
  candidates: number;
}

export type CurrentDiscoveryCount =
  | {
      status: 'known';
      value: number;
      optionalUntil: number | null;
      /** Internal proof only; never spread this object into a wire DTO. */
      proof?: (() => Promise<boolean>) | undefined;
    }
  | {
      status: 'unavailable';
      value: null;
      optionalUntil: null;
    };
export type PublicCountKind = 'posts' | 'trading';
const postPositionSchema = z.strictObject({
  id: z.uuid(),
  scan_at: z.iso.datetime({ precision: 6 }),
});
type PostPosition = z.infer<typeof postPositionSchema>;
interface TimeoutSettings {
  statement_timeout: string;
  lock_timeout: string;
  work_mem: string;
}

class OptionalCountUnavailable extends Error {}

const unavailable = (): CurrentDiscoveryCount => ({
  status: 'unavailable',
  value: null,
  optionalUntil: null,
});

function likedPosition(candidate: LikedCandidate): LikedAnchor {
  let at: string | null = null;
  if (candidate.liked_at !== null) {
    if (
      !(candidate.liked_at instanceof Date) ||
      !Number.isFinite(candidate.liked_at.getTime()) ||
      candidate.liked_at.getUTCFullYear() < 1 ||
      candidate.liked_at.getUTCFullYear() > 9999
    )
      throw new OptionalCountUnavailable();
    at = candidate.liked_at.toISOString();
  }
  const parsed = likedAnchorSchema.safeParse({
    targetKind: candidate.kind,
    at,
    id: candidate.like_id,
  });
  if (!parsed.success) throw new OptionalCountUnavailable();
  return parsed.data;
}

/** Bind only to a still-private result; final proof failure never changes pages. */
export function bindDiscoveryCount(
  tx: PoolClient,
  count: CurrentDiscoveryCount,
  invalidate: () => void,
): void {
  if (count.status !== 'known') return;
  if (count.proof)
    registerOptionalTransactionProof(tx, {
      validate: count.proof,
      invalidate,
      get until() {
        return count.optionalUntil;
      },
    });
  else registerOptionalTransactionDeadline(tx, count.optionalUntil, invalidate);
}

function optionalFailure(error: unknown): boolean {
  if (error instanceof OptionalCountUnavailable) return true;
  if (error instanceof ApplicationError)
    return error.code === 'COMMUNITY_UNAVAILABLE';
  // These are recoverable only inside this optional operation's savepoint.
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error.code === '57014' || error.code === '55P03' || error.code === '53400')
  );
}

function configuredTimeout(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/.exec(value);
  const units: Record<string, number> = {
    ms: 1,
    s: 1000,
    min: 60000,
    h: 3600000,
    d: 86400000,
  };
  const result = match ? Number(match[1]) * units[match[2] ?? 'ms']! : NaN;
  if (!Number.isFinite(result)) throw new OptionalCountUnavailable();
  return result === 0 ? Infinity : result;
}

/** Every source statement gets the remaining monotonic budget, rather than a
 * fresh whole timeout per query/batch. Only snapshot facades receive this client;
 * required policy and finalization keep the original managed client identity. */
function budgetedClient(
  tx: PoolClient,
  expires: number,
  statementLimit: number,
  lockLimit: number,
): PoolClient {
  let appliedStatement: number | null = null;
  let appliedLock: number | null = null;
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property !== 'query') return Reflect.get(target, property, receiver);
      return async (text: string, values?: unknown[]) => {
        const remaining = Math.floor(expires - performance.now());
        if (remaining <= 0) throw new OptionalCountUnavailable();
        const statement = Math.min(
          remaining,
          statementLimit,
          COUNT_SOURCE_STATEMENT_MS,
        );
        const lock = Math.min(remaining, lockLimit, 25);
        // A fixed short timeout already below the remaining allowance needs no
        // redundant configuration roundtrip. Tighten it as the total budget ends.
        if (statement !== appliedStatement || lock !== appliedLock) {
          await target.query(
            "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
            [`${statement}ms`, `${lock}ms`],
          );
          appliedStatement = statement;
          appliedLock = lock;
        }
        if (performance.now() >= expires) throw new OptionalCountUnavailable();
        return target.query(text, values);
      };
    },
  });
}

/** Streaming exact optional counts. Only bounded batch facts survive each loop;
 * global completeness comes from the owner mutation proof, never row locks. */
@Injectable()
export class CommunityDiscoveryCounts {
  private active = 0;
  private readonly maxConcurrent: number;

  constructor(
    @Inject(ContentReviewCountFacade)
    private readonly facts: ContentReviewCountFacade,
    @Inject(LikedHistoryRepository)
    private readonly likes: LikedHistoryRepository,
    @Inject(APP_CONFIG) config: Pick<RuntimeConfig, 'PG_POOL_MAX'>,
  ) {
    // Leave at least one connection available for mandatory/non-count work.
    // A one-connection deployment keeps pages but has no optional scan capacity.
    this.maxConcurrent = Math.min(
      MAX_CONCURRENT_COUNTS,
      Math.max(0, config.PG_POOL_MAX - 1),
    );
  }

  private async attempt(
    tx: PoolClient,
    scan: (
      read: PoolClient,
      includeUntil: (until: number | null) => void,
      maxCandidates: number,
    ) => Promise<CountScanResult>,
    budgetMs: number,
  ): Promise<CurrentDiscoveryCount> {
    if (
      this.active >= this.maxConcurrent ||
      !Number.isFinite(budgetMs) ||
      budgetMs <= 0
    )
      return unavailable();
    this.active++;
    const baseline = checkpointTransactionDeadlines(tx);
    const expires = performance.now() + budgetMs;
    let savepoint = false;
    try {
      await tx.query('SAVEPOINT discovery_optional_count');
      savepoint = true;
      const settings = (
        await tx.query<TimeoutSettings>(
          `SELECT current_setting('statement_timeout') AS statement_timeout,
           current_setting('lock_timeout') AS lock_timeout,current_setting('work_mem') AS work_mem`,
        )
      ).rows[0];
      if (!settings) throw new OptionalCountUnavailable();
      const statementLimit = configuredTimeout(settings.statement_timeout);
      const lockLimit = configuredTimeout(settings.lock_timeout);
      await tx.query(
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true),set_config('work_mem',CASE WHEN pg_size_bytes(current_setting('work_mem'))>4194304 THEN '4MB' ELSE current_setting('work_mem') END,true)",
        [
          `${Math.max(1, Math.min(statementLimit, COUNT_SOURCE_STATEMENT_MS, Math.floor(expires - performance.now())))}ms`,
          `${Math.min(lockLimit, 25)}ms`,
        ],
      );
      const read = budgetedClient(tx, expires, statementLimit, lockLimit);
      const proof = await captureCountProof(tx, read);
      let optionalUntil: number | null = null;
      const includeUntil = (until: number | null) => {
        if (until === null) return;
        if (!Number.isFinite(until)) throw new OptionalCountUnavailable();
        optionalUntil = Math.min(optionalUntil ?? Infinity, until);
        proof?.includeUntil(until);
      };
      const scanned = await scan(
        read,
        includeUntil,
        proof ? Infinity : SMALL_COUNT_PROOF_CANDIDATES,
      );
      const value = scanned.value;
      if (
        performance.now() >= expires ||
        !Number.isSafeInteger(value) ||
        value < 0
      )
        throw new OptionalCountUnavailable();
      await tx.query(
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true),set_config('work_mem',$3,true)",
        [settings.statement_timeout, settings.lock_timeout, settings.work_mem],
      );
      restoreTransactionDeadlines(tx, baseline);
      await tx.query('RELEASE SAVEPOINT discovery_optional_count');
      savepoint = false;
      const count: CurrentDiscoveryCount = {
        status: 'known',
        value,
        optionalUntil,
        proof: async () => {
          if (proof && (await proof.validate(tx))) return true;
          if (
            scanned.candidates > SMALL_COUNT_PROOF_CANDIDATES ||
            this.active >= this.maxConcurrent
          )
            return false;
          this.active++;
          // Independent bounded proof for the formerly supported small set.
          // Unrelated committed churn does not discard exact small counts. All
          // source fences are final-only/NOWAIT; no locking scalar path follows.
          const finalExpires = performance.now() + SMALL_COUNT_PROOF_BUDGET_MS;
          const finalRead = budgetedClient(tx, finalExpires, 100, 1);
          try {
            await fenceSmallCommunityCount(finalRead);
            await fenceSmallSafetyContentCount(finalRead);
            await fenceSmallCampusContentCount(finalRead);
            const current = await scan(
              finalRead,
              (until) => {
                includeUntil(until);
                count.optionalUntil = optionalUntil;
              },
              SMALL_COUNT_PROOF_CANDIDATES,
            );
            return performance.now() < finalExpires && current.value === value;
          } catch (error) {
            if (optionalFailure(error)) return false;
            throw error;
          } finally {
            this.active--;
          }
        },
      };
      return count;
    } catch (error) {
      if (!optionalFailure(error)) throw error;
      if (savepoint) {
        // A failed rollback/release must escape and fail the whole transaction.
        await tx.query('ROLLBACK TO SAVEPOINT discovery_optional_count');
        await tx.query('RELEASE SAVEPOINT discovery_optional_count');
        restoreTransactionDeadlines(tx, baseline);
      }
      return unavailable();
    } finally {
      this.active--;
    }
  }

  profile(
    owner: string,
    viewer: string | null,
    kind: PublicCountKind,
    tx: PoolClient,
    subtype?: TradingSubtype,
    budgetMs = DISCOVERY_COUNT_BUDGET_MS,
  ): Promise<CurrentDiscoveryCount> {
    return this.attempt(
      tx,
      async (read, includeUntil, maxCandidates) => {
        let after: PostPosition | null = null;
        let value = 0;
        let seen = 0;
        for (;;) {
          const candidates: PostPosition[] = (
            await read.query<PostPosition>(
              `SELECT id,CASE WHEN isfinite(published_at)
                 AND EXTRACT(YEAR FROM published_at AT TIME ZONE 'UTC') BETWEEN 1 AND 9999
                 THEN to_char(published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS scan_at
               FROM whaleu_community.posts
               WHERE account_id=$1 AND author_mode='named' AND visibility='approved' AND deleted_at IS NULL
               AND (category='trading')=$2
               ${after ? 'AND (published_at,id)<($3::timestamptz,$4::uuid)' : ''}
               ORDER BY published_at DESC,id DESC LIMIT ${DISCOVERY_COUNT_BATCH + 1}`,
              after
                ? [owner, kind === 'trading', after.scan_at, after.id]
                : [owner, kind === 'trading'],
            )
          ).rows;
          // Unsupported/nonfinite historical coordinates are uncertainty, never
          // a NULL tuple seek that accidentally reports complete exhaustion.
          if (
            candidates.some(
              (candidate) => !postPositionSchema.safeParse(candidate).success,
            )
          )
            throw new OptionalCountUnavailable();
          const current = candidates.slice(0, DISCOVERY_COUNT_BATCH);
          seen += current.length;
          if (seen > maxCandidates) throw new OptionalCountUnavailable();
          if (current.length) {
            const batch = await this.facts.evaluatePosts(
              current.map((item) => item.id),
              viewer,
              read,
            );
            includeUntil(batch.optionalUntil);
            for (const candidate of current) {
              const fact = batch.facts.get(candidate.id);
              if (!fact || fact.decision === 'unknown')
                throw new OptionalCountUnavailable();
              includeUntil(fact.optionalUntil);
              if (fact.decision === 'deny') continue;
              if (
                !fact.post ||
                fact.post.account_id !== owner ||
                fact.post.author_mode !== 'named' ||
                (fact.post.category === 'trading') !== (kind === 'trading')
              )
                throw new OptionalCountUnavailable();
              // Canonical visibility must precede resolution/subtype filtering.
              if (kind === 'trading') {
                if (!fact.listing) throw new OptionalCountUnavailable();
                if (
                  fact.listing.resolution !== 'open' ||
                  (subtype !== undefined && fact.listing.subtype !== subtype)
                )
                  continue;
              }
              value++;
              if (!Number.isSafeInteger(value))
                throw new OptionalCountUnavailable();
            }
          }
          if (candidates.length <= DISCOVERY_COUNT_BATCH)
            return { value, candidates: seen };
          if (seen >= maxCandidates) throw new OptionalCountUnavailable();
          const next = current.at(-1)!;
          if (
            after &&
            !(
              next.scan_at < after.scan_at ||
              (next.scan_at === after.scan_at && next.id < after.id)
            )
          )
            throw new OptionalCountUnavailable();
          after = next;
        }
      },
      budgetMs,
    );
  }

  liked(
    owner: string,
    tx: PoolClient,
    budgetMs = DISCOVERY_COUNT_BUDGET_MS,
  ): Promise<CurrentDiscoveryCount> {
    return this.attempt(
      tx,
      async (read, includeUntil, maxCandidates) => {
        let after: LikedAnchor | null = null;
        let value = 0;
        let seen = 0;
        for (;;) {
          const candidates = await this.likes.candidates(
            owner,
            after,
            DISCOVERY_COUNT_BATCH + 1,
            read,
          );
          // Unsupported historical dates affect only this optional traversal;
          // never let Date.toISOString throw through a separately valid page.
          for (const candidate of candidates) likedPosition(candidate);
          const current = candidates.slice(0, DISCOVERY_COUNT_BATCH);
          seen += current.length;
          if (seen > maxCandidates) throw new OptionalCountUnavailable();
          if (current.length) {
            const batch = await this.facts.evaluateLiked(current, owner, read);
            includeUntil(batch.optionalUntil);
            for (const candidate of current) {
              const fact = batch.facts.get(
                `${candidate.kind}:${candidate.like_id}`,
              );
              if (!fact || fact.decision === 'unknown')
                throw new OptionalCountUnavailable();
              includeUntil(fact.optionalUntil);
              if (fact.decision === 'allow') value++;
              if (!Number.isSafeInteger(value))
                throw new OptionalCountUnavailable();
            }
          }
          if (candidates.length <= DISCOVERY_COUNT_BATCH)
            return { value, candidates: seen };
          if (seen >= maxCandidates) throw new OptionalCountUnavailable();
          const last = current.at(-1)!;
          const next = likedPosition(last);
          if (after && compareLikedAnchors(next, after) <= 0)
            throw new OptionalCountUnavailable();
          after = next;
        }
      },
      budgetMs,
    );
  }
}
