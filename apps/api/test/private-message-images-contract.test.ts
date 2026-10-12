import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  dmSendImageSchema,
  dmMessageSchema,
  dmSendSchema,
} from '../src/messaging/contracts.js';
import {
  canonicalDmEnvelope,
  dmApprovalDigest,
} from '../src/community/content-review/dm-contracts.js';
import { dmDigest } from '../src/messaging/repository.js';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import { createHash } from 'node:crypto';
test('PM3 image envelope is a separate exact branch without changing v1 canonical bytes', () => {
  const base = {
    purpose: 'send_private_message' as const,
    accountId: randomUUID(),
    clientRequestId: randomUUID(),
    conversationId: randomUUID(),
    contextDigest: 'a'.repeat(64),
    senderSlot: 0 as const,
    participantModes: ['named', 'anonymous'] as ['named', 'anonymous'],
  };
  const text = canonicalDmEnvelope({
    ...base,
    version: 1,
    text: 'exact\r\ntext',
    assetIds: [],
  });
  assert.equal(text.text, 'exact\ntext');
  assert.equal(
    dmApprovalDigest(text),
    createHash('sha256')
      .update('whaleu-dm-content-approval:v1\n' + canonicalJson(text))
      .digest('hex'),
  );
  const image = canonicalDmEnvelope({
    ...base,
    version: 2,
    kind: 'image',
    image: { assetId: randomUUID(), manifestDigest: 'b'.repeat(64) },
  });
  assert.equal('text' in image, false);
  assert.equal('assetIds' in image, false);
  assert.ok(Object.isFrozen(image.image));
  assert.notEqual(dmApprovalDigest(image), dmApprovalDigest(text));
  for (const patch of [
    { text: '[图片]' },
    { assetIds: [] },
    { image: { ...image.image, url: 'https://public.invalid' } },
    { kind: 'video' },
    { version: 1 },
  ])
    assert.throws(() => canonicalDmEnvelope({ ...image, ...patch }));
  const command = { clientRequestId: base.clientRequestId, image: image.image };
  assert.ok(dmSendImageSchema.safeParse(command).success);
  assert.equal(dmSendSchema.safeParse(command).success, false);
  assert.notEqual(
    dmDigest({
      operation: 'send_image',
      intent: { conversationId: base.conversationId, ...command },
    }),
    dmDigest({
      operation: 'send',
      intent: {
        conversationId: base.conversationId,
        clientRequestId: base.clientRequestId,
        text: '[图片]',
      },
    }),
  );
});
test('PM3 image descriptor is target-bound and must disappear for recall/unavailable', () => {
  const id = randomUUID(),
    image = {
      protocol: 'private-message-media-v1',
      kind: 'private-message-media',
      conversationId: randomUUID(),
      messageId: id,
      bindingId: randomUUID(),
      width: 10,
      height: 10,
      variants: ['thumb-v1', 'display-v1'],
    };
  const message = {
    id,
    sequence: '1',
    sender: 'peer',
    state: 'image',
    text: null,
    image,
    createdAt: new Date().toISOString(),
    canRecall: false,
  };
  assert.ok(dmMessageSchema.safeParse(message).success);
  for (const patch of [
    { state: 'recalled' },
    { state: 'unavailable' },
    { text: '[图片]' },
    { image: { ...image, messageId: randomUUID() } },
    { image: { ...image, url: 'https://public.invalid' } },
  ])
    assert.equal(
      dmMessageSchema.safeParse({ ...message, ...patch }).success,
      false,
    );
});
