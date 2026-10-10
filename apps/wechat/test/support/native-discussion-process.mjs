/** Separate native-process v4 crash harness. Real HTTP, strict native decoders,
 * flushed disk journals, and parent-owned SIGKILL. Never imports production DI.
 * All credentials arrive over ephemeral IPC and are excluded from the journal. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SessionStore } = require('../../src/auth/session.ts');
const { ClientError } = require('../../src/api/errors.ts');
const { PendingBatchStore } = require('../../src/media/batch-pending.ts');
const {
  PendingAttemptStore,
} = require('../../src/community/pending-attempt.ts');
const {
  createMediaBatchRuntime,
  observeBatch,
} = require('../../src/media/batch-runtime.ts');
const {
  HttpDiscussionBatchGateway,
} = require('../../src/media/discussion-batch-gateway.ts');
const {
  batchPublicationReference,
} = require('../../src/media/batch-publication.ts');
const { ApiClient } = require('../../src/api/client.ts');
const { decodeReceipt } = require('../../src/community/contract.ts');
const { Cancellation } = require('../../src/platform/contracts.ts');
const { systemClock } = require('../../src/platform/clock.ts');
const origin = 'https://native-discussion-process.invalid';
const cuts = new Set([
  'reserve',
  'body',
  'link',
  'seal',
  'dispatch',
  'receipt',
  'settlement',
  'community-clear',
  'media-clear',
]);
let started = false;
process.on('message', async (message) => {
  let reached = null;
  let phase = 'startup';
  const send = (value) =>
    new Promise((resolve, reject) =>
      process.send(value, (error) => (error ? reject(error) : resolve())),
    );
  const park = async (cut) => {
    await send({ event: 'checkpoint', cut });
    await new Promise(() => {});
  };
  try {
    assert.equal(started, false);
    started = true;
    assert.equal(message.command, 'start');
    const { credentials, journalPath, port, mode, cut = null } = message;
    assert.ok(
      ['publish', 'resume', 'resume-and-explicitly-cancel'].includes(mode),
    );
    assert.ok(cut === null || cuts.has(cut));
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
    let armed = false;
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
    const interrupt = (point) => {
      if (armed && cut === point && !reached) {
        reached = point;
        throw new Error(`Durable ${point} checkpoint`);
      }
    };
    const storage = {
      get: (key) => read()[key],
      set(key, value) {
        const saved = read();
        saved[key] = value;
        write(saved);
        if (key.startsWith('whaleu.community.pending.v1:')) interrupt('body');
        if (key.startsWith('whaleu.media.batch.pending.v4:')) {
          const publication = value.publication;
          if (publication?.linkState === 'reserved') interrupt('reserve');
          if (
            publication?.linkState === 'linked' &&
            publication.dispatchState === 'not_dispatched'
          )
            interrupt('link');
          if (publication?.linkState === 'settlement_verified')
            interrupt('settlement');
        }
      },
      remove(key) {
        const saved = read();
        delete saved[key];
        write(saved);
        if (key.startsWith('whaleu.community.pending.v1:'))
          interrupt('community-clear');
        if (key.startsWith('whaleu.media.batch.pending.v4:'))
          interrupt('media-clear');
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
        phase = url.pathname.endsWith('/seal')
          ? 'seal'
          : url.pathname.includes('/batches/requests/')
            ? 'batch-history'
            : url.pathname.startsWith('/v1/me/community/requests/')
              ? 'publication-history'
              : url.pathname.startsWith('/v1/community/')
                ? 'publication'
                : 'media-metadata';
        const publicationRoute =
          /^\/v1\/community\/(?:posts\/[a-f0-9-]+\/comments|comments\/[a-f0-9-]+\/replies)$/.test(
            url.pathname,
          );
        assert.ok(
          url.pathname.startsWith('/v4/media/') ||
            url.pathname.startsWith('/v1/me/community/requests/') ||
            publicationRoute,
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
            armed &&
            cut === 'seal' &&
            input.method === 'POST' &&
            url.pathname.endsWith('/seal') &&
            response.status === 200
          )
            await park('seal');
          if (
            armed &&
            cut === 'dispatch' &&
            input.method === 'POST' &&
            publicationRoute &&
            response.status === 201
          )
            await park('dispatch');
          if (
            armed &&
            cut === 'receipt' &&
            input.method === 'GET' &&
            url.pathname.startsWith('/v1/me/community/requests/') &&
            response.status === 200
          )
            await park('receipt');
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
      gateway = new HttpDiscussionBatchGateway(
        origin,
        transport,
        sessions,
        auth,
      );
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
      discussionGateway: gateway,
    });
    const actor = credentials.accountId;
    const dispatch = async (attempt) => {
      await runtime.beforePublication(attempt, new Cancellation());
      const path =
        attempt.operation === 'publish_comment'
          ? `/v1/community/posts/${attempt.postId}/comments`
          : `/v1/community/comments/${attempt.rootCommentId}/replies`;
      return api.request(
        {
          method: 'POST',
          path,
          authentication: 'required',
          authReplay: 'never',
          successStatus: 201,
          decode: decodeReceipt,
        },
        { body: attempt.payload, cancellation: new Cancellation() },
      );
    };
    const settle = async (attempt, receipt) => {
      if (cut === 'receipt') await park('receipt');
      await runtime.verifyReceipt(attempt, receipt, new Cancellation());
      publicationPending.settle(attempt, receipt);
      runtime.publicationSettled(attempt);
      assert.equal(pending.load(actor), null);
      assert.equal(publicationPending.load(actor), null);
      await send({
        event: 'settled',
        receipt,
        reference: batchPublicationReference(attempt),
      });
    };
    if (mode === 'publish') {
      const attempt = message.attempt,
        status = message.status;
      assert.ok(
        attempt?.operation === 'publish_comment' ||
          attempt?.operation === 'publish_reply',
      );
      assert.equal(attempt.accountId, actor);
      assert.equal(status.version, 4);
      assert.equal(pending.load(actor), null);
      assert.equal(publicationPending.load(actor), null);
      let record = pending.freeze(actor, status.batchIdentity, Date.now());
      record = observeBatch(pending, record, status, Date.now());
      assert.equal(record.members.length, attempt.payload.imageAssetIds.length);
      armed = true;
      runtime.reservePublication(attempt);
      publicationPending.freeze(attempt);
      await settle(attempt, await dispatch(attempt));
    } else {
      armed = true;
      const record = pending.load(actor),
        attempt = publicationPending.load(actor);
      if (mode === 'resume-and-explicitly-cancel') {
        assert.ok(record?.publication);
        const controller = runtime.create(
          () => {},
          record.publication.reference.operation,
        );
        try {
          await controller.start();
        } catch {
          /* Explicit cancellation is an IPC instruction. */
        }
        await controller.cancelOriginal();
        controller.dispose();
        assert.equal(pending.load(actor), null);
        assert.equal(publicationPending.load(actor), null);
        await send({
          event: 'cancelled',
          reference: record.publication.reference,
        });
      } else if (attempt) {
        let receipt;
        try {
          receipt = await community.receipt(
            attempt.payload.clientRequestId,
            new Cancellation(),
          );
        } catch (error) {
          if (
            !(error instanceof ClientError) ||
            error.details.serverCode !== 'REQUEST_NOT_FOUND'
          )
            throw error;
          receipt = await dispatch(attempt);
        }
        await settle(attempt, receipt);
      } else if (record?.publication) {
        // Never recreate missing body bytes from the caller's fresh input.
        if (record.publication.linkState === 'reserved') {
          await send({
            event: 'requires-explicit-cancel',
            reference: record.publication.reference,
          });
        } else {
          const controller = runtime.create(
            () => {},
            record.publication.reference.operation,
          );
          await controller.start();
          controller.dispose();
          assert.equal(pending.load(actor), null);
          await send({
            event: 'settled-without-body',
            reference: record.publication.reference,
          });
        }
      } else {
        assert.equal(record, null);
        assert.ok(message.attempt?.accountId === actor);
        const receipt = await community.receipt(
          message.attempt.payload.clientRequestId,
          new Cancellation(),
        );
        assert.equal(receipt.operation, message.attempt.operation);
        await send({ event: 'already-cleared', receipt });
      }
    }
    process.exit(0);
  } catch (error) {
    if (reached) {
      await park(reached);
      return;
    }
    await send({
      event: 'failure',
      phase,
      kind: error instanceof ClientError ? error.kind : 'internal',
      httpStatus:
        error instanceof ClientError
          ? (error.details.httpStatus ?? null)
          : null,
      applicationCode:
        error instanceof ClientError &&
        /^[A-Z_]{1,80}$/.test(error.details.serverCode ?? '')
          ? error.details.serverCode
          : null,
    });
    process.exit(1);
  }
});
