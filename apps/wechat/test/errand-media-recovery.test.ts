import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { responseError } from '../src/api/envelopes';
import { createErrandMediaRuntime } from '../src/errands/media-runtime';
import type { ErrandMediaUploadView } from '../src/errands/media-runtime';
import {
  ERRAND_MEDIA_PROTOCOL,
  errandMediaPrepareHash,
  decodeErrandMediaPrepare,
} from '../src/errands/media-contract';
import { MediaLocalFiles } from '../src/media/local-files';
import {
  FakeClock,
  MemoryStorage,
  ScriptedTransport,
  flush,
  response,
  signedIn,
} from './helpers';
import { ReadFiles } from './support/media-read-fixtures';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const target = {
  draftId: id(1),
  targetRegionId: id(20),
  slot: 'public0' as const,
  draftRevision: 1,
};
const quotaBody = {
  error: { code: 'MEDIA_RATE_LIMITED', message: 'not exposed' },
};

function harness() {
  const clock = new FakeClock(),
    sessions = signedIn(id(2)),
    storage = new MemoryStorage(),
    transport = new ScriptedTransport();
  let digest = 'a'.repeat(64),
    bytes = 100,
    mime: 'png' | 'jpeg' = 'png',
    keys = 0,
    picks = 0;
  const files = Object.assign(new ReadFiles(), { digest: async () => digest }),
    registry = new MediaLocalFiles(files);
  const views: ErrandMediaUploadView[] = [];
  const runtime = createErrandMediaRuntime({
    api: new ApiClient('https://errand.invalid', transport, sessions, {
      refresh: async () => sessions.snapshot(),
    }),
    sessions,
    storage,
    origin: 'https://errand.invalid',
    clock,
    newRequestId: async () => {
      keys++;
      return id(10);
    },
    wx: {
      chooseMedia(options) {
        const path = `wxfile://tmp/errand-recovery-${++picks}`;
        files.put(path, {
          size: bytes,
          info: { width: 80, height: 60, type: mime },
        });
        options.success({
          tempFiles: [{ tempFilePath: path, size: bytes, fileType: 'image' }],
        });
        options.complete();
      },
    },
    files,
    registry,
    auth: { refresh: async () => sessions.snapshot() },
  });
  const uploader = runtime.createUploader((view) => views.push(view));
  const unrecorded = () =>
    transport.reply({
      protocol: ERRAND_MEDIA_PROTOCOL,
      requestId: id(10),
      serverNow: 1000,
      state: 'not_recorded',
      requestHash: null,
    });
  return {
    runtime,
    uploader,
    transport,
    files,
    views,
    unrecorded,
    keys: () => keys,
    picks: () => picks,
    change: (part: 'mime' | 'bytes' | 'sha256') => {
      if (part === 'mime') mime = 'jpeg';
      else if (part === 'bytes') bytes = 101;
      else digest = 'b'.repeat(64);
    },
  };
}

test('429 retry metadata accepts only one bounded delta-seconds header on matching errors', () => {
  assert.equal(
    responseError(response(quotaBody, 429, { 'Retry-After': '37' }))?.details
      .retryAfterSeconds,
    37,
  );
  assert.equal(
    responseError(response(quotaBody, 429, { 'retry-after': '86400' }))?.details
      .retryAfterSeconds,
    86400,
  );
  for (const value of [
    '0',
    '-1',
    '1.2',
    '86401',
    '00037',
    'Wed, 21 Oct 2026 07:28:00 GMT',
    'private',
  ])
    assert.equal(
      responseError(response(quotaBody, 429, { 'retry-after': value }))?.details
        .retryAfterSeconds,
      undefined,
    );
  assert.equal(
    responseError(
      response(quotaBody, 429, { 'retry-after': '37', 'Retry-After': '38' }),
    )?.details.retryAfterSeconds,
    undefined,
  );
  assert.equal(
    responseError(response(quotaBody, 503, { 'retry-after': '37' }))?.kind,
    'protocol',
  );
  assert.equal(
    responseError(response(quotaBody, 503, { 'retry-after': '37' }))?.details
      .retryAfterSeconds,
    undefined,
  );
});

test('Minute and daily quota retries show exact server wait and explicitly recover the same declaration and key', async () => {
  for (const retry of [37, 7200]) {
    const h = harness();
    try {
      h.transport.reply(quotaBody, 429, { 'retry-after': String(retry) });
      assert.equal(await h.uploader.pick(target), null);
      await flush();
      assert.match(
        h.views[h.views.length - 1]!.message,
        new RegExp(`最早 ${retry} 秒`),
      );
      assert.equal(h.keys(), 1);
      assert.equal(h.runtime.pendingTargets().length, 1);
      const original = decodeErrandMediaPrepare(h.transport.requests[0]!.body);
      h.unrecorded();
      h.transport.steps.push(async (request) => {
        assert.deepEqual(request.body, original);
        return response({
          protocol: ERRAND_MEDIA_PROTOCOL,
          intentId: id(11),
          requestId: original.clientRequestId,
          requestHash: errandMediaPrepareHash(id(2), original),
          serverNow: 1000,
          status: 'ready_unbound',
          manifestDigest: 'b'.repeat(64),
          assetId: id(12),
          bindBefore: 60000,
          mediaProof: 'current',
        });
      });
      assert.deepEqual(await h.uploader.recover(target), {
        assetId: id(12),
        manifestDigest: 'b'.repeat(64),
      });
      await flush();
      assert.equal(h.keys(), 1);
      assert.equal(h.picks(), 2);
      assert.equal(h.transport.requests.length, 3);
      assert.equal(h.files.deleted.length, 2);
    } finally {
      h.runtime.hide();
    }
  }
});

test('Recovering an unrecorded errand image rejects different MIME, byte length or digest without replacing its key', async () => {
  for (const part of ['mime', 'bytes', 'sha256'] as const) {
    const h = harness();
    try {
      h.transport.reply(quotaBody, 429, { 'retry-after': '37' });
      await h.uploader.pick(target);
      await flush();
      h.change(part);
      h.unrecorded();
      assert.equal(await h.uploader.recover(target), null);
      await flush();
      assert.match(h.views[h.views.length - 1]!.message, /与原上传不一致/);
      assert.equal(h.keys(), 1);
      assert.equal(h.picks(), 2);
      assert.equal(h.transport.requests.length, 2);
      assert.equal(h.runtime.pendingTargets().length, 1);
      assert.equal(h.files.deleted.length, 2);
    } finally {
      h.runtime.hide();
    }
  }
});
