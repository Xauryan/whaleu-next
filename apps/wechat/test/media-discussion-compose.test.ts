import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ComposeController,
  type ComposeTarget,
  type ComposeView,
} from '../src/pages/community-compose/controller';
import {
  batchHarness,
  created,
  history,
  identity,
  ids,
  uuid,
} from './support/media-discussion-fixtures';
import { setup, post, comment, reply } from './community-helpers';
import type { BatchIdentity } from '../src/media/discussion-batch-contracts';

function fixture(target: BatchIdentity) {
  const h = batchHarness(3, target),
    s = setup(),
    views: ComposeView[] = [];
  s.profiles.current = { ...s.profiles.current, accountId: ids.actor };
  s.gateway.postImpl = async () =>
    post({
      id: uuid(50),
      space: { id: ids.space, kind: 'regional', name: 'Synthetic space' },
    });
  s.gateway.commentImpl = async () =>
    comment({ id: uuid(51), postId: uuid(50) });
  s.gateway.replyImpl = async () =>
    reply({ id: uuid(52), postId: uuid(50), rootCommentId: uuid(51) });
  const operation =
    target.target.kind === 'comment' ? 'publish_comment' : 'publish_reply';
  const publish = () => {
    const state = h.current();
    if (state.status !== 'publication_pending')
      throw new Error('Missing frozen seal');
    h.setState(history(state));
    const receipt = created(operation);
    h.setReceipt(receipt);
    return receipt;
  };
  s.gateway.publishCommentImpl = async (id, payload) => {
    assert.equal(id, uuid(50));
    assert.equal(payload.text, '');
    assert.equal(payload.imageAssetIds.length, 3);
    return publish();
  };
  s.gateway.publishReplyImpl = async (id, payload) => {
    assert.equal(id, uuid(51));
    assert.equal(payload.text, '');
    assert.equal(payload.imageAssetIds.length, 3);
    assert.equal(
      payload.targetReplyId,
      target.target.kind === 'reply' ? target.target.targetReplyId : null,
    );
    return publish();
  };
  const composeTarget: ComposeTarget =
    target.target.kind === 'comment'
      ? { operation: 'publish_comment', postId: uuid(50) }
      : {
          operation: 'publish_reply',
          postId: uuid(50),
          rootCommentId: uuid(51),
          targetReplyId: target.target.targetReplyId,
        };
  const controller = new ComposeController(
    {
      ...s.runtime,
      sessions: h.sessions,
      pending: h.publicationPending,
      mediaBatch: h.runtime,
      newRequestId: async () => ids.publication,
    },
    composeTarget,
    (v) => views.push(v),
  );
  return {
    ...h,
    compose: controller,
    gatewayCommunity: s.gateway,
    view: () => views[views.length - 1]!,
    dispose() {
      controller.dispose();
      h.controller.dispose();
    },
  };
}
for (const target of [
  identity,
  {
    ...identity,
    purpose: 'community-reply-images',
    target: { kind: 'reply', rootCommentId: uuid(51), targetReplyId: null },
  },
  {
    ...identity,
    purpose: 'community-reply-images',
    target: { kind: 'reply', rootCommentId: uuid(51), targetReplyId: uuid(52) },
  },
] as readonly BatchIdentity[]) {
  test(`Compose sends pure-image ${target.target.kind} with exact complete three-image batch`, async () => {
    const h = fixture(target);
    await h.compose.load();
    await h.compose.recoverImage();
    assert.equal(h.view().text, '');
    assert.equal(h.view().maxImages, 3);
    assert.equal(h.view().canSubmit, true);
    await h.compose.submit();
    assert.equal(h.view().receiptStatus, '发布已确认');
    assert.equal(h.pending.load(ids.actor), null);
    assert.equal(h.publicationPending.load(ids.actor), null);
    h.dispose();
  });
}
test('Compose refuses empty discussion with no images', async () => {
  const h = fixture(identity);
  for (const key of h.storage.data.keys())
    if (key.startsWith('whaleu.media.batch.pending.v4:')) h.storage.remove(key);
  await h.compose.load();
  await h.compose.recoverImage();
  assert.equal(h.view().canSubmit, false);
  await h.compose.submit();
  assert.equal(
    h.gatewayCommunity.calls.some((c) => c.method === 'publishComment'),
    false,
  );
  h.dispose();
});
