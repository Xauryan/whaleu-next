import { uploadHarness, prepare } from './support/media-upload-fixtures';
import { createMediaUploadRuntime } from '../src/media/upload-runtime';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ComposeController,
  type ComposeView,
} from '../src/pages/community-compose/controller';
import {
  batchHarness,
  created,
  history,
  ids,
} from './support/media-batch-fixtures';
import { setup } from './community-helpers';
function compose() {
  const h = batchHarness(),
    s = setup(),
    views: ComposeView[] = [];
  s.profiles.current = { ...s.profiles.current, accountId: ids.actor };
  const runtime = {
    ...s.runtime,
    sessions: h.sessions,
    pending: h.publicationPending,
    mediaBatch: h.runtime,
    newRequestId: async () => ids.publication,
  };
  s.gateway.publishPostImpl = async (payload) => {
    assert.equal(payload.imageAssetIds.length, 3);
    assert.equal(h.pending.load(ids.actor)?.publication?.linkState, 'linked');
    const state = h.current();
    assert.equal(state.status, 'publication_pending');
    if (state.status !== 'publication_pending') throw new Error('Missing seal');
    h.setState(history(state));
    h.setReceipt(created());
    return created();
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
    gatewayCommunity: s.gateway,
    dispose() {
      controller.dispose();
      h.controller.dispose();
    },
  };
}
test('actual Compose controller publishes the complete batch only after seal and settles both keys', async () => {
  const h = compose();
  await h.compose.load();
  await h.compose.recoverImage();
  h.compose.setText('完整三张图片和正文。');
  assert.equal(h.view().mediaSelected, 3);
  assert.equal(h.view().mediaReady, 3);
  await h.compose.submit();
  assert.equal(
    h.gatewayCommunity.calls.filter((c) => c.method === 'publishPost').length,
    1,
  );
  assert.equal(h.pending.load(ids.actor), null);
  assert.equal(h.publicationPending.load(ids.actor), null);
  assert.equal(h.view().receiptStatus, '发布已确认');
  h.dispose();
});
test('actual Compose exposes explicit remove/reorder and never converts failed journal write into dispatch', async () => {
  const h = compose();
  await h.compose.load();
  await h.compose.recoverImage();
  h.compose.setText('不可丢失的草稿');
  h.storage.failWrite = true;
  await h.compose.submit();
  assert.equal(
    h.gatewayCommunity.calls.some((c) => c.method === 'publishPost'),
    false,
  );
  h.storage.failWrite = false;
  assert.equal(h.pending.load(ids.actor)?.members.length, 3);
  h.dispose();
});

test('installed batch runtime still resumes original legacy pending.v1 via unchanged legacy controller', async () => {
  const h = batchHarness(),
    s = setup(),
    legacy = uploadHarness();
  h.storage.remove(
    [...h.storage.data.keys()].find((key) =>
      key.startsWith('whaleu.media.batch.pending.v3:'),
    )!,
  );
  h.pending.legacy.freeze(ids.actor, prepare, 1000);
  s.profiles.current = { ...s.profiles.current, accountId: ids.actor };
  const views: ComposeView[] = [];
  const controller = new ComposeController(
    {
      ...s.runtime,
      sessions: h.sessions,
      pending: h.publicationPending,
      mediaBatch: h.runtime,
      mediaUpload: createMediaUploadRuntime({
        sessions: h.sessions,
        pending: h.pending.legacy,
        gateway: legacy.gateway,
        transfer: legacy.transfer,
        clock: h.clock,
        newRequestId: async () => ids.request,
      }),
    },
    { operation: 'publish_post', spaceId: ids.space, category: 'discussion' },
    (view) => views.push(view),
  );
  await controller.load();
  await controller.recoverImage();
  assert.equal(views[views.length - 1]?.batchMode, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.runtime.modeForActor(ids.actor), 'legacy');
  controller.dispose();
  h.controller.dispose();
  legacy.controller.dispose();
});
