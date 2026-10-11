/** Synthetic independent process harness. Real journal and HTTP adapters; no provider. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SessionStore } = require('../../src/auth/session.ts');
const { ApiClient } = require('../../src/api/client.ts');
const { Cancellation } = require('../../src/platform/contracts.ts');
const {
  PendingRatingCategoryIconStore,
} = require('../../src/ratings/category-icon-pending.ts');
const {
  HttpRatingCategoryIconGateway,
} = require('../../src/ratings/category-icon-gateway.ts');
const {
  HttpCategoryIconMediaGateway,
} = require('../../src/ratings/category-icon-media-gateway.ts');
const {
  CategoryIconCoordinator,
} = require('../../src/ratings/category-icon-coordinator.ts');
const {
  categoryIconProcessFixture,
} = require('./category-icon-process-fixtures.ts');
process.once('message', async ({ mode, stage, path, server }) => {
  try {
    const fixture = categoryIconProcessFixture(),
      origin = 'https://category-icon-process.invalid';
    const read = () => {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
      }
    };
    const write = (value) => {
      writeFileSync(path + '.next', JSON.stringify(value), {
        mode: 0o600,
        flush: true,
      });
      renameSync(path + '.next', path);
    };
    const storage = {
      get: (key) => read()[key],
      set: (key, value) => {
        const all = read();
        all[key] = value;
        write(all);
      },
      remove: (key) => {
        const all = read();
        delete all[key];
        write(all);
      },
    };
    const sessions = new SessionStore();
    sessions.completeLogin(sessions.beginLogin(), {
      accountId: fixture.actor,
      sessionId: 'synthetic-process-session',
      accessToken: 'synthetic-category-process-access',
      refreshToken: 'synthetic-category-process-refresh',
      expiresAt: 9999999999999,
      refreshExpiresAt: 99999999999999,
    });
    const store = new PendingRatingCategoryIconStore(storage, origin);
    store.watchSession(sessions);
    if (mode === 'write') {
      let uploads = store.start(fixture.initial);
      if (stage !== 'uploads-frozen') {
        uploads = store.update(uploads, {
          ...uploads,
          members: [fixture.pending],
        });
        if (stage !== 'scope-response-lost')
          store.update(uploads, {
            ...uploads,
            members: [fixture.ready],
          });
      }
      if (
        ['command-frozen', 'applied-response-lost', 'opaque-switch'].includes(
          stage,
        )
      )
        store.freezeCommand(fixture.actor, fixture.intent);
      if (stage === 'opaque-switch') sessions.logout();
      const timer = setInterval(() => undefined, 60000);
      process.once('disconnect', () => clearInterval(timer));
      process.send({ event: 'durable' });
      return;
    }
    const transport = {
      send: async (request) => {
        assert.ok(request.url.startsWith(origin + '/'));
        const url = new URL(request.url),
          response = await fetch(server + url.pathname + url.search, {
            method: request.method,
            headers: request.headers,
            ...(request.body === undefined
              ? {}
              : { body: JSON.stringify(request.body) }),
          });
        return {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: await response.json(),
        };
      },
    };
    const api = new ApiClient(origin, transport, sessions, {
        refresh: async () => {
          throw Error('No refresh');
        },
      }),
      runtime = {
        sessions,
        pendingRatingCategoryIcon: store,
        ratingCategoryIcon: new HttpRatingCategoryIconGateway(api, sessions),
        ratingCategoryIconMedia: new HttpCategoryIconMediaGateway(api),
        newRequestId: async () => {
          throw Error('No new identity while recovering');
        },
      };
    const controller = new CategoryIconCoordinator(
      runtime,
      {
        now: () => 1791674400000,
        schedule: (fn, ms) => {
          const t = setTimeout(fn, ms);
          return () => clearTimeout(t);
        },
      },
      () => undefined,
    );
    const receipt = await controller.recover(new Cancellation());
    if (!receipt) await controller.cancel(new Cancellation());
    assert.deepEqual(read(), {});
    controller.dispose();
    process.send({ event: 'recovered' });
    process.disconnect();
  } catch (error) {
    process.send({ event: 'error', message: error.stack ?? String(error) });
    process.disconnect();
  }
});
