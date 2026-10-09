import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../../../http/application-error.js';
import { searchCandidateKey } from '../repository.js';
import type { SearchCandidate } from '../repository.js';
import { normalizeSemanticVector } from './provider.js';
import type {
  SemanticDocumentEmbedding,
  SemanticEmbedding,
} from './provider.js';
import { requireQwenSemanticProfile } from './profile.js';
import type { QwenSemanticProfile } from './profile.js';
import { semanticRevisionSchema } from './contracts.js';
import type {
  SemanticAuthorizedSource,
  SemanticSourceRevision,
} from './contracts.js';

const unavailable = () => new ApplicationError('COMMUNITY_UNAVAILABLE');
const rankSchema = z.strictObject({
  key: z.string(),
  distance: z.number().finite().min(0).max(2),
});
export interface SemanticRank {
  readonly key: string;
  readonly distance: number;
}

/** Optional pgvector persistence. No body text, author projection, HTTP route,
 * ANN graph, service-account authority or provider I/O belongs to this owner. */
export class SemanticIndexRepository {
  async revision(
    candidate: SearchCandidate,
    tx: PoolClient,
  ): Promise<SemanticSourceRevision> {
    const result = await tx.query<{ revision: unknown }>(
      'SELECT whaleu_semantic.source_revision($1,$2) AS revision',
      [candidate.kind, candidate.id],
    );
    const parsed = semanticRevisionSchema.safeParse(result.rows[0]?.revision);
    const chain = [
      ['post', candidate.postId],
      ...(candidate.rootCommentId
        ? [['comment', candidate.rootCommentId]]
        : []),
      ...(candidate.kind === 'reply' ? [['reply', candidate.id]] : []),
    ];
    if (
      !parsed.success ||
      parsed.data.length !== chain.length ||
      parsed.data.some(
        (node, i) => node[0] !== chain[i]![0] || node[1] !== chain[i]![1],
      )
    )
      throw unavailable();
    return parsed.data;
  }

  async upsert(
    profile: QwenSemanticProfile,
    source: SemanticAuthorizedSource,
    embedding: SemanticDocumentEmbedding,
    tx: PoolClient,
  ): Promise<void> {
    requireQwenSemanticProfile(profile);
    if (
      embedding.indexSpaceKey !== profile.indexSpaceKey ||
      embedding.id !== searchCandidateKey(source.candidate) ||
      embedding.bodyDigest !== source.bodyDigest
    )
      throw unavailable();
    const vector = normalizeSemanticVector(
      embedding.vector,
      profile.dimensions,
    );
    const written = await tx.query<{
      index_space_key: string;
      kind: string;
      content_id: string;
      matches: boolean;
    }>(
      `INSERT INTO whaleu_semantic.embeddings(index_space_key,kind,content_id,post_id,root_comment_id,source_revision,body_digest,embedding)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::public.vector)
       ON CONFLICT(index_space_key,kind,content_id) DO UPDATE SET
       source_revision=EXCLUDED.source_revision,body_digest=EXCLUDED.body_digest,embedding=EXCLUDED.embedding,
       post_id=EXCLUDED.post_id,root_comment_id=EXCLUDED.root_comment_id
       RETURNING index_space_key,kind,content_id,(embedding OPERATOR(public.=) $8::public.vector) AS matches`,
      [
        profile.indexSpaceKey,
        source.candidate.kind,
        source.candidate.id,
        source.candidate.postId,
        source.candidate.rootCommentId,
        JSON.stringify(source.revision),
        source.bodyDigest,
        JSON.stringify(vector),
      ],
    );
    const row = written.rows[0];
    if (
      written.rowCount !== 1 ||
      written.rows.length !== 1 ||
      !row ||
      row.index_space_key !== profile.indexSpaceKey ||
      row.kind !== source.candidate.kind ||
      row.content_id !== source.candidate.id ||
      row.matches !== true
    )
      throw unavailable();
  }

  /** Every row in `sources` is already canonical-authorized in this transaction.
   * The MATERIALIZED relation excludes denied/stale vectors before distance is
   * evaluated. Missing current entries are unavailable, never fewer/zero hits.
   * Only a bounded distance result reaches JS, never the corpus vectors. */
  async rank(
    profile: QwenSemanticProfile,
    query: SemanticEmbedding,
    sources: readonly SemanticAuthorizedSource[],
    tx: PoolClient,
  ): Promise<SemanticRank[]> {
    requireQwenSemanticProfile(profile);
    if (query.indexSpaceKey !== profile.indexSpaceKey || sources.length > 128)
      throw unavailable();
    const vector = normalizeSemanticVector(query.vector, profile.dimensions);
    const keys = sources.map((source) => searchCandidateKey(source.candidate));
    if (new Set(keys).size !== keys.length) throw unavailable();
    const expected = sources.map((source) => ({
      key: searchCandidateKey(source.candidate),
      kind: source.candidate.kind,
      id: source.candidate.id,
      revision: source.revision,
      body: source.bodyDigest,
    }));
    const result = await tx.query<SemanticRank>(
      `WITH allowed AS MATERIALIZED (
        SELECT wanted.key,e.embedding FROM jsonb_to_recordset($2::jsonb)
        AS wanted(key text,kind text,id uuid,revision jsonb,body text)
        JOIN whaleu_semantic.embeddings e ON e.index_space_key=$1 AND e.kind=wanted.kind
          AND e.content_id=wanted.id AND e.source_revision=wanted.revision AND e.body_digest=wanted.body
      ) SELECT key,(embedding OPERATOR(public.<=>) $3::public.vector) AS distance
      FROM allowed ORDER BY distance ASC,key COLLATE "C" ASC`,
      [profile.indexSpaceKey, JSON.stringify(expected), JSON.stringify(vector)],
    );
    if (result.rows.length !== sources.length) throw unavailable();
    const seen = new Set<string>();
    for (const row of result.rows) {
      if (
        !rankSchema.safeParse(row).success ||
        !keys.includes(row.key) ||
        seen.has(row.key)
      )
        throw unavailable();
      seen.add(row.key);
    }
    return result.rows;
  }
}
