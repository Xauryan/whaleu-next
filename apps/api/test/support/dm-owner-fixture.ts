/** Synthetic isolated owner fixtures only. Never imported by AppModule. */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import {
  canonicalDmEnvelope,
  dmApprovalDigest,
} from '../../src/community/content-review/dm-contracts.js';
import type { DmContentEnvelope } from '../../src/community/content-review/dm-contracts.js';
export interface DmApprovalOptions {
  result?: 'allow' | 'reject' | 'pending' | 'failed';
  state?: 'allow' | 'held' | 'revoked';
  consumeUntil?: Date;
  visibilityUntil?: Date;
  policyUntil?: Date;
  trusted?: boolean;
  issuerUntil?: Date;
}
export async function writeDmApproval(
  tx: PoolClient,
  value: DmContentEnvelope,
  options: DmApprovalOptions = {},
) {
  const envelope = canonicalDmEnvelope(value),
    digest = dmApprovalDigest(envelope),
    policyRevisionId = randomUUID(),
    decisionId = randomUUID(),
    eventId = randomUUID();
  const now = (
    await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
  ).rows[0]!.now.getTime();
  const evaluatedAt = new Date(
    Math.min(
      now - 1000,
      (options.consumeUntil?.getTime() ?? Infinity) - 1000,
      (options.visibilityUntil?.getTime() ?? Infinity) - 1000,
      (options.policyUntil?.getTime() ?? Infinity) - 1000,
      (options.issuerUntil?.getTime() ?? Infinity) - 1000,
    ),
  );
  await tx.query(
    `INSERT INTO whaleu_community.content_approval_policies(id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from,valid_until) VALUES($1,'local-explicit-v1',1,'complete','accepted','synthetic-dm-review','synthetic-dm-policy',$2,$3)`,
    [
      policyRevisionId,
      new Date(evaluatedAt.getTime() - 1000),
      options.policyUntil ?? null,
    ],
  );
  if (options.trusted !== false)
    await tx.query(
      `INSERT INTO whaleu_community.dm_review_issuers(issuer,policy_revision_id,purpose,active,coverage,provenance,source_reference,valid_from,valid_until) VALUES('synthetic-dm-review',$1,'send_private_message',true,'complete','accepted','isolated-test-fixture',$2,$3)`,
      [
        policyRevisionId,
        new Date(evaluatedAt.getTime() - 1000),
        options.issuerUntil ?? null,
      ],
    );
  await tx.query(
    `INSERT INTO whaleu_community.dm_approval_decisions(id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model,visibility_until) VALUES($1,$2,'send_private_message',1,$3,$4::jsonb,$5,$6,'complete','accepted','synthetic-dm-review','synthetic-exact-dm-approval',$7,$8,$9,$10)`,
    [
      decisionId,
      envelope.accountId,
      digest,
      canonicalJson(envelope),
      policyRevisionId,
      options.result ?? 'allow',
      evaluatedAt,
      options.consumeUntil ?? new Date(now + 3600000),
      options.visibilityUntil ? 'until' : 'durable',
      options.visibilityUntil ?? null,
    ],
  );
  await tx.query(
    `INSERT INTO whaleu_community.dm_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,$3,'complete','accepted','synthetic-dm-review','synthetic-dm-event',$4)`,
    [eventId, decisionId, options.state ?? 'allow', evaluatedAt],
  );
  await tx.query(
    'INSERT INTO whaleu_community.dm_approval_heads(decision_id,event_id) VALUES($1,$2)',
    [decisionId, eventId],
  );
  return {
    decisionId,
    policyRevisionId,
    eventId,
    digest,
    envelope,
    version: envelope.version,
  };
}
export async function approveDm(
  pool: Pool,
  envelope: DmContentEnvelope,
  options: DmApprovalOptions = {},
) {
  return withCommunityScopeWriter(pool, (tx) =>
    writeDmApproval(tx, envelope, options),
  );
}
export async function setDmReviewState(
  pool: Pool,
  id: string,
  state: 'allow' | 'held' | 'revoked',
) {
  return withCommunityScopeWriter(pool, async (tx) => {
    const eventId = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_community.dm_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,$3,'complete','accepted','synthetic-dm-review','synthetic-dm-state',clock_timestamp())`,
      [eventId, id, state],
    );
    await tx.query(
      'UPDATE whaleu_community.dm_approval_heads SET event_id=$2 WHERE decision_id=$1',
      [id, eventId],
    );
    return eventId;
  });
}
export async function writeDmTemporary(
  tx: PoolClient,
  accountId: string,
  options: {
    state?: 'verified' | 'unverified' | 'revoked';
    trusted?: boolean;
    validUntil?: Date;
  } = {},
) {
  const assertionId = randomUUID(),
    policyReference = `synthetic-dm-policy:${randomUUID()}`;
  const now = (
    await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
  ).rows[0]!.now.getTime();
  const previous = (
    await tx.query<{ effective_at: Date }>(
      'SELECT a.effective_at FROM whaleu_verification.dm_base_heads h JOIN whaleu_verification.dm_base_assertions a ON a.id=h.assertion_id WHERE h.account_id=$1',
      [accountId],
    )
  ).rows[0];
  const effectiveAt = new Date(
    Math.max(
      previous ? previous.effective_at.getTime() + 1 : -Infinity,
      Math.min(now - 1000, (options.validUntil?.getTime() ?? Infinity) - 1000),
    ),
  );
  if (options.trusted !== false)
    await tx.query(
      `INSERT INTO whaleu_verification.dm_issuers(issuer,policy_reference,purpose,active,coverage,provenance,source_reference,valid_from,valid_until) VALUES('synthetic-dm-base',$1,'private_messages',true,'complete','accepted','isolated-test-fixture',$2,NULL)`,
      [policyReference, new Date(effectiveAt.getTime() - 1000)],
    );
  await tx.query(
    `INSERT INTO whaleu_verification.dm_base_assertions(id,account_id,purpose,state,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until) VALUES($1,$2,'private_messages',$3,'complete','accepted','synthetic-dm-base','isolated-test-assertion',$4,$5,$6)`,
    [
      assertionId,
      accountId,
      options.state ?? 'verified',
      policyReference,
      effectiveAt,
      options.validUntil ?? new Date(now + 3600000),
    ],
  );
  await tx.query(
    'INSERT INTO whaleu_verification.dm_base_heads(account_id,assertion_id) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET assertion_id=excluded.assertion_id',
    [accountId, assertionId],
  );
  return { assertionId, policyReference };
}
export async function grantDmTemporary(
  pool: Pool,
  accountId: string,
  options: Parameters<typeof writeDmTemporary>[2] = {},
) {
  return withCommunityScopeWriter(pool, (tx) =>
    writeDmTemporary(tx, accountId, options),
  );
}
