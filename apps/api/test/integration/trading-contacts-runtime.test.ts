import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import {
  poolOptions,
  DatabaseService,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import type { PublishPost } from '../../src/community/contracts.js';
import { CommunityAccessService } from '../../src/community/community-access.service.js';
import { TradingRepository } from '../../src/community/trading/repository.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
  postApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
  setReviewState,
} from '../support/community-approval-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const { Cancellation } = require('../../../wechat/src/platform/contracts.ts');
const {
  HttpCommunityGateway,
} = require('../../../wechat/src/community/gateway.ts');
const {
  TradingContactsController,
} = require('../../../wechat/src/community/trading-controller.ts');
const { ClientError } = require('../../../wechat/src/api/errors.ts');
const nativeOrigin = 'https://native-contact-fixture.invalid';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function blockedBy(
  pool: Pool,
  blocker: number,
  query: string,
): Promise<number> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const found = (
      await pool.query<{ pid: number }>(
        'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE $2',
        [blocker, query],
      )
    ).rows[0];
    if (found) return found.pid;
    await sleep(10);
  }
  assert.fail(`Expected a PostgreSQL lock waiter: ${query}`);
}

// Ordinary AppModule with synthetic canonical owner records. No authorization,
// visibility, review, identity, safety or provider substitutes are installed.
test(
  'resolved trading contacts in the normal runtime',
  { timeout: 120000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database, 'Use disposable loopback whaleu_test');
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '20',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      owns = false,
      locked = false;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true, 'Run disposable suites serially');
      assert.ok(
        supportedPostgresVersion(
          (
            await pool.query<{ v: number }>(
              "SELECT current_setting('server_version_num')::integer v",
            )
          ).rows[0]!.v,
        ),
      );
      assert.equal(
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
        'Refusing existing WhaleU schemas',
      );
      owns = true;
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.init();
      const http = app.getHttpServer();
      const author = await createRuntimeActor(app),
        reader = await createRuntimeActor(app);
      const scope = await seedCommunityScope(pool);
      await seedReviewPolicy(pool);
      const facts = await setRuntimeVerification(
        pool,
        author.accountId,
        scope.institutionId,
        scope.home.regionId,
      );
      await appendIdentitySelection(
        pool,
        author.accountId,
        facts,
        scope,
        scope.home.campusId,
      );
      const auth = (actor = author) => `Bearer ${actor.accessToken}`;
      const chosen = {
        wechat: ' literal://chosen\ntext ',
        qq: ' QQ:not-a-number ',
        phone: ' chosen text, not account phone ',
      };
      const publish = async (
        urgency: 'normal' | 'urgent' = 'normal',
        actor = author,
        visibilityUntil: Date | null = null,
      ) => {
        const input: PublishPost = {
          clientRequestId: randomUUID(),
          spaceId: scope.home.spaceId,
          category: 'trading',
          text: 'Synthetic listing contact privacy',
          imageAssetIds: [],
          authorMode: 'named',
          commentsPolicy: 'open',
          trading: {
            subtype: 'shuma',
            price: '12.500',
            urgency,
            location: 'Synthetic chosen location',
            contacts: chosen,
          },
        };
        const approval = await approveEnvelope(
          pool,
          await postApprovalEnvelope(app!, pool, actor.accountId, input),
          { visibilityUntil },
        );
        const result = await request(http)
          .post('/v1/community/posts')
          .set('Authorization', auth(actor))
          .send(input);
        assert.equal(result.status, 201, JSON.stringify(result.body));
        assert.equal(
          result.body.outcome,
          'created',
          JSON.stringify(result.body),
        );
        return { id: result.body.resourceId as string, approval };
      };
      const contacts = (id: string, actor = reader) =>
        request(http)
          .get(`/v1/community/posts/${id}/trading/contacts`)
          .set('Authorization', auth(actor));
      const resolution = (
        id: string,
        state: 'open' | 'resolved',
        key = randomUUID(),
      ) =>
        request(http)
          .post(`/v1/community/posts/${id}/trading/resolution`)
          .set('Authorization', auth())
          .send({ clientRequestId: key, resolution: state });
      const absent = (response: {
        status: number;
        body: unknown;
        headers: Record<string, unknown>;
      }) => {
        assert.equal(response.status, 404, JSON.stringify(response.body));
        assert.equal(
          (response.body as { error: { code: string } }).error.code,
          'POST_NOT_FOUND',
        );
        assert.equal(response.headers['cache-control'], 'no-store');
        for (const value of Object.values(chosen))
          assert.ok(!JSON.stringify(response.body).includes(value));
      };
      await t.test(
        'resolved listings deny all chosen contact fields to owner and other viewers without erasing storage',
        async () => {
          for (const urgency of ['normal', 'urgent'] as const) {
            const listing = await publish(urgency);
            for (const actor of [author, reader]) {
              const open = await contacts(listing.id, actor);
              assert.equal(open.status, 200, JSON.stringify(open.body));
              assert.deepEqual(open.body, {
                postId: listing.id,
                contacts: chosen,
              });
            }
            const before = (
              await pool.query(
                'SELECT to_jsonb(t) value FROM whaleu_community.trading_listings t WHERE post_id=$1',
                [listing.id],
              )
            ).rows[0]!.value;
            const resolved = await resolution(listing.id, 'resolved');
            assert.equal(
              resolved.body.outcome,
              'applied',
              JSON.stringify(resolved.body),
            );
            for (const actor of [author, reader])
              absent(await contacts(listing.id, actor));
            const detail = await request(http)
              .get(`/v1/community/posts/${listing.id}`)
              .set('Authorization', auth(reader));
            assert.equal(detail.status, 200);
            assert.equal(detail.body.trading.resolution, 'resolved');
            const after = (
              await pool.query(
                'SELECT to_jsonb(t) value FROM whaleu_community.trading_listings t WHERE post_id=$1',
                [listing.id],
              )
            ).rows[0]!.value;
            assert.deepEqual(after, { ...before, resolution: 'resolved' });
            assert.equal(
              (await resolution(listing.id, 'open')).body.outcome,
              'applied',
            );
            assert.deepEqual((await contacts(listing.id)).body, {
              postId: listing.id,
              contacts: chosen,
            });
            const replay = await resolution(
              listing.id,
              'resolved',
              resolved.body.requestId,
            );
            assert.deepEqual(replay.body, resolved.body);
            assert.deepEqual((await contacts(listing.id)).body, {
              postId: listing.id,
              contacts: chosen,
            });
            assert.deepEqual(
              (
                await pool.query(
                  'SELECT to_jsonb(t) value FROM whaleu_community.trading_listings t WHERE post_id=$1',
                  [listing.id],
                )
              ).rows[0]!.value,
              before,
            );
          }
        },
      );
      await t.test(
        'ordinary contact reads stay session-only and resolution stays phone-only; auth and unknown policy fail closed',
        async () => {
          const listing = await publish();
          const count = async () =>
            Number(
              (
                await pool.query(
                  'SELECT count(*) FROM whaleu_community.trading_requests',
                )
              ).rows[0]!.count,
            );
          const before = await count();
          assert.equal(
            (
              await request(http).get(
                `/v1/community/posts/${listing.id}/trading/contacts`,
              )
            ).status,
            401,
          );
          assert.equal(
            (
              await request(http)
                .get(`/v1/community/posts/${listing.id}/trading/contacts`)
                .set('Authorization', 'Bearer invalid')
            ).status,
            401,
          );
          await setRuntimeVerification(
            pool,
            reader.accountId,
            scope.institutionId,
            scope.home.regionId,
            'unverified',
            'unverified',
          );
          assert.deepEqual((await contacts(listing.id)).body, {
            postId: listing.id,
            contacts: chosen,
          });
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_safety.account_heads SET block_coverage='missing' WHERE account_id=$1",
              [reader.accountId],
            ),
          );
          const unavailable = await contacts(listing.id);
          assert.equal(unavailable.status, 503);
          assert.equal(unavailable.body.error.code, 'COMMUNITY_UNAVAILABLE');
          assert.ok(!JSON.stringify(unavailable.body).includes(chosen.wechat));
          assert.equal(
            await count(),
            before,
            'Contact failures do not reserve resolution receipts',
          );
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_safety.account_heads SET block_coverage='complete' WHERE account_id=$1",
              [reader.accountId],
            ),
          );
          // Publication proof is removed. Owner resolution is still the established phone-only action.
          await setRuntimeVerification(
            pool,
            author.accountId,
            scope.institutionId,
            scope.home.regionId,
            'unavailable',
            'verified',
          );
          assert.equal(
            (await resolution(listing.id, 'resolved')).body.outcome,
            'applied',
          );
          absent(await contacts(listing.id, author));
          assert.equal(
            (await resolution(listing.id, 'open')).body.outcome,
            'applied',
          );
          assert.deepEqual((await contacts(listing.id)).body.contacts, chosen);
          const restored = await setRuntimeVerification(
            pool,
            author.accountId,
            scope.institutionId,
            scope.home.regionId,
          );
          await appendIdentitySelection(
            pool,
            author.accountId,
            restored,
            scope,
            scope.home.campusId,
          );
        },
      );
      await t.test(
        'actual resolution, reopening and deletion serialize later contact HTTP reads behind parent/listing locks',
        async () => {
          const listing = await publish('urgent');
          const lock = await pool.connect(),
            key = [918204, 10];
          const pid = (
            await lock.query<{ pid: number }>('SELECT pg_backend_pid() pid')
          ).rows[0]!.pid;
          await pool.query(`CREATE FUNCTION whaleu_community.contact_test_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type IN ('trading_resolution_changed','post_deleted') THEN PERFORM pg_advisory_xact_lock(918204,10); END IF;
        RETURN NEW; END $$;
        CREATE TRIGGER contact_test_gate BEFORE INSERT ON whaleu_community.outbox FOR EACH ROW EXECUTE FUNCTION whaleu_community.contact_test_gate()`);
          try {
            for (const state of ['resolved', 'open', 'deleted'] as const) {
              await lock.query('SELECT pg_advisory_lock($1,$2)', key);
              const mutation = (
                state === 'deleted'
                  ? request(http)
                      .delete(`/v1/community/posts/${listing.id}`)
                      .set('Authorization', auth())
                  : resolution(listing.id, state)
              ).then((r) => r);
              const writerPid = await blockedBy(
                pool,
                pid,
                '%INSERT INTO whaleu_community.outbox%',
              );
              const reading = contacts(listing.id).then((r) => r);
              await blockedBy(pool, writerPid, '%FROM whaleu_community.posts%');
              await lock.query('SELECT pg_advisory_unlock($1,$2)', key);
              const changed = await mutation;
              assert.equal(
                changed.status,
                state === 'deleted' ? 204 : 201,
                JSON.stringify(changed.body),
              );
              const read = await reading;
              if (state === 'open')
                assert.deepEqual(read.body, {
                  postId: listing.id,
                  contacts: chosen,
                });
              else absent(read);
            }
          } finally {
            await lock.query('SELECT pg_advisory_unlock($1,$2)', key);
            lock.release();
            await pool.query(
              'DROP TRIGGER contact_test_gate ON whaleu_community.outbox; DROP FUNCTION whaleu_community.contact_test_gate()',
            );
          }
        },
      );
      await t.test(
        'a concurrent hidden-parent transition denies a contact read waiting on that parent',
        async () => {
          const listing = await publish(),
            writer = await pool.connect();
          try {
            await writer.query('BEGIN');
            const pid = (
              await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')
            ).rows[0]!.pid;
            await writer.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [listing.id],
            );
            await writer.query(
              "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
              [listing.id],
            );
            const reading = contacts(listing.id).then((r) => r);
            await blockedBy(pool, pid, '%FROM whaleu_community.posts%');
            await writer.query('COMMIT');
            absent(await reading);
            const reopening = await resolution(listing.id, 'open');
            assert.equal(reopening.body.outcome, 'rejected');
            assert.equal(reopening.body.code, 'POST_NOT_FOUND');
            assert.equal(
              (
                await pool.query(
                  'SELECT visibility FROM whaleu_community.posts WHERE id=$1',
                  [listing.id],
                )
              ).rows[0]!.visibility,
              'hidden',
            );
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
        },
      );
      await t.test(
        'a contact read ordered before resolution is authorized then; no claim of recall after commit',
        async () => {
          const listing = await publish(),
            started = deferred(),
            release = deferred();
          let pid = 0;
          const read = app!.get(DatabaseService).transaction(async (tx) => {
            pid = (
              await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')
            ).rows[0]!.pid;
            const actor = await app!
              .get(CommunityAccessService)
              .actor(reader.accessToken, tx);
            await app!
              .get(CommunityAccessService)
              .accessiblePost(listing.id, actor, tx);
            const values = await app!
              .get(TradingRepository)
              .contacts(listing.id, tx);
            started.resolve();
            await release.promise;
            return values;
          });
          await started.promise;
          const resolving = resolution(listing.id, 'resolved').then((r) => r);
          try {
            await blockedBy(pool, pid, '%FROM whaleu_community.posts%');
          } finally {
            release.resolve();
          }
          assert.deepEqual(await read, chosen);
          assert.equal((await resolving).body.outcome, 'applied');
          absent(await contacts(listing.id));
        },
      );
      await t.test(
        'hidden, unapproved and inactive parents cannot be reopened to disclose; immutable receipts remain historical',
        async () => {
          for (const cause of [
            'hidden',
            'approval',
            'scope',
            'deleted',
          ] as const) {
            const listing = await publish(),
              receipt = await resolution(listing.id, 'resolved');
            if (cause === 'hidden')
              await pool.query(
                "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
                [listing.id],
              );
            if (cause === 'approval')
              await setReviewState(pool, listing.approval.decisionId, 'held');
            if (cause === 'scope')
              await withCommunityScopeWriter(pool, (tx) =>
                tx.query(
                  'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
                  [scope.home.spaceId],
                ),
              );
            if (cause === 'deleted')
              await request(http)
                .delete(`/v1/community/posts/${listing.id}`)
                .set('Authorization', auth())
                .expect(204);
            absent(await contacts(listing.id));
            const reopen = await resolution(listing.id, 'open');
            assert.equal(reopen.body.outcome, 'rejected');
            assert.equal(reopen.body.code, 'POST_NOT_FOUND');
            assert.deepEqual(
              (await resolution(listing.id, 'resolved', receipt.body.requestId))
                .body,
              receipt.body,
            );
            assert.deepEqual(
              (
                await request(http)
                  .get(
                    `/v1/me/community/trading-requests/${receipt.body.requestId}`,
                  )
                  .set('Authorization', auth())
              ).body,
              receipt.body,
            );
            absent(await contacts(listing.id, author));
            const stored = (
              await pool.query(
                'SELECT resolution,wechat,qq,phone FROM whaleu_community.trading_listings WHERE post_id=$1',
                [listing.id],
              )
            ).rows[0]!;
            assert.deepEqual(stored, { resolution: 'resolved', ...chosen });
            if (cause === 'scope')
              await withCommunityScopeWriter(pool, (tx) =>
                tx.query(
                  'UPDATE whaleu_community.spaces SET is_active=true WHERE id=$1',
                  [scope.home.spaceId],
                ),
              );
          }
        },
      );
      await t.test(
        'bilateral blocks deny reopened contacts and a concurrent real block wins before a waiting read',
        async () => {
          const readerFacts = await setRuntimeVerification(
            pool,
            reader.accountId,
            scope.institutionId,
            scope.home.regionId,
          );
          await appendIdentitySelection(
            pool,
            reader.accountId,
            readerFacts,
            scope,
            scope.home.campusId,
          );
          const listing = await publish(),
            readerListing = await publish('normal', reader);
          const lock = await pool.connect(),
            key = [918204, 11];
          const pid = (
            await lock.query<{ pid: number }>('SELECT pg_backend_pid() pid')
          ).rows[0]!.pid;
          await pool.query(`CREATE FUNCTION whaleu_safety.contact_test_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.kind='blocked' THEN PERFORM pg_advisory_xact_lock(918204,11); END IF; RETURN NEW; END $$;
        CREATE TRIGGER contact_test_gate BEFORE INSERT ON whaleu_safety.events FOR EACH ROW EXECUTE FUNCTION whaleu_safety.contact_test_gate()`);
          try {
            for (const blocker of [reader, author]) {
              await lock.query('SELECT pg_advisory_lock($1,$2)', key);
              const blocking = request(http)
                .put('/v1/me/safety/blocks')
                .set('Authorization', auth(blocker))
                .send({
                  clientRequestId: randomUUID(),
                  blocked: true,
                  source: {
                    kind: 'post',
                    id: blocker === reader ? listing.id : readerListing.id,
                  },
                })
                .then((r) => r);
              const writerPid = await blockedBy(
                pool,
                pid,
                '%INSERT INTO whaleu_safety.events%',
              );
              const reading = contacts(listing.id).then((r) => r);
              await blockedBy(
                pool,
                writerPid,
                '%pg_advisory_xact_lock_shared%',
              );
              await lock.query('SELECT pg_advisory_unlock($1,$2)', key);
              const result = await blocking;
              assert.equal(
                result.body.receipt.outcome,
                'applied',
                JSON.stringify(result.body),
              );
              absent(await reading);
              assert.equal(
                (await resolution(listing.id, 'resolved')).body.outcome,
                'applied',
              );
              assert.equal(
                (await resolution(listing.id, 'open')).body.outcome,
                'applied',
              );
              absent(await contacts(listing.id));
              const current = result.body.current;
              await request(http)
                .put(`/v1/me/safety/blocks/${current.relationshipId}`)
                .set('Authorization', auth(blocker))
                .send({
                  clientRequestId: randomUUID(),
                  blocked: false,
                  expectedRevision: current.revision,
                })
                .expect(200);
              assert.deepEqual(
                (await contacts(listing.id)).body.contacts,
                chosen,
              );
            }
          } finally {
            await lock.query('SELECT pg_advisory_unlock($1,$2)', key);
            lock.release();
            await pool.query(
              'DROP TRIGGER contact_test_gate ON whaleu_safety.events; DROP FUNCTION whaleu_safety.contact_test_gate()',
            );
          }
        },
      );
      await t.test(
        'contact read retains canonical final deadline checks even after chosen fields were selected',
        async () => {
          const listing = await publish(
            'normal',
            author,
            new Date(Date.now() + 1500),
          );
          let selected = false;
          await assert.rejects(
            app!.get(DatabaseService).transaction(async (tx) => {
              const actor = await app!
                .get(CommunityAccessService)
                .actor(reader.accessToken, tx);
              await app!
                .get(CommunityAccessService)
                .accessiblePost(listing.id, actor, tx);
              assert.deepEqual(
                await app!.get(TradingRepository).contacts(listing.id, tx),
                chosen,
              );
              selected = true;
              await tx.query('SELECT pg_sleep(1.6)');
            }),
            (error: unknown) =>
              (error as { code?: string }).code === 'COMMUNITY_UNAVAILABLE',
          );
          assert.equal(
            selected,
            true,
            'The deadline must expire after selecting contacts',
          );
          const expired = await contacts(listing.id);
          assert.equal(expired.status, 503);
          assert.equal(expired.body.error.code, 'COMMUNITY_UNAVAILABLE');
          assert.ok(!JSON.stringify(expired.body).includes(chosen.wechat));
        },
      );
      await t.test(
        'real native gateway and controller reject resolved reads and stale responses after resolve/reopen',
        async () => {
          const listing = await publish();
          const path = `/v1/community/posts/${listing.id}/trading/contacts`;
          let hold: {
            arrived: ReturnType<typeof deferred>;
            release: ReturnType<typeof deferred>;
          } | null = null;
          const transport = {
            async send(input: {
              url: string;
              method: string;
              headers: Record<string, string>;
              body?: unknown;
            }) {
              const parsed = new URL(input.url);
              assert.equal(parsed.origin, nativeOrigin);
              assert.equal(input.method, 'GET');
              const response = await request(http)
                .get(`${parsed.pathname}${parsed.search}`)
                .set(input.headers);
              assert.equal(response.headers['cache-control'], 'no-store');
              if (parsed.pathname === path && hold) {
                const current = hold;
                hold = null;
                current.arrived.resolve();
                await current.release.promise;
              }
              return {
                status: response.status,
                headers: response.headers,
                body: response.body,
              };
            },
          };
          const sessions = new SessionStore();
          sessions.completeLogin(sessions.beginLogin(), reader);
          const authService = new AuthService(
            sessions,
            new HttpAuthGateway(nativeOrigin, transport, systemClock),
            { login: async () => 'no-provider' },
            systemClock,
          );
          const gateway = new HttpCommunityGateway(
            new ApiClient(nativeOrigin, transport, sessions, authService),
          );
          const cancel = new Cancellation(),
            copied: string[] = [];
          let view: { enabled: boolean; contacts: typeof chosen | null } = {
            enabled: false,
            contacts: null,
          };
          const controller = new TradingContactsController(
            { sessions, gateway },
            (next: typeof view) => {
              view = next;
            },
            async (value: string) => {
              copied.push(value);
            },
          );
          try {
            controller.load(await gateway.post(listing.id, cancel));
            await controller.reveal();
            assert.deepEqual(view.contacts, chosen);
            const gate = { arrived: deferred(), release: deferred() };
            hold = gate;
            const copy = controller.copy('phone');
            await gate.arrived.promise;
            assert.equal(
              (await resolution(listing.id, 'resolved')).body.outcome,
              'applied',
            );
            controller.load(await gateway.post(listing.id, cancel));
            assert.equal(view.enabled, false);
            assert.equal(view.contacts, null);
            gate.release.resolve();
            await copy;
            assert.deepEqual(copied, []);
            await assert.rejects(
              gateway.tradingContacts(listing.id, cancel),
              (error: unknown) => {
                assert.ok(error instanceof ClientError);
                const failure = error as {
                  details: { httpStatus: number; serverCode: string };
                };
                assert.equal(failure.details.httpStatus, 404);
                assert.equal(failure.details.serverCode, 'POST_NOT_FOUND');
                return true;
              },
            );
            assert.equal(
              (await resolution(listing.id, 'open')).body.outcome,
              'applied',
            );
            await controller.reveal();
            assert.equal(view.contacts, null);
            controller.load(await gateway.post(listing.id, cancel));
            await controller.copy('phone');
            assert.deepEqual(copied, [chosen.phone]);
          } finally {
            controller.dispose();
          }
        },
      );
    } finally {
      await app?.close();
      if (owns)
        for (const schema of migrationSchemaNames)
          await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (locked)
        await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      suite?.release();
      await pool.end();
    }
  },
);
