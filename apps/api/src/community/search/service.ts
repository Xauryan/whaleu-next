import { searchPageSchema } from './response-schema.js';
import { categorySchema } from '../contracts.js';
import type { CommunitySpace } from '../contracts.js';
import { CommunityPhoneContinuation } from '../phone-continuation.js';
import { CommunitySearchScopeResolver } from './scope.js';
import type { ResolvedSearchScope } from './scope.js';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { enableSafetyRelationshipProof } from '../../safety/relationship-proof.js';
import { CommunityAccessService } from '../community-access.service.js';
import { SearchHitSerializer } from './serializer.js';
import { tradingSubtypeSchema } from '../trading/contracts.js';
import type { TradingSubtype } from '../trading/contracts.js';
import { CommunityRepository } from '../community.repository.js';
import type { StoredPost, StoredComment } from '../community.repository.js';
import {
  DiscoveryCursorRepository,
  discoveryCursorBucket,
} from '../discovery-cursors.js';
import type {
  SearchPage,
  SearchQuery,
  SearchHit,
  SearchKind,
} from './contracts.js';
import {
  searchAnchorFollows,
  federatedSearchPositionSchema,
  searchCursorScope,
  searchPositionSchema,
  SEARCH_ORDER_ID,
} from './cursor.js';
import type {
  SearchAnchor,
  SearchPosition,
  FederatedSearchPosition,
} from './cursor.js';
import {
  requireSearchMatcherRuntime,
  SEARCH_MATCHER_ID,
  searchMatches,
} from './matching.js';
import {
  SearchRepository,
  SEARCH_SCAN_BATCH,
  searchCandidateSchema,
  searchCandidateKey,
} from './repository.js';
import type { SearchCandidate, SearchStructuralScope } from './repository.js';

@Injectable()
export class SearchService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(SearchHitSerializer)
    private readonly serializer: SearchHitSerializer,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(DiscoveryCursorRepository)
    private readonly cursors: DiscoveryCursorRepository,
    @Inject(SearchRepository) private readonly searches: SearchRepository,
    @Inject(CommunitySearchScopeResolver)
    private readonly scopes: CommunitySearchScopeResolver,
    @Inject(CommunityPhoneContinuation)
    private readonly phones: CommunityPhoneContinuation,
  ) {}

  private async allowed(
    candidate: SearchCandidate,
    scope: SearchStructuralScope,
    actor: string | null,
    tx: PoolClient,
  ): Promise<{
    post: StoredPost;
    content: StoredPost | StoredComment;
    listing: { subtype: TradingSubtype; urgency: 'normal' | 'urgent' } | null;
  } | null> {
    const post = await this.repository.post(candidate.postId, tx);
    if (post.space_id !== candidate.spaceId)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (
      ('spaceId' in scope
        ? post.space_id !== scope.spaceId
        : !(
            (scope.regionalSpaceIds.includes(post.space_id) &&
              categorySchema.safeParse(post.category).success) ||
            (scope.globalSpaceIds.includes(post.space_id) &&
              post.category === 'discussion')
          )) ||
      (scope.category !== null && post.category !== scope.category) ||
      (scope.postId !== null && post.id !== scope.postId) ||
      post.deleted_at !== null ||
      post.visibility !== 'approved'
    )
      return null;
    let listing: {
      subtype: TradingSubtype;
      urgency: 'normal' | 'urgent';
    } | null = null;
    if (post.category === 'trading') {
      const facts = await this.searches.tradingFilter(post.id, tx);
      if (
        !facts ||
        !['normal', 'urgent'].includes(facts.urgency) ||
        !tradingSubtypeSchema.safeParse(facts.subtype).success
      )
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      listing = {
        subtype: tradingSubtypeSchema.parse(facts.subtype),
        urgency: facts.urgency,
      };
      if (
        (scope.tradingSubtype !== null &&
          listing.subtype !== scope.tradingSubtype) ||
        (scope.excludeUrgentTrading && listing.urgency === 'urgent')
      )
        return null;
    } else if (scope.tradingSubtype !== null) return null;
    // Posts retain list semantics; children require authenticated direct parent
    // visibility, then each independently named ancestry node's list proof.
    if (candidate.kind !== 'post' && actor === null)
      throw new ApplicationError('AUTHENTICATION_REQUIRED');
    if (
      !(await this.access.visible(
        actor,
        post,
        tx,
        candidate.kind === 'post' ? 'list_projection' : 'direct_post',
      ))
    )
      return null;
    if (candidate.kind === 'post') return { post, content: post, listing };
    const root = await this.repository.comment(
      candidate.rootCommentId!,
      tx,
      true,
    );
    if (root.post_id !== post.id)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (!(await this.access.visible(actor, root, tx, 'list_projection')))
      return null;
    if (candidate.kind === 'comment') return { post, content: root, listing };
    const reply = await this.repository.reply(candidate.id, tx, true);
    if (reply.post_id !== post.id || reply.root_comment_id !== root.id)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (!(await this.access.visible(actor, reply, tx, 'list_projection')))
      return null;
    // Target reply identities and bodies are deliberately never loaded.
    return { post, content: reply, listing };
  }

  private validateCandidates(
    candidates: SearchCandidate[],
    after: SearchAnchor | null,
    scope: SearchStructuralScope,
  ): void {
    if (candidates.length > SEARCH_SCAN_BATCH + 1)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    let previous = after;
    for (const candidate of candidates) {
      if (
        !searchCandidateSchema.safeParse(candidate).success ||
        !scope.types.includes(candidate.kind) ||
        (scope.from !== null && candidate.at < scope.from) ||
        (scope.to !== null && candidate.at >= scope.to) ||
        (scope.postId !== null && candidate.postId !== scope.postId) ||
        ('spaceId' in scope
          ? candidate.spaceId !== scope.spaceId
          : !scope.regionalSpaceIds.includes(candidate.spaceId) &&
            !scope.globalSpaceIds.includes(candidate.spaceId)) ||
        (previous !== null && !searchAnchorFollows(candidate, previous))
      )
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      previous = candidate;
    }
  }

  private async lockCandidates(
    candidates: SearchCandidate[],
    guard: SearchAnchor | null,
    tx: PoolClient,
  ) {
    const held = new Map<string, SearchCandidate>();
    const reference = guard ? await this.searches.reference(guard, tx) : null;
    if (guard && !reference)
      throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
    if (
      reference &&
      (!searchCandidateSchema.safeParse(reference).success ||
        reference.kind !== guard!.kind ||
        reference.id !== guard!.id)
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const all = [...candidates, ...(reference ? [reference] : [])];
    // Preserve the canonical post -> root -> reply hierarchy across the whole
    // union, including sentinel and guard. Every lock reads metadata only.
    for (const kind of ['post', 'comment', 'reply'] as const) {
      const ids = new Set(
        all.flatMap((item) =>
          kind === 'post'
            ? [item.postId]
            : kind === 'comment'
              ? item.rootCommentId
                ? [item.rootCommentId]
                : []
              : item.kind === 'reply'
                ? [item.id]
                : [],
        ),
      );
      for (const id of [...ids].sort()) {
        const candidate = await this.searches.lockCandidate(kind, id, tx);
        if (!candidate) continue;
        if (
          !searchCandidateSchema.safeParse(candidate).success ||
          candidate.id !== id ||
          candidate.kind !== kind
        )
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        held.set(searchCandidateKey(candidate), candidate);
      }
    }
    for (const item of all) {
      const locked = held.get(searchCandidateKey(item));
      if (!locked) continue; // The stable reread excludes deleted source rows.
      const parent = held.get(
        searchCandidateKey({ kind: 'post', id: locked.postId }),
      );
      const root = locked.rootCommentId
        ? held.get(
            searchCandidateKey({ kind: 'comment', id: locked.rootCommentId }),
          )
        : null;
      if (
        locked.postId !== item.postId ||
        locked.rootCommentId !== item.rootCommentId ||
        !parent ||
        parent.spaceId !== locked.spaceId ||
        (locked.rootCommentId !== null && (!root || root.postId !== parent.id))
      )
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }
    return held;
  }

  search(token: string | null, query: SearchQuery): Promise<SearchPage> {
    requireSearchMatcherRuntime();
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        await lockSafetyPolicy(tx);
        const session =
          token === null ? null : await this.identity.session(token, tx);
        const actor = session?.accountId ?? null;
        if (
          actor === null &&
          (query.type === 'comment' || query.type === 'reply')
        )
          throw new ApplicationError('AUTHENTICATION_REQUIRED');
        const effectiveTypes: SearchKind[] =
          query.type === 'all'
            ? actor === null
              ? ['post']
              : ['post', 'comment', 'reply']
            : [query.type];
        const explicitSpace =
          'spaceId' in query
            ? await this.repository.space(query.spaceId, tx)
            : null;
        if (
          explicitSpace?.kind === 'global' &&
          ((query.category !== undefined && query.category !== 'discussion') ||
            query.tradingSubtype !== undefined)
        )
          throw new BadRequestException('Invalid request');
        if (query.cursor) {
          if (actor === null)
            throw new ApplicationError('AUTHENTICATION_REQUIRED');
          if (!(await this.phones.verified(actor, tx)))
            throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
        }
        const scopeHash = searchCursorScope(query, session);
        const position: SearchPosition | FederatedSearchPosition | null =
          query.cursor
            ? await this.cursors.get(query.cursor, scopeHash, tx, (value) =>
                'scope' in query
                  ? federatedSearchPositionSchema.parse(value)
                  : searchPositionSchema.parse(value),
              )
            : null;
        const resolved: ResolvedSearchScope | null =
          'scope' in query ? await this.scopes.resolve(query.scope, tx) : null;
        if (
          position?.v === 4 &&
          position.membershipFingerprint !== resolved?.membershipFingerprint
        )
          throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
        const scope: SearchStructuralScope = {
          types: effectiveTypes,
          from: query.from ?? null,
          to: query.to ?? null,
          postId: query.postId ?? null,
          ...(explicitSpace
            ? { spaceId: explicitSpace.id }
            : {
                regionalSpaceIds: resolved!.regionalSpaceIds,
                globalSpaceIds: resolved!.globalSpaceIds,
              }),
          category: query.category ?? null,
          tradingSubtype: query.tradingSubtype ?? null,
          excludeUrgentTrading:
            explicitSpace !== null && query.category === undefined,
        };
        const sourceSpace = (id: string): Readonly<CommunitySpace> => {
          const space =
            explicitSpace?.id === id ? explicitSpace : resolved?.space(id);
          if (!space) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          return space;
        };
        const seek = position?.after ?? null;
        const guard = position?.visible ?? null;
        const candidates = await this.searches.candidates(scope, seek, tx);
        this.validateCandidates(candidates, seek, scope);
        const held = await this.lockCandidates(candidates, guard, tx);
        if (guard) {
          const candidate = held.get(searchCandidateKey(guard));
          if (
            !candidate ||
            candidate.at !== guard.at ||
            candidate.kind !== guard.kind
          )
            throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
          const allowed = await this.allowed(candidate, scope, actor, tx);
          if (
            !allowed ||
            !(await this.searches.exactAnchor(guard, tx)) ||
            !searchMatches(allowed.content.text, query.q)
          )
            throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
        }
        const current = await this.searches.candidates(scope, seek, tx);
        this.validateCandidates(current, seek, scope);
        if (
          current.some(
            (item) =>
              !held.has(searchCandidateKey(item)) ||
              held.get(searchCandidateKey(item))!.spaceId !== item.spaceId ||
              held.get(searchCandidateKey(item))!.at !== item.at ||
              held.get(searchCandidateKey(item))!.postId !== item.postId ||
              held.get(searchCandidateKey(item))!.rootCommentId !==
                item.rootCommentId,
          )
        )
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        const items: SearchHit[] = [];
        let consumed = 0;
        let lastVisible = guard;
        for (const candidate of current.slice(0, SEARCH_SCAN_BATCH)) {
          consumed++;
          const allowed = await this.allowed(candidate, scope, actor, tx);
          if (!allowed || !searchMatches(allowed.content.text, query.q))
            continue;
          const space = sourceSpace(candidate.spaceId);
          items.push(
            await this.serializer.hit(
              candidate,
              allowed.post,
              allowed.content,
              space,
              query.q,
              allowed.listing,
              tx,
            ),
          );
          lastVisible = {
            at: candidate.at,
            kind: candidate.kind,
            id: candidate.id,
          };
          if (items.length === query.limit) break;
        }
        const exhausted = consumed === current.length;
        const next = exhausted ? null : current[consumed - 1];
        if (
          !exhausted &&
          (!next || (seek !== null && !searchAnchorFollows(next, seek)))
        )
          throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
        let continuation: SearchPage['continuation'] = exhausted
          ? 'end'
          : items.length === query.limit
            ? 'more'
            : 'scan_pending';
        if (!exhausted) {
          if (actor === null) continuation = 'login_required';
          else {
            // Unlike advisory hints, continued traversal needs current known phone
            // evidence and its mandatory deadline, including on an empty batch.
            if (!(await this.phones.verified(actor, tx)))
              continuation = 'phone_verification_required';
          }
        }
        if (token !== null) await this.identity.session(token, tx);
        // Cursor quota lock is last. The transaction still performs mandatory
        // deferred relationship/deadline proof before committing either result.
        const nextCursor =
          next && (continuation === 'more' || continuation === 'scan_pending')
            ? await this.cursors.create(
                scopeHash,
                discoveryCursorBucket(actor),
                {
                  ...(resolved
                    ? {
                        v: 4,
                        membershipFingerprint: resolved.membershipFingerprint,
                      }
                    : { v: 3 }),
                  kind: 'search',
                  matcherId: SEARCH_MATCHER_ID,
                  orderId: SEARCH_ORDER_ID,
                  after: { at: next.at, kind: next.kind, id: next.id },
                  visible: lastVisible,
                },
                tx,
              )
            : null;
        const result = searchPageSchema.safeParse({
          items,
          effectiveTypes,
          nextCursor,
          continuation,
        });
        if (!result.success)
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        return result.data;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
