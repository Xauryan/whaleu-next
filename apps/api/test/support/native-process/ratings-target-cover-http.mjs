/** Real native gateway + journal11 in an independent process. Only the HTTP
 * origin is bridged to the disposable loopback AppModule. No mocked receipt.
 * Killing this client says nothing about a server/provider writer retiring. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runCoveredInteractions } from './ratings-target-cover-interactions.mjs';
const require = createRequire(import.meta.url);
const { SessionStore } = require('../../../../wechat/src/auth/session.ts');
const { ApiClient } = require('../../../../wechat/src/api/client.ts');
const {
  Cancellation,
} = require('../../../../wechat/src/platform/contracts.ts');
const {
  PendingRatingStore,
} = require('../../../../wechat/src/ratings/pending.ts');
const {
  HttpRatingTargetCoverGateway,
} = require('../../../../wechat/src/ratings/target-cover-gateway.ts');
const {
  HttpRatingCoverMediaGateway,
} = require('../../../../wechat/src/ratings/target-cover-media-gateway.ts');
const {
  runRatingCommand,
  settleRatingCommand,
} = require('../../../../wechat/src/ratings/commands.ts');
const origin = 'https://ratings-cover-native-process.invalid';
const send = (message) =>
  new Promise((resolve) => process.send(message, resolve));
process.once(
  'message',
  async ({
    mode,
    credentials,
    journalPath,
    port,
    intent,
    upload,
    targetId,
  }) => {
    try {
      const read = () => {
        try {
          return JSON.parse(readFileSync(journalPath, 'utf8'));
        } catch (error) {
          if (error.code === 'ENOENT') return {};
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
      sessions.completeLogin(sessions.beginLogin(), credentials);
      const pending = new PendingRatingStore(storage, origin),
        actor = credentials.accountId,
        calls = [],
        receipts = [],
        deletions = [];
      const api = new ApiClient(
        origin,
        {
          async send(input) {
            const url = new URL(input.url);
            assert.equal(url.origin, origin);
            assert.match(
              url.pathname,
              mode === 'interactions'
                ? /^\/v(?:1|2|3)\/(?:ratings|media)\//
                : /^\/v3\/(ratings\/target-cover|media\/ratings-target)\//,
            );
            calls.push({ method: input.method, path: url.pathname });
            const abort = new AbortController(),
              off = input.cancellation?.subscribe(() => abort.abort());
            try {
              if (
                mode === 'interactions' &&
                input.method === 'POST' &&
                ['create_comment_scoped', 'create_reply_scoped'].includes(
                  input.body?.operation,
                )
              ) {
                await new Promise((resolve, reject) => {
                  const requestId = input.body.payload.clientRequestId;
                  const receive = (message) => {
                    if (
                      message?.event !== 'review-ready' ||
                      message.requestId !== requestId
                    )
                      return;
                    process.removeListener('message', receive);
                    if (message.error) reject(new Error(message.error));
                    else resolve();
                  };
                  process.on('message', receive);
                  void send({ event: 'review-needed', intent: input.body });
                });
              }
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
                mode === 'interactions' &&
                response.status === 200 &&
                body.outcome
              ) {
                if (body.protocolVersion === 2) receipts.push(body);
                if (input.method === 'DELETE') deletions.push(body);
              }
              if (
                mode === 'commit-and-stop' &&
                response.status === 200 &&
                url.pathname === '/v3/ratings/target-cover/commit'
              ) {
                await send({ event: 'server-committed', receipt: body, calls });
                return await new Promise(() => {}); // Supervisor verifies PG, then actual SIGKILL.
              }
              return {
                status: response.status,
                headers: Object.fromEntries(response.headers),
                body,
              };
            } finally {
              off?.();
            }
          },
        },
        sessions,
        {
          async refresh() {
            throw new Error('Fresh IPC credentials must not need refresh');
          },
        },
      );
      const runtime = {
        sessions,
        pendingRatings: pending,
        ratingTargetCover: new HttpRatingTargetCoverGateway(api, sessions),
        ratingCoverMedia: new HttpRatingCoverMediaGateway(api),
      };
      if (mode === 'interactions') {
        const ids = await runCoveredInteractions(
          runtime,
          api,
          targetId,
          receipts,
          deletions,
        );
        await send({ event: 'interactions-complete', receipts, calls, ...ids });
        process.disconnect();
        return;
      }
      if (mode === 'foreign') {
        assert.equal(pending.load(actor), null);
        await send({ event: 'foreign-isolated', calls });
        process.disconnect();
        return;
      }
      if (mode === 'commit-and-stop' || mode === 'freeze-and-stop') {
        if (upload) {
          const initial = pending.freezeCoverUpload({
            ...upload,
            scope: null,
            status: null,
          });
          const ready = pending.updateCoverUpload(initial, upload);
          pending.sealCoverUpload(ready, intent);
        } else pending.freeze({ version: 11, accountId: actor, intent });
        if (mode === 'freeze-and-stop') {
          await send({ event: 'journal-frozen', calls });
          return;
        }
      }
      const attempt = pending.load(actor);
      assert.equal(attempt?.version, 11);
      const receipt = await runRatingCommand(
        runtime,
        attempt,
        new Cancellation(),
        mode !== 'recover',
      );
      const settled = settleRatingCommand(runtime, attempt, receipt);
      assert.equal(pending.load(actor), null);
      assert.equal(
        calls[0]?.path,
        `/v3/ratings/target-cover/receipts/${attempt.intent.payload.clientRequestId}`,
      );
      if (mode === 'recover')
        assert.ok(
          calls.every(
            (call) =>
              ![
                '/v3/ratings/target-cover/prepare',
                '/v3/ratings/target-cover/commit',
              ].includes(call.path),
          ),
        );
      await send({
        event: 'recovered',
        receipt: settled,
        calls,
        remaining: pending.load(actor),
      });
      process.disconnect();
    } catch (error) {
      await send({ event: 'failure', message: String(error?.stack ?? error) });
      process.disconnect();
      process.exitCode = 1;
    }
  },
);
