import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeUploadPrepare } from '../src/media/upload-contracts';
import {
  PROFILE_MEDIA_PROTOCOL as protocol,
  avatarCommandHash,
  avatarPrepareHash,
  decodeAvatarCatalog,
  decodeAvatarCommand,
  decodeAvatarEditRecovery,
  decodeAvatarEditStatus,
  decodeAvatarGrant,
  decodeAvatarPrepare,
  decodeAvatarReceipt,
  decodeCurrentAvatar,
} from '../src/profile/avatar-contract';
import {
  avatarCatalog,
  avatarCurrent,
  avatarGrant,
  avatarIds,
  avatarPrepare,
  avatarReady,
} from './support/avatar-fixtures';
test('Profile strict protocol refuses old purpose, arbitrary URLs and fake Community scope fields', () => {
  assert.deepEqual(decodeAvatarPrepare(avatarPrepare), avatarPrepare);
  assert.throws(() => decodeUploadPrepare(avatarPrepare));
  for (const patch of [
    { version: 5 },
    { protocol: 'profile-media-v2' },
    { draftId: avatarIds.edit },
    { accountId: avatarIds.actor },
    { slot: 'banner' },
    { spaceId: avatarIds.profile },
    { approved: true },
    { url: 'https://storage.invalid/avatar' },
  ])
    assert.throws(() => decodeAvatarPrepare({ ...avatarPrepare, ...patch }));
  assert.throws(() =>
    decodeAvatarPrepare({
      ...avatarPrepare,
      declaration: { ...avatarPrepare.declaration, bytes: 5242881 },
    }),
  );
});
test('catalog and custom/clear command union are exact and independently domain hashed', () => {
  assert.deepEqual(decodeAvatarCatalog(avatarCatalog), avatarCatalog);
  const command = {
    protocol,
    clientRequestId: avatarIds.command,
    expectedRevision: 5,
    source: { kind: 'clear' },
  };
  assert.equal(decodeAvatarCommand(command).source.kind, 'clear');
  assert.throws(() =>
    decodeAvatarCommand({
      ...command,
      source: { kind: 'clear', itemId: 'one' },
    }),
  );
  assert.throws(() =>
    decodeAvatarCommand({
      ...command,
      source: {
        kind: 'catalog',
        catalogVersion: 'synthetic-v1',
        itemId: '../secret',
      },
    }),
  );
  assert.throws(() =>
    decodeAvatarCommand({
      ...command,
      source: {
        kind: 'custom',
        editId: avatarIds.edit,
        assetId: avatarIds.asset,
        manifestDigest: 'a'.repeat(64),
      },
    }),
  );
  assert.notEqual(
    avatarCommandHash(avatarIds.actor, command),
    avatarCommandHash(avatarIds.other, command),
  );
  assert.notEqual(
    avatarCommandHash(avatarIds.actor, command),
    avatarCommandHash(avatarIds.actor, { ...command, expectedRevision: 6 }),
  );
  assert.notEqual(
    avatarPrepareHash(avatarIds.actor, avatarPrepare),
    avatarCommandHash(avatarIds.actor, command),
  );
  assert.throws(() =>
    decodeAvatarCatalog({
      protocol,
      availability: 'unavailable',
      catalogVersion: '91-real',
      items: [],
    }),
  );
});
test('current avatar, edit deadline and minimal historical receipt never accept URLs or forged history', () => {
  assert.deepEqual(decodeCurrentAvatar(avatarCurrent), avatarCurrent);
  assert.throws(() =>
    decodeCurrentAvatar({
      ...avatarCurrent,
      avatar: { ...avatarCurrent.avatar, url: 'https://x.invalid' },
    }),
  );
  assert.throws(() =>
    decodeCurrentAvatar({ ...avatarCurrent, profileId: null }),
  );
  assert.deepEqual(decodeAvatarEditStatus(avatarReady()), avatarReady());
  assert.throws(() =>
    decodeAvatarEditStatus({ ...avatarReady(), draftExpiresAt: 90000 }),
  );
  assert.throws(() =>
    decodeAvatarEditStatus({ ...avatarReady(), bindBefore: 100000 }),
  );
  assert.deepEqual(decodeAvatarGrant(avatarGrant), avatarGrant);
  assert.throws(() => decodeAvatarGrant({ ...avatarGrant, generation: '01' }));
  assert.throws(() =>
    decodeAvatarReceipt({
      protocol,
      clientRequestId: avatarIds.command,
      requestHash: 'a'.repeat(64),
      resultingRevision: 6,
      operation: 'publish_post',
    }),
  );
  const cancelled = {
    protocol,
    requestId: avatarIds.request,
    serverNow: 1000,
    state: 'cancelled_before_prepare',
    requestHash: 'a'.repeat(64),
    reason: 'cancelled',
  };
  assert.deepEqual(decodeAvatarEditRecovery(cancelled), cancelled);
  assert.throws(() =>
    decodeAvatarEditRecovery({ ...cancelled, intentId: avatarIds.intent }),
  );
});
