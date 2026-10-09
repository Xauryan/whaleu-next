import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import { dmDigest } from '../src/messaging/repository.js';
import { dmSendSchema } from '../src/messaging/contracts.js';
import { messagingHashVectors } from './support/messaging-hash-vectors.js';
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reversed(child)]),
    );
  return value;
}
test('DM server original-intent fixed canonical bytes and digests match native across all operations', () => {
  for (const vector of messagingHashVectors) {
    assert.equal(canonicalJson(vector.envelope), vector.canonical, vector.name);
    assert.equal(
      canonicalJson(reversed(vector.envelope)),
      vector.canonical,
      vector.name,
    );
    assert.equal(dmDigest(vector.envelope), vector.hash, vector.name);
    if (vector.name === 'send' && 'text' in vector.envelope.intent) {
      const { conversationId, ...body } = vector.envelope.intent;
      const parsed = dmSendSchema.parse({
        ...body,
        text: body.text.replace(/\n/g, '\r\n'),
      });
      assert.equal(
        dmDigest({ operation: 'send', intent: { conversationId, ...parsed } }),
        vector.hash,
      );
    }
  }
});
