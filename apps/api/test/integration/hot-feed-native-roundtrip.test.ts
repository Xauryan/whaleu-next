import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import {
  hotFeedFixture,
  hotIds,
  hotOk,
  hotPath,
} from '../support/hot-feed-fixture.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
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
  HttpHotGateway,
} = require('../../../wechat/src/community/hot-gateway.ts');
const {
  HotController,
  initialHotView,
} = require('../../../wechat/src/pages/community-hot/controller.ts');
const {
  ViewObserver,
} = require('../../../wechat/src/community/view-observer.ts');
interface HotView {
  posts: { id: string }[];
  loaded: boolean;
  range: string;
  error: string;
  canPrevious: boolean;
  canNext: boolean;
  continuation: string;
}
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
const protocol = (error: unknown) => {
  assert.ok(error instanceof ClientError);
  assert.equal((error as { kind: string }).kind, 'protocol');
  return true;
};
class NativeClock {
  private value = Date.now();
  private serial = 0;
  private pending = new Map<number, { at: number; callback: () => void }>();
  now = () => this.value;
  schedule = (callback: () => void, ms: number) => {
    const key = ++this.serial;
    this.pending.set(key, { at: this.value + ms, callback });
    return () => {
      this.pending.delete(key);
    };
  };
  advance(ms: number) {
    this.value += ms;
    for (let guard = 0; guard < 100; guard++) {
      const next = [...this.pending]
        .filter(([, task]) => task.at <= this.value)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) return;
      this.pending.delete(next[0]);
      next[1].callback();
    }
    assert.fail('Native test clock exceeded bounded callback work');
  }
}

test(
  'actual native hot gateway/controller/exposure runtime roundtrips normal HTTP and PostgreSQL',
  { timeout: 120000 },
  async (t) => {
    const f = await hotFeedFixture();
    await f.app.listen(0, '127.0.0.1');
    const transport = new DirectoryHttpTransport(
      Number(new URL(await f.app.getUrl()).port),
    );
    const w = await f.world(),
      rows: string[] = [];
    for (let n = 0; n < 12; n++) rows.push((await w.ready()).id);
    const minimum = [...rows].sort()[0]!;
    const makeClient = (
      credentials: SessionCredentials | null = w.reader,
      clock = systemClock,
    ) => {
      const native = platform(),
        sessions = new SessionStore();
      if (credentials)
        sessions.completeLogin(sessions.beginLogin(), credentials);
      const auth = new AuthService(
        sessions,
        new HttpAuthGateway(directoryNativeOrigin, transport, clock),
        {
          login: async () => {
            throw new Error('No provider in local acceptance');
          },
        },
        clock,
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
        clock,
      );
      return { native, sessions, runtime, gateway: new HttpHotGateway(api) };
    };
    const client = makeClient(),
      cancel = new Cancellation();
    const send = transport.send.bind(transport);
    transport.send = async (input) => {
      if (new URL(input.url).pathname === '/v1/me/community/view-reports') {
        assert.ok(input.body && typeof input.body === 'object');
        assert.deepEqual(Object.keys(input.body).sort(), [
          'batchId',
          'epochId',
          'kind',
          'postIds',
          'version',
        ]);
      }
      return send(input);
    };
    transport.checkResponse = (path, status, body) => {
      if (path === hotPath && status === 200)
        hotOk({ status, body: body as Parameters<typeof hotIds>[0] });
    };
    try {
      await t.test(
        'strict native decoder reads optional-auth real page and rejects private extras/current-page duplicates',
        async () => {
          const intent = { spaceId: w.scope.home.spaceId, range: 'day' };
          const page = await client.gateway.hot(intent, null, cancel, 10);
          assert.equal(page.items.length, 10);
          const guest = makeClient(null);
          try {
            const preview = await guest.gateway.hot(intent, null, cancel);
            assert.equal(preview.continuation, 'login_required');
            assert.equal(preview.nextCursor, null);
          } finally {
            guest.runtime.views.dispose();
          }
          for (const transform of [
            (body: Record<string, unknown>) => ({ ...body, score: '3.1400' }),
            (body: Record<string, unknown>) => ({
              ...body,
              inputs: { views: '1' },
            }),
            (body: Record<string, unknown>) => ({
              ...body,
              items: [
                ...(body['items'] as unknown[]).slice(0, 1),
                ...(body['items'] as unknown[]).slice(0, 1),
              ],
            }),
            (body: Record<string, unknown>) => ({
              ...body,
              items: (body['items'] as object[]).map((row, i) =>
                i === 0 ? { ...row, certificate: 'private' } : row,
              ),
            }),
          ]) {
            transport.corruptNext = {
              path: hotPath,
              transform: (body) => transform(body as Record<string, unknown>),
            };
            await assert.rejects(
              client.gateway.hot(intent, null, cancel),
              protocol,
            );
          }
          assert.ok(
            transport.exchanges.some(
              (e) => e.path.startsWith(hotPath) && !e.authorized,
            ),
          );
        },
      );
      await t.test(
        'real score movement may repeat an earlier card on a later page; fresh Previous never uses cached cards',
        async () => {
          await f.like(w.reader, minimum);
          await f.settle('like', minimum);
          await f.materializer.refresh(minimum);
          let view: HotView = initialHotView();
          const controller = new HotController(
            client.runtime,
            (value: HotView) => {
              view = value;
            },
          );
          try {
            await controller.load({ spaceId: w.scope.home.spaceId });
            assert.equal(view.loaded, true);
            assert.equal(view.posts[0]!.id, minimum);
            const first = view.posts.map((p) => p.id);
            await f.like(w.reader, minimum, false);
            await f.settle('like', minimum);
            await f.materializer.refresh(minimum);
            await controller.next();
            assert.equal(view.loaded, true);
            assert.equal(view.error, '');
            assert.ok(view.posts.some((p) => p.id === minimum));
            assert.ok(first.includes(minimum));
            assert.equal(view.canPrevious, true);
            const exchanges = transport.exchanges.length;
            await controller.previous();
            assert.equal(view.loaded, true);
            assert.equal(transport.exchanges.length, exchanges + 1);
            assert.notEqual(view.posts[0]!.id, minimum);
            await controller.setRange('week');
            assert.equal(view.range, 'week');
            assert.equal(view.canPrevious, false);
            assert.equal(view.loaded, true);
          } finally {
            controller.dispose();
          }
        },
      );
      await t.test(
        'late range response and same-account relogin cannot restore prior current cards',
        async () => {
          let view: HotView = initialHotView();
          const controller = new HotController(
            client.runtime,
            (value: HotView) => {
              view = value;
            },
          );
          try {
            await controller.load({ spaceId: w.scope.home.spaceId });
            const held = transport.holdNext(hotPath);
            const old = controller.setRange('week');
            await held.arrived;
            const fresh = controller.setRange('month');
            held.release();
            await Promise.all([old, fresh]);
            assert.equal(view.loaded, true);
            assert.equal(view.range, 'month');
            const gate = transport.holdNext(hotPath),
              pending = controller.refresh();
            await gate.arrived;
            client.sessions.completeLogin(
              client.sessions.beginLogin(),
              w.reader,
            );
            assert.deepEqual(view.posts, []);
            gate.release();
            await pending;
            assert.deepEqual(view.posts, []);
            await controller.load({ spaceId: w.scope.home.spaceId });
            assert.equal(view.loaded, true);
            controller.cancel();
            assert.deepEqual(view.posts, []);
          } finally {
            controller.dispose();
          }
        },
      );
      await t.test(
        'existing exposure contract requires render commit, >=50% continuously for 1s, and never reports guest fetches',
        async () => {
          const clock = new NativeClock(),
            native = makeClient(w.reader, clock);
          const callbacks = new Map<
            string,
            (event: { intersectionRatio: number }) => void
          >();
          const wx = {
            nextTick: (callback: () => void) => callback(),
            createIntersectionObserver: () => {
              let selector = '';
              const observer = {
                relativeToViewport: () => observer,
                observe: (
                  value: string,
                  callback: (event: { intersectionRatio: number }) => void,
                ) => {
                  selector = value;
                  callbacks.set(value, callback);
                },
                disconnect: () => {
                  callbacks.delete(selector);
                },
              };
              return observer;
            },
          };
          await native.runtime.views.foreground();
          const observer = new ViewObserver(
            wx,
            {},
            clock,
            native.runtime.views,
            'list_exposure',
          );
          const count = async () =>
            (
              await f.pool.query<{ count: string }>(
                'SELECT count::text FROM whaleu_post_hotness.view_states WHERE post_id=$1',
                [minimum],
              )
            ).rows[0]!.count;
          const before = await count();
          try {
            const cards = await native.gateway.hot(
              { spaceId: w.scope.home.spaceId, range: 'day' },
              null,
              cancel,
            );
            assert.equal(
              await count(),
              before,
              'A fetched page is not an exposure',
            );
            const render = observer.render(
              cards.items.map((p: { id: string }) => p.id),
              `${w.scope.home.spaceId}:day`,
            );
            assert.equal(callbacks.size, 0);
            render();
            const target = cards.items[0].id,
              callback = callbacks.get(`#view-${target}`)!;
            assert.ok(callback);
            callback({ intersectionRatio: 0.49 });
            clock.advance(1000);
            callback({ intersectionRatio: 0.5 });
            clock.advance(999);
            const reports = transport.exchanges.filter(
              (e) => e.path === '/v1/me/community/view-reports',
            ).length;
            clock.advance(1);
            // The unchanged runtime batches list exposure for five minutes. Advance only
            // native platform time; PostgreSQL clock and credential deadlines stay real.
            clock.advance(300000);
            const deadline = Date.now() + 5000;
            while (
              Date.now() < deadline &&
              transport.exchanges.filter(
                (e) => e.path === '/v1/me/community/view-reports',
              ).length === reports
            )
              await sleep(20);
            assert.equal(
              transport.exchanges.filter(
                (e) => e.path === '/v1/me/community/view-reports',
              ).length,
              reports + 1,
            );
            assert.equal(
              (
                await f.pool.query<{ count: string }>(
                  'SELECT count::text FROM whaleu_post_hotness.view_states WHERE post_id=$1',
                  [target],
                )
              ).rows[0]!.count,
              '1',
            );
            callback({ intersectionRatio: 0 });
            callback({ intersectionRatio: 0.5 });
            clock.advance(1000);
            clock.advance(300000);
            const againUntil = Date.now() + 5000;
            while (
              Date.now() < againUntil &&
              transport.exchanges.filter(
                (e) => e.path === '/v1/me/community/view-reports',
              ).length ===
                reports + 1
            )
              await sleep(20);
            assert.equal(
              transport.exchanges.filter(
                (e) => e.path === '/v1/me/community/view-reports',
              ).length,
              reports + 2,
            );
            assert.equal(
              (
                await f.pool.query<{ count: string }>(
                  'SELECT count::text FROM whaleu_post_hotness.view_states WHERE post_id=$1',
                  [target],
                )
              ).rows[0]!.count,
              '2',
              'Qualified re-entry counts again under the existing contract',
            );
            observer.dispose();
            native.runtime.views.hide();
            assert.equal(callbacks.size, 0);
            const guest = makeClient(null, clock),
              guestObserver = new ViewObserver(
                wx,
                {},
                clock,
                guest.runtime.views,
                'list_exposure',
              );
            try {
              await guest.runtime.views.foreground();
              guestObserver.render([target], `${w.scope.home.spaceId}:day`)();
              clock.advance(1000);
              assert.equal(callbacks.size, 0);
            } finally {
              guestObserver.dispose();
              guest.runtime.views.dispose();
            }
          } finally {
            observer.dispose();
            native.runtime.views.dispose();
          }
        },
      );
    } finally {
      client.runtime.views.dispose();
      await f.close();
    }
  },
);
