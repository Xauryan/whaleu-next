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
import { CommunitySerializer } from '../community-serialization.js';
import { CommunityRepository } from '../community.repository.js';
import type { StoredPost } from '../community.repository.js';
import type { PostView } from '../contracts.js';
import {
  DiscoveryCursorRepository,
  discoveryCursorBucket,
} from '../discovery-cursors.js';
import type { SearchPage, SearchQuery } from './contracts.js';
import {
  searchAnchorFollows,
  federatedSearchPositionSchema,
  searchCursorScope,
  searchPositionSchema,
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
} from './repository.js';
import type { SearchCandidate, SearchStructuralScope } from './repository.js';

@Injectable()
export class SearchService {
  constructor(
    @Inject(CommunityRepository)
    private readonly repository: CommunityRepository,
    @Inject(CommunityAccessService)
    private readonly access: CommunityAccessService,
    @Inject(CommunitySerializer)
    private readonly serializer: CommunitySerializer,
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
    post: StoredPost,
    scope: SearchStructuralScope,
    actor: string | null,
    tx: PoolClient,
  ): Promise<boolean> {
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
      post.deleted_at !== null ||
      post.visibility !== 'approved'
    )
      return false;
    if (post.category === 'trading') {
      const listing = await this.searches.tradingFilter(post.id, tx);
      if (!listing || !['normal', 'urgent'].includes(listing.urgency))
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      if (
        (scope.tradingSubtype !== null &&
          listing.subtype !== scope.tradingSubtype) ||
        (scope.excludeUrgentTrading && listing.urgency === 'urgent')
      )
        return false;
    } else if (scope.tradingSubtype !== null) return false;
    // Includes canonical review reconstruction before named list policy. The
    // direct-post path is deliberately not used: reverse-only blocks differ.
    return this.access.visible(actor, post, tx, 'list_projection');
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
    for (const id of [
      ...new Set([
        ...candidates.map((item) => item.id),
        ...(guard ? [guard.id] : []),
      ]),
    ].sort()) {
      // The lookahead is locked as structural metadata only. No peek body or
      // visibility proof is fetched, even when every examined row is denied.
      const candidate = await this.searches.lockCandidate(id, tx);
      if (!candidate) {
        if (id === guard?.id)
          throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
        continue;
      }
      if (
        !searchCandidateSchema.safeParse(candidate).success ||
        candidate.id !== id
      )
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      held.set(id, candidate);
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
          position?.v === 2 &&
          position.membershipFingerprint !== resolved?.membershipFingerprint
        )
          throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
        const scope: SearchStructuralScope = {
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
          const post = held.has(guard.id)
            ? await this.repository.post(guard.id, tx)
            : null;
          if (
            !post ||
            !(await this.allowed(post, scope, actor, tx)) ||
            !(await this.searches.exactAnchor(guard, tx)) ||
            !searchMatches(post.text, query.q)
          )
            throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
        }
        const current = await this.searches.candidates(scope, seek, tx);
        this.validateCandidates(current, seek, scope);
        if (
          current.some(
            (item) =>
              !held.has(item.id) ||
              held.get(item.id)!.spaceId !== item.spaceId ||
              held.get(item.id)!.at !== item.at,
          )
        )
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        const items: PostView[] = [];
        let consumed = 0;
        let lastVisible = guard;
        for (const candidate of current.slice(0, SEARCH_SCAN_BATCH)) {
          consumed++;
          const post = await this.repository.post(candidate.id, tx);
          if (post.space_id !== candidate.spaceId)
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          if (!(await this.allowed(post, scope, actor, tx))) continue;
          if (!searchMatches(post.text, query.q)) continue;
          const space = sourceSpace(candidate.spaceId);
          items.push(
            await this.serializer.post(
              post,
              space,
              actor,
              await this.access.advisory(actor, space, tx),
              tx,
            ),
          );
          lastVisible = { at: candidate.at, id: candidate.id };
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
                        v: 2,
                        membershipFingerprint: resolved.membershipFingerprint,
                      }
                    : { v: 1 }),
                  kind: 'search',
                  matcherId: SEARCH_MATCHER_ID,
                  after: { at: next.at, id: next.id },
                  visible: lastVisible,
                },
                tx,
              )
            : null;
        return { items, nextCursor, continuation };
      },
      { isolationLevel: 'read committed' },
    );
  }
}
