import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CampusContentScopeFacade } from '../../campus/content-scope.facade.js';
import {
  transactionReadEpoch,
  registerTransactionDeadline,
} from '../../database/transaction-deadlines.js';
import { SnapshotReadBudget } from './count-snapshot.repository.js';
import {
  MediaContentSnapshotFacade,
  UnavailableMediaContentSnapshotFacade,
  mediaContentKey,
} from '../../media/content-snapshot.facade.js';
import type { MediaContentFact } from '../../media/content-snapshot.facade.js';
import {
  captureSemanticMediaProof,
  requireSemanticMediaProof,
} from '../search/semantic/eligibility-proof.js';
import {
  semanticMediaChainSchema,
  semanticMediaNode,
} from '../search/semantic/media-certificate.js';
import type { SemanticMediaChain } from '../search/semantic/media-certificate.js';
import { ApplicationError } from '../../http/application-error.js';
import { categorySchema } from '../contracts.js';
import type { ContentKind } from './contracts.js';
import { validateApprovalMetadata } from './approval-metadata.js';
import type { ApprovalMetadata } from './approval-metadata.js';
import { LocalApprovedContentVisibility } from './local-approved-content-visibility.js';
import type { SearchReadContext } from './search-read-context.js';
import {
  searchCandidateKey,
  searchCandidateSchema,
} from '../search/repository.js';
import type {
  SearchCandidate,
  SearchStructuralScope,
} from '../search/repository.js';
import {
  semanticFingerprint,
  semanticRevisionSchema,
} from '../search/semantic/contracts.js';
import type { SemanticAuthorizedSource } from '../search/semantic/contracts.js';
import { requireQwenSemanticProfile } from '../search/semantic/profile.js';
import type { QwenSemanticProfile } from '../search/semantic/profile.js';

const unavailable = () => new ApplicationError('COMMUNITY_UNAVAILABLE');
const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const SEARCH_CONTENT_METADATA_LIMIT = 100_000;
const certificateSchema = z.strictObject({
  index_space_key: digest,
  kind: z.enum(['post', 'comment', 'reply']),
  content_id: uuid,
  post_id: uuid,
  root_comment_id: uuid.nullable(),
  source_revision: semanticRevisionSchema,
  body_digest: digest,
  has_searchable_text: z.boolean(),
  space_id: uuid,
  region_id: uuid.nullable(),
  certificate_version: z.literal(1),
  valid_until: z.date().nullable(),
});
export const certificateV2Schema = certificateSchema
  .extend({
    certificate_version: z.literal(2),
    media_chain: semanticMediaChainSchema,
  })
  .superRefine((certificate, ctx) => {
    if (
      certificate.media_chain.length !== certificate.source_revision.length ||
      certificate.media_chain.some(
        (node, index) =>
          node.kind !== certificate.source_revision[index]?.[0] ||
          node.id !== certificate.source_revision[index]?.[1],
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Incomplete Media ancestry' });
  });
const anyCertificateSchema = z.union([certificateSchema, certificateV2Schema]);
/** Persistent evidence contains neither body nor approval envelope. Its complete
 * ordered revision chain binds every ancestor, not merely the leaf lifecycle. */
export type SearchContentCertificate = Readonly<
  z.infer<typeof anyCertificateSchema>
>;
export type SearchContentDecision = 'allow' | 'deny' | 'unknown';
interface Conditional {
  decision: SearchContentDecision;
  validUntil: number | null;
  eligibilityRevision?: unknown;
}
const minimum = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b);

export interface SearchContentNode extends ApprovalMetadata {
  kind: ContentKind;
  id: string;
  post_id: string;
  root_comment_id: string | null;
  account_id: string;
  author_mode: 'named' | 'anonymous';
  visibility: string;
  deleted_at: Date | null;
  publication_state: string | null;
  generation: string | null;
  digest: string | null;
  decision_id: string | null;
  event_id: string | null;
  stored_certificate?: unknown;
  stored_certificate_v2?: unknown;
  expected_images?: unknown;
  images?: readonly { assetId: string; digest: string; position: number }[];
  media_fact?: MediaContentFact;
  exact_time_valid: boolean;
  read_at?: Date;
}
interface StructuralRow extends SearchCandidate {
  space_active: boolean | null;
  space_kind: string | null;
  region_id: string | null;
  certificate: unknown;
  certificate_v2?: unknown;
  current_revision: unknown;
}
/** Internal transaction handle, never an HTTP DTO or a bag of caller supplied
 * IDs. SQL consumers must assert its lifetime before using either relation. */
export interface SearchContentEligibilityRelation {
  readonly tableName: string;
  readonly nodesTableName: string;
  readonly validUntil: number | null;
  readonly mediaAware?: boolean;
  assertCurrent(tx: PoolClient): void;
}
const handles = new WeakSet<object>();
export function requireSearchContentEligibilityRelation(
  relation: SearchContentEligibilityRelation,
  tx: PoolClient,
): void {
  if (!handles.has(relation)) throw unavailable();
  relation.assertCurrent(tx);
}

/** SQL retains PostgreSQL microseconds for all ordering/not-before predicates.
 * JavaScript deadlines are deliberately rounded down, a conservative earlier
 * cutoff; they must never be used to authorize a future event in the same ms. */
export const SEARCH_APPROVAL_EXACT_TIME_PREDICATE = `(
 d.evaluated_at<=timing.now AND e.occurred_at<=timing.now AND e.occurred_at>=d.evaluated_at
 AND p.valid_from<=d.evaluated_at AND (p.valid_until IS NULL OR p.valid_until>timing.now)
 AND d.consume_until>d.evaluated_at AND (d.visibility_until IS NULL OR d.visibility_until>timing.now)
)`;

const metadataProjection = `d.policy_revision_id,d.result,d.coverage,d.provenance,d.issuer,d.provenance_ref,
 d.evaluated_at,d.consume_until,d.visibility_model,d.visibility_until,
 p.policy_key,p.version AS policy_version,p.coverage AS policy_coverage,p.provenance AS policy_provenance,
 p.issuer AS policy_issuer,p.provenance_ref AS policy_provenance_ref,p.valid_from AS policy_valid_from,
 p.valid_until AS policy_valid_until,e.state,e.occurred_at AS event_at,e.coverage AS event_coverage,
 e.provenance AS event_provenance,e.issuer AS event_issuer,e.provenance_ref AS event_provenance_ref`;
const chain = (candidate: SearchCandidate): [ContentKind, string][] => [
  ['post', candidate.postId],
  ...(candidate.rootCommentId
    ? [['comment', candidate.rootCommentId] as [ContentKind, string]]
    : []),
  ...(candidate.kind === 'reply'
    ? [['reply', candidate.id] as [ContentKind, string]]
    : []),
];

/** Pure cheap evaluator. Exact definition reconstruction is intentionally absent:
 * only a certificate minted by the canonical owner can close that evidence.
 * Structural denial precedes missing evidence. Review denial is usable only
 * with certified immutable approval evidence; malformed evidence stays unknown. */
export function evaluateSearchContentCertificate(
  candidate: SearchCandidate,
  certificate: SearchContentCertificate | null,
  nodes: ReadonlyMap<string, SearchContentNode>,
  scope: {
    active: boolean;
    kind: string | null;
    regionId: string | null;
    regionActive: boolean;
  },
  indexSpaceKey: string,
  now: number,
): Conditional {
  const ancestry = chain(candidate);
  const certified =
    certificate !== null &&
    certificate.index_space_key === indexSpaceKey &&
    certificate.kind === candidate.kind &&
    certificate.content_id === candidate.id &&
    certificate.post_id === candidate.postId &&
    certificate.root_comment_id === candidate.rootCommentId &&
    certificate.space_id === candidate.spaceId &&
    certificate.region_id === scope.regionId &&
    certificate.source_revision.length === ancestry.length &&
    (certificate.certificate_version === 1 ||
      certificateV2Schema.safeParse(certificate).success);
  let until: number | null = null;
  const consumed: unknown[] = [];
  const finish = (decision: SearchContentDecision): Conditional => ({
    decision,
    validUntil: until,
    ...(certificate?.certificate_version === 2
      ? {
          eligibilityRevision: [
            'semantic-media-eligibility-v2',
            certificate.source_revision,
            certificate.media_chain,
            consumed,
            decision,
            until,
          ],
        }
      : {}),
  });
  for (const [index, [kind, id]] of ancestry.entries()) {
    const node = nodes.get(`${kind}:${id}`);
    if (!node || node.deleted_at || node.visibility !== 'approved')
      return finish('deny');
    if (kind === 'post' && (!scope.active || !scope.regionActive))
      return finish('deny');
    if (
      node.post_id !== candidate.postId ||
      (kind !== 'post' && node.root_comment_id !== candidate.rootCommentId) ||
      (kind === 'post' && node.publication_state !== 'published') ||
      !['regional', 'global'].includes(scope.kind ?? '')
    )
      return finish('unknown');
    if (!certified || !certificate) return finish('unknown');
    const revision = certificate.source_revision[index]!;
    consumed.push([
      kind,
      id,
      node.generation,
      node.digest,
      node.decision_id,
      node.policy_revision_id,
      node.event_id,
    ]);
    if (
      revision[0] !== kind ||
      revision[1] !== id ||
      revision[2] !== node.generation ||
      revision[3] !== node.digest ||
      revision[4] !== node.decision_id ||
      revision[5] !== node.policy_revision_id ||
      node.exact_time_valid !== true
    )
      return finish('unknown');
    const reviewed = validateApprovalMetadata(node, false, now);
    until = minimum(until, reviewed.optionalUntil);
    if (reviewed.decision.kind !== 'allow')
      return finish(reviewed.decision.kind === 'deny' ? 'deny' : 'unknown');
    if (revision[6] !== node.event_id) return finish('unknown');
    const images = exactNodeImages(node);
    if (!images) return finish('unknown');
    if (certificate.certificate_version === 1) {
      // V1 authority is limited to a CURRENT, explicitly proved all-empty chain.
      if (images.length) return finish('unknown');
      continue;
    }
    const current =
      node.media_fact && semanticMediaNode(kind, id, node.media_fact);
    const stored = certificate.media_chain[index];
    if (!current || !stored || current.decision === 'review-denied')
      return finish('unknown');
    consumed.push(current);
    until = minimum(until, current.validUntil);
    if (current.validUntil !== null && current.validUntil <= now)
      return finish('unknown');
    const immutableAttachments = (attachments: typeof current.attachments) =>
      attachments.map((attachment) => ({
        slot: attachment.slot,
        ordinal: attachment.ordinal,
        bindingId: attachment.bindingId,
        assetId: attachment.assetId,
        manifestDigest: attachment.manifestDigest,
        policyRevision: attachment.policyRevision,
        intentId: attachment.intentId,
        intentState: attachment.intentState,
      }));
    if (
      stored.decision === 'review-denied' ||
      semanticFingerprint(immutableAttachments(current.attachments)) !==
        semanticFingerprint(immutableAttachments(stored.attachments))
    )
      return finish('unknown');
    if (current.decision === 'deny') return finish('deny');
    // Equality includes binding identity and the monotonic head/event. A -> B ->
    // A-looking C cannot revive old authority, while text vector identity stays V1.
    if (semanticFingerprint(current) !== semanticFingerprint(stored))
      return finish('unknown');
  }
  if (
    !certificate ||
    (certificate.valid_until?.getTime() ?? null) !== until ||
    (until !== null && until <= now)
  )
    return finish('unknown');
  return finish('allow');
}

const imageIdentitySchema = z
  .array(z.strictObject({ assetId: uuid, digest }))
  .max(9);
function exactNodeImages(
  node: SearchContentNode,
): { assetId: string; digest: string }[] | null {
  const expected = imageIdentitySchema.safeParse(node.expected_images);
  if (
    !expected.success ||
    !node.images ||
    node.images.some((image, index) => image.position !== index)
  )
    return null;
  const current = imageIdentitySchema.safeParse(
    node.images.map(({ assetId, digest }) => ({ assetId, digest })),
  );
  return current.success &&
    semanticFingerprint(current.data) === semanticFingerprint(expected.data)
    ? current.data
    : null;
}
function decodeCertificate(raw: unknown): SearchContentCertificate | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const parsed = anyCertificateSchema.safeParse({
    ...value,
    valid_until:
      value['valid_until'] === null
        ? null
        : new Date(String(value['valid_until'])),
  });
  return parsed.success ? parsed.data : null;
}

/** Canonical community owner. Query work is O(scope metadata), not O(definition
 * size) and not a disguised 128-row corpus window. The 100k operational bound
 * fails explicitly; 128 remains solely the later final-proof/rank budget.
 * Callers capture all required owner epochs before prepare and finally fence
 * them after canonical page work; a handle alone is not a final owner proof. */
export class ContentReviewSearchEligibilityFacade {
  private readonly captures = new WeakMap<
    object,
    {
      tx: PoolClient;
      epoch: object;
      encoded: string;
      ancestors: readonly SearchContentCertificate[];
    }
  >();
  constructor(
    private readonly visibility: LocalApprovedContentVisibility,
    private readonly campuses: CampusContentScopeFacade,
    private readonly media: MediaContentSnapshotFacade = new UnavailableMediaContentSnapshotFacade(),
  ) {}

  private async hasV2(tx: PoolClient): Promise<boolean> {
    return (
      (
        await tx.query<{ present: boolean }>(
          "SELECT to_regclass('whaleu_semantic.certificates_v2') IS NOT NULL AS present",
        )
      ).rows[0]?.present === true
    );
  }

  private async nodes(
    candidates: readonly SearchCandidate[],
    tx: PoolClient,
    indexSpaceKey: string | null = null,
    mediaAware = false,
    activePosts?: ReadonlySet<string>,
  ): Promise<Map<string, SearchContentNode>> {
    const all = new Map<string, SearchContentNode>();
    for (let offset = 0; offset < candidates.length; offset += 256) {
      const keys = new Map(
        candidates
          .slice(offset, offset + 256)
          .flatMap(chain)
          .map(([kind, id]) => [`${kind}:${id}`, { kind, id }]),
      );
      const budget = new SnapshotReadBudget();
      const rows = await budget.rows<SearchContentNode>(
        tx,
        `WITH timing AS MATERIALIZED (SELECT clock_timestamp() AS now), wanted AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id uuid)),
         sources AS (
           SELECT 'post'::text kind,s.id,s.id post_id,NULL::uuid root_comment_id,s.account_id,s.author_mode,
             s.visibility,s.deleted_at,s.publication_state FROM whaleu_community.posts s JOIN wanted w ON w.kind='post' AND w.id=s.id
           UNION ALL SELECT 'comment',s.id,s.post_id,s.id,s.account_id,s.author_mode,s.visibility,s.deleted_at,NULL::text
             FROM whaleu_community.root_comments s JOIN wanted w ON w.kind='comment' AND w.id=s.id
           UNION ALL SELECT 'reply',s.id,s.post_id,s.root_comment_id,s.account_id,s.author_mode,s.visibility,s.deleted_at,NULL::text
             FROM whaleu_community.replies s JOIN wanted w ON w.kind='reply' AND w.id=s.id
         ) SELECT s.*,timing.now AS read_at,g.generation,b.digest,b.decision_id,h.event_id,b.envelope->'images' AS expected_images,
         CASE WHEN cert.content_id IS NULL THEN NULL ELSE to_jsonb(cert) END AS stored_certificate,
         ${mediaAware ? 'CASE WHEN cv2.content_id IS NULL THEN NULL ELSE to_jsonb(cv2) END' : 'NULL::jsonb'} AS stored_certificate_v2,
         ${SEARCH_APPROVAL_EXACT_TIME_PREDICATE} AS exact_time_valid,${metadataProjection}
         FROM sources s CROSS JOIN timing LEFT JOIN whaleu_semantic.source_generations g ON g.kind=s.kind AND g.content_id=s.id
         LEFT JOIN whaleu_community.content_approval_bindings b ON b.content_kind=s.kind AND b.content_id=s.id AND b.content_version=1
         LEFT JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id
         LEFT JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id
         LEFT JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id
         LEFT JOIN whaleu_community.content_approval_events e ON e.id=h.event_id AND e.decision_id=d.id
         LEFT JOIN whaleu_semantic.certificates cert ON cert.index_space_key=$2 AND cert.kind=s.kind AND cert.content_id=s.id
         ${mediaAware ? 'LEFT JOIN whaleu_semantic.certificates_v2 cv2 ON cv2.index_space_key=$2 AND cv2.kind=s.kind AND cv2.content_id=s.id' : ''}`,
        [JSON.stringify([...keys.values()]), indexSpaceKey],
        keys.size,
        [
          'read_at',
          'deleted_at',
          'evaluated_at',
          'consume_until',
          'visibility_until',
          'policy_valid_from',
          'policy_valid_until',
          'event_at',
        ],
      );
      const ids = (kind: ContentKind) =>
        [...keys.values()]
          .filter((key) => key.kind === kind)
          .map((key) => key.id);
      const images = await budget.rows<{
        kind: ContentKind;
        id: string;
        assetId: string;
        digest: string;
        position: number;
      }>(
        tx,
        `SELECT * FROM (
          SELECT 'post'::text kind,post_id id,asset_id AS "assetId",digest,position FROM whaleu_community.post_images WHERE post_id=ANY($1::uuid[])
          UNION ALL SELECT 'comment',comment_id,asset_id,digest,position FROM whaleu_community.comment_images WHERE comment_id=ANY($2::uuid[])
          UNION ALL SELECT 'reply',reply_id,asset_id,digest,position FROM whaleu_community.reply_images WHERE reply_id=ANY($3::uuid[])
        ) image_rows ORDER BY kind,id,position`,
        [ids('post'), ids('comment'), ids('reply')],
        9 * ids('post').length +
          3 * ids('comment').length +
          3 * ids('reply').length,
      );
      const grouped = new Map<string, typeof images>();
      for (const image of images) {
        const key = `${image.kind}:${image.id}`;
        const existing = grouped.get(key) ?? [];
        existing.push(image);
        grouped.set(key, existing);
      }
      const references = [];
      for (const node of rows) {
        node.images = grouped.get(`${node.kind}:${node.id}`) ?? [];
        if (
          !mediaAware ||
          node.deleted_at ||
          node.visibility !== 'approved' ||
          (activePosts && !activePosts.has(node.post_id)) ||
          (node.kind === 'post' && node.publication_state !== 'published')
        )
          continue;
        // Review is canonical before Media. Never force unrelated Media after a
        // known earlier review rejection, or turn malformed evidence into denial.
        const reviewed = validateApprovalMetadata(
          node,
          false,
          node.read_at?.getTime() ?? NaN,
        );
        const expected = exactNodeImages(node);
        if (
          node.exact_time_valid !== true ||
          reviewed.decision.kind !== 'allow' ||
          !expected
        )
          continue;
        if (expected.length) requireSemanticMediaProof(tx);
        references.push({
          parent: {
            ownerKind: 'community' as const,
            resourceKind: node.kind,
            resourceId: node.id,
            contentVersion: 1 as const,
          },
          expected,
        });
      }
      let facts: ReadonlyMap<string, MediaContentFact>;
      try {
        facts = await this.media.readBatch(references, tx, budget);
      } catch {
        throw unavailable();
      }
      for (const node of rows) {
        const fact = facts.get(
          mediaContentKey({
            ownerKind: 'community',
            resourceKind: node.kind,
            resourceId: node.id,
            contentVersion: 1,
          }),
        );
        if (fact) node.media_fact = fact;
        all.set(`${node.kind}:${node.id}`, node);
      }
    }
    return all;
  }

  async captureCurrent(
    source: SemanticAuthorizedSource,
    profile: QwenSemanticProfile,
    tx: PoolClient,
    read?: SearchReadContext,
  ): Promise<SearchContentCertificate> {
    return this.capture(source, profile, tx, read, true);
  }

  async captureEligibilityCurrent(
    candidate: SearchCandidate,
    profile: QwenSemanticProfile,
    tx: PoolClient,
    read?: SearchReadContext,
  ): Promise<{
    decision: SearchContentDecision;
    certificate?: SearchContentCertificate;
  }> {
    await captureSemanticMediaProof(tx);
    const nodes = await this.nodes([candidate], tx);
    const hasImages = chain(candidate).some(([kind, id]) => {
      const node = nodes.get(`${kind}:${id}`);
      const images = node && exactNodeImages(node);
      return !images || images.length > 0;
    });
    return hasImages
      ? this.captureEligibilityV2(candidate, profile, tx, read)
      : this.captureEligibility(candidate, profile, tx, read);
  }

  async capture(
    source: SemanticAuthorizedSource,
    profile: QwenSemanticProfile,
    tx: PoolClient,
    read?: SearchReadContext,
    currentMedia = false,
  ): Promise<SearchContentCertificate> {
    if (
      !semanticRevisionSchema.safeParse(source.revision).success ||
      source.bodyDigest !==
        createHash('sha256').update(source.text, 'utf8').digest('hex')
    )
      throw unavailable();
    const result = await (
      currentMedia
        ? this.captureEligibilityCurrent.bind(this)
        : this.captureEligibility.bind(this)
    )(source.candidate, profile, tx, read);
    if (
      result.decision !== 'allow' ||
      !result.certificate ||
      result.certificate.body_digest !== source.bodyDigest ||
      semanticFingerprint(result.certificate.source_revision) !==
        semanticFingerprint(source.revision)
    )
      throw unavailable();
    return result.certificate;
  }

  /** Certificate-only backfill port. A canonical rejection still validates the
   * exact immutable approval envelope through LocalApprovedContentVisibility.
   * Its scalar short circuit deliberately does not invent a new definition
   * requirement after rejection. No body is returned and denied text never
   * reaches a provider. A new allow head cannot reuse this rejection evidence.
   * The first denied ancestor is enough; return its certificate for persistence
   * and let the query's ordered role composition suppress its whole subtree. */
  async captureEligibility(
    candidate: SearchCandidate,
    profile: QwenSemanticProfile,
    tx: PoolClient,
    read?: SearchReadContext,
  ): Promise<{
    decision: SearchContentDecision;
    certificate?: SearchContentCertificate;
  }> {
    return this.captureVersion(candidate, profile, tx, read, 1);
  }

  async captureEligibilityV2(
    candidate: SearchCandidate,
    profile: QwenSemanticProfile,
    tx: PoolClient,
    read?: SearchReadContext,
  ): Promise<{
    decision: SearchContentDecision;
    certificate?: SearchContentCertificate;
  }> {
    await captureSemanticMediaProof(tx);
    if (!(await this.hasV2(tx))) throw unavailable();
    return this.captureVersion(candidate, profile, tx, read, 2);
  }

  private async captureVersion(
    candidate: SearchCandidate,
    profile: QwenSemanticProfile,
    tx: PoolClient,
    read: SearchReadContext | undefined,
    version: 1 | 2,
  ): Promise<{
    decision: SearchContentDecision;
    certificate?: SearchContentCertificate;
  }> {
    requireQwenSemanticProfile(profile);
    const epoch = transactionReadEpoch(tx);
    if (!epoch || !searchCandidateSchema.safeParse(candidate).success)
      throw unavailable();
    // Canonical lock order precedes every certificate/vector write. Requiring
    // source xmin older than snapshot xmin conservatively proves the component
    // insertion window committed, including when the caller used savepoints.
    for (const [kind, id] of chain(candidate)) {
      const table =
        kind === 'post'
          ? 'posts'
          : kind === 'comment'
            ? 'root_comments'
            : 'replies';
      const locked = await tx.query<{ committed: boolean }>(
        `SELECT age(xmin)>age((pg_snapshot_xmin(pg_current_snapshot())::text::numeric % 4294967296)::text::xid) AS committed
         FROM whaleu_community.${table} WHERE id=$1 FOR SHARE`,
        [id],
      );
      if (locked.rows[0]?.committed !== true) throw unavailable();
    }
    const current = (
      await tx.query<{
        space_id: string;
        region_id: string | null;
        active: boolean;
        now: Date;
      }>(
        `SELECT p.space_id,sp.operating_region_id AS region_id,sp.is_active AS active,clock_timestamp() AS now
       FROM whaleu_community.posts p JOIN whaleu_community.spaces sp ON sp.id=p.space_id WHERE p.id=$1`,
        [candidate.postId],
      )
    ).rows[0];
    if (!current || current.space_id !== candidate.spaceId)
      return { decision: 'unknown' };
    const regions = current.region_id
      ? await this.campuses.readRegionsBatch([current.region_id], tx)
      : null;
    const active =
      current.active === true &&
      (current.region_id === null || regions?.get(current.region_id) === true);
    if (!active) return { decision: 'deny' };
    const nodes = await this.nodes(
      [candidate],
      tx,
      null,
      version === 2,
      new Set([candidate.postId]),
    );
    let validUntil: number | null = null;
    const ancestors: SearchContentCertificate[] = [];
    const mediaChain: SemanticMediaChain = [];
    for (const [ordinal, [kind, id]] of chain(candidate).entries()) {
      const node = nodes.get(`${kind}:${id}`);
      if (!node || node.deleted_at || node.visibility !== 'approved')
        return { decision: 'deny' };
      if (
        node.post_id !== candidate.postId ||
        (kind !== 'post' && node.root_comment_id !== candidate.rootCommentId) ||
        node.exact_time_valid !== true
      )
        return { decision: 'unknown' };
      const checked = await this.visibility.check(
        null,
        {
          contentKind: kind,
          contentId: id,
          contentVersion: 1,
          ...(node.author_mode === 'anonymous'
            ? { authorMode: 'anonymous' as const }
            : {
                authorMode: 'named' as const,
                namedAccountId: node.account_id,
              }),
        },
        tx,
        'list_projection',
        read,
        version === 2, // Legacy V1 never receives Media authority.
      );
      if (checked.kind === 'unavailable') return { decision: 'unknown' };
      const evaluated = validateApprovalMetadata(
        node,
        false,
        current.now.getTime(),
      );
      if (evaluated.decision.kind === 'unavailable')
        return { decision: 'unknown' };
      const mediaNode =
        version === 2 && node.media_fact
          ? semanticMediaNode(kind, id, node.media_fact)
          : null;
      const mediaDenied =
        version === 2 &&
        evaluated.decision.kind === 'allow' &&
        mediaNode?.decision === 'deny';
      if (
        checked.kind === 'deny' &&
        evaluated.decision.kind !== 'deny' &&
        !mediaDenied
      )
        return { decision: 'deny' };
      if (checked.kind !== evaluated.decision.kind && !mediaDenied)
        return { decision: 'unknown' };
      validUntil = minimum(validUntil, evaluated.optionalUntil);
      if (version === 2) {
        if (evaluated.decision.kind === 'deny')
          mediaChain.push({
            kind,
            id,
            decision: 'review-denied',
            attachments: null,
            validUntil: null,
          });
        else {
          if (
            !mediaNode ||
            mediaNode.decision === 'review-denied' ||
            mediaNode.decision !== checked.kind
          )
            return { decision: 'unknown' };
          mediaChain.push(mediaNode);
          validUntil = minimum(validUntil, mediaNode.validUntil);
        }
        registerTransactionDeadline(tx, validUntil, 'COMMUNITY_UNAVAILABLE');
      }
      const table =
        kind === 'post'
          ? 'posts'
          : kind === 'comment'
            ? 'root_comments'
            : 'replies';
      const body = (
        await tx.query<{
          body_digest: string;
          text: string | null;
          revision: unknown;
        }>(
          `SELECT CASE WHEN $3::boolean THEN text ELSE NULL END AS text,
         encode(sha256(convert_to(text,'UTF8')),'hex') AS body_digest,whaleu_semantic.source_revision($2,$1) AS revision
         FROM whaleu_community.${table} WHERE id=$1`,
          [id, kind, checked.kind === 'allow'],
        )
      ).rows[0];
      const revision = semanticRevisionSchema.safeParse(body?.revision);
      if (
        !body ||
        !revision.success ||
        revision.data.length !== ordinal + 1 ||
        semanticFingerprint(revision.data[ordinal]) !==
          semanticFingerprint([
            kind,
            id,
            node.generation,
            node.digest,
            node.decision_id,
            node.policy_revision_id,
            node.event_id,
          ])
      )
        return { decision: 'unknown' };
      const parsed = anyCertificateSchema.parse({
        index_space_key: profile.indexSpaceKey,
        kind,
        content_id: id,
        post_id: candidate.postId,
        root_comment_id: kind === 'post' ? null : candidate.rootCommentId,
        source_revision: revision.data,
        body_digest: body.body_digest,
        has_searchable_text: body.text !== null && body.text.trim().length > 0,
        space_id: current.space_id,
        region_id: current.region_id,
        certificate_version: version,
        ...(version === 2 ? { media_chain: [...mediaChain] } : {}),
        valid_until: validUntil === null ? null : new Date(validUntil),
      });
      for (const item of parsed.source_revision) Object.freeze(item);
      Object.freeze(parsed.source_revision);
      if (parsed.certificate_version === 2) {
        for (const node of parsed.media_chain) {
          if (node.attachments) {
            for (const attachment of node.attachments)
              Object.freeze(attachment);
            Object.freeze(node.attachments);
          }
          Object.freeze(node);
        }
        Object.freeze(parsed.media_chain);
      }
      const certificate = Object.freeze(parsed);
      ancestors.push(certificate);
      if (checked.kind === 'deny' || ordinal === chain(candidate).length - 1) {
        this.captures.set(certificate, {
          tx,
          epoch,
          encoded: JSON.stringify(certificate),
          ancestors,
        });
        return { decision: checked.kind, certificate };
      }
    }
    return { decision: 'unknown' };
  }

  async persist(
    certificate: SearchContentCertificate,
    tx: PoolClient,
  ): Promise<void> {
    const proof = this.captures.get(certificate);
    if (
      !proof ||
      proof.tx !== tx ||
      proof.epoch !== transactionReadEpoch(tx) ||
      proof.encoded !== JSON.stringify(certificate)
    )
      throw unavailable();
    const c = anyCertificateSchema.safeParse(certificate);
    if (!c.success) throw unavailable();
    for (const item of proof.ancestors) {
      if (item.certificate_version === 2) {
        if (
          item.media_chain.some((node) => (node.attachments?.length ?? 0) > 0)
        )
          requireSemanticMediaProof(tx);
        registerTransactionDeadline(
          tx,
          item.valid_until?.getTime() ?? null,
          'COMMUNITY_UNAVAILABLE',
        );
      }
      const v2 = item.certificate_version === 2;
      const written = await tx.query(
        `INSERT INTO whaleu_semantic.${v2 ? 'certificates_v2' : 'certificates'}(index_space_key,kind,content_id,post_id,root_comment_id,source_revision,
       body_digest,space_id,region_id,certificate_version,valid_until,has_searchable_text${v2 ? ',media_chain' : ''})
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12${v2 ? ',$13::jsonb' : ''})
       ON CONFLICT(index_space_key,kind,content_id) DO UPDATE SET post_id=EXCLUDED.post_id,
       root_comment_id=EXCLUDED.root_comment_id,source_revision=EXCLUDED.source_revision,body_digest=EXCLUDED.body_digest,
       space_id=EXCLUDED.space_id,region_id=EXCLUDED.region_id,certificate_version=EXCLUDED.certificate_version,
       valid_until=EXCLUDED.valid_until,has_searchable_text=EXCLUDED.has_searchable_text${v2 ? ',media_chain=EXCLUDED.media_chain' : ''} RETURNING *`,
        [
          item.index_space_key,
          item.kind,
          item.content_id,
          item.post_id,
          item.root_comment_id,
          JSON.stringify(item.source_revision),
          item.body_digest,
          item.space_id,
          item.region_id,
          item.certificate_version,
          item.valid_until,
          item.has_searchable_text,
          ...(item.certificate_version === 2
            ? [JSON.stringify(item.media_chain)]
            : []),
        ],
      );
      const returned = anyCertificateSchema.safeParse(written.rows[0]);
      if (
        written.rowCount !== 1 ||
        !returned.success ||
        JSON.stringify(returned.data) !== JSON.stringify(item)
      )
        throw unavailable();
    }
  }

  async prepare(
    scope: SearchStructuralScope,
    profile: QwenSemanticProfile,
    tx: PoolClient,
  ): Promise<SearchContentEligibilityRelation> {
    requireQwenSemanticProfile(profile);
    await captureSemanticMediaProof(tx);
    const v2Installed = await this.hasV2(tx);
    const epoch = transactionReadEpoch(tx);
    if (!epoch) throw unavailable();
    const rows = await tx.query<StructuralRow>(
      `WITH structural AS (
       SELECT p.id,'post'::text kind,p.id post_id,NULL::uuid root_id,p.published_at at FROM whaleu_community.posts p WHERE p.visibility='approved' AND p.deleted_at IS NULL
       UNION ALL SELECT c.id,'comment',c.post_id,c.id,c.created_at FROM whaleu_community.root_comments c WHERE c.visibility='approved' AND c.deleted_at IS NULL
       UNION ALL SELECT r.id,'reply',r.post_id,r.root_comment_id,r.created_at FROM whaleu_community.replies r WHERE r.visibility='approved' AND r.deleted_at IS NULL
      ) SELECT s.id,s.kind,p.space_id AS "spaceId",p.id AS "postId",s.root_id AS "rootCommentId",
       to_char(s.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
       sp.is_active AS space_active,sp.kind AS space_kind,sp.operating_region_id AS region_id,
       CASE WHEN c.content_id IS NULL THEN NULL ELSE to_jsonb(c) END AS certificate,
       ${v2Installed ? 'CASE WHEN cv2.content_id IS NULL THEN NULL ELSE to_jsonb(cv2) END' : 'NULL::jsonb'} AS certificate_v2,
       whaleu_semantic.source_revision(s.kind,s.id) AS current_revision
      FROM structural s JOIN whaleu_community.posts p ON p.id=s.post_id
      LEFT JOIN whaleu_community.spaces sp ON sp.id=p.space_id
      LEFT JOIN whaleu_semantic.certificates c ON c.index_space_key=$10 AND c.kind=s.kind AND c.content_id=s.id
      ${v2Installed ? 'LEFT JOIN whaleu_semantic.certificates_v2 cv2 ON cv2.index_space_key=$10 AND cv2.kind=s.kind AND cv2.content_id=s.id' : ''}
      WHERE p.visibility='approved' AND p.deleted_at IS NULL AND s.kind=ANY($11::text[]) AND (($1::uuid IS NOT NULL AND p.space_id=$1)
       OR ($1::uuid IS NULL AND ((p.space_id=ANY($2::uuid[]) AND p.category=ANY($12::text[]))
         OR (p.space_id=ANY($3::uuid[]) AND p.category='discussion'))))
       AND ($4::text IS NULL OR p.category=$4)
       AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM whaleu_community.trading_listings t WHERE t.post_id=p.id AND t.subtype=$5))
       AND (NOT $6::boolean OR NOT EXISTS(SELECT 1 FROM whaleu_community.trading_listings t WHERE t.post_id=p.id AND t.urgency='urgent'))
       AND ($7::uuid IS NULL OR p.id=$7) AND ($8::timestamptz IS NULL OR s.at>=$8::timestamptz)
       AND ($9::timestamptz IS NULL OR s.at<$9::timestamptz) LIMIT ${SEARCH_CONTENT_METADATA_LIMIT + 1}`,
      [
        'spaceId' in scope ? scope.spaceId : null,
        'spaceId' in scope ? [] : scope.regionalSpaceIds,
        'spaceId' in scope ? [] : scope.globalSpaceIds,
        scope.category,
        scope.tradingSubtype,
        scope.excludeUrgentTrading,
        scope.postId,
        scope.from,
        scope.to,
        profile.indexSpaceKey,
        scope.types,
        categorySchema.options,
      ],
    );
    if (rows.rows.length > SEARCH_CONTENT_METADATA_LIMIT) throw unavailable();
    const candidates = rows.rows.map((row) => {
      const parsed = searchCandidateSchema.safeParse({
        id: row.id,
        kind: row.kind,
        spaceId: row.spaceId,
        postId: row.postId,
        rootCommentId: row.rootCommentId,
        at: row.at,
      });
      if (!parsed.success) throw unavailable();
      return parsed.data;
    });
    const regionIds = [
      ...new Set(
        rows.rows.flatMap((row) => (row.region_id ? [row.region_id] : [])),
      ),
    ];
    const regions = new Map<string, boolean>();
    for (let offset = 0; offset < regionIds.length; offset += 256)
      for (const [id, active] of await this.campuses.readRegionsBatch(
        regionIds.slice(offset, offset + 256),
        tx,
      ))
        regions.set(id, active);
    const activePosts = new Set(
      rows.rows
        .filter(
          (row) =>
            row.space_active === true &&
            (row.region_id === null || regions.get(row.region_id) === true),
        )
        .map((row) => row.postId),
    );
    const nodes = await this.nodes(
      candidates,
      tx,
      profile.indexSpaceKey,
      v2Installed,
      activePosts,
    );
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]?.now.getTime();
    if (now === undefined || !Number.isFinite(now)) throw unavailable();
    let validUntil: number | null = null;
    const safetyNodes = new Map<
      string,
      {
        node_key: string;
        author_mode: string;
        named_account_id: string | null;
        purpose: string;
        base_decision: SearchContentDecision;
        base_valid_until: string | null;
        eligibility_revision: unknown;
      }
    >();
    const facts = rows.rows.map((row, index) => {
      // JSON timestamp decoding is explicit; invalid/missing certificates are
      // unknown, never silently omitted from coverage or treated as denied.
      const candidate = candidates[index]!;
      const choose = (
        subject: SearchCandidate,
        legacy: unknown,
        v2: unknown,
      ) => {
        const textOnly = chain(subject).every(([kind, id]) => {
          const node = nodes.get(`${kind}:${id}`);
          return node !== undefined && exactNodeImages(node)?.length === 0;
        });
        return textOnly
          ? (decodeCertificate(legacy) ?? decodeCertificate(v2))
          : decodeCertificate(v2);
      };
      const certificate = choose(
        candidate,
        row.certificate,
        row.certificate_v2,
      );
      const result = evaluateSearchContentCertificate(
        candidate,
        certificate,
        nodes,
        {
          active: row.space_active === true,
          kind: row.space_kind,
          regionId: row.region_id,
          regionActive:
            row.region_id === null || regions.get(row.region_id) === true,
        },
        profile.indexSpaceKey,
        now,
      );
      validUntil = minimum(validUntil, result.validUntil);
      const roleKeys = chain(candidate).map(([kind, id]) => {
        const purpose =
          kind === 'post' && candidate.kind !== 'post'
            ? 'direct_post'
            : 'list_projection';
        const nodeKey = `${kind}:${id}:${purpose}`;
        const node = nodes.get(`${kind}:${id}`);
        const subject = {
          ...candidate,
          kind,
          id,
          rootCommentId: kind === 'post' ? null : candidate.rootCommentId,
        };
        const nodeCertificate = choose(
          subject,
          node?.stored_certificate,
          node?.stored_certificate_v2,
        );
        const base = evaluateSearchContentCertificate(
          {
            ...candidate,
            kind,
            id,
            rootCommentId: kind === 'post' ? null : candidate.rootCommentId,
          },
          nodeCertificate,
          nodes,
          {
            active: row.space_active === true,
            kind: row.space_kind,
            regionId: row.region_id,
            regionActive:
              row.region_id === null || regions.get(row.region_id) === true,
          },
          profile.indexSpaceKey,
          now,
        );
        safetyNodes.set(nodeKey, {
          node_key: nodeKey,
          author_mode: node?.author_mode ?? 'unknown',
          named_account_id:
            node?.author_mode === 'named' ? node.account_id : null,
          purpose,
          base_decision: base.decision,
          eligibility_revision: base.eligibilityRevision ?? null,
          base_valid_until:
            base.validUntil === null
              ? null
              : new Date(base.validUntil).toISOString(),
        });
        return nodeKey;
      });
      return {
        ...candidate,
        key: searchCandidateKey(candidate),
        decision: result.decision,
        valid_until:
          result.validUntil === null
            ? null
            : new Date(result.validUntil).toISOString(),
        source_revision:
          result.decision === 'allow' ? row.current_revision : null,
        body_digest:
          result.decision === 'allow' ? certificate!.body_digest : null,
        has_searchable_text:
          result.decision === 'allow' ? certificate!.has_searchable_text : null,
        post_safety_key: roleKeys[0],
        root_safety_key: roleKeys[1] ?? null,
        reply_safety_key: roleKeys[2] ?? null,
      };
    });
    const suffix = randomUUID().replaceAll('-', '');
    const tableName = `search_content_${suffix}`,
      nodesTableName = `search_nodes_${suffix}`;
    await tx.query(
      `CREATE TEMP TABLE ${tableName} ON COMMIT DROP AS SELECT * FROM jsonb_to_recordset($1::jsonb)
     AS x(key text,kind text,id uuid,"spaceId" uuid,"postId" uuid,"rootCommentId" uuid,at text,decision text,
       valid_until timestamptz,source_revision jsonb,body_digest text,has_searchable_text boolean,post_safety_key text,root_safety_key text,reply_safety_key text)`,
      [JSON.stringify(facts)],
    );
    await tx.query(
      `CREATE TEMP TABLE ${nodesTableName} ON COMMIT DROP AS SELECT * FROM jsonb_to_recordset($1::jsonb)
     AS x(node_key text,author_mode text,named_account_id uuid,purpose text,base_decision text,base_valid_until timestamptz,eligibility_revision jsonb)`,
      [JSON.stringify([...safetyNodes.values()])],
    );
    const relation = Object.freeze({
      tableName,
      nodesTableName,
      validUntil,
      mediaAware: [...safetyNodes.values()].some(
        (node) => node.eligibility_revision !== null,
      ),
      assertCurrent(client: PoolClient) {
        if (client !== tx || transactionReadEpoch(client) !== epoch)
          throw unavailable();
      },
    });
    handles.add(relation);
    return relation;
  }
}
