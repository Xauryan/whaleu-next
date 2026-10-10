import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CampusContentScopeFacade } from '../../campus/content-scope.facade.js';
import { ApplicationError } from '../../http/application-error.js';
import { optionalCountMediaStep } from '../../database/count-proof.js';
import {
  MediaContentSnapshotFacade,
  UnavailableMediaContentSnapshotFacade,
  mediaContentKey,
} from '../../media/content-snapshot.facade.js';
import type {
  MediaContentFact,
  MediaContentReference,
} from '../../media/content-snapshot.facade.js';
import { SafetyContentVisibilityFacade } from '../../safety/content-visibility.facade.js';
import type { Decision } from '../community-policy.js';
import type {
  StoredComment,
  StoredPost,
  StoredReply,
} from '../community.repository.js';
import type { LikedCandidate } from '../liked/repository.js';
import {
  validateApprovalBinding,
  validateApprovalRow,
} from './approval-validation.js';
import type { ContentKind } from './contracts.js';
import {
  ContentReviewCountRepository,
  COUNT_SNAPSHOT_BATCH,
  contentKey,
} from './count-snapshot.repository.js';
import type { CountReviewSnapshot } from './count-snapshot.repository.js';
import {
  definitionMatchesApproval,
  definitionNodeDecision,
  definitionScopeDecision,
  reconstructDefinition,
} from './definition-validation.js';
import type {
  CurrentContent,
  DefinitionPost,
} from './definition-validation.js';

export {
  COUNT_SNAPSHOT_BATCH,
  COUNT_SNAPSHOT_BYTES,
  COUNT_SNAPSHOT_NODES,
} from './count-snapshot.repository.js';
export type CountSnapshotDecision = 'allow' | 'deny' | 'unknown';
export interface CountSnapshotFact {
  mediaRequired?: true;
  decision: CountSnapshotDecision;
  optionalUntil: number | null;
  post: Pick<
    StoredPost,
    'id' | 'account_id' | 'author_mode' | 'category' | 'space_id'
  > | null;
  listing: { subtype: string; resolution: string } | null;
}
export interface CountSnapshotBatch {
  /** Only image dependencies reached in canonical short-circuit order. */
  mediaRequired: boolean;
  facts: Map<string, CountSnapshotFact>;
  dependencies: {
    contentIds: string[];
    spaceIds: string[];
    namedAccountIds: string[];
  };
  optionalUntil: number | null;
}
interface ConditionalDecision {
  mediaRequired?: true;
  decision: CountSnapshotDecision;
  optionalUntil: number | null;
}
const unknown = (): ConditionalDecision => ({
  decision: 'unknown',
  optionalUntil: null,
});
const denied = (): ConditionalDecision => ({
  decision: 'deny',
  optionalUntil: null,
});
const allowed = (): ConditionalDecision => ({
  decision: 'allow',
  optionalUntil: null,
});
const minimum = (...values: (number | null)[]): number | null => {
  const finite = values.filter((value): value is number => value !== null);
  return finite.length ? Math.min(...finite) : null;
};
function conditional(
  decision: Decision<unknown>,
  optionalUntil: number | null = null,
): ConditionalDecision {
  return {
    decision: decision.kind === 'unavailable' ? 'unknown' : decision.kind,
    optionalUntil,
  };
}
function then(
  first: ConditionalDecision,
  next: () => ConditionalDecision,
): ConditionalDecision {
  if (first.decision !== 'allow') return first;
  const second = next();
  return {
    ...second,
    ...(first.mediaRequired || second.mediaRequired
      ? { mediaRequired: true as const }
      : {}),
    optionalUntil: minimum(first.optionalUntil, second.optionalUntil),
  };
}
function publicFact(
  result: ConditionalDecision,
  post: DefinitionPost | undefined,
  snapshot: CountReviewSnapshot,
): CountSnapshotFact {
  const listing = post ? snapshot.listings.get(post.id) : undefined;
  return {
    ...result,
    post: post
      ? {
          id: post.id,
          account_id: post.account_id,
          author_mode: post.author_mode,
          category: post.category,
          space_id: post.space_id,
        }
      : null,
    listing: listing
      ? { subtype: listing.subtype, resolution: listing.resolution! }
      : null,
  };
}
/** Batch-local pure evaluator of the same composed, short-circuit scalar policy.
 * No publication authority, author lifecycle, profile privacy or addressed-reply
 * visibility is added to an already-authorized discovery request. */
class SnapshotEvaluator {
  private readonly baseCache = new Map<string, ConditionalDecision>();
  readonly mediaRequests = new Map<string, MediaContentReference>();
  constructor(
    private readonly snapshot: CountReviewSnapshot,
    private readonly regions: Map<string, boolean>,
    private readonly media: ReadonlyMap<string, MediaContentFact> = new Map(),
  ) {}
  private regionActive(post: DefinitionPost): boolean {
    const space = this.snapshot.spaces.get(post.space_id);
    return (
      !space?.operating_region_id ||
      this.regions.get(space.operating_region_id) === true
    );
  }
  private definition(
    kind: ContentKind,
    id: string,
    scope: Parameters<typeof reconstructDefinition>[4],
  ): Decision<CurrentContent> {
    const { posts, roots, replies, spaces } = this.snapshot;
    const reference =
      kind === 'post'
        ? posts.get(id)
        : kind === 'comment'
          ? roots.get(id)
          : replies.get(id);
    if (!reference) return { kind: 'deny', reason: 'POST_NOT_FOUND' };
    const post =
      kind === 'post'
        ? (reference as DefinitionPost)
        : posts.get((reference as StoredComment).post_id);
    const postDecision = definitionNodeDecision(post, true);
    if (postDecision.kind !== 'allow') return postDecision;
    if (!post) return { kind: 'unavailable' };
    const scopeDecision = definitionScopeDecision(
      spaces.get(post.space_id),
      scope,
      this.regionActive(post),
    );
    if (scopeDecision.kind !== 'allow') return scopeDecision;
    let content: StoredPost | StoredComment | StoredReply = post;
    let rootId: string | null = null;
    const parents: CurrentContent['parents'] = [];
    if (kind !== 'post') {
      rootId =
        kind === 'comment' ? id : (reference as StoredReply).root_comment_id;
      const root = roots.get(rootId);
      const rootDecision = definitionNodeDecision(
        root?.post_id === post.id ? root : undefined,
      );
      if (rootDecision.kind !== 'allow') return rootDecision;
      if (!root) return { kind: 'unavailable' };
      content = root;
      parents.push({ kind: 'post', id: post.id });
      if (kind === 'reply') {
        const reply = replies.get(id);
        const replyDecision = definitionNodeDecision(
          reply?.post_id === post.id && reply.root_comment_id === root.id
            ? reply
            : undefined,
        );
        if (replyDecision.kind !== 'allow') return replyDecision;
        if (!reply) return { kind: 'unavailable' };
        content = reply;
        parents.push({ kind: 'comment', id: root.id });
      }
    }
    const poll = kind === 'post' ? this.snapshot.polls.get(id) : undefined;
    const formation =
      kind === 'post' ? this.snapshot.formations.get(id) : undefined;
    return reconstructDefinition(kind, post, content, rootId, scope, parents, {
      images: this.snapshot.images.get(contentKey(kind, id)) ?? [],
      poll,
      formation,
      listing: kind === 'post' ? this.snapshot.listings.get(id) : undefined,
      options: poll ? (this.snapshot.options.get(poll.id) ?? []) : [],
      creators: formation
        ? (this.snapshot.creators.get(formation.id) ?? [])
        : [],
    });
  }
  base(kind: ContentKind, id: string): ConditionalDecision {
    const key = contentKey(kind, id),
      cached = this.baseCache.get(key);
    if (cached) return cached;
    // Content's ancestry is structurally bounded to post/root/reply; the cache
    // sentinel also fails closed against unexpected cyclic/cross-kind input.
    this.baseCache.set(key, unknown());
    let result = unknown();
    const binding = this.snapshot.bindings.get(key);
    if (binding) {
      try {
        const reviewed = validateApprovalRow(
          this.snapshot.approvals.get(binding.decision_id) ?? null,
          false,
          this.snapshot.now,
        );
        const accepted = validateApprovalBinding(binding, reviewed.decision);
        result = conditional(accepted, reviewed.optionalUntil);
        if (accepted.kind === 'allow') {
          const stored = this.definition(
            kind,
            id,
            accepted.value.envelope.scope,
          );
          result = then(result, () => conditional(stored));
          if (stored.kind === 'allow') {
            const images = stored.value.envelope.images;
            if (images.length) {
              const reference: MediaContentReference = {
                parent: {
                  ownerKind: 'community',
                  resourceKind: kind,
                  resourceId: id,
                  contentVersion: 1,
                },
                expected: images,
              };
              const mediaKey = mediaContentKey(reference.parent);
              this.mediaRequests.set(mediaKey, reference);
              result = then(result, () => {
                const fact = this.media.get(mediaKey);
                return {
                  decision: fact?.decision ?? 'unknown',
                  optionalUntil: fact?.validUntil ?? null,
                  mediaRequired: true,
                };
              });
            }
            result = then(result, () =>
              definitionMatchesApproval(
                stored.value,
                accepted.value,
                images.length > 0,
              )
                ? allowed()
                : unknown(),
            );
            for (const parent of stored.value.parents)
              result = then(result, () => this.base(parent.kind, parent.id));
          }
        }
      } catch {
        result = unknown();
      }
    }
    this.baseCache.set(key, result);
    return result;
  }
  beforeRelationship(kind: ContentKind, id: string): ConditionalDecision {
    const content =
      kind === 'post'
        ? this.snapshot.posts.get(id)
        : kind === 'comment'
          ? this.snapshot.roots.get(id)
          : this.snapshot.replies.get(id);
    // CommunityAccessService.visibilityDecision denies every non-approved state
    // before consulting review, unlike the definition-only leaf evaluator.
    if (!content || content.visibility !== 'approved' || content.deleted_at)
      return denied();
    if (kind === 'post') {
      const post = content as DefinitionPost,
        space = this.snapshot.spaces.get(post.space_id);
      // accessiblePost maps missing/inactive space/region to POST_NOT_FOUND.
      if (!space?.is_active || !this.regionActive(post)) return denied();
    }
    let result = this.base(kind, id);
    result = then(result, () => {
      const binding = this.snapshot.bindings.get(contentKey(kind, id));
      if (
        !binding ||
        binding.envelope.authorMode !== content.author_mode ||
        (content.author_mode === 'named' &&
          binding.account_id !== content.account_id)
      )
        return unknown();
      return allowed();
    });
    return result;
  }
}
/** Conditional, nonlocking count facts only. The caller must capture and finally
 * validate all participating owner epochs/fences and optional horizons under
 * READ COMMITTED before publishing a total. This is NOT the locked page port. */
@Injectable()
export class ContentReviewCountFacade {
  constructor(
    @Inject(ContentReviewCountRepository)
    private readonly records: ContentReviewCountRepository,
    @Inject(CampusContentScopeFacade)
    private readonly campuses: CampusContentScopeFacade,
    @Inject(SafetyContentVisibilityFacade)
    private readonly safety: SafetyContentVisibilityFacade,
    @Inject(MediaContentSnapshotFacade)
    private readonly media: MediaContentSnapshotFacade = new UnavailableMediaContentSnapshotFacade(),
  ) {}
  private async prepare(
    snapshot: CountReviewSnapshot,
    viewer: string | null,
    tx: PoolClient,
    managed?: PoolClient,
  ) {
    const regions = await this.campuses.readRegionsBatch(
      [
        ...new Set(
          [...snapshot.spaces.values()].flatMap((space) =>
            space.operating_region_id ? [space.operating_region_id] : [],
          ),
        ),
      ],
      tx,
    );
    let evaluator = new SnapshotEvaluator(snapshot, regions);
    // Probe canonical gates first. Earlier Review/structure denial never gains
    // an artificial Media dependency, and all image requests are batch-local.
    for (const post of snapshot.posts.values())
      evaluator.beforeRelationship('post', post.id);
    for (const root of snapshot.roots.values())
      evaluator.beforeRelationship('comment', root.id);
    for (const reply of snapshot.replies.values())
      evaluator.beforeRelationship('reply', reply.id);
    if (evaluator.mediaRequests.size) {
      let media: ReadonlyMap<string, MediaContentFact>;
      try {
        const readMedia = () =>
          this.media.readBatch(
            [...evaluator.mediaRequests.values()],
            tx,
            snapshot.budget,
          );
        // Prefetch alone is not a dependency: e.g. a removed liked membership
        // can deny before any image is consumed. Recover SQL failures with the
        // real managed client, then let canonical evaluation consume unknowns.
        media =
          (managed
            ? await optionalCountMediaStep(managed, readMedia)
            : await readMedia()) ?? new Map();
      } catch (error) {
        // Optional source errors unwind the runner's savepoint, never the
        // independently authorized page. Do not swallow integrity failures.
        if (
          (error instanceof ApplicationError &&
            error.code === 'MEDIA_UNAVAILABLE') ||
          (typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            ['42P01', '42703', '3F000'].includes(String(error.code)))
        )
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        throw error;
      }
      evaluator = new SnapshotEvaluator(snapshot, regions, media);
    }
    const before = new Map<string, ConditionalDecision>();
    const named: string[] = [];
    const collect = (
      kind: ContentKind,
      content: StoredPost | StoredComment,
    ) => {
      const result = evaluator.beforeRelationship(kind, content.id);
      before.set(contentKey(kind, content.id), result);
      if (
        result.decision === 'allow' &&
        content.author_mode === 'named' &&
        viewer &&
        content.account_id !== viewer
      )
        named.push(content.account_id);
    };
    for (const post of snapshot.posts.values()) collect('post', post);
    for (const root of snapshot.roots.values()) collect('comment', root);
    for (const reply of snapshot.replies.values()) collect('reply', reply);
    const safety = await this.safety.checkBatch(viewer, named, tx);
    snapshot.dependencies.namedAccountIds = safety.namedAccountIds;
    const direct = (kind: ContentKind, id: string): ConditionalDecision => {
      const first = before.get(contentKey(kind, id)) ?? denied();
      return then(first, () => {
        const content =
          kind === 'post'
            ? snapshot.posts.get(id)
            : kind === 'comment'
              ? snapshot.roots.get(id)
              : snapshot.replies.get(id);
        if (!content) return denied();
        if (
          content.author_mode === 'anonymous' ||
          !viewer ||
          content.account_id === viewer
        )
          return allowed();
        return safety.facts.get(content.account_id) ?? unknown();
      });
    };
    return direct;
  }
  async evaluatePosts(
    ids: readonly string[],
    viewer: string | null,
    tx: PoolClient,
    managed?: PoolClient,
  ): Promise<CountSnapshotBatch> {
    if (ids.length > COUNT_SNAPSHOT_BATCH)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const snapshot = await this.records.read(
      { posts: [...ids], roots: [], replies: [] },
      tx,
    );
    const direct = await this.prepare(snapshot, viewer, tx, managed),
      facts = new Map<string, CountSnapshotFact>();
    for (const id of ids)
      facts.set(
        id,
        publicFact(direct('post', id), snapshot.posts.get(id), snapshot),
      );
    return {
      facts,
      mediaRequired: [...facts.values()].some(
        (fact) => fact.mediaRequired === true,
      ),
      dependencies: snapshot.dependencies,
      optionalUntil: minimum(
        ...[...facts.values()].map((fact) => fact.optionalUntil),
      ),
    };
  }
  async evaluateLiked(
    candidates: readonly LikedCandidate[],
    viewer: string,
    tx: PoolClient,
    managed?: PoolClient,
  ): Promise<CountSnapshotBatch> {
    if (candidates.length > COUNT_SNAPSHOT_BATCH)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const snapshot = await this.records.read(
      {
        posts: candidates.map((row) => row.post_id),
        roots: candidates.flatMap((row) =>
          row.root_comment_id ? [row.root_comment_id] : [],
        ),
        replies: candidates
          .filter((row) => row.kind === 'reply')
          .map((row) => row.target_id),
      },
      tx,
    );
    const current = await this.records.memberships(
      candidates,
      viewer,
      tx,
      snapshot.budget,
    );
    const direct = await this.prepare(snapshot, viewer, tx, managed),
      facts = new Map<string, CountSnapshotFact>();
    for (const candidate of candidates) {
      const membership = current.get(
        contentKey(candidate.kind, candidate.target_id),
      );
      let result = membership ? direct('post', candidate.post_id) : denied();
      result = then(result, () => {
        if (candidate.kind === 'post')
          return candidate.target_id === candidate.post_id &&
            candidate.root_comment_id === null
            ? allowed()
            : unknown();
        const root = candidate.root_comment_id
          ? snapshot.roots.get(candidate.root_comment_id)
          : undefined;
        if (
          !root ||
          root.post_id !== candidate.post_id ||
          (candidate.kind === 'comment' && root.id !== candidate.target_id)
        )
          return unknown();
        return direct('comment', root.id);
      });
      if (candidate.kind === 'reply')
        result = then(result, () => {
          const reply = snapshot.replies.get(candidate.target_id);
          if (
            !reply ||
            reply.post_id !== candidate.post_id ||
            reply.root_comment_id !== candidate.root_comment_id
          )
            return unknown();
          return direct('reply', reply.id);
        });
      result = then(result, () =>
        membership &&
        membership.like_id === candidate.like_id &&
        (membership.liked_at?.getTime() ?? null) ===
          (candidate.liked_at?.getTime() ?? null)
          ? allowed()
          : unknown(),
      );
      facts.set(
        `${candidate.kind}:${candidate.like_id}`,
        publicFact(result, snapshot.posts.get(candidate.post_id), snapshot),
      );
    }
    return {
      facts,
      mediaRequired: [...facts.values()].some(
        (fact) => fact.mediaRequired === true,
      ),
      dependencies: snapshot.dependencies,
      optionalUntil: minimum(
        ...[...facts.values()].map((fact) => fact.optionalUntil),
      ),
    };
  }
}
