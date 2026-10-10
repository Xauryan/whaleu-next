/** Independent-process journal/HTTP harness. All credentials and endpoints are
 * synthetic. Parent sends SIGKILL after the durable checkpoint, never a throw. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SessionStore } = require('../../src/auth/session.ts');
const { ApiClient } = require('../../src/api/client.ts');
const { Cancellation } = require('../../src/platform/contracts.ts');
const {
  PendingRatingDiscussionMediaStore,
} = require('../../src/ratings/discussion-media-pending.ts');
const {
  RatingDiscussionMediaController,
} = require('../../src/ratings/discussion-media-controller.ts');
const {
  HttpRatingDiscussionMediaGateway,
} = require('../../src/ratings/discussion-media-gateway.ts');
const {
  discussionProcessFixture,
  processId,
} = require('./discussion-media-process-fixtures.ts');

function durableCheckpoint(stage, calls) {
  // The one-shot startup message listener has already been removed, so IPC
  // and idle HTTP sockets need not keep Node alive. Retain a real event-loop
  // handle before notifying the parent, including while it checks server SQL.
  // Wait for the parent's SIGKILL, cleaning up if IPC disconnects instead.
  // This timer never retries a command or changes the durable journal.
  const keepAlive = setInterval(() => undefined, 60000);
  process.once('disconnect', () => clearInterval(keepAlive));
  process.send({ event: 'durable', stage, calls });
}

process.once('message', async (message) => {
  const { mode, stage, path, server, legacyVersion, legacyValue } = message;
  try {
    const read = () => {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
      }
    };
    const write = (value) => {
      writeFileSync(`${path}.next`, JSON.stringify(value), {
        mode: 0o600,
        flush: true,
      });
      renameSync(`${path}.next`, path);
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
    const fixture = message.fixture ?? discussionProcessFixture(),
      origin = message.origin ?? 'https://discussion-process.invalid',
      actor = fixture.actor;
    const sessions = new SessionStore();
    const credentials = message.credentials ?? {
      accountId: actor,
      sessionId: 'synthetic-session',
      accessToken: 'synthetic-process-access',
      refreshToken: 'synthetic-process-refresh',
      expiresAt: 9999999999999,
      refreshExpiresAt: 99999999999999,
    };
    sessions.completeLogin(sessions.beginLogin(), credentials);
    const store = new PendingRatingDiscussionMediaStore(storage, origin);
    if (mode === 'legacy') {
      storage.set(
        `whaleu.ratings.pending.v${legacyVersion}:${origin}:${actor}`,
        legacyValue ?? { corrupt: true },
      );
      const bytes = readFileSync(path, 'utf8');
      assert.throws(() => store.start(fixture.initial));
      assert.throws(() => store.opaqueRecovery(actor));
      assert.equal(readFileSync(path, 'utf8'), bytes);
      process.send({ event: 'recovered', stage });
      process.disconnect();
      return;
    }
    // The actual ApiClient/gateway issue the fixed HTTPS wire paths. Only the
    // test transport maps them to the parent-owned loopback server, reconnecting
    // after every OS-process restart. No process-local server DTO cache exists.
    const calls = [];
    const transport = {
      send: async (request) => {
        assert.ok(request.url.startsWith(origin + '/'));
        assert.equal(
          request.headers.Authorization,
          `Bearer ${credentials.accessToken}`,
        );
        const url = new URL(request.url);
        calls.push({ method: request.method, path: url.pathname + url.search });
        const response = await fetch(`${server}${url.pathname}${url.search}`, {
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
    const gateway = new HttpRatingDiscussionMediaGateway(
      new ApiClient(origin, transport, sessions, {
        refresh: async () => {
          throw Error('Unexpected authentication refresh');
        },
      }),
      sessions,
    );
    const nativePending =
      stage === 'native-completion-pending' && mode === 'write';
    const transfer = nativePending
      ? {
          settled: () => false,
          clearSession: () => undefined,
          localFiles: {},
          pick: () => {
            throw Error('No reupload');
          },
          inspect: () => {
            throw Error('No reupload');
          },
          remove: async () => undefined,
        }
      : undefined;
    // Native window requires identity-shared registry; no IO is admitted by
    // this boundary-only completion capability.
    let controller, editorView;
    if (nativePending) {
      const { MediaLocalFiles } = require('../../src/media/local-files.ts');
      transfer.localFiles = new MediaLocalFiles({
        unlink: async () => undefined,
        stat: async () => 0,
        image: async () => ({ width: 1, height: 1, type: 'png' }),
        readError: async () => null,
      });
    }
    controller = new RatingDiscussionMediaController(
      sessions,
      store,
      gateway,
      transfer,
      async () => {
        throw Error('Fresh request IDs forbidden during recovery');
      },
      (view) => {
        editorView = view;
      },
    );
    if (mode === 'write' || mode === 'commit-and-stop') {
      const original = store.start(fixture.initial);
      if (mode === 'commit-and-stop' || stage !== 'batch-persisted') {
        const value =
          mode !== 'commit-and-stop' && stage === 'prepare-unknown'
            ? {
                ...fixture.sealed,
                members: fixture.sealed.members.map((m) => ({
                  ...m,
                  state: 'pending',
                  assetId: null,
                  manifestDigest: null,
                })),
                sealedPlanDigest: null,
              }
            : fixture.sealed;
        store.update(original, value);
      }
      if (
        mode === 'commit-and-stop' ||
        [
          'command-frozen',
          'applied-before-receipt',
          'native-completion-pending',
          'opaque-account-switch',
          'opaque-partial-scrub',
          'opaque-both-scrub-failed',
        ].includes(stage)
      )
        store.freezeCommand(actor, fixture.intent);
      if (mode === 'commit-and-stop') {
        // Real native gateway prepare/commit reaches the original API owner.
        // Deliberately lose its applied response before the durable journal write.
        const receipt = await gateway.command(
          fixture.intent,
          new Cancellation(),
        );
        assert.equal(receipt.outcome, 'applied');
        assert.equal(store.load(actor).command.receipt, null);
        durableCheckpoint(stage, calls);
        return;
      }
      if (stage === 'native-completion-pending') {
        await controller.recover();
        assert.equal(store.load(actor).command.receipt.outcome, 'applied');
        assert.equal(Object.keys(read()).length, 2);
      }
      if (
        stage === 'opaque-account-switch' ||
        stage === 'opaque-partial-scrub' ||
        stage === 'opaque-both-scrub-failed'
      ) {
        if (stage === 'opaque-partial-scrub') {
          const set = storage.set;
          storage.set = (key, value) => {
            if (value?.phase === 'batch-opaque')
              throw Error('synthetic second-key write failure');
            set(key, value);
          };
        }
        if (stage === 'opaque-both-scrub-failed') {
          const set = storage.set;
          storage.set = (key, value) => {
            if (
              value?.phase === 'batch-opaque' ||
              value?.phase === 'command-opaque'
            )
              throw Error('synthetic both scrub writes failed');
            set(key, value);
          };
        }
        sessions.logout();
        sessions.completeLogin(sessions.beginLogin(), {
          ...credentials,
          accountId: processId(999),
        });
        assert.equal(
          store.opaqueRecovery(actor).command.phase,
          'command-opaque',
        );
        if (stage === 'opaque-account-switch')
          assert.equal(
            /"body"|"context"|"token"|localSrc|filePath|grantId/.test(
              JSON.stringify(read()),
            ),
            false,
          );
        assert.deepEqual(store.opaqueRecovery(processId(999)), {
          batch: null,
          command: null,
        });
        if (stage === 'opaque-both-scrub-failed') {
          assert.ok(
            Object.values(read()).some(
              (value) => value.phase === 'command' && value.intent,
            ),
          );
          assert.equal(store.isOpaque(actor), true);
          assert.throws(() => store.load(actor));
        }
      }
      durableCheckpoint(stage, calls);
      return; // Parent observes and SIGKILLs.
    }
    if (message.blockScrubWrites)
      storage.set = () => {
        throw Error('synthetic cold storage writes denied');
      };
    await controller.recover(message.action ?? 'receipt');
    if (message.requireOpaque) {
      assert.equal(store.isOpaque(actor), true);
      assert.throws(() => store.load(actor));
      assert.deepEqual(editorView.selected, []);
      assert.equal(
        /"body"|"context"|"token"|"declaration"/.test(
          JSON.stringify(store.opaqueRecovery(actor)),
        ),
        false,
      );
    }
    if (
      message.expectedSettled ??
      (stage === 'applied-before-receipt' ||
        stage === 'native-completion-pending')
    )
      assert.equal(Object.keys(read()).length, 0);
    else {
      assert.ok(Object.keys(read()).length > 0);
      if (message.cancelAfterRecovery !== false) {
        await controller.recover('cancel');
        assert.equal(Object.keys(read()).length, 0);
      }
    }
    assert.equal(
      /filePath|localSrc|grantId/.test(JSON.stringify(read())),
      false,
    );
    controller.dispose();
    process.send({
      event: 'recovered',
      stage,
      retainedKeys: Object.keys(read()).length,
      calls,
    });
    process.disconnect();
  } catch (error) {
    process.send({ event: 'error', message: String(error?.stack ?? error) });
    process.disconnect();
  }
});
