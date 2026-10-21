import { Inject, Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import {
  OptionalCountRunner,
  OptionalCountUnavailable,
  DISCOVERY_COUNT_BATCH,
  DISCOVERY_COUNT_BUDGET_MS,
  SMALL_COUNT_PROOF_BUDGET_MS,
} from '../../database/optional-count.js';
import type { CurrentOptionalCount } from '../../database/optional-count.js';
import { optionalCountMediaStep } from '../../database/count-proof.js';
import type { CountProofCollector } from '../../database/count-proof.js';
import {
  registerOptionalTransactionProof,
  transactionLifetime,
} from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import { mediaCountProofOwner } from '../../media/required-proof.js';
import { fenceSmallSafetyContentCount } from '../../safety/content-count-fence.js';
import { fenceSmallCampusContentCount } from '../../campus/content-count-fence.js';
import { captureImageAwareCountProof } from '../count-proof.js';
import { fenceSmallCommunityCount } from '../small-count-fence.js';
import { idSchema } from '../contracts.js';
import { ContentReviewCountFacade } from '../content-review/count-snapshot.facade.js';
import type {
  DiscussionCountCandidate,
  DiscussionCountPurpose,
} from '../content-review/count-snapshot.facade.js';

export interface DiscussionCountValues {
  comments: number;
  replies: number;
}
export type CurrentDiscussionCount =
  CurrentOptionalCount<DiscussionCountValues>;
interface Scope {
  expires: number;
  proof: CountProofCollector | null | undefined;
  registered: boolean;
  finalExpires: number;
  entries: {
    count: Extract<CurrentDiscussionCount, { status: 'known' }>;
    invalidate: () => void;
  }[];
}
const validValue = (value: DiscussionCountValues) =>
  Number.isSafeInteger(value.comments) &&
  value.comments >= 0 &&
  Number.isSafeInteger(value.replies) &&
  value.replies >= 0 &&
  Number.isSafeInteger(value.comments + value.replies);

/** Counts are optional, never page eligibility. One transaction shares a 2s
 * monotonic source budget and ONE final owner proof, regardless of feed size.
 * Only 256 canonical candidate facts survive each batch. No raw SQL total is
 * public, and a bounded scan that cannot finish returns null, never a prefix. */
@Injectable()
export class CommunityDiscussionCounts {
  private readonly runner: OptionalCountRunner;
  private readonly scopes = new WeakMap<object, Scope>();
  constructor(
    @Inject(ContentReviewCountFacade)
    private readonly facts: ContentReviewCountFacade,
    @Inject(APP_CONFIG) config: Pick<RuntimeConfig, 'PG_POOL_MAX'>,
  ) {
    this.runner = new OptionalCountRunner(config.PG_POOL_MAX, config);
  }
  private scope(tx: PoolClient): Scope {
    const lifetime = transactionLifetime(tx);
    if (!lifetime) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    let scope = this.scopes.get(lifetime);
    if (!scope) {
      scope = {
        expires: performance.now() + DISCOVERY_COUNT_BUDGET_MS,
        proof: undefined,
        registered: false,
        finalExpires: 0,
        entries: [],
      };
      this.scopes.set(lifetime, scope);
    }
    return scope;
  }
  bind(
    tx: PoolClient,
    count: CurrentDiscussionCount,
    invalidate: () => void,
  ): void {
    if (count.status !== 'known') return;
    const scope = this.scope(tx);
    scope.entries.push({ count, invalidate });
    if (scope.registered) return;
    scope.registered = true;
    registerOptionalTransactionProof(tx, {
      validate: async () => {
        scope.finalExpires = performance.now() + SMALL_COUNT_PROOF_BUDGET_MS;
        // Epoch-supported deployments need one fixed-size final proof for every
        // post/root count in the response. Churn conservatively erases counts.
        if (scope.proof) return scope.proof.validate(tx);
        // The legacy small-source fallback also shares a single final budget.
        // It must never become 500ms per feed item.
        for (const entry of scope.entries) {
          if (
            performance.now() >= scope.finalExpires ||
            !entry.count.proof ||
            !(await entry.count.proof())
          )
            return false;
        }
        return performance.now() < scope.finalExpires;
      },
      invalidate: () => {
        for (const entry of scope.entries) entry.invalidate();
      },
      get until() {
        const deadlines = scope.entries.flatMap(({ count }) =>
          count.optionalUntil === null ? [] : [count.optionalUntil],
        );
        return deadlines.length ? Math.min(...deadlines) : null;
      },
    });
  }
  read(
    postId: string,
    viewer: string | null,
    purpose: DiscussionCountPurpose,
    tx: PoolClient,
    rootId?: string,
  ): Promise<CurrentDiscussionCount> {
    const scope = this.scope(tx);
    let fallback = false,
      mediaFenced = false;
    return this.runner.attempt<DiscussionCountValues>(
      tx,
      async (read, includeUntil, maximum) => {
        const value = { comments: 0, replies: 0 };
        let seen = 0,
          mediaRequired = false;
        for (const kind of (rootId ? ['reply'] : ['comment', 'reply']) as (
          'comment' | 'reply'
        )[]) {
          let after: string | null = null;
          for (;;) {
            const table = kind === 'comment' ? 'root_comments' : 'replies';
            const candidates: DiscussionCountCandidate[] = (
              await read.query<DiscussionCountCandidate>(
                `SELECT '${kind}' AS kind,id,post_id AS "postId",${kind === 'comment' ? 'id' : 'root_comment_id'} AS "rootId"
             FROM whaleu_community.${table}
             WHERE post_id=$1 AND visibility='approved' AND deleted_at IS NULL
             AND ($2::uuid IS NULL OR id>$2::uuid)
             ${rootId ? 'AND root_comment_id=$3::uuid' : ''}
             ORDER BY id LIMIT ${DISCOVERY_COUNT_BATCH + 1}`,
                rootId ? [postId, after, rootId] : [postId, after],
              )
            ).rows;
            if (
              candidates.length > DISCOVERY_COUNT_BATCH + 1 ||
              candidates.some(
                (candidate, index) =>
                  candidate.kind !== kind ||
                  candidate.postId !== postId ||
                  !idSchema.safeParse(candidate.id).success ||
                  !idSchema.safeParse(candidate.rootId).success ||
                  (rootId !== undefined && candidate.rootId !== rootId) ||
                  (kind === 'comment' && candidate.rootId !== candidate.id) ||
                  candidate.id <=
                    (index ? candidates[index - 1]!.id : (after ?? '')),
              )
            ) {
              throw new OptionalCountUnavailable();
            }
            const current = candidates.slice(0, DISCOVERY_COUNT_BATCH);
            seen += current.length;
            if (seen > maximum) throw new OptionalCountUnavailable();
            if (current.length) {
              const batch = await this.facts.evaluateDiscussion(
                current,
                viewer,
                purpose,
                read,
                tx,
              );
              includeUntil(batch.optionalUntil);
              mediaRequired ||= batch.mediaRequired;
              for (const candidate of current) {
                const fact = batch.facts.get(`${kind}:${candidate.id}`);
                if (!fact || fact.decision === 'unknown')
                  throw new OptionalCountUnavailable();
                includeUntil(fact.optionalUntil);
                if (fact.decision === 'allow')
                  value[kind === 'comment' ? 'comments' : 'replies']++;
              }
              if (!validValue(value)) throw new OptionalCountUnavailable();
            }
            if (candidates.length <= DISCOVERY_COUNT_BATCH) break;
            if (seen >= maximum) throw new OptionalCountUnavailable();
            after = current.at(-1)!.id;
          }
        }
        if (mediaRequired) {
          if (fallback) {
            if (!mediaFenced) throw new OptionalCountUnavailable();
          } else scope.proof?.requireMedia();
        }
        return { value, candidates: seen };
      },
      Math.max(0, scope.expires - performance.now()),
      async (managed, read) => {
        if (scope.proof === undefined)
          scope.proof = await captureImageAwareCountProof(managed, read);
        return scope.proof;
      },
      async (read) => {
        await fenceSmallCommunityCount(read);
        await fenceSmallSafetyContentCount(read);
        await fenceSmallCampusContentCount(read);
        mediaFenced =
          (await optionalCountMediaStep(tx, () =>
            mediaCountProofOwner.fence(read),
          )) === true;
        fallback = true;
      },
      {
        valid: validValue,
        equal: (a, b) => a.comments === b.comments && a.replies === b.replies,
        proofBudgetMs: () =>
          Math.max(0, scope.finalExpires - performance.now()),
      },
    );
  }
}
