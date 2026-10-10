import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaReadRuntime } from '../src/media/runtime';
import {
  initialMediaReadView,
  type MediaReadView,
} from '../src/media/read-controller';
import type { WxMediaApi } from '../src/platform/wechat-media';
import { flush } from './helpers';
import { attachment, downloadHarness } from './support/media-read-fixtures';

function fixture() {
  const h = downloadHarness();
  const wx: WxMediaApi = {
    ...h.wx,
    getFileSystemManager: () => ({
      getFileInfo: (input) => {
        void h.files
          .stat(input.filePath)
          .then((size) => input.success({ size }), input.fail);
      },
      readFile: (input) => {
        void h.files
          .readError(input.filePath)
          .then(
            (body) => input.success({ data: JSON.stringify(body) }),
            input.fail,
          );
      },
      unlink: (input) => {
        void h.files.unlink(input.filePath).then(input.success, input.fail);
      },
    }),
    getImageInfo: (input) => {
      void h.files
        .image(input.src)
        .then(
          (info) =>
            input.success({ ...info, orientation: 'up', path: input.src }),
          input.fail,
        );
    },
  };
  return { ...h, wx, identity: { sessions: h.sessions, auth: h.auth } };
}

test('ordinary runtime defaults unavailable even with all native capabilities present', async () => {
  const h = fixture();
  const runtime = createMediaReadRuntime(
    h.identity,
    h.wx,
    'https://media-reader.invalid',
    h.clock,
    undefined,
  );
  const controller = runtime.create(() => undefined);
  await controller.load(attachment);
  assert.equal(controller.snapshot().status, 'unavailable');
  assert.equal(h.calls.length, 0);
  controller.dispose();
});

for (const capability of [
  'downloadFile',
  'getFileSystemManager',
  'getImageInfo',
] as const) {
  test(`verified bridge remains unavailable when ${capability} is absent`, async () => {
    const h = fixture();
    delete h.wx[capability];
    const runtime = createMediaReadRuntime(
      h.identity,
      h.wx,
      'https://media-reader.invalid',
      h.clock,
      undefined,
      true,
    );
    const controller = runtime.create(() => undefined);
    await controller.load(attachment);
    assert.equal(controller.snapshot().status, 'unavailable');
    assert.equal(h.calls.length, 0);
    controller.dispose();
  });
}

test('missing refresh service and invalid origin cannot enable even a verified bridge', async () => {
  const h = fixture();
  for (const runtime of [
    createMediaReadRuntime(
      { sessions: h.sessions },
      h.wx,
      'https://media-reader.invalid',
      h.clock,
      undefined,
      true,
    ),
    createMediaReadRuntime(
      h.identity,
      h.wx,
      'https://media-reader.invalid/foreign/path',
      h.clock,
      undefined,
      true,
    ),
  ]) {
    const controller = runtime.create(() => undefined);
    await controller.load(attachment);
    assert.equal(controller.snapshot().status, 'unavailable');
    controller.dispose();
  }
  assert.equal(h.calls.length, 0);
});

test('verified synthetic bridge uses native download and FS but exposes no upload or preview API', async () => {
  const h = fixture();
  let view: MediaReadView = initialMediaReadView();
  const runtime = createMediaReadRuntime(
    h.identity,
    h.wx,
    'https://media-reader.invalid',
    h.clock,
    undefined,
    true,
  );
  const controller = runtime.create((value) => {
    view = value;
  });
  const loading = controller.load(attachment);
  await h.finish();
  await loading;
  assert.equal(view.status, 'ready');
  assert.equal(view.localSrc, 'wxfile://tmp/media-read-0.png');
  controller.dispose();
  assert.equal(view.localSrc, '');
  await flush();
  assert.equal(h.files.values.size, 0);
});
