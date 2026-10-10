import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import type { WxMediaApi } from '../src/platform/wechat-media';
import type { WxUploadApi } from '../src/platform/wechat-upload';
import { MediaLocalFiles } from '../src/media/local-files';
import { MediaGalleryController } from '../src/media/gallery-controller';
import type { MediaReadTransfer } from '../src/media/authenticated-download';
import { AvatarReadController } from '../src/profile/avatar-read-controller';
import { AvatarPrincipalOwner } from '../src/profile/avatar-principal';
import { ProfileAvatarDownload } from '../src/profile/avatar-download';
import { ProfileAvatarUpload } from '../src/profile/avatar-upload';
import { FakeClock, deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  ReadFiles,
  DownloadCall,
  imageHeaders,
  attachment,
} from './support/media-read-fixtures';
import {
  avatarCurrent,
  avatarGrant,
  avatarIds,
  FakeAvatarGateway,
} from './support/avatar-fixtures';
import { PROFILE_MEDIA_PROTOCOL as protocol } from '../src/profile/avatar-contract';
const origin = 'https://api.example.test';
function readHarness() {
  const sessions = new SessionStore(),
    principals = new AvatarPrincipalOwner(sessions),
    files = new ReadFiles(),
    clock = new FakeClock(),
    registry = new MediaLocalFiles(files),
    calls: DownloadCall[] = [];
  const wx: WxMediaApi = {
    downloadFile(options) {
      const call = new DownloadCall(options);
      calls.push(call);
      return call;
    },
  };
  const download = new ProfileAvatarDownload(
    origin,
    wx,
    files,
    registry,
    principals,
    { refresh: async () => sessions.snapshot() },
    clock,
  );
  const principal = principals.snapshot(),
    context = {
      current: () => {
        principals.assertCurrent(principal);
        return principals.snapshot();
      },
    };
  return {
    sessions,
    principals,
    files,
    clock,
    registry,
    calls,
    download,
    context,
    principal,
  };
}
test('guest download uses only current appearance route and has no fake Authorization/session credential', async () => {
  const s = readHarness(),
    owner = {};
  const pending = s.download.download(
    avatarCurrent,
    'display-v1',
    owner,
    s.context,
    new Cancellation(),
  );
  await flush();
  const call = s.calls[0]!;
  assert.equal(
    call.options.url,
    `${origin}/v1/profiles/${avatarIds.profile}/avatar/${avatarIds.appearance}/display-v1`,
  );
  assert.deepEqual(call.options.header, {});
  const path = 'wxfile://tmp/profile-avatar.png';
  s.files.put(path);
  call.headers({ ...imageHeaders(), 'x-content-type-options': 'nosniff' });
  call.success(path);
  call.complete();
  const file = await pending;
  assert.equal(await s.download.resolve(file, owner, s.principal), path);
  await assert.rejects(s.registry.resolve(file, owner, s.sessions.snapshot()));
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
  await assert.rejects(s.download.resolve(file, owner, s.principal));
  await s.download.release(file);
  assert.deepEqual(s.files.deleted, [path]);
});
test('Profile guest and Community session leases/IO share the same hard limits', async () => {
  const s = readHarness(),
    first = s.registry.acquireTransfer(),
    second = s.registry.acquireTransfer();
  await assert.rejects(
    s.download.download(
      avatarCurrent,
      'display-v1',
      {},
      s.context,
      new Cancellation(),
    ),
  );
  assert.equal(s.calls.length, 0);
  first();
  second();
  const a = s.registry.reserve(),
    b = s.registry.reserve();
  assert.throws(() => s.registry.reserve(1));
  s.registry.releaseReservation(a);
  s.registry.releaseReservation(b);
  const owner = {},
    guest = {};
  for (let i = 0; i < 4; i++) {
    const path = `wxfile://tmp/guest-${i}.png`;
    s.files.put(path);
    s.registry.adoptGuest(path, 100, owner, guest);
  }
  assert.equal(s.registry.capacityAvailable, false);
  assert.throws(() => s.registry.reserve(1));
});
test('late guest native callback is removed after principal change and never adopted', async () => {
  const s = readHarness(),
    cancel = new Cancellation();
  const pending = s.download.download(
    avatarCurrent,
    'display-v1',
    {},
    s.context,
    cancel,
  );
  const rejected = assert.rejects(pending);
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
  cancel.cancel();
  const path = 'wxfile://tmp/old-guest.png';
  s.files.put(path);
  s.calls[0]!.success(path);
  s.calls[0]!.complete();
  await rejected;
  await flush();
  assert.ok(s.files.deleted.includes(path));
});
test('shared system picker generation, concrete multipart receipt, and byte declaration remain Profile-only', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const files = Object.assign(new ReadFiles(), {
    digest: async () => 'a'.repeat(64),
  });
  const registry = new MediaLocalFiles(files),
    clock = new FakeClock();
  const uploadStarted =
    deferred<Parameters<NonNullable<WxUploadApi['uploadFile']>>[0]>();
  const wx: WxUploadApi = {
    chooseMedia(options) {
      options.success({
        tempFiles: [
          {
            tempFilePath: 'wxfile://tmp/chosen-avatar.png',
            size: 100,
            fileType: 'image',
          },
        ],
      });
      options.complete();
    },
    uploadFile(options) {
      uploadStarted.resolve(options);
      return { abort() {} };
    },
  };
  const transfer = new ProfileAvatarUpload(
    origin,
    wx,
    files,
    registry,
    sessions,
    clock,
  );
  const ticket = sessions.snapshot(),
    session = {
      current: () => {
        sessions.assertCurrent(ticket);
        return sessions.snapshot();
      },
    },
    cancel = new Cancellation();
  const path = 'wxfile://tmp/chosen-avatar.png';
  files.put(path);
  const file = await transfer.pick(session, cancel);
  assert.equal(
    (await transfer.inspect(file, session, cancel)).sha256,
    'a'.repeat(64),
  );
  const handle = transfer.register(avatarGrant, session);
  const pending = transfer.upload(
    handle,
    file,
    () => undefined,
    session,
    cancel,
  );
  // Selection inspection and capability resolution may take any number of
  // microtasks. Wait for the actual native dispatch, and propagate early failure.
  const uploadOptions = await Promise.race([
    uploadStarted.promise,
    pending.then(() => assert.fail('Upload finished without native dispatch')),
  ]);
  assert.equal(
    uploadOptions.url,
    `${origin}/v1/me/profile/avatar-edits/${avatarIds.edit}/uploads/${avatarIds.grant}`,
  );
  assert.equal(uploadOptions.name, 'file');
  assert.ok(uploadOptions.header.Authorization);
  uploadOptions.success({
    statusCode: 200,
    data: JSON.stringify({
      protocol,
      status: 'uploadObserved',
      editId: avatarIds.edit,
      intentId: avatarIds.intent,
      generation: '1',
      grantId: avatarIds.grant,
      bytes: 100,
      sha256: 'a'.repeat(64),
      next: 'finalize',
    }),
  });
  uploadOptions.complete();
  assert.equal((await pending).protocol, protocol);
  transfer.clearSession(ticket);
  await flush();
  assert.ok(files.deleted.includes(path));
});
test('system picker cancellation and complete release reservation and permit another normal selection', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const files = Object.assign(new ReadFiles(), {
      digest: async () => 'a'.repeat(64),
    }),
    registry = new MediaLocalFiles(files),
    clock = new FakeClock();
  const calls: Parameters<NonNullable<WxUploadApi['chooseMedia']>>[0][] = [];
  const transfer = new ProfileAvatarUpload(
    origin,
    {
      chooseMedia(options) {
        calls.push(options);
      },
    },
    files,
    registry,
    sessions,
    clock,
  );
  const ticket = sessions.snapshot(),
    session = {
      current: () => {
        sessions.assertCurrent(ticket);
        return sessions.snapshot();
      },
    };
  const cancelled = transfer.pick(session, new Cancellation()),
    rejected = assert.rejects(cancelled);
  assert.equal(calls.length, 1);
  const io1 = registry.acquireTransfer(),
    io2 = registry.acquireTransfer();
  io1();
  io2();
  const states: string[] = [];
  const stop = transfer.subscribePicker(() =>
    states.push(transfer.pickerState),
  );
  calls[0]!.fail({ errMsg: 'chooseMedia:fail cancel' });
  assert.equal(transfer.pickerState, 'waiting-native');
  calls[0]!.complete();
  await rejected;
  assert.equal(transfer.pickerState, 'ready');
  assert.deepEqual(states, ['ready']);
  stop();
  const a = registry.reserve(),
    b = registry.reserve();
  registry.releaseReservation(a);
  registry.releaseReservation(b);
  const selecting = transfer.pick(session, new Cancellation());
  assert.equal(calls.length, 2);
  const path = 'wxfile://tmp/reselected.png';
  files.put(path);
  calls[1]!.success({
    tempFiles: [{ tempFilePath: path, size: 100, fileType: 'image' }],
  });
  calls[1]!.complete();
  const file = await selecting;
  assert.equal(await transfer.preview(file, session, new Cancellation()), path);
  await transfer.remove(file);
});
test('system picker abort does not release an uncompleted native allocation and a late old result is discarded', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const files = Object.assign(new ReadFiles(), {
      digest: async () => 'a'.repeat(64),
    }),
    registry = new MediaLocalFiles(files),
    clock = new FakeClock();
  const calls: Parameters<NonNullable<WxUploadApi['chooseMedia']>>[0][] = [];
  const transfer = new ProfileAvatarUpload(
    origin,
    {
      chooseMedia(options) {
        calls.push(options);
      },
    },
    files,
    registry,
    sessions,
    clock,
  );
  const ticket = sessions.snapshot(),
    session = {
      current: () => {
        sessions.assertCurrent(ticket);
        return sessions.snapshot();
      },
    },
    cancel = new Cancellation();
  const selected = transfer.pick(session, cancel),
    rejected = assert.rejects(selected);
  cancel.cancel();
  await rejected;
  const held = registry.reserve();
  assert.throws(() => registry.reserve(1));
  registry.releaseReservation(held);
  sessions.completeLogin(sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: avatarIds.other,
  });
  const path = 'wxfile://tmp/late-system-picker.png';
  files.put(path);
  calls[0]!.success({
    tempFiles: [{ tempFilePath: path, size: 100, fileType: 'image' }],
  });
  calls[0]!.complete();
  await flush();
  assert.ok(files.deleted.includes(path));
  const current = sessions.snapshot(),
    newSession = {
      current: () => {
        sessions.assertCurrent(current);
        return sessions.snapshot();
      },
    };
  const again = transfer.pick(newSession, new Cancellation()),
    againRejected = assert.rejects(again);
  calls[1]!.fail({ errMsg: 'chooseMedia:fail cancel' });
  calls[1]!.complete();
  await againRejected;
});

test('avatar admission does not preempt an automatic Community gallery and actor change revokes both owners', async () => {
  const s = readHarness();
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
  let sequence = 0;
  const community: MediaReadTransfer = {
    async download(_image, _variant, owner, session) {
      const credit = s.registry.acquireTransfer();
      try {
        const reservation = s.registry.reserve();
        const path = `wxfile://tmp/community-kept-${++sequence}.png`;
        s.files.put(path);
        return s.registry.adopt(
          path,
          100,
          owner,
          session.current(),
          reservation,
        );
      } finally {
        credit();
      }
    },
    resolve: (file, owner, ticket) => s.registry.resolve(file, owner, ticket),
    release: (file) => s.registry.release(file),
  };
  const gallery = new MediaGalleryController(
    s.sessions,
    community,
    () => undefined,
  );
  await gallery.load(
    [1, 2, 3].map((n) => ({
      ...attachment,
      assetId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      bindingId: `00000000-0000-4000-8000-${String(n + 10).padStart(12, '0')}`,
    })),
  );
  const prior = gallery.snapshot();
  assert.equal(prior.slots.filter((slot) => slot.localSrc).length, 3);
  const reader = new AvatarReadController(
    s.principals,
    new FakeAvatarGateway(),
    s.download,
    s.clock,
    () => undefined,
  );
  const occupied = s.registry.reserve();
  await reader.load(avatarIds.profile);
  assert.equal(reader.snapshot().status, 'unavailable');
  assert.equal(s.calls.length, 0);
  assert.deepEqual(gallery.snapshot(), prior);
  assert.deepEqual(s.files.deleted, []);
  s.registry.releaseReservation(occupied);
  const finishAvatar = async (index: number) => {
    const loading = reader.load(avatarIds.profile);
    await flush();
    const path = `wxfile://tmp/non-preemptive-avatar-${index}.png`;
    s.files.put(path);
    const call = s.calls[index]!;
    call.headers({ ...imageHeaders(), 'x-content-type-options': 'nosniff' });
    call.success(path);
    call.complete();
    await loading;
  };
  await finishAvatar(0);
  assert.equal(reader.snapshot().status, 'ready');
  assert.deepEqual(gallery.snapshot(), prior);
  reader.clear();
  await flush();
  assert.equal(reader.snapshot().localSrc, '');
  assert.equal(s.calls.length, 1);
  assert.deepEqual(gallery.snapshot(), prior);
  await finishAvatar(1);
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: avatarIds.other,
  });
  assert.equal(reader.snapshot().localSrc, '');
  assert.ok(gallery.snapshot().slots.every((slot) => !slot.localSrc));
  await flush();
  gallery.dispose();
  reader.dispose();
});
