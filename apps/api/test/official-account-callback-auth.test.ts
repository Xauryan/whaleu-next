import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  CallbackRejection,
  canonicalCallbackBody,
  parseCallbackBody,
  parseSyntheticChallenge,
  syntheticCallbackSignature,
  syntheticChallengeBytes,
  verifySyntheticSignature,
  callbackLogicalHash,
} from '../src/official-account-operations/callback-auth.js';
import type { SyntheticCallbackEnvelope } from '../src/official-account-operations/callback-auth.js';
import { OfficialCallbackBoundary } from '../src/official-account-operations/callback-ledger.js';

const event = (): SyntheticCallbackEnvelope => ({
  profile: 'synthetic-official-v1',
  accountRef: randomUUID(),
  keyEpoch: 1,
  eventId: randomUUID(),
  officialSubject: `synthetic:official:${randomUUID()}`,
  kind: 'subscribe',
  sequence: 1,
  occurredAt: 1700000000000,
  issuedAt: 1700000000000,
});
const rejects = (status: number) => (error: unknown) =>
  error instanceof CallbackRejection && error.status === status;
test('exact canonical synthetic callback bytes and public fixture HMAC only', () => {
  const e = event(),
    raw = canonicalCallbackBody(e),
    registration = randomUUID();
  assert.deepEqual(parseCallbackBody(raw, 'application/json'), e);
  assert.deepEqual(
    parseCallbackBody(raw, 'application/json; charset=utf-8'),
    e,
  );
  const signature = syntheticCallbackSignature('POST', registration, raw, 1);
  verifySyntheticSignature('POST', registration, raw, signature, 1);
  for (const [id, bytes, sig, epoch] of [
    [randomUUID(), raw, signature, 1],
    [registration, Buffer.concat([raw, Buffer.from(' ')]), signature, 1],
    [registration, raw, signature.toUpperCase(), 1],
    [registration, raw, signature, 2],
    [registration, raw, signature, 3],
    [registration, raw, '0'.repeat(64), 1],
    [registration, raw, 'a', 1],
  ] as const)
    assert.throws(
      () => verifySyntheticSignature('POST', id, bytes, sig, epoch),
      rejects(401),
    );
});
test('rejects XML/entities, duplicate/unknown/missing fields, coercion, noncanonical and invalid UTF-8', () => {
  const e = event(),
    raw = canonicalCallbackBody(e).toString();
  const bad = [
    '<xml/>',
    '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><x>&a;</x>',
    '<!DOCTYPE x [<!ENTITY a "aaaaaaaa">]><x>&a;&a;</x>',
    JSON.stringify({ ...e, extra: 1 }),
    raw.replace('"sequence":1,', ''),
    raw.replace('"sequence":1', '"sequence":"1"'),
    raw.replace('"sequence":1', '"sequence":1,"sequence":1'),
    ` ${raw}`,
    raw + '\n',
    JSON.stringify({ ...e, sequence: 0 }),
    JSON.stringify({ ...e, sequence: 9007199254740992 }),
    JSON.stringify({ ...e, occurredAt: e.issuedAt + 1 }),
    JSON.stringify({ ...e, officialSubject: 'real-open-id' }),
    JSON.stringify({ ...e, officialSubject: 'x'.repeat(1025) }),
    JSON.stringify({
      a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } },
    }),
    JSON.stringify({ ...e, officialSubject: '\ud800' }),
    JSON.stringify({ ...e, officialSubject: '\0' }),
    JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 33 }, (_, i) => [`member${i}`, 1]),
      ),
    ),
  ];
  for (const text of bad)
    assert.throws(
      () => parseCallbackBody(Buffer.from(text), 'application/json'),
      rejects(400),
    );
  assert.throws(
    () => parseCallbackBody(Buffer.from([0xff, 0xfe]), 'application/json'),
    rejects(400),
  );
  assert.throws(
    () =>
      parseCallbackBody(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(raw)]),
        'application/json',
      ),
    rejects(400),
  );
  assert.throws(
    () => parseCallbackBody(Buffer.alloc(65536), 'application/json'),
    rejects(400),
  );
  assert.throws(
    () => parseCallbackBody(Buffer.alloc(65537), 'application/json'),
    rejects(413),
  );
  assert.throws(
    () => parseCallbackBody(Buffer.from(raw), 'text/plain'),
    rejects(415),
  );
  assert.throws(
    () => parseCallbackBody(Buffer.from(raw), 'application/json', 'gzip'),
    rejects(415),
  );
  assert.throws(
    () => parseCallbackBody(Buffer.from(raw), 'application/json', 'identity'),
    rejects(415),
  );
});
test('challenge exact query and cross-epoch logical replay identity', () => {
  const e = event(),
    q = {
      accountRef: e.accountRef,
      keyEpoch: '1',
      challenge: 'a'.repeat(32),
      issuedAt: String(e.issuedAt),
    };
  const parsed = parseSyntheticChallenge(q),
    id = randomUUID(),
    bytes = syntheticChallengeBytes(parsed);
  verifySyntheticSignature(
    'GET',
    id,
    bytes,
    syntheticCallbackSignature('GET', id, bytes, 1),
    1,
  );
  for (const invalid of [
    { ...q, extra: 'x' },
    { ...q, keyEpoch: '01' },
    { ...q, issuedAt: ['1'] },
    { ...q, challenge: 'A'.repeat(32) },
    { ...q, challenge: '<xml>' },
  ])
    assert.throws(() => parseSyntheticChallenge(invalid), rejects(400));
  assert.equal(
    callbackLogicalHash(e),
    callbackLogicalHash({ ...e, keyEpoch: 2, issuedAt: e.issuedAt + 1000 }),
  );
  assert.notEqual(
    callbackLogicalHash(e),
    callbackLogicalHash({ ...e, kind: 'unsubscribe' }),
  );
});
test('ordinary runtime and forged structural DI cannot enable callback acceptance', async () => {
  const db = {
    transaction: async () => {
      throw new Error('No database access permitted');
    },
  };
  const normal = new OfficialCallbackBoundary(db),
    forged = new OfficialCallbackBoundary(db, {
      profile: 'synthetic-official-v1',
    });
  for (const boundary of [normal, forged]) {
    assert.deepEqual(
      await boundary.receive(randomUUID(), {
        rawBody: Buffer.from('secret body'),
      }),
      { status: 503, body: { error: 'callback_unavailable' }, retryAfter: 5 },
    );
    assert.equal((await boundary.challenge(randomUUID(), {})).status, 503);
  }
});
