import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { MediaController } from '../src/media/controller';
import type {
  LocalMediaFile,
  MediaAttachment,
  MediaGateway,
  MediaIntentStatus,
  MediaPrepare,
  MediaSession,
  MediaTransfer,
} from '../src/media/contracts';
import { Cancellation } from '../src/platform/contracts';
import { unavailableMediaGateway } from '../src/media/gateway';
import { credentials, deferred, FakeClock, flush, signedIn } from './helpers';

async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await flush();
}

const intentId = '11111111-1111-4111-8111-111111111111';
const assetId = '22222222-2222-4222-8222-222222222222';
const bindingId = '33333333-3333-4333-8333-333333333333';
const target = {
  draftId: '44444444-4444-4444-8444-444444444444',
  spaceId: '55555555-5555-4555-8555-555555555555',
};

function harness() {
  const sessions = signedIn('a');
  const clock = new FakeClock();
  const calls: string[] = [];
  const prepares: MediaPrepare[] = [];
  const removed: string[] = [];
  const contexts: MediaSession[] = [];
  let progress: (percent: number) => void = () => undefined;
  const status = (
    state: 'prepared' | 'processing' | 'ready' = 'prepared',
  ): MediaIntentStatus =>
    state === 'ready'
      ? {
          intentId: intentId,
          expiresAt: 100_000,
          status: state,
          assetId: assetId,
        }
      : { intentId: intentId, expiresAt: 100_000, status: state };
  const gateway: MediaGateway = {
    async prepare(input, context) {
      context.current();
      prepares.push(input);
      calls.push('prepare');
      return status();
    },
    async status(id, context) {
      context.current();
      calls.push(`status:${id}`);
      return status('ready');
    },
    async grant(id, context) {
      context.current();
      calls.push('grant');
      return {
        intentId: id,
        generation: 1,
        expiresAt: 10_000,
        handle: 'opaque',
      };
    },
    async finalize(id, context) {
      context.current();
      calls.push(`finalize:${id}`);
      return status('processing');
    },
    async cancel(id, context) {
      context.current();
      calls.push(`cancel:${id}`);
    },
  };
  const transfer: MediaTransfer = {
    async pick(context) {
      context.current();
      return { localId: 'picked' };
    },
    async inspectLocal(_file, context) {
      context.current();
      return {
        bytes: 100,
        mime: 'image/png',
        width: 10,
        height: 10,
        frames: 1,
      };
    },
    async upload(_plan, _file, callback, context) {
      contexts.push(context);
      context.current();
      progress = callback;
      callback(100);
    },
    async downloadAuthenticated(_attachment, _variant, context) {
      context.current();
      return { localId: 'downloaded' };
    },
    async previewTemporary(file, context) {
      context.current();
      calls.push(`preview:${file.localId}`);
    },
    async removeTemporary(file) {
      removed.push(file.localId);
    },
    clearSession(ticket) {
      calls.push(`clear:${ticket.epoch}`);
    },
  };
  let key = 0;
  const controller = new MediaController(
    sessions,
    transfer,
    clock,
    () => `66666666-6666-4666-8666-${String(++key).padStart(12, '0')}`,
    gateway,
  );
  return {
    sessions,
    clock,
    calls,
    prepares,
    removed,
    contexts,
    status,
    gateway,
    transfer,
    controller,
    progress: (percent: number) => progress(percent),
  };
}
const attachment: MediaAttachment = {
  version: 1,
  kind: 'authenticated-media',
  assetId: assetId,
  bindingId: bindingId,
  variants: ['thumb-v1', 'display-v1'],
  width: 10,
  height: 10,
};

test('100% remains processing; only server ready unlocks asset; duplicate taps coalesce', async () => {
  const h = harness();
  await h.controller.select(target);
  const running = h.controller.start();
  assert.equal(h.controller.start(), running);
  await drain();
  assert.equal(h.controller.snapshot().status, 'processing');
  assert.equal(h.controller.snapshot().assetId, null);
  h.clock.advance(1000);
  await running;
  assert.equal(h.controller.snapshot().assetId, assetId);
  h.progress(50); // Late SDK callback must not move ready back to uploading.
  assert.equal(h.controller.snapshot().status, 'ready');
  h.controller.dispose();
});

test('lost finalize response reads same intent before retry and never reuploads ready asset', async () => {
  const h = harness();
  let uploads = 0;
  h.transfer.upload = async () => {
    uploads += 1;
  };
  h.gateway.finalize = async () => {
    throw new ClientError('timeout', 'Synthetic timeout');
  };
  await h.controller.select(target);
  await assert.rejects(h.controller.start());
  await h.controller.start();
  assert.equal(uploads, 1);
  assert.equal(h.prepares.length, 1);
  assert.ok(h.calls.includes(`status:${intentId}`));
  assert.equal(h.controller.snapshot().status, 'ready');
  h.controller.dispose();
});

test('prepare timeout reuses exact request and key; new selection gets a new key', async () => {
  const h = harness();
  h.gateway.prepare = async (input) => {
    h.prepares.push(input);
    throw new ClientError('timeout', 'Synthetic timeout');
  };
  await h.controller.select(target);
  await assert.rejects(h.controller.start());
  await assert.rejects(h.controller.start());
  assert.equal(h.prepares[0], h.prepares[1]);
  await h.controller.select(target);
  await assert.rejects(h.controller.start());
  assert.notEqual(
    h.prepares[0]?.clientRequestId,
    h.prepares[2]?.clientRequestId,
  );
  h.controller.dispose();
});

test('switching account cancels upload and ignores late progress and completion', async () => {
  const h = harness();
  const upload = deferred<void>();
  let progress: (percent: number) => void = () => undefined;
  h.transfer.upload = async (_plan, _file, callback, context, cancel) => {
    progress = callback;
    h.contexts.push(context);
    await upload.promise;
    assert.equal(cancel.isCancelled, true);
  };
  await h.controller.select(target);
  const running = h.controller.start();
  const rejected = assert.rejects(running);
  await drain();
  h.sessions.completeLogin(h.sessions.beginLogin(), credentials('b'));
  await rejected;
  progress(100);
  upload.resolve();
  await drain();
  assert.deepEqual(h.controller.snapshot(), {
    status: 'idle',
    progress: 0,
    assetId: null,
  });
  assert.ok(h.removed.includes('picked'));
  assert.ok(!h.calls.some((call) => call.startsWith('finalize:')));
  assert.throws(
    () => h.contexts[0]?.current(),
    (error: unknown) =>
      error instanceof ClientError && error.kind === 'stale-session',
  );
  h.controller.dispose();
});

test('same-account relogin invalidates epoch; refresh preserves work and returns latest auth revision', async () => {
  const h = harness();
  await h.controller.select(target);
  await h.controller.preview();
  const ticket = h.sessions.snapshot();
  h.sessions.rotate(ticket, credentials('a', 'rotated'));
  assert.equal(h.controller.snapshot().status, 'selected');
  const running = h.controller.start();
  const rejected = assert.rejects(running);
  await drain();
  assert.equal(h.contexts[0]?.current().revision, 1);
  h.sessions.completeLogin(
    h.sessions.beginLogin(),
    credentials('a', 'relogin'),
  );
  await rejected;
  assert.equal(h.controller.snapshot().status, 'idle');
  assert.equal(h.clock.timers, 0);
  h.controller.dispose();
});

test('late downloaded temporary file is removed and never previewed after account switch', async () => {
  const h = harness();
  const download = deferred<LocalMediaFile>();
  h.transfer.downloadAuthenticated = async () => download.promise;
  await h.controller.select(target);
  const preview = h.controller.preview(attachment);
  const rejected = assert.rejects(preview);
  h.sessions.completeLogin(h.sessions.beginLogin(), credentials('b'));
  await rejected;
  download.resolve({ localId: 'late_download' });
  await drain();
  assert.ok(h.removed.includes('late_download'));
  assert.ok(!h.calls.some((call) => call.startsWith('preview:')));
  h.controller.dispose();
});

test('late picker output and poll success cannot populate a replacement epoch', async () => {
  const h = harness();
  const picked = deferred<LocalMediaFile>();
  h.transfer.pick = async () => picked.promise;
  const selecting = h.controller.select(target);
  const rejected = assert.rejects(selecting);
  h.sessions.completeLogin(h.sessions.beginLogin(), credentials('b'));
  await rejected;
  picked.resolve({ localId: 'late_pick' });
  await drain();
  assert.ok(h.removed.includes('late_pick'));
  assert.equal(h.controller.snapshot().status, 'idle');
  h.controller.dispose();

  const p = harness();
  const poll = deferred<MediaIntentStatus>();
  p.gateway.status = async () => poll.promise;
  await p.controller.select(target);
  const running = p.controller.start();
  const rejectPoll = assert.rejects(running);
  await drain();
  p.clock.advance(1000);
  await drain();
  p.sessions.logout();
  await rejectPoll;
  poll.resolve(p.status('ready'));
  await drain();
  assert.equal(p.controller.snapshot().assetId, null);
  p.controller.dispose();
});

test('compression is reinspected, invalid byte limits fail closed, and hide removes temporary files', async () => {
  const h = harness();
  h.transfer.optionalCompress = async () => ({ localId: 'compressed' });
  h.transfer.inspectLocal = async (file) => {
    assert.equal(file.localId, 'compressed');
    return {
      bytes: 6 * 1024 * 1024,
      mime: 'image/png',
      width: 10,
      height: 10,
      frames: 1,
    };
  };
  await assert.rejects(h.controller.select(target, true));
  assert.equal(h.prepares.length, 0);
  assert.ok(h.removed.includes('picked'));
  assert.ok(h.removed.includes('compressed'));
  h.controller.hide();
  assert.equal(h.controller.snapshot().status, 'idle');
  h.controller.dispose();
});

test('explicit cancel stops polling, clears local state and cancels only the same intent', async () => {
  const h = harness();
  await h.controller.select(target);
  const running = h.controller.start();
  const rejected = assert.rejects(running);
  await drain();
  await h.controller.cancel();
  await rejected;
  assert.equal(h.clock.timers, 0);
  assert.ok(h.calls.includes(`cancel:${intentId}`));
  assert.equal(h.controller.snapshot().status, 'idle');
  h.controller.dispose();
});

test('default gateway remains unavailable without any real or synthetic provider registration', async () => {
  const h = harness();
  const context: MediaSession = { current: () => h.sessions.snapshot() };
  await assert.rejects(
    unavailableMediaGateway.status(intentId, context, new Cancellation()),
    (error: unknown) =>
      error instanceof ClientError && error.kind === 'configuration',
  );
  h.controller.dispose();
});

test('failed upload retries same intent after a status read, without creating a second prepare', async () => {
  const h = harness();
  let attempts = 0;
  h.transfer.upload = async () => {
    attempts += 1;
    if (attempts === 1)
      throw new ClientError('network', 'Synthetic upload failure');
  };
  h.gateway.status = async (id) => {
    h.calls.push(`status:${id}`);
    return h.status();
  };
  h.gateway.finalize = async () => h.status('ready');
  await h.controller.select(target);
  await assert.rejects(h.controller.start());
  await h.controller.start();
  assert.equal(attempts, 2);
  assert.equal(h.prepares.length, 1);
  assert.equal(h.controller.snapshot().status, 'ready');
  assert.ok(
    h.calls.indexOf(`status:${intentId}`) < h.calls.lastIndexOf('grant'),
  );
  h.controller.dispose();
});

test('expired intent and mismatched grant fail closed before transfer', async () => {
  const h = harness();
  let uploads = 0;
  h.transfer.upload = async () => {
    uploads += 1;
  };
  h.gateway.prepare = async () => ({
    intentId: intentId,
    status: 'prepared',
    expiresAt: 1,
  });
  await h.controller.select(target);
  await h.controller.start();
  assert.equal(h.controller.snapshot().status, 'expired');
  assert.equal(uploads, 0);
  h.controller.dispose();

  const p = harness();
  p.gateway.grant = async () => ({
    intentId: '99999999-9999-4999-8999-999999999999',
    generation: 1,
    expiresAt: 10_000,
    handle: 'opaque',
  });
  p.transfer.upload = async () => {
    uploads += 1;
  };
  await p.controller.select(target);
  await assert.rejects(p.controller.start());
  assert.equal(uploads, 0);
  p.controller.dispose();
});

test('changed or missing local bytes never get a new prepare or silently substituted file', async () => {
  const h = harness();
  await h.controller.select(target);
  h.transfer.inspectLocal = async () => ({
    bytes: 101,
    mime: 'image/png',
    width: 10,
    height: 10,
    frames: 1,
  });
  await assert.rejects(h.controller.start());
  assert.ok(!h.calls.includes('grant'));
  assert.equal(h.prepares.length, 1);
  h.controller.dispose();
});

test('authenticated previews are transient, remove downloaded output, and discard unknown descriptor fields', async () => {
  const h = harness();
  let downloads = 0;
  h.transfer.downloadAuthenticated = async (descriptor, variant, session) => {
    session.current();
    assert.equal(variant, 'display-v1');
    assert.deepEqual(
      Object.keys(descriptor).sort(),
      Object.keys(attachment).sort(),
    );
    downloads += 1;
    return { localId: `download_${downloads}` };
  };
  await h.controller.select(target);
  const extra = { ...attachment, url: 'must-not-forward' };
  await h.controller.preview(extra);
  await h.controller.preview(attachment);
  assert.equal(downloads, 2);
  assert.ok(h.removed.includes('download_1'));
  assert.ok(h.removed.includes('download_2'));
  h.controller.dispose();
});

test('prepare matches the shared wire shape and keeps local dimensions out of its declaration', async () => {
  const h = harness();
  h.gateway.finalize = async () => h.status('ready');
  await h.controller.select(target);
  await h.controller.start();
  assert.deepEqual(h.prepares[0], {
    clientRequestId: '66666666-6666-4666-8666-000000000001',
    purpose: 'community-post-image',
    draftId: target.draftId,
    spaceId: target.spaceId,
    slot: 'images',
    ordinal: 0,
    declaration: { mime: 'image/png', bytes: 100 },
  });
  h.controller.dispose();
  const invalid = harness();
  await assert.rejects(
    invalid.controller.select({ ...target, spaceId: 'not-a-uuid' }),
  );
  assert.equal(invalid.prepares.length, 0);
  invalid.controller.dispose();
});
