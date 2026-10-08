/** Disposable synthetic facts through the production review schema. Never import
 * from application/startup code: no provider override or runtime issuer exists. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import {
  canonicalErrandEnvelope,
  errandApprovalDigest,
} from '../../src/community/content-review/errand-contracts.js';
import type { ErrandContentEnvelope } from '../../src/community/content-review/errand-contracts.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';

export interface ErrandReviewFixtureOptions {
  result?: 'allow' | 'reject' | 'pending' | 'failed';
  consumeUntil?: Date;
  visibilityUntil?: Date | null;
}
export interface ErrandReviewFixture {
  decisionId: string;
  policyRevisionId: string;
  eventId: string;
  digest: string;
  version: 1;
  envelope: ErrandContentEnvelope;
}

export async function approveErrand(
  pool: Pool,
  value: ErrandContentEnvelope,
  options: ErrandReviewFixtureOptions = {},
): Promise<ErrandReviewFixture> {
  const envelope = canonicalErrandEnvelope(value);
  const digest = errandApprovalDigest(envelope);
  // The shared fixture writer verifies the actual loopback connection and
  // disposable PostgreSQL 18 test database, then takes the EXCLUSIVE safety gate
  // before any policy/account/head mutation. Each fixture has its own policy.
  return withCommunityScopeWriter(pool, async (tx) => {
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]?.now.getTime();
    assert.ok(Number.isFinite(now), 'Synthetic review needs database time');
    const consumeUntil = options.consumeUntil ?? new Date(now! + 3_600_000);
    const visibilityUntil = options.visibilityUntil ?? null;
    assert.ok(
      consumeUntil instanceof Date && Number.isFinite(consumeUntil.getTime()),
      'Synthetic consumption deadline must be a finite date',
    );
    assert.ok(
      visibilityUntil === null ||
        (visibilityUntil instanceof Date &&
          Number.isFinite(visibilityUntil.getTime())),
      'Synthetic visibility deadline must be null or a finite date',
    );
    // Explicit expired fixtures remain structurally valid evidence: evaluation
    // predates every supplied deadline instead of violating ledger CHECKs.
    const evaluatedAt = new Date(
      Math.min(
        now! - 1000,
        consumeUntil.getTime() - 1000,
        visibilityUntil === null ? Infinity : visibilityUntil.getTime() - 1000,
      ),
    );
    const policyRevisionId = randomUUID(),
      decisionId = randomUUID(),
      eventId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_community.content_approval_policies
       (id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from,valid_until)
       VALUES($1,'local-explicit-v1',1,'complete','accepted',
         'synthetic-errand-review-owner','synthetic-errand-policy-v1',$2,NULL)`,
      [policyRevisionId, new Date(evaluatedAt.getTime() - 1000)],
    );
    await tx.query(
      `INSERT INTO whaleu_community.errand_approval_decisions
       (id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,
        coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model,visibility_until)
       VALUES($1,$2,'publish_errand',1,$3,$4::jsonb,$5,$6,'complete','accepted',
         'synthetic-errand-review-owner','synthetic-exact-errand-review',$7,$8,$9,$10)`,
      [
        decisionId,
        envelope.accountId,
        digest,
        canonicalJson(envelope),
        policyRevisionId,
        options.result ?? 'allow',
        evaluatedAt,
        consumeUntil,
        visibilityUntil === null ? 'durable' : 'until',
        visibilityUntil,
      ],
    );
    await tx.query(
      `INSERT INTO whaleu_community.errand_approval_events
       (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
       VALUES($1,$2,'allow','complete','accepted',
         'synthetic-errand-review-owner','synthetic-initial-errand-state',$3)`,
      [eventId, decisionId, evaluatedAt],
    );
    await tx.query(
      `INSERT INTO whaleu_community.errand_approval_heads(decision_id,event_id)
       VALUES($1,$2)`,
      [decisionId, eventId],
    );
    return {
      decisionId,
      policyRevisionId,
      eventId,
      digest,
      version: 1,
      envelope,
    };
  });
}

/** Append-only event plus monotonic head change; immutable review facts are never
 * overwritten. Calling this does not create a replacement consumption grant. */
export async function setErrandReviewState(
  pool: Pool,
  decisionId: string,
  state: 'allow' | 'held' | 'revoked',
): Promise<string> {
  return withCommunityScopeWriter(pool, async (tx) => {
    const eventId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_community.errand_approval_events
       (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
       VALUES($1,$2,$3,'complete','accepted',
         'synthetic-errand-review-owner','synthetic-current-errand-state',clock_timestamp())`,
      [eventId, decisionId, state],
    );
    const result = await tx.query(
      'UPDATE whaleu_community.errand_approval_heads SET event_id=$1 WHERE decision_id=$2',
      [eventId, decisionId],
    );
    assert.equal(
      result.rowCount,
      1,
      'Synthetic errand review head must already exist',
    );
    return eventId;
  });
}
export function holdErrandReview(
  pool: Pool,
  decisionId: string,
): Promise<string> {
  return setErrandReviewState(pool, decisionId, 'held');
}
export function revokeErrandReview(
  pool: Pool,
  decisionId: string,
): Promise<string> {
  return setErrandReviewState(pool, decisionId, 'revoked');
}
