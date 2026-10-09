import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../../../http/application-error.js';
import { registerTransactionDeadline } from '../../../database/transaction-deadlines.js';
import { SafetySearchEligibilityFacade } from '../../../safety/search-eligibility.facade.js';
import { requireSearchContentEligibilityRelation } from '../../content-review/search-eligibility.facade.js';
import type { SearchContentEligibilityRelation } from '../../content-review/search-eligibility.facade.js';
import { searchCandidateSchema, SEARCH_SCAN_BATCH } from '../repository.js';
import type { SearchCandidate } from '../repository.js';
import { requireQwenSemanticProfile } from './profile.js';
import type { QwenSemanticProfile } from './profile.js';
import { normalizeSemanticVector } from './provider.js';
import type { SemanticEmbedding } from './provider.js';
import { semanticRevisionSchema } from './contracts.js';
import type { SemanticSourceRevision } from './contracts.js';

const unavailable = () => new ApplicationError('COMMUNITY_UNAVAILABLE');
const rowSchema = searchCandidateSchema.safeExtend({
  key: z.string(),
  distance: z.number().finite().min(0).max(2),
  revision: semanticRevisionSchema,
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export interface SemanticCorpusCandidate {
  readonly candidate: SearchCandidate;
  readonly key: string;
  readonly distance: number;
  readonly revision: SemanticSourceRevision;
  readonly bodyDigest: string;
}
export interface SemanticCorpusSelection {
  readonly fingerprint: string;
  readonly candidates: readonly SemanticCorpusCandidate[];
}

/** Full-scope exact pgvector retrieval. Owner-issued metadata relation first,
 * parent-first canonical base/Safety tri-state next, distance computation last.
 * No source-body/embedding postfilter budget or shared approximate graph. */
export class SemanticCorpusRepository {
  constructor(private readonly safety: SafetySearchEligibilityFacade) {}
  async select(
    relation: SearchContentEligibilityRelation,
    actor: string | null,
    profile: QwenSemanticProfile,
    query: SemanticEmbedding,
    tx: PoolClient,
  ): Promise<SemanticCorpusSelection> {
    requireSearchContentEligibilityRelation(relation, tx);
    requireQwenSemanticProfile(profile);
    if (query.indexSpaceKey !== profile.indexSpaceKey) throw unavailable();
    const vector = normalizeSemanticVector(query.vector, profile.dimensions);
    const table = `semantic_eligibility_${randomUUID().replaceAll('-', '')}`;
    const nodes = relation.nodesTableName,
      base = relation.tableName;
    const safety = this.safety.relation({ nodes, viewerParameter: 1 });
    const postBase = "COALESCE(p.base_decision,'unknown')";
    const postSafety = "COALESCE(ps.decision,'unknown')";
    const rootBase = "COALESCE(r.base_decision,'unknown')";
    const rootSafety = "COALESCE(rs.decision,'unknown')";
    const replyBase = "COALESCE(l.base_decision,'unknown')";
    const replySafety = "COALESCE(ls.decision,'unknown')";
    const afterPostBase = `${postBase}='allow'`;
    const afterPost = `${afterPostBase} AND ${postSafety}='allow'`;
    const afterRootBase = `${afterPost} AND b.root_safety_key IS NOT NULL AND ${rootBase}='allow'`;
    const afterRoot = `${afterRootBase} AND ${rootSafety}='allow'`;
    const afterReplyBase = `${afterRoot} AND b.reply_safety_key IS NOT NULL AND ${replyBase}='allow'`;
    await tx.query(
      `CREATE TEMP TABLE ${table} ON COMMIT DROP AS
      WITH safety AS MATERIALIZED (${safety})
      SELECT b.*,CASE
        WHEN ${postBase}<>'allow' THEN ${postBase}
        WHEN ${postSafety}<>'allow' THEN ${postSafety}
        WHEN b.root_safety_key IS NOT NULL AND ${rootBase}<>'allow' THEN ${rootBase}
        WHEN b.root_safety_key IS NOT NULL AND ${rootSafety}<>'allow' THEN ${rootSafety}
        WHEN b.reply_safety_key IS NOT NULL AND ${replyBase}<>'allow' THEN ${replyBase}
        WHEN b.reply_safety_key IS NOT NULL AND ${replySafety}<>'allow' THEN ${replySafety}
        ELSE 'allow' END AS eligibility,
        LEAST(p.base_valid_until,
          CASE WHEN ${afterPostBase} THEN ps.valid_until END,
          CASE WHEN ${afterPost} THEN r.base_valid_until END,
          CASE WHEN ${afterRootBase} THEN rs.valid_until END,
          CASE WHEN ${afterRoot} THEN l.base_valid_until END,
          CASE WHEN ${afterReplyBase} THEN ls.valid_until END) AS deadline
      FROM ${base} b
      LEFT JOIN ${nodes} p ON p.node_key=b.post_safety_key
      LEFT JOIN safety ps ON ps.node_key=b.post_safety_key
      LEFT JOIN ${nodes} r ON r.node_key=b.root_safety_key
      LEFT JOIN safety rs ON rs.node_key=b.root_safety_key
      LEFT JOIN ${nodes} l ON l.node_key=b.reply_safety_key
      LEFT JOIN safety ls ON ls.node_key=b.reply_safety_key`,
      [actor],
    );
    const state = (
      await tx.query<{
        unknown: boolean | null;
        deadline: Date | null;
        fingerprint: string;
      }>(
        `SELECT bool_or(eligibility='unknown') AS unknown,min(deadline) AS deadline,
       encode(sha256(convert_to(COALESCE(string_agg(jsonb_build_array(kind,id,"spaceId","postId","rootCommentId",at,eligibility,
         CASE WHEN eligibility='allow' THEN source_revision ELSE NULL END,
         CASE WHEN eligibility='allow' THEN body_digest ELSE NULL END,
         CASE WHEN eligibility='allow' THEN has_searchable_text ELSE NULL END)::text,'' ORDER BY key COLLATE "C"),''),'UTF8')),'hex') AS fingerprint
       FROM ${table}`,
      )
    ).rows[0];
    if (
      !state ||
      state.unknown === true ||
      !/^[a-f0-9]{64}$/.test(state.fingerprint)
    )
      throw unavailable();
    registerTransactionDeadline(
      tx,
      state.deadline?.getTime() ?? null,
      'COMMUNITY_UNAVAILABLE',
    );
    // A known empty body is not a text retrieval source. Its certificate and
    // current authorization still participated in the complete scope proof.
    const allowed = `semantic_allowed_${randomUUID().replaceAll('-', '')}`;
    await tx.query(`CREATE TEMP TABLE ${allowed} ON COMMIT DROP AS SELECT * FROM ${table}
      WHERE eligibility='allow' AND has_searchable_text IS TRUE`);
    const join = `e.index_space_key=$1 AND e.kind=a.kind AND e.content_id=a.id AND e.source_revision=a.source_revision AND e.body_digest=a.body_digest`;
    const missing = (
      await tx.query<{ missing: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM ${allowed} a
      LEFT JOIN whaleu_semantic.embeddings e ON ${join} WHERE e.content_id IS NULL) AS missing`,
        [profile.indexSpaceKey],
      )
    ).rows[0];
    if (missing?.missing !== false) throw unavailable();
    const result = await tx.query(
      `SELECT a.key,a.kind,a.id,a."spaceId",a."postId",a."rootCommentId",a.at,
      a.source_revision AS revision,a.body_digest AS "bodyDigest",
      (e.embedding OPERATOR(public.<=>) $2::public.vector) AS distance
      FROM ${allowed} a JOIN whaleu_semantic.embeddings e ON ${join}
      ORDER BY distance ASC,a.key COLLATE "C" ASC LIMIT ${SEARCH_SCAN_BATCH}`,
      [profile.indexSpaceKey, JSON.stringify(vector)],
    );
    const seen = new Set<string>();
    const candidates = result.rows.map((raw) => {
      const parsed = rowSchema.safeParse(raw);
      if (!parsed.success) throw unavailable();
      const { key, distance, revision, bodyDigest, ...candidate } = parsed.data;
      if (key !== `${candidate.kind}:${candidate.id}` || seen.has(key))
        throw unavailable();
      seen.add(key);
      return { candidate, key, distance, revision, bodyDigest };
    });
    relation.assertCurrent(tx);
    return { fingerprint: state.fingerprint, candidates };
  }
}
