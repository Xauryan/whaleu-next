import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import request from 'supertest';
import { ViewComponentRepository } from '../../src/community/view-component/repository.js';
import { ViewReportingService } from '../../src/community/view-component/service.js';
import {
  viewReportingEpochSchema,
  viewReportReceiptSchema,
} from '../../src/community/view-component/contracts.js';
import { ApplicationError } from '../../src/http/application-error.js';
import {
  safeErrorResponseSchema,
  titleMaintenanceContinuationErrorSchema,
} from '../../src/http/error-contracts.js';
import {
  assertReceipt,
  observeViewQueries,
  reportIntent,
  reportPath,
  viewFixture,
} from '../support/view-component-fixture.js';

// Execute the unchanged native decoder against actual HTTP wire responses.
const require = createRequire(import.meta.url);
const {
  decodeViewEpoch,
  matchViewReceipt,
} = require('../../../wechat/src/community/view-contract.ts');

function safeError(response: request.Response, code: string) {
  const body = safeErrorResponseSchema.parse(response.body);
  assert.equal(body.error.code, code);
  assert.equal(body.error.requestId, response.headers['x-request-id']);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal('successorRequestId' in body.error, false);
  return body;
}

test(
  'OpenAPI owner contracts retain real PostgreSQL rollback, HTTP normalization and maintenance recovery',
  { timeout: 120000 },
  async (t) => {
    const f = await viewFixture();
    const records = f.app.get(ViewComponentRepository);
    const views = f.app.get(ViewReportingService);
    const queries = observeViewQueries(f.app);
    const statements: string[] = [];
    queries.setHook(async ({ sql }) => {
      statements.push(sql);
    });
    try {
      await t.test(
        'invalid constructed epoch rolls back its real inserted row before any acknowledgement',
        async () => {
          const actor = await f.actor();
          const original = records.createEpoch.bind(records);
          let insertedId: string | undefined;
          records.createEpoch = async (...args) => {
            const row = await original(...args);
            insertedId = row.id;
            return {
              ...row,
              expires_at: new Date(row.expires_at.getTime() + 1),
            };
          };
          statements.length = 0;
          try {
            safeError(
              await f.issue(actor).expect(503),
              'VIEW_REPORTING_UNAVAILABLE',
            );
          } finally {
            records.createEpoch = original;
          }
          assert.ok(insertedId, 'The real INSERT must have run');
          assert.equal(statements.at(-1), 'ROLLBACK');
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_post_hotness.view_reporting_epochs WHERE id=$1',
                [insertedId],
              )
            ).rowCount,
            0,
          );
          viewReportingEpochSchema.parse(await f.epoch(actor));
        },
      );

      await t.test(
        'new receipt output rejection rolls back an observed SQL aggregate mutation without writing a receipt',
        async () => {
          const actor = await f.actor();
          const epoch = await f.epoch(actor);
          const post = await f.publish(actor);
          const input = reportIntent(epoch.epochId, Array(51).fill(post.id));
          safeError(await f.report(actor, input).expect(400), 'BAD_REQUEST');
          const original = records.increment.bind(records);
          let uncommittedCount: string | undefined;
          records.increment = async (postId, delta, tx) => {
            await original(postId, delta, tx);
            uncommittedCount = (
              await tx.query<{ count: string }>(
                'SELECT count FROM whaleu_post_hotness.view_states WHERE post_id=$1',
                [postId],
              )
            ).rows[0]!.count;
          };
          statements.length = 0;
          try {
            // Bypass request validation only to exercise the independent output
            // boundary after real business writes; HTTP still rejects this input.
            await assert.rejects(
              views.report(actor.accessToken, input),
              (error: unknown) =>
                error instanceof ApplicationError &&
                error.code === 'VIEW_REPORTING_UNAVAILABLE',
            );
          } finally {
            records.increment = original;
          }
          assert.equal(uncommittedCount, '51');
          assert.equal(statements.at(-1), 'ROLLBACK');
          assert.equal(statements.includes('COMMIT'), false);
          assert.equal(
            statements.some((sql) =>
              sql.includes(
                'INSERT INTO whaleu_post_hotness.view_report_receipts',
              ),
            ),
            false,
          );
          assert.equal(await f.count(post.id), '0');
          assert.deepEqual(await f.counters(epoch.epochId), {
            batch_count: 0,
            event_count: 0,
          });
          assert.deepEqual(await f.receipts(epoch.epochId), []);
        },
      );

      await t.test(
        'invalid replay output rolls back before commit and leaves its durable acknowledgement unchanged',
        async () => {
          const actor = await f.actor();
          const epoch = await f.epoch(actor);
          const post = await f.publish(actor);
          const input = reportIntent(epoch.epochId, [post.id]);
          const first = await f.report(actor, input).expect(200);
          const before = await f.receipts(epoch.epochId);
          const original = records.receipt.bind(records);
          records.receipt = async (...args) => {
            const row = await original(...args);
            return row ? { ...row, acceptedCount: 51 } : null;
          };
          statements.length = 0;
          try {
            safeError(
              await f.report(actor, input).expect(503),
              'VIEW_REPORTING_UNAVAILABLE',
            );
          } finally {
            records.receipt = original;
          }
          assert.equal(statements.at(-1), 'ROLLBACK');
          assert.deepEqual(await f.receipts(epoch.epochId), before);
          assert.equal(await f.count(post.id), '1');
          assert.deepEqual(
            (await f.report(actor, input).expect(200)).body,
            first.body,
          );
        },
      );

      await t.test(
        'actual HTTP output matches both owner schemas and native decoders while normalized duplicate events replay exactly',
        async () => {
          const actor = await f.actor();
          const epoch = await f.epoch(actor);
          assert.deepEqual(
            decodeViewEpoch(epoch),
            viewReportingEpochSchema.parse(epoch),
          );
          const post = await f.publish(actor);
          const input = reportIntent(epoch.epochId, [post.id, post.id]);
          const upper = {
            ...input,
            epochId: input.epochId.toUpperCase(),
            batchId: input.batchId.toUpperCase(),
            postIds: input.postIds.map((id) => id.toUpperCase()),
          };
          const first = await f.report(actor, upper).expect(200);
          assertReceipt(first.body, input, 2);
          assert.deepEqual(
            matchViewReceipt(input, first.body),
            viewReportReceiptSchema.parse(first.body),
          );
          assert.equal(first.headers['cache-control'], 'no-store');
          assert.ok(first.headers['x-request-id']);
          assert.equal(first.headers['x-ratelimit-limit'], undefined);
          assert.deepEqual(
            (await f.report(actor, input).expect(200)).body,
            first.body,
          );
          assert.equal(await f.count(post.id), '2');
          assert.throws(() =>
            matchViewReceipt({ ...input, batchId: randomUUID() }, first.body),
          );
          safeError(
            await f.report(actor, { ...input, postIds: [post.id] }).expect(409),
            'VIEW_REPORT_CONFLICT',
          );
          safeError(
            await f
              .report(actor, { ...input, kind: 'detail_visit' })
              .expect(400),
            'BAD_REQUEST',
          );
        },
      );

      await t.test(
        'documented HTTP error classes use the safe envelope and fixed rate-limit hint',
        async () => {
          const actor = await f.actor();
          const epoch = await f.epoch(actor);
          const input = reportIntent(epoch.epochId, [randomUUID()]);
          safeError(
            await f.report(undefined, input).expect(401),
            'AUTHENTICATION_REQUIRED',
          );
          safeError(
            await f
              .report(actor, { ...input, epochId: randomUUID() })
              .expect(410),
            'VIEW_REPORTING_EPOCH_CLOSED',
          );
          for (const [contentType, body, status, code] of [
            ['application/json', '{broken', 400, 'BAD_REQUEST'],
            [
              'application/json',
              JSON.stringify({ value: 'x'.repeat(70000) }),
              413,
              'PAYLOAD_TOO_LARGE',
            ],
            [
              'application/json; charset=unsupported',
              '{}',
              415,
              'UNSUPPORTED_MEDIA_TYPE',
            ],
          ] as const) {
            safeError(
              await request(f.app.getHttpServer())
                .post(reportPath)
                .set('Authorization', `Bearer ${actor.accessToken}`)
                .set('Content-Type', contentType)
                .send(body)
                .expect(status),
              code,
            );
          }
          const original = views.report.bind(views);
          views.report = async () => {
            throw new Error('synthetic-private-exception-detail');
          };
          try {
            const failure = await f.report(actor, input).expect(500);
            safeError(failure, 'INTERNAL_ERROR');
            assert.equal(
              JSON.stringify(failure.body).includes('synthetic-private'),
              false,
            );
          } finally {
            views.report = original;
          }
          for (let i = 1; i < 20; i++) await f.issue(actor).expect(200);
          const limited = await f.issue(actor).expect(429);
          safeError(limited, 'RATE_LIMITED');
          assert.equal(limited.headers['retry-after'], '60');
          const blocked = await f.actor();
          await f.pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [blocked.accountId],
          );
          safeError(await f.issue(blocked).expect(403), 'ACCOUNT_BLOCKED');
        },
      );

      await t.test(
        'real title-maintenance continuation retains its exact separate recovery envelope',
        async () => {
          const actor = await f.actor();
          await f.grant(actor.accountId, 'developer');
          const start = {
            requestId: randomUUID(),
            operation: 'repair_level_titles',
          };
          const first = await f.batch(actor.accessToken, start).expect(200);
          assert.equal(first.body.done, false);
          const next = {
            requestId: randomUUID(),
            previousRequestId: start.requestId,
          };
          await f.batch(actor.accessToken, next).expect(200);
          const conflict = await f
            .batch(actor.accessToken, {
              requestId: randomUUID(),
              previousRequestId: start.requestId,
            })
            .expect(409);
          const body = titleMaintenanceContinuationErrorSchema.parse(
            conflict.body,
          );
          assert.equal(body.error.successorRequestId, next.requestId);
          assert.equal(body.error.requestId, conflict.headers['x-request-id']);
          assert.equal(conflict.headers['cache-control'], 'no-store');
          assert.equal(
            safeErrorResponseSchema.safeParse(conflict.body).success,
            false,
          );
          assert.deepEqual(
            (await f.receipt(actor.accessToken, next.requestId).expect(200))
              .body.requestId,
            next.requestId,
          );
        },
      );
    } finally {
      queries.restore();
      await f.close();
    }
  },
);
