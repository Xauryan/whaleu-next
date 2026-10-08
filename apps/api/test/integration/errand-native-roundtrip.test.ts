import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { errandRuntimeFixture } from '../support/errand-runtime-fixture.js';
import { approveErrand } from '../support/errand-review-fixtures.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
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
  HttpErrandsGateway,
} = require('../../../wechat/src/errands/gateway.ts');
const {
  HttpErrandNoticesGateway,
} = require('../../../wechat/src/errands/notices.ts');
test(
  'actual native errand gateways decode ordinary AppModule publication, recovery, private detail, history and local notices',
  { timeout: 120000 },
  async () => {
    const f = await errandRuntimeFixture();
    try {
      const p = await f.actor(),
        r = await f.actor(),
        cancel = new Cancellation();
      const client = (actor: typeof p) => {
        const transport = new DirectoryHttpTransport(f.port),
          sessions = new SessionStore();
        sessions.completeLogin(sessions.beginLogin(), actor);
        const auth = new AuthService(
            sessions,
            new HttpAuthGateway(directoryNativeOrigin, transport, systemClock),
            {
              login: async () => {
                throw new Error('No provider calls');
              },
            },
            systemClock,
          ),
          api = new ApiClient(directoryNativeOrigin, transport, sessions, auth);
        return {
          transport,
          sessions,
          gateway: new HttpErrandsGateway(api),
          notices: new HttpErrandNoticesGateway(api),
        };
      };
      const publisher = client(p),
        runner = client(r),
        input = f.body(f.scope.related.regionId, {
          reward: '12.345678901234567890123456789',
        });
      await approveErrand(f.pool, await f.envelope(p, input));
      const intent = { operation: 'publish', payload: input },
        receipt = await publisher.gateway.command(intent, cancel);
      assert.equal(receipt.outcome, 'applied');
      assert.deepEqual(
        await publisher.gateway.receipt(input.clientRequestId, cancel),
        receipt,
      );
      assert.deepEqual(
        await publisher.gateway.command(intent, cancel),
        receipt,
      );
      const regions = await publisher.gateway.regions(
        f.scope.related.campusId,
        cancel,
      );
      assert.equal(regions[0].id, f.scope.related.regionId);
      const list = await publisher.gateway.list(
        {
          regionId: f.scope.related.regionId,
          filter: 'all',
          sort: 'reward',
          direction: 'desc',
        },
        null,
        cancel,
      );
      assert.equal(list.context.discoveryMode, 'own_only');
      assert.equal(list.items[0].reward, input.reward);
      const publicDetail = await runner.gateway.detail(receipt.orderId, cancel);
      assert.equal(publicDetail.relation, 'none');
      assert.ok(!('privateText' in publicDetail));
      const accept = {
        operation: 'accept',
        orderId: receipt.orderId,
        payload: {
          clientRequestId: randomUUID(),
          expectedRevision: receipt.revision,
          contacts: { wechat: 'runtime_runner', phone: '' },
        },
      };
      runner.transport.dropSuccess = {
        path: `/v1/errands/${receipt.orderId}/accept`,
        method: 'POST',
      };
      await assert.rejects(runner.gateway.command(accept, cancel));
      const recovered = await runner.gateway.receipt(
        accept.payload.clientRequestId,
        cancel,
      );
      assert.equal(recovered.outcome, 'applied');
      assert.deepEqual(await runner.gateway.command(accept, cancel), recovered);
      const pDetail = await publisher.gateway.detail(receipt.orderId, cancel),
        rDetail = await runner.gateway.detail(receipt.orderId, cancel);
      assert.equal(pDetail.oppositeContact.contacts.wechat, 'runtime_runner');
      assert.equal(rDetail.privateText, input.privateText);
      assert.equal(
        rDetail.oppositeContact.contacts.phone,
        input.publisherContacts.phone,
      );
      assert.deepEqual(await runner.gateway.contactHistory(cancel), {
        status: 'available',
        contacts: accept.payload.contacts,
      });
      assert.equal(
        (await runner.gateway.mine('accepted', null, cancel)).items.length,
        1,
      );
      const notices = await publisher.notices.list(null, cancel);
      assert.equal(notices.items[0].kind, 'accepted');
      assert.equal((await publisher.notices.unread(cancel)).unreadCount, 1);
      assert.equal(
        (await publisher.notices.read(notices.items[0].noticeId, cancel))
          .unreadCount,
        0,
      );
      const completed = await publisher.gateway.command(
        {
          operation: 'complete',
          orderId: receipt.orderId,
          payload: {
            clientRequestId: randomUUID(),
            expectedRevision: recovered.revision,
          },
        },
        cancel,
      );
      assert.equal(completed.outcome, 'applied');
      const after = await runner.gateway.detail(receipt.orderId, cancel);
      assert.equal(after.state, 'completed');
      assert.ok(!('oppositeContact' in after));
      assert.equal(
        (await runner.notices.list(null, cancel)).items[0].kind,
        'completed',
      );
      await publisher.gateway.command(
        {
          operation: 'delete',
          orderId: receipt.orderId,
          payload: {
            clientRequestId: randomUUID(),
            expectedRevision: completed.revision,
          },
        },
        cancel,
      );
      await assert.rejects(runner.gateway.detail(receipt.orderId, cancel));
      assert.equal(
        (await runner.gateway.mine('accepted', null, cancel)).items.length,
        0,
      );
      assert.equal((await runner.notices.list(null, cancel)).items.length, 1);
      assert.ok(
        [...publisher.transport.exchanges, ...runner.transport.exchanges].every(
          (x) => x.authorized,
        ),
      );
    } finally {
      await f.close();
    }
  },
);
