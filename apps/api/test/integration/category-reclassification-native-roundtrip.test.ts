/** Emitted native App/Page/WXML -> ordinary AppModule -> disposable PostgreSQL.
 * Only platform callbacks and explicitly synthetic accepted pets(10) <-> scenery(12)
 * evidence are supplied. This does not assert production/source/provider/device acceptance. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { NestFactory } from '@nestjs/core';
import type { PoolClient } from 'pg';
import type { TransactionOptions } from '../../src/database/database.js';
import { AppModule } from '../../src/app.module.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService, inTransaction } from '../../src/database/database.js';
import { HotScoreMaterializer } from '../../src/community/hot-score/materializer.js';
import { SubscriptionComponentSettlement } from '../../src/community/subscription-component/settlement.js';
import { LikeComponentSettlement } from '../../src/community/like-component/settlement.js';
import { CommentComponentSettlement } from '../../src/community/comment-component/settlement.js';
import { CommunityUpdatesFacade } from '../../src/community/updates.facade.js';
import { NotificationsRepository } from '../../src/notifications/repository.js';
import { UpdatesWorker } from '../../src/notifications/worker.js';
import {
  categoryPolicyDigest,
  categoryReviewDigest,
} from '../../src/community/category-reclassification/evidence.js';
import {
  reclassificationCommandSchema,
  reclassificationReceiptSchema,
} from '../../src/community/category-reclassification/contracts.js';
import type { ReclassificationCommand } from '../../src/community/category-reclassification/contracts.js';
import { postPinFixture } from '../support/post-pin-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  approveEnvelope,
  setReviewState,
} from '../support/community-approval-fixtures.js';
import { discussionApprovalEnvelope } from '../support/community-runtime-fixtures.js';

const ok = (response: { status: number; body: unknown }, status = 200) =>
  assert.equal(response.status, status, JSON.stringify(response.body));
const credentials = (actor: SessionCredentials): SessionCredentials => ({
  accountId: actor.accountId,
  sessionId: actor.sessionId,
  accessToken: actor.accessToken,
  refreshToken: actor.refreshToken,
  expiresAt: actor.expiresAt,
  refreshExpiresAt: actor.refreshExpiresAt,
});

test(
  'emitted scoped category roundtrip preserves original publication, independent descendants, projections and exact original-key recovery',
  { timeout: 300000 },
  async (t) => {
    const f = await postPinFixture({
      createApp: (config) =>
        NestFactory.create(
          AppModule.register({ ...config, HOT_FEED_PROCESSING: 'manual_only' }),
          { logger: false },
        ),
    });
    t.after(() => f.close());
    // Test-only bounded metadata covers concurrent native/Supertest requests and
    // final proofs. No query parameters, row data, tokens or bodies are retained.
    type HttpDiagnostic = {
      http: number;
      method: string;
      path: string;
      requestId: string | null;
      startedAt: string;
      endedAt: string | null;
      elapsedMs: number | null;
      status: number | null;
      completion: 'pending' | 'finish' | 'close';
      transactions: number[];
    };
    type SqlDiagnostic = {
      transaction: number;
      request: HttpDiagnostic | null;
      phase: 'operation' | 'finalization';
      category: string;
      prefix: string;
      startedAt: string;
      endedAt: string;
      elapsedMs: number;
      outcome: 'completed' | 'failed';
      sqlstate: string | null;
    };
    type TransactionDiagnostic = {
      transaction: number;
      request: HttpDiagnostic | null;
      phase: 'operation' | 'finalization';
      startedAt: string;
      endedAt: string;
      elapsedMs: number;
      outcome: 'completed' | 'failed';
      name: string | null;
      code: string | null;
      sqlstate: string | null;
      stack: string[];
      recentSql: SqlDiagnostic[];
    };
    const boundedPush = <T>(values: T[], value: T, maximum: number) => {
      values.push(value);
      if (values.length > maximum) values.shift();
    };
    const elapsed = (started: number) =>
      Math.round((performance.now() - started) * 10) / 10;
    const httpRequests: HttpDiagnostic[] = [];
    const httpContext = new AsyncLocalStorage<HttpDiagnostic>();
    const http = f.app.getHttpServer() as Server;
    const originalHttpEmit = http.emit;
    const dispatchHttpEvent = originalHttpEmit as (
      this: Server,
      event: string,
      ...args: unknown[]
    ) => boolean;
    const routeSegments = new Set(
      'v1 v2 v3 me community posts comments replies saved liked profile profiles public-profile-ref campus spaces search post-pins post-pin-commands post-pin-requests pin read like save hot updates category-management category-commands category-requests cancel owner-visibility owner-visibility-commands owner-visibility-requests'.split(
        ' ',
      ),
    );
    const diagnosticPath = (url: string | undefined) =>
      (url ?? '')
        .split(/[?#]/, 1)[0]!
        .split('/')
        .map((segment) =>
          !segment || routeSegments.has(segment) ? segment : ':id',
        )
        .join('/')
        .slice(0, 240);
    let httpSequence = 0;
    http.emit = function (
      this: Server,
      event: string,
      ...args: unknown[]
    ): boolean {
      if (event !== 'request')
        return dispatchHttpEvent.call(this, event, ...args);
      const [incoming, response] = args as [IncomingMessage, ServerResponse];
      const started = performance.now();
      const diagnostic: HttpDiagnostic = {
        http: ++httpSequence,
        method: /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(
          incoming.method ?? '',
        )
          ? incoming.method!
          : 'OTHER',
        path: diagnosticPath(incoming.url),
        requestId: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
        elapsedMs: null,
        status: null,
        completion: 'pending',
        transactions: [],
      };
      boundedPush(httpRequests, diagnostic, 64);
      const finish = (completion: 'finish' | 'close') => {
        if (diagnostic.completion !== 'pending') return;
        const requestId = response.getHeader('x-request-id');
        diagnostic.requestId =
          typeof requestId === 'string' &&
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)
            ? requestId
            : null;
        diagnostic.endedAt = new Date().toISOString();
        diagnostic.elapsedMs = elapsed(started);
        diagnostic.status = response.statusCode;
        diagnostic.completion = completion;
      };
      response.once('finish', () => finish('finish'));
      response.once('close', () => finish('close'));
      // run scopes each concurrent dispatch and preserves the server receiver.
      // The original emit (and therefore every request listener) runs once.
      return httpContext.run(diagnostic, () =>
        dispatchHttpEvent.call(this, event, ...args),
      );
    } as typeof http.emit;
    const database = f.app.get(DatabaseService);
    const originalTransaction = database.transaction.bind(database);
    const transactionFailures: TransactionDiagnostic[] = [];
    const recentTransactions: TransactionDiagnostic[] = [];
    const sqlFailures: SqlDiagnostic[] = [];
    const recentSql: SqlDiagnostic[] = [];
    let transactionSequence = 0;
    const sqlPrefix = (sql: string) =>
      sql
        .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, '?')
        .replace(/'(?:''|[^'])*'/g, '?')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\r\n]*/g, ' ')
        .replace(/\b\d+(?:\.\d+)?\b/g, '#')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 320);
    const sqlCategory = (sql: string) => {
      if (/^\s*(?:SET|SHOW|SAVEPOINT|RELEASE|ROLLBACK|COMMIT)\b/i.test(sql))
        return 'transaction-control';
      if (/post_category_live|category_read_live/i.test(sql))
        return 'category-live';
      if (/post_category_/i.test(sql)) return 'category-source';
      if (/discovery_count|count_epoch/i.test(sql)) return 'count-source';
      if (/whaleu_authorization|role_grants/i.test(sql)) return 'authority';
      if (/whaleu_identity|whaleu_auth\b/i.test(sql)) return 'identity';
      if (/whaleu_safety/i.test(sql)) return 'safety';
      if (/whaleu_community/i.test(sql)) return 'community';
      return 'other';
    };
    const errorCode = (error: unknown) => {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : null;
      return typeof code === 'string' && /^[0-9A-Z_]{1,96}$/.test(code)
        ? code
        : null;
    };
    database.transaction = async function <T>(
      operation: (tx: PoolClient) => Promise<T>,
      options: TransactionOptions = {},
    ): Promise<T> {
      const transaction = ++transactionSequence;
      const request = httpContext.getStore() ?? null;
      if (request) boundedPush(request.transactions, transaction, 32);
      const started = performance.now();
      const startedAt = new Date().toISOString();
      const transactionSql: SqlDiagnostic[] = [];
      let phase: 'operation' | 'finalization' = 'operation';
      let failure: unknown;
      let completed = false;
      let restoreQuery: (() => void) | undefined;
      try {
        const result = await originalTransaction(async (tx) => {
          const previousQuery = tx.query;
          const originalQuery = previousQuery.bind(tx);
          const wrappedQuery = (async (sql: string, values?: unknown[]) => {
            const started = performance.now();
            const startedAt = new Date().toISOString();
            let completed = false;
            let sqlstate: string | null = null;
            try {
              const result = await originalQuery(sql, values);
              completed = true;
              return result;
            } catch (error) {
              const code = errorCode(error);
              sqlstate = code && /^[0-9A-Z]{5}$/.test(code) ? code : null;
              throw error;
            } finally {
              const endedAt = new Date().toISOString();
              const elapsedMs = elapsed(started);
              const diagnostic: SqlDiagnostic = {
                transaction,
                request,
                phase,
                category:
                  typeof sql === 'string' ? sqlCategory(sql) : 'non-text',
                prefix:
                  typeof sql === 'string' ? sqlPrefix(sql) : '<non-text query>',
                startedAt,
                endedAt,
                elapsedMs,
                outcome: completed ? 'completed' : 'failed',
                sqlstate,
              };
              boundedPush(recentSql, diagnostic, 80);
              boundedPush(transactionSql, diagnostic, 12);
              if (!completed) boundedPush(sqlFailures, diagnostic, 20);
              // Preserve coverage through deferred constraints, final proofs and
              // COMMIT/ROLLBACK, then restore before the client returns to pool.
              if (
                typeof sql === 'string' &&
                (/^\s*ROLLBACK\s*;?\s*$/i.test(sql) ||
                  (completed && /^\s*COMMIT\s*;?\s*$/i.test(sql)))
              )
                restoreQuery?.();
            }
          }) as typeof tx.query;
          restoreQuery = () => {
            if (tx.query === wrappedQuery) tx.query = previousQuery;
          };
          tx.query = wrappedQuery;
          const result = await operation(tx);
          phase = 'finalization';
          return result;
        }, options);
        completed = true;
        return result;
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        restoreQuery?.();
        const code = errorCode(failure);
        const diagnostic: TransactionDiagnostic = {
          transaction,
          request,
          phase,
          startedAt,
          endedAt: new Date().toISOString(),
          elapsedMs: elapsed(started),
          outcome: completed ? 'completed' : 'failed',
          name: failure instanceof Error ? failure.name.slice(0, 80) : null,
          code,
          sqlstate: code && /^[0-9A-Z]{5}$/.test(code) ? code : null,
          // Omit the error message, which may include SQL literals or payloads.
          // Frames still locate owner wall deadlines with no SQLSTATE.
          stack:
            failure instanceof Error
              ? (failure.stack ?? '')
                  .split('\n')
                  .filter((line) => /^\s+at /.test(line))
                  .slice(0, 10)
                  .map((line) => line.slice(0, 400))
              : [],
          recentSql: completed ? [] : [...transactionSql],
        };
        boundedPush(recentTransactions, diagnostic, 24);
        if (!completed) boundedPush(transactionFailures, diagnostic, 16);
      }
    };
    t.after(() => {
      database.transaction = originalTransaction;
      http.emit = originalHttpEmit;
      httpContext.disable();
      if (
        httpRequests.length > 0 ||
        recentSql.length > 0 ||
        recentTransactions.length > 0 ||
        sqlFailures.length > 0 ||
        transactionFailures.length > 0
      )
        t.diagnostic(
          `Category native transaction diagnostics: ${JSON.stringify({
            httpRequests,
            recentSql,
            recentTransactions,
            sqlFailures,
            transactionFailures,
          })}`,
        );
    });
    const owner = await f.actor(),
      admin = await f.actor(),
      reader = await f.actor();
    const grantId = await f.grant(
      admin.accountId,
      'school_admin',
      f.scope.home.regionId,
    );
    await f.bind(f.scope.home.spaceId, 'regional', f.scope.home.regionId);
    const auth = (actor = reader) => `Bearer ${actor.accessToken}`;
    const get = (path: string, actor = reader) =>
      request(http).get(path).set('Authorization', auth(actor));
    const post = await f.publish(owner, f.scope.home.spaceId, 'pets');
    const filler = await f.publish(owner, f.scope.home.spaceId, 'pets');
    for (const actor of [owner, admin, reader]) {
      const profile = await get('/v1/me/profile', actor);
      ok(profile);
      ok(
        await request(http)
          .put('/v1/me/campus')
          .set('Authorization', auth(actor))
          .send({
            campusId: f.scope.home.campusId,
            expectedRevision: profile.body.revision,
          }),
      );
    }
    const profileRef = await get('/v1/me/public-profile-ref', owner);
    ok(profileRef);
    const profileId = profileRef.body.profileId as string;
    const issuerId = randomUUID(),
      policyId = randomUUID();
    const definition = {
      version: 1,
      authorMode: 'named',
      content: 'text_only',
      component: 'none',
      distribution: 'regional',
      sync: 'none',
      anonymousDm: false,
      origin: 'native',
      crosswalk: { pets: 10, scenery: 12 },
      transitions: [
        { from: 'pets', to: 'scenery' },
        { from: 'scenery', to: 'pets' },
      ],
      continueDescendants: true,
      futureChildren: 'original_envelope_plus_reviewed_current_parent',
      descendantMedia: 'text_only',
    };
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        `INSERT INTO whaleu_community.post_category_issuers(id,source_ref,accepted_at,valid_until) VALUES($1,'synthetic:native-category-issuer',clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '1 hour')`,
        [issuerId],
      );
      await tx.query(
        `INSERT INTO whaleu_community.post_category_policies(id,source_key,revision,source_ref,original_region_id,issuer_id,definition,digest,accepted_at,valid_until) VALUES($1,'synthetic:pets-scenery-only',1,'synthetic:accepted-pets10-scenery12-directed-crosswalk',$2,$3,$4,$5,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
        [
          policyId,
          f.scope.home.regionId,
          issuerId,
          definition,
          categoryPolicyDigest(definition),
        ],
      );
      await tx.query(
        'INSERT INTO whaleu_community.post_category_policy_heads(source_key,policy_id) VALUES($1,$2)',
        ['synthetic:pets-scenery-only', policyId],
      );
    });
    const insertReview = async (envelope: Record<string, unknown>) => {
      const id = randomUUID();
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          `INSERT INTO whaleu_community.post_category_reviews(id,issuer_id,policy_id,purpose,envelope,digest,result,accepted_at,valid_until) VALUES($1,$2,$3,$4,$5,$6,'allow',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')`,
          [
            id,
            issuerId,
            policyId,
            envelope['purpose'],
            envelope,
            categoryReviewDigest(envelope),
          ],
        ),
      );
      return id;
    };
    const approveCommand = async (raw: unknown) => {
      const command = reclassificationCommandSchema.parse(raw);
      assert.equal(command.postId, post.id);
      const existing = await f.pool.query(
        'SELECT 1 FROM whaleu_community.post_category_commands WHERE actor_id=$1 AND request_id=$2',
        [admin.accountId, command.clientRequestId],
      );
      if (existing.rowCount) return;
      const envelope = (
        await f.pool.query<{ envelope: Record<string, unknown> }>(
          'SELECT whaleu_community.post_category_command_envelope($1,$2,$3,$4) AS envelope',
          [admin.accountId, command, grantId, policyId],
        )
      ).rows[0]!.envelope;
      assert.ok(envelope);
      await insertReview(envelope);
    };
    const publishChild = async (
      text: string,
      rootCommentId: string | null = null,
      supplemental = false,
    ) => {
      const body = {
        clientRequestId: randomUUID(),
        text,
        imageAssetIds: [],
        authorMode: 'named' as const,
        ...(rootCommentId ? { targetReplyId: null } : {}),
      };
      const envelope = await discussionApprovalEnvelope(
        f.app,
        f.pool,
        reader.accountId,
        post.id,
        body,
        rootCommentId,
      );
      assert.equal(
        envelope.category,
        'pets',
        'New children retain original canonical category',
      );
      const approval = await approveEnvelope(f.pool, envelope);
      let reviewId: string | null = null;
      if (supplemental) {
        const context = (
          await f.pool.query<{ envelope: Record<string, unknown> }>(
            `SELECT whaleu_community.post_category_child_envelope($1,$2,$3,$4,h.event_id) AS envelope FROM whaleu_community.post_category_heads h WHERE h.post_id=$5`,
            [
              reader.accountId,
              body.clientRequestId,
              rootCommentId ? 'reply' : 'comment',
              approval.decisionId,
              post.id,
            ],
          )
        ).rows[0]!.envelope;
        assert.ok(context);
        reviewId = await insertReview(context);
      }
      const response = await request(http)
        .post(
          rootCommentId
            ? `/v1/community/comments/${rootCommentId}/replies`
            : `/v1/community/posts/${post.id}/comments`,
        )
        .set('Authorization', auth())
        .send(body);
      return {
        response,
        approval,
        reviewId,
        body,
        id: response.body.resourceId as string,
      };
    };
    const oldComment = await publishChild('categoryjourney old comment');
    ok(oldComment.response, 201);
    const oldReply = await publishChild(
      'categoryjourney old reply',
      oldComment.id,
    );
    ok(oldReply.response, 201);
    const revokedChild = await publishChild(
      'categoryjourney independently revoked comment',
    );
    ok(revokedChild.response, 201);
    await setReviewState(f.pool, revokedChild.approval.decisionId, 'revoked');
    for (const actor of [owner, reader]) {
      ok(
        await request(http)
          .put(`/v1/community/posts/${post.id}/save`)
          .set('Authorization', auth(actor))
          .send({ clientRequestId: randomUUID() }),
      );
      ok(
        await request(http)
          .put(`/v1/community/posts/${post.id}/like`)
          .set('Authorization', auth(actor))
          .send({ requestId: randomUUID(), liked: true }),
      );
    }
    const pin = await request(http)
      .post('/v1/community/post-pin-commands')
      .set('Authorization', auth(admin))
      .send({
        clientRequestId: randomUUID(),
        operation: 'pin',
        postId: post.id,
      });
    ok(pin);
    ok(
      await request(http)
        .post('/v1/community/post-pin-commands')
        .set('Authorization', auth())
        .send({
          clientRequestId: randomUUID(),
          operation: 'read',
          postId: post.id,
          pinId: pin.body.pinId,
        }),
    );
    const pinBefore = (await get(`/v1/community/posts/${post.id}/pin`)).body
      .pin;
    assert.equal(pinBefore.readState, 'read');
    const noticeWorker = new UpdatesWorker(
      f.app.get(DatabaseService),
      {
        ...f.app.get<RuntimeConfig>(APP_CONFIG),
        COMMUNITY_UPDATES_PROCESSING: 'manual_only',
      },
      f.app.get(CommunityUpdatesFacade),
      f.app.get(NotificationsRepository),
    );
    const events = (
      await f.pool.query<{ id: string }>(
        "SELECT id FROM whaleu_community.outbox WHERE resource_id=ANY($1::uuid[]) AND event_type IN ('comment_created','reply_created')",
        [[oldComment.id, oldReply.id]],
      )
    ).rows.map((row) => row.id);
    assert.ok(
      (await noticeWorker.run({ mode: 'apply', eventIds: events }))
        .materialized >= 1,
    );
    const settleHot = async () => {
      for (const id of [post.id, filler.id]) {
        const saved = (
          await f.pool.query<{ id: string }>(
            "SELECT o.id FROM whaleu_community.saved_obligations o JOIN whaleu_community.saved_epochs e ON e.id=o.epoch_id WHERE e.post_id=$1 AND o.action='save_ranking' ORDER BY e.started_sequence",
            [id],
          )
        ).rows;
        for (const row of saved)
          await inTransaction(f.pool, (tx) =>
            f.app
              .get(SubscriptionComponentSettlement)
              .process(row.id, tx, true),
          );
        for (const [table, service] of [
          ['like', f.app.get(LikeComponentSettlement)],
          ['comment', f.app.get(CommentComponentSettlement)],
        ] as const) {
          const rows = (
            await f.pool.query<{ id: string }>(
              `SELECT id FROM whaleu_post_hotness.${table}_sources WHERE post_id=$1 ORDER BY source_sequence`,
              [id],
            )
          ).rows;
          for (const row of rows)
            await inTransaction(f.pool, (tx) =>
              service.process(row.id, tx, true),
            );
        }
        assert.ok(
          ['current', 'refreshed'].includes(
            await f.app.get(HotScoreMaterializer).refresh(id),
          ),
        );
      }
    };
    await settleHot();
    const originalDetail = await get(`/v1/community/posts/${post.id}`);
    ok(originalDetail);
    const original = async () => ({
      post: (
        await f.pool.query(
          'SELECT to_jsonb(p) row FROM whaleu_community.posts p WHERE id=$1',
          [post.id],
        )
      ).rows,
      binding: (
        await f.pool.query(
          'SELECT to_jsonb(b) row FROM whaleu_community.content_approval_bindings b WHERE content_id=ANY($1::uuid[]) ORDER BY content_kind,content_id',
          [[post.id, oldComment.id, oldReply.id, revokedChild.id]],
        )
      ).rows,
      children: (
        await f.pool.query(
          'SELECT row FROM (SELECT to_jsonb(c) row FROM whaleu_community.root_comments c WHERE id=ANY($1::uuid[]) UNION ALL SELECT to_jsonb(r) row FROM whaleu_community.replies r WHERE id=$2) retained ORDER BY row::text',
          [[oldComment.id, revokedChild.id], oldReply.id],
        )
      ).rows,
      receipts: (
        await f.pool.query(
          'SELECT to_jsonb(r) row FROM whaleu_community.publication_requests r WHERE client_request_id=ANY($1::uuid[]) ORDER BY account_id,client_request_id',
          [
            [
              post.input.clientRequestId,
              oldComment.body.clientRequestId,
              oldReply.body.clientRequestId,
              revokedChild.body.clientRequestId,
            ],
          ],
        )
      ).rows,
    });
    const immutableBefore = await original();
    const effects = async () => {
      const result: Record<string, unknown> = {};
      for (const table of [
        'whaleu_community.outbox',
        'whaleu_notifications.notices',
        'whaleu_notifications.processing_receipts',
        'whaleu_experience.records',
        'whaleu_experience.settlements',
      ]) {
        result[table] = (
          await f.pool.query(
            `SELECT to_jsonb(t) row FROM ${table} t ORDER BY to_jsonb(t)::text`,
          )
        ).rows;
      }
      return result;
    };
    let effectBaseline = await effects();
    const publicProjection = async (
      category: 'pets' | 'scenery',
      hidden = false,
    ) => {
      const projectionOk = (
        response: { status: number; body: unknown },
        path: string,
        requestContext: { filter?: string; viewer?: 'owner' | 'reader' } = {},
        expectedStatus = 200,
      ) => {
        if (response.status === expectedStatus) return;
        const body = response.body;
        const error =
          body && typeof body === 'object' && 'error' in body
            ? body.error
            : null;
        const metadata = error && typeof error === 'object' ? error : null;
        assert.equal(
          response.status,
          expectedStatus,
          JSON.stringify({
            path,
            filter: requestContext.filter ?? null,
            viewer: requestContext.viewer ?? 'reader',
            category,
            hidden,
            status: response.status,
            code: metadata && 'code' in metadata ? metadata.code : null,
            requestId:
              metadata && 'requestId' in metadata ? metadata.requestId : null,
            sqlFailures,
            transactionFailures,
          }),
        );
      };
      for (const filter of ['pets', 'scenery']) {
        const expected = !hidden && filter === category;
        const feed = await get('/v1/community/posts').query({
          spaceId: f.scope.home.spaceId,
          category: filter,
        });
        projectionOk(feed, '/v1/community/posts', { filter });
        const target = feed.body.items.find(
          (item: { id: string }) => item.id === post.id,
        );
        assert.equal(!!target, expected, `Feed ${filter}`);
        if (target) assert.equal(target.category, category);
        const pins = await get('/v1/community/post-pins').query({
          spaceId: f.scope.home.spaceId,
          category: filter,
        });
        projectionOk(pins, '/v1/community/post-pins', { filter });
        assert.equal(pins.body.items.length, expected ? 1 : 0, `Pin ${filter}`);
        if (expected) {
          assert.equal(pins.body.items[0].post.category, category);
          assert.deepEqual(
            pins.body.items[0].pin,
            pinBefore,
            'Pin identity, slot level, expiry and read marker survive category changes',
          );
        }
        const search = await get('/v1/community/search').query({
          spaceId: f.scope.home.spaceId,
          postId: post.id,
          q: 'categoryjourney',
          type: 'all',
          category: filter,
        });
        projectionOk(search, '/v1/community/search', { filter });
        assert.equal(
          search.body.items.length > 0,
          expected,
          `Search ${filter}`,
        );
        for (const item of search.body.items) {
          assert.equal(item.category, category);
          assert.notEqual(item.contentId, revokedChild.id);
        }
      }
      for (const actor of [owner, reader]) {
        const saved = await get('/v1/me/community/saved', actor);
        projectionOk(saved, '/v1/me/community/saved', {
          viewer: actor === owner ? 'owner' : 'reader',
        });
        assert.equal(
          saved.body.visibleSavedCount,
          hidden ? 0 : 1,
          JSON.stringify({
            surface: 'saved-count',
            category,
            hidden,
            sqlFailures,
          }),
        );
        assert.equal(saved.body.items.length, hidden ? 0 : 1);
        if (!hidden) assert.equal(saved.body.items[0].post.category, category);
        const liked = await get('/v1/me/community/liked', actor);
        projectionOk(liked, '/v1/me/community/liked', {
          viewer: actor === owner ? 'owner' : 'reader',
        });
        assert.equal(
          liked.body.visibleLikedCountStatus,
          'known',
          JSON.stringify({
            surface: 'liked-count',
            category,
            hidden,
            sqlFailures,
          }),
        );
        assert.equal(liked.body.visibleLikedCount, hidden ? 0 : 1);
        assert.equal(liked.body.items.length, hidden ? 0 : 1);
        const history = await get(`/v1/profiles/${profileId}/posts`, actor);
        projectionOk(history, `/v1/profiles/${profileId}/posts`, {
          viewer: actor === owner ? 'owner' : 'reader',
        });
        assert.equal(
          history.body.totalStatus,
          'known',
          JSON.stringify({
            surface: 'profile-history-count',
            category,
            hidden,
            sqlFailures,
          }),
        );
        assert.equal(history.body.total, hidden ? 1 : 2);
        const target = history.body.items.find(
          (item: { id: string }) => item.id === post.id,
        );
        assert.equal(!!target, !hidden);
        if (target) assert.equal(target.category, category);
        const summary = await get(`/v1/profiles/${profileId}`, actor);
        projectionOk(summary, `/v1/profiles/${profileId}`, {
          viewer: actor === owner ? 'owner' : 'reader',
        });
        assert.equal(
          summary.body.postCountStatus,
          'known',
          JSON.stringify({
            surface: 'profile-summary-count',
            category,
            hidden,
            sqlFailures,
          }),
        );
        assert.equal(summary.body.postCount, hidden ? 1 : 2);
        const hot = await get('/v1/community/hot', actor).query({
          spaceId: f.scope.home.spaceId,
        });
        projectionOk(hot, '/v1/community/hot', {
          viewer: actor === owner ? 'owner' : 'reader',
        });
        const hotTarget = hot.body.items.find(
          (item: { id: string }) => item.id === post.id,
        );
        assert.equal(!!hotTarget, !hidden);
        if (hotTarget) assert.equal(hotTarget.category, category);
      }
      const updates = await get('/v1/me/community/updates', owner);
      projectionOk(updates, '/v1/me/community/updates', { viewer: 'owner' });
      assert.ok(updates.body.items.length > 0);
      assert.equal(
        updates.body.items.some(
          (item: { status: string }) => item.status === 'available',
        ),
        !hidden,
      );
      const detail = await get(`/v1/community/posts/${post.id}`);
      if (hidden)
        projectionOk(detail, `/v1/community/posts/${post.id}`, {}, 404);
      else {
        projectionOk(detail, `/v1/community/posts/${post.id}`);
        assert.equal(detail.body.category, category);
        assert.deepEqual(
          detail.body.author,
          originalDetail.body.author,
          'Named creation identity is not replaced',
        );
        assert.equal(detail.body.publishedAt, originalDetail.body.publishedAt);
        const comments = await get(`/v1/community/posts/${post.id}/comments`);
        projectionOk(comments, `/v1/community/posts/${post.id}/comments`);
        assert.ok(
          comments.body.items.some(
            (item: { id: string }) => item.id === oldComment.id,
          ),
        );
        assert.ok(
          !comments.body.items.some(
            (item: { id: string }) => item.id === revokedChild.id,
          ),
        );
        const replies = await get(
          `/v1/community/comments/${oldComment.id}/replies`,
        );
        projectionOk(
          replies,
          `/v1/community/comments/${oldComment.id}/replies`,
        );
        assert.ok(
          replies.body.items.some(
            (item: { id: string }) => item.id === oldReply.id,
          ),
        );
      }
      assert.deepEqual(
        await original(),
        immutableBefore,
        'Original category, hashes, envelopes, children and publication receipts remain immutable',
      );
    };
    await publicProjection('pets');
    const oldPage = await get('/v1/community/posts').query({
      spaceId: f.scope.home.spaceId,
      category: 'pets',
      limit: '1',
    });
    ok(oldPage);
    assert.ok(
      oldPage.body.nextCursor,
      'A pre-move category cursor is established',
    );
    let newCommentId = '',
      newReplyId = '';
    const setHidden = async (hidden: boolean) => {
      const state = await get(
        `/v1/me/community/posts/${post.id}/owner-visibility`,
        owner,
      );
      ok(state);
      const result = await request(http)
        .post('/v1/me/community/owner-visibility-commands')
        .set('Authorization', auth(owner))
        .send({
          clientRequestId: randomUUID(),
          postId: post.id,
          ownerHidden: hidden,
          expectedVersion: state.body.version,
        });
      ok(result);
      assert.equal(result.body.outcome, 'applied');
    };
    const child = fork(
      fileURLToPath(
        new URL(
          './helpers/category-reclassification-native-worker.mjs',
          import.meta.url,
        ),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--import', 'tsx'],
      },
    );
    t.after(() => {
      if (child.connected) child.disconnect();
      if (child.exitCode === null) child.kill();
    });
    child.stdout?.resume();
    let logs = '';
    child.stderr?.on('data', (data) => {
      logs += String(data);
    });
    const done = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        let finished = false;
        const checkpoint = async (value: Record<string, unknown>) => {
          switch (value['name']) {
            case 'approve-command':
              await approveCommand(value['command']);
              break;
            case 'moved-to-scenery': {
              await publicProjection('scenery');
              assert.deepEqual(
                await effects(),
                effectBaseline,
                'Classification is not a reward or notification replay',
              );
              const stalePage = await get('/v1/community/posts').query({
                spaceId: f.scope.home.spaceId,
                category: 'pets',
                limit: '1',
                cursor: oldPage.body.nextCursor,
              });
              assert.equal(
                stalePage.status,
                400,
                JSON.stringify(stalePage.body),
              );
              assert.equal(stalePage.body.error.code, 'BAD_REQUEST');
              const missing = await publishChild(
                'categoryjourney missing supplementary Review',
              );
              assert.ok(
                [403, 409, 503].includes(missing.response.status),
                JSON.stringify(missing.response.body),
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT 1 FROM whaleu_community.root_comments WHERE text=$1',
                    [missing.body.text],
                  )
                ).rowCount,
                0,
              );
              const added = await publishChild(
                'categoryjourney current parent comment',
                null,
                true,
              );
              ok(added.response, 201);
              newCommentId = added.id;
              const reply = await publishChild(
                'categoryjourney current parent reply',
                added.id,
                true,
              );
              ok(reply.response, 201);
              newReplyId = reply.id;
              const bindings = (
                await f.pool.query(
                  'SELECT content_id,original_decision_id,review_id FROM whaleu_community.post_category_child_bindings WHERE content_id=ANY($1::uuid[]) ORDER BY content_id',
                  [[added.id, reply.id]],
                )
              ).rows;
              assert.equal(bindings.length, 2);
              assert.ok(
                bindings.some(
                  (row) =>
                    row.original_decision_id === added.approval.decisionId &&
                    row.review_id === added.reviewId,
                ),
              );
              assert.ok(
                bindings.some(
                  (row) =>
                    row.original_decision_id === reply.approval.decisionId &&
                    row.review_id === reply.reviewId,
                ),
              );
              await settleHot();
              effectBaseline = await effects();
              break;
            }
            case 'hide-before-recovery':
              await publicProjection('pets');
              assert.deepEqual(await effects(), effectBaseline);
              await setHidden(true);
              await publicProjection('pets', true);
              {
                const management = await get(
                  `/v1/community/posts/${post.id}/category-management`,
                  admin,
                );
                assert.equal(management.status, 404);
                assert.equal(management.body.error.code, 'POST_NOT_FOUND');
                const rejected = await request(http)
                  .post('/v1/community/category-commands')
                  .set('Authorization', auth(admin))
                  .send({
                    clientRequestId: randomUUID(),
                    postId: post.id,
                    expectedRevision: 2,
                    targetCategory: 'scenery',
                  });
                assert.ok(
                  [403, 404, 503].includes(rejected.status),
                  JSON.stringify(rejected.body),
                );
                const privateDetail = await get(
                  `/v1/community/posts/${post.id}`,
                  owner,
                );
                ok(privateDetail);
                assert.equal(privateDetail.body.category, 'pets');
              }
              break;
            case 'restore-after-recovery':
              await setHidden(false);
              await publicProjection('pets');
              break;
            default:
              throw Error(
                `Unexpected category native checkpoint: ${String(value['name'])}`,
              );
          }
          child.send({
            event: 'continue',
            name: value['name'],
            checkpointId: value['checkpointId'],
          });
        };
        child.on('message', (raw) => {
          const value = raw as Record<string, unknown>;
          if (value['event'] === 'checkpoint')
            void checkpoint(value).catch(reject);
          else if (value['event'] === 'failure') {
            finished = true;
            reject(
              Error(
                `${String(value['message'])}\nReal transaction failures: ${JSON.stringify(transactionFailures)}\nSQL failures: ${JSON.stringify(sqlFailures)}`,
              ),
            );
          } else if (value['event'] === 'done') {
            finished = true;
            resolve(value);
          }
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (!finished) reject(Error(`Category native exit ${code}: ${logs}`));
        });
        child.send({
          port: f.port,
          admin: credentials(admin),
          reader: credentials(reader),
          postId: post.id,
        });
      },
    );
    assert.equal(Number(done['appliedCommands']), 2);
    assert.ok(Number(done['receiptReads']) >= 2);
    assert.ok(Number(done['httpCalls']) >= 10);
    const cancelled = await get(
      `/v1/community/category-requests/${String(done['cancelledRequestId'])}`,
      admin,
    );
    ok(cancelled);
    assert.equal(cancelled.body.state, 'recorded');
    assert.equal(cancelled.body.receipt.code, 'POST_CATEGORY_CANCELLED');
    const head = (
      await f.pool.query(
        'SELECT * FROM whaleu_community.post_category_heads WHERE post_id=$1',
        [post.id],
      )
    ).rows[0]!;
    assert.equal(head.revision, 2);
    assert.equal(head.current_category, 'pets');
    const history = (
      await f.pool.query(
        'SELECT original_category,previous_category,current_category,revision,previous_event_id,id FROM whaleu_community.post_category_events WHERE post_id=$1 ORDER BY revision',
        [post.id],
      )
    ).rows;
    assert.equal(history.length, 2);
    assert.equal(history[1].previous_event_id, history[0].id);
    assert.deepEqual(
      history.map((row) => [
        row.original_category,
        row.previous_category,
        row.current_category,
      ]),
      [
        ['pets', 'pets', 'scenery'],
        ['pets', 'scenery', 'pets'],
      ],
    );
    const comments = await get(`/v1/community/posts/${post.id}/comments`);
    ok(comments);
    assert.ok(
      comments.body.items.some(
        (item: { id: string }) => item.id === newCommentId,
      ),
    );
    const replies = await get(`/v1/community/comments/${newCommentId}/replies`);
    ok(replies);
    assert.ok(
      replies.body.items.some((item: { id: string }) => item.id === newReplyId),
    );
    await t.test(
      'receipt recovery and cancellation stay independent of classification source writers',
      async () => {
        const originalRequestId = String(done['lostRequestId']);
        const originalCommand = (
          await f.pool.query<{
            command: ReclassificationCommand;
            receipt: unknown;
          }>(
            'SELECT command,receipt FROM whaleu_community.post_category_commands WHERE actor_id=$1 AND request_id=$2',
            [admin.accountId, originalRequestId],
          )
        ).rows[0]!;
        assert.ok(originalCommand);
        const pendingCancellation: ReclassificationCommand = {
          clientRequestId: randomUUID(),
          postId: post.id,
          expectedRevision: 2,
          targetCategory: 'scenery',
        };
        const positiveCommand: ReclassificationCommand = {
          ...pendingCancellation,
          clientRequestId: randomUUID(),
        };
        // This positive command has exact accepted Review before contention. A
        // missing approval must not masquerade as the intended writer-fence failure.
        await approveCommand(positiveCommand);
        const revoked = await f.actor();
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
            [revoked.sessionId],
          ),
        );
        const blocker = await f.pool.connect();
        const holdClassificationSources = async () => {
          // Real relation writer locks are compatible with reads, but conflict
          // with classification's final SHARE NOWAIT source proof. The advisory
          // slot is the actual Community count-epoch writer protocol. No source
          // data, identity row or category receipt table is mutated.
          await blocker.query(`LOCK TABLE
          whaleu_community.post_category_policies,
          whaleu_community.post_category_policy_heads,
          whaleu_community.post_category_reviews,
          whaleu_community.post_category_review_withdrawals,
          whaleu_community.post_category_read_epoch,
          whaleu_community.discovery_count_epochs
          IN ROW EXCLUSIVE MODE`);
          await blocker.query('SELECT pg_advisory_xact_lock(1464356101,0)');
        };
        try {
          await blocker.query('BEGIN');
          await blocker.query('SAVEPOINT recovery_policy_gate');
          await blocker.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0))",
          );
          await holdClassificationSources();
          const recovered = await get(
            `/v1/community/category-requests/${originalRequestId}`,
            admin,
          ).timeout({ response: 3000, deadline: 5000 });
          ok(recovered);
          assert.deepEqual(recovered.body, {
            state: 'recorded',
            receipt: originalCommand.receipt,
          });
          const replay = await request(http)
            .post('/v1/community/category-commands')
            .set('Authorization', auth(admin))
            .send(originalCommand.command)
            .timeout({ response: 3000, deadline: 5000 });
          ok(replay);
          assert.deepEqual(replay.body, originalCommand.receipt);
          const absent = await get(
            `/v1/community/category-requests/${pendingCancellation.clientRequestId}`,
            admin,
          ).timeout({ response: 3000, deadline: 5000 });
          ok(absent);
          assert.deepEqual(absent.body, { state: 'not_recorded' });
          const cancelledUnderLocks = await request(http)
            .post(
              `/v1/community/category-requests/${pendingCancellation.clientRequestId}/cancel`,
            )
            .set('Authorization', auth(admin))
            .send(pendingCancellation)
            .timeout({ response: 3000, deadline: 5000 });
          ok(cancelledUnderLocks);
          assert.equal(cancelledUnderLocks.body.outcome, 'rejected');
          assert.equal(
            cancelledUnderLocks.body.code,
            'POST_CATEGORY_CANCELLED',
          );
          assert.equal(
            cancelledUnderLocks.body.requestId,
            pendingCancellation.clientRequestId,
          );
          const cancelledRecovery = await get(
            `/v1/community/category-requests/${pendingCancellation.clientRequestId}`,
            admin,
          ).timeout({ response: 3000, deadline: 5000 });
          ok(cancelledRecovery);
          assert.deepEqual(cancelledRecovery.body, {
            state: 'recorded',
            receipt: cancelledUnderLocks.body,
          });
          for (const [token, code] of [
            [`wu_a_${'x'.repeat(43)}`, 'AUTHENTICATION_REQUIRED'],
            [revoked.accessToken, 'SESSION_REVOKED'],
          ] as const) {
            const unauthorizedGet = await request(http)
              .get(`/v1/community/category-requests/${originalRequestId}`)
              .set('Authorization', `Bearer ${token}`)
              .timeout({ response: 3000, deadline: 5000 });
            assert.equal(
              unauthorizedGet.status,
              401,
              JSON.stringify(unauthorizedGet.body),
            );
            assert.equal(unauthorizedGet.body.error.code, code);
            const unauthorizedCancel = await request(http)
              .post(
                `/v1/community/category-requests/${pendingCancellation.clientRequestId}/cancel`,
              )
              .set('Authorization', `Bearer ${token}`)
              .send(pendingCancellation)
              .timeout({ response: 3000, deadline: 5000 });
            assert.equal(
              unauthorizedCancel.status,
              401,
              JSON.stringify(unauthorizedCancel.body),
            );
            assert.equal(unauthorizedCancel.body.error.code, code);
          }
          // A positive command intentionally waits on Safety. Release that
          // gate, then retain the category writers to exercise its own final
          // nonblocking classification fence rather than an HTTP timeout.
          await blocker.query('ROLLBACK TO SAVEPOINT recovery_policy_gate');
          await holdClassificationSources();
          const blockedCommand = await request(http)
            .post('/v1/community/category-commands')
            .set('Authorization', auth(admin))
            .send(positiveCommand)
            .timeout({ response: 3000, deadline: 5000 });
          assert.equal(
            blockedCommand.status,
            503,
            JSON.stringify(blockedCommand.body),
          );
          assert.ok(
            ['POST_CATEGORY_UNAVAILABLE', 'COMMUNITY_UNAVAILABLE'].includes(
              blockedCommand.body.error.code,
            ),
            JSON.stringify(blockedCommand.body),
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.post_category_commands WHERE actor_id=$1 AND request_id=$2',
                [admin.accountId, positiveCommand.clientRequestId],
              )
            ).rowCount,
            0,
            'Relevant source contention cannot commit even a receipt',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.post_category_events WHERE actor_id=$1 AND request_id=$2',
                [admin.accountId, positiveCommand.clientRequestId],
              )
            ).rowCount,
            0,
            'Relevant source contention cannot commit an event',
          );
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT * FROM whaleu_community.post_category_heads WHERE post_id=$1',
                [post.id],
              )
            ).rows[0],
            head,
          );
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
        }
      },
    );
    const unchanged: ReclassificationCommand = {
      clientRequestId: randomUUID(),
      postId: post.id,
      expectedRevision: 2,
      targetCategory: 'pets',
    };
    const noOp = await request(http)
      .post('/v1/community/category-commands')
      .set('Authorization', auth(admin))
      .send(unchanged);
    ok(noOp);
    assert.equal(
      reclassificationReceiptSchema.parse(noOp.body).outcome,
      'unchanged',
    );
    const assertFreshStaleDenied = async (actor: typeof admin) => {
      const body: ReclassificationCommand = {
        clientRequestId: randomUUID(),
        postId: post.id,
        expectedRevision: 1,
        targetCategory: 'scenery',
      };
      const response = await request(http)
        .post('/v1/community/category-commands')
        .set('Authorization', auth(actor))
        .send(body);
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.equal(
        response.body.error.code,
        'AUTHORIZATION_REQUIRED',
        'A stale revision is not authority to submit a fresh positive command',
      );
      for (const table of ['post_category_commands', 'post_category_events']) {
        assert.equal(
          (
            await f.pool.query(
              `SELECT 1 FROM whaleu_community.${table} WHERE actor_id=$1 AND request_id=$2`,
              [actor.accountId, body.clientRequestId],
            )
          ).rowCount,
          0,
          `Unauthorized fresh stale input cannot create ${table}`,
        );
      }
    };
    await assertFreshStaleDenied(reader);
    const staleCommand: ReclassificationCommand = {
      ...unchanged,
      clientRequestId: randomUUID(),
      expectedRevision: 1,
    };
    const stale = await request(http)
      .post('/v1/community/category-commands')
      .set('Authorization', auth(admin))
      .send(staleCommand);
    ok(stale);
    assert.equal(stale.body.outcome, 'rejected');
    assert.equal(stale.body.code, 'POST_CATEGORY_STALE');
    const storedStale = (
      await f.pool.query(
        'SELECT grant_id,command,receipt FROM whaleu_community.post_category_commands WHERE actor_id=$1 AND request_id=$2',
        [admin.accountId, staleCommand.clientRequestId],
      )
    ).rows[0]!;
    assert.deepEqual(
      storedStale,
      { grant_id: grantId, command: staleCommand, receipt: stale.body },
      'A currently authorized stale same-target command records its exact terminal receipt',
    );
    const conflict = await request(http)
      .post('/v1/community/category-commands')
      .set('Authorization', auth(admin))
      .send({ ...unchanged, targetCategory: 'scenery' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'REQUEST_CONFLICT');
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_community.post_category_events WHERE post_id=$1',
          [post.id],
        )
      ).rows[0].n,
      2,
    );
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
        [grantId, admin.accountId],
      ),
    );
    await publicProjection('pets');
    await assertFreshStaleDenied(admin);
    const recoveredStale = await get(
      `/v1/community/category-requests/${staleCommand.clientRequestId}`,
      admin,
    );
    ok(recoveredStale);
    assert.deepEqual(
      recoveredStale.body,
      { state: 'recorded', receipt: stale.body },
      'Grant revocation cannot erase a previously authorized stale receipt',
    );
    const replayedStale = await request(http)
      .post('/v1/community/category-commands')
      .set('Authorization', auth(admin))
      .send(staleCommand);
    ok(replayedStale);
    assert.deepEqual(
      replayedStale.body,
      stale.body,
      'Original-key replay remains metadata-only after selected grant revocation',
    );
    const deniedManagement = await get(
      `/v1/community/posts/${post.id}/category-management`,
      admin,
    );
    ok(deniedManagement);
    assert.equal(deniedManagement.body.canChange, false);
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
        [admin.sessionId],
      ),
    );
    await publicProjection('pets');
    assert.deepEqual(
      await effects(),
      effectBaseline,
      'Post-commit authority revocation never republishes or suppresses accepted classification',
    );
    await t.test(
      'a selected-grant revoker queued behind command SHARE makes the final command proof roll back',
      async () => {
        const racingAdmin = await f.actor();
        const racingGrant = await f.grant(
          racingAdmin.accountId,
          'school_admin',
          f.scope.home.regionId,
        );
        const racingPost = await f.publish(
          racingAdmin,
          f.scope.home.spaceId,
          'pets',
        );
        const command: ReclassificationCommand = {
          clientRequestId: randomUUID(),
          postId: racingPost.id,
          expectedRevision: 0,
          targetCategory: 'scenery',
        };
        const envelope = (
          await f.pool.query<{ envelope: Record<string, unknown> }>(
            'SELECT whaleu_community.post_category_command_envelope($1,$2,$3,$4) AS envelope',
            [racingAdmin.accountId, command, racingGrant, policyId],
          )
        ).rows[0]!.envelope;
        await insertReview(envelope);
        const revoker = await f.pool.connect();
        const priorTransaction = database.transaction;
        const runTransaction = priorTransaction.bind(database);
        let observed = false;
        const writer: {
          pending: Promise<
            { ok: true; count: number | null } | { ok: false; error: unknown }
          > | null;
        } = { pending: null };
        let revokerOpen = false;
        try {
          await revoker.query('BEGIN');
          revokerOpen = true;
          // Bound only the independent test writer; application budgets and proof
          // implementations remain unchanged.
          await revoker.query("SET LOCAL statement_timeout='8s'");
          const revokerPid = (
            await revoker.query<{ pid: number }>(
              'SELECT pg_backend_pid() AS pid',
            )
          ).rows[0]!.pid;
          database.transaction = function <T>(
            operation: (tx: PoolClient) => Promise<T>,
            options: TransactionOptions = {},
          ): Promise<T> {
            return runTransaction(async (tx) => {
              const result = await operation(tx);
              const receipt = reclassificationReceiptSchema.safeParse(result);
              if (
                receipt.success &&
                receipt.data.requestId === command.clientRequestId &&
                receipt.data.outcome === 'applied'
              ) {
                assert.equal(
                  writer.pending,
                  null,
                  'Only this exact tentative command arms the revoker',
                );
                const commandPid = (
                  await tx.query<{ pid: number }>(
                    'SELECT pg_backend_pid() AS pid',
                  )
                ).rows[0]!.pid;
                writer.pending = revoker
                  .query(
                    'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
                    [racingGrant, racingAdmin.accountId],
                  )
                  .then(
                    (value) => ({ ok: true as const, count: value.rowCount }),
                    (error) => ({ ok: false as const, error }),
                  );
                const deadline = Date.now() + 5000;
                while (Date.now() < deadline) {
                  const state = (
                    await f.pool.query<{ waiting: boolean }>(
                      `SELECT a.wait_event_type='Lock' AND $2::integer=ANY(pg_blocking_pids(a.pid))
                    AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid
                      AND l.relation='whaleu_authorization.role_grants'::regclass
                      AND l.mode='RowExclusiveLock' AND l.granted) AS waiting
                   FROM pg_stat_activity a WHERE a.pid=$1`,
                      [revokerPid, commandPid],
                    )
                  ).rows[0];
                  if (state?.waiting) {
                    observed = true;
                    break;
                  }
                  await delay(10);
                }
                assert.ok(
                  observed,
                  'Exact revoker PID must be blocked by the command while already holding its grant-table writer lock',
                );
              }
              return result;
            }, options);
          };
          const response = await request(http)
            .post('/v1/community/category-commands')
            .set('Authorization', auth(racingAdmin))
            .send(command)
            .timeout({ response: 10000, deadline: 12000 });
          assert.ok(observed, 'Command reached the observed final-fence race');
          assert.equal(response.status, 503, JSON.stringify(response.body));
          assert.equal(response.body.error.code, 'POST_CATEGORY_UNAVAILABLE');
          const result = await writer.pending;
          assert.ok(
            result?.ok,
            'Queued revocation must complete after command rollback',
          );
          assert.equal(result.count, 1);
          await revoker.query('COMMIT');
          revokerOpen = false;
          for (const table of [
            'post_category_commands',
            'post_category_events',
          ]) {
            assert.equal(
              (
                await f.pool.query(
                  `SELECT 1 FROM whaleu_community.${table} WHERE actor_id=$1 AND request_id=$2`,
                  [racingAdmin.accountId, command.clientRequestId],
                )
              ).rowCount,
              0,
              `No ${table} may survive the pending selected-grant revoker`,
            );
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.post_category_heads WHERE post_id=$1',
                [racingPost.id],
              )
            ).rowCount,
            0,
          );
          assert.ok(
            (
              await f.pool.query(
                'SELECT revoked_at FROM whaleu_authorization.role_grants WHERE id=$1',
                [racingGrant],
              )
            ).rows[0]!.revoked_at,
          );
          const recovery = await get(
            `/v1/community/category-requests/${command.clientRequestId}`,
            racingAdmin,
          );
          ok(recovery);
          assert.deepEqual(recovery.body, { state: 'not_recorded' });
        } finally {
          database.transaction = priorTransaction;
          // Drain the already-started writer even when an assertion or HTTP call
          // fails. Its independent statement deadline prevents a stranded waiter.
          if (writer.pending) await writer.pending;
          try {
            if (revokerOpen) await revoker.query('ROLLBACK');
          } finally {
            revoker.release();
          }
        }
      },
    );
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'INSERT INTO whaleu_community.post_category_policy_withdrawals(policy_id) VALUES($1)',
        [policyId],
      ),
    );
    const unavailable = await get(`/v1/community/posts/${post.id}`);
    assert.ok(
      [404, 503].includes(unavailable.status),
      JSON.stringify(unavailable.body),
    );
    const fallback = await get('/v1/community/posts').query({
      spaceId: f.scope.home.spaceId,
      category: 'pets',
    });
    ok(fallback);
    assert.ok(
      !fallback.body.items.some((item: { id: string }) => item.id === post.id),
      'Withdrawn current policy cannot fall back to original category',
    );
    assert.deepEqual(await original(), immutableBefore);
    t.diagnostic(
      `Emitted scoped category journey: ${String(done['httpCalls'])} loopback requests; pets -> scenery -> pets, exact recovery/cancel, immutable publication and descendant continuation.`,
    );
  },
);
