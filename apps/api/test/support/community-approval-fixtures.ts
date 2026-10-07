/** Disposable exact review facts only. Never imported by application/startup code. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  approvalDigest,
  canonicalEnvelope,
} from '../../src/community/content-review/contracts.js';
import type {
  AcceptedApproval,
  EffectiveContentEnvelope,
} from '../../src/community/content-review/contracts.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
export {
  approvalDigest,
  canonicalEnvelope,
} from '../../src/community/content-review/contracts.js';
export async function seedReviewPolicy(pool: Pool): Promise<string> {
  return withCommunityScopeWriter(pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_community.content_approval_policies
       (id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from,valid_until)
       VALUES($1,'local-explicit-v1',1,'complete','accepted','synthetic-review-owner','synthetic-review-policy-v1',$2,NULL)`,
      [id, new Date(Date.now() - 60_000)],
    );
    return id;
  });
}
export interface ApprovalFixtureOptions {
  policyRevisionId?: string;
  result?: 'allow' | 'reject' | 'pending' | 'failed';
  consumeUntil?: Date;
  visibilityUntil?: Date | null;
  state?: 'allow' | 'held' | 'revoked';
  evaluatedAt?: Date;
  coverage?: 'complete' | 'missing' | 'conflicting';
  provenance?: 'accepted' | 'unreconciled' | 'rejected';
}
export async function approveEnvelope(
  pool: Pool,
  value: EffectiveContentEnvelope,
  options: ApprovalFixtureOptions = {},
): Promise<AcceptedApproval> {
  const envelope = canonicalEnvelope(value);
  const digest = approvalDigest(envelope);
  return withCommunityScopeWriter(pool, async (tx) => {
    const policy =
      options.policyRevisionId ??
      (
        await tx.query<{ id: string }>(
          `SELECT id FROM whaleu_community.content_approval_policies WHERE coverage='complete' AND provenance='accepted' ORDER BY valid_from DESC,id DESC LIMIT 1`,
        )
      ).rows[0]?.id;
    assert.ok(
      policy,
      'Explicit synthetic review policy must be constructed before approval',
    );
    const id = randomUUID(),
      eventId = randomUUID();
    const evaluatedAt = options.evaluatedAt ?? new Date(Date.now() - 1000);
    const visibilityUntil = options.visibilityUntil ?? null;
    await tx.query(
      `INSERT INTO whaleu_community.content_approval_decisions
       (id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,
        coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model,visibility_until)
       VALUES($1,$2,$3,1,$4,$5::jsonb,$6,$7,$8,$9,'synthetic-review-owner','synthetic-exact-review',$10,$11,$12,$13)`,
      [
        id,
        envelope.accountId,
        envelope.purpose,
        digest,
        JSON.stringify(envelope),
        policy,
        options.result ?? 'allow',
        options.coverage ?? 'complete',
        options.provenance ?? 'accepted',
        evaluatedAt,
        options.consumeUntil ?? new Date(Date.now() + 3_600_000),
        visibilityUntil === null ? 'durable' : 'until',
        visibilityUntil,
      ],
    );
    await tx.query(
      `INSERT INTO whaleu_community.content_approval_events
       (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
       VALUES($1,$2,$3,'complete','accepted','synthetic-review-owner','synthetic-initial-state',$4)`,
      [eventId, id, options.state ?? 'allow', evaluatedAt],
    );
    await tx.query(
      'INSERT INTO whaleu_community.content_approval_heads(decision_id,event_id) VALUES($1,$2)',
      [id, eventId],
    );
    return { decisionId: id, digest, version: 1, envelope };
  });
}
export async function setReviewState(
  pool: Pool,
  decisionId: string,
  state: 'allow' | 'held' | 'revoked',
): Promise<string> {
  return withCommunityScopeWriter(pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_community.content_approval_events
       (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
       VALUES($1,$2,$3,'complete','accepted','synthetic-review-owner','synthetic-current-state',clock_timestamp())`,
      [id, decisionId, state],
    );
    const result = await tx.query(
      'UPDATE whaleu_community.content_approval_heads SET event_id=$1 WHERE decision_id=$2',
      [id, decisionId],
    );
    assert.equal(
      result.rowCount,
      1,
      'Synthetic review head must already exist',
    );
    return id;
  });
}
