import type { ContentReviewSearchEligibilityFacade } from '../../content-review/search-eligibility.facade.js';
import type { SemanticCorpusRepository } from './corpus-repository.js';
import type { QwenSemanticProfile } from './profile.js';
import type { SearchAnchor } from '../cursor.js';
import type { SearchQuery, SearchHit } from '../contracts.js';
import { searchCandidateKey } from '../repository.js';
import type { SearchService } from '../service.js';
import { ApplicationError } from '../../../http/application-error.js';
import { semanticFingerprint } from './contracts.js';
import type { SemanticScopeAuthority } from './contracts.js';
import { QwenSemanticProvider } from './provider.js';
import { SemanticIndexRepository } from './repository.js';

const unavailable = () => new ApplicationError('COMMUNITY_UNAVAILABLE');
export const SEMANTIC_RERANK_CANDIDATES = 32;
export interface InternalSemanticResult {
  readonly mode: 'exact-scope-oracle-v1' | 'exact-full-corpus-v1';
  readonly coverage: 'current-authorized-text-scope';
  readonly ordering: 'embedding-top32-then-rerank';
  readonly items: SearchHit[];
}

export function oracleScopeAuthority(
  searches: SearchService,
  index: SemanticIndexRepository,
): SemanticScopeAuthority {
  return {
    preflight: async (token, query) => {
      await searches.semanticSourceBatch(token, query);
    },
    withSources: (token, query, sources, operation) =>
      searches.semanticScope(token, query, index, operation, 'index', sources),
    withScope: (token, query, operation, intent) =>
      searches.semanticScope(token, query, index, operation, intent),
  };
}

/** Uses the full metadata owner for reads and the bounded explicit-source
 * owner for authorized indexing. Neither path creates a background identity. */
export function fullCorpusScopeAuthority(
  searches: SearchService,
  index: SemanticIndexRepository,
  content: ContentReviewSearchEligibilityFacade,
  corpus: SemanticCorpusRepository,
  profile: QwenSemanticProfile,
): SemanticScopeAuthority {
  const oracle = oracleScopeAuthority(searches, index);
  return {
    preflight: oracle.preflight,
    withSources: oracle.withSources,
    withScope: (token, query, operation, intent = 'search', embedding) => {
      if (intent === 'index')
        return oracle.withScope(token, query, operation, 'index');
      if (!embedding) throw unavailable();
      return searches.semanticCorpus(
        token,
        query,
        profile,
        embedding,
        index,
        content,
        corpus,
        operation,
      );
    },
  };
}

/** Explicitly configured orchestration, with an offline fixture mode for tests.
 * HTTP uses only the full-corpus owner; the small oracle remains a test baseline.
 * Default mode refuses before provider/authority calls. Indexing is explicit,
 * actor-authorized work and is never an automatic side effect of searching. */
export class SemanticSearchEngine {
  constructor(
    private readonly provider: QwenSemanticProvider,
    private readonly index: SemanticIndexRepository,
    private readonly authority: SemanticScopeAuthority,
    private readonly mode:
      'disabled' | 'local_fixture' | 'configured' = 'disabled',
    private readonly certificates?: ContentReviewSearchEligibilityFacade,
  ) {}

  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw unavailable();
    }
  }

  private enabled(query: SearchQuery): void {
    if (
      this.mode === 'disabled' ||
      query.cursor ||
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 10
    )
      throw unavailable();
  }

  /** A query actor is not an unrestricted background-indexer identity. Snapshot
   * and CAS each reprove the entire current scope; all external computation is
   * between completed transactions. No historical completeness is inferred. */
  indexSources(
    token: string | null,
    query: SearchQuery,
    sources: readonly Pick<SearchAnchor, 'kind' | 'id'>[],
  ): Promise<{ indexed: number }> {
    return this.indexScope(token, query, sources);
  }

  indexScope(
    token: string | null,
    query: SearchQuery,
    sourceIds?: readonly Pick<SearchAnchor, 'kind' | 'id'>[],
  ): Promise<{ indexed: number }> {
    return this.guarded(() => this.indexScopeUnsafe(token, query, sourceIds));
  }

  private async indexScopeUnsafe(
    token: string | null,
    query: SearchQuery,
    sourceIds?: readonly Pick<SearchAnchor, 'kind' | 'id'>[],
  ): Promise<{ indexed: number }> {
    this.enabled(query);
    const authority: SemanticScopeAuthority = sourceIds
      ? {
          ...this.authority,
          withScope: (token, query, operation) =>
            this.authority.withSources(token, query, sourceIds, operation),
        }
      : this.authority;
    const before = await authority.withScope(
      token,
      query,
      async (scope) => ({
        fingerprint: scope.fingerprint,
        sources: scope.sources,
        nonTextSources: scope.nonTextSources ?? [],
        deniedSources: scope.deniedSources ?? [],
      }),
      'index',
    );
    if (
      !before.sources.length &&
      !before.nonTextSources.length &&
      !before.deniedSources.length
    )
      return { indexed: 0 };
    const embeddings = before.sources.length
      ? await this.provider.embedDocuments(
          before.sources.map((source, i) => ({
            id: `document-${i}`,
            text: source.text,
          })),
        )
      : [];
    return authority.withScope(
      token,
      query,
      async (scope, tx) => {
        if (
          scope.fingerprint !== before.fingerprint ||
          embeddings.length !== scope.sources.length
        )
          throw unavailable();
        for (let i = 0; i < scope.sources.length; i++) {
          const source = scope.sources[i]!;
          const embedding = embeddings[i]!;
          if (
            embedding.id !== `document-${i}` ||
            embedding.bodyDigest !== source.bodyDigest
          )
            throw unavailable();
          if (this.certificates) {
            const certificate = await this.certificates.captureCurrent(
              source,
              this.provider.profile,
              tx,
            );
            await this.certificates.persist(certificate, tx);
          }
          await this.index.upsert(
            this.provider.profile,
            source,
            {
              ...embedding,
              id: searchCandidateKey(source.candidate),
            },
            tx,
          );
        }
        if (this.certificates) {
          for (const candidate of scope.deniedSources ?? []) {
            const evidence = await this.certificates.captureEligibilityCurrent(
              candidate,
              this.provider.profile,
              tx,
            );
            if (evidence.decision === 'unknown' || !evidence.certificate)
              throw unavailable();
            await this.certificates.persist(evidence.certificate, tx);
          }
          for (const source of scope.nonTextSources ?? []) {
            const certificate = await this.certificates.captureCurrent(
              source,
              this.provider.profile,
              tx,
            );
            await this.certificates.persist(certificate, tx);
          }
        }
        return { indexed: scope.sources.length };
      },
      'index',
    );
  }

  search(
    token: string | null,
    query: SearchQuery,
  ): Promise<InternalSemanticResult> {
    return this.guarded(() => this.searchUnsafe(token, query));
  }

  private async searchUnsafe(
    token: string | null,
    query: SearchQuery,
  ): Promise<InternalSemanticResult> {
    this.enabled(query);
    await this.authority.preflight(token, query);
    const embedding = await this.provider.embedQuery(query.q);
    const before = await this.authority.withScope(
      token,
      query,
      async (scope, tx) => {
        const ranks =
          scope.ranks ??
          (await this.index.rank(
            this.provider.profile,
            embedding,
            scope.sources,
            tx,
          ));
        const sources = new Map(
          scope.sources.map((source) => [
            searchCandidateKey(source.candidate),
            source,
          ]),
        );
        return {
          fingerprint: scope.fingerprint,
          rankFingerprint: semanticFingerprint(ranks),
          candidates: ranks.slice(0, SEMANTIC_RERANK_CANDIDATES).map((rank) => {
            const source = sources.get(rank.key);
            if (!source) throw unavailable();
            return { key: rank.key, text: source.text };
          }),
        };
      },
      'search',
      embedding,
    );
    // Provider identifiers are local ordinals, never content/account UUIDs.
    const ranked = before.candidates.length
      ? await this.provider.rerank(
          query.q,
          before.candidates.map((candidate, i) => ({
            id: `candidate-${i}`,
            text: candidate.text,
          })),
        )
      : [];
    const byId = new Map(
      before.candidates.map((candidate, i) => [
        `candidate-${i}`,
        candidate.key,
      ]),
    );
    const keys = ranked.slice(0, query.limit).map((rank) => {
      const key = byId.get(rank.id);
      if (!key) throw unavailable();
      return key;
    });
    return this.authority.withScope(
      token,
      query,
      async (scope, tx) => {
        if (scope.fingerprint !== before.fingerprint) throw unavailable();
        // Revalidate every previously eligible/denied source and the complete
        // ranking inputs, not just returned hits. A changed slate is unavailable,
        // never silently shortened into an apparently complete top-K answer.
        const ranks =
          scope.ranks ??
          (await this.index.rank(
            this.provider.profile,
            embedding,
            scope.sources,
            tx,
          ));
        if (semanticFingerprint(ranks) !== before.rankFingerprint)
          throw unavailable();
        const items = await scope.project(keys);
        return {
          mode:
            scope.corpus === 'full'
              ? 'exact-full-corpus-v1'
              : 'exact-scope-oracle-v1',
          coverage: 'current-authorized-text-scope',
          ordering: 'embedding-top32-then-rerank',
          items,
        };
      },
      'search',
      embedding,
    );
  }
}
