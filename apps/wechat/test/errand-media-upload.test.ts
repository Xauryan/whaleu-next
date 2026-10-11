import assert from 'node:assert/strict';
import test from 'node:test';
import { ErrandMediaUpload } from '../src/errands/media-upload';
import { ERRAND_MEDIA_PROTOCOL } from '../src/errands/media-contract';
import { MediaLocalFiles } from '../src/media/local-files';
import { Cancellation } from '../src/platform/contracts';
import type { WxUploadApi, UploadFiles } from '../src/platform/wechat-upload';
import { FakeClock, flush, signedIn } from './helpers';
import { ReadFiles } from './support/media-read-fixtures';
import { grant, observed, ids } from './support/media-upload-fixtures';
type NativeUpload = Parameters<NonNullable<WxUploadApi['uploadFile']>>[0];
function harness() {
  const clock = new FakeClock(),
    sessions = signedIn(ids.actor),
    ticket = sessions.snapshot();
  const files = Object.assign(new ReadFiles(), {
    digest: async () => 'a'.repeat(64),
  }) satisfies UploadFiles;
  const registry = new MediaLocalFiles(files),
    calls: NativeUpload[] = [];
  const path = 'wxfile://tmp/errand-selected.png';
  files.put(path);
  let picks = 0,
    aborts = 0;
  const wx: WxUploadApi = {
    chooseMedia(options) {
      picks++;
      options.success({
        tempFiles: [{ tempFilePath: path, size: 100, fileType: 'image' }],
      });
      options.complete();
    },
    uploadFile(options) {
      calls.push(options);
      return {
        abort() {
          aborts++;
        },
      };
    },
  };
  const upload = new ErrandMediaUpload(
    'https://errand.invalid',
    wx,
    files,
    registry,
    sessions,
    clock,
  );
  const session = {
    current: () => {
      sessions.assertCurrent(ticket);
      return sessions.snapshot();
    },
  };
  const { version: _grantVersion, ...rawGrant } = grant,
    { version: _observedVersion, ...rawObserved } = observed;
  void _grantVersion;
  void _observedVersion;
  return {
    clock,
    sessions,
    files,
    registry,
    calls,
    upload,
    session,
    path,
    wx,
    grant: { ...rawGrant, protocol: ERRAND_MEDIA_PROTOCOL },
    receipt: { ...rawObserved, protocol: ERRAND_MEDIA_PROTOCOL },
    picks: () => picks,
    aborts: () => aborts,
  };
}
test('Errand uploads use only the exact typed14 first-party route and retain native ownership until complete', async () => {
  const h = harness(),
    cancel = new Cancellation(),
    file = await h.upload.pick(h.session, cancel);
  const effect = await h.upload.upload(
      h.grant,
      file,
      h.session,
      cancel,
      () => undefined,
    ),
    call = h.calls[0]!;
  assert.equal(
    call.url,
    `https://errand.invalid/v3/media/errands/upload-intents/${ids.intent}/uploads/${ids.grant}`,
  );
  assert.equal(call.name, 'file');
  assert.equal(
    call.header['Authorization'],
    `Bearer ${h.session.current().credentials!.accessToken}`,
  );
  call.success({ statusCode: 200, data: JSON.stringify(h.receipt) });
  assert.deepEqual(await effect.result, h.receipt);
  let removed = false;
  const cleanup = h.upload.remove(file).then(() => {
    removed = true;
  });
  await flush();
  assert.equal(removed, false);
  assert.equal(h.files.deleted.length, 0);
  call.complete();
  await effect.complete;
  await cleanup;
  assert.deepEqual(h.files.deleted, [h.path]);
  assert.equal(h.clock.timers, 0);
});
test('Cancelled errand upload retains the shared account writer and bytes until native complete, even across adapter instances', async () => {
  const h = harness(),
    cancel = new Cancellation(),
    file = await h.upload.pick(h.session, cancel);
  const effect = await h.upload.upload(
      h.grant,
      file,
      h.session,
      cancel,
      () => undefined,
    ),
    failure = assert.rejects(effect.result);
  cancel.cancel();
  await failure;
  assert.equal(h.aborts(), 1);
  assert.throws(() => h.registry.acquireTransfer(ids.actor));
  let removed = false;
  const cleanup = h.upload.remove(file).then(() => {
    removed = true;
  });
  await flush();
  assert.equal(removed, false);
  h.calls[0]!.success({ statusCode: 200, data: JSON.stringify(h.receipt) });
  await flush();
  assert.equal(removed, false);
  h.calls[0]!.complete();
  await effect.complete;
  await cleanup;
  const credit = h.registry.acquireTransfer(ids.actor);
  credit();
  assert.deepEqual(h.files.deleted, [h.path]);
  assert.equal(h.clock.timers, 0);
});
test('Errand upload decoders reject foreign protocol before native dispatch and share the ten MiB reservation budget', async () => {
  const h = harness(),
    cancel = new Cancellation(),
    file = await h.upload.pick(h.session, cancel);
  await assert.rejects(
    h.upload.upload(
      {
        ...h.grant,
        protocol: 'organization-media-v1' as typeof ERRAND_MEDIA_PROTOCOL,
      },
      file,
      h.session,
      cancel,
      () => undefined,
    ),
  );
  assert.equal(h.calls.length, 0);
  await h.upload.remove(file);
  const first = h.registry.reserve(),
    second = h.registry.reserve();
  try {
    await assert.rejects(h.upload.pick(h.session, new Cancellation()));
    assert.equal(h.picks(), 1);
  } finally {
    h.registry.releaseReservation(first);
    h.registry.releaseReservation(second);
  }
  assert.equal(h.clock.timers, 0);
});
