import { createHash } from 'node:crypto';
import type { ContentReviewSearchEligibilityFacade } from '../content-review/search-eligibility.facade.js';
import type { SemanticCorpusRepository } from './semantic/corpus-repository.js';
import type { QwenSemanticProfile } from './semantic/profile.js';
import type { SemanticEmbedding } from './semantic/provider.js';
import { captureSemanticEligibilityProof } from './semantic/eligibility-proof.js';
import { semanticFingerprint } from './semantic/contracts.js';
import type {
  SemanticScopeSnapshot,
  SemanticAuthorizedSource,
} from './semantic/contracts.js';
import type { SemanticIndexRepository } from './semantic/repository.js';
import { semanticBodyDigest } from './semantic/provider.js';
import { SearchReadContext } from '../content-review/search-read-context.js';
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
  searchAnchorSchema,
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

  /** Test subclasses can compare the unchanged scalar owners without adding a
   * runtime feature flag or an alternate authorization provider. */
  protected canonicalReadContext(
    tx: PoolClient,
  ): SearchReadContext | undefined {
    return new SearchReadContext(tx);
  }

  private async allowed(
    candidate: SearchCandidate,
    scope: SearchStructuralScope,
    actor: string | null,
    tx: PoolClient,
    read?: SearchReadContext,
  ): Promise<{
    post: StoredPost;
    content: StoredPost | StoredComment;
    listing: { subtype: TradingSubtype; urgency: 'normal' | 'urgent' } | null;
  } | null> {
    const post = await this.repository.post(candidate.postId, tx, false, read);
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
      const facts = await this.searches.tradingFilter(post.id, tx, read);
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
        read,
      ))
    )
      return null;
    if (candidate.kind === 'post') return { post, content: post, listing };
    const root = await this.repository.comment(
      candidate.rootCommentId!,
      tx,
      true,
      read,
    );
    if (root.post_id !== post.id)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (!(await this.access.visible(actor, root, tx, 'list_projection', read)))
      return null;
    if (candidate.kind === 'comment') return { post, content: root, listing };
    const reply = await this.repository.reply(candidate.id, tx, true, read);
    if (reply.post_id !== post.id || reply.root_comment_id !== root.id)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (!(await this.access.visible(actor, reply, tx, 'list_projection', read)))
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
      if (!ids.size) continue;
      const locked = await this.searches.lockCandidates(
        kind,
        [...ids].sort(),
        tx,
      );
      if (locked.length > ids.size)
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      let previous: string | null = null;
      for (const candidate of locked) {
        if (
          !searchCandidateSchema.safeParse(candidate).success ||
          !ids.has(candidate.id) ||
          candidate.kind !== kind ||
          (previous !== null && candidate.id <= previous)
        )
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        held.set(searchCandidateKey(candidate), candidate);
        previous = candidate.id;
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

  /** Private structural enumeration for explicit actor-authorized indexing.
   * A resume coordinate is not an index-coverage proof. New/changed sources are
   * detected by query-time coverage checks and require reconciliation. */
  semanticSourceBatch(
    token: string | null,
    query: SearchQuery,
    checkpoint: { scopeFingerprint: string; after: SearchAnchor } | null = null,
  ): Promise<{
    sources: Pick<SearchAnchor, 'kind' | 'id'>[];
    next: { scopeFingerprint: string; after: SearchAnchor } | null;
  }> {
    if (
      query.cursor ||
      (checkpoint && !searchAnchorSchema.safeParse(checkpoint.after).success)
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        await lockSafetyPolicy(tx);
        await captureSemanticEligibilityProof(tx);
        const { session, resolved, scope } = await this.semanticContext(
          token,
          query,
          tx,
        );
        const scopeFingerprint = semanticFingerprint([
          'semantic-index-enumeration-v1',
          searchCursorScope(query, session),
          resolved?.membershipFingerprint ?? null,
        ]);
        if (checkpoint && checkpoint.scopeFingerprint !== scopeFingerprint)
          throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
        const rows = await this.searches.candidates(
          scope,
          checkpoint?.after ?? null,
          tx,
        );
        this.validateCandidates(rows, checkpoint?.after ?? null, scope);
        const last = rows[SEARCH_SCAN_BATCH - 1];
        if (token !== null) await this.identity.session(token, tx);
        return {
          sources: rows
            .slice(0, SEARCH_SCAN_BATCH)
            .map(({ kind, id }) => ({ kind, id })),
          next:
            rows.length > SEARCH_SCAN_BATCH && last
              ? {
                  scopeFingerprint,
                  after: { at: last.at, kind: last.kind, id: last.id },
                }
              : null,
        };
      },
      { isolationLevel: 'read committed' },
    );
  }

  private async semanticContext(
    token: string | null,
    query: SearchQuery,
    tx: PoolClient,
  ) {
    const session =
      token === null ? null : await this.identity.session(token, tx);
    const actor = session?.accountId ?? null;
    if (actor === null && (query.type === 'comment' || query.type === 'reply'))
      throw new ApplicationError('AUTHENTICATION_REQUIRED');
    const types: SearchKind[] =
      query.type === 'all'
        ? actor === null
          ? ['post']
          : ['post', 'comment', 'reply']
        : [query.type];
    const explicit =
      'spaceId' in query
        ? await this.repository.space(query.spaceId, tx)
        : null;
    if (
      explicit?.kind === 'global' &&
      ((query.category !== undefined && query.category !== 'discussion') ||
        query.tradingSubtype !== undefined)
    )
      throw new BadRequestException('Invalid request');
    const resolved =
      'scope' in query ? await this.scopes.resolve(query.scope, tx) : null;
    const scope: SearchStructuralScope = {
      types,
      from: query.from ?? null,
      to: query.to ?? null,
      postId: query.postId ?? null,
      ...(explicit
        ? { spaceId: explicit.id }
        : {
            regionalSpaceIds: resolved!.regionalSpaceIds,
            globalSpaceIds: resolved!.globalSpaceIds,
          }),
      category: query.category ?? null,
      tradingSubtype: query.tradingSubtype ?? null,
      excludeUrgentTrading: explicit !== null && query.category === undefined,
    };
    return { session, actor, explicit, resolved, scope };
  }

  /** Internal exact-search oracle, not an HTTP endpoint or a scalable corpus
   * authorization implementation. The cap applies to the ENTIRE structural
   * scope before any body, vector or embedding-coverage inspection. Providers
   * must run outside this callback; it accepts local SQL/projection only. */
  semanticScope<T>(
    token: string | null,
    query: SearchQuery,
    revisions: Pick<SemanticIndexRepository, 'revision'>,
    operation: (snapshot: SemanticScopeSnapshot, tx: PoolClient) => Promise<T>,
    intent: 'index' | 'search' = 'search',
    sourceIds?: readonly Pick<SearchAnchor, 'kind' | 'id'>[],
  ): Promise<T> {
    if (
      sourceIds &&
      (sourceIds.length > SEARCH_SCAN_BATCH ||
        new Set(sourceIds.map(searchCandidateKey)).size !== sourceIds.length)
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (query.cursor) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const read = this.canonicalReadContext(tx);
        try {
          await lockSafetyPolicy(tx);
          if (intent === 'search') await captureSemanticEligibilityProof(tx);
          const { session, actor, explicit, resolved, scope } =
            await this.semanticContext(token, query, tx);
          const readMetadata = async (): Promise<SearchCandidate[]> => {
            if (!sourceIds) return this.searches.candidates(scope, null, tx);
            const rows: SearchCandidate[] = [];
            for (const source of sourceIds) {
              if (
                !searchAnchorSchema.shape.kind.safeParse(source.kind).success ||
                !searchAnchorSchema.shape.id.safeParse(source.id).success
              )
                throw new ApplicationError('COMMUNITY_UNAVAILABLE');
              const row = await this.searches.reference(source, tx);
              if (row) rows.push(row);
            }
            return rows.sort((a, b) =>
              searchAnchorFollows(a, b)
                ? 1
                : searchAnchorFollows(b, a)
                  ? -1
                  : 0,
            );
          };
          const candidates = await readMetadata();
          this.validateCandidates(candidates, null, scope);
          // A 129th source is NOT a continuation page or a recent-window result.
          if (candidates.length > SEARCH_SCAN_BATCH)
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          const held = await this.lockCandidates(candidates, null, tx);
          const current = await readMetadata();
          this.validateCandidates(current, null, scope);
          if (
            semanticFingerprint(current) !== semanticFingerprint(candidates) ||
            current.some(
              (candidate) =>
                semanticFingerprint(
                  held.get(searchCandidateKey(candidate)) ?? null,
                ) !== semanticFingerprint(candidate),
            )
          )
            throw new ApplicationError('COMMUNITY_UNAVAILABLE');
          const sources: SemanticAuthorizedSource[] = [];
          const nonTextSources: SemanticAuthorizedSource[] = [];
          const deniedSources: SearchCandidate[] = [];
          const eligibility: unknown[] = [];
          const projections = new Map<string, () => Promise<SearchHit>>();
          for (const candidate of current) {
            const allowed = await this.allowed(
              candidate,
              scope,
              actor,
              tx,
              read,
            );
            if (!allowed) {
              // A denied body's hash, lifecycle token, embedding or missing index
              // must never influence the snapshot, cap or ranking slate.
              eligibility.push([candidate, 'deny']);
              deniedSources.push(candidate);
              continue;
            }
            const revision = await revisions.revision(candidate, tx);
            const fingerprint = semanticFingerprint([
              candidate,
              revision,
              allowed.content.text,
            ]);
            eligibility.push([candidate, 'allow', fingerprint]);
            // Image-only comments are known non-text sources, not index failures.
            const source = Object.freeze({
              candidate: Object.freeze({ ...candidate }),
              revision,
              fingerprint,
              bodyDigest: createHash('sha256')
                .update(allowed.content.text, 'utf8')
                .digest('hex'),
              text: allowed.content.text,
            });
            if (!allowed.content.text.trim()) {
              nonTextSources.push(source);
              continue;
            }
            sources.push(source);
            const space =
              explicit?.id === candidate.spaceId
                ? explicit
                : resolved?.space(candidate.spaceId);
            if (!space) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
            projections.set(searchCandidateKey(candidate), () =>
              this.serializer.hit(
                candidate,
                allowed.post,
                allowed.content,
                space,
                query.q,
                allowed.listing,
                tx,
                'semantic',
              ),
            );
          }
          const fingerprint = semanticFingerprint([
            'semantic-scope-oracle-v1',
            searchCursorScope(query, session),
            resolved?.membershipFingerprint ?? null,
            eligibility,
          ]);
          const result = await operation(
            {
              fingerprint,
              sources: Object.freeze(sources),
              nonTextSources: Object.freeze(nonTextSources),
              deniedSources: Object.freeze(deniedSources),
              project: async (keys) => {
                read?.assertCurrent(tx);
                if (
                  keys.length > query.limit ||
                  new Set(keys).size !== keys.length
                )
                  throw new ApplicationError('COMMUNITY_UNAVAILABLE');
                const hits: SearchHit[] = [];
                for (const key of keys) {
                  const project = projections.get(key);
                  if (!project)
                    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
                  hits.push(await project());
                }
                read?.assertCurrent(tx);
                return hits;
              },
            },
            tx,
          );
          if (token !== null) await this.identity.session(token, tx);
          read?.assertCurrent(tx);
          return result;
        } finally {
          read?.close();
        }
      },
      { isolationLevel: 'read committed' },
    );
  }

  /** Full-corpus metadata eligibility precedes vector access. Only the exact
   * top128 enters the existing canonical lock/proof budget. No model call occurs
   * here; the configured HTTP owner runs providers between committed phases. */
  semanticCorpus<T>(
    token: string | null,
    query: SearchQuery,
    profile: QwenSemanticProfile,
    embedding: SemanticEmbedding,
    index: SemanticIndexRepository,
    content: ContentReviewSearchEligibilityFacade,
    corpus: SemanticCorpusRepository,
    operation: (snapshot: SemanticScopeSnapshot, tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (query.cursor) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const read = this.canonicalReadContext(tx);
        try {
          await lockSafetyPolicy(tx);
          await captureSemanticEligibilityProof(tx);
          const { session, actor, explicit, resolved, scope } =
            await this.semanticContext(token, query, tx);
          const relation = await content.prepare(scope, profile, tx);
          const selection = await corpus.select(
            relation,
            actor,
            profile,
            embedding,
            tx,
          );
          const candidates = selection.candidates
            .map((entry) => entry.candidate)
            .sort((a, b) =>
              searchAnchorFollows(a, b)
                ? 1
                : searchAnchorFollows(b, a)
                  ? -1
                  : 0,
            );
          this.validateCandidates(candidates, null, scope);
          const held = await this.lockCandidates(candidates, null, tx);
          const sources: SemanticAuthorizedSource[] = [];
          const projections = new Map<string, () => Promise<SearchHit>>();
          for (const entry of selection.candidates) {
            const candidate = entry.candidate;
            if (
              semanticFingerprint(held.get(entry.key) ?? null) !==
              semanticFingerprint(candidate)
            )
              throw new ApplicationError('COMMUNITY_UNAVAILABLE');
            const allowed = await this.allowed(
              candidate,
              scope,
              actor,
              tx,
              read,
            );
            // The relation certified this source as allowed. A stale/different
            // decision invalidates the whole ranking instead of postfiltering it.
            if (!allowed) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
            const revision = await index.revision(candidate, tx);
            const bodyDigest = semanticBodyDigest(allowed.content.text);
            if (
              semanticFingerprint(revision) !==
                semanticFingerprint(entry.revision) ||
              bodyDigest !== entry.bodyDigest
            )
              throw new ApplicationError('COMMUNITY_UNAVAILABLE');
            sources.push(
              Object.freeze({
                candidate: Object.freeze({ ...candidate }),
                revision,
                bodyDigest,
                text: allowed.content.text,
                fingerprint: semanticFingerprint([
                  candidate,
                  revision,
                  allowed.content.text,
                ]),
              }),
            );
            const space =
              explicit?.id === candidate.spaceId
                ? explicit
                : resolved?.space(candidate.spaceId);
            if (!space) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
            projections.set(entry.key, () =>
              this.serializer.hit(
                candidate,
                allowed.post,
                allowed.content,
                space,
                query.q,
                allowed.listing,
                tx,
                'semantic',
              ),
            );
          }
          const fingerprint = semanticFingerprint([
            'semantic-full-corpus-v1',
            searchCursorScope(query, session),
            resolved?.membershipFingerprint ?? null,
            selection.fingerprint,
          ]);
          const result = await operation(
            {
              fingerprint,
              sources: Object.freeze(sources),
              corpus: 'full',
              ranks: selection.candidates.map(({ key, distance }) => ({
                key,
                distance,
              })),
              project: async (keys) => {
                read?.assertCurrent(tx);
                if (
                  keys.length > query.limit ||
                  new Set(keys).size !== keys.length
                )
                  throw new ApplicationError('COMMUNITY_UNAVAILABLE');
                const hits: SearchHit[] = [];
                for (const key of keys) {
                  const project = projections.get(key);
                  if (!project)
                    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
                  hits.push(await project());
                }
                read?.assertCurrent(tx);
                return hits;
              },
            },
            tx,
          );
          if (token !== null) await this.identity.session(token, tx);
          relation.assertCurrent(tx);
          read?.assertCurrent(tx);
          return result;
        } finally {
          read?.close();
        }
      },
      { isolationLevel: 'read committed' },
    );
  }

  search(token: string | null, query: SearchQuery): Promise<SearchPage> {
    requireSearchMatcherRuntime();
    return this.repository.database.transaction(
      async (tx) => {
        enableSafetyRelationshipProof(tx);
        const read = this.canonicalReadContext(tx);
        try {
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
            ((query.category !== undefined &&
              query.category !== 'discussion') ||
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
            'scope' in query
              ? await this.scopes.resolve(query.scope, tx)
              : null;
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
            const allowed = await this.allowed(
              candidate,
              scope,
              actor,
              tx,
              read,
            );
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
            const allowed = await this.allowed(
              candidate,
              scope,
              actor,
              tx,
              read,
            );
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
          read?.assertCurrent(tx);
          return result.data;
        } finally {
          read?.close();
        }
      },
      { isolationLevel: 'read committed' },
    );
  }
}
