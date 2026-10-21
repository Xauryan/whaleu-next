import { retainReadingSchema, requireReadingSchema } from './readiness.js';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.js';
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
import { ReadingSourceOwner } from './source-owner.js';
import {
  eligible,
  FORMATTER,
  jobKey,
  sameIdentity,
  sourceIdentitySchema,
  sourceIdentity,
} from './contracts.js';
import type {
  SourceIdentity,
  SourceSnapshot,
  ReadingPlan,
} from './contracts.js';
import { decodeExactPlan } from './formatter.js';
const digest = z.string().regex(/^[a-f0-9]{64}$/),
  integerText = z.string().regex(/^[1-9][0-9]*$/);
const timeText = z.string().min(10).max(80);
export const schedulingSchema = z.object({
  job_key: digest,
  row_version: integerText,
  next_probe_at: timeText,
});
export interface QueueCursor {
  nextProbeAt: string;
  jobKey: string;
}
const jobSchema = z.object({
  job_key: digest,
  content_kind: z.enum(['post', 'comment', 'reply']),
  content_id: z.uuid(),
  source_revision: z.literal(1),
  source_hash: digest,
  publication_request_id: z.uuid(),
  formatter_version: z.literal(FORMATTER),
  generation: z.literal(1),
  state: z.enum(['pending', 'running', 'complete', 'exhausted']),
  claims: z.number().int().min(0).max(3),
  lease_fence: z.string().regex(/^(0|[1-9][0-9]*)$/),
  lease_token: z.uuid().nullable(),
  lease_until: timeText.nullable(),
  slot_id: z.number().int().min(1).max(2).nullable(),
  schedule_state: z.enum(['runnable', 'deferred', 'quarantined']),
  probe_count: z.number().int().min(0).max(3),
  next_probe_at: timeText.nullable(),
  next_attempt_at: timeText,
  row_version: integerText,
  write_transaction: z.string().regex(/^[0-9]+$/),
  scheduling_reason: z
    .enum([
      'authority_unavailable',
      'invalid_payload',
      'claims_exhausted',
      'completed',
      'computation_retry',
    ])
    .nullable(),
});
type Job = z.infer<typeof jobSchema>;
const projection =
  'j.*,j.row_version::text,j.lease_fence::text,j.lease_until::text,j.next_probe_at::text,j.next_attempt_at::text,j.write_transaction::text';
function identity(row: Job): SourceIdentity {
  return {
    kind: row.content_kind,
    id: row.content_id,
    sourceRevision: 1,
    sourceHash: row.source_hash,
    publicationRequestId: row.publication_request_id,
  };
}
export function decodeCandidate(raw: unknown) {
  const schedule = schedulingSchema.safeParse(raw);
  if (!schedule.success) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  return { schedule: schedule.data, job: jobSchema.safeParse(raw) };
}
interface Fact {
  key: string;
  fingerprint: string;
}
async function graph(key: string, tx: PoolClient) {
  return (
    await tx.query(
      `SELECT jsonb_build_object('head',(SELECT to_jsonb(h)||jsonb_build_object('xmin',h.xmin::text) FROM whaleu_community.reading_format_heads h WHERE (h.content_kind,h.content_id)=(j.content_kind,j.content_id)),'job',to_jsonb(j)||jsonb_build_object('xmin',j.xmin::text),'result',(SELECT to_jsonb(r)||jsonb_build_object('xmin',r.xmin::text) FROM whaleu_community.reading_format_results r WHERE r.job_key=j.job_key),'slots',(SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('xmin',s.xmin::text) ORDER BY slot_id) FROM whaleu_community.reading_format_slots s)) value FROM whaleu_community.reading_format_jobs j WHERE job_key=$1`,
      [key],
    )
  ).rows[0]?.['value'];
}
const graphProof: RequiredTransactionProof<Fact> = {
  maximumFacts: 8,
  failureCode: 'COMMUNITY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'COMMUNITY_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.reading_format_heads,whaleu_community.reading_format_jobs,whaleu_community.reading_format_results,whaleu_community.reading_format_slots IN SHARE MODE NOWAIT',
      );
      for (const f of facts)
        if (ownerFingerprint(await graph(f.key, read)) !== f.fingerprint)
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }),
};
async function retain(key: string, tx: PoolClient) {
  enableRequiredTransactionProof(tx, graphProof);
  const fingerprint = ownerFingerprint(await graph(key, tx));
  registerRequiredTransactionFact(
    tx,
    graphProof,
    key,
    Object.freeze({ key, fingerprint }),
  );
}
type Operation = 'enroll' | 'claim' | 'complete' | 'retry';
declare const permitBrand: unique symbol;
interface Permit {
  readonly [permitBrand]: true;
}
interface PermitState {
  owner: ReadingFormattingRuntime;
  tx: PoolClient;
  epoch: object;
  operation: Operation;
  source: SourceSnapshot;
  generation: 1;
  used: boolean;
}
const permits = new WeakMap<object, PermitState>();
export interface ReadingClaim {
  readonly key: string;
  readonly source: SourceSnapshot;
  readonly generation: 1;
  readonly leaseToken: string;
  readonly leaseFence: string;
  readonly slotId: number;
  readonly leaseUntil: string;
}
/** Real managed-transaction owner. Tokens never leave this module or cross compute. */
@Injectable()
export class ReadingFormattingRuntime {
  constructor(
    @Inject(DatabaseService) readonly database: DatabaseService,
    @Inject(ReadingSourceOwner) private readonly sources: ReadingSourceOwner,
  ) {}
  async installed(tx: PoolClient) {
    return retainReadingSchema(tx);
  }
  async ready(): Promise<boolean> {
    return this.database.transaction(
      async (tx) => {
        await requireReadingSchema(tx);
        return true;
      },
      { isolationLevel: 'read committed' },
    );
  }
  async #issue(
    expected: SourceIdentity,
    operation: Operation,
    tx: PoolClient,
  ): Promise<Permit> {
    await requireReadingSchema(tx);
    const epoch = transactionReadEpoch(tx);
    if (!epoch) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const source = await this.sources.resolve(expected, tx);
    const permit = Object.freeze({}) as Permit;
    permits.set(permit, {
      owner: this,
      tx,
      epoch,
      operation,
      source,
      generation: 1,
      used: false,
    });
    return permit;
  }
  #consume(
    permit: Permit,
    operation: Operation,
    expected: SourceIdentity,
    tx: PoolClient,
  ) {
    const state = permits.get(permit);
    if (
      !state ||
      state.used ||
      state.owner !== this ||
      state.tx !== tx ||
      state.epoch !== transactionReadEpoch(tx) ||
      state.operation !== operation ||
      !sameIdentity(state.source, expected) ||
      state.generation !== 1
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    state.used = true;
    return state.source;
  }
  async enrollCreated(
    kind: SourceIdentity['kind'],
    id: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<void> {
    const row = (
      await tx.query<{
        source_hash: string;
        source_format: string;
        reading_formatting: string | null;
        body: string;
      }>(
        `SELECT s.source_hash,s.source_format,s.reading_formatting,b.envelope->>'text' body FROM whaleu_community.community_text_sources s JOIN whaleu_community.content_approval_bindings b USING(content_kind,content_id) WHERE s.content_kind=$1 AND s.content_id=$2 AND s.client_request_id=$3 AND s.publication_transaction=pg_current_xact_id()`,
        [kind, id, requestId],
      )
    ).rows[0];
    if (!row) return;
    if (
      row.source_format !== 'plain' ||
      row.reading_formatting !== 'auto' ||
      Array.from(row.body).length < (kind === 'post' ? 300 : 200)
    )
      return;
    // Ineligible/Markdown/opted-out publications never enter the M2 owner.
    if (!(await this.installed(tx))) return;
    const expected = {
      kind,
      id,
      sourceRevision: 1 as const,
      sourceHash: row.source_hash,
      publicationRequestId: requestId,
    };
    const permit = await this.#issue(expected, 'enroll', tx);
    this.#consume(permit, 'enroll', expected, tx);
    await tx.query(
      `INSERT INTO whaleu_community.reading_format_heads(content_kind,content_id,source_revision,source_hash,publication_request_id,formatter_version,generation,state,row_version) VALUES($1,$2,1,$3,$4,$5,1,'active',1)`,
      [kind, id, row.source_hash, requestId, FORMATTER],
    );
    const key = jobKey(expected, 1);
    await tx.query(
      `INSERT INTO whaleu_community.reading_format_jobs(job_key,content_kind,content_id,source_revision,source_hash,publication_request_id,formatter_version,generation) VALUES($1,$2,$3,1,$4,$5,$6,1)`,
      [key, kind, id, row.source_hash, requestId, FORMATTER],
    );
    await retain(key, tx);
  }
  async candidates(cursor: QueueCursor | null): Promise<unknown[]> {
    return this.database.transaction(
      async (tx) => {
        if (!(await this.installed(tx))) return [];
        return (
          await tx.query(
            `SELECT ${projection} FROM whaleu_community.reading_format_jobs j WHERE j.schedule_state IN ('runnable','deferred') AND j.next_probe_at<=clock_timestamp() AND ($1::timestamptz IS NULL OR (j.next_probe_at,j.job_key)>($1::timestamptz,$2::text)) ORDER BY j.next_probe_at,j.job_key LIMIT 8`,
            [cursor?.nextProbeAt ?? null, cursor?.jobKey ?? null],
          )
        ).rows;
      },
      { isolationLevel: 'read committed' },
    );
  }
  /** Independent maintenance owner. Actual locked-row fingerprint and row-version,
   * not supplied source authority. Updates scheduling fields exclusively. */
  async defer(
    raw: unknown,
    reason: 'authority_unavailable' | 'invalid_payload',
  ): Promise<boolean> {
    const observed = decodeCandidate(raw).schedule;
    return this.database.transaction(
      async (tx) => {
        await requireReadingSchema(tx);
        if (!transactionReadEpoch(tx))
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        await tx.query(
          "SET LOCAL lock_timeout='5ms'; SET LOCAL statement_timeout='1000ms'",
        );
        const current = (
          await tx.query(
            `SELECT ${projection} FROM whaleu_community.reading_format_jobs j WHERE job_key=$1 FOR UPDATE NOWAIT`,
            [observed.job_key],
          )
        ).rows[0];
        if (
          !current ||
          ownerFingerprint(current) !== ownerFingerprint(raw) ||
          current['row_version'] !== observed.row_version
        )
          return false;
        const result = await tx.query(
          `UPDATE whaleu_community.reading_format_jobs SET probe_count=probe_count+CASE WHEN $3='invalid_payload' THEN 0 ELSE 1 END,schedule_state=CASE WHEN $3='invalid_payload' OR probe_count>=2 THEN 'quarantined' ELSE 'deferred' END,next_probe_at=CASE WHEN $3='invalid_payload' OR probe_count>=2 THEN NULL ELSE clock_timestamp()+CASE probe_count WHEN 0 THEN interval '5 seconds' ELSE interval '30 seconds' END END,scheduling_reason=$3,row_version=row_version+1 WHERE job_key=$1 AND row_version=$2 AND schedule_state<>'quarantined' AND next_probe_at<=clock_timestamp()`,
          [observed.job_key, observed.row_version, reason],
        );
        if (result.rowCount) await retain(observed.job_key, tx);
        return result.rowCount === 1;
      },
      { isolationLevel: 'read committed' },
    );
  }
  async claim(raw: unknown): Promise<ReadingClaim | null> {
    const parsed = decodeCandidate(raw);
    if (!parsed.job.success) return null;
    const discovered = parsed.job.data,
      expected = identity(discovered);
    return this.database.transaction(
      async (tx) => {
        const permit = await this.#issue(expected, 'claim', tx);
        await tx.query(
          "SELECT content_id FROM whaleu_community.reading_format_heads WHERE content_kind=$1 AND content_id=$2 AND generation=1 AND state='active' FOR UPDATE NOWAIT",
          [expected.kind, expected.id],
        );
        const slots = (
          await tx.query<{ slot_id: number; available: boolean }>(
            `SELECT slot_id,job_key IS NULL OR lease_until<=clock_timestamp() available FROM whaleu_community.reading_format_slots ORDER BY slot_id FOR UPDATE NOWAIT`,
          )
        ).rows;
        if (
          slots.length !== 2 ||
          slots[0]?.slot_id !== 1 ||
          slots[1]?.slot_id !== 2
        )
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        const locked = (
          await tx.query(
            `SELECT ${projection} FROM whaleu_community.reading_format_jobs j WHERE job_key=$1 FOR UPDATE NOWAIT`,
            [discovered.job_key],
          )
        ).rows[0];
        const row = jobSchema.parse(locked);
        if (
          !sameIdentity(identity(row), expected) ||
          row.row_version !== discovered.row_version
        )
          return null;
        const source = this.#consume(permit, 'claim', expected, tx);
        if (!eligible(source))
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        const slot = slots.find((s) => s.available);
        if (!slot) return null;
        if (row.claims === 3) {
          await tx.query(
            `UPDATE whaleu_community.reading_format_jobs SET state='exhausted',lease_token=NULL,lease_until=NULL,slot_id=NULL,schedule_state='quarantined',next_probe_at=NULL,scheduling_reason='claims_exhausted',row_version=row_version+1,write_transaction=pg_current_xact_id() WHERE job_key=$1 AND state='running' AND lease_until<=clock_timestamp()`,
            [row.job_key],
          );
          await tx.query(
            `UPDATE whaleu_community.reading_format_slots SET job_key=NULL,lease_token=NULL,lease_fence=NULL,lease_until=NULL,row_version=row_version+1 WHERE slot_id=$1 AND job_key=$2 AND lease_token=$3 AND lease_fence=$4 AND lease_until=$5::timestamptz AND lease_until<=clock_timestamp()`,
            [
              row.slot_id,
              row.job_key,
              row.lease_token,
              row.lease_fence,
              row.lease_until,
            ],
          );
          await retain(row.job_key, tx);
          return null;
        }
        const token = randomUUID();
        const changed = await tx.query<{
          lease_until: string;
          lease_fence: string;
        }>(
          `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) UPDATE whaleu_community.reading_format_jobs SET state='running',claims=claims+1,lease_fence=lease_fence+1,lease_token=$2,lease_until=instant.now+interval '10 seconds',slot_id=$3,schedule_state='runnable',next_probe_at=instant.now+interval '10 seconds',scheduling_reason=NULL,row_version=row_version+1,write_transaction=pg_current_xact_id() FROM instant WHERE job_key=$1 AND schedule_state<>'quarantined' AND next_attempt_at<=instant.now AND next_probe_at<=instant.now AND (state='pending' OR (state='running' AND lease_until<=instant.now)) RETURNING lease_until::text,lease_fence::text`,
          [row.job_key, token, slot.slot_id],
        );
        const lease = changed.rows[0];
        if (!lease) return null;
        // A previous lease for this same job may still occupy the other expired
        // slot. Release only the exact old locked-row triple, never another job
        // or a newer lease. Otherwise completion would leave a stale slot edge.
        if (row.slot_id !== null && row.slot_id !== slot.slot_id) {
          await tx.query(
            `UPDATE whaleu_community.reading_format_slots SET job_key=NULL,lease_token=NULL,lease_fence=NULL,lease_until=NULL,row_version=row_version+1 WHERE slot_id=$1 AND job_key=$2 AND lease_token=$3 AND lease_fence=$4 AND lease_until=$5::timestamptz AND lease_until<=clock_timestamp()`,
            [
              row.slot_id,
              row.job_key,
              row.lease_token,
              row.lease_fence,
              row.lease_until,
            ],
          );
        }
        await tx.query(
          `UPDATE whaleu_community.reading_format_slots SET job_key=$2,lease_token=$3,lease_fence=$4,lease_until=$5,row_version=row_version+1 WHERE slot_id=$1`,
          [
            slot.slot_id,
            row.job_key,
            token,
            lease.lease_fence,
            lease.lease_until,
          ],
        );
        registerTransactionExactDeadline(
          tx,
          lease.lease_until,
          'COMMUNITY_UNAVAILABLE',
        );
        await retain(row.job_key, tx);
        return {
          key: row.job_key,
          source,
          generation: 1,
          leaseToken: token,
          leaseFence: lease.lease_fence,
          slotId: slot.slot_id,
          leaseUntil: lease.lease_until,
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
  /** Bounded processing retry is separate from unavailable-authority probes. */
  async retry(claim: ReadingClaim): Promise<boolean> {
    return this.database.transaction(
      async (tx) => {
        const expected = sourceIdentitySchema.parse(
          sourceIdentity(claim.source),
        );
        const permit = await this.#issue(expected, 'retry', tx);
        await tx.query(
          "SELECT content_id FROM whaleu_community.reading_format_heads WHERE content_kind=$1 AND content_id=$2 AND generation=$3 AND state='active' FOR UPDATE NOWAIT",
          [expected.kind, expected.id, claim.generation],
        );
        await tx.query(
          'SELECT slot_id FROM whaleu_community.reading_format_slots ORDER BY slot_id FOR UPDATE NOWAIT',
        );
        const raw = (
          await tx.query(
            `SELECT ${projection} FROM whaleu_community.reading_format_jobs j WHERE job_key=$1 FOR UPDATE NOWAIT`,
            [claim.key],
          )
        ).rows[0];
        if (!raw) return false;
        const row = jobSchema.parse(raw);
        this.#consume(permit, 'retry', expected, tx);
        if (
          !sameIdentity(identity(row), expected) ||
          row.state !== 'running' ||
          row.lease_token !== claim.leaseToken ||
          row.lease_fence !== claim.leaseFence ||
          row.slot_id !== claim.slotId ||
          row.generation !== claim.generation ||
          claim.key !== jobKey(expected, claim.generation)
        )
          return false;
        const current =
          (
            await tx.query(
              'SELECT slot_id FROM whaleu_community.reading_format_slots WHERE slot_id=$1 AND job_key=$2 AND lease_token=$3 AND lease_fence=$4 AND lease_until=$5::timestamptz AND lease_until>clock_timestamp()',
              [
                claim.slotId,
                claim.key,
                claim.leaseToken,
                claim.leaseFence,
                row.lease_until,
              ],
            )
          ).rowCount === 1;
        if (!current) return false;
        registerTransactionExactDeadline(
          tx,
          row.lease_until,
          'COMMUNITY_UNAVAILABLE',
        );
        await tx.query(
          `WITH instant AS MATERIALIZED(SELECT clock_timestamp()+CASE WHEN $2=1 THEN interval '5 seconds' ELSE interval '30 seconds' END retry_at) UPDATE whaleu_community.reading_format_jobs SET state=CASE WHEN claims=3 THEN 'exhausted' ELSE 'pending' END,lease_token=NULL,lease_until=NULL,slot_id=NULL,schedule_state=CASE WHEN claims=3 THEN 'quarantined' ELSE 'deferred' END,next_attempt_at=CASE WHEN claims=3 THEN next_attempt_at ELSE instant.retry_at END,next_probe_at=CASE WHEN claims=3 THEN NULL ELSE instant.retry_at END,scheduling_reason=CASE WHEN claims=3 THEN 'claims_exhausted' ELSE 'computation_retry' END,row_version=row_version+1,write_transaction=pg_current_xact_id() FROM instant WHERE job_key=$1`,
          [claim.key, row.claims],
        );
        await tx.query(
          'UPDATE whaleu_community.reading_format_slots SET job_key=NULL,lease_token=NULL,lease_fence=NULL,lease_until=NULL,row_version=row_version+1 WHERE slot_id=$1 AND job_key=$2 AND lease_token=$3 AND lease_fence=$4',
          [claim.slotId, claim.key, claim.leaseToken, claim.leaseFence],
        );
        await retain(claim.key, tx);
        return true;
      },
      { isolationLevel: 'read committed' },
    );
  }
  async complete(claim: ReadingClaim, plan: ReadingPlan): Promise<boolean> {
    return this.database.transaction(
      async (tx) => {
        const expected = sourceIdentitySchema.parse(
            sourceIdentity(claim.source),
          ),
          permit = await this.#issue(expected, 'complete', tx);
        await tx.query(
          `SELECT content_id FROM whaleu_community.reading_format_heads WHERE content_kind=$1 AND content_id=$2 AND generation=$3 AND state='active' FOR UPDATE NOWAIT`,
          [expected.kind, expected.id, claim.generation],
        );
        await tx.query(
          'SELECT slot_id FROM whaleu_community.reading_format_slots ORDER BY slot_id FOR UPDATE NOWAIT',
        );
        const row = (
          await tx.query(
            `SELECT ${projection} FROM whaleu_community.reading_format_jobs j WHERE job_key=$1 FOR UPDATE NOWAIT`,
            [claim.key],
          )
        ).rows[0];
        if (!row) return false;
        const job = jobSchema.parse(row),
          source = this.#consume(permit, 'complete', expected, tx);
        if (
          !sameIdentity(identity(job), expected) ||
          job.generation !== claim.generation ||
          claim.key !== jobKey(expected, claim.generation)
        )
          return false;
        const exact = decodeExactPlan(source, JSON.stringify(plan));
        if (!exact) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        if (job.state === 'complete') {
          const existing = (
            await tx.query<{ plan: unknown }>(
              `SELECT plan FROM whaleu_community.reading_format_results WHERE job_key=$1 AND lease_token=$2 AND lease_fence=$3`,
              [claim.key, claim.leaseToken, claim.leaseFence],
            )
          ).rows[0];
          if (
            !existing ||
            !decodeExactPlan(source, JSON.stringify(existing.plan))
          )
            return false;
          await retain(claim.key, tx);
          return true;
        }
        if (
          job.state !== 'running' ||
          job.lease_token !== claim.leaseToken ||
          job.lease_fence !== claim.leaseFence ||
          job.slot_id !== claim.slotId
        )
          return false;
        const valid =
          (
            await tx.query(
              `SELECT slot_id FROM whaleu_community.reading_format_slots WHERE slot_id=$1 AND job_key=$2 AND lease_token=$3 AND lease_fence=$4 AND lease_until=$5::timestamptz AND lease_until>clock_timestamp()`,
              [
                claim.slotId,
                claim.key,
                claim.leaseToken,
                claim.leaseFence,
                job.lease_until,
              ],
            )
          ).rowCount === 1;
        if (!valid) return false;
        registerTransactionExactDeadline(
          tx,
          job.lease_until,
          'COMMUNITY_UNAVAILABLE',
        );
        await tx.query(
          `INSERT INTO whaleu_community.reading_format_results(job_key,plan,lease_token,lease_fence) VALUES($1,$2::jsonb,$3,$4)`,
          [
            claim.key,
            JSON.stringify(exact),
            claim.leaseToken,
            claim.leaseFence,
          ],
        );
        await tx.query(
          `UPDATE whaleu_community.reading_format_jobs SET state='complete',lease_token=NULL,lease_until=NULL,slot_id=NULL,schedule_state='quarantined',next_probe_at=NULL,scheduling_reason='completed',row_version=row_version+1,write_transaction=pg_current_xact_id() WHERE job_key=$1`,
          [claim.key],
        );
        await tx.query(
          `UPDATE whaleu_community.reading_format_slots SET job_key=NULL,lease_token=NULL,lease_fence=NULL,lease_until=NULL,row_version=row_version+1 WHERE slot_id=$1 AND job_key=$2 AND lease_token=$3 AND lease_fence=$4`,
          [claim.slotId, claim.key, claim.leaseToken, claim.leaseFence],
        );
        await retain(claim.key, tx);
        return true;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
