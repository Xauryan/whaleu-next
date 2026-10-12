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
import { idSchema } from '../contracts.js';
import type { AcceptedApproval } from '../content-review/contracts.js';
import { exactCategoryReview } from './evidence.js';
export interface CategoryChildTarget {
  kind: 'comment' | 'reply';
  id: string;
  postId: string;
}
interface ChildFact extends CategoryChildTarget {
  allowed: boolean;
  head: string | null;
  binding: string | null;
  review: string | null;
  validUntil: string | null;
}
// Missing supplemental context is an old-child marker only because SQL enforces
// immutable original approval in the creation transaction and requires every
// post-head child to bind current context under the same parent lock. Audit
// timestamps are deliberately not authority; full original canonical approval
// and current continuation policy remain independent reader requirements.
const query = `SELECT q.kind,q.id,q.post_id AS "postId",h.event_id::text AS head,
 NULL::text AS binding,NULL::text AS review,(h.post_id IS NULL) AS allowed,NULL::text AS "validUntil"
 FROM jsonb_to_recordset($1::jsonb) q(kind text,id uuid,post_id uuid)
 JOIN whaleu_community.posts post ON post.id=q.post_id
 LEFT JOIN whaleu_community.post_category_heads h ON h.post_id=post.id`;
const movedQuery = `WITH category_child_wanted AS MATERIALIZED (
 SELECT * FROM jsonb_to_recordset($1::jsonb) q(kind text,id uuid,post_id uuid)
), category_child_live AS MATERIALIZED (
 SELECT l.* FROM whaleu_community.post_category_live l WHERE l.post_id IN (SELECT post_id FROM category_child_wanted)
), category_child_bindings AS MATERIALIZED (
 SELECT c.* FROM whaleu_community.post_category_child_bindings c JOIN category_child_wanted q
 ON c.content_kind=q.kind AND c.content_id=q.id AND c.post_id=q.post_id
), category_child_reviews AS MATERIALIZED (
 SELECT r.id,r.effective_until FROM whaleu_community.post_category_review_live r
 WHERE r.id IN (SELECT review_id FROM category_child_bindings) AND r.purpose='community_child_current_parent_classification'
) SELECT q.kind,q.id,q.post_id AS "postId",h.event_id::text AS head,c.review_id::text AS binding,r.id::text AS review,
 l.post_id IS NOT NULL AND b.content_id IS NOT NULL AND
 (CASE WHEN c.content_id IS NULL THEN pol.definition->'continueDescendants'='true'::jsonb
 ELSE c.original_decision_id=b.decision_id AND c.original_digest=b.digest AND r.id IS NOT NULL
 AND (c.event_id=h.event_id OR pol.definition->'continueDescendants'='true'::jsonb) END)
 AND (b.envelope->'images'='[]'::jsonb OR pol.definition->>'descendantMedia'='retain_current_media_proof') AS allowed,
 least(l.valid_until,r.effective_until)::text AS "validUntil"
 FROM category_child_wanted q
 JOIN whaleu_community.posts post ON post.id=q.post_id
 JOIN whaleu_community.post_category_heads h ON h.post_id=post.id
 LEFT JOIN category_child_live l ON l.post_id=h.post_id
 LEFT JOIN whaleu_community.post_category_policies pol ON pol.id=l.policy_id
 LEFT JOIN whaleu_community.content_approval_bindings b ON b.content_kind=q.kind AND b.content_id=q.id AND b.envelope->>'postId'=post.id::text
 LEFT JOIN category_child_bindings c ON c.content_kind=q.kind AND c.content_id=q.id AND c.post_id=post.id
 LEFT JOIN category_child_reviews r ON r.id=c.review_id`;

const childKey = (target: CategoryChildTarget) =>
  `${target.kind}:${target.id}:${target.postId}`;
function uniqueTargets(
  targets: readonly CategoryChildTarget[],
): CategoryChildTarget[] {
  if (
    targets.length > 100000 ||
    targets.some(
      (target) =>
        !['comment', 'reply'].includes(target.kind) ||
        !idSchema.safeParse(target.id).success ||
        !idSchema.safeParse(target.postId).success,
    )
  )
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  const subjects = new Map<string, string>();
  for (const target of targets) {
    const key = `${target.kind}:${target.id}`;
    const prior = subjects.get(key);
    if (prior && prior !== target.postId)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    subjects.set(key, target.postId);
  }
  return [
    ...new Map(targets.map((target) => [childKey(target), target])).values(),
  ];
}
async function facts(
  targets: readonly CategoryChildTarget[],
  tx: PoolClient,
): Promise<ChildFact[]> {
  const unique = uniqueTargets(targets);
  const rows: ChildFact[] = [];
  for (let i = 0; i < unique.length; i += 512) {
    const part = unique.slice(i, i + 512);
    const expected = new Set(part.map(childKey));
    const result = await tx.query<ChildFact>(query, [
      JSON.stringify(
        part.map((t) => ({ kind: t.kind, id: t.id, post_id: t.postId })),
      ),
    ]);
    const found = new Map<string, ChildFact>();
    for (const row of result.rows) {
      const key = childKey(row);
      if (!expected.has(key) || found.has(key))
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      found.set(key, { ...row, allowed: row.allowed === true });
    }
    const moved = [...found.values()].filter((row) => row.head !== null);
    if (moved.length) {
      const details = await tx.query<ChildFact>(movedQuery, [
        JSON.stringify(
          moved.map((row) => ({
            kind: row.kind,
            id: row.id,
            post_id: row.postId,
          })),
        ),
      ]);
      const seen = new Set<string>();
      for (const row of details.rows) {
        const key = childKey(row);
        const prior = found.get(key);
        if (
          !prior ||
          prior.head === null ||
          prior.head !== row.head ||
          seen.has(key)
        )
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        seen.add(key);
        found.set(key, { ...row, allowed: row.allowed === true });
      }
      if (seen.size !== moved.length)
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }
    for (const target of part)
      rows.push(
        found.get(childKey(target)) ?? {
          ...target,
          allowed: false,
          head: null,
          binding: null,
          review: null,
          validUntil: null,
        },
      );
  }
  return rows;
}
export async function batchCategoryChildContextSnapshot(
  targets: readonly CategoryChildTarget[],
  tx: PoolClient,
): Promise<{
  allowed: ReadonlyMap<string, boolean>;
  validUntil: number | null;
  exactValidUntil: string | null;
}> {
  const rows = await facts(targets, tx);
  let minimum: string | null = null;
  let milliseconds: number | null = null;
  for (const row of rows)
    if (row.validUntil) {
      const time = Date.parse(row.validUntil);
      if (!Number.isFinite(time))
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      if (milliseconds === null || time < milliseconds) {
        minimum = row.validUntil;
        milliseconds = time;
      }
    }
  return {
    allowed: new Map(rows.map((r) => [`${r.kind}:${r.id}`, r.allowed])),
    validUntil: milliseconds,
    exactValidUntil: minimum,
  };
}
export async function fenceCategoryChildSources(tx: PoolClient): Promise<void> {
  await tx.query(
    'LOCK TABLE whaleu_community.post_category_child_bindings,whaleu_community.post_category_live,whaleu_community.post_category_review_live,whaleu_community.content_approval_bindings IN SHARE MODE NOWAIT',
  );
}
const proof: RequiredTransactionProof<ChildFact> = {
  maximumFacts: 2048,
  failureCode: 'COMMUNITY_UNAVAILABLE',
  validate: (retained, tx) =>
    boundedOwnerProof(tx, 'COMMUNITY_UNAVAILABLE', async (read) => {
      if (retained.every((fact) => fact.head === null))
        await read.query(
          'LOCK TABLE whaleu_community.posts,whaleu_community.post_category_heads IN SHARE MODE NOWAIT',
        );
      else await fenceCategoryChildSources(read);
      const current = await facts(retained, read);
      const map = new Map(current.map((f) => [childKey(f), f]));
      for (const fact of retained)
        if (
          ownerFingerprint(map.get(childKey(fact))) !== ownerFingerprint(fact)
        )
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      // Aggregate after the final current-source reread, not once per child or
      // page batch. PostgreSQL keeps microseconds; the final clock runs last.
      const deadlines = current.flatMap((row) =>
        row.validUntil ? [row.validUntil] : [],
      );
      if (deadlines.length) {
        const minimum = (
          await read.query<{ until: string | null }>(
            'SELECT min(value)::text AS until FROM unnest($1::timestamptz[]) value',
            [deadlines],
          )
        ).rows[0]?.until;
        if (!minimum) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        registerTransactionExactDeadline(tx, minimum, 'COMMUNITY_UNAVAILABLE');
      }
    }),
};
const retained = new WeakMap<
  PoolClient,
  { epoch: object; facts: Map<string, Readonly<ChildFact>> }
>();
export async function batchCategoryChildContextAllowed(
  targets: readonly CategoryChildTarget[],
  tx: PoolClient,
  options: { retainProof?: boolean } = {},
): Promise<ReadonlyMap<string, boolean>> {
  const unique = uniqueTargets(targets);
  if (!unique.length) return new Map();
  if (options.retainProof === false) {
    const rows = await facts(unique, tx);
    return new Map(rows.map((row) => [`${row.kind}:${row.id}`, row.allowed]));
  }
  enableRequiredTransactionProof(tx, proof);
  const epoch = transactionReadEpoch(tx);
  if (!epoch) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  let current = retained.get(tx);
  if (!current || current.epoch !== epoch) {
    current = { epoch, facts: new Map() };
    retained.set(tx, current);
  }
  const missing = unique.filter(
    (target) => !current.facts.has(childKey(target)),
  );
  if (missing.length) {
    const rows = await facts(missing, tx);
    if (transactionReadEpoch(tx) !== epoch)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    for (const row of rows) {
      const fact = Object.freeze(row);
      registerRequiredTransactionFact(tx, proof, ownerFingerprint(fact), fact);
      current.facts.set(childKey(fact), fact);
    }
  }
  return new Map(
    unique.map((target) => [
      `${target.kind}:${target.id}`,
      current.facts.get(childKey(target))?.allowed === true,
    ]),
  );
}
export async function categoryChildContextAllowed(
  kind: 'comment' | 'reply',
  id: string,
  postId: string,
  tx: PoolClient,
): Promise<boolean> {
  return (
    (await batchCategoryChildContextAllowed([{ kind, id, postId }], tx)).get(
      `${kind}:${id}`,
    ) === true
  );
}
export async function bindCategoryChildContext(
  approval: AcceptedApproval,
  kind: 'comment' | 'reply',
  id: string,
  requestId: string,
  tx: PoolClient,
): Promise<void> {
  const postId = approval.envelope.postId;
  if (!postId) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  const head = (
    await tx.query<{ event_id: string; policy_id: string }>(
      'SELECT event_id,policy_id FROM whaleu_community.post_category_live WHERE post_id=$1',
      [postId],
    )
  ).rows[0];
  if (!head) {
    if (
      (
        await tx.query(
          'SELECT post_id FROM whaleu_community.post_category_heads WHERE post_id=$1',
          [postId],
        )
      ).rows.length
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return;
  }
  const envelope = (
    await tx.query<{ envelope: unknown }>(
      'SELECT whaleu_community.post_category_child_envelope($1,$2,$3,$4,$5) AS envelope',
      [
        approval.envelope.accountId,
        requestId,
        kind,
        approval.decisionId,
        head.event_id,
      ],
    )
  ).rows[0]?.envelope;
  if (!envelope) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  const reviewId = await exactCategoryReview(envelope, head.policy_id, tx);
  await tx.query(
    'INSERT INTO whaleu_community.post_category_child_bindings(content_kind,content_id,post_id,event_id,original_decision_id,original_digest,review_id,actor_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      kind,
      id,
      postId,
      head.event_id,
      approval.decisionId,
      approval.digest,
      reviewId,
      approval.envelope.accountId,
      requestId,
    ],
  );
  if (!(await categoryChildContextAllowed(kind, id, postId, tx)))
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
}
