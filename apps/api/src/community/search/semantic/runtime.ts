import { MediaContentSnapshotFacade } from '../../../media/content-snapshot.facade.js';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.js';
import type { RuntimeConfig } from '../../../config/config.js';
import { ApplicationError } from '../../../http/application-error.js';
import { CampusContentScopeFacade } from '../../../campus/content-scope.facade.js';
import { SafetySearchEligibilityFacade } from '../../../safety/search-eligibility.facade.js';
import { LocalApprovedContentVisibility } from '../../content-review/local-approved-content-visibility.js';
import { ContentReviewSearchEligibilityFacade } from '../../content-review/search-eligibility.facade.js';
import { SearchService } from '../service.js';
import type { SearchQuery } from '../contracts.js';
import { createQwenSemanticProfile } from './profile.js';
import { QwenSemanticProvider } from './provider.js';
import {
  TumuerQwenHttpTransport,
  TUMUER_QWEN_ORIGIN,
} from './tumuer-http-transport.js';
import { SemanticIndexRepository } from './repository.js';
import { SemanticCorpusRepository } from './corpus-repository.js';
import { SemanticSearchEngine, fullCorpusScopeAuthority } from './engine.js';
import { semanticSearchPageSchema } from './http-contracts.js';
import type { SemanticSearchPage } from './http-contracts.js';

export const SEMANTIC_MODEL_PROVIDER = Symbol('SEMANTIC_MODEL_PROVIDER');
/** No environment secret is read until a separately configured enabled request.
 * The user's gateway is fixed. SiliconFlow is never an automatic fallback. */
export function createConfiguredSemanticProvider(
  config: RuntimeConfig,
): QwenSemanticProvider | null {
  if (config.COMMUNITY_SEMANTIC_SEARCH === 'disabled') return null;
  const profile = createQwenSemanticProfile({
    providerId: 'tumuer',
    deploymentId: 'router.tumuer.me',
    deploymentRevision: config.COMMUNITY_SEMANTIC_DEPLOYMENT_REVISION!,
    embeddingModelRevision: config.COMMUNITY_SEMANTIC_EMBEDDING_REVISION!,
    rerankerModelRevision: config.COMMUNITY_SEMANTIC_RERANKER_REVISION!,
  });
  const transport = new TumuerQwenHttpTransport(
    profile,
    {
      enabled: config.COMMUNITY_SEMANTIC_TRANSMISSION === 'approved',
      origin: TUMUER_QWEN_ORIGIN,
      secretEnvironmentVariable: 'WHALEU_TUMUER_SEMANTIC_API_KEY',
      timeoutMs: config.COMMUNITY_SEMANTIC_TIMEOUT_MS,
    },
    {
      fetch: (url, init) => fetch(url, init),
      resolveSecret: (name) => process.env[name],
    },
  );
  return new QwenSemanticProvider(profile, transport, {
    timeoutMs: config.COMMUNITY_SEMANTIC_TIMEOUT_MS,
  });
}

@Injectable()
export class SemanticSearchRuntime {
  private readonly engine: SemanticSearchEngine | null;
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(SEMANTIC_MODEL_PROVIDER) provider: QwenSemanticProvider | null,
    @Inject(SearchService) searches: SearchService,
    @Inject(LocalApprovedContentVisibility)
    visibility: LocalApprovedContentVisibility,
    @Inject(CampusContentScopeFacade) campuses: CampusContentScopeFacade,
    @Inject(SafetySearchEligibilityFacade)
    safety: SafetySearchEligibilityFacade,
    @Inject(MediaContentSnapshotFacade) media: MediaContentSnapshotFacade,
  ) {
    if (!provider || config.COMMUNITY_SEMANTIC_SEARCH === 'disabled') {
      this.engine = null;
      return;
    }
    const index = new SemanticIndexRepository();
    const certificates = new ContentReviewSearchEligibilityFacade(
      visibility,
      campuses,
      media,
    );
    const corpus = new SemanticCorpusRepository(safety);
    this.engine = new SemanticSearchEngine(
      provider,
      index,
      fullCorpusScopeAuthority(
        searches,
        index,
        certificates,
        corpus,
        provider.profile,
      ),
      'configured',
      certificates,
    );
  }
  async search(
    token: string | null,
    query: SearchQuery,
  ): Promise<SemanticSearchPage> {
    if (!this.engine || this.config.COMMUNITY_SEMANTIC_SEARCH === 'disabled')
      throw new ApplicationError('SEMANTIC_SEARCH_DISABLED');
    if (token === null && (query.type === 'comment' || query.type === 'reply'))
      throw new ApplicationError('AUTHENTICATION_REQUIRED');
    const result = await this.engine.search(token, query);
    if (result.mode !== 'exact-full-corpus-v1')
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const parsed = semanticSearchPageSchema.safeParse({
      mode: 'semantic',
      indexStatus: 'current',
      ranking: 'embedding-top32-reranked',
      items: result.items,
    });
    if (!parsed.success) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return parsed.data;
  }
}
