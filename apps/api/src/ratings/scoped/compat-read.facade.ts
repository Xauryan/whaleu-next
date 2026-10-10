import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CampusRatingScopedContextFacade } from '../../campus/rating-scoped-context.facade.js';
import { RatingCategoryContentReviewFacade } from '../../community/content-review/rating-category-content-review.facade.js';
import { RatingScopedContentReviewFacade } from '../../community/content-review/rating-scoped-content-review.facade.js';
import { canonicalRatingCategoryBase } from '../../community/content-review/rating-category-contracts.js';
import { canonicalRatingScopedCategorySource } from '../../community/content-review/rating-scoped-contracts.js';
import { canonicalEqual } from '../../community/content-review/contracts.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import type { CategoryRow, RatingCatalog } from '../repository.js';

interface Source {
  id: string;
  revision: string;
  source_kind: string;
  payload: Record<string, unknown>;
  valid_until: Date | string;
  current: boolean;
}
interface Tuple {
  scopeKey: string;
  catalogId: string;
  headRevision: string;
  releaseId: string;
}
interface Compat {
  id: string;
  scoped_tuples: Tuple[];
  valid_until: Date;
  source_digest: string;
  current: boolean;
}
interface Evidence {
  category: Record<string, unknown>;
  proof: unknown;
  expected: unknown;
  base: Source;
  override: Source | null;
}
function unavailable(): never {
  throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
}
async function epoch(tx: PoolClient) {
  const row = (
    await tx.query<{ state: unknown }>(`SELECT jsonb_build_array(
    (SELECT epoch::text FROM whaleu_ratings.scoped_source_epoch WHERE singleton AND version=1),
    (SELECT epoch::text FROM whaleu_ratings.scope_protocol_epoch WHERE singleton AND version=1),
    (SELECT epoch::text FROM whaleu_ratings.navigation_epoch WHERE singleton AND version=1)) state`)
  ).rows[0];
  if (
    !row ||
    !Array.isArray(row.state) ||
    row.state.length !== 3 ||
    row.state.some(
      (value: unknown) =>
        typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value),
    )
  )
    unavailable();
  return ownerFingerprint(row.state);
}
const proof: RequiredTransactionProof<string> = {
  maximumFacts: 1,
  failureCode: 'RATING_SCOPE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_SCOPE_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch,whaleu_ratings.navigation_epoch IN SHARE MODE NOWAIT',
      );
      if (facts.length !== 1 || facts[0] !== (await epoch(read))) unavailable();
    }),
};
const lifetimes = new WeakMap<
  PoolClient,
  {
    readEpoch: object;
    fingerprint: string;
    bytes: number;
    paths: number;
    reviewed: Map<string, 'allow' | 'deny'>;
  }
>();

/** A canonical v1 revision maps to ALL exact current scoped inputs. It never
 * masquerades as a native base revision or borrows one campus's permission. */
@Injectable()
export class RatingCompatReadFacade {
  constructor(
    @Inject(CampusRatingScopedContextFacade)
    private readonly campus: CampusRatingScopedContextFacade,
    @Inject(RatingCategoryContentReviewFacade)
    private readonly nativeReview: RatingCategoryContentReviewFacade,
    @Inject(RatingScopedContentReviewFacade)
    private readonly scopedReview: RatingScopedContentReviewFacade,
  ) {}
  private async sourceReview(
    source: Source,
    categoryId: string,
    tx: PoolClient,
  ): Promise<'allow' | 'deny'> {
    if (!source || !source.current) unavailable();
    const until = new Date(source.valid_until).getTime();
    if (!Number.isFinite(until)) unavailable();
    registerTransactionDeadline(tx, until, 'RATING_SCOPE_UNAVAILABLE');
    if (
      source.source_kind === 'scoped_category_override' &&
      source.payload['action'] === 'inherit'
    ) {
      const reset = (
        await tx.query<{ valid: boolean }>(
          `SELECT issuer='ratings-category-management' AND payload->>'categoryId'=$3 AND payload->'modes'=jsonb_build_object('name',jsonb_build_object('mode','inherit'),'description',jsonb_build_object('mode','inherit')) AND NOT payload ? 'reviewEnvelope' valid FROM whaleu_ratings.scoped_source_attestations WHERE id=$1 AND revision=$2`,
          [source.id, source.revision, categoryId],
        )
      ).rows[0];
      if (reset?.valid !== true) unavailable();
      return 'allow';
    }
    if (source.source_kind === 'legacy_adoption') {
      const reference = source.payload['reviewSource'];
      if (
        !reference ||
        typeof reference !== 'object' ||
        Array.isArray(reference)
      )
        unavailable();
      const ref = reference as Record<string, unknown>;
      if (
        ref['kind'] !== 'scoped_category_v5' ||
        typeof ref['sourceId'] !== 'string' ||
        typeof ref['sourceRevision'] !== 'string'
      )
        unavailable();
      const adopted = (
        await tx.query<Source>(
          `SELECT s.*,whaleu_ratings.scoped_source_current(s.id,s.revision,clock_timestamp()) current FROM whaleu_ratings.scoped_source_attestations s WHERE s.id=$1 AND s.revision=$2 AND s.source_kind='scoped_category_base'`,
          [ref['sourceId'], ref['sourceRevision']],
        )
      ).rows[0];
      if (!adopted) unavailable();
      return this.sourceReview(adopted, categoryId, tx);
    }
    if (source.source_kind === 'm3a_native_bridge') {
      if (source.payload['categoryId'] !== categoryId) unavailable();
      const row = (
        await tx.query<{ revision: string; envelope: unknown }>(
          `SELECT b.revision,b.envelope FROM whaleu_ratings.catalog_category_lineage l JOIN whaleu_ratings.category_base_versions b ON (b.category_id,b.revision)=(l.category_id,l.base_revision) WHERE l.catalog_id=$1 AND l.category_id=$2 AND l.effective_revision=$3 AND l.source_kind='native'`,
          [
            source.payload['legacyCatalogId'] ??
              source.payload['legacyAfterCatalogId'],
            categoryId,
            source.payload['categoryRevision'],
          ],
        )
      ).rows[0];
      if (!row) unavailable();
      const result = await this.nativeReview.current(
        canonicalRatingCategoryBase({
          categoryId,
          baseRevision: row.revision,
          envelope: row.envelope as never,
        }),
        tx,
      );
      if (result.kind === 'unavailable')
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      return result.kind;
    }
    if (
      !['scoped_category_base', 'scoped_category_override'].includes(
        source.source_kind,
      )
    )
      unavailable();
    const result = await this.scopedReview.currentCategorySource(
      canonicalRatingScopedCategorySource({
        sourceId: source.id,
        sourceRevision: source.revision,
        categoryId,
        envelope: source.payload['reviewEnvelope'],
      }),
      tx,
    );
    if (result.kind === 'unavailable')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return result.kind;
  }
  async qualify(
    catalog: RatingCatalog,
    categories: readonly CategoryRow[],
    tx: PoolClient,
    mode: 'read' | 'write' = 'read',
  ): Promise<readonly ('allow' | 'deny')[]> {
    const readEpoch = transactionReadEpoch(tx);
    if (!readEpoch || categories.length > 512) unavailable();
    let state = lifetimes.get(tx);
    if (!state || state.readEpoch !== readEpoch) {
      state = {
        readEpoch,
        fingerprint: await epoch(tx),
        bytes: 0,
        paths: 0,
        reviewed: new Map(),
      };
      lifetimes.set(tx, state);
    }
    if (mode === 'read') {
      if (state.fingerprint !== (await epoch(tx))) unavailable();
      enableRequiredTransactionProof(tx, proof);
      registerRequiredTransactionFact(
        tx,
        proof,
        'compat-sources',
        state.fingerprint,
      );
    }
    const domain = await this.campus.resolveLegacyCompatDomain(
      catalog.regionId === null
        ? { kind: 'global_compat' }
        : { kind: 'region_compat', regionId: catalog.regionId },
      tx,
    );
    const compat = (
      await tx.query<Compat>(
        `SELECT v.*,whaleu_ratings.scoped_compat_current(v.id) current FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions v ON v.id=h.version_id WHERE h.compat_key=$1 AND v.legacy_catalog_id=$2 FOR SHARE OF h,v`,
        [
          catalog.regionId === null
            ? 'global_compat'
            : `region_compat:${catalog.regionId}`,
          catalog.id,
        ],
      )
    ).rows[0];
    if (
      !compat?.current ||
      !(compat.valid_until instanceof Date) ||
      !canonicalEqual(
        compat.scoped_tuples.map((entry) => entry.scopeKey),
        domain.scopeKeys,
      )
    )
      unavailable();
    registerTransactionDeadline(
      tx,
      compat.valid_until.getTime(),
      'RATING_SCOPE_UNAVAILABLE',
    );
    const upcoming = (
      await tx.query<{ at: Date | null }>(
        'SELECT min(effective_at) at FROM whaleu_ratings.scoped_source_attestations WHERE scope_keys&&$1::text[] AND effective_at>clock_timestamp()',
        [[...domain.scopeKeys]],
      )
    ).rows[0]?.at;
    if (upcoming)
      registerTransactionDeadline(
        tx,
        upcoming.getTime(),
        'RATING_SCOPE_UNAVAILABLE',
      );
    const result: ('allow' | 'deny')[] = categories.map(() => 'allow');
    for (const tuple of compat.scoped_tuples) {
      for (let offset = 0; offset < categories.length; offset += 128) {
        const batch = categories.slice(offset, offset + 128);
        const rows = (
          await tx.query<Evidence>(
            `SELECT to_jsonb(a)||jsonb_build_object('ordinal',a.ordinal::text) category,l.proof,whaleu_ratings.scoped_expected_category(l.placement_revision,$3) expected,
          to_jsonb(b)||jsonb_build_object('current',whaleu_ratings.scoped_source_current(b.id,b.revision,clock_timestamp())) base,
          CASE WHEN o.id IS NULL THEN NULL ELSE to_jsonb(o)||jsonb_build_object('current',whaleu_ratings.scoped_source_current(o.id,o.revision,clock_timestamp())) END override
          FROM unnest($2::uuid[]) WITH ORDINALITY wanted(id,ordinal)
          JOIN whaleu_ratings.scoped_categories a ON a.catalog_id=$1 AND a.category_id=wanted.id
          JOIN whaleu_ratings.scoped_category_lineage l ON (l.catalog_id,l.category_id,l.effective_revision)=(a.catalog_id,a.category_id,a.effective_revision)
          JOIN whaleu_ratings.scoped_source_attestations b ON (b.id,b.revision)=(l.base_source_id,l.base_source_revision)
          LEFT JOIN whaleu_ratings.scoped_source_attestations o ON (o.id,o.revision)=(l.override_source_id,l.override_source_revision) ORDER BY wanted.ordinal`,
            [tuple.catalogId, batch.map((row) => row.id), tuple.scopeKey],
          )
        ).rows;
        state.bytes += Buffer.byteLength(JSON.stringify(rows), 'utf8');
        state.paths += rows.length;
        if (
          rows.length !== batch.length ||
          state.bytes > 64 * 1024 * 1024 ||
          state.paths > 100000
        )
          unavailable();
        for (const [index, row] of rows.entries()) {
          const old = batch[index]!,
            body = row.category;
          if (
            !row.expected ||
            !canonicalEqual(row.proof, row.expected) ||
            body['category_id'] !== old.id ||
            body['parent_id'] !== old.parent_id ||
            body['level'] !== old.level ||
            body['kind'] !== old.kind ||
            body['system_key'] !== old.system_key ||
            body['name'] !== old.name ||
            body['description'] !== old.description ||
            body['active'] !== old.active ||
            body['hidden'] !== old.hidden ||
            String(body['ordinal']) !== old.ordinal
          )
            unavailable();
          for (const source of [row.base, row.override]) {
            if (!source) continue;
            const key = `${source.id}:${source.revision}:${old.id}`;
            let decision = state.reviewed.get(key);
            if (!decision) {
              decision = await this.sourceReview(source, old.id, tx);
              state.reviewed.set(key, decision);
            }
            if (decision === 'deny') result[offset + index] = 'deny';
          }
        }
      }
    }
    return Object.freeze(result);
  }
}
