import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  BlockMutationController,
  initialBlockMutationView,
} from '../src/community/block-controller';
import type { BlockGateway } from '../src/community/block-gateway';
import { PendingBlockStore } from '../src/community/block-pending';
import { blockResult } from './block-helpers';
import {
  namedPost,
  profileId,
  publicProfile,
  discoverySetup,
} from './discovery-helpers';
import { otherId } from './community-helpers';
import { deferred, flush } from './helpers';
import type { BlockIntent, BlockResult } from '../src/community/block-contract';
function setup() {
  const s = discoverySetup(),
    pendingBlocks = new PendingBlockStore(s.storage, 'https://api.example');
  let view = initialBlockMutationView();
  const sent: BlockIntent[] = [];
  const behavior: { apply: BlockGateway['apply'] } = {
    apply: async (intent) => blockResult(intent),
  };
  const blocks: BlockGateway = {
    apply: async (intent, cancel) => {
      sent.push(intent);
      return behavior.apply(intent, cancel);
    },
    receipt: async () => blockResult(sent[0]!),
    list: async () => ({ items: [], nextCursor: null }),
    state: async () => ({
      relationshipId: otherId,
      blocked: true,
      revision: '1',
    }),
  };
  const controller = new BlockMutationController(
    { ...s.runtime, pendingBlocks, blocks },
    (next) => (view = next),
  );
  controller.load();
  return { ...s, pendingBlocks, controller, sent, behavior, view: () => view };
}
test('profile block requires actual available nonself DTO and cannot enter through forged content source', async () => {
  const s = setup();
  s.controller.requestBlock('profile' as never, namedPost());
  assert.equal(s.view().confirmSource, null);
  for (const value of [
    publicProfile({ isOwn: true }),
    { status: 'unavailable', profileId },
    { ...publicProfile(), accountId: otherId },
  ]) {
    s.controller.requestProfileBlock(value as never);
    assert.equal(s.view().confirmSource, null);
  }
  s.controller.requestProfileBlock(publicProfile());
  assert.deepEqual(s.view().confirmSource, { kind: 'profile', id: profileId });
  assert.equal(s.sent.length, 0);
  s.controller.dismissBlock();
  await s.controller.confirmBlock();
  assert.equal(s.sent.length, 0);
  s.controller.requestProfileBlock(publicProfile());
  await s.controller.confirmBlock();
  assert.equal(s.sent.length, 1);
  assert.deepEqual(
    s.sent[0]!.operation === 'block_named' ? s.sent[0]!.source : null,
    { kind: 'profile', id: profileId },
  );
  assert.equal(s.pendingBlocks.load(s.accountId), null);
});
test('lost profile block result keeps original public source and owner journal; recovery cannot issue opposite request', async () => {
  const s = setup();
  s.behavior.apply = async () => {
    throw new ClientError('timeout', 'safe');
  };
  s.controller.requestProfileBlock(publicProfile());
  await s.controller.confirmBlock();
  assert.equal(s.view().frozen, true);
  const pending = s.pendingBlocks.load(s.accountId);
  assert.ok(pending);
  assert.ok(JSON.stringify(pending.intent).includes(profileId));
  assert.equal(JSON.stringify(pending.intent).includes('displayName'), false);
  await s.controller.unblockProfile({
    status: 'blocked_by_you',
    profileId,
    relationship: { relationshipId: otherId, blocked: true, revision: '1' },
  });
  assert.equal(s.sent.length, 1);
  await s.controller.recover();
  assert.equal(s.pendingBlocks.load(s.accountId), null);
});
test('profile block late result after app hide cannot repopulate current state and replay remains account-owned', async () => {
  const s = setup(),
    pending = deferred<BlockResult>();
  s.behavior.apply = () => pending.promise;
  s.controller.requestProfileBlock(publicProfile());
  const running = s.controller.confirmBlock();
  await flush();
  s.runtime.privateViews!.clear();
  assert.equal(s.view().current, null);
  pending.resolve(blockResult(s.sent[0]!));
  await running;
  assert.equal(s.view().current, null);
  assert.ok(s.pendingBlocks.load(s.accountId));
});
test('outgoing-profile unblock uses only safe relationship revision, incoming unavailable cannot unblock', async () => {
  const s = setup();
  await s.controller.unblockProfile({ status: 'unavailable', profileId });
  assert.equal(s.sent.length, 0);
  await s.controller.unblockProfile({
    status: 'blocked_by_you',
    profileId,
    relationship: { relationshipId: otherId, blocked: true, revision: '1' },
  });
  assert.equal(s.sent[0]!.operation, 'unblock_named');
  assert.equal('source' in s.sent[0]!, false);
});
