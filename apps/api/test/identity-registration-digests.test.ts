import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config/config.js';
import {
  parseDigestKeyRing,
  ProviderIdentityDigests,
} from '../src/identity/registration/digests.js';
const ring = {
  version: 1 as const,
  activeEpoch: 'key-b',
  keys: [
    { epoch: 'key-a', keyHex: '12'.repeat(32) },
    { epoch: 'key-b', keyHex: '34'.repeat(32) },
  ],
};
const identity = {
  provider: 'wechat' as const,
  appId: 'wx0123456789abcdef',
  subject: 'synthetic-provider-subject',
};

test('HMAC identity digests separate protocol, app, epoch and key; union identity grants no merge', () => {
  const keys = new ProviderIdentityDigests(ring);
  const a = keys.digest(identity, 'key-a');
  assert.match(a.digest, /^[a-f0-9]{64}$/);
  assert.notEqual(a.digest, keys.digest(identity, 'key-b').digest);
  assert.notEqual(
    a.digest,
    keys.digest({ ...identity, appId: 'wx1111111111111111' }, 'key-a').digest,
  );
  assert.notEqual(
    a.digest,
    keys.digest({ ...identity, subject: 'other-subject' }, 'key-a').digest,
  );
  assert.deepEqual(
    a,
    keys.digest({ ...identity, unionSubject: 'private-union-id' }, 'key-a'),
  );
  assert.notEqual(
    a.digest,
    createHash('sha256').update(identity.subject).digest('hex'),
  );
  assert.notEqual(a.digest, keys.keyCheck('key-a'));
  assert.ok(keys.matchesKeyCheck('key-a', keys.keyCheck('key-a')));
  assert.equal(keys.matchesKeyCheck('key-a', keys.keyCheck('key-b')), false);
  assert.equal(keys.matchesKeyCheck('absent', keys.keyCheck('key-a')), false);
  assert.equal(keys.matchesKeyCheck('key-a', 'invalid'), false);
  assert.equal(JSON.stringify(keys).includes(ring.keys[0]!.keyHex), false);
});

test('changing a key under a reused epoch fails its persisted key check', () => {
  const original = new ProviderIdentityDigests(ring);
  const replacement = new ProviderIdentityDigests({
    ...ring,
    keys: ring.keys.map((k) => ({
      ...k,
      keyHex: k.epoch === 'key-a' ? '56'.repeat(32) : k.keyHex,
    })),
  });
  assert.equal(
    replacement.matchesKeyCheck('key-a', original.keyCheck('key-a')),
    false,
  );
});

for (const value of [
  'secret-invalid-json',
  JSON.stringify({ ...ring, extra: 'secret-extra' }),
  JSON.stringify({ ...ring, version: 2 }),
  JSON.stringify({ ...ring, activeEpoch: 'missing' }),
  JSON.stringify({ ...ring, keys: [] }),
  JSON.stringify({ ...ring, keys: [ring.keys[0], ring.keys[0]] }),
  JSON.stringify({
    ...ring,
    keys: [ring.keys[0], { ...ring.keys[1], keyHex: ring.keys[0]!.keyHex }],
  }),
  JSON.stringify({
    ...ring,
    keys: [{ epoch: 'key-a', keyHex: 'short-secret' }],
  }),
  JSON.stringify({
    ...ring,
    keys: Array.from({ length: 9 }, (_, n) => ({
      epoch: `key-${n}`,
      keyHex: n.toString(16).repeat(64),
    })),
  }),
])
  test('keyring rejects malformed, duplicate, missing active or over-budget inputs without leaking them', () => {
    assert.throws(
      () => parseDigestKeyRing(value),
      (error: Error) => {
        assert.equal(
          error.message,
          'Invalid configuration field: IDENTITY_DELETION_DIGEST_KEYRING',
        );
        assert.equal('cause' in error, false);
        return true;
      },
    );
  });

test('digest scope rejects arbitrary and rehearsal app IDs or malformed provider subjects', () => {
  const keys = new ProviderIdentityDigests(ring);
  for (const changed of [
    { appId: 'synthetic-account-deletion-rehearsal' },
    { subject: '' },
    { subject: 'x'.repeat(129) },
    { subject: 'private value' },
  ])
    assert.throws(() => keys.digest({ ...identity, ...changed }, 'key-a'));
});

test('configuration is opt-in stricter, never an environment disable for persistent enforcement', () => {
  const local = {
    DATABASE_URL: 'postgresql://localhost/whaleu_test',
    PG_SSL_MODE: 'disable',
  };
  assert.equal(loadConfig(local).IDENTITY_REGISTRATION_GUARD, 'automatic');
  assert.throws(() =>
    loadConfig({ ...local, IDENTITY_REGISTRATION_GUARD: 'disabled' }),
  );
  assert.throws(() =>
    loadConfig({ ...local, IDENTITY_REGISTRATION_GUARD: 'required' }),
  );
  assert.equal(
    loadConfig({
      ...local,
      IDENTITY_REGISTRATION_GUARD: 'required',
      IDENTITY_DELETION_DIGEST_KEYRING: JSON.stringify(ring),
    }).IDENTITY_REGISTRATION_GUARD,
    'required',
  );
  assert.throws(
    () =>
      loadConfig({
        ...local,
        IDENTITY_DELETION_DIGEST_KEYRING: 'secret-invalid',
      }),
    (error: Error) => !error.message.includes('secret-invalid'),
  );
});
