import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  BlockMutationController,
  type BlockMutationView,
} from '../src/community/block-controller';
import type {
  BlockIntent,
  BlockResult,
  BlocksList,
} from '../src/community/block-contract';
import type { BlockGateway } from '../src/community/block-gateway';
import { PendingBlockStore } from '../src/community/block-pending';
import { SafetyChanges } from '../src/community/safety-changes';
import {
  BlocksController,
  type BlocksView,
} from '../src/pages/community-blocks/controller';
import {
  blockCandidate,
  blockEntry,
  blockIntent,
  blockResult,
} from './block-helpers';
import {
  intent,
  otherId,
  post,
  postId,
  requestId,
  setup,
} from './community-helpers';
import { deferred, flush } from './helpers';
import {
  FeedController,
  type FeedView,
} from '../src/pages/community-feed/controller';
import { wireCredentials } from './identity-helpers';
function harness() {
  const s = setup(),
    sent: BlockIntent[] = [],
    queried: string[] = [],
    views: BlockMutationView[] = [];
  const behavior: BlockGateway = {
    apply: async (value) => blockResult(value),
    receipt: async () => blockResult(sent[sent.length - 1]),
    list: async () => ({ items: [blockEntry()], nextCursor: null }),
    state: async () => ({
      relationshipId: otherId,
      blocked: true,
      revision: '1',
    }),
  };
  const blocks: BlockGateway = {
    ...behavior,
    apply: (...args) => {
      sent.push(args[0]);
      return behavior.apply(...args);
    },
    receipt: (...args) => {
      queried.push(args[0]);
      return behavior.receipt(...args);
    },
    list: (...args) => behavior.list(...args),
  };
  const runtime = {
    ...s.runtime,
    blocks,
    pendingBlocks: new PendingBlockStore(s.storage, 'synthetic'),
    safetyChanges: new SafetyChanges(s.runtime.privateViews),
  };
  const controller = new BlockMutationController(runtime, (view) =>
    views.push(view),
  );
  controller.load();
  return {
    ...s,
    runtime,
    behavior,
    controller,
    sent,
    queried,
    view: () => views[views.length - 1]!,
  };
}
test('named nonself confirmation never resolves anonymous/self targets, cancel and repeated clicks are safe', async () => {
  const s = harness();
  s.controller.requestBlock('post', post());
  s.controller.requestBlock('post', {
    ...blockCandidate(),
    viewer: { isSelf: true },
  });
  assert.equal(s.view().confirmSource, null);
  s.controller.requestBlock('post', blockCandidate());
  assert.deepEqual(s.view().confirmSource, { kind: 'post', id: postId });
  s.controller.dismissBlock();
  await s.controller.confirmBlock();
  assert.equal(s.sent.length, 0);
  s.controller.requestBlock('post', blockCandidate());
  s.controller.requestBlock('reply', { ...blockCandidate(), id: otherId });
  assert.equal(s.view().confirmSource?.kind, 'post');
  await s.controller.confirmBlock();
  assert.equal(s.sent.length, 1);
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().current?.blocked, true);
  assert.doesNotMatch(
    JSON.stringify(s.sent),
    /profileId|accountId|displayName/,
  );
});
test('freeze and readback precede dispatch, collapse repeat/opposite attempts and preserve all earlier journals', async () => {
  const s = harness(),
    pending = deferred<BlockResult>();
  s.runtime.pending.freeze({
    version: 1,
    accountId: s.accountId,
    operation: 'publish_post',
    payload: intent(),
  });
  s.runtime.pendingSaved.freeze({
    version: 1,
    accountId: s.accountId,
    operation: 'set_post_saved',
    postId,
    clientRequestId: requestId,
    desired: true,
    channel: null,
  });
  s.behavior.apply = async (value) => {
    assert.deepEqual(s.runtime.pendingBlocks.load(s.accountId)?.intent, value);
    return pending.promise;
  };
  s.controller.requestBlock('post', blockCandidate());
  const running = s.controller.confirmBlock();
  await s.controller.confirmBlock();
  await s.controller.unblock(blockEntry());
  await flush();
  assert.equal(s.sent.length, 1);
  assert.equal(s.view().frozen, true);
  pending.resolve(blockResult());
  await running;
  assert.equal(s.runtime.pendingBlocks.load(s.accountId), null);
  assert.ok(s.runtime.pending.load(s.accountId));
  assert.ok(s.runtime.pendingSaved.load(s.accountId));
});
test('lost response, retry, restart and current state never reapply stale historical blocked bit', async () => {
  const s = harness();
  s.behavior.apply = async () => {
    throw new ClientError('timeout', 'synthetic');
  };
  s.controller.requestBlock('post', blockCandidate());
  await s.controller.confirmBlock();
  const pending = s.runtime.pendingBlocks.load(s.accountId)!;
  s.controller.dispose();
  const views: BlockMutationView[] = [];
  const reopened = new BlockMutationController(s.runtime, (view) =>
    views.push(view),
  );
  reopened.load();
  assert.equal(views[views.length - 1]!.frozen, true);
  s.behavior.receipt = async () => {
    throw new ClientError('http', 'not found', {
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  await reopened.recover();
  assert.deepEqual(s.runtime.pendingBlocks.load(s.accountId), pending);
  s.behavior.apply = async (value) => blockResult(value, false, '2');
  await reopened.recover(true);
  assert.deepEqual(s.sent[1], pending.intent);
  assert.equal(views[views.length - 1]!.current?.blocked, false);
  assert.match(
    views[views.length - 1]!.receiptStatus,
    /原屏蔽请求.*当前未屏蔽/,
  );
  assert.equal(s.runtime.pendingBlocks.load(s.accountId), null);
});
test('matching terminal rejected receipts release only exact pending key and display no claimed state', async () => {
  const s = harness();
  s.behavior.apply = async (value) => ({
    receipt: {
      requestId: value.clientRequestId,
      operation: value.operation,
      outcome: 'rejected',
      code: 'PHONE_VERIFICATION_REQUIRED',
    },
    current: null,
  });
  s.controller.requestBlock('post', blockCandidate());
  await s.controller.confirmBlock();
  assert.equal(s.runtime.pendingBlocks.load(s.accountId), null);
  assert.equal(s.view().current, null);
  assert.match(s.view().receiptStatus, /手机号/);
  s.behavior.apply = async () =>
    blockResult({ ...blockIntent(), clientRequestId: otherId });
  s.controller.requestBlock('post', blockCandidate());
  await s.controller.confirmBlock();
  assert.ok(s.runtime.pendingBlocks.load(s.accountId));
  assert.equal(s.view().frozen, true);
});
test('independent unblock of unavailable display uses opaque relationship revision and preserves reverse relationship scope', async () => {
  const s = harness();
  await s.controller.unblock(blockEntry());
  assert.deepEqual(s.sent[0], {
    operation: 'unblock_named',
    relationshipId: otherId,
    expectedRevision: '1',
    blocked: false,
    clientRequestId: requestId,
  });
  assert.equal(s.view().current?.blocked, false);
  assert.equal(s.view().current?.relationshipId, otherId);
});
test('failed storage never dispatches, failed settlement retains barrier, and origin/account stores are isolated', async () => {
  const s = harness();
  s.storage.failWrite = true;
  s.controller.requestBlock('post', blockCandidate());
  await s.controller.confirmBlock();
  assert.equal(s.sent.length, 0);
  s.storage.failWrite = false;
  s.controller.load();
  s.storage.failRemove = true;
  s.controller.requestBlock('post', blockCandidate());
  await s.controller.confirmBlock();
  assert.equal(s.sent.length, 1);
  assert.equal(s.view().frozen, true);
  assert.ok(new PendingBlockStore(s.storage, 'synthetic').load(s.accountId));
  assert.equal(
    new PendingBlockStore(s.storage, 'other-origin').load(s.accountId),
    null,
  );
  assert.equal(s.runtime.pendingBlocks.load(otherId), null);
});
test('cancel before UUID persistence and account-switch late callbacks never settle or leak another account', async () => {
  const s = harness(),
    key = deferred<string>();
  s.runtime.newRequestId = () => key.promise;
  s.controller.requestBlock('post', blockCandidate());
  const before = s.controller.confirmBlock();
  await flush();
  s.controller.cancel();
  key.resolve(requestId);
  await before;
  assert.equal(s.sent.length, 0);
  s.runtime.newRequestId = async () => requestId;
  const result = deferred<BlockResult>();
  s.behavior.apply = () => result.promise;
  s.controller.requestBlock('post', blockCandidate());
  const running = s.controller.confirmBlock();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  result.resolve(blockResult());
  await running;
  assert.equal(s.view().current, null);
  assert.equal(s.view().frozen, false);
  assert.ok(s.runtime.pendingBlocks.load(s.accountId));
  assert.equal(s.runtime.pendingBlocks.load(otherId), null);
});
test('owner list pagination, pull reload and invalidation suppress pre-unblock delayed page restores', async () => {
  const s = harness(),
    views: BlocksView[] = [];
  let reads = 0;
  const delayed = deferred<BlocksList>();
  s.behavior.list = async (after) => {
    reads++;
    return after
      ? delayed.promise
      : { items: [blockEntry()], nextCursor: 'cursor' };
  };
  const list = new BlocksController(s.runtime, (view) => views.push(view));
  await list.load();
  const more = list.more();
  await flush();
  s.behavior.list = async () => ({ items: [], nextCursor: null });
  await s.controller.unblock(blockEntry());
  await flush();
  delayed.resolve({ items: [blockEntry()], nextCursor: null });
  await more;
  await flush();
  assert.equal(reads, 2);
  assert.deepEqual(views[views.length - 1]!.items, []);
  assert.equal(views[views.length - 1]!.loaded, true);
  list.dispose();
});
test('app hide preserves pending journal and clears transient confirmation and receipts', async () => {
  const s = harness(),
    result = deferred<BlockResult>();
  s.behavior.apply = () => result.promise;
  s.controller.requestBlock('post', blockCandidate());
  const running = s.controller.confirmBlock();
  await flush();
  s.runtime.privateViews!.clear();
  result.resolve(blockResult());
  await running;
  assert.equal(s.view().current, null);
  assert.equal(s.view().confirmSource, null);
  assert.ok(s.runtime.pendingBlocks.load(s.accountId));
});

test('known committed block invalidates stale feed even when journal cleanup fails', async () => {
  const s = harness(),
    views: FeedView[] = [];
  s.gateway.feedImpl = async () => ({
    items: [blockCandidate()],
    nextCursor: null,
    continuation: 'end',
  });
  const feed = new FeedController(s.runtime, (view) => views.push(view));
  await feed.load();
  assert.equal(views[views.length - 1]!.posts.length, 1);
  s.behavior.apply = async (value) => {
    s.gateway.feedImpl = async () => ({
      items: [],
      nextCursor: null,
      continuation: 'end',
    });
    return blockResult(value);
  };
  s.storage.failRemove = true;
  s.controller.requestBlock('post', blockCandidate());
  await s.controller.confirmBlock();
  await flush();
  assert.deepEqual(views[views.length - 1]!.posts, []);
  assert.equal(s.view().frozen, true);
  assert.match(s.view().error, /本地保存失败/);
  assert.ok(s.runtime.pendingBlocks.load(s.accountId));
  feed.dispose();
});

test('validated result clears content before journal persistence and releases other same-account barriers afterward', async () => {
  const s = harness(),
    peerViews: BlockMutationView[] = [];
  const peer = new BlockMutationController(s.runtime, (view) =>
    peerViews.push(view),
  );
  peer.load();
  let invalidated = false;
  s.runtime.safetyChanges.subscribe(() => {
    invalidated = true;
  });
  const remove = s.storage.remove.bind(s.storage);
  s.storage.remove = (key) => {
    assert.equal(invalidated, true);
    remove(key);
  };
  s.controller.requestBlock('post', blockCandidate());
  await s.controller.confirmBlock();
  await flush();
  assert.equal(peerViews[peerViews.length - 1]!.frozen, false);
  assert.equal(s.view().current?.blocked, true);
  peer.dispose();
});
test('mismatched terminal receipt cannot invalidate content or settle the original barrier', async () => {
  const s = harness();
  let invalidations = 0;
  s.runtime.safetyChanges.subscribe(() => {
    invalidations++;
  });
  s.behavior.apply = async () =>
    blockResult({ ...blockIntent(), clientRequestId: otherId });
  s.controller.requestBlock('post', blockCandidate());
  await s.controller.confirmBlock();
  assert.equal(invalidations, 0);
  assert.ok(s.runtime.pendingBlocks.load(s.accountId));
  assert.equal(s.view().current, null);
});

test('block invalidation preserves selected public feed category while rechecking current scope', async () => {
  const s = harness(),
    views: FeedView[] = [];
  const feed = new FeedController(s.runtime, (view) => views.push(view));
  await feed.load();
  await feed.setCategory('trading');
  await feed.setTradingSubtype('shuma');
  s.runtime.safetyChanges.invalidate(s.accountId);
  await flush();
  const view = views[views.length - 1]!;
  assert.equal(view.category, 'trading');
  assert.equal(view.tradingSubtype, 'shuma');
  const reads = s.gateway.calls.filter((call) => call.method === 'feed');
  assert.deepEqual(reads[reads.length - 1]!.args[0], {
    spaceId: view.space!.id,
    category: 'trading',
    tradingSubtype: 'shuma',
  });
  feed.dispose();
});
