import request from 'supertest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { inTransaction } from '../../src/database/database.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { PhoneBindingService } from '../../src/verification/phone-binding.service.js';
import type { PhoneAuthorizationProof } from '../../src/verification/wechat-phone-provider.js';
import { VerificationRepository } from '../../src/verification/verification.repository.js';
import { maintenanceFixture } from '../support/title-maintenance-fixture.js';
const appId = 'wx0000000000000000';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test(
  'durable phone authorization binds once, recovers original keys, preserves independent facts and fences late completion',
  { timeout: 120000 },
  async (t) => {
    let calls = 0;
    let exchange = async (): Promise<PhoneAuthorizationProof> => ({
      appId,
      authorizedAt: Date.now(),
    });
    const f = await maintenanceFixture({
      nativeVerificationEnrollment: true,
      phoneProvider: {
        exchange: async () => {
          calls++;
          return exchange();
        },
      },
    });
    const service = f.app.get(PhoneBindingService);
    const records = new VerificationRepository();
    const actor = async () => {
      const token = mintToken('access');
      const session = await f.identity.createSession(
        { provider: 'wechat', appId, subject: randomUUID() },
        { access: hashToken(token), refresh: hashToken(mintToken('refresh')) },
      );
      return { ...session, token };
    };
    try {
      await t.test(
        'HTTP routes enforce owner authentication, exact consent payload and status-only receipts',
        async () => {
          const who = await actor(),
            id = randomUUID();
          const http = f.app.getHttpServer();
          await request(http)
            .post('/v1/me/phone-binding/requests')
            .send({
              requestId: id,
              consent: 'wechat-phone-verification-v1',
              replacesRequestId: null,
            })
            .expect(401);
          await request(http)
            .post('/v1/me/phone-binding/requests')
            .set('Authorization', `Bearer ${who.token}`)
            .send({
              requestId: id,
              consent: 'implicit',
              replacesRequestId: null,
            })
            .expect(400);
          const reserved = await request(http)
            .post('/v1/me/phone-binding/requests')
            .set('Authorization', `Bearer ${who.token}`)
            .send({
              requestId: id,
              consent: 'wechat-phone-verification-v1',
              replacesRequestId: null,
            })
            .expect(200);
          assert.deepEqual(reserved.body, { requestId: id, state: 'reserved' });
          await request(http)
            .post(`/v1/me/phone-binding/requests/${id}/authorize`)
            .set('Authorization', `Bearer ${who.token}`)
            .send({
              code: 'code',
              consent: 'wechat-phone-verification-v1',
              phoneNumber: '13123456789',
            })
            .expect(400);
          assert.equal(calls, 0);
          const closed = await request(http)
            .post(`/v1/me/phone-binding/requests/${id}/close`)
            .set('Authorization', `Bearer ${who.token}`)
            .send({})
            .expect(200);
          assert.deepEqual(closed.body, { requestId: id, state: 'closed' });
        },
      );
      await t.test(
        'claim is durable before dispatch and duplicate calls only recover',
        async () => {
          const who = await actor(),
            id = randomUUID();
          const result = deferred<PhoneAuthorizationProof>(),
            entered = deferred<void>();
          exchange = () => {
            entered.resolve();
            return result.promise;
          };
          assert.equal(
            (await service.reserve(who.token, id, null)).state,
            'reserved',
          );
          const running = service.authorize(
            who.token,
            id,
            'synthetic-single-use-code',
          );
          await entered.promise;
          assert.equal(
            (await service.authorize(who.token, id, 'must-not-dispatch')).state,
            'processing',
          );
          assert.equal((await service.read(who.token, id)).state, 'processing');
          result.resolve({ appId, authorizedAt: Date.now() });
          assert.equal((await running).state, 'verified');
          assert.equal(
            (await service.authorize(who.token, id, 'must-not-dispatch')).state,
            'verified',
          );
          assert.equal(calls, 1);
          const summary = await inTransaction(
            f.pool,
            async (tx) => (await records.read(who.accountId, tx)).summary,
          );
          assert.deepEqual(summary, {
            affiliation: { status: 'unverified' },
            studentNumber: { status: 'unverified' },
            phone: { status: 'verified' },
            application: { status: 'none' },
          });
          const other = await actor();
          assert.equal(
            (await service.read(other.token, id)).state,
            'not_found',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT id FROM whaleu_verification.phone_proofs WHERE account_id=$1',
                [who.accountId],
              )
            ).rowCount,
            1,
          );
          const times = (
            await f.pool.query<{ exact: boolean }>(
              `SELECT a.verified_at=p.verified_at AND a.expires_at=p.valid_until AS exact
         FROM whaleu_verification.phone_proofs p JOIN whaleu_verification.assertions a ON a.id=p.assertion_id
         WHERE p.account_id=$1 AND p.request_id=$2`,
              [who.accountId, id],
            )
          ).rows[0];
          assert.equal(
            times?.exact,
            true,
            'Protected proof timestamps stay exact at PostgreSQL microsecond precision',
          );
        },
      );
      await t.test(
        'unknown stays unknown under original key; explicit new reservation closes old key',
        async () => {
          const who = await actor(),
            first = randomUUID(),
            next = randomUUID();
          exchange = async () => {
            throw new Error('private provider exception');
          };
          await service.reserve(who.token, first, null);
          const before = calls;
          assert.equal(
            (
              await service.authorize(
                who.token,
                first,
                'synthetic-uncertain-code',
              )
            ).state,
            'unknown',
          );
          assert.equal(
            (await service.authorize(who.token, first, 'no-retry')).state,
            'unknown',
          );
          assert.equal(calls, before + 1);
          await assert.rejects(service.reserve(who.token, next, null));
          assert.equal(
            (await service.reserve(who.token, next, first)).state,
            'reserved',
          );
          assert.equal((await service.read(who.token, first)).state, 'closed');
          assert.equal(
            (
              await f.pool.query(
                'SELECT id FROM whaleu_verification.phone_proofs WHERE account_id=$1',
                [who.accountId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'expired claimed request cannot publish after user replaces it; real deadline race',
        async () => {
          const who = await actor(),
            first = randomUUID(),
            next = randomUUID();
          const result = deferred<PhoneAuthorizationProof>(),
            entered = deferred<void>();
          exchange = () => {
            entered.resolve();
            return result.promise;
          };
          await service.reserve(who.token, first, null);
          const running = service.authorize(
            who.token,
            first,
            'synthetic-delayed-code',
          );
          await entered.promise;
          await assert.rejects(service.reserve(who.token, next, first));
          await sleep(31_000);
          assert.equal((await service.read(who.token, first)).state, 'unknown');
          assert.equal(
            (await service.reserve(who.token, next, first)).state,
            'reserved',
          );
          result.resolve({ appId, authorizedAt: Date.now() });
          assert.equal((await running).state, 'closed');
          assert.equal(
            (
              await f.pool.query(
                'SELECT id FROM whaleu_verification.phone_proofs WHERE account_id=$1',
                [who.accountId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'protected request rejects early close/reclaim and forged proofless assertion',
        async () => {
          const who = await actor(),
            id = randomUUID();
          const result = deferred<PhoneAuthorizationProof>(),
            entered = deferred<void>();
          exchange = () => {
            entered.resolve();
            return result.promise;
          };
          await service.reserve(who.token, id, null);
          const running = service.authorize(
            who.token,
            id,
            'synthetic-guard-code',
          );
          await entered.promise;
          await assert.rejects(
            f.pool.query(
              "UPDATE whaleu_verification.phone_requests SET state='reserved' WHERE account_id=$1 AND request_id=$2",
              [who.accountId, id],
            ),
            /cannot replay/,
          );
          assert.equal(
            (await service.close(who.token, id)).state,
            'processing',
          );
          await assert.rejects(
            f.pool.query(
              `INSERT INTO whaleu_verification.assertions
        (id,account_id,fact_kind,assertion_state,coverage_state,provenance_state,method,source_reference,policy_reference,source_account_id,phone_binding_reference,verified_at,expiry_kind,expires_at)
        VALUES($1,$2,'phone','verified','complete','accepted','phone_provider',$3,'wechat-phone-authorization/v1',$2,$4,clock_timestamp(),'at',clock_timestamp()+interval '1 hour')`,
              [
                randomUUID(),
                who.accountId,
                `wechat_phone_request:${id}`,
                randomUUID(),
              ],
            ),
            /protected authorization proof/,
          );
          result.resolve({ appId: 'wrong-app', authorizedAt: Date.now() });
          assert.equal((await running).state, 'unknown');
        },
      );
    } finally {
      await f.close();
    }
  },
);
