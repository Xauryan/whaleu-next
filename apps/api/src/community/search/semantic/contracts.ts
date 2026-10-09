import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { SearchHit, SearchQuery } from '../contracts.js';
import type { SearchAnchor } from '../cursor.js';
import type { SemanticEmbedding } from './provider.js';
import type { SearchCandidate } from '../repository.js';
import { canonicalJson } from '../../content-review/contracts.js';

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
// Own incarnation plus exact immutable review definition and monotonic head event.
export const semanticRevisionSchema = z
  .array(
    z.tuple([
      z.enum(['post', 'comment', 'reply']),
      uuid,
      uuid,
      digest,
      uuid,
      uuid,
      uuid,
    ]),
  )
  .min(1)
  .max(3);
export type SemanticSourceRevision = z.infer<typeof semanticRevisionSchema>;
export interface SemanticAuthorizedSource {
  readonly candidate: Readonly<SearchCandidate>;
  readonly revision: SemanticSourceRevision;
  readonly fingerprint: string;
  readonly bodyDigest: string;
  readonly text: string;
}
export const semanticFingerprint = (value: unknown): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');

export interface SemanticScopeSnapshot {
  readonly fingerprint: string;
  readonly sources: readonly SemanticAuthorizedSource[];
  readonly nonTextSources?: readonly SemanticAuthorizedSource[];
  readonly deniedSources?: readonly SearchCandidate[];
  /** A fresh narrow public projection, only valid in this transaction. */
  project(keys: readonly string[]): Promise<SearchHit[]>;
  readonly ranks?: readonly { key: string; distance: number }[];
  readonly corpus?: 'full' | 'oracle';
}
/** Internal transaction port. The callback may do local SQL only, never provider
 * I/O. It must not retain tx/project. Returning waits for mandatory owner proofs
 * and transaction commit, not just callback completion. */
export interface SemanticScopeAuthority {
  preflight(token: string | null, query: SearchQuery): Promise<void>;
  withSources<T>(
    token: string | null,
    query: SearchQuery,
    sources: readonly Pick<SearchAnchor, 'kind' | 'id'>[],
    operation: (snapshot: SemanticScopeSnapshot, tx: PoolClient) => Promise<T>,
  ): Promise<T>;
  withScope<T>(
    token: string | null,
    query: SearchQuery,
    operation: (snapshot: SemanticScopeSnapshot, tx: PoolClient) => Promise<T>,
    intent?: 'index' | 'search',
    embedding?: SemanticEmbedding,
  ): Promise<T>;
}
