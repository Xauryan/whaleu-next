import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from 'js-sha256';
import {
  PROFILE_COVER_PROTOCOL as protocol,
  coverPrepareHash,
  coverCommandHash,
  decodeCoverCapabilities,
  decodeCoverCommand,
  decodeCoverPrepare,
  decodeCurrentCover,
} from '../src/profile/cover-contract';
import { coverCurrent, coverIds, coverPrepare } from './support/cover-fixtures';

test('cover capabilities are exact configuration information, not acceptance or publication authority', () => {
  for (const upload of ['available', 'unavailable'] as const)
    assert.deepEqual(decodeCoverCapabilities({ protocol, upload }), {
      protocol,
      upload,
    });
  for (const value of [
    { protocol: 'profile-media-v1', upload: 'available' },
    { protocol, upload: true },
    { protocol, upload: 'available', approved: true },
    { protocol },
  ])
    assert.throws(() => decodeCoverCapabilities(value));
});

test('cover contract rejects avatar protocols, catalog bindings and remote URLs', () => {
  assert.deepEqual(decodeCurrentCover(coverCurrent), coverCurrent);
  assert.throws(() =>
    decodeCoverPrepare({ ...coverPrepare, protocol: 'profile-media-v1' }),
  );
  assert.throws(() => decodeCoverPrepare({ ...coverPrepare, slot: 'avatar' }));
  assert.throws(() =>
    decodeCurrentCover({ ...coverCurrent, avatar: coverCurrent.cover }),
  );
  assert.throws(() =>
    decodeCurrentCover({
      ...coverCurrent,
      cover: { ...coverCurrent.cover, url: 'https://example.test/private.jpg' },
    }),
  );
  assert.throws(() =>
    decodeCurrentCover({
      ...coverCurrent,
      cover: {
        ...coverCurrent.cover,
        source: { kind: 'catalog', itemId: 'named-avatar' },
      },
    }),
  );
  assert.throws(() =>
    decodeCoverCommand({
      protocol,
      clientRequestId: coverIds.command,
      expectedRevision: 5,
      source: { kind: 'catalog', itemId: 'named-avatar' },
    }),
  );
});

test('cover journal hashes include independent domains and actor plus exact frozen request', () => {
  const {
    protocol: wireProtocol,
    clientRequestId,
    expectedRevision,
    slot,
    declaration,
  } = coverPrepare;
  assert.equal(
    coverPrepareHash(coverIds.actor, coverPrepare),
    sha256(
      'whaleu-profile-cover-prepare:v1\n' +
        JSON.stringify({
          protocol: wireProtocol,
          actorAccountId: coverIds.actor,
          clientRequestId,
          expectedRevision,
          slot,
          declaration,
        }),
    ),
  );
  const command = {
    protocol,
    clientRequestId: coverIds.command,
    expectedRevision: 5,
    source: { kind: 'clear' as const },
  };
  assert.equal(
    coverCommandHash(coverIds.actor, command),
    sha256(
      'whaleu-profile-cover-command:v1\n' +
        JSON.stringify({
          protocol,
          actorAccountId: coverIds.actor,
          clientRequestId: command.clientRequestId,
          expectedRevision: 5,
          source: command.source,
        }),
    ),
  );
  assert.notEqual(
    coverPrepareHash(coverIds.actor, coverPrepare),
    coverPrepareHash(coverIds.other, coverPrepare),
  );
});
