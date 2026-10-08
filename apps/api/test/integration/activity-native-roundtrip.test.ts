import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
import {
  syntheticActivity,
  seedActivityCatalog,
  seedActivityHistory,
  activityVisitCount,
} from '../support/activity-fixtures.js';
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
  HttpActivitiesGateway,
} = require('../../../wechat/src/activities/gateway.ts');
const {
  HttpProfileGateway,
} = require('../../../wechat/src/profile/gateway.ts');
const {
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const {
  ActivityController,
  initialActivityView,
} = require('../../../wechat/src/activities/controller.ts');
const {
  ActivityVisitController,
  initialActivityVisitView,
} = require('../../../wechat/src/activities/visit-controller.ts');
const {
  ActivityPreferenceController,
  initialActivityPreferenceView,
} = require('../../../wechat/src/activities/preference.ts');
function platform() {
  const values = new Map<string, unknown>();
  return {
    values,
    getStorageSync: (key: string) => structuredClone(values.get(key)),
    setStorageSync: (key: string, value: unknown) =>
      values.set(key, structuredClone(value)),
    removeStorageSync: (key: string) => values.delete(key),
    getRandomValues: (input: {
      length: number;
      success(value: { randomValues: ArrayBuffer }): void;
    }) =>
      input.success({
        randomValues: Uint8Array.from(randomBytes(input.length)).buffer,
      }),
  };
}
test(
  'actual activity native controllers/gateway/preferences cross ordinary AppModule HTTP and PostgreSQL',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture(),
      transport = new DirectoryHttpTransport(f.port),
      actor = await f.actor(),
      native = platform(),
      sessions = new SessionStore();
    sessions.completeLogin(sessions.beginLogin(), actor);
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
      api = new ApiClient(directoryNativeOrigin, transport, sessions, auth),
      runtime = createCommunityRuntime(
        { sessions, auth, api },
        native,
        directoryNativeOrigin,
      ),
      gateway = new HttpActivitiesGateway(api),
      profiles = new HttpProfileGateway(api),
      cancel = new Cancellation(),
      region = f.scope.home.regionId;
    const rows = Array.from({ length: 24 }, (_, i) =>
      syntheticActivity({
        ordinal: String(i + 1),
        createdAt: new Date(Date.now() - 3600000).toISOString(),
      }),
    );
    let catalog = await seedActivityCatalog(f.pool, region, rows);
    await seedActivityHistory(f.pool, actor.accountId, 'never_visited');
    try {
      await t.test(
        'required gateway decodes context/list/detail, exact receipt and frozen previous selection',
        async () => {
          assert.deepEqual(await gateway.context(cancel), {
            regionId: region,
            visitHistory: 'never_visited',
          });
          const first = await gateway.list(region, 'entry', null, cancel);
          assert.equal(first.items.length, 20);
          assert.equal(first.selection.kind, 'recent');
          const detail = await gateway.detail(region, rows[0]!.id, cancel);
          assert.equal(detail.bodyText, rows[0]!.bodyText);
          assert.equal(await activityVisitCount(f.pool, actor.accountId), 0);
          const intent = {
            requestId: randomUUID(),
            regionId: region,
            expectedCatalogRevision: catalog,
          };
          const receipt = await gateway.visit(intent, cancel);
          assert.equal(receipt.requestId, intent.requestId);
          assert.deepEqual(await gateway.visit(intent, cancel), receipt);
          const second = await gateway.list(
            region,
            'entry',
            first.nextCursor,
            cancel,
          );
          assert.equal(second.items.length, 4);
          const previous = await gateway.list(
            region,
            'entry',
            first.pageCursor,
            cancel,
          );
          assert.deepEqual(previous.selection, first.selection);
          assert.deepEqual(previous.items, first.items);
          assert.ok(
            transport.exchanges.every((exchange) => exchange.authorized),
          );
        },
      );
      await t.test(
        'render-completion visibility writes once, detail does not, hidden views and late callbacks are cleared',
        async () => {
          let view = initialActivityView(),
            visitView = initialActivityVisitView(),
            completion: Promise<void> | undefined;
          const visits = new ActivityVisitController(
              runtime,
              (v: typeof visitView) => {
                visitView = v;
              },
            ),
            controller = new ActivityController(
              runtime,
              'list',
              (v: typeof view) => {
                view = v;
              },
              (context: { regionId: string; catalogRevision: string }) => {
                completion = visits.acknowledge(context);
              },
            );
          const before = await activityVisitCount(f.pool, actor.accountId);
          try {
            await controller.load();
            assert.equal(view.loaded, true, view.error);
            assert.equal(
              await activityVisitCount(f.pool, actor.accountId),
              before,
            );
            controller.visible(view.renderKey);
            controller.visible(view.renderKey);
            await completion;
            assert.equal(visitView.confirmed, true, visitView.error);
            assert.equal(
              await activityVisitCount(f.pool, actor.accountId),
              before + 1,
            );
            await controller.next();
            assert.equal(view.pageNumber, 2);
            await controller.previous();
            assert.equal(view.pageNumber, 1);
            const key = view.renderKey;
            controller.dispose();
            controller.visible(key);
            assert.equal(view.items.length, 0);
            assert.equal(
              await activityVisitCount(f.pool, actor.accountId),
              before + 1,
            );
          } finally {
            controller.dispose();
            visits.dispose();
          }
          let detailView = initialActivityView();
          const detailController = new ActivityController(
            runtime,
            'detail',
            (v: typeof detailView) => {
              detailView = v;
            },
          );
          try {
            await detailController.load({
              regionId: region,
              activityId: rows[0]!.id,
            });
            assert.equal(detailView.detail.bodyText, rows[0]!.bodyText);
            assert.equal(
              await activityVisitCount(f.pool, actor.accountId),
              before + 1,
            );
          } finally {
            detailController.dispose();
          }
        },
      );
      await t.test(
        'response-loss recovery replays minimal original receipt after accepted catalog replacement',
        async () => {
          const id = randomUUID(),
            intent = {
              requestId: id,
              regionId: region,
              expectedCatalogRevision: catalog,
            };
          transport.dropSuccess = {
            path: `/v1/me/activity-visits/${id}`,
            method: 'PUT',
          };
          const before = await activityVisitCount(f.pool, actor.accountId);
          await assert.rejects(gateway.visit(intent, cancel));
          assert.equal(
            await activityVisitCount(f.pool, actor.accountId),
            before + 1,
          );
          catalog = await seedActivityCatalog(f.pool, region, rows);
          const receipt = await gateway.visit(intent, cancel);
          assert.equal(receipt.catalogRevision, intent.expectedCatalogRevision);
          assert.equal(
            await activityVisitCount(f.pool, actor.accountId),
            before + 1,
          );
        },
      );
      await t.test(
        'Profile owner persists reminder preference with revision conflict and unrelated settings preserved',
        async () => {
          const before = await profiles.profile(cancel),
            saved = await profiles.updatePreferences(
              {
                expectedRevision: before.revision,
                preferences: {
                  activitySubscribed: !before.preferences.activitySubscribed,
                },
              },
              cancel,
            );
          assert.equal(
            saved.preferences.activitySubscribed,
            !before.preferences.activitySubscribed,
          );
          for (const key of Object.keys(before.preferences))
            if (key !== 'activitySubscribed')
              assert.equal(saved.preferences[key], before.preferences[key]);
          await assert.rejects(
            profiles.updatePreferences(
              {
                expectedRevision: before.revision,
                preferences: {
                  activitySubscribed: before.preferences.activitySubscribed,
                },
              },
              cancel,
            ),
          );
          assert.equal(
            (await profiles.profile(cancel)).preferences.activitySubscribed,
            saved.preferences.activitySubscribed,
          );
          // The actual activity preference controller uses that same owner gateway.
          let view = initialActivityPreferenceView();
          const controller = new ActivityPreferenceController(
            runtime,
            (v: typeof view) => {
              view = v;
            },
          );
          try {
            await controller.load();
            assert.equal(view.loaded, true, view.error);
          } finally {
            controller.dispose();
          }
        },
      );
      await t.test(
        'native strict decoding rejects a source-field injection and account epoch clears body',
        async () => {
          transport.corruptNext = {
            path: `/v1/regions/${region}/activities`,
            transform: (body: unknown) => ({
              ...(body as object),
              sourceId: 'private',
            }),
          };
          await assert.rejects(gateway.list(region, 'all', null, cancel));
          let view = initialActivityView();
          const controller = new ActivityController(
            runtime,
            'list',
            (v: typeof view) => {
              view = v;
            },
          );
          try {
            await controller.load();
            assert.equal(view.loaded, true);
            sessions.logout();
            assert.equal(view.items.length, 0);
            assert.equal(view.loaded, false);
          } finally {
            controller.dispose();
          }
          assert.ok(
            !JSON.stringify([...native.values]).includes(rows[0]!.bodyText),
          );
        },
      );
    } finally {
      runtime.views?.dispose();
      await f.close();
    }
  },
);
