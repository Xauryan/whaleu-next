/** Test-only separate native process. No server policy, decoder or owner is
 * replaced. Credentials arrive over IPC and are never written to the journal. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SessionStore } = require('../../../../wechat/src/auth/session.ts');
const {
  PendingMediaStore,
} = require('../../../../wechat/src/media/pending.ts');
const {
  HttpUploadGateway,
} = require('../../../../wechat/src/media/upload-gateway.ts');
const {
  MediaUploadController,
} = require('../../../../wechat/src/media/upload-controller.ts');
const { systemClock } = require('../../../../wechat/src/platform/clock.ts');
const origin = 'https://native-process.invalid';
let controller;
process.on('message', async (message) => {
  try {
    if (message.command === 'cancel') {
      await controller.cancelOriginal();
      process.send({ event: 'cancelled', view: controller.snapshot() }, () =>
        process.exit(0),
      );
      return;
    }
    assert.equal(message.command, 'start');
    const { credentials, journalPath, port, prepare, mode } = message;
    const read = () => {
      try {
        return JSON.parse(readFileSync(journalPath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return {};
        throw error;
      }
    };
    const write = (value) =>
      writeFileSync(journalPath, JSON.stringify(value), {
        mode: 0o600,
        flush: true,
      });
    const storage = {
      get(key) {
        return read()[key];
      },
      set(key, value) {
        const saved = read();
        saved[key] = value;
        write(saved);
      },
      remove(key) {
        const saved = read();
        delete saved[key];
        write(saved);
      },
    };
    const sessions = new SessionStore();
    sessions.completeLogin(sessions.beginLogin(), credentials);
    const pending = new PendingMediaStore(storage, origin);
    if (mode === 'prepare-and-stop')
      pending.freeze(credentials.accountId, prepare, Date.now());
    const transport = {
      async send(input) {
        const url = new URL(input.url);
        assert.equal(url.origin, origin);
        assert.match(url.pathname, /^\/v2\/media\//);
        const abort = new AbortController();
        const stop = input.cancellation?.subscribe(() => abort.abort());
        try {
          const response = await fetch(
            `http://127.0.0.1:${port}${url.pathname}${url.search}`,
            {
              method: input.method,
              headers: input.headers,
              ...(input.body === undefined
                ? {}
                : { body: JSON.stringify(input.body) }),
              redirect: 'error',
              signal: abort.signal,
            },
          );
          const body = await response.json();
          if (
            mode === 'prepare-and-stop' &&
            input.method === 'POST' &&
            url.pathname === '/v2/media/upload-intents' &&
            response.status === 200
          ) {
            process.send({
              event: 'prepare-committed',
              intentId: body.intentId,
            });
            // Deliberately withhold the response from the real native controller.
            // The supervisor must observe this process actually exit before restart.
            return await new Promise(() => {});
          }
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body,
          };
        } finally {
          stop?.();
        }
      },
    };
    const gateway = new HttpUploadGateway(origin, transport, sessions, {
      async refresh() {
        throw new Error('Unexpected refresh');
      },
    });
    controller = new MediaUploadController(
      sessions,
      pending,
      gateway,
      undefined,
      systemClock,
      async () => {
        throw new Error('Recovery must not allocate another request key');
      },
    );
    await controller.recover();
    process.send({
      event: 'recovered',
      view: controller.snapshot(),
      record: pending.load(credentials.accountId),
    });
  } catch (error) {
    process.send(
      {
        event: 'failure',
        name: error?.name ?? 'Error',
        message: error?.message ?? 'Native recovery failed',
      },
      () => process.exit(1),
    );
  }
});
