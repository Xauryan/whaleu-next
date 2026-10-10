/** Actual separate native process and flushed disk journal. The server, owner
 * proofs and decoder are not replaced. Credentials arrive only over IPC. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SessionStore } = require('../../../../wechat/src/auth/session.ts');
const {
  PendingBatchStore,
} = require('../../../../wechat/src/media/batch-pending.ts');
const {
  PendingAttemptStore,
} = require('../../../../wechat/src/community/pending-attempt.ts');
const {
  createMediaBatchRuntime,
  observeBatch,
} = require('../../../../wechat/src/media/batch-runtime.ts');
const {
  HttpBatchGateway,
} = require('../../../../wechat/src/media/batch-gateway.ts');
const { ApiClient } = require('../../../../wechat/src/api/client.ts');
const {
  decodeReceipt,
} = require('../../../../wechat/src/community/contract.ts');
const {
  Cancellation,
} = require('../../../../wechat/src/platform/contracts.ts');
const { systemClock } = require('../../../../wechat/src/platform/clock.ts');
const origin = 'https://native-batch-process.invalid';
let controller;
process.on('message', async (message) => {
  try {
    assert.equal(message.command, 'start');
    const { credentials, journalPath, port, mode } = message;
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
      get: (key) => read()[key],
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
    const pending = new PendingBatchStore(storage, origin),
      publicationPending = new PendingAttemptStore(storage, origin);
    const transport = {
      async send(input) {
        const url = new URL(input.url);
        assert.equal(url.origin, origin);
        assert.ok(
          url.pathname.startsWith('/v3/media/') ||
            url.pathname.startsWith('/v1/me/community/requests/'),
        );
        const abort = new AbortController(),
          stop = input.cancellation?.subscribe(() => abort.abort());
        try {
          const response = await fetch(
            `http://127.0.0.1:${port}${url.pathname}${url.search}`,
            {
              method: input.method,
              headers: input.headers,
              redirect: 'error',
              signal: abort.signal,
              ...(input.body === undefined
                ? {}
                : { body: JSON.stringify(input.body) }),
            },
          );
          const body = await response.json();
          if (
            mode === 'seal-unknown' &&
            input.method === 'POST' &&
            url.pathname.endsWith('/seal') &&
            response.status === 200
          ) {
            process.send({ event: 'seal-committed', batchId: body.batchId });
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
    const auth = {
      async refresh() {
        throw new Error('Unexpected refresh');
      },
    };
    const api = new ApiClient(origin, transport, sessions, auth),
      gateway = new HttpBatchGateway(origin, transport, sessions, auth);
    const community = {
      receipt: (id, cancellation) =>
        api.request(
          {
            method: 'GET',
            path: `/v1/me/community/requests/${id}`,
            authentication: 'required',
            authReplay: 'once',
            successStatus: 200,
            decode: decodeReceipt,
          },
          { cancellation },
        ),
    };
    const runtime = createMediaBatchRuntime({
      sessions,
      pending,
      publicationPending,
      community,
      clock: systemClock,
      newRequestId: async () => randomUUID(),
      gateway,
    });
    if (mode === 'reserved-before-body' || mode === 'seal-unknown') {
      const status = message.status;
      let record = pending.freeze(
        credentials.accountId,
        status.batchIdentity,
        Date.now(),
      );
      record = observeBatch(pending, record, status, Date.now());
      assert.equal(record.members.length, message.body.imageAssetIds.length);
      const attempt = {
        version: 1,
        accountId: credentials.accountId,
        operation: 'publish_post',
        payload: message.body,
      };
      runtime.reservePublication(attempt);
      if (mode === 'reserved-before-body') {
        assert.equal(publicationPending.load(credentials.accountId), null);
        process.send({
          event: 'reserved',
          batchRequestId: record.batchRequestId,
        });
        await new Promise(() => {});
      } else {
        publicationPending.freeze(attempt);
        await runtime.beforePublication(attempt, new Cancellation());
        throw new Error('Seal response should have been withheld');
      }
    } else {
      assert.equal(mode, 'resume-and-explicitly-cancel');
      controller = runtime.create(() => {});
      const before = pending.load(credentials.accountId);
      assert.ok(before?.publication);
      // A receipt miss alone is deliberately not a recovery success or cleanup.
      try {
        await controller.start();
      } catch {
        /* Explicit user cancel follows. */
      }
      assert.ok(
        pending.load(credentials.accountId),
        'Unknown receipt retained the WAL',
      );
      await controller.cancelOriginal();
      assert.equal(pending.load(credentials.accountId), null);
      assert.equal(publicationPending.load(credentials.accountId), null);
      process.send(
        {
          event: 'cancelled',
          batchRequestId: before.batchRequestId,
          reference: before.publication.reference,
        },
        () => process.exit(0),
      );
    }
  } catch (error) {
    process.send?.(
      {
        event: 'failure',
        name: error?.name,
        message: error?.message,
        stack: error?.stack,
      },
      () => process.exit(1),
    );
  }
});
