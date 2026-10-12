import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeIntent, decodeMessage } from '../src/messaging/contract';
import { PendingMessagingStore, intentHash } from '../src/messaging/pending';
import { PendingPrivateMessageImages } from '../src/messaging/image-pending';
import { dispatch } from '../src/messaging/commands';
import { Cancellation } from '../src/platform/contracts';
import { MemoryStorage, flush } from './helpers';
import {
  MessagingDetailController,
  type DetailView,
} from '../src/messaging/detail-controller';
import type { PrivateMessageImages } from '../src/messaging/image-runtime';
import {
  accountId,
  conversationId,
  messageId,
  requestId,
  otherId,
  timestamp,
  harness,
  history,
  message,
  conversation,
} from './messaging-helpers';
const image = { assetId: otherId, manifestDigest: 'a'.repeat(64) };
const intent = decodeIntent({
  operation: 'send_image',
  conversationId,
  clientRequestId: requestId,
  image,
});
test('PM3 unresolved upload fences stale-page text commands before a second journal or request', async () => {
  const h = harness();
  const pending = new PendingPrivateMessageImages(h.storage, 'synthetic');
  pending.freeze({
    accountId,
    conversationId,
    messageRequestId: requestId,
    uploadRequestId: otherId,
    uploadHash: 'a'.repeat(64),
  });
  h.runtime.images = { pending } as unknown as PrivateMessageImages;
  await assert.rejects(
    dispatch(
      h.runtime,
      {
        operation: 'send',
        clientRequestId: otherId,
        conversationId,
        text: 'stale page',
      },
      new Cancellation(),
      () => {},
    ),
  );
  assert.equal(h.runtime.pending.load(accountId), null);
  assert.equal(h.applied.length, 0);
});
test('PM3 changed block/hide and stale fulfilled download revoke presentation before retained-history reauthorization', async () => {
  const h = harness();
  let view: DetailView | undefined;
  let reads = 0;
  const released: string[] = [];
  const descriptor = {
    protocol: 'private-message-media-v1' as const,
    kind: 'private-message-media' as const,
    conversationId,
    messageId,
    bindingId: otherId,
    width: 48,
    height: 48,
    variants: ['thumb-v1', 'display-v1'] as const,
  };
  h.gateway.history = async () =>
    history({
      items: [message({ state: 'image', text: null, image: descriptor })],
    });
  let stale = false;
  h.runtime.images = {
    pending: { load: () => null },
    read: async () => {
      const file = { localId: String(++reads) };
      if (stale) controller.hide();
      return { file, path: 'wxfile://tmp/private-synthetic' };
    },
    release: async (file: { localId: string }) => {
      released.push(file.localId);
    },
  } as unknown as PrivateMessageImages;
  const controller = new MessagingDetailController(
    h.runtime,
    { conversationId },
    (v, done) => {
      view = v;
      done?.();
    },
  );
  await controller.load();
  await controller.showImage(messageId);
  assert.ok(view!.imagePath);
  h.gateway.conversation = async () =>
    conversation({ sendAvailability: 'unavailable' });
  await controller.load();
  assert.equal(view!.imagePath, '');
  assert.deepEqual(released, ['1']);
  await controller.showImage(messageId);
  assert.ok(view!.imagePath);
  assert.equal(reads, 2);
  h.gateway.conversation = async () =>
    conversation({ sendAvailability: 'unavailable', hidden: true });
  await controller.load();
  assert.equal(view!.imagePath, '');
  assert.deepEqual(released, ['1', '2']);
  stale = true;
  await controller.showImage(messageId);
  await flush();
  assert.equal(view!.imagePath, '');
  assert.deepEqual(released, ['1', '2', '3']);
  controller.dispose();
});
test('PM3 image command has distinct hash and never persists asset facts or pixels', () => {
  const storage = new MemoryStorage(),
    store = new PendingMessagingStore(storage, 'https://synthetic.invalid');
  const original = store.freeze({ version: 1, accountId, intent });
  assert.equal(original.operation, 'send_image');
  assert.equal(store.load(accountId)?.intent?.operation, 'send_image');
  const restarted = new PendingMessagingStore(
    storage,
    'https://synthetic.invalid',
  );
  assert.equal(restarted.load(accountId)?.intent, null);
  assert.equal(restarted.load(accountId)?.intentHash, intentHash(intent));
  assert.throws(() =>
    restarted.freeze({
      version: 1,
      accountId,
      intent: decodeIntent({
        ...intent,
        image: { ...image, manifestDigest: 'b'.repeat(64) },
      }),
    }),
  );
  assert.throws(() =>
    restarted.freeze({
      version: 1,
      accountId,
      intent: decodeIntent({
        operation: 'send',
        conversationId,
        clientRequestId: requestId,
        text: '[图片]',
      }),
    }),
  );
  assert.equal(
    restarted.freeze({ version: 1, accountId, intent }).intent.operation,
    'send_image',
  );
  restarted.scrubBodies(accountId);
  assert.equal(restarted.load(accountId)?.intent, null);
});
test('PM3 minimal image journal is origin/account scoped and only clears exact unresolved identity', () => {
  const storage = new MemoryStorage(),
    pending = new PendingPrivateMessageImages(
      storage,
      'https://synthetic.invalid',
    );
  const row = {
    accountId,
    conversationId,
    messageRequestId: requestId,
    uploadRequestId: otherId,
    uploadHash: 'f'.repeat(64),
  };
  pending.freeze(row);
  assert.deepEqual(
    new PendingPrivateMessageImages(storage, 'https://synthetic.invalid').load(
      accountId,
    ),
    row,
  );
  assert.equal(
    new PendingPrivateMessageImages(storage, 'https://other.invalid').load(
      accountId,
    ),
    null,
  );
  assert.equal(pending.load(otherId), null);
  assert.throws(() => pending.freeze({ ...row, uploadHash: 'e'.repeat(64) }));
  assert.throws(() => pending.clear({ ...row, messageRequestId: otherId }));
  pending.clear(row);
  assert.equal(pending.load(accountId), null);
});
test('PM3 discriminated image is never fake text or an arbitrary URL', () => {
  const image = {
    protocol: 'private-message-media-v1',
    kind: 'private-message-media',
    conversationId,
    messageId,
    bindingId: otherId,
    width: 48,
    height: 48,
    variants: ['thumb-v1', 'display-v1'],
  };
  const raw = {
    id: messageId,
    sequence: '1',
    sender: 'peer',
    state: 'image',
    text: null,
    image,
    createdAt: timestamp,
    canRecall: false,
  };
  assert.equal(decodeMessage(raw).state, 'image');
  assert.throws(() => decodeMessage({ ...raw, text: '[图片]' }));
  assert.throws(() =>
    decodeMessage({
      ...raw,
      image: { ...image, url: 'https://public.invalid/private' },
    }),
  );
  assert.throws(() => decodeMessage({ ...raw, state: 'recalled' }));
  assert.throws(() => decodeIntent({ ...intent, text: '[图片]' }));
});
