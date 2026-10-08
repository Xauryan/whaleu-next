import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  registerOptionalTransactionDeadline,
  registerOptionalTransactionProof,
} from '../database/transaction-deadlines.js';
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

import {
  OptionalCountRunner,
  OptionalCountUnavailable,
  DISCOVERY_COUNT_BATCH,
  DISCOVERY_COUNT_BUDGET_MS,
} from '../database/optional-count.js';
import type { CurrentOptionalCount } from '../database/optional-count.js';
export {
  DISCOVERY_COUNT_BATCH,
  DISCOVERY_COUNT_BUDGET_MS,
  SMALL_COUNT_PROOF_CANDIDATES,
  SMALL_COUNT_PROOF_BUDGET_MS,
} from '../database/optional-count.js';
export type CurrentDiscoveryCount = CurrentOptionalCount<number>;
export type PublicCountKind = 'posts' | 'trading';
const postPositionSchema = z.strictObject({
  id: z.uuid(),
  scan_at: z.iso.datetime({ precision: 6 }),
});
type PostPosition = z.infer<typeof postPositionSchema>;
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

/** Streaming exact optional counts. Only bounded batch facts survive each loop;
 * global completeness comes from the owner mutation proof, never row locks. */
@Injectable()
export class CommunityDiscoveryCounts {
  private readonly runner: OptionalCountRunner;

  constructor(
    @Inject(ContentReviewCountFacade)
    private readonly facts: ContentReviewCountFacade,
    @Inject(LikedHistoryRepository)
    private readonly likes: LikedHistoryRepository,
    @Inject(APP_CONFIG) config: Pick<RuntimeConfig, 'PG_POOL_MAX'>,
  ) {
    this.runner = new OptionalCountRunner(config.PG_POOL_MAX, config);
  }

  private attempt(
    tx: PoolClient,
    scan: (
      read: PoolClient,
      includeUntil: (until: number | null) => void,
      maxCandidates: number,
    ) => Promise<{ value: number; candidates: number }>,
    budgetMs: number,
  ): Promise<CurrentDiscoveryCount> {
    return this.runner.attempt<number>(
      tx,
      scan,
      budgetMs,
      captureCountProof,
      async (read) => {
        await fenceSmallCommunityCount(read);
        await fenceSmallSafetyContentCount(read);
        await fenceSmallCampusContentCount(read);
      },
    );
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
