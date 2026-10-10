import assert from 'node:assert/strict';
import test from 'node:test';
import { Cancellation } from '../src/platform/contracts';
import type { MediaAttachment } from '../src/media/contracts';
import { credentials, deferred, flush } from './helpers';
import {
  attachment,
  downloadHarness,
  expiredBody,
  failure,
  imageHeaders,
} from './support/media-read-fixtures';

test('read-only GET derives its first-party URL from the binding and reads latest session token', async () => {
  const h = downloadHarness();
  h.sessions.rotate(h.sessions.snapshot(), credentials('reader', 'latest'));
  const read = h.read();
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(
    h.calls[0]!.options.url,
    `https://media-reader.invalid/v1/media/bindings/${attachment.bindingId}/display-v1`,
  );
  assert.deepEqual(h.calls[0]!.options.header, {
    Authorization: 'Bearer synthetic-access-latest',
  });
  assert.equal(h.calls[0]!.options.timeout, 15_000);
  const path = await h.finish();
  const handle = await read;
  assert.deepEqual(Object.keys(handle), ['localId']);
  assert.ok(Object.isFrozen(handle));
  assert.equal(
    await h.transfer.resolve(handle, h.owner, h.sessions.snapshot()),
    path,
  );
  assert.equal(h.clock.timers, 0);
  await h.transfer.release(handle);
  assert.deepEqual(h.files.deleted, [path]);
});

test('expired JSON 401 refreshes once, deletes the error file once, and replays with latest token', async () => {
  const h = downloadHarness();
  const read = h.read();
  await flush();
  const oldPath = await h.finish(
    0,
    { body: expiredBody() },
    { 'content-type': 'application/json; charset=utf-8' },
    401,
  );
  await flush();
  assert.equal(h.refreshes.length, 1);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(
    h.files.deleted,
    [oldPath],
    'Error bytes must not be unlinked twice into a false tombstone',
  );
  assert.equal(
    h.calls[1]!.options.header['Authorization'],
    'Bearer synthetic-access-refreshed',
  );
  await h.finish(1);
  const handle = await read;
  await h.transfer.release(handle);
  assert.equal(h.files.values.size, 0);
  // Four new leases prove cleanup did not leave an invisible tombstone.
  const leases = Array.from({ length: 4 }, (_, i) =>
    h.registry.adopt(
      `wxfile://tmp/reusable-${i}.png`,
      1,
      {},
      h.sessions.snapshot(),
    ),
  );
  assert.equal(leases.length, 4);
});

test('second expired 401 never triggers a second refresh and all response files are removed', async () => {
  const h = downloadHarness();
  const rejected = assert.rejects(h.read(), failure('auth-expired'));
  await h.finish(
    0,
    { body: expiredBody() },
    { 'content-type': 'application/json' },
    401,
  );
  await flush();
  await h.finish(
    1,
    { body: expiredBody() },
    { 'content-type': 'application/json' },
    401,
  );
  await rejected;
  assert.equal(h.refreshes.length, 1);
  assert.equal(h.calls.length, 2);
  assert.equal(h.files.values.size, 0);
  assert.equal(new Set(h.files.deleted).size, h.files.deleted.length);
});

for (const [label, body, contentType] of [
  ['bare', undefined, 'application/octet-stream'],
  [
    'unknown envelope',
    { error: { code: 'AUTHENTICATION_REQUIRED' } },
    'application/json',
  ],
  [
    'wrong case envelope',
    { error: { code: 'access_token_expired' } },
    'application/json',
  ],
  ['expired body under non-JSON MIME', expiredBody(), 'text/plain'],
] as const) {
  test(`${label} 401 fails closed without refresh`, async () => {
    const h = downloadHarness();
    const rejected = assert.rejects(h.read(), failure('auth-required'));
    await h.finish(0, { body }, { 'content-type': contentType }, 401);
    await rejected;
    assert.equal(h.refreshes.length, 0);
    assert.equal(h.calls.length, 1);
  });
}

for (const status of [
  100,
  101,
  199,
  201,
  202,
  204,
  206,
  300,
  301,
  302,
  303,
  304,
  307,
  308,
  400,
  401,
  403,
  404,
  410,
  416,
  422,
  429,
  500,
  502,
  503,
  504,
  0,
  600,
  NaN,
  200.5,
]) {
  test(`HTTP ${status} never becomes an image`, async () => {
    const h = downloadHarness();
    const rejected = assert.rejects(h.read());
    const path = await h.finish(0, {}, imageHeaders(), status);
    await rejected;
    assert.ok(h.files.deleted.includes(path));
    assert.equal(h.files.decoded.length, 0);
    assert.equal(h.refreshes.length, 0);
  });
}

const malformedHeaders: ReadonlyArray<
  readonly [string, Record<string, unknown> | null]
> = [
  ['missing header callback', null],
  ['missing MIME', { 'content-length': '100', 'cache-control': 'no-store' }],
  [
    'missing length',
    { 'content-type': 'image/png', 'cache-control': 'no-store' },
  ],
  [
    'missing cache control',
    { 'content-type': 'image/png', 'content-length': '100' },
  ],
  ['wrong MIME', { ...imageHeaders(), 'content-type': 'text/html' }],
  [
    'parameterized MIME',
    { ...imageHeaders(), 'content-type': 'image/png; charset=utf-8' },
  ],
  [
    'public cache',
    { ...imageHeaders(), 'cache-control': 'public, max-age=3600' },
  ],
  ['partial content', { ...imageHeaders(), 'content-range': 'bytes 0-99/100' }],
  [
    'redirect header',
    { ...imageHeaders(), location: 'https://other.invalid/image' },
  ],
  ['numeric length value', { ...imageHeaders(), 'content-length': 100 }],
  ['case-colliding header', { ...imageHeaders(), 'Content-Type': 'image/png' }],
  ...[
    '0',
    '-1',
    '0100',
    '100.0',
    '1e2',
    '+100',
    ' 100',
    '100 ',
    '99',
    '101',
    'NaN',
  ].map(
    (value) =>
      [
        `length ${value}`,
        { ...imageHeaders(), 'content-length': value },
      ] as const,
  ),
];
for (const [name, headers] of malformedHeaders) {
  test(`rejects ${name}, removes bytes, and does not decode an image`, async () => {
    const h = downloadHarness();
    const rejected = assert.rejects(h.read(), failure('protocol'));
    await h.finish(0, {}, headers);
    await rejected;
    await flush();
    assert.equal(h.files.values.size, 0);
    assert.equal(h.files.decoded.length, 0);
  });
}

test('case-insensitive header names and no-store token are accepted', async () => {
  const h = downloadHarness();
  const read = h.read();
  await flush();
  await h.finish(
    0,
    {},
    {
      'Content-Type': 'image/png',
      'Content-Length': '100',
      'Cache-Control': 'PRIVATE, No-Store',
    },
  );
  await h.transfer.release(await read);
});

for (const size of [0, -1, 0.5, NaN, Infinity, 5 * 1024 * 1024 + 1]) {
  test(`rejects invalid local byte count ${size}`, async () => {
    const h = downloadHarness();
    const rejected = assert.rejects(h.read(), failure('protocol'));
    await h.finish(0, { size }, imageHeaders(size));
    await rejected;
    assert.equal(h.files.decoded.length, 0);
  });
}
for (const info of [
  { width: 0, height: 60, type: 'png' },
  { width: 80, height: -1, type: 'png' },
  { width: 80.5, height: 60, type: 'png' },
  { width: NaN, height: 60, type: 'png' },
  { width: 2049, height: 60, type: 'png' },
  { width: 80, height: 2049, type: 'png' },
  { width: 79, height: 60, type: 'png' },
  { width: 80, height: 59, type: 'png' },
  { width: 80, height: 60, type: 'gif' },
  { width: 80, height: 60, type: 'jpeg' },
]) {
  test(`rejects local metadata ${JSON.stringify(info)}`, async () => {
    const h = downloadHarness();
    const rejected = assert.rejects(h.read(), failure('protocol'));
    await h.finish(0, { info });
    await rejected;
    assert.equal(h.files.values.size, 0);
  });
}

test('thumbnail has its own 400px bound and does not require display dimensions', async () => {
  const h = downloadHarness();
  const read = h.transfer.download(
    attachment,
    'thumb-v1',
    h.owner,
    h.session,
    new Cancellation(),
  );
  await flush();
  assert.match(h.calls[0]!.options.url, /\/thumb-v1$/);
  await h.finish(0, { info: { width: 400, height: 300, type: 'png' } });
  await h.transfer.release(await read);
  const rejected = assert.rejects(
    h.transfer.download(
      attachment,
      'thumb-v1',
      h.owner,
      h.session,
      new Cancellation(),
    ),
    failure('protocol'),
  );
  await h.finish(1, { info: { width: 401, height: 300, type: 'png' } });
  await rejected;
});

test('bytes changing during image validation cannot be adopted', async () => {
  const h = downloadHarness();
  h.files.image = async (path) => {
    h.files.values.get(path)!.size = 101;
    return { width: 80, height: 60, type: 'png' };
  };
  const rejected = assert.rejects(h.read(), failure('storage'));
  await h.finish();
  await rejected;
  assert.equal(h.files.values.size, 0);
});

for (const raw of [
  { ...attachment, url: 'https://other.invalid/track' },
  { ...attachment, bindingId: '../escape' },
]) {
  test('rejects descriptor URL/identifier injection before native dispatch', async () => {
    const h = downloadHarness();
    await assert.rejects(
      h.transfer.download(
        raw as MediaAttachment,
        'display-v1',
        h.owner,
        h.session,
        new Cancellation(),
      ),
      failure('protocol'),
    );
    assert.equal(h.calls.length, 0);
  });
}

test('same-account relogin invalidates a response even when the account identifier matches', async () => {
  const h = downloadHarness();
  const rejected = assert.rejects(h.read());
  await flush();
  h.sessions.completeLogin(
    h.sessions.beginLogin(),
    credentials('reader', 'new-login'),
  );
  await h.finish();
  await rejected;
  await flush();
  assert.equal(h.files.values.size, 0);
  assert.equal(h.refreshes.length, 0);
});

test('session replacement while refresh is pending never replays with another epoch', async () => {
  const h = downloadHarness();
  const gate = deferred<ReturnType<typeof credentials>>();
  h.authGateway.refresh = () => gate.promise;
  const rejected = assert.rejects(h.read(), failure('stale-session'));
  await h.finish(
    0,
    { body: expiredBody() },
    { 'content-type': 'application/json' },
    401,
  );
  await flush();
  await flush();
  h.sessions.completeLogin(
    h.sessions.beginLogin(),
    credentials('reader', 'new-login'),
  );
  gate.resolve(credentials('reader', 'old-refresh'));
  await rejected;
  assert.equal(h.calls.length, 1);
  assert.equal(
    h.sessions.snapshot().credentials?.accessToken,
    'synthetic-access-new-login',
  );
});

test('aborted construction aborts the returned task and late output is removed', async () => {
  const h = downloadHarness();
  const cancel = new Cancellation();
  h.construct = () => cancel.cancel();
  const rejected = assert.rejects(h.read(cancel), failure('cancelled'));
  await rejected;
  assert.equal(h.calls[0]!.aborted, 1);
  await h.finish();
  await flush();
  assert.equal(h.files.values.size, 0);
  assert.equal(h.clock.timers, 0);
});

test('timeout detaches listeners, aborts native I/O, and removes late bytes', async () => {
  const h = downloadHarness();
  const rejected = assert.rejects(h.read(), failure('timeout'));
  await flush();
  h.clock.advance(15_000);
  await rejected;
  assert.ok(h.calls[0]!.aborted >= 1);
  assert.equal(h.calls[0]!.header, undefined);
  assert.equal(h.calls[0]!.progress, undefined);
  await h.finish();
  await flush();
  assert.equal(h.files.values.size, 0);
});

test('second header event aborts instead of accepting a redirected response', async () => {
  const h = downloadHarness();
  const rejected = assert.rejects(h.read(), failure('protocol'));
  await flush();
  h.calls[0]!.headers(imageHeaders());
  await flush();
  h.calls[0]!.headers(imageHeaders());
  await h.finish();
  await rejected;
  assert.ok(h.calls[0]!.aborted >= 1);
  assert.equal(h.files.values.size, 0);
});

test('at most two in-flight operations include local verification after native complete', async () => {
  const h = downloadHarness();
  const gate = deferred<number>();
  h.files.stat = () => gate.promise;
  const first = h.read();
  const second = h.read();
  await h.finish(0);
  await h.finish(1);
  await flush();
  await assert.rejects(h.read(), failure('configuration'));
  assert.equal(h.calls.length, 2);
  gate.resolve(100);
  for (const handle of await Promise.all([first, second]))
    await h.transfer.release(handle);
});

for (const size of [-1, NaN, Infinity, 0.5, 5 * 1024 * 1024 + 1]) {
  test(`native progress byte count ${size} aborts before allocation can be retained`, async () => {
    const h = downloadHarness();
    const rejected = assert.rejects(h.read(), failure('protocol'));
    await flush();
    h.calls[0]!.progress?.({ totalBytesWritten: size });
    await rejected;
    assert.ok(h.calls[0]!.aborted >= 1);
    await h.finish();
    await flush();
    assert.equal(h.files.values.size, 0);
  });
}

test('pre-cancelled request never dispatches and unsupported native callbacks fail closed', async () => {
  const h = downloadHarness();
  const cancel = new Cancellation();
  cancel.cancel();
  await assert.rejects(h.read(cancel), failure('cancelled'));
  assert.equal(h.calls.length, 0);
  for (const missing of ['headers', 'progress'] as const) {
    const p = downloadHarness();
    p.wx.downloadFile = (options) => ({
      abort() {
        options.complete();
      },
      ...(missing === 'headers' ? {} : { onHeadersReceived() {} }),
      ...(missing === 'progress' ? {} : { onProgressUpdate() {} }),
    });
    await assert.rejects(p.read(), failure('protocol'));
  }
});

test('native failure and synchronous throw have bounded errors without leaking platform strings', async () => {
  const h = downloadHarness();
  h.wx.downloadFile = () => {
    throw new Error('Do not expose secret native detail');
  };
  await assert.rejects(h.read(), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes('secret'), false);
    return failure('network')(error);
  });
  const p = downloadHarness();
  const rejected = assert.rejects(p.read(), failure('network'));
  await flush();
  p.calls[0]!.options.fail({ errMsg: 'Do not expose secret detail' });
  p.calls[0]!.complete();
  await rejected;
  assert.equal(p.clock.timers, 0);
});

test('cleanup failure revokes files, retries later, and never exposes the failed file as a new lease', async () => {
  const h = downloadHarness();
  h.files.failUnlink = true;
  const rejected = assert.rejects(h.read(), failure('protocol'));
  const path = await h.finish(
    0,
    {},
    { ...imageHeaders(), 'content-type': 'text/html' },
  );
  await rejected;
  assert.throws(
    () => h.registry.adopt(path, 100, h.owner, h.sessions.snapshot()),
    failure('storage'),
  );
  h.files.failUnlink = false;
  const next = h.read();
  await h.finish(1);
  await h.transfer.release(await next);
  assert.equal(h.files.values.size, 0);
});

test('two simultaneous expired reads share the actual AuthService single-flight refresh', async () => {
  const h = downloadHarness();
  const refreshed = deferred<ReturnType<typeof credentials>>();
  let refreshCount = 0;
  h.authGateway.refresh = () => {
    refreshCount++;
    return refreshed.promise;
  };
  const first = h.read();
  const second = h.read();
  await h.finish(
    0,
    { body: expiredBody() },
    { 'content-type': 'application/json' },
    401,
  );
  await h.finish(
    1,
    { body: expiredBody() },
    { 'content-type': 'application/json' },
    401,
  );
  assert.equal(refreshCount, 1);
  assert.equal(h.calls.length, 2);
  refreshed.resolve(credentials('reader', 'single-flight'));
  await h.finish(2);
  await h.finish(3);
  for (const index of [2, 3])
    assert.equal(
      h.calls[index]!.options.header['Authorization'],
      'Bearer synthetic-access-single-flight',
    );
  for (const handle of await Promise.all([first, second]))
    await h.transfer.release(handle);
  assert.equal(h.files.values.size, 0);
});

test('cancel during local metadata inspection cleans its file and forbids a late adoption', async () => {
  const h = downloadHarness();
  const info = deferred<{ width: number; height: number; type: string }>();
  h.files.image = () => info.promise;
  const cancel = new Cancellation();
  const rejected = assert.rejects(h.read(cancel), failure('cancelled'));
  const path = await h.finish();
  cancel.cancel();
  await rejected;
  info.resolve({ width: 80, height: 60, type: 'png' });
  await flush();
  assert.deepEqual(h.files.deleted, [path]);
  assert.equal(h.files.values.size, 0);
});

test('uncompleted aborted tasks keep the native slot cap until completion callbacks arrive', async () => {
  const h = downloadHarness();
  const one = new Cancellation(),
    two = new Cancellation();
  const first = assert.rejects(h.read(one), failure('cancelled'));
  const second = assert.rejects(h.read(two), failure('cancelled'));
  await flush();
  one.cancel();
  two.cancel();
  await Promise.all([first, second]);
  await assert.rejects(h.read(), failure('configuration'));
  assert.equal(h.calls.length, 2);
  h.calls[0]!.complete();
  h.calls[1]!.complete();
  const next = h.read();
  await h.finish(2);
  await h.transfer.release(await next);
});

test('duplicate callbacks cannot delete an adopted file; distinct late outputs are removed', async () => {
  const h = downloadHarness();
  const read = h.read();
  const path = await h.finish();
  const handle = await read;
  h.calls[0]!.success(path);
  const late = 'wxfile://tmp/extra-native-output.png';
  h.files.put(late);
  h.calls[0]!.success(late);
  await flush();
  assert.equal(
    await h.transfer.resolve(handle, h.owner, h.sessions.snapshot()),
    path,
  );
  assert.deepEqual(h.files.deleted, [late]);
  await h.transfer.release(handle);
});

for (const path of [
  'https://other.invalid/photo',
  'wxfile://usr/persisted.png',
  'wxfile://tmp/../secret',
]) {
  test(`forged native output ${path} never reaches image decode or arbitrary unlink`, async () => {
    const h = downloadHarness();
    const rejected = assert.rejects(h.read(), failure('protocol'));
    await flush();
    h.calls[0]!.headers(imageHeaders());
    h.calls[0]!.success(path);
    h.calls[0]!.complete();
    await rejected;
    assert.deepEqual(h.files.stats, []);
    assert.deepEqual(h.files.deleted, []);
  });
}

test('JPEG at the byte ceiling and its declared dimensions remain valid', async () => {
  const h = downloadHarness();
  const size = 5 * 1024 * 1024;
  const read = h.read();
  await h.finish(
    0,
    { size, info: { width: 80, height: 60, type: 'jpeg' } },
    { ...imageHeaders(size), 'content-type': 'image/jpeg' },
  );
  await h.transfer.release(await read);
  assert.equal(h.files.values.size, 0);
});

test('oversized error body cannot cause a refresh and is removed without being read', async () => {
  const h = downloadHarness();
  const rejected = assert.rejects(h.read(), failure('auth-required'));
  await h.finish(
    0,
    { size: 8193, body: expiredBody() },
    { 'content-type': 'application/json', 'content-length': '8193' },
    401,
  );
  await rejected;
  assert.deepEqual(h.files.errors, []);
  assert.equal(h.refreshes.length, 0);
  assert.equal(h.files.values.size, 0);
});
