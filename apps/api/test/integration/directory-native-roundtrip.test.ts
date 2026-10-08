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
  seedDirectoryTaxonomy,
  seedDirectoryCatalog,
  syntheticDirectoryCategory,
  syntheticDirectoryEntry,
} from '../support/directory-catalog-fixtures.js';
import { appendIdentitySelection } from '../support/community-scope-fixtures.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';

const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { ClientError } = require('../../../wechat/src/api/errors.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const { Cancellation } = require('../../../wechat/src/platform/contracts.ts');
const {
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const {
  HttpDirectoryGateway,
} = require('../../../wechat/src/directory/gateway.ts');
const {
  DirectoryHubController,
  DirectoryListController,
  DirectoryDetailController,
  initialDirectoryView,
} = require('../../../wechat/src/directory/controller.ts');

interface DirectoryView {
  loaded: boolean;
  canCopy: boolean;
  copyBusy: boolean;
  entries: readonly { id: string }[];
  categories: readonly { id: string }[];
  detail: unknown;
  error: string;
  status: string;
}
const protocol = (error: unknown) => {
  assert.ok(error instanceof ClientError);
  assert.equal((error as { kind: string }).kind, 'protocol');
  return true;
};
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
  'actual native directory gateway, decoders and lifecycle cross normal Nest HTTP and PostgreSQL',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture(),
      transport = new DirectoryHttpTransport(f.port);
    const cancel = new Cancellation(),
      actor = await f.actor();
    const regionId = f.scope.home.regionId;
    const category = syntheticDirectoryCategory();
    const taxonomy = await seedDirectoryTaxonomy(f.pool, regionId, 'org', [
      category,
    ]);
    const rows = Array.from({ length: 24 }, (_, i) =>
      syntheticDirectoryEntry(category.id, {
        name: `Native 社群${i}`,
        ordinal: i,
        searchOrdinal: i,
        badge: i === 0 ? 'official' : 'normal',
      }),
    );
    await seedDirectoryCatalog(f.pool, regionId, 'org', taxonomy, rows);
    const path = `/v1/directory/regions/${regionId}/entries`;
    const route = {
      regionId,
      kind: 'org',
      categoryId: category.id,
      entryId: rows[0]!.id,
    };
    const makeClient = (credentials: SessionCredentials = actor) => {
      const native = platform(),
        sessions = new SessionStore();
      sessions.completeLogin(sessions.beginLogin(), credentials);
      const auth = new AuthService(
        sessions,
        new HttpAuthGateway(directoryNativeOrigin, transport, systemClock),
        { login: async () => 'provider-never-called' },
        systemClock,
      );
      const api = new ApiClient(
        directoryNativeOrigin,
        transport,
        sessions,
        auth,
      );
      const runtime = createCommunityRuntime(
        { sessions, auth, api },
        native,
        directoryNativeOrigin,
      );
      return {
        native,
        sessions,
        runtime,
        gateway: new HttpDirectoryGateway(api),
      };
    };
    const client = makeClient();
    try {
      await t.test(
        'required-auth gateway strictly decodes real context, category, paged list and QQ detail',
        async () => {
          assert.deepEqual(await client.gateway.context(cancel), { regionId });
          const categories = await client.gateway.categories(
            regionId,
            'org',
            null,
            cancel,
          );
          assert.equal(categories.items[0].id, category.id);
          const first = await client.gateway.entries(
            { regionId, kind: 'org', categoryId: category.id },
            null,
            cancel,
          );
          assert.equal(first.items.length, 20);
          assert.equal(first.continuation, 'more');
          const next = await client.gateway.entries(
            { regionId, kind: 'org', categoryId: category.id },
            first.nextCursor,
            cancel,
          );
          assert.deepEqual(
            [...first.items, ...next.items].map(
              (row: { id: string }) => row.id,
            ),
            rows.map((row) => row.id),
          );
          assert.equal(next.continuation, 'end');
          const detail = await client.gateway.detail(
            regionId,
            rows[0]!.id,
            cancel,
          );
          assert.equal(detail.platform, 'qq');
          assert.deepEqual(detail.badge, {
            status: 'known',
            value: 'official',
          });
          assert.equal(detail.qqGroupNumber.value, rows[0]!.qqNumber);
          assert.ok(
            transport.exchanges.every(
              (exchange) => exchange.method === 'GET' && exchange.authorized,
            ),
          );
        },
      );
      await t.test(
        'strict decoders reject private extras, wrong kind/category/id, media URLs and inconsistent platform branches from HTTP',
        async () => {
          const corruptions: ((body: Record<string, unknown>) => unknown)[] = [
            (body) => ({ ...body, created_by_user_id: actor.accountId }),
            (body) => ({ ...body, id: randomUUID() }),
            (body) => ({
              ...body,
              avatar: {
                status: 'unavailable',
                value: 'https://private.invalid/qr',
              },
            }),
            (body) => ({
              ...body,
              qqGroupNumber: { status: 'known', value: '123456', secret: true },
            }),
            (body) => ({ ...body, platform: 'official' }),
            (body) => ({
              ...body,
              managers: {
                status: 'unavailable',
                items: [{ id: actor.accountId }],
              },
            }),
          ];
          for (const transform of corruptions) {
            transport.corruptNext = {
              path: `${path}/${rows[0]!.id}`,
              transform: (body) => transform(body as Record<string, unknown>),
            };
            await assert.rejects(
              client.gateway.detail(regionId, rows[0]!.id, cancel),
              protocol,
            );
          }
          for (const patch of [
            { kind: 'school' },
            { categoryId: randomUUID() },
            { qqGroupNumber: { status: 'known', value: '123456' } },
          ]) {
            transport.corruptNext = {
              path,
              transform: (body) => {
                const result = body as { items: object[] };
                return {
                  ...result,
                  items: result.items.map((row, i) =>
                    i === 0 ? { ...row, ...patch } : row,
                  ),
                };
              },
            };
            await assert.rejects(
              client.gateway.entries(
                { regionId, kind: 'org', categoryId: category.id },
                null,
                cancel,
              ),
              protocol,
            );
          }
        },
      );
      await t.test(
        'hub/list paths retain org context and fresh Previous requests replace pages in accepted order',
        async () => {
          let hubView: DirectoryView = initialDirectoryView(),
            listView: DirectoryView = initialDirectoryView();
          const hub = new DirectoryHubController(
            client.runtime,
            (value: DirectoryView) => {
              hubView = value;
            },
          );
          const list = new DirectoryListController(
            client.runtime,
            (value: DirectoryView) => {
              listView = value;
            },
          );
          try {
            await hub.load({ kind: 'org' });
            assert.equal(hubView.loaded, true);
            assert.ok(hub.categoryPath(category.id).includes('kind=org'));
            await list.load({ regionId, kind: 'org', categoryId: category.id });
            assert.equal(listView.entries[0]!.id, rows[0]!.id);
            assert.ok(list.entryPath(rows[0]!.id).includes('kind=org'));
            await list.next();
            assert.equal(listView.entries[0]!.id, rows[20]!.id);
            assert.equal(listView.entries.length, 4);
            const count = transport.exchanges.length;
            await list.previous();
            assert.ok(transport.exchanges.length > count);
            assert.equal(listView.entries[0]!.id, rows[0]!.id);
            list.setInput('不存在的名字');
            await list.submit();
            assert.equal(listView.loaded, true);
            assert.equal(listView.entries.length, 0);
            assert.equal(listView.status, '没有匹配的名称');
            await list.clearSearch();
            assert.equal(listView.entries.length, 20);
          } finally {
            hub.dispose();
            list.dispose();
          }
          assert.equal(listView.entries.length, 0);
          assert.equal(hubView.categories.length, 0);
        },
      );
      await t.test(
        'copy only reads current authorized DTO and suppresses repeated pending taps and hide callbacks',
        async () => {
          let view: DirectoryView = initialDirectoryView();
          const copies: string[] = [];
          const detail = new DirectoryDetailController(
            client.runtime,
            (value: DirectoryView) => {
              view = value;
            },
          );
          await detail.load(route);
          assert.equal(view.canCopy, true);
          let release!: () => void;
          const wait = new Promise<void>((resolve) => {
            release = resolve;
          });
          const pending = detail.copyQq(async (value: string) => {
            copies.push(value);
            await wait;
          });
          await detail.copyQq(async (value: string) => {
            copies.push(value);
          });
          assert.deepEqual(copies, [rows[0]!.qqNumber]);
          detail.dispose();
          release();
          await pending;
          assert.equal(view.detail, null);
          assert.equal(view.canCopy, false);
          assert.equal(view.copyBusy, false);
          await detail.copyQq(async (value: string) => {
            copies.push(value);
          });
          assert.equal(copies.length, 1);
        },
      );
      await t.test(
        'late real response after hide cannot restore body or contact',
        async () => {
          let view: DirectoryView = initialDirectoryView();
          const detail = new DirectoryDetailController(
            client.runtime,
            (value: DirectoryView) => {
              view = value;
            },
          );
          const gate = transport.holdNext(`${path}/${rows[0]!.id}`);
          const pending = detail.load(route);
          await gate.arrived;
          detail.dispose();
          gate.release();
          await pending;
          assert.equal(view.detail, null);
          assert.equal(view.canCopy, false);
        },
      );
      await t.test(
        'same-account login epoch replacement and scope invalidation immediately clear loaded detail',
        async () => {
          const isolated = makeClient();
          let view: DirectoryView = initialDirectoryView();
          const detail = new DirectoryDetailController(
            isolated.runtime,
            (value: DirectoryView) => {
              view = value;
            },
          );
          try {
            await detail.load(route);
            assert.ok(view.detail);
            isolated.sessions.completeLogin(
              isolated.sessions.beginLogin(),
              actor,
            );
            assert.equal(view.detail, null);
            assert.equal(view.canCopy, false);
            await detail.load(route);
            assert.ok(view.detail);
            isolated.runtime.directoryScopeChanges.clear(actor.accountId);
            assert.equal(view.detail, null);
            assert.equal(view.canCopy, false);
          } finally {
            detail.dispose();
          }
        },
      );
      await t.test(
        'scope change while real response is pending prevents any stale list projection',
        async () => {
          const isolated = makeClient();
          let view: DirectoryView = initialDirectoryView();
          const list = new DirectoryListController(
            isolated.runtime,
            (value: DirectoryView) => {
              view = value;
            },
          );
          const gate = transport.holdNext(path);
          const pending = list.load({
            regionId,
            kind: 'org',
            categoryId: category.id,
          });
          await gate.arrived;
          isolated.runtime.directoryScopeChanges.clear(actor.accountId);
          gate.release();
          await pending;
          assert.equal(view.entries.length, 0);
          assert.equal(view.loaded, false);
          list.dispose();
        },
      );
      await t.test(
        'protocol and network replacement errors clear old detail before retry and never persist contact or cursor',
        async () => {
          const isolated = makeClient();
          let view: DirectoryView = initialDirectoryView();
          const detail = new DirectoryDetailController(
            isolated.runtime,
            (value: DirectoryView) => {
              view = value;
            },
          );
          try {
            await detail.load(route);
            assert.ok(view.detail);
            transport.corruptNext = {
              path: `${path}/${rows[0]!.id}`,
              transform: (body) => ({
                ...(body as object),
                raw_media: 'secret',
              }),
            };
            await detail.refresh();
            assert.equal(view.detail, null);
            assert.equal(view.canCopy, false);
            assert.ok(view.error);
            await detail.refresh();
            assert.ok(view.detail);
            transport.failNext = `${path}/${rows[0]!.id}`;
            await detail.refresh();
            assert.equal(view.detail, null);
            assert.ok(view.error);
            assert.equal(isolated.native.values.size, 0);
          } finally {
            detail.dispose();
          }
        },
      );
      await t.test(
        'hide, scope change and logout before clipboard microtask suppress the copy dispatch',
        async () => {
          for (const change of ['hide', 'scope', 'logout']) {
            const isolated = makeClient();
            let view: DirectoryView = initialDirectoryView();
            const detail = new DirectoryDetailController(
              isolated.runtime,
              (value: DirectoryView) => {
                view = value;
              },
            );
            const copied: string[] = [];
            try {
              await detail.load(route);
              assert.ok(view.detail);
              const pending = detail.copyQq(async (value: string) => {
                copied.push(value);
              });
              if (change === 'hide') detail.dispose();
              if (change === 'scope')
                isolated.runtime.directoryScopeChanges.clear(actor.accountId);
              if (change === 'logout') isolated.sessions.logout();
              await pending;
              assert.deepEqual(
                copied,
                [],
                `Clipboard must not dispatch after ${change}`,
              );
              assert.equal(view.detail, null);
              assert.equal(view.canCopy, false);
            } finally {
              detail.dispose();
            }
          }
        },
      );
      await t.test(
        'identity selection changed while hidden requires fresh home and refuses old route on return',
        async () => {
          let view: DirectoryView = initialDirectoryView();
          const first = new DirectoryDetailController(
            client.runtime,
            (value: DirectoryView) => {
              view = value;
            },
          );
          await first.load(route);
          first.dispose();
          await appendIdentitySelection(
            f.pool,
            actor.accountId,
            actor.facts,
            f.scope,
            f.scope.related.campusId,
          );
          const returning = new DirectoryDetailController(
            client.runtime,
            (value: DirectoryView) => {
              view = value;
            },
          );
          try {
            await returning.load(route);
            assert.equal(view.detail, null);
            assert.equal(view.canCopy, false);
            assert.ok(view.error);
          } finally {
            returning.dispose();
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);
