import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  transactionReadEpoch,
  transactionLifetime,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import type { HomeDistributionSurface } from './candidate-sql.js';

const MAXIMUM_FACTS = 2048;
const READ_BATCH = 256;
const id = z.uuid().refine((value) => value === value.toLowerCase());
const factSchema = z.strictObject({
  postId: id,
  accountId: id,
  authorMode: z.enum(['named', 'anonymous']),
  version: z.number().int().min(1).max(7),
  dispositionId: id.nullable(),
  decisionId: id.nullable(),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  result: z.enum(['short_text', 'reference_only']).nullable(),
  surfaces: z
    .strictObject({
      home: z.literal(true),
      hot: z.enum(['disabled', 'exclude_water']),
      following: z.enum(['excluded', 'named_only_author_filter']),
    })
    .nullable(),
  valid: z.boolean(),
});
type Fact = z.infer<typeof factSchema>;
const unavailable = () => new ApplicationError('COMMUNITY_UNAVAILABLE');

/** Identity is private owner evidence only. Never attach any part of this row
 * to a public post DTO, even for an anonymous author viewing their own post.
 * Historical admissions are immutable: today's head and expiry are intentionally
 * absent. Current content Review/Safety/access remain independent owner checks.
 */
const projection = `SELECT p.id AS "postId",p.account_id AS "accountId",
  p.author_mode AS "authorMode",p.publication_envelope_version AS version,
  d.post_id AS "dispositionId",d.decision_id AS "decisionId",d.digest,
  d.evidence->>'result' AS result,a.definition->'surfaces' AS surfaces,
  CASE WHEN d.post_id IS NOT NULL OR p.publication_envelope_version=7
    THEN whaleu_community.home_post_disposition_valid(p.id) ELSE true END AS valid
  FROM whaleu_community.posts p
  LEFT JOIN whaleu_community.home_post_dispositions d ON d.post_id=p.id
  LEFT JOIN whaleu_community.home_policy_admissions a
    ON a.id=(d.evidence->'admission'->>'id')::uuid
    AND a.revision::text=d.evidence->'admission'->>'revision'
    AND a.digest=d.evidence->'admission'->>'digest'
  WHERE p.id=ANY($1::uuid[]) ORDER BY p.id`;

function requestedIds(postIds: readonly string[]): string[] {
  if (
    postIds.length > MAXIMUM_FACTS ||
    postIds.some((v) => !id.safeParse(v).success)
  )
    throw unavailable();
  return [...new Set(postIds)].sort();
}
async function readFacts(
  postIds: readonly string[],
  tx: PoolClient,
): Promise<Readonly<Fact>[]> {
  const facts: Readonly<Fact>[] = [];
  for (let offset = 0; offset < postIds.length; offset += READ_BATCH) {
    const ids = postIds.slice(offset, offset + READ_BATCH);
    const rows = (await tx.query<Fact>(projection, [ids])).rows;
    if (rows.length !== ids.length) throw unavailable();
    const expected = new Set(ids);
    for (const value of rows) {
      const parsed = factSchema.safeParse(value);
      if (!parsed.success) throw unavailable();
      const row = parsed.data;
      if (
        !expected.delete(row.postId) ||
        !row.valid ||
        (row.dispositionId === null
          ? row.version === 7 ||
            row.decisionId !== null ||
            row.digest !== null ||
            row.result !== null ||
            row.surfaces !== null
          : row.dispositionId !== row.postId ||
            row.version !== 7 ||
            row.decisionId === null ||
            row.digest === null ||
            row.surfaces === null)
      )
        throw unavailable();
      facts.push(Object.freeze(row));
    }
  }
  return facts;
}
const proof: RequiredTransactionProof<Readonly<Fact>> = {
  maximumFacts: MAXIMUM_FACTS,
  failureCode: 'COMMUNITY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'COMMUNITY_UNAVAILABLE', async (read) => {
      // Only bound V7 facts enter this owner. Legacy absent rows cannot acquire
      // Home metadata after creation or change their immutable envelope version.
      // These fences never follow an unbounded blocking wait.
      await read.query(`LOCK TABLE whaleu_community.posts,
      whaleu_community.home_post_dispositions,whaleu_community.home_policy_admissions,
      whaleu_community.content_approval_bindings,whaleu_community.content_approval_decisions
      IN SHARE MODE NOWAIT`);
      const current = new Map(
        (await readFacts(requestedIds(facts.map((f) => f.postId)), read)).map(
          (fact) => [fact.postId, ownerFingerprint(fact)],
        ),
      );
      for (const fact of facts)
        if (current.get(fact.postId) !== ownerFingerprint(fact))
          throw unavailable();
    }),
};
// Work is charged before SQL against the transaction lifetime, not its read
// epoch. Optional rollback invalidates authority caches but cannot refund work.
const budgets = new WeakMap<PoolClient, { lifetime: object; reads: number }>();
const retained = new WeakMap<
  PoolClient,
  { epoch: object; facts: Map<string, Readonly<Fact>> }
>();

/** One bounded batch per candidate window. Cache lifetime is an opaque managed
 * transaction read epoch, so optional rollback or client reuse cannot retain an
 * author identity or restriction from a previous read. Final proof rechecks it.
 */
export async function prepareHomeDistribution(
  postIds: readonly string[],
  tx: PoolClient,
): Promise<void> {
  const ids = requestedIds(postIds);
  if (!ids.length) return;
  enableRequiredTransactionProof(tx, proof);
  const epoch = transactionReadEpoch(tx);
  const lifetime = transactionLifetime(tx);
  if (!epoch || !lifetime) throw unavailable();
  let current = retained.get(tx);
  if (!current || current.epoch !== epoch) {
    current = { epoch, facts: new Map() };
    retained.set(tx, current);
  }
  const missing = ids.filter((postId) => !current.facts.has(postId));
  if (!missing.length) return;
  let budget = budgets.get(tx);
  if (!budget || budget.lifetime !== lifetime) {
    budget = { lifetime, reads: 0 };
    budgets.set(tx, budget);
  }
  if (budget.reads + missing.length > MAXIMUM_FACTS) throw unavailable();
  budget.reads += missing.length;
  const facts = await readFacts(missing, tx);
  if (transactionReadEpoch(tx) !== epoch) throw unavailable();
  for (const fact of facts) {
    // 0061 freezes publication_envelope_version; 0178's insertion guard requires
    // the exact fresh creation transaction and its deferred proof requires V7.
    // Therefore historical absence is permanent, not a mutable visibility fact.
    // Do not add a broad Home final fence to an entirely historical feed.
    if (fact.dispositionId !== null)
      registerRequiredTransactionFact(tx, proof, ownerFingerprint(fact), fact);
    current.facts.set(fact.postId, fact);
  }
}

/** Distribution-only gate. Never use this for detail/profile/search/saved or
 * references, and never accept a caller-supplied original author identity.
 * Following is explicitly new admitted behavior, not inferred legacy parity.
 */
export async function homeDistributionAllowed(
  postId: string,
  viewer: string | null,
  surface: HomeDistributionSurface,
  tx: PoolClient,
): Promise<boolean> {
  await prepareHomeDistribution([postId], tx);
  const fact = retained.get(tx)?.facts.get(postId);
  if (!fact) throw unavailable();
  if (fact.dispositionId === null || fact.result === null) return true;
  if (surface === 'official' || surface === 'related_sync') return false;
  if (viewer === null || viewer !== fact.accountId) return false;
  if (surface === 'following')
    return (
      fact.authorMode === 'named' &&
      fact.surfaces?.following === 'named_only_author_filter'
    );
  if (surface === 'hot') return fact.surfaces?.hot === 'exclude_water';
  return true;
}
