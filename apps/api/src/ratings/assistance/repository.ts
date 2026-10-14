import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { ApplicationError } from '../../http/application-error.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import * as C from './contracts.js';

export interface AssistanceRecord {
  account_id: string;
  request_id: string;
  purpose: C.AssistancePurpose;
  intent_hash: string;
  draft_id: string;
  input_revision: number;
  session_id: string;
  context_id: string;
  source_revision: string;
  input_digest: string;
  profile: typeof C.ASSISTANCE_PROFILE;
  admitted_at: Date;
  queue_until: Date;
  payload_until: Date;
  intent: C.AssistanceRequest;
  provider_input: C.AssistanceProviderInput;
}
export interface AssistanceAccountingClaim {
  account_id: string;
  request_id: string;
  attempt: number;
  input_digest: string;
}
export interface AssistanceClaim extends AssistanceRecord {
  fence: string;
  lease_until: Date;
  attempt: number;
}
@Injectable()
export class RatingAssistanceRepository {
  async lock(actor: string, id: string, tx: PoolClient) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [
      actor,
      id,
    ]);
  }
  async metadata(
    actor: string,
    id: string,
    tx: PoolClient,
  ): Promise<C.AssistanceMetadata | null> {
    const r = (
      await tx.query(
        `SELECT c.request_id "requestId",c.purpose,c.intent_hash "intentHash",COALESCE(o.outcome,j.state) outcome FROM whaleu_ratings.assistance_claims c LEFT JOIN whaleu_ratings.assistance_outcomes o USING(account_id,request_id) LEFT JOIN whaleu_ratings.assistance_jobs j USING(account_id,request_id) WHERE c.account_id=$1 AND c.request_id=$2`,
        [actor, id],
      )
    ).rows[0];
    return r ? C.assistanceMetadataSchema.parse({ version: 1, ...r }) : null;
  }
  async expireUndispatched(actor: string, id: string, tx: PoolClient) {
    await this.lock(actor, id, tx);
    const expired = await tx.query(
      `SELECT 1 FROM whaleu_ratings.assistance_requests r JOIN whaleu_ratings.assistance_jobs j USING(account_id,request_id) WHERE r.account_id=$1 AND r.request_id=$2 AND r.queue_until<=clock_timestamp() AND j.state IN ('queued','claimed') AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.assistance_attempts a WHERE a.account_id=r.account_id AND a.request_id=r.request_id) FOR UPDATE OF j`,
      [actor, id],
    );
    if (expired.rowCount === 1) await this.finish(actor, id, 'expired', tx);
  }
  async bind(
    actor: string,
    id: string,
    purpose: C.AssistancePurpose,
    hash: string,
    tx: PoolClient,
  ) {
    await this.lock(actor, id, tx);
    const old = await this.metadata(actor, id, tx);
    if (old && (old.purpose !== purpose || old.intentHash !== hash))
      throw new ApplicationError('REQUEST_CONFLICT');
    if (!old)
      await tx.query(
        'INSERT INTO whaleu_ratings.assistance_claims(account_id,request_id,purpose,intent_hash) VALUES($1,$2,$3,$4)',
        [actor, id, purpose, hash],
      );
    return old;
  }
  async admit(
    actor: string,
    session: string,
    request: C.AssistanceRequest,
    input: C.AssistanceProviderInput,
    source: string,
    sourceBinding: unknown,
    tx: PoolClient,
  ) {
    const hash = C.assistanceIntentHash(request),
      digest = C.assistanceInputDigest(input, source);
    const now = (await tx.query<{ at: Date }>('SELECT clock_timestamp() at'))
      .rows[0]!.at;
    try {
      await tx.query(
        `INSERT INTO whaleu_ratings.assistance_requests(account_id,request_id,purpose,intent_hash,draft_id,input_revision,session_id,context_id,source_revision,input_digest,profile,admitted_at,queue_until,payload_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          actor,
          request.requestId,
          request.purpose,
          hash,
          request.draftId,
          request.inputRevision,
          session,
          request.context.id,
          source,
          digest,
          C.ASSISTANCE_PROFILE,
          now,
          new Date(now.getTime() + C.ASSISTANCE_LIMITS.queueMs),
          new Date(now.getTime() + C.ASSISTANCE_LIMITS.retentionMs),
        ],
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'constraint' in error &&
        error.constraint === 'assistance_quota'
      )
        throw new ApplicationError('RATING_ASSISTANCE_RATE_LIMITED');
      throw error;
    }
    await tx.query(
      'INSERT INTO whaleu_ratings.assistance_payloads(account_id,request_id,intent,provider_input,source_binding) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)',
      [
        actor,
        request.requestId,
        canonicalJson(request),
        canonicalJson(input),
        canonicalJson(sourceBinding),
      ],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.assistance_jobs(account_id,request_id,state) VALUES($1,$2,'queued')",
      [actor, request.requestId],
    );
  }
  async record(
    actor: string,
    id: string,
    tx: PoolClient,
  ): Promise<AssistanceRecord | null> {
    return (
      (
        await tx.query<AssistanceRecord>(
          'SELECT r.*,p.intent,p.provider_input FROM whaleu_ratings.assistance_requests r JOIN whaleu_ratings.assistance_payloads p USING(account_id,request_id) WHERE account_id=$1 AND request_id=$2 AND payload_until>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.assistance_cancellations x WHERE x.account_id=r.account_id AND x.request_id=r.request_id)',
          [actor, id],
        )
      ).rows[0] ?? null
    );
  }
  async cancelVisibility(actor: string, id: string, tx: PoolClient) {
    await this.lock(actor, id, tx);
    await tx.query(
      `INSERT INTO whaleu_ratings.assistance_cancellations(account_id,request_id,purpose,intent_hash) SELECT account_id,request_id,purpose,intent_hash FROM whaleu_ratings.assistance_claims WHERE account_id=$1 AND request_id=$2 ON CONFLICT DO NOTHING`,
      [actor, id],
    );
    await tx.query(
      'DELETE FROM whaleu_ratings.assistance_results WHERE account_id=$1 AND request_id=$2',
      [actor, id],
    );
    await tx.query(
      'DELETE FROM whaleu_ratings.assistance_payloads WHERE account_id=$1 AND request_id=$2',
      [actor, id],
    );
  }
  async finish(
    actor: string,
    id: string,
    outcome: 'unavailable' | 'rejected' | 'cancelled' | 'expired',
    tx: PoolClient,
  ) {
    await this.lock(actor, id, tx);
    await tx.query(
      `INSERT INTO whaleu_ratings.assistance_outcomes(account_id,request_id,purpose,intent_hash,outcome) SELECT account_id,request_id,purpose,intent_hash,$3 FROM whaleu_ratings.assistance_claims WHERE account_id=$1 AND request_id=$2 ON CONFLICT DO NOTHING`,
      [actor, id, outcome],
    );
    await tx.query(
      "UPDATE whaleu_ratings.assistance_jobs SET state='terminal' WHERE account_id=$1 AND request_id=$2 AND state<>'terminal'",
      [actor, id],
    );
    const result = await this.metadata(actor, id, tx);
    if (result?.outcome !== 'generated') {
      await tx.query(
        'DELETE FROM whaleu_ratings.assistance_results WHERE account_id=$1 AND request_id=$2',
        [actor, id],
      );
      await tx.query(
        'DELETE FROM whaleu_ratings.assistance_payloads WHERE account_id=$1 AND request_id=$2',
        [actor, id],
      );
    }
    return result!;
  }
  async finishClaim(
    claim: AssistanceClaim,
    outcome: 'unavailable' | 'rejected' | 'expired',
    tx: PoolClient,
  ) {
    await this.lock(claim.account_id, claim.request_id, tx);
    const current = await tx.query(
      `SELECT 1 FROM whaleu_ratings.assistance_jobs WHERE account_id=$1 AND request_id=$2 AND fence=$3 AND state IN ('claimed','dispatch_admitted','outcome_unknown') AND lease_until>clock_timestamp() FOR UPDATE`,
      [claim.account_id, claim.request_id, claim.fence],
    );
    if (current.rowCount !== 1)
      return this.metadata(claim.account_id, claim.request_id, tx);
    return this.finish(claim.account_id, claim.request_id, outcome, tx);
  }
  async finishAccounting(claim: AssistanceAccountingClaim, tx: PoolClient) {
    await this.lock(claim.account_id, claim.request_id, tx);
    const current = await tx.query(
      `SELECT 1 FROM whaleu_ratings.assistance_jobs WHERE account_id=$1 AND request_id=$2 AND (state='outcome_unknown' OR (state IN ('claimed','dispatch_admitted') AND lease_until<=clock_timestamp())) FOR UPDATE`,
      [claim.account_id, claim.request_id],
    );
    if (current.rowCount !== 1)
      return this.metadata(claim.account_id, claim.request_id, tx);
    return this.finish(claim.account_id, claim.request_id, 'unavailable', tx);
  }
  async claim(
    actor: string,
    id: string,
    tx: PoolClient,
  ): Promise<AssistanceClaim | null> {
    await this.lock(actor, id, tx);
    await tx.query('SELECT pg_advisory_xact_lock(146,2)');
    const job = (
      await tx.query<{
        state: string;
        fence: string;
        lease_until: Date | null;
      }>(
        `SELECT * FROM whaleu_ratings.assistance_jobs WHERE account_id=$1 AND request_id=$2 AND (state='queued' OR (state IN ('claimed','dispatch_admitted','outcome_unknown') AND lease_until<=clock_timestamp())) FOR UPDATE SKIP LOCKED`,
        [actor, id],
      )
    ).rows[0];
    if (!job) return null;
    const busy = (
      await tx.query<{ n: number }>(
        "SELECT count(*)::int n FROM whaleu_ratings.assistance_jobs WHERE state IN ('claimed','dispatch_admitted') AND lease_until>clock_timestamp()",
      )
    ).rows[0]!.n;
    if (busy >= C.ASSISTANCE_LIMITS.workers) return null;
    const r = await this.record(actor, id, tx);
    if (!r) {
      await this.finish(actor, id, 'expired', tx);
      return null;
    }
    const attempt = (
      await tx.query<{ n: number }>(
        'SELECT count(*)::int n FROM whaleu_ratings.assistance_attempts WHERE account_id=$1 AND request_id=$2',
        [actor, id],
      )
    ).rows[0]!.n;
    // Existing attempt means reconciliation, never an implicit resend.
    const updated = (
      await tx.query<{ fence: string; lease_until: Date }>(
        "UPDATE whaleu_ratings.assistance_jobs SET state='claimed',fence=fence+1,lease_until=clock_timestamp()+interval '30 seconds' WHERE account_id=$1 AND request_id=$2 RETURNING fence::text,lease_until",
        [actor, id],
      )
    ).rows[0]!;
    return { ...r, ...updated, attempt };
  }
  async current(claim: AssistanceClaim, tx: PoolClient) {
    const row = (
      await tx.query(
        `SELECT j.* FROM whaleu_ratings.assistance_jobs j JOIN whaleu_ratings.assistance_requests r USING(account_id,request_id) WHERE j.account_id=$1 AND j.request_id=$2 AND j.fence=$3 AND j.state IN ('claimed','dispatch_admitted','outcome_unknown') AND j.lease_until>clock_timestamp() AND r.payload_until>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.assistance_cancellations x WHERE x.account_id=j.account_id AND x.request_id=j.request_id) AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.assistance_outcomes o WHERE o.account_id=j.account_id AND o.request_id=j.request_id) FOR UPDATE OF j`,
        [claim.account_id, claim.request_id, claim.fence],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('RATING_ASSISTANCE_UNAVAILABLE');
    return row;
  }
  async dispatch(claim: AssistanceClaim, tx: PoolClient) {
    await this.current(claim, tx);
    const n = (await tx.query<{ at: Date }>('SELECT clock_timestamp() at'))
      .rows[0]!.at;
    const attempt = claim.attempt + 1;
    await tx.query(
      `INSERT INTO whaleu_ratings.assistance_attempts(account_id,request_id,purpose,intent_hash,input_digest,profile,attempt,fence,admitted_at,dispatch_until,reserved_input,reserved_output,reserved_money) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,512,64,0)`,
      [
        claim.account_id,
        claim.request_id,
        claim.purpose,
        claim.intent_hash,
        claim.input_digest,
        claim.profile,
        attempt,
        claim.fence,
        n,
        new Date(n.getTime() + C.ASSISTANCE_LIMITS.dispatchMs),
      ],
    );
    await tx.query(
      "UPDATE whaleu_ratings.assistance_jobs SET state='dispatch_admitted' WHERE account_id=$1 AND request_id=$2 AND fence=$3",
      [claim.account_id, claim.request_id, claim.fence],
    );
    return { attempt, deadline: n.getTime() + C.ASSISTANCE_LIMITS.dispatchMs };
  }
  async unknown(claim: AssistanceClaim, tx: PoolClient) {
    await tx.query(
      "UPDATE whaleu_ratings.assistance_jobs SET state='outcome_unknown' WHERE account_id=$1 AND request_id=$2 AND fence=$3 AND state IN ('claimed','dispatch_admitted','outcome_unknown')",
      [claim.account_id, claim.request_id, claim.fence],
    );
  }
  async settle(
    claim: AssistanceAccountingClaim,
    attempt: number,
    acceptance: 'accepted' | 'not_accepted' | 'conservatively_charged',
    usage: zUsage,
    tx: PoolClient,
  ) {
    const exact = C.assistanceUsageSchema.parse(usage);
    // The original attempt, not the latest lease, owns late provider accounting.
    await tx.query(
      `INSERT INTO whaleu_ratings.assistance_settlements(account_id,request_id,attempt,fence,input_digest,profile,acceptance,input_tokens,output_tokens,monetary_minor_units) SELECT account_id,request_id,attempt,fence,input_digest,profile,$4,$5,$6,0 FROM whaleu_ratings.assistance_attempts WHERE account_id=$1 AND request_id=$2 AND attempt=$3 ON CONFLICT DO NOTHING`,
      [
        claim.account_id,
        claim.request_id,
        attempt,
        acceptance,
        exact.inputTokens,
        exact.outputTokens,
      ],
    );
  }
  async generated(
    claim: AssistanceClaim,
    attempt: number,
    text: string,
    tx: PoolClient,
  ) {
    await this.lock(claim.account_id, claim.request_id, tx);
    await this.current(claim, tx);
    if (!C.validAssistanceOutput(claim.purpose, text))
      throw new ApplicationError('RATING_ASSISTANCE_UNAVAILABLE');
    const id = randomUUID(),
      digest = C.assistanceResultDigest(text);
    await tx.query(
      `INSERT INTO whaleu_ratings.assistance_outcomes(account_id,request_id,purpose,intent_hash,outcome,result_id,result_digest,attempt,fence) VALUES($1,$2,$3,$4,'generated',$5,$6,$7,$8)`,
      [
        claim.account_id,
        claim.request_id,
        claim.purpose,
        claim.intent_hash,
        id,
        digest,
        attempt,
        claim.fence,
      ],
    );
    await tx.query(
      'INSERT INTO whaleu_ratings.assistance_results(account_id,request_id,result_id,result_digest,literal_text) VALUES($1,$2,$3,$4,$5)',
      [claim.account_id, claim.request_id, id, digest, text],
    );
    await tx.query(
      "UPDATE whaleu_ratings.assistance_jobs SET state='terminal' WHERE account_id=$1 AND request_id=$2 AND fence=$3",
      [claim.account_id, claim.request_id, claim.fence],
    );
  }
  async result(actor: string, id: string, tx: PoolClient) {
    return (
      (
        await tx.query<{
          result_id: string;
          result_digest: string;
          literal_text: string;
        }>(
          `SELECT p.* FROM whaleu_ratings.assistance_results p JOIN whaleu_ratings.assistance_requests r USING(account_id,request_id) WHERE account_id=$1 AND request_id=$2 AND r.payload_until>clock_timestamp()`,
          [actor, id],
        )
      ).rows[0] ?? null
    );
  }
  async reconcileAdmission(claim: AssistanceAccountingClaim, tx: PoolClient) {
    await this.lock(claim.account_id, claim.request_id, tx);
    const n = (
      await tx.query<{ n: number }>(
        'SELECT count(*)::int n FROM whaleu_ratings.assistance_reconciliations WHERE account_id=$1 AND request_id=$2 AND attempt=$3',
        [claim.account_id, claim.request_id, claim.attempt],
      )
    ).rows[0]!.n;
    if (n >= 3) return false;
    await tx.query(
      'INSERT INTO whaleu_ratings.assistance_reconciliations(account_id,request_id,attempt,ordinal) VALUES($1,$2,$3,$4)',
      [claim.account_id, claim.request_id, claim.attempt, n + 1],
    );
    return true;
  }
  async unsettled(tx: PoolClient): Promise<AssistanceAccountingClaim[]> {
    return (
      await tx.query<AssistanceAccountingClaim>(
        `SELECT a.account_id,a.request_id,a.attempt,a.input_digest FROM whaleu_ratings.assistance_attempts a WHERE a.dispatch_until<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.assistance_settlements s WHERE (s.account_id,s.request_id,s.attempt)=(a.account_id,a.request_id,a.attempt)) ORDER BY a.admitted_at LIMIT 8`,
      )
    ).rows;
  }
  async cleanup(tx: PoolClient) {
    const rows = (
      await tx.query<{ account_id: string; request_id: string }>(
        `SELECT r.account_id,r.request_id FROM whaleu_ratings.assistance_requests r WHERE payload_until<=clock_timestamp() AND (EXISTS(SELECT 1 FROM whaleu_ratings.assistance_payloads p WHERE p.account_id=r.account_id AND p.request_id=r.request_id) OR EXISTS(SELECT 1 FROM whaleu_ratings.assistance_results p WHERE p.account_id=r.account_id AND p.request_id=r.request_id)) ORDER BY payload_until LIMIT 100`,
      )
    ).rows;
    for (const r of rows) {
      await this.lock(r.account_id, r.request_id, tx);
      // Expiry removes plaintext, never immutable identity, attempts or charges.
      await this.finish(r.account_id, r.request_id, 'expired', tx);
      await tx.query(
        'DELETE FROM whaleu_ratings.assistance_payloads WHERE account_id=$1 AND request_id=$2',
        [r.account_id, r.request_id],
      );
      await tx.query(
        'DELETE FROM whaleu_ratings.assistance_results WHERE account_id=$1 AND request_id=$2',
        [r.account_id, r.request_id],
      );
    }
    return rows.length;
  }
}
type zUsage = {
  inputTokens: number;
  outputTokens: number;
  monetaryMinorUnits: 0;
};
