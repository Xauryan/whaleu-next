import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { errandRuntimeFixture } from '../support/errand-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
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
  HttpErrandAdminGateway,
} = require('../../../wechat/src/errands/admin-gateway.ts');
test(
  'native read-only admin gateway strictly decodes ordinary AppModule scope, historical status and count contracts',
  { timeout: 120000 },
  async () => {
    const f = await errandRuntimeFixture();
    try {
      const p = await f.actor(),
        admin = await f.actor({ affiliation: 'unverified', identity: false });
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'Synthetic native admin')",
          [randomUUID(), admin.accountId, f.scope.home.regionId],
        ),
      );
      await f.pool.query(
        "INSERT INTO whaleu_profile.profiles(account_id,nickname) VALUES($1,'PublicName')",
        [p.accountId],
      );
      const order = await f.publish(
        p,
        f.body(undefined, { title: 'Public order123' }),
      );
      await f.command(p, order.id, order.revision, 'delete');
      const transport = new DirectoryHttpTransport(f.port),
        sessions = new SessionStore();
      sessions.completeLogin(sessions.beginLogin(), admin);
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
      const gateway = new HttpErrandAdminGateway(
          new ApiClient(directoryNativeOrigin, transport, sessions, auth),
        ),
        cancel = new Cancellation();
      const authorization = await gateway.authorization(cancel);
      assert.equal(authorization.role, 'school_admin');
      assert.deepEqual(authorization.management.operatingRegionIds, [
        f.scope.home.regionId,
      ]);
      const query = {
        regionId: f.scope.home.regionId,
        status: 'all',
        keyword: '',
      };
      const all = await gateway.list(query, null, cancel);
      assert.deepEqual(all.total, { status: 'known', value: '1' });
      assert.equal(all.items[0].displayState, 'deleted');
      assert.equal(all.items[0].publisher.displayName, 'PublicName');
      assert.deepEqual(all.items[0].deletionReason, { status: 'unavailable' });
      assert.deepEqual(
        (await gateway.list({ ...query, status: 'pending' }, null, cancel))
          .total,
        { status: 'known', value: '0' },
      );
      const numeric = await gateway.list(
        { ...query, keyword: '123' },
        null,
        cancel,
      );
      assert.equal(numeric.items.length, 1);
      assert.deepEqual(numeric.total, { status: 'unavailable' });
      assert.equal(
        numeric.context.search.legacyNumericReferences,
        'unavailable',
      );
      await assert.rejects(
        gateway.list(
          { ...query, regionId: f.scope.related.regionId },
          null,
          cancel,
        ),
      );
    } finally {
      await f.close();
    }
  },
);
