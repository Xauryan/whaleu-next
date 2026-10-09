import type { SearchQuery } from '../contracts.js';
import type { SearchAnchor } from '../cursor.js';
import type { SearchService } from '../service.js';
import type { SemanticSearchEngine } from './engine.js';

export interface SemanticIndexCheckpoint {
  readonly scopeFingerprint: string;
  readonly after: SearchAnchor;
}
/** One explicit bounded batch. The caller may durably retain `next` and resume;
 * repeating a batch is safe through current revision/profile CAS upserts. No
 * scheduler, invented service identity, provider activation or completeness
 * certificate is created. End of enumeration does NOT prove historical coverage. */
export async function indexNextSemanticBatch(
  searches: SearchService,
  engine: SemanticSearchEngine,
  token: string | null,
  query: SearchQuery,
  checkpoint: SemanticIndexCheckpoint | null = null,
): Promise<{ indexed: number; next: SemanticIndexCheckpoint | null }> {
  const page = await searches.semanticSourceBatch(token, query, checkpoint);
  const result = await engine.indexSources(token, query, page.sources);
  return { indexed: result.indexed, next: page.next };
}
