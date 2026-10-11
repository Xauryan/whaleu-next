import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import request from 'supertest';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { schoolCommandHash } from '../../src/school-configuration/contracts.js';
const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const {
  HttpProfileGateway,
} = require('../../../wechat/src/profile/gateway.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const { Cancellation } = require('../../../wechat/src/platform/contracts.ts');
const {
  HttpSchoolConfigurationGateway,
} = require('../../../wechat/src/school-configuration/gateway.ts');
const {
  SchoolCommandJournal,
} = require('../../../wechat/src/school-configuration/pending.ts');
const {
  SchoolAdminController,
  initialSchoolAdminView,
} = require('../../../wechat/src/school-configuration/admin-controller.ts');
const {
  SchoolServicesController,
  initialSchoolServicesView,
} = require('../../../wechat/src/school-configuration/public-controller.ts');
const {
  publicSchoolEntryKeys,
} = require('../../../wechat/src/school-configuration/contract.ts');
test(
  'real native school services cross ordinary HTTP/PostgreSQL: exact admin CAS, public projection, lost response, cancellation, disabled/switch/revocation',
  { timeout: 180000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    try {
      const admin = await createRuntimeActor(f.app),
        member = await createRuntimeActor(f.app),
        developer = await createRuntimeActor(f.app),
        superAdmin = await createRuntimeActor(f.app);
      const grantId = randomUUID();
      await withCommunityScopeWriter(f.pool, async (tx) => {
        for (const [actor, role, region, id] of [
          [admin, 'school_admin', f.scope.home.regionId, grantId],
          [developer, 'developer', null, randomUUID()],
          [superAdmin, 'super_admin', null, randomUUID()],
        ] as const)
          await tx.query(
            `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,$3,$4,$2,'synthetic school services acceptance')`,
            [id, actor.accountId, role, region],
          );
      });
      const client = (credentials?: SessionCredentials) => {
        const sessions = new SessionStore(),
          transport = new DirectoryHttpTransport(f.port);
        if (credentials)
          sessions.completeLogin(sessions.beginLogin(), credentials);
        const auth = new AuthService(
            sessions,
            new HttpAuthGateway(directoryNativeOrigin, transport, systemClock),
            {
              login: async () => {
                throw new Error('No real provider calls');
              },
            },
            systemClock,
          ),
          api = new ApiClient(directoryNativeOrigin, transport, sessions, auth);
        return {
          sessions,
          transport,
          gateway: new HttpSchoolConfigurationGateway(api),
          profiles: new HttpProfileGateway(api),
        };
      };
      const a = client(admin),
        u = client(member),
        guest = client(),
        d = client(developer),
        s = client(superAdmin),
        cancel = new Cancellation();
      const region = f.scope.home.regionId;
      const command = (revision = 0) => ({
        clientRequestId: randomUUID(),
        expectedRevision: revision,
        entry: {
          kind: 'admin' as const,
          enabled: true,
          wechatId: 'synthetic_admin',
        },
        qrcode: { action: 'keep' as const },
      });
      await t.test(
        'guest absent configuration is exactly five unconfigured entries, developer cannot manage and super must choose explicit region',
        async () => {
          const data = await guest.gateway.public(
            f.scope.home.campusId,
            cancel,
          );
          assert.deepEqual(
            data.entries.map((entry: { entryKey: string }) => entry.entryKey),
            publicSchoolEntryKeys,
          );
          assert.ok(
            data.entries.every(
              (entry: { state: string }) => entry.state === 'unconfigured',
            ),
          );
          assert.equal(
            (await d.gateway.capabilities(cancel)).management,
            'none',
          );
          await assert.rejects(d.gateway.management(region, cancel));
          assert.equal(
            (await s.gateway.capabilities(cancel)).management,
            'global',
          );
          await assert.rejects(s.gateway.management(null, cancel));
          assert.equal(
            (await s.gateway.management(region, cancel)).context.regionId,
            region,
          );
          assert.equal(
            (await a.gateway.management(null, cancel)).context.regionId,
            region,
          );
          await assert.rejects(
            a.gateway.management(f.scope.foreign.regionId, cancel),
          );
          await request(f.app.getHttpServer())
            .get('/v1/school-services')
            .query({ campusId: f.scope.home.campusId })
            .set('Authorization', 'Bearer malformed')
            .expect(401);
        },
      );
      let first: ReturnType<typeof command>;
      await t.test(
        'save hash and original receipt are stable, foreign target/data/key do not alias',
        async () => {
          first = command();
          const receipt = await a.gateway.save(region, 'admin', first, cancel);
          assert.equal(
            receipt.requestHash,
            schoolCommandHash(admin.accountId, region, 'admin', first),
          );
          assert.deepEqual(
            await a.gateway.save(region, 'admin', first, cancel),
            receipt,
          );
          assert.deepEqual(
            (await a.gateway.recover(first.clientRequestId, cancel)).receipt,
            receipt,
          );
          await assert.rejects(
            a.gateway.save(
              region,
              'admin',
              { ...first, entry: { ...first.entry, wechatId: 'changed' } },
              cancel,
            ),
          );
          assert.equal(
            (await u.gateway.recover(first.clientRequestId, cancel)).state,
            'not_recorded',
          );
          const data = await guest.gateway.public(
            f.scope.home.campusId,
            cancel,
          );
          assert.equal(data.entries.at(-1).data.wechatId, 'synthetic_admin');
          await request(f.app.getHttpServer())
            .post(`/v1/me/school-configuration/${region}/entries/admin`)
            .set('Authorization', `Bearer ${admin.accessToken}`)
            .send({ ...command(1), appSecret: 'never-store' })
            .expect(400);
        },
      );
      await t.test(
        'ordinary native admin controller persists a lost-success request and restores exact receipt after page reconstruction',
        async () => {
          const values = new Map<string, unknown>(),
            storage = {
              get: (key: string) => values.get(key),
              set: (key: string, value: unknown) =>
                values.set(key, structuredClone(value)),
              remove: (key: string) => values.delete(key),
            },
            journal = new SchoolCommandJournal(storage, directoryNativeOrigin);
          let view = initialSchoolAdminView();
          let controller = new SchoolAdminController(
            a.sessions,
            a.gateway,
            a.profiles,
            journal,
            async () => randomUUID(),
            (next: unknown) => {
              view = next;
            },
          );
          await controller.load();
          controller.chooseEntry('admin');
          controller.setField('wechatId', 'lost_response_admin');
          a.transport.dropSuccess = {
            path: `/v1/me/school-configuration/${region}/entries/admin`,
            method: 'POST',
          };
          await controller.save();
          assert.equal(view.pending, true);
          const pending = journal.read(admin.accountId);
          assert.ok(pending);
          controller.dispose();
          controller = new SchoolAdminController(
            a.sessions,
            a.gateway,
            a.profiles,
            journal,
            async () => randomUUID(),
            (next: unknown) => {
              view = next;
            },
          );
          await controller.load();
          assert.equal(view.pending, true);
          await controller.recover();
          assert.equal(view.pending, false);
          assert.equal(journal.read(admin.accountId), null);
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_school_configuration.requests WHERE actor_id=$1 AND client_request_id=$2',
                [admin.accountId, pending.command.clientRequestId],
              )
            ).rows[0]!.n,
            1,
          );
          controller.dispose();
        },
      );
      await t.test(
        'same-key pre-save cancellation wins and concurrent CAS saves have one winner',
        async () => {
          const cancelled = command(2),
            hash = schoolCommandHash(
              admin.accountId,
              region,
              'admin',
              cancelled,
            );
          assert.equal(
            (await a.gateway.cancel(cancelled.clientRequestId, hash, cancel))
              .state,
            'cancelled',
          );
          await assert.rejects(
            a.gateway.save(region, 'admin', cancelled, cancel),
          );
          assert.equal(
            (await a.gateway.recover(cancelled.clientRequestId, cancel)).state,
            'cancelled',
          );
          const results = await Promise.allSettled([
            a.gateway.save(region, 'admin', command(2), cancel),
            a.gateway.save(region, 'admin', command(2), cancel),
          ]);
          assert.equal(
            results.filter((result) => result.status === 'fulfilled').length,
            1,
          );
        },
      );
      await t.test(
        'internal review group never projects and disabled contact cannot be copied; late prior-campus response stays cleared',
        async () => {
          await a.gateway.save(
            region,
            'review',
            {
              clientRequestId: randomUUID(),
              expectedRevision: 0,
              entry: {
                kind: 'group',
                enabled: true,
                name: 'INTERNAL REVIEW',
                description: 'NOT PUBLIC',
                joinUrl: '',
                qqGroupNumber: '12345678',
                maxGroupNumber: 1,
              },
              qrcode: { action: 'keep' },
            },
            cancel,
          );
          assert.ok(
            !JSON.stringify(
              await guest.gateway.public(f.scope.home.campusId, cancel),
            ).includes('INTERNAL'),
          );
          let view = initialSchoolServicesView();
          const copied: string[] = [];
          const controller = new SchoolServicesController(
            u.sessions,
            u.gateway,
            u.profiles,
            {
              set: async (value: string) => {
                copied.push(value);
              },
            },
            (next: unknown) => {
              view = next;
            },
          );
          await controller.load(f.scope.home.campusId);
          await controller.copy('admin', 'wechatId');
          assert.equal(copied.length, 1);
          await a.gateway.save(
            region,
            'admin',
            {
              ...command(3),
              entry: { kind: 'admin', enabled: false, wechatId: 'do_not_leak' },
            },
            cancel,
          );
          await controller.copy('admin', 'wechatId');
          assert.equal(copied.length, 1);
          assert.equal(view.entries.at(-1).data, null);
          const held = u.transport.holdNext('/v1/school-services');
          const old = controller.load(f.scope.home.campusId);
          await held.arrived;
          await controller.load(f.scope.foreign.campusId);
          held.release();
          await old;
          assert.equal(view.campusId, f.scope.foreign.campusId);
          assert.ok(
            view.entries.every(
              (entry: { state: string }) => entry.state === 'unconfigured',
            ),
          );
          u.sessions.logout();
          assert.deepEqual(view.entries, []);
          controller.dispose();
        },
      );
      await t.test(
        'permission loss blocks future management but owner metadata recovery remains, SQL provenance/receipt mutation is rejected',
        async () => {
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
              [grantId],
            ),
          );
          await assert.rejects(a.gateway.management(region, cancel));
          await assert.rejects(
            a.gateway.save(region, 'admin', command(4), cancel),
          );
          assert.equal(
            (await a.gateway.recover(first.clientRequestId, cancel)).state,
            'recorded',
          );
          await assert.rejects(
            f.pool.query(
              "UPDATE whaleu_school_configuration.publications SET data='{}'::jsonb WHERE region_id=$1",
              [region],
            ),
          );
          await assert.rejects(
            f.pool.query(
              'DELETE FROM whaleu_school_configuration.requests WHERE actor_id=$1',
              [admin.accountId],
            ),
          );
          assert.equal(
            (
              await f.pool.query(
                "SELECT count(*)::int n FROM whaleu_school_configuration.publications WHERE data::text LIKE '%never-store%' OR data::text LIKE '%appSecret%'",
              )
            ).rows[0]!.n,
            0,
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
