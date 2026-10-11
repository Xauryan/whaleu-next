import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  canonicalEqual,
  canonicalJson,
} from '../../community/content-review/contracts.js';
import {
  canonicalRatingCategoryIconDefinition,
  type RatingCategoryIconDefinitionDescriptor,
} from '../../community/content-review/rating-category-icon-contracts.js';
import { RatingCategoryIconReviewFacade } from '../../community/content-review/rating-category-icon-review.facade.js';
import {
  ratingCategoryIconBindingMatches,
  type RatingCategoryIconReviewBinding,
} from '../../community/content-review/rating-category-icon-validation.js';
import {
  canonicalRatingScopedCategorySource,
  ratingScopedApprovalDigest,
  type RatingScopedCategorySourceDescriptor,
} from '../../community/content-review/rating-scoped-contracts.js';
import { RatingScopedContentReviewFacade } from '../../community/content-review/rating-scoped-content-review.facade.js';
import {
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import {
  CategoryIconMediaContentSnapshotFacade,
  categoryIconMediaContentKey,
  type CategoryIconMediaContentAttachment,
  type CategoryIconMediaContentReference,
  type MediaSnapshotReadBudget,
} from '../../media/category-icon-content-snapshot.facade.js';
import {
  categoryIconMediaManagementQualificationSchema,
  type CategoryIconMediaManagementQualification,
} from '../../media/category-icon-owner-proof.js';
import { CategoryIconMediaRequiredProof } from '../../media/category-icon-required-proof.js';
import type { CategoryIconMediaParent } from '../../media/contracts-category-icon.js';
import {
  RatingScopedCompilationBudget,
  scopedExpectedCategorySchema,
  type ScopedExpectedCategory,
} from '../scoped/compiler.js';
import { scopedId } from '../scoped/contracts.js';
import { retainRatingReadBytes } from '../target-cover-current.js';
import { categoryIconSnapshot } from './icon-capability.js';
import type { CategoryIconAppearance } from './icon-contracts.js';
import {
  categoryIconContentSchema,
  categoryIconDigest,
  type CategoryIconContent,
} from './icon-extension.js';
import { retainCategoryIconState } from './icon-proof.js';
import {
  resolveCategoryIcon,
  type CategoryIconBaseRoot,
  type CategoryIconOverrideRoot,
  type CategoryIconRoot,
} from './icon-references.js';
import { RatingCategoryIconRepository } from './icon-repository.js';

const inputSchema = z.strictObject({
  categoryId: scopedId,
  appearanceId: scopedId,
  selector: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('global') }),
    z.strictObject({ kind: z.literal('campus'), campusId: scopedId }),
  ]),
});
export type CategoryIconManagementRootInput = z.infer<typeof inputSchema>;
export interface CurrentCategoryIconManagementRoot {
  readonly appearance: CategoryIconAppearance;
  readonly parent: CategoryIconMediaParent;
  readonly binding: CategoryIconMediaContentAttachment;
  readonly reviewBinding: Readonly<RatingCategoryIconReviewBinding>;
  readonly content: CategoryIconContent;
  readonly definition: RatingCategoryIconDefinitionDescriptor;
  readonly qualification: CategoryIconMediaManagementQualification;
  readonly ownerRevision: string;
  readonly reviewRevision: string;
}
export interface CategoryIconManagementRootDependencies {
  readonly roots: Pick<RatingCategoryIconRepository, 'roots'>;
  readonly sourceReview: Pick<
    RatingScopedContentReviewFacade,
    'currentCategorySource'
  >;
  readonly review: Pick<RatingCategoryIconReviewFacade, 'currentBatch'>;
  readonly media: Pick<CategoryIconMediaContentSnapshotFacade, 'readBatch'>;
  readonly mediaProof: Pick<CategoryIconMediaRequiredProof, 'capture'>;
}
const defaults: CategoryIconManagementRootDependencies = {
  roots: new RatingCategoryIconRepository(),
  sourceReview: new RatingScopedContentReviewFacade(),
  review: new RatingCategoryIconReviewFacade(),
  media: new CategoryIconMediaContentSnapshotFacade(),
  mediaProof: new CategoryIconMediaRequiredProof(),
};
function unavailable(): never {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
}
function reviewUnavailable(): never {
  throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
}
function mediaUnavailable(): never {
  throw new ApplicationError('MEDIA_UNAVAILABLE');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** The caller passes its existing compilation budget. Every observation also
 * joins the transaction-wide ledger used by other Ratings reads and Media8. */
class SharedReadBudget extends RatingScopedCompilationBudget {
  constructor(
    private readonly shared: RatingScopedCompilationBudget,
    private readonly tx: PoolClient,
  ) {
    super();
  }
  override observe(value: unknown): void {
    this.shared.observe(value);
    retainRatingReadBytes(this.tx, value);
  }
}
async function rows<T>(
  tx: PoolClient,
  sql: string,
  values: unknown[],
  cap: number,
  budget: SharedReadBudget,
): Promise<T[]> {
  const result = (await tx.query(sql, values)).rows as T[];
  budget.observe(result);
  if (result.length > cap) unavailable();
  return result;
}
async function currentEpoch(
  tx: PoolClient,
  budget: SharedReadBudget,
): Promise<string> {
  const result = await rows<{ version: number; epoch: string }>(
    tx,
    'SELECT version,epoch::text FROM whaleu_ratings.category_icon_epoch WHERE singleton',
    [],
    1,
    budget,
  );
  if (
    result.length !== 1 ||
    result[0]!.version !== 1 ||
    !/^(0|[1-9][0-9]*)$/.test(result[0]!.epoch)
  )
    unavailable();
  return result[0]!.epoch;
}
interface ManagementHead {
  root_key: string;
  root_definition_id: string;
  selector: unknown;
  review_binding_id: string;
  binding: RatingCategoryIconReviewBinding | null;
}
interface ExactSource {
  id: string;
  revision: string;
  source_kind: string;
  issuer: string;
  scope_keys: string[];
  original_body: unknown;
  payload: Record<string, unknown>;
  valid_until: Date;
  current: boolean;
}
function selectClosure(
  roots: readonly CategoryIconRoot[],
  input: CategoryIconManagementRootInput,
) {
  const campusId =
    input.selector.kind === 'campus' ? input.selector.campusId : null;
  const scopeKey = campusId === null ? 'global' : `campus:${campusId}`;
  const candidates = roots.filter(
    (root) =>
      root.categoryId === input.categoryId &&
      root.value.kind === 'image' &&
      root.value.appearance.appearanceId === input.appearanceId &&
      (root.kind === 'override'
        ? root.campusId === campusId
        : root.scopeKeys.includes(scopeKey)),
  );
  if (candidates.length !== 1) return unavailable();
  const root = candidates[0]!;
  if (root.value.kind !== 'image') return unavailable();
  const baseSource = root.kind === 'base' ? root.source : root.baseSource;
  const bases = roots.filter(
    (candidate): candidate is CategoryIconBaseRoot =>
      candidate.kind === 'base' &&
      candidate.categoryId === root.categoryId &&
      candidate.identityId === root.identityId &&
      canonicalEqual(candidate.source, baseSource),
  );
  const overrides =
    campusId === null
      ? []
      : roots.filter(
          (candidate): candidate is CategoryIconOverrideRoot =>
            candidate.kind === 'override' &&
            candidate.categoryId === root.categoryId &&
            candidate.identityId === root.identityId &&
            candidate.campusId === campusId &&
            canonicalEqual(candidate.baseSource, baseSource),
        );
  if (bases.length !== 1 || overrides.length > 1) return unavailable();
  return {
    root,
    appearance: root.value.appearance,
    base: bases[0]!,
    override: overrides[0],
    campusId,
    baseSource,
  };
}
type CategoryBody = Pick<
  CategoryIconContent,
  'parentId' | 'level' | 'kind' | 'systemKey' | 'name' | 'description'
>;
type OriginalSourceEvidence = Pick<
  ExactSource,
  'id' | 'revision' | 'source_kind' | 'issuer' | 'scope_keys' | 'payload'
>;
interface ExactCategorySources {
  readonly body: CategoryBody;
  readonly evidence: readonly (
    | RatingScopedCategorySourceDescriptor
    | {
        kind: 'original-base';
        source: OriginalSourceEvidence;
        body: ScopedExpectedCategory['body'];
      }
    | { kind: 'inherit'; source: OriginalSourceEvidence }
  )[];
}
async function exactSources(
  closure: ReturnType<typeof selectClosure>,
  tx: PoolClient,
  budget: SharedReadBudget,
  review: CategoryIconManagementRootDependencies['sourceReview'],
): Promise<ExactCategorySources> {
  const wanted = [
    closure.baseSource,
    ...(closure.override?.source ? [closure.override.source] : []),
  ];
  const sources = await rows<ExactSource>(
    tx,
    `SELECT s.id,s.revision,s.source_kind,s.issuer,s.scope_keys,s.payload,s.valid_until,
    whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()) current,
    CASE WHEN s.source_kind IN ('m3a_native_bridge','legacy_adoption')
      THEN whaleu_ratings.scoped_base_category(s.id,s.revision) END original_body
    FROM unnest($1::uuid[],$2::uuid[]) wanted(id,revision)
    JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(wanted.id,wanted.revision)
    JOIN whaleu_ratings.scoped_source_heads h ON (h.source_id,h.source_revision,h.source_kind,h.source_key)=(s.id,s.revision,s.source_kind,s.source_key)
    ORDER BY s.id FOR SHARE OF h,s`,
    [
      wanted.map((source) => source.id),
      wanted.map((source) => source.revision),
    ],
    wanted.length,
    budget,
  );
  if (
    sources.length !== wanted.length ||
    new Set(sources.map((source) => source.id)).size !== sources.length
  )
    unavailable();
  const evidence: ExactCategorySources['evidence'][number][] = [];
  let body: CategoryBody | undefined;
  for (const [index, expected] of wanted.entries()) {
    const source =
      sources.find(
        (item) =>
          item.id === expected.id && item.revision === expected.revision,
      ) ?? unavailable();
    if (
      source.current !== true ||
      !(source.valid_until instanceof Date) ||
      !Number.isFinite(source.valid_until.getTime()) ||
      !(index === 0
        ? [
            'scoped_category_base',
            'm3a_native_bridge',
            'legacy_adoption',
          ].includes(source.source_kind)
        : source.source_kind === 'scoped_category_override') ||
      !source.payload ||
      typeof source.payload !== 'object' ||
      Array.isArray(source.payload)
    )
      unavailable();
    registerTransactionDeadline(
      tx,
      source.valid_until.getTime(),
      'RATING_SCOPE_UNAVAILABLE',
    );
    const original: OriginalSourceEvidence = {
      id: source.id,
      revision: source.revision,
      source_kind: source.source_kind,
      issuer: source.issuer,
      scope_keys: source.scope_keys,
      payload: source.payload,
    };
    if (index === 0 && source.source_kind !== 'scoped_category_base') {
      // Adopted native/legacy sources keep their original proof protocol. The
      // original SQL reader qualifies that exact current source and body; a
      // historical body or a synthesized Review5 envelope is never authority.
      const parsed = scopedExpectedCategorySchema.shape.body.safeParse(
        source.original_body,
      );
      if (
        !parsed.success ||
        parsed.data.id !== closure.root.categoryId ||
        parsed.data.identityId !== closure.root.identityId ||
        parsed.data.identityKind !==
          (source.source_kind === 'm3a_native_bridge'
            ? 'native_bridge'
            : 'adopted')
      )
        unavailable();
      const base = parsed.data;
      body = {
        parentId: base.parentId,
        level: base.level,
        kind: base.kind,
        systemKey: base.systemKey,
        name: base.name,
        description: base.description,
      };
      evidence.push({ kind: 'original-base', source: original, body: base });
      continue;
    }
    if (index === 1 && source.payload['action'] === 'inherit') {
      // The immutable management source guard and original scoped composition
      // own this metadata-only tombstone. Its exact base carries identity; the
      // tombstone remains a non-null source in the composite Review8 content.
      if (
        source.issuer !== 'ratings-category-management' ||
        closure.campusId === null ||
        !canonicalEqual(source.scope_keys, [`campus:${closure.campusId}`]) ||
        source.payload['categoryId'] !== closure.root.categoryId ||
        source.payload['baseSourceId'] !== closure.baseSource.id ||
        source.payload['baseSourceRevision'] !== closure.baseSource.revision ||
        !canonicalEqual(source.payload['modes'], {
          name: { mode: 'inherit' },
          description: { mode: 'inherit' },
        }) ||
        'reviewEnvelope' in source.payload ||
        'issuanceDigest' in source.payload
      )
        unavailable();
      evidence.push({ kind: 'inherit', source: original });
      continue;
    }
    let descriptor: RatingScopedCategorySourceDescriptor;
    try {
      descriptor = canonicalRatingScopedCategorySource({
        sourceId: source.id,
        sourceRevision: source.revision,
        categoryId: closure.root.categoryId,
        envelope: source.payload['reviewEnvelope'],
      });
    } catch {
      return reviewUnavailable();
    }
    const envelope = descriptor.envelope;
    if (
      envelope.identityId !== closure.root.identityId ||
      (index === 0
        ? envelope.purpose !== 'publish_rating_category_base_scoped'
        : envelope.purpose !== 'publish_rating_category_override_scoped' ||
          envelope.scope.campusId !== closure.campusId ||
          envelope.baseSourceId !== closure.baseSource.id ||
          envelope.baseSourceRevision !== closure.baseSource.revision)
    )
      unavailable();
    const decision = await review.currentCategorySource(descriptor, tx);
    budget.observe({ descriptor, decision });
    if (
      decision.kind !== 'allow' ||
      decision.value.version !== 5 ||
      decision.value.digest !== ratingScopedApprovalDigest(envelope) ||
      !canonicalEqual(decision.value.envelope, envelope)
    )
      reviewUnavailable();
    if (envelope.purpose === 'publish_rating_category_base_scoped')
      body = envelope.body;
    else body = { ...(body ?? unavailable()), ...envelope.body };
    evidence.push(descriptor);
  }
  return { body: body ?? unavailable(), evidence };
}

/** Read-only management authority for an exact still-recoverable root. The
 * original owner must already have checked authenticated all-of management
 * permission across the complete closure. This never consults public catalog
 * projections, chooses a historical Review binding, repairs metadata or retires
 * a root. Public delivery must continue through its original-release gate. */
export async function currentCategoryIconManagementRoot(
  raw: CategoryIconManagementRootInput,
  tx: PoolClient,
  sharedBudget: RatingScopedCompilationBudget,
  dependencies: CategoryIconManagementRootDependencies = defaults,
): Promise<CurrentCategoryIconManagementRoot> {
  const parsed = inputSchema.safeParse(raw),
    readEpoch = transactionReadEpoch(tx);
  if (!parsed.success || !readEpoch) return unavailable();
  const input = parsed.data,
    budget = new SharedReadBudget(sharedBudget, tx);
  const epoch = await currentEpoch(tx, budget);
  const roots = await dependencies.roots.roots(tx, budget);
  const keys = [
    ...new Set(
      roots.flatMap((root) =>
        root.kind === 'override'
          ? [...root.scopeKeys, `campus:${root.campusId}`]
          : root.scopeKeys,
      ),
    ),
  ].sort();
  if (!keys.length || keys.length > 1001) unavailable();
  await retainCategoryIconState(keys, tx);
  const closureRevision = await categoryIconSnapshot(keys, tx);
  budget.observe({ keys, closureRevision });
  if ((await currentEpoch(tx, budget)) !== epoch) unavailable();
  const closure = selectClosure(roots, input);
  const heads = await rows<ManagementHead>(
    tx,
    `SELECT h.root_key,h.root_definition_id,h.selector,h.review_binding_id,to_jsonb(b) binding
    FROM whaleu_ratings.category_icon_management_review_heads h
    JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=h.review_binding_id
    WHERE h.root_definition_id=$1 AND h.selector=$2::jsonb
    ORDER BY h.root_key LIMIT 2 FOR SHARE OF h,b`,
    [closure.root.definitionId, canonicalJson(input.selector)],
    1,
    budget,
  );
  const head = heads[0],
    binding = head?.binding;
  if (
    !head ||
    head.root_key !==
      canonicalJson([closure.root.definitionId, input.selector]) ||
    head.root_definition_id !== closure.root.definitionId ||
    !canonicalEqual(head.selector, input.selector) ||
    !binding ||
    head.review_binding_id !== binding.id
  )
    unavailable();
  let definition: RatingCategoryIconDefinitionDescriptor;
  try {
    definition = canonicalRatingCategoryIconDefinition({
      definitionId: binding.definition_id,
      definitionDigest: binding.definition_digest,
      envelope: binding.envelope,
    });
  } catch {
    return reviewUnavailable();
  }
  if (!ratingCategoryIconBindingMatches(binding, definition))
    reviewUnavailable();
  // Root identity comes from the current server-owned definition and exact
  // appearance selection, never from caller-supplied null override fields. New
  // base-management pointers describe that original base slot even where a
  // public campus body has an override. Existing exact effective-body pointers
  // keep their original source qualification; there is no historical fallback.
  const directBase =
    closure.root.kind === 'base' &&
    definition.envelope.content.overrideDefinitionId === null &&
    definition.envelope.content.overrideSource === null;
  const sourceClosure = directBase
    ? { ...closure, override: undefined }
    : closure;
  const sources = await exactSources(
    sourceClosure,
    tx,
    budget,
    dependencies.sourceReview,
  );
  const content = categoryIconContentSchema.parse({
    categoryId: closure.root.categoryId,
    identityId: closure.root.identityId,
    ...sources.body,
    selector: input.selector,
    baseSource: closure.baseSource,
    overrideSource: sourceClosure.override?.source ?? null,
    baseDefinitionId: closure.base.definitionId,
    overrideDefinitionId: sourceClosure.override?.definitionId ?? null,
    icon: resolveCategoryIcon(
      directBase ? [closure.base] : roots,
      {
        categoryId: input.categoryId,
        identityId: closure.root.identityId,
        baseSource: closure.baseSource,
        overrideSource: sourceClosure.override?.source ?? null,
        campusId: closure.campusId,
      },
      budget,
    ),
  });
  if (
    content.icon.kind !== 'image' ||
    content.icon.definitionId !== closure.root.definitionId ||
    content.icon.appearance.appearanceId !== input.appearanceId ||
    !canonicalEqual(content, definition.envelope.content)
  )
    unavailable();
  const decisions = await dependencies.review.currentBatch([definition], tx),
    decision = decisions[0];
  budget.observe({ definition, decisions });
  if (
    decisions.length !== 1 ||
    !decision ||
    decision.kind !== 'allow' ||
    decision.value.version !== 8 ||
    decision.value.decisionId !== binding.decision_id ||
    decision.value.digest !== binding.approval_digest ||
    !canonicalEqual(decision.value.envelope, definition.envelope)
  )
    reviewUnavailable();
  const parent: CategoryIconMediaParent = {
    ownerKind: 'ratings',
    resourceKind: 'category_icon',
    resourceId: closure.appearance.appearanceId,
    contentVersion: 1,
  };
  const reference: CategoryIconMediaContentReference = {
    parent,
    expected: [
      {
        assetId: closure.appearance.assetId,
        digest: closure.appearance.manifestDigest,
      },
    ],
  };
  const mediaBudget: MediaSnapshotReadBudget = {
    rows: <T>(read: PoolClient, sql: string, values: unknown[], cap: number) =>
      rows<T>(read, sql, values, cap, budget),
  };
  await dependencies.mediaProof.capture(tx);
  const facts = await dependencies.media.readBatch(
    [reference],
    tx,
    mediaBudget,
  );
  const fact = facts.get(categoryIconMediaContentKey(parent)),
    attachment = fact?.attachments[0];
  budget.observe(fact ?? null);
  if (
    !fact ||
    fact.version !== 8 ||
    fact.decision !== 'allow' ||
    !canonicalEqual(fact.parent, parent) ||
    fact.validUntil === null ||
    !Number.isFinite(fact.validUntil) ||
    fact.attachments.length !== 1 ||
    !attachment ||
    attachment.assetId !== closure.appearance.assetId ||
    attachment.manifestDigest !== closure.appearance.manifestDigest
  )
    mediaUnavailable();
  registerTransactionDeadline(tx, fact.validUntil, 'MEDIA_UNAVAILABLE');
  if (
    readEpoch !== transactionReadEpoch(tx) ||
    (await currentEpoch(tx, budget)) !== epoch ||
    (await categoryIconSnapshot(keys, tx)) !== closureRevision
  )
    unavailable();
  const qualification = categoryIconMediaManagementQualificationSchema.parse({
    kind: 'management-root',
    rootDefinitionId: closure.root.definitionId,
    closureRevision,
    identityId: closure.root.identityId,
    baseSource: closure.baseSource,
    overrideSource: sourceClosure.override?.source ?? null,
    definitionId: definition.definitionId,
    definitionDigest: definition.definitionDigest,
  });
  return freeze({
    appearance: { ...closure.appearance },
    parent,
    binding: { ...attachment },
    reviewBinding: { ...binding },
    content,
    definition,
    qualification,
    ownerRevision: categoryIconDigest('management-root-owner', {
      qualification,
      appearance: closure.appearance,
      binding: attachment,
    }),
    reviewRevision: categoryIconDigest('management-root-review', {
      binding,
      sources,
    }),
  });
}
