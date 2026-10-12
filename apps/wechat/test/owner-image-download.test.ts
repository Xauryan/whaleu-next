import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { OwnerImageDownload } from '../src/media/owner-image-download';
import { OptionalMediaPrincipalOwner } from '../src/media/optional-principal';
import { MediaLocalFiles } from '../src/media/local-files';
import { Cancellation } from '../src/platform/contracts';
import type { WxMediaApi } from '../src/platform/wechat-media';
import { FakeClock, flush, signedIn } from './helpers';
import { DownloadCall, ReadFiles } from './support/media-read-fixtures';

function harness(
  failure: 'headers' | 'progress' | 'native',
  abortThrows = false,
  completeDuringRegistration = false,
) {
  const sessions = signedIn('synthetic-owner'),
    principals = new OptionalMediaPrincipalOwner(sessions),
    clock = new FakeClock(),
    files = new ReadFiles(),
    registry = new MediaLocalFiles(files),
    calls: DownloadCall[] = [];
  const wx: WxMediaApi = {
    downloadFile(options) {
      const call = new DownloadCall(options);
      calls.push(call);
      if (failure === 'native')
        throw new Error('Native task entered before synchronous throw');
      if (failure === 'headers')
        call.onHeadersReceived = () => {
          if (completeDuringRegistration) call.complete();
          throw new Error('Header listener registration failed');
        };
      else
        call.onProgressUpdate = () => {
          if (completeDuringRegistration) call.complete();
          throw new Error('Progress listener registration failed');
        };
      if (abortThrows)
        call.abort = () => {
          call.aborted++;
          throw new Error('Native abort failed');
        };
      return call;
    },
  };
  const create = () =>
    new OwnerImageDownload(
      'https://media.example',
      wx,
      files,
      registry,
      principals,
      { refresh: async () => sessions.snapshot() },
      clock,
      {
        decode: (value: { width: number; height: number }) => value,
        shape: (value) => value,
        path: () => '/v3/media/synthetic/controlled-image/display-v1',
      },
    );
  const download = (transfer = create()) =>
    transfer.download(
      { width: 80, height: 60 },
      'display-v1',
      {},
      { current: () => principals.snapshot() },
      new Cancellation(),
    );
  return {
    sessions,
    principals,
    clock,
    files,
    registry,
    calls,
    create,
    download,
  };
}

for (const failure of ['headers', 'progress'] as const)
  for (const abortThrows of [false, true])
    test(`owner image ${failure} registration throw keeps shared credit/reservation until late complete, abortThrows=${abortThrows}`, async () => {
      const h = harness(failure, abortThrows);
      try {
        const failed = h.download();
        await assert.rejects(
          failed,
          (error: unknown) =>
            error instanceof ClientError && error.kind === 'network',
        );
        assert.equal(h.calls.length, 1);
        assert.equal(h.calls[0]!.aborted, 1);
        assert.equal(h.clock.timers, 0);

        // A different owner using the same registry must see the abandoned task.
        const siblingTransfer = h.registry.acquireTransfer(
          'different-upload-owner',
        );
        assert.throws(() => h.registry.acquireTransfer());
        const siblingBytes = h.registry.reserve();
        assert.throws(() => h.registry.reserve(1));
        h.registry.releaseReservation(siblingBytes);
        await assert.rejects(h.download(h.create()), /capacity unavailable/);
        assert.equal(
          h.calls.length,
          1,
          'No replacement native task may bypass shared admission',
        );

        h.sessions.logout();
        assert.throws(
          () => h.registry.acquireTransfer(),
          'Account change cannot release a native task',
        );
        const latePath = `wxfile://tmp/late-${failure}-${abortThrows}.png`;
        h.files.put(latePath);
        h.calls[0]!.success(latePath);
        await flush();
        assert.ok(h.files.deleted.includes(latePath));
        assert.throws(
          () => h.registry.acquireTransfer(),
          'Late output cleanup is not native complete',
        );

        h.calls[0]!.complete();
        const available = h.registry.acquireTransfer();
        h.calls[0]!.complete();
        assert.throws(
          () => h.registry.acquireTransfer(),
          'Repeated complete releases exactly one credit',
        );
        available();
        siblingTransfer();
        const first = h.registry.reserve(),
          second = h.registry.reserve();
        h.registry.releaseReservation(first);
        h.registry.releaseReservation(second);
      } finally {
        h.principals.dispose();
      }
    });

test('native download call that throws after entry retains its unknown task until native complete', async () => {
  const h = harness('native');
  try {
    await assert.rejects(h.download());
    const other = h.registry.acquireTransfer();
    assert.throws(() => h.registry.acquireTransfer());
    h.calls[0]!.complete();
    const released = h.registry.acquireTransfer();
    released();
    other();
  } finally {
    h.principals.dispose();
  }
});

test('pre-entry principal revocation releases reservation and transfer without entering native download', async () => {
  const h = harness('headers');
  const schedule = h.clock.schedule.bind(h.clock);
  h.clock.schedule = (callback, ms) => {
    const stop = schedule(callback, ms);
    h.sessions.logout();
    return stop;
  };
  try {
    await assert.rejects(h.download());
    assert.equal(h.calls.length, 0);
    assert.equal(h.clock.timers, 0);
    const first = h.registry.acquireTransfer(),
      second = h.registry.acquireTransfer();
    first();
    second();
    const a = h.registry.reserve(),
      b = h.registry.reserve();
    h.registry.releaseReservation(a);
    h.registry.releaseReservation(b);
  } finally {
    h.principals.dispose();
  }
});

for (const failure of ['headers', 'progress'] as const)
  test(`owner image ${failure} registration throwing after synchronous complete never double-releases shared capacity`, async () => {
    const h = harness(failure, true, true);
    try {
      await assert.rejects(h.download());
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0]!.aborted, 1);
      assert.equal(h.clock.timers, 0);
      const first = h.registry.acquireTransfer(),
        second = h.registry.acquireTransfer();
      h.calls[0]!.complete();
      assert.throws(
        () => h.registry.acquireTransfer(),
        'Catch and repeated complete cannot decrement a completed task twice',
      );
      first();
      second();
      const handles = Array.from({ length: 4 }, () => h.registry.reserve(1));
      assert.throws(
        () => h.registry.reserve(1),
        'Every handle is still counted exactly once',
      );
      handles.forEach((handle) => h.registry.releaseReservation(handle));
      h.sessions.logout();
      const path = `wxfile://tmp/after-quiet-${failure}.png`;
      h.files.put(path);
      h.calls[0]!.success(path);
      h.calls[0]!.complete();
      await flush();
      assert.ok(h.files.deleted.includes(path));
      const available = Array.from({ length: 4 }, () => h.registry.reserve(1));
      available.forEach((handle) => h.registry.releaseReservation(handle));
    } finally {
      h.principals.dispose();
    }
  });
