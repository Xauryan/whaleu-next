import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { decodePostIntent } from '../src/community/contract';
import {
  PendingAttemptStore,
  type PendingAttempt,
} from '../src/community/pending-attempt';
import {
  createMediaUploadRuntime,
  mediaPublicationOwner,
  mediaPublicationReference,
} from '../src/media/upload-runtime';
import { Cancellation } from '../src/platform/contracts';
import { MemoryStorage } from './helpers';
import {
  ids,
  origin,
  prepare,
  uploadHarness,
} from './support/media-upload-fixtures';
function attempt(): PendingAttempt {
  return {
    version: 1,
    accountId: ids.actor,
    operation: 'publish_post',
    payload: decodePostIntent({
      clientRequestId: ids.publication,
      spaceId: ids.space,
      category: 'discussion',
      text: 'Only the publication owner stores this private text',
      imageAssetIds: [ids.asset],
      authorMode: 'named',
      commentsPolicy: 'open',
    }),
  };
}

test('publication pointer hash matches existing server postIntent/publicationHash without copying body', () => {
  const value = attempt(),
    reference = mediaPublicationReference(value);
  assert.equal(value.operation, 'publish_post');
  if (value.operation !== 'publish_post') assert.fail();
  const body = value.payload;
  assert.equal(
    reference.intentHash,
    createHash('sha256')
      .update(
        JSON.stringify({
          operation: 'publish_post',
          intent: {
            spaceId: body.spaceId,
            category: body.category,
            text: body.text,
            imageAssetIds: body.imageAssetIds,
            authorMode: body.authorMode,
            commentsPolicy: body.commentsPolicy,
          },
        }),
      )
      .digest('hex'),
  );
  assert.deepEqual(Object.keys(reference), [
    'clientRequestId',
    'operation',
    'intentHash',
  ]);
});
test('compose link durably freezes only an exact one-image publication and old attempts cannot overwrite it', () => {
  const h = uploadHarness(),
    record = h.pending.freeze(ids.actor, prepare, 1000);
  h.pending.update(record, {
    intentId: ids.intent,
    assetId: ids.asset,
    phase: 'ready_hint',
  });
  const runtime = createMediaUploadRuntime({
    sessions: h.sessions,
    pending: h.pending,
    clock: h.clock,
    newRequestId: async () => ids.request,
  });
  const original = attempt();
  runtime.beforePublication(original);
  assert.equal(h.pending.load(ids.actor)?.phase, 'publication_uncertain');
  assert.deepEqual(
    h.pending.load(ids.actor)?.publication,
    mediaPublicationReference(original),
  );
  assert.equal(
    JSON.stringify(h.pending.load(ids.actor)).includes(
      'Only the publication owner',
    ),
    false,
  );
  runtime.beforePublication(original);
  assert.throws(() =>
    runtime.beforePublication({ ...original, accountId: ids.other }),
  );
  if (original.operation !== 'publish_post') assert.fail();
  assert.throws(() =>
    runtime.beforePublication({
      ...original,
      payload: { ...original.payload, clientRequestId: ids.other },
    }),
  );
  h.controller.dispose();
});
test('publication owner checks saved pointer and exact receipt before media recovery can act', async () => {
  const h = uploadHarness(),
    storage = new MemoryStorage(),
    pending = new PendingAttemptStore(storage, origin),
    original = attempt();
  pending.freeze(original);
  let calls = 0;
  const owner = mediaPublicationOwner(pending, {
    async receipt(requestId) {
      calls++;
      return {
        requestId,
        operation: 'publish_post',
        outcome: 'created',
        resourceId: ids.other,
        createdAt: '2026-10-10T00:00:00Z',
      };
    },
  });
  const ticket = h.sessions.snapshot(),
    session = {
      current: () => {
        h.sessions.assertCurrent(ticket);
        return h.sessions.snapshot();
      },
    };
  await owner.receipt(
    mediaPublicationReference(original),
    session,
    new Cancellation(),
  );
  assert.equal(calls, 1);
  await assert.rejects(
    owner.receipt(
      { ...mediaPublicationReference(original), intentHash: 'c'.repeat(64) },
      session,
      new Cancellation(),
    ),
  );
  assert.equal(calls, 1);
  h.controller.dispose();
});
test('runtime has no production enable flag; omitted transfer is unavailable with no picker or HTTP work', async () => {
  const h = uploadHarness();
  const runtime = createMediaUploadRuntime({
    sessions: h.sessions,
    pending: h.pending,
    clock: h.clock,
    newRequestId: async () => ids.request,
  });
  const controller = runtime.create(() => undefined);
  assert.equal(controller.available, false);
  await assert.rejects(
    controller.select({ draftId: ids.draft, spaceId: ids.space }),
  );
  assert.equal(h.pending.load(ids.actor), null);
  assert.deepEqual(h.calls, []);
  controller.dispose();
  h.controller.dispose();
});
