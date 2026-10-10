/** Real page controllers. All gateway responses come from the loopback owner;
 * only canonical text Review issuance is requested from the PG fixture over IPC. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  RatingScopedController,
} = require('../../../../wechat/src/ratings/scoped-controller.ts');
const {
  HttpRatingScopedGateway,
} = require('../../../../wechat/src/ratings/scoped-gateway.ts');
const {
  RatingDeletionController,
} = require('../../../../wechat/src/ratings/deletion-controller.ts');
const {
  HttpRatingDeletionGateway,
} = require('../../../../wechat/src/ratings/deletion-gateway.ts');
const {
  HttpRatingsGateway,
} = require('../../../../wechat/src/ratings/gateway.ts');
const {
  HttpRatingDiscussionGateway,
} = require('../../../../wechat/src/ratings/discussion-gateway.ts');
export async function runCoveredInteractions(
  runtime,
  api,
  targetId,
  receipts,
  deletions,
) {
  Object.assign(runtime, {
    ratingScoped: new HttpRatingScopedGateway(api, runtime.sessions),
    newRequestId: async () => randomUUID(),
    ratings: new HttpRatingsGateway(api),
    ratingDiscussion: new HttpRatingDiscussionGateway(api),
    ratingDeletion: new HttpRatingDeletionGateway(api),
  });
  const actor = runtime.sessions.snapshot().credentials.accountId;
  let rootId, replyId;
  const act = async (mode, operation, action) => {
    let view;
    const controller = new RatingScopedController(runtime, (value) => {
      view = value;
    });
    try {
      await controller.load({
        mode,
        scope: 'global',
        targetId,
        ...(mode === 'thread' ? { rootId } : {}),
      });
      assert.equal(view.detail?.id, targetId, JSON.stringify(view));
      const before = receipts.length;
      await action(controller);
      assert.equal(receipts.length, before + 1, JSON.stringify(view));
      const receipt = receipts.at(-1);
      assert.equal(receipt.operation, operation);
      assert.equal(receipt.outcome, 'applied');
      assert.equal(runtime.pendingRatings.load(actor), null);
      return receipt;
    } finally {
      controller.dispose();
    }
  };
  await act('detail', 'set_score_scoped', async (c) => {
    c.chooseScore(5);
    await c.confirmScore();
  });
  rootId = (
    await act('detail', 'create_comment_scoped', async (c) => {
      c.openComposer();
      c.setAuthorMode('named');
      c.setText('Native real HTTP covered comment');
      await c.publish();
    })
  ).result.subjectId;
  replyId = (
    await act('thread', 'create_reply_scoped', async (c) => {
      c.openComposer();
      c.setAuthorMode('named');
      c.setText('Native real HTTP covered reply');
      await c.publish();
    })
  ).result.replyId;
  await act('detail', 'set_comment_like_scoped', (c) => c.toggleLike(rootId));
  await act('thread', 'set_reply_like_scoped', (c) => c.toggleLike(replyId));
  await act('detail', 'set_target_subscription_scoped', (c) =>
    c.toggleSubscription(targetId),
  );
  for (const [subjectKind, subjectId] of [
    ['reply', replyId],
    ['comment', rootId],
  ]) {
    let view;
    const controller = new RatingDeletionController(runtime, (value) => {
      view = value;
    });
    try {
      await controller.load({ subjectKind, targetId, rootId, subjectId });
      await controller.readContext('owner');
      assert.equal(view.canConfirm, true, JSON.stringify(view));
      const before = deletions.length;
      await controller.confirmDelete();
      assert.equal(deletions.length, before + 1, JSON.stringify(view));
      assert.equal(deletions.at(-1).outcome, 'applied');
      assert.equal(runtime.pendingRatings.load(actor), null);
    } finally {
      controller.dispose();
    }
  }
  return { rootId, replyId };
}
