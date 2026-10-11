import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { ActivityMediaService } from '../src/activities/media/facade.js';
import type { ActivityMediaSlot } from '../src/media/contracts-activity.js';
function harness() {
  const service = Object.create(
    ActivityMediaService.prototype,
  ) as ActivityMediaService;
  const calls: {
    activityId: string;
    slot: ActivityMediaSlot;
    bindingId: string;
  }[] = [];
  const assetId = randomUUID(),
    manifestDigest = 'a'.repeat(64);
  Object.defineProperty(service, 'assets', {
    value: {
      async requireCurrentBinding(
        activityId: string,
        slot: ActivityMediaSlot,
        bindingId: string,
      ) {
        calls.push({ activityId, slot, bindingId });
        return { assetId, manifestDigest };
      },
    },
  });
  return { service, calls, assetId, manifestDigest };
}
test('Activity publication requires cover independently of optional gallery', async () => {
  const h = harness(),
    tx = {} as PoolClient,
    activity = randomUUID();
  await assert.rejects(
    h.service.requireCurrentBindings(activity, { gallery0: randomUUID() }, tx, {
      requireCover: true,
    }),
  );
  assert.equal(h.calls.length, 0);
  await h.service.requireCurrentBindings(
    activity,
    { cover: randomUUID() },
    tx,
    { requireCover: true },
  );
  assert.equal(h.calls[0]?.slot, 'cover');
});
test('Activity review includes only exact current image facts in fixed slot order', async () => {
  const h = harness(),
    tx = {} as PoolClient,
    activity = randomUUID(),
    cover = randomUUID(),
    gallery = randomUUID();
  const facts = await h.service.reviewFacts(
    activity,
    { gallery8: gallery, cover, gallery0: null },
    tx,
  );
  assert.deepEqual(h.calls, [
    { activityId: activity, slot: 'cover', bindingId: cover },
    { activityId: activity, slot: 'gallery8', bindingId: gallery },
  ]);
  assert.deepEqual(facts, [
    { slot: 'cover', assetId: h.assetId, manifestDigest: h.manifestDigest },
    { slot: 'gallery8', assetId: h.assetId, manifestDigest: h.manifestDigest },
  ]);
  assert.ok(Object.isFrozen(facts) && facts.every(Object.isFrozen));
  await assert.rejects(
    h.service.reviewFacts(activity, { cover, gallery0: cover }, tx),
  );
  assert.equal(h.calls.length, 2);
});
test('A missing or revoked independent image proof blocks activity review', async () => {
  const h = harness(),
    activity = randomUUID();
  h.service.assets.requireCurrentBinding = async () => {
    throw new Error('Current image Safety unavailable');
  };
  await assert.rejects(
    h.service.reviewFacts(activity, { cover: randomUUID() }, {} as PoolClient),
    /Current image Safety unavailable/,
  );
});

test('Original draft retirement requires its actor, revision and exact old pointers without live organization or image approval', async () => {
  const h = harness(),
    actor = randomUUID(),
    activity = randomUUID(),
    binding = randomUUID();
  let retired = 0;
  h.service.assets.retireDraft = async (input) => {
    retired++;
    assert.equal(input.actorAccountId, actor);
    assert.deepEqual(input.currentBindings, { cover: binding });
    return { cover: null };
  };
  const tx = {
    query: async () => ({
      rows: [
        {
          account_id: actor,
          revision: '2',
          media_bindings: { cover: binding },
        },
      ],
    }),
  } as unknown as PoolClient;
  const input = {
    actorAccountId: actor,
    activityId: activity,
    revision: 2,
    currentBindings: { cover: binding },
  };
  assert.deepEqual(await h.service.retireDraft(input, tx), { cover: null });
  assert.equal(retired, 1);
  assert.equal(h.calls.length, 0);
  for (const patch of [
    { actorAccountId: randomUUID() },
    { revision: 1 },
    { currentBindings: {} },
  ])
    await assert.rejects(h.service.retireDraft({ ...input, ...patch }, tx));
  assert.equal(retired, 1);
});
