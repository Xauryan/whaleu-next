import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WechatMediaFiles,
  type WxMediaApi,
} from '../src/platform/wechat-media';
import { FakeClock } from './helpers';
import { failure } from './support/media-read-fixtures';

function platform() {
  const calls: string[] = [];
  let contents: string | ArrayBuffer =
    '{"error":{"code":"ACCESS_TOKEN_EXPIRED"}}';
  const wx: WxMediaApi = {
    getFileSystemManager: () => ({
      getFileInfo(input) {
        calls.push(`stat:${input.filePath}`);
        input.success({ size: 100 });
      },
      readFile(input) {
        assert.equal(input.encoding, 'utf8');
        assert.equal(input.position, 0);
        assert.ok(input.length <= 8192);
        calls.push(`read:${input.filePath}:${input.length}`);
        input.success({ data: contents });
      },
      unlink(input) {
        calls.push(`unlink:${input.filePath}`);
        input.success();
      },
    }),
    getImageInfo(input) {
      calls.push(`image:${input.src}`);
      input.success({
        width: 80,
        height: 60,
        type: 'png',
        orientation: 'up',
        path: input.src,
      });
    },
  };
  const clock = new FakeClock();
  return {
    wx,
    clock,
    calls,
    files: new WechatMediaFiles(wx, clock),
    setBody(value: string | ArrayBuffer) {
      contents = value;
    },
  };
}

test('platform only uses local filesystem and getImageInfo with bounded JSON reads', async () => {
  const h = platform();
  const path = 'wxfile://tmp/read.png';
  assert.equal(await h.files.stat(path), 100);
  assert.deepEqual(await h.files.image(path), {
    width: 80,
    height: 60,
    type: 'png',
  });
  assert.deepEqual(await h.files.readError(path, 41), {
    error: { code: 'ACCESS_TOKEN_EXPIRED' },
  });
  await h.files.unlink(path);
  assert.deepEqual(h.calls, [
    `stat:${path}`,
    `image:${path}`,
    `read:${path}:41`,
    `unlink:${path}`,
  ]);
  assert.equal(h.clock.timers, 0);
});

for (const size of [-1, 0, 0.5, NaN, Infinity, 8193]) {
  test(`oversized/invalid error JSON read ${size} is rejected before platform I/O`, async () => {
    const h = platform();
    await assert.rejects(
      h.files.readError('wxfile://tmp/error', size),
      failure('protocol'),
    );
    assert.deepEqual(h.calls, []);
  });
}
for (const value of ['not-json', '', new ArrayBuffer(4)]) {
  test('malformed JSON and non-string callbacks fail closed', async () => {
    const h = platform();
    h.setBody(value);
    await assert.rejects(
      h.files.readError('wxfile://tmp/error', 10),
      failure('protocol'),
    );
  });
}

test('missing platform, synchronous throws, and silent callbacks remain bounded', async () => {
  const clock = new FakeClock();
  await assert.rejects(
    new WechatMediaFiles({}, clock).stat('wxfile://tmp/missing'),
    failure('storage'),
  );
  await assert.rejects(
    new WechatMediaFiles(
      {
        getImageInfo() {
          throw new Error('Native fault');
        },
      },
      clock,
    ).image('wxfile://tmp/missing'),
    failure('configuration'),
  );
  const hanging = new WechatMediaFiles({ getImageInfo() {} }, clock);
  const rejected = assert.rejects(
    hanging.image('wxfile://tmp/hanging'),
    failure('timeout'),
  );
  clock.advance(5000);
  await rejected;
  assert.equal(clock.timers, 0);
});
