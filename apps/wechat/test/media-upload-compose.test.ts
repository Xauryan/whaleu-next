import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  ComposeController,
  type ComposeView,
} from '../src/pages/community-compose/controller';
import { createMediaUploadRuntime } from '../src/media/upload-runtime';
import { credentials, deferred } from './helpers';
import { setup } from './community-helpers';
import {
  ids,
  prepare,
  prepared,
  recovery,
  uploadHarness,
} from './support/media-upload-fixtures';
function compose(newRequestId: () => Promise<string> = async () => ids.draft) {
  const s = setup(),
    h = uploadHarness(),
    views: ComposeView[] = [];
  s.profiles.current = { ...s.profiles.current, accountId: ids.actor };
  const runtime = {
    ...s.runtime,
    sessions: h.sessions,
    newRequestId,
    mediaUpload: createMediaUploadRuntime({
      sessions: h.sessions,
      pending: h.pending,
      gateway: h.gateway,
      transfer: h.transfer,
      clock: h.clock,
      newRequestId: async () => ids.request,
    }),
  };
  const controller = new ComposeController(
    runtime,
    { operation: 'publish_post', spaceId: ids.space, category: 'discussion' },
    (view) => views.push(view),
  );
  return {
    ...h,
    compose: controller,
    view: () => views[views.length - 1]!,
    dispose() {
      controller.dispose();
      h.controller.dispose();
    },
  };
}
test('compose double tap coalesces before request ID/picker and preserves one immutable upload', async () => {
  const id = deferred<string>(),
    arrived = deferred<void>();
  let calls = 0;
  const h = compose(async () => {
    calls++;
    arrived.resolve();
    return id.promise;
  });
  await h.compose.load();
  await h.compose.recoverImage();
  const first = h.compose.selectImage(),
    second = h.compose.selectImage();
  assert.equal(first, second);
  await arrived.promise;
  assert.equal(calls, 1);
  assert.equal(h.calls.includes('pick'), false);
  assert.equal(h.view().mediaBusy, true);
  id.resolve(ids.draft);
  await first;
  assert.equal(h.calls.filter((call) => call === 'pick').length, 1);
  assert.equal(h.calls.filter((call) => call === 'prepare').length, 1);
  assert.equal(h.pending.load(ids.actor)?.clientRequestId, ids.request);
  assert.equal(h.view().mediaStatus, 'ready');
  assert.equal(h.view().mediaBusy, false);
  h.dispose();
});
test('compose hide/dispose before random ID resolves never opens late picker or renders old error', async () => {
  const id = deferred<string>(),
    arrived = deferred<void>();
  const h = compose(async () => {
    arrived.resolve();
    return id.promise;
  });
  await h.compose.load();
  await h.compose.recoverImage();
  const action = h.compose.selectImage();
  await arrived.promise;
  h.compose.dispose();
  const cleared = h.view();
  id.reject(new ClientError('network', 'Late ID failure'));
  await action;
  assert.deepEqual(h.view(), cleared);
  assert.equal(h.calls.includes('pick'), false);
  assert.equal(h.pending.load(ids.actor), null);
  h.dispose();
});
test('compose explicit cancel invalidates selection still awaiting random ID', async () => {
  const id = deferred<string>(),
    arrived = deferred<void>();
  const h = compose(async () => {
    arrived.resolve();
    return id.promise;
  });
  await h.compose.load();
  await h.compose.recoverImage();
  const selection = h.compose.selectImage();
  await arrived.promise;
  await h.compose.cancelImage();
  id.resolve(ids.draft);
  await selection;
  assert.equal(h.calls.includes('pick'), false);
  assert.equal(h.pending.load(ids.actor), null);
  assert.equal(h.view().mediaStatus, 'idle');
  h.dispose();
});
for (const kind of ['select', 'recover', 'cancel'] as const)
  test(`compose ${kind} late rejection after same-account relogin cannot overwrite replacement view`, async () => {
    const failed = deferred<never>(),
      arrived = deferred<void>();
    const h = compose(
      kind === 'select'
        ? async () => {
            arrived.resolve();
            return failed.promise;
          }
        : undefined,
    );
    await h.compose.load();
    await h.compose.recoverImage();
    if (kind !== 'select') {
      h.pending.freeze(ids.actor, prepare, 1000);
      h.setState(recovery(prepared()));
    }
    if (kind === 'recover')
      h.gateway.recover = async () => {
        arrived.resolve();
        return failed.promise;
      };
    if (kind === 'cancel')
      h.gateway.cancelRequest = async () => {
        arrived.resolve();
        return failed.promise;
      };
    const action =
      kind === 'select'
        ? h.compose.selectImage()
        : kind === 'recover'
          ? h.compose.recoverImage()
          : h.compose.cancelImage();
    await arrived.promise;
    h.sessions.completeLogin(
      h.sessions.beginLogin(),
      credentials(ids.actor, 'new-epoch'),
    );
    const replacement = h.view();
    failed.reject(new ClientError('network', 'Late old actor failure'));
    await action;
    assert.deepEqual(h.view(), replacement);
    if (kind !== 'select') assert.ok(h.pending.load(ids.actor));
    h.dispose();
  });
