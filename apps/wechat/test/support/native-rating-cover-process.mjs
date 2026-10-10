/** Restart-only native journal harness. No production DI, network or disk secrets. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SessionStore } = require('../../src/auth/session.ts');
const { PendingRatingStore } = require('../../src/ratings/pending.ts');
const {
  RatingTargetCoverCommandController,
} = require('../../src/ratings/target-cover-controller.ts');
const { ClientError } = require('../../src/api/errors.ts');
process.once(
  'message',
  async ({
    path,
    mode,
    credentials,
    upload,
    intent,
    receipt,
    stage,
    legacy,
  }) => {
    try {
      const read = () => {
        try {
          return JSON.parse(readFileSync(path, 'utf8'));
        } catch (e) {
          if (e.code === 'ENOENT') return {};
          throw e;
        }
      };
      const write = (data) =>
        writeFileSync(path, JSON.stringify(data), { mode: 0o600, flush: true });
      const storage = {
        get: (key) => read()[key],
        set: (key, value) => {
          const data = read();
          data[key] = value;
          write(data);
        },
        remove: (key) => {
          const data = read();
          delete data[key];
          write(data);
        },
      };
      const sessions = new SessionStore();
      sessions.completeLogin(sessions.beginLogin(), credentials);
      const store = new PendingRatingStore(storage, 'process-cover'),
        actor = credentials.accountId;
      if (mode === 'conflict') {
        storage.set(
          `whaleu.ratings.pending.v${legacy.version}:process-cover:${actor}`,
          legacy.value,
        );
        const bytes = readFileSync(path, 'utf8');
        assert.throws(() =>
          store.freeze({ version: 11, accountId: actor, intent }),
        );
        assert.equal(readFileSync(path, 'utf8'), bytes);
        process.send({ event: 'recovered', stage });
        process.disconnect();
        return;
      }
      if (mode === 'write') {
        if (stage === 'scope-unknown' || stage === 'ready') {
          const original = store.freezeCoverUpload({
            ...upload,
            scope: null,
            status: null,
          });
          if (stage === 'ready') store.updateCoverUpload(original, upload);
        } else store.freeze({ version: 11, accountId: actor, intent });
        if (stage === 'receipt-written') storage.set('server-receipt', receipt);
        process.send({ event: 'durable', stage });
        return; // Parent kills before graceful process teardown.
      }
      const before = readFileSync(path, 'utf8');
      if (stage === 'scope-unknown' || stage === 'ready') {
        const restored = store.loadCoverUpload(actor);
        assert.equal(
          restored.scopeInput.clientRequestId,
          upload.scopeInput.clientRequestId,
        );
        assert.equal(
          restored.status?.status ?? null,
          stage === 'ready' ? 'ready_unbound' : null,
        );
        assert.throws(() =>
          store.settleCoverUploadCancellation(restored, {
            protocol: 'ratings-target-media-v1',
            requestId: upload.scopeInput.clientRequestId,
            serverNow: 1000,
            state: 'not_recorded',
            requestHash: null,
          }),
        );
        sessions.logout();
        sessions.completeLogin(sessions.beginLogin(), credentials);
        assert.deepEqual(store.loadCoverUpload(actor), restored);
        assert.equal(readFileSync(path, 'utf8'), before);
      } else {
        const calls = [];
        const missing = async () => {
          throw new ClientError('business', 'Unknown original receipt', {
            serverCode: 'REQUEST_NOT_FOUND',
          });
        };
        const gateway = {
          receipt: async () => {
            calls.push('receipt');
            return storage.get('server-receipt') ?? missing();
          },
          command: async () => {
            calls.push('command');
            return missing();
          },
          cancel: async () => {
            throw new Error('Implicit cancel forbidden');
          },
        };
        const controller = new RatingTargetCoverCommandController(
          sessions,
          store,
          gateway,
          () => undefined,
        );
        await controller.recover();
        assert.deepEqual(calls, ['receipt']);
        if (stage === 'receipt-written') assert.equal(store.load(actor), null);
        else {
          assert.equal(readFileSync(path, 'utf8'), before);
          assert.equal(
            store.load(actor).intent.payload.clientRequestId,
            intent.payload.clientRequestId,
          );
        }
        controller.dispose();
      }
      assert.equal(
        /filePath|localSrc|uploadToken|grantId/.test(JSON.stringify(read())),
        false,
      );
      process.send({ event: 'recovered', stage });
      process.disconnect();
    } catch (error) {
      process.send({ event: 'error', message: String(error?.stack ?? error) });
      process.disconnect();
    }
  },
);
