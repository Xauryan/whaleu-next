import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
  transactionReadEpoch,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { categorySchema, idSchema } from '../contracts.js';
import type { Category } from '../contracts.js';
import { reclassificationCategorySchema } from './contracts.js';

const MAXIMUM_FACTS = 2048;
const MAXIMUM_SNAPSHOT_IDS = 100000;
const READ_BATCH = 512;
const unavailable = () => new ApplicationError('COMMUNITY_UNAVAILABLE');

interface CategoryEvidence {
  postId: string;
  originalCategory: Category | null;
  originalSpaceId: string | null;
  headPostId: string | null;
  headCategory: Category | null;
  revision: number | null;
  eventId: string | null;
  headXmin: string | null;
  livePostId: string | null;
  liveCategory: Category | null;
  liveRevision: number | null;
  liveEventId: string | null;
  policyId: string | null;
  reviewId: string | null;
  validUntil: string | null;
}
interface CategoryRow extends CategoryEvidence {
  batchValidUntil: string | null;
  batchValidUntilMs: number | null;
  batchValidUntilMicros: string | null;
}
interface CategoryRead {
  facts: readonly Readonly<CategoryEvidence>[];
  validUntil: number | null;
  exactValidUntil: string | null;
}

/** Every source lookup is keyed by one bounded set of canonical post IDs. Keep
 * publication category/space separate from the independent current overlay. */
const projection = `SELECT requested.post_id AS "postId",
  p.category AS "originalCategory",p.space_id AS "originalSpaceId",
  h.post_id AS "headPostId",h.current_category AS "headCategory",
  h.revision,h.event_id AS "eventId",h.xmin::text AS "headXmin",
  NULL::uuid AS "livePostId",NULL::text AS "liveCategory",
  NULL::integer AS "liveRevision",NULL::uuid AS "liveEventId",
  NULL::uuid AS "policyId",NULL::uuid AS "reviewId",NULL::text AS "validUntil",
  NULL::text AS "batchValidUntil",NULL::double precision AS "batchValidUntilMs",NULL::text AS "batchValidUntilMicros"
  FROM unnest($1::uuid[]) requested(post_id)
  LEFT JOIN whaleu_community.posts p ON p.id=requested.post_id
  LEFT JOIN whaleu_community.post_category_heads h ON h.post_id=p.id`;
/** Planning an untouched read must not expand the nested current Review views.
 * Moved IDs enter a separate bounded materialized owner projection. */
const liveProjection = `WITH category_read_live AS MATERIALIZED (
  SELECT live.* FROM whaleu_community.post_category_live live WHERE live.post_id=ANY($1::uuid[])
) SELECT requested.post_id AS "postId",
  live.post_id AS "livePostId",live.current_category AS "liveCategory",
  live.revision AS "liveRevision",live.event_id AS "liveEventId",
  live.policy_id AS "policyId",live.review_id AS "reviewId",
  live.valid_until::text AS "validUntil",
  (min(live.valid_until) OVER ())::text AS "batchValidUntil",
  floor(extract(epoch FROM min(live.valid_until) OVER ())*1000)::double precision AS "batchValidUntilMs",
  (extract(epoch FROM min(live.valid_until) OVER ())*1000000)::numeric(30,0)::text AS "batchValidUntilMicros"
  FROM unnest($1::uuid[]) requested(post_id)
  LEFT JOIN category_read_live live ON live.post_id=requested.post_id`;

function requestedIds(postIds: readonly string[], maximum: number): string[] {
  if (
    postIds.length > maximum ||
    postIds.some((id) => !idSchema.safeParse(id).success)
  )
    throw unavailable();
  return [...new Set(postIds.map((id) => id.toLowerCase()))];
}
function validId(value: unknown): value is string {
  return idSchema.safeParse(value).success;
}
function validUntil(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 10 && value.length <= 80;
}
function validateFact(fact: CategoryEvidence): void {
  if (
    !validId(fact.postId) ||
    (fact.originalCategory === null
      ? fact.originalSpaceId !== null || fact.headPostId !== null
      : !categorySchema.safeParse(fact.originalCategory).success ||
        !validId(fact.originalSpaceId))
  )
    throw unavailable();
  if (fact.headPostId === null) {
    if (
      fact.headCategory !== null ||
      fact.revision !== null ||
      fact.eventId !== null ||
      fact.headXmin !== null ||
      fact.livePostId !== null
    )
      throw unavailable();
  } else if (
    fact.headPostId !== fact.postId ||
    !reclassificationCategorySchema.safeParse(fact.headCategory).success ||
    !Number.isSafeInteger(fact.revision) ||
    fact.revision! < 1 ||
    fact.revision! > 2147483647 ||
    !validId(fact.eventId) ||
    typeof fact.headXmin !== 'string' ||
    !/^\d+$/.test(fact.headXmin)
  )
    throw unavailable();
  if (fact.livePostId === null) {
    if (
      fact.liveCategory !== null ||
      fact.liveRevision !== null ||
      fact.liveEventId !== null ||
      fact.policyId !== null ||
      fact.reviewId !== null ||
      fact.validUntil !== null
    )
      throw unavailable();
  } else if (
    fact.livePostId !== fact.headPostId ||
    fact.liveCategory !== fact.headCategory ||
    fact.liveRevision !== fact.revision ||
    fact.liveEventId !== fact.eventId ||
    !validId(fact.policyId) ||
    !validId(fact.reviewId) ||
    !validUntil(fact.validUntil)
  )
    throw unavailable();
}

async function readEvidence(
  postIds: readonly string[],
  tx: PoolClient,
): Promise<CategoryRead> {
  const facts: Readonly<CategoryEvidence>[] = [];
  let horizon: bigint | null = null;
  let exactValidUntil: string | null = null;
  let horizonMs: number | null = null;
  for (let offset = 0; offset < postIds.length; offset += READ_BATCH) {
    const ids = postIds.slice(offset, offset + READ_BATCH);
    const base = (await tx.query<CategoryRow>(projection, [ids])).rows;
    const expected = new Set(ids);
    if (base.length !== ids.length) throw unavailable();
    const moved = base
      .filter((row) => row.headPostId !== null)
      .map((row) => row.postId);
    const overlay = moved.length
      ? (
          await tx.query<
            Pick<
              CategoryRow,
              | 'postId'
              | 'livePostId'
              | 'liveCategory'
              | 'liveRevision'
              | 'liveEventId'
              | 'policyId'
              | 'reviewId'
              | 'validUntil'
              | 'batchValidUntil'
              | 'batchValidUntilMs'
              | 'batchValidUntilMicros'
            >
          >(liveProjection, [moved])
        ).rows
      : [];
    const live = new Map(overlay.map((row) => [row.postId, row]));
    if (
      overlay.length !== moved.length ||
      live.size !== moved.length ||
      moved.some((id) => !live.has(id))
    )
      throw unavailable();
    for (const source of base) {
      const row =
        source.headPostId === null
          ? source
          : { ...source, ...live.get(source.postId)! };
      if (!expected.delete(row.postId)) throw unavailable();
      const {
        batchValidUntil,
        batchValidUntilMs,
        batchValidUntilMicros,
        ...fact
      } = row;
      validateFact(fact);
      if (batchValidUntil === null) {
        if (
          batchValidUntilMs !== null ||
          batchValidUntilMicros !== null ||
          fact.validUntil !== null
        )
          throw unavailable();
      } else {
        if (
          !validUntil(batchValidUntil) ||
          !Number.isFinite(batchValidUntilMs) ||
          typeof batchValidUntilMicros !== 'string' ||
          !/^-?\d+$/.test(batchValidUntilMicros)
        )
          throw unavailable();
        const micros = BigInt(batchValidUntilMicros);
        if (horizon === null || micros < horizon) {
          horizon = micros;
          exactValidUntil = batchValidUntil;
          horizonMs = batchValidUntilMs;
        }
      }
      facts.push(Object.freeze(fact));
    }
  }
  return { facts, validUntil: horizonMs, exactValidUntil };
}

/** Final-only, nonblocking fences include current policy/Review authority and
 * absence of first heads or withdrawal records. The committed actor authority
 * is immutable event evidence; later role changes do not erase classification. */
export async function fencePostCategorySources(tx: PoolClient): Promise<void> {
  await tx.query(`LOCK TABLE
    whaleu_community.posts,
    whaleu_community.content_approval_bindings,
    whaleu_community.post_category_heads,
    whaleu_community.post_category_events,
    whaleu_community.post_category_issuers,
    whaleu_community.post_category_issuer_withdrawals,
    whaleu_community.post_category_policies,
    whaleu_community.post_category_policy_heads,
    whaleu_community.post_category_policy_withdrawals,
    whaleu_community.post_category_reviews,
    whaleu_community.post_category_review_withdrawals,
    whaleu_community.post_category_child_bindings
    IN SHARE MODE NOWAIT`);
}
const proof: RequiredTransactionProof<Readonly<CategoryEvidence>> = {
  maximumFacts: MAXIMUM_FACTS,
  failureCode: 'COMMUNITY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'COMMUNITY_UNAVAILABLE', async (read) => {
      if (facts.every((fact) => fact.headPostId === null))
        await read.query(
          'LOCK TABLE whaleu_community.posts,whaleu_community.post_category_heads IN SHARE MODE NOWAIT',
        );
      else await fencePostCategorySources(read);
      const current = await readEvidence(
        [...new Set(facts.map((fact) => fact.postId))],
        read,
      );
      const byId = new Map(
        current.facts.map((fact) => [fact.postId, ownerFingerprint(fact)]),
      );
      for (const fact of facts)
        if (byId.get(fact.postId) !== ownerFingerprint(fact))
          throw unavailable();
      // One exact SQL minimum avoids registering a deadline for every post. The
      // transaction wrapper samples the database clock after ALL owner proofs.
      registerTransactionExactDeadline(
        tx,
        current.exactValidUntil,
        'COMMUNITY_UNAVAILABLE',
      );
    }),
};
function categoriesFor(
  postIds: readonly string[],
  facts: readonly Readonly<CategoryEvidence>[],
): ReadonlyMap<string, Category | null> {
  const resolved = new Map(
    facts.map((fact) => [
      fact.postId,
      fact.headPostId === null ? fact.originalCategory : fact.liveCategory,
    ]),
  );
  return new Map(
    postIds.map((postId) => [
      postId,
      resolved.get(postId.toLowerCase()) ?? null,
    ]),
  );
}

const retained = new WeakMap<
  PoolClient,
  { epoch: object; categories: Map<string, Category | null> }
>();

/** The caller owns the canonical read/mutation transaction. Exact per-post
 * evidence permits unrelated writes by that same transaction; a whole-owner
 * epoch comparison here would wrongly reject normal likes/comments. */
export async function resolvePostCategories(
  postIds: readonly string[],
  tx: PoolClient,
): Promise<ReadonlyMap<string, Category | null>> {
  const ids = requestedIds(postIds, MAXIMUM_FACTS);
  if (!ids.length) return new Map();
  enableRequiredTransactionProof(tx, proof);
  const epoch = transactionReadEpoch(tx);
  if (!epoch) throw unavailable();
  let current = retained.get(tx);
  if (!current || current.epoch !== epoch) {
    current = { epoch, categories: new Map() };
    retained.set(tx, current);
  }
  const missing = ids.filter((id) => !current.categories.has(id));
  if (missing.length) {
    const read = await readEvidence(missing, tx);
    if (transactionReadEpoch(tx) !== epoch) throw unavailable();
    for (const fact of read.facts)
      registerRequiredTransactionFact(tx, proof, ownerFingerprint(fact), fact);
    for (const [id, category] of categoriesFor(missing, read.facts))
      current.categories.set(id, category);
  }
  return new Map(
    postIds.map((id) => [id, current.categories.get(id.toLowerCase()) ?? null]),
  );
}
export async function resolvePostCategory(
  postId: string,
  tx: PoolClient,
): Promise<Category | null> {
  return (await resolvePostCategories([postId], tx)).get(postId) ?? null;
}

/** Nonlocking bounded snapshot for count/search owners. This is NOT a standalone
 * proof: the caller must capture before enumeration and finally validate every
 * current category source plus the returned horizon.
 * It never registers mandatory facts against a budgeted proxy client. */
export async function readPostCategorySnapshot(
  postIds: readonly string[],
  tx: PoolClient,
): Promise<{
  categories: ReadonlyMap<string, Category | null>;
  validUntil: number | null;
  exactValidUntil: string | null;
}> {
  const ids = requestedIds(postIds, MAXIMUM_SNAPSHOT_IDS);
  const read = await readEvidence(ids, tx);
  return {
    categories: categoriesFor(postIds, read.facts),
    validUntil: read.validUntil,
    exactValidUntil: read.exactValidUntil,
  };
}
