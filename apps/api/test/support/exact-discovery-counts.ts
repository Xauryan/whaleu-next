/** Canonical disposable data and observation only; no runtime policy providers. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Pool, PoolClient } from 'pg';
import type { INestApplication } from '@nestjs/common';
import { DatabaseService } from '../../src/database/database.js';
import type { TransactionOptions } from '../../src/database/database.js';
import {
  approvalDigest,
  canonicalEnvelope,
} from '../../src/community/content-review/contracts.js';
import type {
  ContentKind,
  EffectiveContentEnvelope,
} from '../../src/community/content-review/contracts.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';

export interface ExactSeedRow {
  id: string;
  decision: string;
  event: string;
  at: string;
  state: 'allow' | 'held' | 'revoked';
  envelope: EffectiveContentEnvelope;
  digest: string;
}
export async function seedExactContent(
  pool: Pool,
  policyId: string,
  kind: ContentKind,
  count: number,
  definition: (index: number) => EffectiveContentEnvelope,
  options: {
    time?: (index: number) => string;
    state?: (index: number) => ExactSeedRow['state'];
    id?: (index: number) => string;
    visibilityUntil?: Date;
  } = {},
): Promise<ExactSeedRow[]> {
  const result: ExactSeedRow[] = [];
  // Fixture arrays are not the count algorithm. Still keep fixture writes bounded
  // so reproducing a benchmark does not need one oversized bind value.
  for (let offset = 0; offset < count; offset += 512) {
    const rows = Array.from(
      { length: Math.min(512, count - offset) },
      (_, j) => {
        const index = offset + j,
          envelope = canonicalEnvelope(definition(index));
        return {
          id: options.id?.(index) ?? randomUUID(),
          decision: randomUUID(),
          event: randomUUID(),
          at:
            options.time?.(index) ??
            new Date(Date.UTC(2020, 0, 1) - index * 1000).toISOString(),
          state: options.state?.(index) ?? 'allow',
          envelope,
          digest: approvalDigest(envelope),
        };
      },
    );
    await withCommunityScopeWriter(pool, async (tx) => {
      await tx.query(
        `CREATE TEMP TABLE exact_seed(id uuid, decision uuid, event uuid, at timestamptz, state text, envelope jsonb, digest text) ON COMMIT DROP`,
      );
      await tx.query(
        `INSERT INTO exact_seed SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,decision uuid,event uuid,at timestamptz,state text,envelope jsonb,digest text)`,
        [JSON.stringify(rows)],
      );
      if (kind === 'post') {
        await tx.query(`INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,published_at)
          SELECT id,(envelope->>'spaceId')::uuid,(envelope->>'accountId')::uuid,envelope->>'category',envelope->>'text',envelope->>'authorMode',envelope->>'commentsPolicy',at FROM exact_seed`);
        await tx.query(`INSERT INTO whaleu_community.trading_listings(post_id,subtype,price,urgency,location,wechat,qq,phone)
          SELECT id,envelope->'trading'->>'subtype',(envelope->'trading'->>'price')::numeric,envelope->'trading'->>'urgency',envelope->'trading'->>'location',envelope->'trading'->'contacts'->>'wechat',envelope->'trading'->'contacts'->>'qq',envelope->'trading'->'contacts'->>'phone'
          FROM exact_seed WHERE envelope->>'category'='trading'`);
      } else if (kind === 'comment') {
        await tx.query(`INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode,created_at)
          SELECT id,(envelope->>'postId')::uuid,(envelope->>'accountId')::uuid,envelope->>'text',envelope->>'authorMode',at FROM exact_seed`);
      } else {
        await tx.query(`INSERT INTO whaleu_community.replies(id,post_id,root_comment_id,target_reply_id,account_id,text,author_mode,created_at)
          SELECT id,(envelope->>'postId')::uuid,(envelope->>'rootCommentId')::uuid,(envelope->>'targetReplyId')::uuid,(envelope->>'accountId')::uuid,envelope->>'text',envelope->>'authorMode',at FROM exact_seed`);
      }
      await tx.query(`INSERT INTO whaleu_community.${kind}_images(${kind}_id,asset_id,digest,position)
        SELECT s.id,(image.value->>'assetId')::uuid,image.value->>'digest',(image.ordinality-1)::integer
        FROM exact_seed s CROSS JOIN LATERAL jsonb_array_elements(s.envelope->'images') WITH ORDINALITY AS image(value,ordinality)`);
      // Normal anonymous publication creates its thread-local display persona.
      // Bulk fixtures must do the same; otherwise a randomly selected anonymous
      // preview fails even though its canonical visibility/count facts are valid.
      await tx.query(
        `INSERT INTO whaleu_community.thread_personas(id,post_id,account_id,display_name)
         SELECT gen_random_uuid(),CASE WHEN $1='post' THEN id ELSE (envelope->>'postId')::uuid END,
           (envelope->>'accountId')::uuid,'匿名鲸鱼'
         FROM exact_seed WHERE envelope->>'authorMode'='anonymous'
         ON CONFLICT(post_id,account_id) DO NOTHING`,
        [kind],
      );
      await tx.query(
        `INSERT INTO whaleu_community.content_approval_decisions
        (id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model,visibility_until)
        SELECT decision,(envelope->>'accountId')::uuid,envelope->>'purpose',1,digest,envelope,$1,'allow','complete','accepted','synthetic-review-owner','exact-count-fixture',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour',$2,$3 FROM exact_seed`,
        [
          policyId,
          options.visibilityUntil ? 'until' : 'durable',
          options.visibilityUntil ?? null,
        ],
      );
      await tx.query(`INSERT INTO whaleu_community.content_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
        SELECT event,decision,state,'complete','accepted','synthetic-review-owner','exact-count-state',clock_timestamp() FROM exact_seed`);
      await tx.query(
        `INSERT INTO whaleu_community.content_approval_heads(decision_id,event_id) SELECT decision,event FROM exact_seed`,
      );
      await tx.query(
        `INSERT INTO whaleu_community.content_approval_bindings(content_kind,content_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope)
        SELECT $1,id,1,decision,(envelope->>'accountId')::uuid,envelope->>'purpose',1,digest,envelope,envelope->'scope' FROM exact_seed`,
        [kind],
      );
    });
    result.push(...rows);
  }
  return result;
}

export async function seedExactLikes(
  pool: Pool,
  owner: string,
  kind: ContentKind,
  ids: readonly string[],
  dated: boolean,
): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += 512) {
    const batch = ids.slice(offset, offset + 512);
    await pool.query(
      `INSERT INTO whaleu_community.${kind}_likes(${kind}_id,account_id${dated ? ',liked_at' : ''}) SELECT unnest($1::uuid[]),$2${dated ? ", '2021-01-01T00:00:00.000Z'::timestamptz" : ''}`,
      [batch, owner],
    );
  }
}

export interface ExactQueryObservation {
  sql: string;
  values: unknown[];
  rows: number;
  bytes: number;
  durationMs: number;
}
export interface ExactMeasurement {
  label: string;
  durationMs: number;
  queries: number;
  resultBytes: number;
  maxQueryRows: number;
  maxQueryBytes: number;
  maxBindArray: number;
  maxCountBatchBytes: number;
  heapEnd: number;
  heapStart: number;
  heapHighWater: number;
  countQueries: number;
  begins: string[];
  queryGroups: Record<string, number>;
}
/** Instrument the actual pg client; every call/result still uses ordinary SQL. */
export function observeExactQueries(app: INestApplication) {
  const database = app.get(DatabaseService);
  const originalTransaction = database.transaction.bind(database);
  let active: ExactMeasurement | null = null;
  let hook:
    ((event: ExactQueryObservation, tx: PoolClient) => Promise<void>) | null =
    null;
  let failureHook:
    | ((
        event: { sql: string; code: string | null },
        tx: PoolClient,
      ) => Promise<void>)
    | null = null;
  database.transaction = async function <T>(
    operation: (tx: PoolClient) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const measurement = active;
    if (measurement)
      measurement.begins.push(options.isolationLevel ?? 'server default');
    let restore: (() => void) | undefined;
    let batchBytes: number | null = null;
    try {
      return await originalTransaction(async (tx) => {
        const originalQuery = tx.query.bind(tx);
        restore = () => {
          tx.query = originalQuery;
        };
        tx.query = (async (sql: string, values?: unknown[]) => {
          const start = performance.now();
          let result;
          try {
            result = await originalQuery(sql, values);
          } catch (error) {
            if (failureHook)
              await failureHook(
                {
                  sql,
                  code:
                    typeof error === 'object' &&
                    error !== null &&
                    'code' in error
                      ? String(error.code)
                      : null,
                },
                tx,
              );
            throw error;
          }
          // PostgreSQL returns one result per statement for multi-SET budgets.
          // Observe their rows without changing the result returned to the owner.
          const rows = Array.isArray(result)
            ? result.flatMap((part) => part.rows)
            : result.rows;
          const bytes = Buffer.byteLength(JSON.stringify(rows));
          if (measurement) {
            measurement.queries++;
            measurement.resultBytes += bytes;
            const countCandidate =
              /LIMIT\s+257/i.test(sql) &&
              !sql.includes('count_snapshot_source');
            if (countCandidate) batchBytes = 0;
            if (batchBytes !== null) {
              batchBytes += bytes;
              measurement.maxCountBatchBytes = Math.max(
                measurement.maxCountBatchBytes,
                batchBytes,
              );
            }
            if (sql === 'RELEASE SAVEPOINT discovery_optional_count')
              batchBytes = null;

            measurement.maxQueryRows = Math.max(
              measurement.maxQueryRows,
              rows.length,
            );
            measurement.maxQueryBytes = Math.max(
              measurement.maxQueryBytes,
              bytes,
            );
            measurement.maxBindArray = Math.max(
              measurement.maxBindArray,
              ...(values ?? []).filter(Array.isArray).map((v) => v.length),
            );
            measurement.heapHighWater = Math.max(
              measurement.heapHighWater,
              process.memoryUsage().heapUsed,
            );
            if (
              /LIMIT\s+257/i.test(sql) &&
              !sql.includes('count_snapshot_source')
            )
              measurement.countQueries++;
            const group =
              sql.match(/(?:FROM|INTO|UPDATE)\s+(whaleu_\w+\.\w+)/i)?.[1] ??
              sql.split(/\s+/).slice(0, 3).join(' ');
            measurement.queryGroups[group] =
              (measurement.queryGroups[group] ?? 0) + 1;
          }
          if (hook)
            await hook(
              {
                sql,
                values: values ?? [],
                rows: rows.length,
                bytes,
                durationMs: performance.now() - start,
              },
              tx,
            );
          return result;
        }) as typeof tx.query;
        return operation(tx);
      }, options);
    } finally {
      restore?.();
    }
  };
  return {
    async measure<T>(
      label: string,
      operation: () => Promise<T>,
    ): Promise<{ value: T; measurement: ExactMeasurement }> {
      assert.equal(active, null, 'Measurements must run serially');
      const start = performance.now(),
        heap = process.memoryUsage().heapUsed;
      const measurement: ExactMeasurement = {
        label,
        durationMs: 0,
        queries: 0,
        resultBytes: 0,
        maxQueryRows: 0,
        maxQueryBytes: 0,
        maxBindArray: 0,
        maxCountBatchBytes: 0,
        heapEnd: heap,
        heapStart: heap,
        heapHighWater: heap,
        countQueries: 0,
        begins: [],
        queryGroups: {},
      };
      active = measurement;
      try {
        const value = await operation();
        return { value, measurement };
      } finally {
        measurement.durationMs = performance.now() - start;
        measurement.heapEnd = process.memoryUsage().heapUsed;
        active = null;
      }
    },
    setHook(value: typeof hook) {
      hook = value;
    },
    setFailureHook(value: typeof failureHook) {
      failureHook = value;
    },
    restore() {
      database.transaction = originalTransaction;
    },
  };
}
