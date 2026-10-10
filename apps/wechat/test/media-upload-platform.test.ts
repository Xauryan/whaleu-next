import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from 'js-sha256';
import { AuthenticatedMediaUpload } from '../src/media/authenticated-upload';
import { MediaLocalFiles } from '../src/media/local-files';
import type { MediaSession } from '../src/media/contracts';
import { Cancellation } from '../src/platform/contracts';
import {
  WechatUploadFiles,
  type WxUploadApi,
  type WxUploadTask,
} from '../src/platform/wechat-upload';
import { credentials, deferred, FakeClock, signedIn } from './helpers';
import { grant, ids, observed, origin } from './support/media-upload-fixtures';
type UploadInput = Parameters<NonNullable<WxUploadApi['uploadFile']>>[0];
type PickInput = Parameters<NonNullable<WxUploadApi['chooseMedia']>>[0];
function nativeHarness() {
  const sessions = signedIn(ids.actor),
    ticket = sessions.snapshot(),
    clock = new FakeClock(),
    cancel = new Cancellation();
  const session: MediaSession = {
    current: () => {
      sessions.assertCurrent(ticket);
      return sessions.snapshot();
    },
  };
  const path = 'wxfile://tmp/owned-upload.png';
  let bytes = new Uint8Array(140001).fill(81),
    present = true;
  const reads: number[] = [],
    deleted: string[] = [],
    uploads: UploadInput[] = [];
  const uploadArrivals = new Map<
    number,
    ReturnType<typeof deferred<UploadInput>>
  >();
  const removals = new Map<number, ReturnType<typeof deferred<string>>>();
  let progress:
    Parameters<NonNullable<WxUploadTask['onProgressUpdate']>>[0] | undefined;
  let aborts = 0,
    refreshes = 0;
  const wx: WxUploadApi = {
    chooseMedia(input) {
      input.success({
        tempFiles: [
          { tempFilePath: path, size: bytes.byteLength, fileType: 'image' },
        ],
      });
      input.complete();
    },
    getImageInfo(input) {
      input.success({
        width: 100,
        height: 100,
        type: 'png',
        orientation: 'up',
        path: input.src,
      });
    },
    getFileSystemManager: () => ({
      getFileInfo(input) {
        if (present) input.success({ size: bytes.length });
        else input.fail({});
      },
      readFile(input) {
        reads.push(input.length);
        input.success({
          data: bytes.slice(input.position, input.position + input.length)
            .buffer,
        });
      },
      unlink(input) {
        assert.equal(input.filePath, path);
        present = false;
        const index = deleted.length;
        deleted.push(input.filePath);
        removals.get(index)?.resolve(input.filePath);
        input.success();
      },
    }),
    uploadFile(input) {
      const index = uploads.length;
      uploads.push(input);
      uploadArrivals.get(index)?.resolve(input);
      return {
        abort() {
          aborts++;
        },
        onProgressUpdate(listener) {
          progress = listener;
        },
        offProgressUpdate(listener) {
          if (progress === listener) progress = undefined;
        },
      };
    },
  };
  const files = new WechatUploadFiles(wx, clock),
    registry = new MediaLocalFiles(files);
  const transfer = new AuthenticatedMediaUpload(
    origin,
    wx,
    files,
    registry,
    sessions,
    clock,
    {
      async refresh(owner) {
        refreshes++;
        return sessions.rotate(owner, credentials(ids.actor, 'fresh'));
      },
    },
  );
  const lease = () => ({
    ...grant,
    expectedBytes: bytes.length,
    expectedSha256: sha256(bytes),
  });
  const receipt = () => ({
    ...observed,
    bytes: bytes.length,
    sha256: sha256(bytes),
  });
  return {
    sessions,
    session,
    ticket,
    clock,
    cancel,
    path,
    reads,
    deleted,
    uploads,
    wx,
    files,
    registry,
    transfer,
    async uploadAt(
      index: number,
      operation: Promise<unknown>,
    ): Promise<UploadInput> {
      const existing = uploads[index];
      if (existing) return existing;
      let arrival = uploadArrivals.get(index);
      if (!arrival) {
        arrival = deferred<UploadInput>();
        uploadArrivals.set(index, arrival);
      }
      // Wait for the actual SDK boundary, not a guessed number of microtasks.
      // If validation fails before dispatch, surface that failure instead of hanging.
      return Promise.race([
        arrival.promise,
        operation.then(() => {
          throw new Error('Upload settled before reaching the native SDK');
        }),
      ]);
    },
    async removalAt(index: number): Promise<string> {
      const existing = deleted[index];
      if (existing) return existing;
      let removal = removals.get(index);
      if (!removal) {
        removal = deferred<string>();
        removals.set(index, removal);
      }
      return removal.promise;
    },
    lease,
    receipt,
    getBytes: () => bytes,
    setBytes(value: Uint8Array) {
      bytes = Uint8Array.from(value);
    },
    getAborts: () => aborts,
    getRefreshes: () => refreshes,
    progress(value: number) {
      progress?.({
        progress: value,
        totalBytesSent: Math.round((bytes.length * value) / 100),
        totalBytesExpectedToSend: bytes.length,
      });
    },
  };
}
async function readyUpload() {
  const h = nativeHarness(),
    file = await h.transfer.pick(h.session, h.cancel),
    handle = h.transfer.register(h.lease(), h.session);
  return { ...h, file, handle };
}

test('real platform digest uses bounded ArrayBuffer chunks, unknown frame count, and exact first-party multipart API', async () => {
  const h = await readyUpload();
  const inspected = await h.transfer.inspect(h.file, h.session, h.cancel);
  assert.equal(inspected.sha256, sha256(h.getBytes()));
  assert.equal(inspected.frameCount, 'unknown');
  assert.ok(h.reads.every((length) => length > 0 && length <= 65536));
  assert.ok(h.reads.length >= 3);
  h.sessions.rotate(h.ticket, credentials(ids.actor, 'rotated'));
  const task = h.transfer.upload(
    h.handle,
    h.file,
    () => undefined,
    h.session,
    h.cancel,
  );
  const input = await h.uploadAt(0, task);
  assert.equal(
    input.url,
    `${origin}/v2/media/upload-intents/${ids.intent}/uploads/${ids.grant}`,
  );
  assert.equal(input.name, 'file');
  assert.equal(input.filePath, h.path);
  assert.deepEqual(input.header, {
    Authorization: 'Bearer synthetic-access-rotated',
  });
  assert.equal('formData' in input, false);
  assert.equal('method' in input, false);
  input.success({ statusCode: 200, data: JSON.stringify(h.receipt()) });
  input.complete();
  assert.equal((await task).next, 'finalize');
  await h.transfer.remove(h.file);
  assert.deepEqual(h.deleted, [h.path]);
});
test('forged serialized file/grant handles never confer path/network authority', async () => {
  const h = await readyUpload();
  await assert.rejects(h.transfer.inspect({ ...h.file }, h.session, h.cancel));
  await assert.rejects(
    h.transfer.upload(
      { ...h.handle },
      h.file,
      () => undefined,
      h.session,
      h.cancel,
    ),
  );
  assert.equal(h.uploads.length, 0);
  await h.transfer.remove(h.file);
});
test('same-length file substitution after prepare is rejected before SDK upload', async () => {
  const h = await readyUpload();
  h.setBytes(new Uint8Array(h.getBytes().length).fill(82));
  await assert.rejects(
    h.transfer.upload(h.handle, h.file, () => undefined, h.session, h.cancel),
  );
  assert.equal(h.uploads.length, 0);
  await h.transfer.remove(h.file);
});
for (const [status, data] of [
  [206, JSON.stringify(observed)],
  [302, JSON.stringify(observed)],
  [200, 'not json'],
  [200, 'x'.repeat(8193)],
  [200, JSON.stringify({ ...observed, url: 'https://outside.invalid' })],
  [200, JSON.stringify({ ...observed, status: 'ready' })],
] as const)
  test(`SDK success does not accept malformed/partial/redirect receipt ${status}/${data.length}`, async () => {
    const h = await readyUpload();
    const task = assert.rejects(
      h.transfer.upload(h.handle, h.file, () => undefined, h.session, h.cancel),
    );
    await h.uploadAt(0, task);
    h.uploads[0]!.success({ statusCode: status, data });
    h.uploads[0]!.complete();
    await task;
    assert.equal(h.getRefreshes(), 0);
    await h.transfer.remove(h.file);
  });
test('explicit expired-token failure refreshes once but never transparently replays multipart', async () => {
  const h = await readyUpload();
  const task = assert.rejects(
    h.transfer.upload(h.handle, h.file, () => undefined, h.session, h.cancel),
  );
  await h.uploadAt(0, task);
  h.uploads[0]!.success({
    statusCode: 401,
    data: JSON.stringify({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }),
  });
  h.uploads[0]!.complete();
  await task;
  assert.equal(h.getRefreshes(), 1);
  assert.equal(h.uploads.length, 1);
  await h.transfer.remove(h.file);
});
test('timeout keeps native slot until complete and late success after cancellation cannot resolve', async () => {
  const h = await readyUpload();
  let progress = 0;
  const task = assert.rejects(
    h.transfer.upload(h.handle, h.file, () => progress++, h.session, h.cancel),
  );
  await h.uploadAt(0, task);
  h.cancel.cancel();
  h.uploads[0]!.success({ statusCode: 200, data: JSON.stringify(h.receipt()) });
  h.progress(100);
  await task;
  assert.equal(progress, 0);
  assert.equal(h.getAborts(), 1);
  h.uploads[0]!.complete();
  await h.transfer.remove(h.file);
});
test('native complete missing consumes bounded slots rather than enabling unbounded abandoned uploads', async () => {
  const h = await readyUpload();
  for (let i = 0; i < 2; i++) {
    const handle =
        i === 0 ? h.handle : h.transfer.register(h.lease(), h.session),
      task = h.transfer.upload(
        handle,
        h.file,
        () => undefined,
        h.session,
        h.cancel,
      );
    await h.uploadAt(i, task);
    h.uploads[i]!.success({
      statusCode: 200,
      data: JSON.stringify(h.receipt()),
    });
    await task;
  }
  await assert.rejects(
    h.transfer.upload(
      h.transfer.register(h.lease(), h.session),
      h.file,
      () => undefined,
      h.session,
      h.cancel,
    ),
  );
  assert.equal(h.uploads.length, 2);
  for (const input of h.uploads) input.complete();
  await h.transfer.remove(h.file);
});
test('cancel during native task construction aborts returned task and rejects stale epoch callbacks', async () => {
  const h = await readyUpload();
  let aborted = 0;
  h.wx.uploadFile = (input) => {
    h.cancel.cancel();
    input.success({ statusCode: 200, data: JSON.stringify(h.receipt()) });
    input.complete();
    return {
      abort() {
        aborted++;
      },
    };
  };
  await assert.rejects(
    h.transfer.upload(h.handle, h.file, () => undefined, h.session, h.cancel),
  );
  assert.equal(aborted, 1);
  await h.transfer.remove(h.file);
});
test('late non-abortable picker output is owned and removed; user cancellation remains distinct', async () => {
  const h = nativeHarness();
  let pick: PickInput | undefined;
  h.wx.chooseMedia = (input) => {
    pick = input;
  };
  const task = assert.rejects(
    h.transfer.pick(h.session, h.cancel),
    (error) =>
      error instanceof Error && 'kind' in error && error.kind === 'cancelled',
  );
  h.cancel.cancel();
  await task;
  pick!.success({
    tempFiles: [{ tempFilePath: h.path, size: h.getBytes().length }],
  });
  pick!.complete();
  await h.removalAt(0);
  assert.deepEqual(h.deleted, [h.path]);
  const other = nativeHarness();
  other.wx.chooseMedia = (input) => {
    input.fail({ errMsg: 'chooseMedia:fail cancel' });
    input.complete();
  };
  await assert.rejects(
    other.transfer.pick(other.session, other.cancel),
    (error) =>
      error instanceof Error && 'kind' in error && error.kind === 'cancelled',
  );
});
test('short ArrayBuffer/string reads, missing files and unsupported image type fail closed', async () => {
  const h = nativeHarness();
  const file = await h.transfer.pick(h.session, h.cancel);
  const original = h.wx.getFileSystemManager!;
  h.wx.getFileSystemManager = () => ({
    ...original(),
    readFile(input) {
      input.success({ data: new ArrayBuffer(1) });
    },
  });
  await assert.rejects(h.transfer.inspect(file, h.session, h.cancel));
  h.wx.getFileSystemManager = original;
  h.wx.getImageInfo = (input) =>
    input.success({
      width: 100,
      height: 100,
      type: 'heic',
      orientation: 'up',
      path: input.src,
    });
  await assert.rejects(h.transfer.inspect(file, h.session, h.cancel));
  await h.transfer.remove(file);
});
