import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from 'js-sha256';
import { decodeIntent } from '../src/messaging/contract';
import { canonicalDmJson, intentHash } from '../src/messaging/pending';
import { messagingHashVectors } from './messaging-hash-vectors';
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
test('fixed original-intent canonical bytes and SHA-256 match every server operation', () => {
  for (const vector of messagingHashVectors) {
    assert.equal(
      canonicalDmJson(vector.envelope),
      vector.canonical,
      vector.name,
    );
    assert.equal(
      canonicalDmJson(reversed(vector.envelope)),
      vector.canonical,
      vector.name,
    );
    assert.equal(
      sha256('whaleu:dm:v1\n' + canonicalDmJson(vector.envelope)),
      vector.hash,
      vector.name,
    );
    if (vector.name !== 'canonical-null-empty-not-a-command') {
      const intent = decodeIntent({
        operation: vector.envelope.operation,
        ...vector.envelope.intent,
      });
      assert.equal(intentHash(intent), vector.hash, vector.name);
      assert.equal(
        intentHash(decodeIntent(reversed(intent))),
        vector.hash,
        vector.name,
      );
      if (intent.operation === 'send')
        assert.equal(
          intentHash({ ...intent, text: intent.text.replace(/\n/g, '\r\n') }),
          vector.hash,
        );
    }
  }
});
test('null is canonically defined but never fills a missing required command field', () => {
  assert.equal(canonicalDmJson({ b: null, a: '' }), '{"a":"","b":null}');
  assert.throws(() =>
    decodeIntent({
      operation: 'send',
      clientRequestId: '77777777-7777-4777-8777-777777777777',
      conversationId: '55555555-5555-4555-8555-555555555555',
      text: null,
    }),
  );
  assert.throws(() => canonicalDmJson({ a: undefined }));
});
