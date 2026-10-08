/** Disposable canonical facts; all reporting uses the ordinary AppModule. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import { subscriptionFixture } from './subscription-component-fixture.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';

export const epochPath = '/v1/me/community/view-reporting-epoch';
export const reportPath = '/v1/me/community/view-reports';
export type ViewKind = 'list_exposure' | 'detail_visit';
export interface ViewReport {
  version: 1;
  epochId: string;
  batchId: string;
  kind: ViewKind;
  postIds: string[];
}
export function reportIntent(
  epochId: string,
  postIds: string[],
  kind: ViewKind = 'list_exposure',
): ViewReport {
  return { version: 1, epochId, batchId: randomUUID(), kind, postIds };
}
/** Independent wire-contract implementation, not imported production hashing. */
export function expectedFingerprint(
  input: Pick<ViewReport, 'kind' | 'postIds'>,
) {
  const counts = new Map<string, number>();
  for (const raw of input.postIds) {
    const id = raw.toLowerCase();
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const pairs = [...counts].sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256')
    .update(JSON.stringify([1, input.kind, pairs]))
    .digest('hex');
}
export function assertReceipt(body: unknown, input: ViewReport, count: number) {
  assert.deepEqual(body, {
    version: 1,
    epochId: input.epochId.toLowerCase(),
    batchId: input.batchId.toLowerCase(),
    kind: input.kind,
    payloadFingerprint: expectedFingerprint(input),
    acceptedCount: count,
  });
}
export async function viewFixture() {
  const f = await subscriptionFixture();
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  const issue = (
    actor?: Pick<Actor, 'accessToken'>,
    body: object = { version: 1 },
  ) => {
    const call = request(f.app.getHttpServer()).post(epochPath);
    return (
      actor ? call.set('Authorization', `Bearer ${actor.accessToken}`) : call
    ).send(body);
  };
  const report = (
    actor: Pick<Actor, 'accessToken'> | undefined,
    body: object,
  ) => {
    const call = request(f.app.getHttpServer()).post(reportPath);
    return (
      actor ? call.set('Authorization', `Bearer ${actor.accessToken}`) : call
    ).send(body);
  };
  const epoch = async (actor: Pick<Actor, 'accessToken'>) => {
    const response = await issue(actor).expect(200);
    assert.deepEqual(
      Object.keys(response.body).sort(),
      [
        'version',
        'epochId',
        'issuedAt',
        'collectionUntil',
        'expiresAt',
        'serverNow',
      ].sort(),
    );
    assert.equal(response.body.version, 1);
    assert.match(
      response.body.epochId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(
      Date.parse(response.body.collectionUntil) -
        Date.parse(response.body.issuedAt),
      3600000,
    );
    assert.equal(
      Date.parse(response.body.expiresAt) - Date.parse(response.body.issuedAt),
      86400000,
    );
    return response.body as {
      version: 1;
      epochId: string;
      issuedAt: string;
      collectionUntil: string;
      expiresAt: string;
      serverNow: string;
    };
  };
  const count = async (postId: string): Promise<string | undefined> =>
    (
      await f.pool.query<{ count: string }>(
        'SELECT count FROM whaleu_post_hotness.view_states WHERE post_id=$1',
        [postId],
      )
    ).rows[0]?.count;
  const receipts = async (epochId: string) =>
    (
      await f.pool.query(
        'SELECT * FROM whaleu_post_hotness.view_report_receipts WHERE epoch_id=$1 ORDER BY batch_id',
        [epochId],
      )
    ).rows;
  const counters = async (epochId: string) =>
    (
      await f.pool.query(
        'SELECT batch_count,event_count FROM whaleu_post_hotness.view_reporting_epochs WHERE id=$1',
        [epochId],
      )
    ).rows[0];
  const block = async (blocker: string, blocked: string) =>
    withCommunityScopeWriter(f.pool, async (tx) => {
      const relation = randomUUID();
      await tx.query(
        "INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,revision,display_snapshot,source_kind,source_id) VALUES($1,$2,$3,true,1,'Synthetic view acceptance','profile',$4)",
        [relation, blocker, blocked, randomUUID()],
      );
      await tx.query(
        "INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) VALUES($1,$2,$3,'blocked',1)",
        [randomUUID(), blocker, relation],
      );
      return relation;
    });
  return { ...f, issue, epoch, report, count, receipts, counters, block };
}
export type ViewFixture = Awaited<ReturnType<typeof viewFixture>>;

/** Historical clock/capacity facts only, behind the standard loopback/version
 * guard. Never disable triggers, alter production functions or fake DB clocks. */
export async function syntheticEpoch(
  pool: Pool,
  accountId: string,
  input: {
    expiresInMs?: number;
    batchCount?: number;
    eventCount?: number;
  } = {},
) {
  const id = randomUUID();
  return withCommunityScopeWriter(pool, async (tx) => {
    const row = (
      await tx.query<{
        id: string;
        issued_at: Date;
        collection_until: Date;
        expires_at: Date;
      }>(
        `WITH timing AS (SELECT date_trunc('milliseconds',clock_timestamp()) + ($3::double precision * interval '1 millisecond') AS expires)
       INSERT INTO whaleu_post_hotness.view_reporting_epochs(id,account_id,issued_at,collection_until,expires_at,batch_count,event_count)
       SELECT $1,$2,expires-interval '24 hours',expires-interval '23 hours',expires,$4,$5 FROM timing RETURNING id,issued_at,collection_until,expires_at`,
        [
          id,
          accountId,
          input.expiresInMs ?? 3600000,
          input.batchCount ?? 0,
          input.eventCount ?? 0,
        ],
      )
    ).rows[0]!;
    return {
      epochId: row.id,
      issuedAt: row.issued_at,
      collectionUntil: row.collection_until,
      expiresAt: row.expires_at,
    };
  });
}
export async function syntheticReceipt(
  tx: PoolClient,
  epochId: string,
  body = reportIntent(epochId, [randomUUID()]),
  acceptedCount = 0,
) {
  await tx.query(
    'INSERT INTO whaleu_post_hotness.view_report_receipts(epoch_id,batch_id,kind,payload_fingerprint,accepted_count) VALUES($1,$2,$3,$4,$5)',
    [
      epochId,
      body.batchId,
      body.kind,
      expectedFingerprint(body),
      acceptedCount,
    ],
  );
  return body;
}

/** Observe completed real SQL without interpreting its result. PostgreSQL
 * multi-statement SET LOCAL returns an array, which is deliberately preserved. */
export function observeViewQueries(
  app: import('@nestjs/common').INestApplication,
) {
  const database = app.get(DatabaseService);
  const transaction = database.transaction.bind(database);
  let hook:
    | ((
        event: { sql: string; values: unknown[] },
        tx: PoolClient,
      ) => Promise<void>)
    | null = null;
  database.transaction = async (operation, options) => {
    let restore: (() => void) | undefined;
    try {
      return await transaction(async (tx) => {
        const query = tx.query.bind(tx);
        restore = () => {
          tx.query = query;
        };
        tx.query = (async (sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          await hook?.({ sql, values: values ?? [] }, tx);
          return result;
        }) as typeof tx.query;
        return operation(tx);
      }, options);
    } finally {
      restore?.();
    }
  };
  return {
    setHook(value: typeof hook) {
      hook = value;
    },
    restore() {
      database.transaction = transaction;
    },
  };
}
