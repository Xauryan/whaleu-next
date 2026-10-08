/** Test-only scalar owner lane. Keeps metadata batching, real policy providers,
 * structural matching, cursor operations and mandatory final proof identical. */
import type { PoolClient } from 'pg';
import type { SearchReadContext } from '../../src/community/content-review/search-read-context.js';
import type { SearchService } from '../../src/community/search/service.js';
export async function withScalarCanonicalReads<T>(
  service: SearchService,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = service as unknown as {
    canonicalReadContext(tx: PoolClient): SearchReadContext | undefined;
  };
  const original = owner.canonicalReadContext;
  owner.canonicalReadContext = () => undefined;
  try {
    return await operation();
  } finally {
    owner.canonicalReadContext = original;
  }
}
