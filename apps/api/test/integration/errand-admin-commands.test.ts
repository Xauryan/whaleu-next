import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import request from 'supertest';
import type { Response } from 'supertest';
import {
  errandRuntimeFixture,
  seedErrandFeature,
} from '../support/errand-runtime-fixture.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
import {
  errandAdminReceiptSchema,
  errandRestrictionReceiptSchema,
} from '../../src/errands/admin-command-contracts.js';
const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const { Cancellation } = require('../../../wechat/src/platform/contracts.ts');
const {
  HttpErrandAdminCommandsGateway,
} = require('../../../wechat/src/errands/admin-command-gateway.ts');
const {
  decodeErrandNotice,
} = require('../../../wechat/src/errands/admin-notice-contract.ts');
const duration = { kind: 'finite' as const, unit: 'days' as const, value: 7 };
const ok = (r: Response) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const applied = (r: Response) => {
  const body = ok(r);
  assert.equal(body.outcome, 'applied', JSON.stringify(body));
  return body;
};
test(
  'E2B ordinary AppModule administrative commands, native transport, atomic local notices and recovery',
  { timeout: 120000 },
  async (t) => {
    const f = await errandRuntimeFixture();
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    const grant = async (
      a: Actor,
      role = 'school_admin',
      region: string | null = f.scope.home.regionId,
    ) => {
      const id = randomUUID();
      await f.pool.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,$3,$4,$2,'Synthetic E2B acceptance')",
        [id, a.accountId, role, region],
      );
      return id;
    };
    const profile = async (a: Actor) => {
      await f.pool.query(
        "INSERT INTO whaleu_profile.profiles(account_id,nickname) VALUES($1,'PublicName') ON CONFLICT(account_id) DO NOTHING",
        [a.accountId],
      );
      return (
        await f.pool.query<{ id: string }>(
          'SELECT public_id id FROM whaleu_profile.profiles WHERE account_id=$1',
          [a.accountId],
        )
      ).rows[0]!.id;
    };
    const post = (a: Actor, path: string, body: object) =>
      f.auth(request(f.http).post(path), a).send(body);
    const get = (a: Actor, path: string) =>
      f.auth(request(f.http).get(path), a);
    const scoped = (
      a: Actor,
      o: { id: string; revision: string },
      op = 'delete',
      extra: Record<string, unknown> = {},
    ) =>
      post(a, `/v1/admin/errands/${o.id}/${op}`, {
        clientRequestId: randomUUID(),
        expectedRevision: o.revision,
        ...extra,
      });
    try {
      const admin = await f.actor({
          affiliation: 'unverified',
          identity: false,
        }),
        global = await f.actor({ affiliation: 'unverified', identity: false }),
        publisher = await f.actor(),
        runner = await f.actor();
      const schoolGrant = await grant(admin);
      await grant(global, 'super_admin', null);
      await profile(publisher);
      await profile(runner);
      await t.test(
        'exact scope, strict bodies, self deletion and protected delete-only',
        async () => {
          const foreign = await f.publish(
            publisher,
            f.body(f.scope.foreign.regionId),
          );
          assert.equal(
            (await scoped(admin, foreign)).body.error.code,
            'AUTHORIZATION_REQUIRED',
          );
          const own = await f.publish(admin).catch(() => null); // Unverified administrator has no publication source affiliation.
          assert.equal(own, null);
          const ordinary = await f.publish(publisher);
          assert.equal(
            (await scoped(publisher, ordinary)).body.error.code,
            'AUTHORIZATION_REQUIRED',
          );
          assert.equal(
            (
              await scoped(admin, ordinary, 'delete', {
                targetAccountId: publisher.accountId,
              })
            ).status,
            400,
          );
          const protectedPublisher = await f.actor();
          await grant(
            protectedPublisher,
            'school_admin',
            f.scope.foreign.regionId,
          );
          const order = await f.publish(protectedPublisher);
          const rejected = ok(
            await scoped(admin, order, 'delete', {
              deleteReason: 'why',
              publisherRestriction: duration,
            }),
          );
          assert.equal(rejected.code, 'ERRAND_RESTRICTION_TARGET_PROTECTED');
          assert.equal(
            (
              await f.pool.query(
                'SELECT deleted_at FROM whaleu_errands.orders WHERE id=$1',
                [order.id],
              )
            ).rows[0].deleted_at,
            null,
          );
          applied(await scoped(admin, order, 'delete', { deleteReason: '' }));
        },
      );
      await t.test(
        'completed tombstone preserves lifecycle and exact same-key replay with current scope',
        async () => {
          const order = await f.publish(publisher),
            accepted = applied(
              await f.command(runner, order.id, order.revision, 'accept'),
            );
          const completed = applied(
            await f.command(publisher, order.id, accepted.revision, 'complete'),
          );
          const body = {
            clientRequestId: randomUUID(),
            expectedRevision: completed.revision,
            deleteReason: 'Administrative reason',
          };
          const first = applied(
            await post(admin, `/v1/admin/errands/${order.id}/delete`, body),
          );
          errandAdminReceiptSchema.parse(first);
          assert.notEqual(first.revision, completed.revision);
          assert.deepEqual(
            ok(await post(admin, `/v1/admin/errands/${order.id}/delete`, body)),
            first,
          );
          assert.equal(
            (
              await post(admin, `/v1/admin/errands/${order.id}/delete`, {
                ...body,
                deleteReason: 'different',
              })
            ).body.error.code,
            'REQUEST_CONFLICT',
          );
          assert.equal(
            (await get(admin, `/v1/me/errand-requests/${body.clientRequestId}`))
              .body.error.code,
            'REQUEST_NOT_FOUND',
          );
          const row = (
            await f.pool.query(
              'SELECT state,completed_at,deleted_at FROM whaleu_errands.orders WHERE id=$1',
              [order.id],
            )
          ).rows[0];
          assert.equal(row.state, 'completed');
          assert.ok(row.completed_at && row.deleted_at);
          assert.equal((await f.detail(publisher, order.id)).status, 404);
          const catalog = ok(
            await get(admin, '/v1/admin/errands').query({ status: 'deleted' }),
          );
          assert.deepEqual(
            catalog.items.find((v: { id: string }) => v.id === order.id)
              .deletionReason,
            { status: 'provided', value: 'Administrative reason' },
          );
          await f.pool.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
            [schoolGrant],
          );
          assert.equal(
            (
              await get(
                admin,
                `/v1/admin/errand-requests/${body.clientRequestId}`,
              )
            ).body.error.code,
            'AUTHORIZATION_REQUIRED',
          );
          await grant(admin);
          assert.deepEqual(
            ok(
              await get(
                admin,
                `/v1/admin/errand-requests/${body.clientRequestId}`,
              ),
            ),
            first,
          );
        },
      );
      await t.test(
        'accepted restriction is account-wide, does not manufacture lifecycle, and publisher-admin remains permitted',
        async () => {
          const p = await f.actor(),
            r = await f.actor();
          await grant(p);
          const order = await f.publish(p);
          const accepted = applied(
            await f.command(r, order.id, order.revision, 'accept'),
          );
          const result = applied(
            await scoped(
              p,
              { id: order.id, revision: accepted.revision },
              'restrict-accepter',
              { reason: 'Nonperformance', duration },
            ),
          );
          assert.equal(result.revision, accepted.revision);
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int count FROM whaleu_errands.transitions WHERE actor_id=$1 AND request_id=$2',
                [p.accountId, result.requestId],
              )
            ).rows[0].count,
            0,
          );
          const second = await f.publish(
            publisher,
            f.body(f.scope.foreign.regionId),
          );
          assert.equal(
            ok(await f.command(r, second.id, second.revision, 'accept')).code,
            'ERRAND_ACTION_RESTRICTED',
          );
          const mine = await f.publish(p);
          assert.equal(
            ok(await scoped(p, mine)).code,
            'ERRAND_USE_OWNER_COMMAND',
          );
          applied(await f.command(p, mine.id, mine.revision, 'delete'));
        },
      );
      await t.test(
        'unknown target feature baseline blocks only restriction effects, not authorized pure deletion',
        async () => {
          const p = await f.actor(),
            order = await f.publish(p);
          await seedErrandFeature(f.pool, p.accountId, [], {
            coverage: 'missing',
          });
          const failed = await scoped(admin, order, 'delete', {
            deleteReason: 'Atomic reason',
            publisherRestriction: duration,
          });
          assert.equal(failed.status, 503, JSON.stringify(failed.body));
          assert.equal(failed.body.error.code, 'SAFETY_UNAVAILABLE');
          assert.equal(
            (
              await f.pool.query(
                'SELECT deleted_at FROM whaleu_errands.orders WHERE id=$1',
                [order.id],
              )
            ).rows[0].deleted_at,
            null,
          );
          applied(
            await scoped(admin, order, 'delete', {
              deleteReason: 'Delete only',
            }),
          );
        },
      );
      await t.test(
        'combined delete/restriction is atomic and emits one of each notice',
        async () => {
          const p = await f.actor();
          const order = await f.publish(p);
          const body = {
            clientRequestId: randomUUID(),
            expectedRevision: order.revision,
            deleteReason: 'Combined reason',
            publisherRestriction: duration,
          };
          const result = applied(
            await post(admin, `/v1/admin/errands/${order.id}/delete`, body),
          );
          assert.deepEqual(
            ok(await post(admin, `/v1/admin/errands/${order.id}/delete`, body)),
            result,
          );
          const notices = ok(await get(p, '/v1/me/errand-notices'));
          assert.deepEqual(
            notices.items.map((n: { kind: string }) => n.kind).sort(),
            ['admin_deleted', 'feature_restricted'],
          );
          assert.equal(notices.unreadCount, 2);
          for (const notice of notices.items) {
            decodeErrandNotice(notice);
            const path = `/v1/me/errand-notices/${notice.noticeId}/read`;
            const one = ok(await f.auth(request(f.http).put(path), p).send({}));
            assert.deepEqual(
              ok(await f.auth(request(f.http).put(path), p).send({})),
              one,
            );
          }
          assert.equal(
            ok(await get(p, '/v1/me/errand-notices/unread-count')).unreadCount,
            0,
          );
        },
      );
      await t.test(
        'native global issue/list/history/release/receipt uses actual transport, strict DTO and durable effects',
        async () => {
          const subject = await f.actor(),
            targetProfileId = await profile(subject);
          const transport = new DirectoryHttpTransport(f.port),
            sessions = new SessionStore();
          sessions.completeLogin(sessions.beginLogin(), global);
          const auth = new AuthService(
            sessions,
            new HttpAuthGateway(directoryNativeOrigin, transport, systemClock),
            {
              login: async () => {
                throw new Error('No provider calls');
              },
            },
            systemClock,
          );
          const gateway = new HttpErrandAdminCommandsGateway(
              new ApiClient(directoryNativeOrigin, transport, sessions, auth),
            ),
            cancel = new Cancellation();
          const intent = {
            operation: 'issue',
            payload: {
              clientRequestId: randomUUID(),
              targetProfileId,
              action: 'publish',
              reason: 'Global reason',
              duration: { kind: 'permanent' },
            },
          };
          const issued = await gateway.command(intent, cancel);
          errandRestrictionReceiptSchema.parse(issued);
          assert.equal(issued.outcome, 'applied');
          assert.deepEqual(await gateway.command(intent, cancel), issued);
          assert.deepEqual(await gateway.receipt(intent, cancel), issued);
          const list = await gateway.restrictions(
            { targetProfileId, state: 'all' },
            null,
            cancel,
            1,
          );
          assert.equal(list.items.length, 1);
          assert.deepEqual(list.recordedTotal, { status: 'known', value: '1' });
          assert.equal(list.historyCoverage, 'unknown_before_boundary');
          const history = await gateway.history(
            issued.restrictionId,
            null,
            cancel,
          );
          assert.equal(history.events[0].kind, 'issued');
          const release = {
            operation: 'release',
            restrictionId: issued.restrictionId,
            payload: { clientRequestId: randomUUID(), reason: 'Resolved' },
          };
          const released = await gateway.command(release, cancel);
          assert.equal(released.restrictionId, issued.restrictionId);
          assert.deepEqual(await gateway.receipt(release, cancel), released);
          const after = await gateway.history(
            issued.restrictionId,
            null,
            cancel,
          );
          assert.equal(after.restriction.state, 'released');
          assert.equal(after.events.length, 2);
          const notices = ok(await get(subject, '/v1/me/errand-notices'));
          assert.equal(notices.items.length, 2);
          notices.items.forEach(decodeErrandNotice);
          for (const notice of notices.items)
            ok(
              await f
                .auth(
                  request(f.http).put(
                    `/v1/me/errand-notices/${notice.noticeId}/read`,
                  ),
                  subject,
                )
                .send({}),
            );
          assert.equal(
            (await get(admin, '/v1/admin/errand-restrictions')).body.error.code,
            'AUTHORIZATION_REQUIRED',
          );
          assert.equal(
            (
              await post(
                admin,
                `/v1/admin/errand-restrictions/${issued.restrictionId}/release`,
                release.payload,
              )
            ).body.error.code,
            'AUTHORIZATION_REQUIRED',
          );
          const text = JSON.stringify([list, history, notices]);
          for (const secret of [
            'fixture_publisher',
            '12345678901',
            'Synthetic private pickup instructions',
            subject.accountId,
          ])
            assert.equal(text.includes(secret), false);
        },
      );
      await t.test(
        'durable administrative history rejects update/delete/truncate and cross-namespace notice identities',
        async () => {
          await assert.rejects(
            f.pool.query(
              "UPDATE whaleu_errands.admin_events SET delete_reason='tamper'",
            ),
          );
          await assert.rejects(
            f.pool.query('TRUNCATE whaleu_errands.admin_events CASCADE'),
          );
          await assert.rejects(
            f.pool.query(
              'TRUNCATE whaleu_notifications.errand_notice_identities CASCADE',
            ),
          );
          await assert.rejects(
            f.pool.query(
              "INSERT INTO whaleu_notifications.errand_notice_identities(id,source) VALUES($1,'restriction')",
              [randomUUID()],
            ),
          );
          const contexts = (
            await f.pool.query(
              'SELECT count(*)::int count FROM whaleu_errands.admin_request_contexts',
            )
          ).rows[0].count;
          assert.ok(contexts > 0);
        },
      );
    } finally {
      await f.close();
    }
  },
);
