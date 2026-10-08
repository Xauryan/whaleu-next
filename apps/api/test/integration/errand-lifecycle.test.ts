import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import type { Response } from 'supertest';
import {
  errandRuntimeFixture,
  seedErrandFeature,
  seedTemporaryErrandBase,
  syntheticErrandRestriction,
} from '../support/errand-runtime-fixture.js';
import {
  approveErrand,
  revokeErrandReview,
} from '../support/errand-review-fixtures.js';
import {
  appendIdentitySelection,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import { setRuntimeVerification } from '../support/community-runtime-fixtures.js';
function rejected(r: Response, code: string) {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.outcome, 'rejected', JSON.stringify(r.body));
  assert.equal(r.body.code, code);
}
function denied(r: Response, code?: string) {
  assert.ok(r.status >= 400, JSON.stringify(r.body));
  if (code) assert.equal(r.body.error?.code, code);
}
test(
  'text-only errands normal AppModule lifecycle, exact review, privacy, history, authority, receipts and durable notices',
  { timeout: 120000 },
  async (t) => {
    const f = await errandRuntimeFixture();
    try {
      await t.test(
        'strict HTTP/source field rules, no anonymous reads, review unavailable and media explicit',
        async () => {
          const a = await f.actor(),
            input = f.body();
          denied(
            await request(f.http)
              .get('/v1/errands')
              .query({ regionId: f.scope.home.regionId }),
            'AUTHENTICATION_REQUIRED',
          );
          const missing = await f
            .auth(request(f.http).post('/v1/errands'), a)
            .send(input);
          denied(missing, 'CONTENT_REVIEW_UNAVAILABLE');
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_errands.requests WHERE request_id=$1',
                [input.clientRequestId],
              )
            ).rowCount,
            0,
          );
          for (const patch of [
            { publisherContacts: { wechat: '', phone: '123' } },
            { reward: 12 },
            { title: '🙂'.repeat(51) },
            { state: 'accepted' },
            { publisherId: randomUUID() },
          ])
            denied(
              await f
                .auth(request(f.http).post('/v1/errands'), a)
                .send({ ...input, ...patch }),
              'BAD_REQUEST',
            );
          denied(
            await f
              .auth(request(f.http).post('/v1/errands'), a)
              .send({ ...input, publicAssetIds: [randomUUID()] }),
            'ERRAND_MEDIA_UNAVAILABLE',
          );
          denied(await f.list(a, { unknown: 'x' }), 'BAD_REQUEST');
          denied(
            await f.auth(
              request(f.http)
                .get('/v1/errands')
                .query({ regionId: f.scope.home.regionId })
                .send({ x: 1 }),
              a,
            ),
            'BAD_REQUEST',
          );
        },
      );
      await t.test(
        'cross-region publication and acceptance; related/foreign discovery own-only; participant-only private sections',
        async () => {
          const publisher = await f.actor(),
            runner = await f.actor(),
            stranger = await f.actor();
          for (const region of [
            f.scope.related.regionId,
            f.scope.foreign.regionId,
          ]) {
            const order = await f.publish(publisher, f.body(region));
            const mine = await f.list(publisher, { regionId: region }),
              other = await f.list(stranger, { regionId: region });
            assert.equal(mine.body.context.discoveryMode, 'own_only');
            assert.ok(
              mine.body.items.some((r: { id: string }) => r.id === order.id),
            );
            assert.ok(
              !other.body.items.some((r: { id: string }) => r.id === order.id),
            );
            const publicDetail = await f.detail(stranger, order.id);
            assert.equal(publicDetail.status, 200);
            assert.ok(!('privateText' in publicDetail.body));
            assert.ok(!('oppositeContact' in publicDetail.body));
            assert.equal(
              publicDetail.body.sourceRegion.id,
              f.scope.home.regionId,
            );
            rejected(
              await f.command(publisher, order.id, order.revision, 'accept'),
              'ERRAND_SELF_ACCEPT',
            );
            const accepted = await f.command(
              runner,
              order.id,
              order.revision,
              'accept',
            );
            assert.equal(
              accepted.body.outcome,
              'applied',
              JSON.stringify(accepted.body),
            );
            const own = await f.detail(publisher, order.id),
              run = await f.detail(runner, order.id);
            assert.equal(own.body.privateText, order.body.privateText);
            assert.equal(
              own.body.oppositeContact.contacts.wechat,
              'fixture_runner',
            );
            assert.equal(
              run.body.oppositeContact.contacts.phone,
              '12345678901',
            );
            for (const serialized of [
              JSON.stringify(mine.body),
              JSON.stringify(accepted.body),
            ])
              for (const secret of [
                order.body.privateText,
                'fixture_publisher',
                'fixture_runner',
                '12345678901',
              ])
                assert.ok(!serialized.includes(secret));
            const history = await f.own(runner, 'accepted');
            assert.ok(
              history.body.items.some((r: { id: string }) => r.id === order.id),
            );
            assert.ok(!JSON.stringify(history.body).includes('privateText'));
          }
        },
      );
      await t.test(
        'completion/cancellation hide opposite contacts, retain private relationship across campus changes; tombstones preserve state audit',
        async () => {
          const p = await f.actor(),
            r = await f.actor();
          const order = await f.publish(p);
          const accepted = await f.command(
            r,
            order.id,
            order.revision,
            'accept',
          );
          assert.equal(accepted.body.outcome, 'applied');
          await appendIdentitySelection(
            f.pool,
            p.accountId,
            p.facts,
            f.scope,
            f.scope.related.campusId,
          );
          await appendIdentitySelection(
            f.pool,
            r.accountId,
            r.facts,
            f.scope,
            f.scope.related.campusId,
          );
          assert.equal(
            (await f.detail(r, order.id)).body.privateText,
            order.body.privateText,
          );
          rejected(
            await f.command(r, order.id, accepted.body.revision, 'complete'),
            'ERRAND_NOT_FOUND',
          );
          await seedErrandFeature(f.pool, p.accountId, [
            syntheticErrandRestriction('all'),
          ]);
          const completed = await f.command(
            p,
            order.id,
            accepted.body.revision,
            'complete',
          );
          assert.equal(completed.body.outcome, 'applied');
          for (const a of [p, r]) {
            const d = await f.detail(a, order.id);
            assert.equal(d.body.state, 'completed');
            assert.equal(d.body.privateText, order.body.privateText);
            assert.ok(!('oppositeContact' in d.body));
          }
          rejected(
            await f.command(p, order.id, completed.body.revision, 'cancel'),
            'ERRAND_STATE_CONFLICT',
          );
          assert.equal(
            (await f.command(p, order.id, completed.body.revision, 'delete'))
              .body.outcome,
            'applied',
          );
          denied(await f.detail(p, order.id), 'ERRAND_NOT_FOUND');
          assert.ok(
            !(await f.own(p)).body.items.some(
              (x: { id: string }) => x.id === order.id,
            ),
          );
          const row = (
            await f.pool.query(
              'SELECT state,completed_at,deleted_at FROM whaleu_errands.orders WHERE id=$1',
              [order.id],
            )
          ).rows[0];
          assert.equal(row.state, 'completed');
          assert.ok(row.completed_at && row.deleted_at);
          const p2 = await f.actor(),
            r2 = await f.actor(),
            cancelled = await f.publish(p2);
          const claim = await f.command(
            r2,
            cancelled.id,
            cancelled.revision,
            'accept',
          );
          const cancel = await f.command(
            p2,
            cancelled.id,
            claim.body.revision,
            'cancel',
          );
          assert.equal(cancel.body.outcome, 'applied');
          const d = await f.detail(r2, cancelled.id);
          assert.equal(d.body.state, 'cancelled');
          assert.ok(d.body.privateText);
          assert.ok(!d.body.oppositeContact);
        },
      );
      await t.test(
        'remembered contacts and accepted/completed notices are private-free, durable, owner-only and monotonic read',
        async () => {
          const p = await f.actor(),
            r = await f.actor(),
            s = await f.actor();
          assert.deepEqual(
            (
              await f.auth(
                request(f.http).get('/v1/me/errands/contact-history'),
                r,
              )
            ).body,
            { status: 'empty' },
          );
          const order = await f.publish(p),
            claim = await f.command(r, order.id, order.revision, 'accept', {
              contacts: { wechat: 'only_saved_here', phone: '987' },
            });
          assert.equal(claim.body.outcome, 'applied');
          assert.deepEqual(
            (
              await f.auth(
                request(f.http).get('/v1/me/errands/contact-history'),
                r,
              )
            ).body,
            {
              status: 'available',
              contacts: { wechat: 'only_saved_here', phone: '987' },
            },
          );
          const notices = await f.auth(
            request(f.http).get('/v1/me/errand-notices'),
            p,
          );
          assert.equal(notices.body.items.length, 1);
          assert.equal(notices.body.unreadCount, 1);
          assert.equal(notices.body.items[0].kind, 'accepted');
          for (const secret of [
            'only_saved_here',
            '987',
            order.body.privateText,
            'fixture_publisher',
          ])
            assert.ok(!JSON.stringify(notices.body).includes(secret));
          const id = notices.body.items[0].noticeId;
          denied(
            await f
              .auth(request(f.http).put(`/v1/me/errand-notices/${id}/read`), s)
              .send({}),
            'ERRAND_NOT_FOUND',
          );
          const first = await f
              .auth(request(f.http).put(`/v1/me/errand-notices/${id}/read`), p)
              .send({}),
            again = await f
              .auth(request(f.http).put(`/v1/me/errand-notices/${id}/read`), p)
              .send({});
          assert.deepEqual(first.body, again.body);
          assert.equal(first.body.unreadCount, 0);
          const complete = await f.command(
            p,
            order.id,
            claim.body.revision,
            'complete',
          );
          await f.command(p, order.id, complete.body.revision, 'delete');
          const done = await f.auth(
            request(f.http).get('/v1/me/errand-notices'),
            r,
          );
          assert.equal(done.body.items[0].kind, 'completed');
          assert.equal(done.body.items[0].orderId, order.id);
        },
      );
      await t.test(
        'strict exact review rejects changed private intent; review revocation hides detail while publisher cleanup remains available',
        async () => {
          const p = await f.actor(),
            input = f.body();
          await approveErrand(f.pool, await f.envelope(p, input));
          denied(
            await f
              .auth(request(f.http).post('/v1/errands'), p)
              .send({ ...input, privateText: 'Changed private instructions' }),
            'CONTENT_REVIEW_UNAVAILABLE',
          );
          const published = await f
            .auth(request(f.http).post('/v1/errands'), p)
            .send(input);
          assert.equal(published.body.outcome, 'applied');
          const order = await f.publish(p);
          await revokeErrandReview(f.pool, order.approval.decisionId);
          denied(await f.detail(p, order.id), 'ERRAND_NOT_FOUND');
          assert.equal(
            (await f.command(p, order.id, order.revision, 'cancel')).body
              .outcome,
            'applied',
          );
          const rejectedInput = f.body();
          await approveErrand(f.pool, await f.envelope(p, rejectedInput), {
            result: 'reject',
          });
          rejected(
            await f
              .auth(request(f.http).post('/v1/errands'), p)
              .send(rejectedInput),
            'CONTENT_REJECTED',
          );
        },
      );
      await t.test(
        'feature publish/accept/all are distinct; temporary and grant base never fabricate publication affiliation',
        async () => {
          const p = await f.actor(),
            a = await f.actor();
          await seedErrandFeature(f.pool, a.accountId, [
            syntheticErrandRestriction('publish'),
          ]);
          rejected(
            await f.auth(request(f.http).post('/v1/errands'), a).send(f.body()),
            'ERRAND_ACTION_RESTRICTED',
          );
          const order = await f.publish(p);
          assert.equal(
            (await f.command(a, order.id, order.revision, 'accept')).body
              .outcome,
            'applied',
          );
          const blocked = await f.actor();
          await seedErrandFeature(f.pool, blocked.accountId, [
            syntheticErrandRestriction('accept'),
          ]);
          const o2 = await f.publish(p);
          rejected(
            await f.command(blocked, o2.id, o2.revision, 'accept'),
            'ERRAND_ACTION_RESTRICTED',
          );
          const temp = await f.actor({
            affiliation: 'unverified',
            identity: false,
          });
          await seedTemporaryErrandBase(f.pool, temp.accountId);
          assert.equal(
            (await f.command(temp, o2.id, o2.revision, 'accept')).body.outcome,
            'applied',
          );
          rejected(
            await f
              .auth(request(f.http).post('/v1/errands'), temp)
              .send(f.body()),
            'AFFILIATION_VERIFICATION_REQUIRED',
          );
          const admin = await f.actor({
            affiliation: 'unverified',
            identity: false,
          });
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'Synthetic fixture')",
              [randomUUID(), admin.accountId, f.scope.foreign.regionId],
            ),
          );
          const o3 = await f.publish(p);
          assert.equal(
            (await f.command(admin, o3.id, o3.revision, 'accept')).body.outcome,
            'applied',
          );
        },
      );
      await t.test(
        'minimal terminal receipts replay across phone/affiliation changes but never across owner or intent',
        async () => {
          const p = await f.actor(),
            s = await f.actor(),
            order = await f.publish(p);
          const replay = await f
            .auth(request(f.http).post('/v1/errands'), p)
            .send(order.body);
          assert.deepEqual(replay.body, order.receipt);
          denied(
            await f
              .auth(request(f.http).post('/v1/errands'), p)
              .send({ ...order.body, title: 'Different' }),
            'REQUEST_CONFLICT',
          );
          denied(
            await f.auth(
              request(f.http).get(
                `/v1/me/errand-requests/${order.body.clientRequestId}`,
              ),
              s,
            ),
            'REQUEST_NOT_FOUND',
          );
          await setRuntimeVerification(
            f.pool,
            p.accountId,
            f.scope.institutionId,
            f.scope.home.regionId,
            'unverified',
            'unverified',
          );
          assert.deepEqual(
            (
              await f.auth(
                request(f.http).get(
                  `/v1/me/errand-requests/${order.body.clientRequestId}`,
                ),
                p,
              )
            ).body,
            order.receipt,
          );
          assert.deepEqual(
            (
              await f
                .auth(request(f.http).post('/v1/errands'), p)
                .send(order.body)
            ).body,
            order.receipt,
          );
          denied(await f.detail(p, order.id), 'PHONE_VERIFICATION_REQUIRED');
        },
      );
      await t.test(
        'receipt recovery rejects revoked sessions and disabled accounts; participant obligations survive affiliation loss',
        async () => {
          const publisher = await f.actor(),
            order = await f.publish(publisher);
          await setRuntimeVerification(
            f.pool,
            publisher.accountId,
            f.scope.institutionId,
            f.scope.home.regionId,
            'unverified',
            'verified',
          );
          assert.equal(
            (await f.detail(publisher, order.id)).body.privateText,
            order.body.privateText,
          );
          assert.ok(
            (await f.own(publisher)).body.items.some(
              (item: { id: string }) => item.id === order.id,
            ),
          );
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
              [publisher.sessionId],
            ),
          );
          denied(
            await f.auth(
              request(f.http).get(
                `/v1/me/errand-requests/${order.body.clientRequestId}`,
              ),
              publisher,
            ),
            'SESSION_REVOKED',
          );
          denied(
            await f
              .auth(request(f.http).post('/v1/errands'), publisher)
              .send(order.body),
            'SESSION_REVOKED',
          );
          const disabled = await f.actor(),
            other = await f.publish(disabled);
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
              [disabled.accountId],
            ),
          );
          denied(
            await f.auth(
              request(f.http).get(
                `/v1/me/errand-requests/${other.body.clientRequestId}`,
              ),
              disabled,
            ),
            'ACCOUNT_BLOCKED',
          );
          denied(
            await f
              .auth(request(f.http).post('/v1/errands'), disabled)
              .send(other.body),
            'ACCOUNT_BLOCKED',
          );
        },
      );
      await t.test(
        'three-day discovery window never becomes an acceptance expiry or hides own history',
        async () => {
          const publisher = await f.actor(),
            runner = await f.actor();
          await f.pool.query(
            "CREATE FUNCTION whaleu_errands.synthetic_old_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.created_at:=date_trunc('milliseconds',clock_timestamp()-interval '4 days'); RETURN NEW; END $$; CREATE TRIGGER synthetic_old_order BEFORE INSERT ON whaleu_errands.orders FOR EACH ROW EXECUTE FUNCTION whaleu_errands.synthetic_old_order();",
          );
          let order: Awaited<ReturnType<typeof f.publish>>;
          try {
            order = await f.publish(publisher);
          } finally {
            await f.pool.query(
              'DROP TRIGGER synthetic_old_order ON whaleu_errands.orders; DROP FUNCTION whaleu_errands.synthetic_old_order()',
            );
          }
          assert.ok(
            !(await f.list(runner)).body.items.some(
              (item: { id: string }) => item.id === order.id,
            ),
          );
          assert.ok(
            (await f.own(publisher)).body.items.some(
              (item: { id: string }) => item.id === order.id,
            ),
          );
          assert.equal((await f.detail(runner, order.id)).status, 200);
          assert.equal(
            (await f.command(runner, order.id, order.revision, 'accept')).body
              .outcome,
            'applied',
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
