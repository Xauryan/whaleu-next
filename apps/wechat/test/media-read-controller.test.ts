import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import type { MediaReadTransfer } from '../src/media/authenticated-download';
import type { LocalMediaFile, MediaAttachment } from '../src/media/contracts';
import {
  MediaReadController,
  initialMediaReadView,
  type MediaReadView,
} from '../src/media/read-controller';
import { credentials, deferred, flush, signedIn } from './helpers';
import { attachment } from './support/media-read-fixtures';

function harness() {
  const sessions = signedIn('reader');
  const lifecycle = new PrivateViewLifecycle();
  const rendered: MediaReadView[] = [];
  const calls: Parameters<MediaReadTransfer['download']>[] = [];
  const released: LocalMediaFile[] = [];
  const transfer: MediaReadTransfer = {
    async download(...args) {
      args[3].current();
      calls.push(args);
      return Object.freeze({ localId: `read-${calls.length}` });
    },
    async resolve(file, _owner, ticket) {
      sessions.assertCurrent(ticket);
      return `wxfile://tmp/${file.localId}.png`;
    },
    async release(file) {
      released.push(file);
    },
  };
  const page = {
    data: { mediaRead: initialMediaReadView() },
    setData(patch: { mediaRead: MediaReadView }) {
      this.data = { ...this.data, ...patch };
      rendered.push(patch.mediaRead);
    },
  };
  const controller = new MediaReadController(
    sessions,
    transfer,
    (view) => page.setData({ mediaRead: view }),
    lifecycle,
  );
  return {
    sessions,
    lifecycle,
    rendered,
    calls,
    released,
    transfer,
    page,
    controller,
  };
}

test('a normal reader with no upload Work gets only a capability-resolved local source in current setData', async () => {
  const h = harness();
  assert.deepEqual(Object.keys(h.transfer).sort(), [
    'download',
    'release',
    'resolve',
  ]);
  await h.controller.load(attachment);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]![1], 'display-v1');
  assert.deepEqual(h.page.data.mediaRead, {
    status: 'ready',
    localSrc: 'wxfile://tmp/read-1.png',
    expanded: false,
  });
  for (const view of h.rendered) {
    assert.deepEqual(Object.keys(view).sort(), [
      'expanded',
      'localSrc',
      'status',
    ]);
    assert.ok(Object.isFrozen(view));
    assert.equal(JSON.stringify(view).includes('Bearer'), false);
  }
  h.controller.dispose();
});

test('duplicate taps coalesce while loading; opening and closing each reauthorize and release the old file', async () => {
  const h = harness();
  const download = deferred<LocalMediaFile>();
  const originalDownload = h.transfer.download;
  h.transfer.download = (...args) => {
    h.calls.push(args);
    return download.promise;
  };
  const loading = h.controller.load(attachment);
  assert.equal(h.controller.open(), loading);
  assert.equal(h.controller.open(), loading);
  assert.equal(h.calls.length, 1);
  download.resolve({ localId: 'inline-first' });
  await loading;
  h.transfer.download = originalDownload;
  const opening = h.controller.open();
  assert.equal(h.controller.open(), opening);
  assert.equal(h.page.data.mediaRead.localSrc, '');
  await opening;
  assert.equal(h.calls.length, 2);
  assert.equal(h.page.data.mediaRead.expanded, true);
  await h.controller.close();
  assert.equal(h.calls.length, 3);
  assert.equal(h.page.data.mediaRead.expanded, false);
  assert.deepEqual(
    h.released.map((file) => file.localId),
    ['inline-first', 'read-2'],
  );
  h.controller.dispose();
});

test('clear removes the visible image before cancellation and before asynchronous unlink', async () => {
  const h = harness();
  await h.controller.load(attachment);
  const call = h.calls[0]!;
  const observations: string[] = [];
  call[4].subscribe(() => {
    assert.deepEqual(h.page.data.mediaRead, initialMediaReadView());
    observations.push('abort');
  });
  h.transfer.release = async () => {
    assert.deepEqual(h.page.data.mediaRead, initialMediaReadView());
    observations.push('unlink');
  };
  h.controller.clear();
  assert.deepEqual(observations, ['abort', 'unlink']);
  await h.controller.open();
  assert.equal(
    h.calls.length,
    1,
    'A cleared descriptor requires another fresh parent read',
  );
  h.controller.dispose();
});

test('refresh preserves display and each subsequent request uses current token revision', async () => {
  const h = harness();
  await h.controller.load(attachment);
  const before = h.page.data.mediaRead;
  h.sessions.rotate(h.sessions.snapshot(), credentials('reader', 'rotated'));
  assert.equal(h.page.data.mediaRead, before);
  assert.equal(
    h.calls[0]![3].current().credentials?.accessToken,
    'synthetic-access-rotated',
  );
  await h.controller.open();
  assert.equal(h.calls[1]![3].current().revision, 1);
  h.controller.dispose();
});

for (const action of [
  'logout',
  'relogin',
  'account switch',
  'hide',
  'dispose',
  'private lifecycle',
] as const) {
  test(`${action} synchronously clears expanded image and prevents stale callback repaint`, async () => {
    const h = harness();
    await h.controller.load(attachment);
    await h.controller.open();
    const pending = deferred<LocalMediaFile>();
    h.transfer.download = (...args) => {
      h.calls.push(args);
      return pending.promise;
    };
    const run = h.controller.open();
    switch (action) {
      case 'logout':
        h.sessions.logout();
        break;
      case 'relogin':
        h.sessions.completeLogin(
          h.sessions.beginLogin(),
          credentials('reader', 'new'),
        );
        break;
      case 'account switch':
        h.sessions.completeLogin(h.sessions.beginLogin(), credentials('other'));
        break;
      case 'hide':
        h.controller.hide();
        break;
      case 'dispose':
        h.controller.dispose();
        break;
      case 'private lifecycle':
        h.lifecycle.clear('reader');
        break;
    }
    assert.deepEqual(h.page.data.mediaRead, initialMediaReadView());
    await run;
    const length = h.rendered.length;
    pending.resolve({ localId: 'late' });
    await flush();
    assert.equal(h.rendered.length, length);
    assert.ok(h.released.some((file) => file.localId === 'late'));
    await h.controller.open();
    assert.equal(h.calls.length, 3);
    h.controller.dispose();
  });
}

test('a failed read also loses its descriptor on same-account relogin', async () => {
  const h = harness();
  h.transfer.download = async (...args) => {
    h.calls.push(args);
    throw new ClientError('http', 'Gone', {
      httpStatus: 404,
      serverCode: 'POST_NOT_FOUND',
    });
  };
  await h.controller.load(attachment);
  assert.equal(h.page.data.mediaRead.status, 'denied');
  h.sessions.completeLogin(
    h.sessions.beginLogin(),
    credentials('reader', 'new'),
  );
  await h.controller.open();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.page.data.mediaRead, initialMediaReadView());
  h.controller.dispose();
});

test('another account privacy invalidation does not clear the current viewer', async () => {
  const h = harness();
  await h.controller.load(attachment);
  h.lifecycle.clear('another-reader');
  assert.equal(h.page.data.mediaRead.status, 'ready');
  h.lifecycle.clear();
  assert.deepEqual(h.page.data.mediaRead, initialMediaReadView());
  h.controller.dispose();
});

test('superseded download and resolve callbacks cannot populate a newer attachment', async () => {
  const h = harness();
  const old = deferred<LocalMediaFile>();
  const original = h.transfer.download;
  h.transfer.download = (...args) => {
    h.calls.push(args);
    return old.promise;
  };
  const stale = h.controller.load(attachment);
  h.transfer.download = original;
  await h.controller.load({
    ...attachment,
    bindingId: '44444444-4444-4444-8444-444444444444',
  });
  old.resolve({ localId: 'stale-descriptor' });
  await stale;
  await flush();
  assert.equal(h.page.data.mediaRead.localSrc, 'wxfile://tmp/read-2.png');
  assert.ok(h.released.some((file) => file.localId === 'stale-descriptor'));
  const resolving = deferred<string>();
  h.transfer.resolve = () => resolving.promise;
  const staleResolve = h.controller.open();
  await flush();
  h.controller.clear();
  await staleResolve;
  resolving.resolve('wxfile://tmp/stale-resolve.png');
  await flush();
  assert.deepEqual(h.page.data.mediaRead, initialMediaReadView());
  h.controller.dispose();
});

test('late old-source image-error events cannot invalidate the replacement image', async () => {
  const h = harness();
  await h.controller.load(attachment);
  const old = h.page.data.mediaRead.localSrc;
  await h.controller.open();
  const current = h.page.data.mediaRead.localSrc;
  h.controller.imageFailed(old);
  assert.equal(h.page.data.mediaRead.localSrc, current);
  h.controller.imageFailed(current);
  assert.deepEqual(h.page.data.mediaRead, {
    status: 'unavailable',
    localSrc: '',
    expanded: false,
  });
  assert.ok(h.released.some((file) => file.localId === 'read-2'));
  h.controller.dispose();
});

for (const [error, expected] of [
  [new ClientError('auth-required', 'Auth'), 'denied'],
  [
    new ClientError('forbidden', 'Scope', {
      httpStatus: 403,
      serverCode: 'AUTHORIZATION_REQUIRED',
    }),
    'denied',
  ],
  [
    new ClientError('forbidden', 'Unknown scope', { httpStatus: 403 }),
    'unavailable',
  ],
  [
    new ClientError('http', 'Missing', {
      httpStatus: 404,
      serverCode: 'POST_NOT_FOUND',
    }),
    'denied',
  ],
  [
    new ClientError('http', 'Unknown missing', { httpStatus: 404 }),
    'unavailable',
  ],
  [
    new ClientError('protocol', 'Mismatched denial', {
      httpStatus: 503,
      serverCode: 'POST_NOT_FOUND',
    }),
    'unavailable',
  ],
  [new ClientError('http', 'Unavailable', { httpStatus: 503 }), 'unavailable'],
  [new ClientError('protocol', 'Malformed'), 'unavailable'],
  [new ClientError('storage', 'Missing'), 'unavailable'],
  [new ClientError('timeout', 'Deadline'), 'unavailable'],
] as const) {
  test(`${error.kind}/${error.details.httpStatus ?? ''} produces bounded ${expected} state`, async () => {
    const h = harness();
    h.transfer.download = async () => {
      throw error;
    };
    await h.controller.load(attachment);
    assert.deepEqual(h.page.data.mediaRead, {
      status: expected,
      localSrc: '',
      expanded: false,
    });
    h.controller.dispose();
  });
}

test('unauthenticated, unavailable, invalid, and missing attachments cause no transfer', async () => {
  const h = harness();
  await h.controller.load({
    ...attachment,
    url: 'https://other.invalid',
  } as MediaAttachment);
  assert.equal(h.page.data.mediaRead.status, 'unavailable');
  await h.controller.load(null);
  assert.deepEqual(h.page.data.mediaRead, initialMediaReadView());
  h.sessions.logout();
  await h.controller.load(attachment);
  assert.equal(h.page.data.mediaRead.status, 'denied');
  assert.equal(h.calls.length, 0);
  h.controller.dispose();
  const unavailable = new MediaReadController(
    signedIn('reader'),
    undefined,
    () => undefined,
  );
  await unavailable.load(attachment);
  assert.equal(unavailable.snapshot().status, 'unavailable');
  unavailable.dispose();
});

test('a setData failure still cancels and releases the already-visible file', async () => {
  const h = harness();
  await h.controller.load(attachment);
  const cancel = h.calls[0]![4];
  const original = h.page.setData;
  h.page.setData = () => {
    throw new Error('Synthetic native render failure');
  };
  assert.throws(() => h.controller.clear(), /Synthetic native render failure/);
  assert.equal(cancel.isCancelled, true);
  assert.deepEqual(
    h.released.map((file) => file.localId),
    ['read-1'],
  );
  assert.deepEqual(h.controller.snapshot(), initialMediaReadView());
  h.page.setData = original;
  h.controller.dispose();
});

test('a reentrant hide from loading render cannot dispatch a now-stale download', async () => {
  const h = harness();
  const original = h.page.setData;
  h.page.setData = (patch) => {
    original.call(h.page, patch);
    if (patch.mediaRead.status === 'loading') h.controller.hide();
  };
  await h.controller.load(attachment);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.page.data.mediaRead, initialMediaReadView());
  h.controller.dispose();
});
