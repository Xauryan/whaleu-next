import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { AnnouncementMediaService } from '../src/announcements/media/facade.js';
import type { AnnouncementMediaSlot } from '../src/media/contracts-announcement.js';
function harness() {
  const service = Object.create(
    AnnouncementMediaService.prototype,
  ) as AnnouncementMediaService;
  const calls: {
    announcementId: string;
    slot: AnnouncementMediaSlot;
    bindingId: string;
  }[] = [];
  const assetId = randomUUID(),
    manifestDigest = 'a'.repeat(64);
  Object.defineProperty(service, 'assets', {
    value: {
      async requireCurrentBinding(
        announcementId: string,
        slot: AnnouncementMediaSlot,
        bindingId: string,
      ) {
        calls.push({ announcementId, slot, bindingId });
        return { assetId, manifestDigest };
      },
    },
  });
  return { service, calls, assetId, manifestDigest };
}
test('Announcement text-only and nine optional images never require a cover', async () => {
  const h = harness(),
    tx = {} as PoolClient,
    announcement = randomUUID();
  await h.service.requireCurrentBindings(announcement, {}, tx);
  assert.equal(h.calls.length, 0);
  await h.service.requireCurrentBindings(
    announcement,
    { gallery8: randomUUID() },
    tx,
  );
  assert.equal(h.calls[0]?.slot, 'gallery8');
});
test('Announcement review includes only exact current image facts in fixed slot order', async () => {
  const h = harness(),
    tx = {} as PoolClient,
    announcement = randomUUID(),
    gallery0 = randomUUID(),
    gallery = randomUUID();
  const facts = await h.service.reviewFacts(
    announcement,
    { gallery8: gallery, gallery0, gallery1: null },
    tx,
  );
  assert.deepEqual(h.calls, [
    { announcementId: announcement, slot: 'gallery0', bindingId: gallery0 },
    { announcementId: announcement, slot: 'gallery8', bindingId: gallery },
  ]);
  assert.deepEqual(facts, [
    { slot: 'gallery0', assetId: h.assetId, manifestDigest: h.manifestDigest },
    { slot: 'gallery8', assetId: h.assetId, manifestDigest: h.manifestDigest },
  ]);
  assert.ok(Object.isFrozen(facts) && facts.every(Object.isFrozen));
  await assert.rejects(
    h.service.reviewFacts(announcement, { gallery0, gallery1: gallery0 }, tx),
  );
  assert.equal(h.calls.length, 2);
});
test('A missing or revoked independent image proof blocks announcement review', async () => {
  const h = harness(),
    announcement = randomUUID();
  h.service.assets.requireCurrentBinding = async () => {
    throw new Error('Current image Safety unavailable');
  };
  await assert.rejects(
    h.service.reviewFacts(
      announcement,
      { gallery0: randomUUID() },
      {} as PoolClient,
    ),
    /Current image Safety unavailable/,
  );
});

test('Original draft retirement requires its actor, revision and exact old pointers without live management or image approval', async () => {
  const h = harness(),
    actor = randomUUID(),
    announcement = randomUUID(),
    binding = randomUUID();
  let retired = 0;
  h.service.assets.retireDraft = async (input) => {
    retired++;
    assert.equal(input.actorAccountId, actor);
    assert.deepEqual(input.currentBindings, { gallery0: binding });
    return { gallery0: null };
  };
  const tx = {
    query: async () => ({
      rows: [
        {
          creator_id: actor,
          revision: '2',
          media_bindings: { gallery0: binding },
        },
      ],
    }),
  } as unknown as PoolClient;
  const input = {
    actorAccountId: actor,
    announcementId: announcement,
    revision: 2,
    currentBindings: { gallery0: binding },
  };
  assert.deepEqual(await h.service.retireDraft(input, tx), { gallery0: null });
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
