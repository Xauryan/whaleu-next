import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { prepareMediaSchema } from '../src/media/contracts.js';
import { prepareMediaV2Schema } from '../src/media/contracts-v2.js';
import { prepareMediaV3Schema } from '../src/media/contracts-v3.js';
import { prepareMediaV4Schema } from '../src/media/contracts-v4.js';
import {
  prepareProfileMediaSchema,
  profileMediaRequestHash,
  profileMediaStatusSchema,
  profileMediaRecoverySchema,
  profileMediaParentSchema,
  profileMediaGrantSchema,
} from '../src/media/contracts-profile.js';
import { avatarPrepareHash } from '../src/profile/avatar/contracts.js';

const prepare = () => ({
  protocol: 'profile-media-v1' as const,
  clientRequestId: randomUUID(),
  expectedRevision: 0,
  slot: 'avatar' as const,
  declaration: {
    mime: 'image/png' as const,
    bytes: 12,
    sha256: 'a'.repeat(64),
  },
});
test('Profile media independently versions its source declaration and exact request hash', () => {
  const actor = randomUUID(),
    input = prepare();
  assert.deepEqual(prepareProfileMediaSchema.parse(input), input);
  assert.equal(
    profileMediaRequestHash(actor, input),
    createHash('sha256')
      .update(
        'whaleu-profile-media-prepare:v1\n' +
          JSON.stringify({
            protocol: 'profile-media-v1',
            actorAccountId: actor,
            clientRequestId: input.clientRequestId,
            expectedRevision: input.expectedRevision,
            slot: input.slot,
            declaration: input.declaration,
          }),
      )
      .digest('hex'),
  );
  assert.equal(
    profileMediaRequestHash(actor, input),
    avatarPrepareHash(actor, input),
  );
  for (const patch of [
    { expectedRevision: 1 },
    { declaration: { ...input.declaration, bytes: 13 } },
    { declaration: { ...input.declaration, sha256: 'b'.repeat(64) } },
  ])
    assert.notEqual(
      profileMediaRequestHash(actor, { ...input, ...patch }),
      profileMediaRequestHash(actor, input),
    );
  for (const schema of [
    prepareMediaSchema,
    prepareMediaV2Schema,
    prepareMediaV3Schema,
    prepareMediaV4Schema,
  ])
    assert.equal(schema.safeParse(input).success, false);
  for (const extra of [
    { spaceId: randomUUID() },
    { postId: randomUUID() },
    { url: 'https://invalid.test/source' },
    { accountId: actor },
    { approved: true },
    { protocolVersion: 5 },
    { ordinal: 0 },
    { purpose: 'profile-avatar-image' },
  ])
    assert.equal(
      prepareProfileMediaSchema.safeParse({ ...input, ...extra }).success,
      false,
    );
  assert.equal(
    prepareProfileMediaSchema.safeParse({ ...input, slot: 'banner' }).success,
    false,
  );
  assert.equal(
    prepareProfileMediaSchema.safeParse({
      ...input,
      expectedRevision: 2147483647,
    }).success,
    false,
  );
});
test('Profile status has no Community draft/publication identity and historical commands grant no image authority', () => {
  const base = {
    protocol: 'profile-media-v1',
    editId: randomUUID(),
    intentId: randomUUID(),
    requestId: randomUUID(),
    requestHash: 'a'.repeat(64),
    serverNow: 1,
  };
  const ready = {
    ...base,
    status: 'ready_unbound',
    assetId: randomUUID(),
    readyRetentionUntil: 4,
    editExpiresAt: 3,
    bindBefore: 3,
    mediaProof: 'current',
  };
  assert.equal(profileMediaStatusSchema.safeParse(ready).success, true);
  assert.equal(
    profileMediaStatusSchema.safeParse({ ...ready, draftExpiresAt: 3 }).success,
    false,
  );
  const bound = {
    ...base,
    status: 'bound_history',
    assetId: randomUUID(),
    bindingId: randomUUID(),
    command: {
      protocol: 'profile-media-v1',
      clientRequestId: randomUUID(),
      requestHash: 'b'.repeat(64),
      resultingRevision: 1,
      operation: 'select_avatar',
    },
    attachmentState: 'detached',
  };
  assert.equal(profileMediaStatusSchema.safeParse(bound).success, true);
  for (const extra of [
    { url: 'https://invalid.test' },
    { manifest: {} },
    { width: 12 },
    { appearanceId: randomUUID() },
    { publication: null },
  ])
    assert.equal(
      profileMediaStatusSchema.safeParse({ ...bound, ...extra }).success,
      false,
    );
  const { editId, ...missing } = bound;
  assert.ok(editId);
  assert.equal(profileMediaStatusSchema.safeParse(missing).success, false);
  assert.equal(
    profileMediaRecoverySchema.safeParse({
      protocol: base.protocol,
      requestId: base.requestId,
      serverNow: 1,
      requestHash: base.requestHash,
      state: 'recorded',
      status: bound,
    }).success,
    true,
  );
  const cancelled = {
    protocol: base.protocol,
    requestId: base.requestId,
    serverNow: 1,
    requestHash: base.requestHash,
    state: 'cancelled_before_prepare',
    reason: 'cancelled',
  };
  assert.equal(profileMediaRecoverySchema.safeParse(cancelled).success, true);
  assert.equal(
    profileMediaRecoverySchema.safeParse({ ...cancelled, editId: randomUUID() })
      .success,
    false,
  );
});
test('Profile exact parent and grants cannot expand to arbitrary owner or source slots', () => {
  const parent = {
    ownerKind: 'profile',
    resourceKind: 'avatar',
    resourceId: randomUUID(),
    contentVersion: 1,
  };
  assert.equal(profileMediaParentSchema.safeParse(parent).success, true);
  for (const patch of [
    { resourceKind: 'banner' },
    { ownerKind: 'community' },
    { contentVersion: 2 },
    { accountId: randomUUID() },
  ])
    assert.equal(
      profileMediaParentSchema.safeParse({ ...parent, ...patch }).success,
      false,
    );
  assert.equal(
    profileMediaGrantSchema.safeParse({
      version: 1,
      protocol: 'profile-media-v1',
    }).success,
    false,
  );
});
test('additive Profile SQL preserves explicit protocol isolation and exact edit deadline/evidence guards', () => {
  const sql = readFileSync(
    new URL('../migrations/0080_profile_avatar_media.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /protocol_version IN \(2,3,4,5\)/);
  assert.match(sql, /CREATE TABLE whaleu_media\.profile_request_markers/);
  assert.match(
    sql,
    /REFERENCES whaleu_media\.upload_request_fences\(actor_id,client_request_id\) DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(
    sql,
    /media_profile_marker_fence[\s\S]*DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(sql, /fence\.request_hash<>marker\.request_hash/);
  assert.match(sql, /id=fence\.intent_id AND protocol_version=5/);
  assert.match(
    sql,
    /protocol_version<>5 AND owner_kind<>'profile' AND target_kind<>'edit'/,
  );
  assert.match(sql, /e\.request_hash=NEW\.request_hash/);
  assert.match(sql, /e\.expires_at=NEW\.expires_at/);
  assert.match(
    sql,
    /media_profile_binding_retention_final[\s\S]*DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(sql, /jsonb_array_length\(profile_assets\)<>1/);
  assert.match(
    sql,
    /ELSIF NEW\.attach_evidence->'version' IN \('2'::jsonb,'3'::jsonb\)/,
  );
  assert.doesNotMatch(sql, /UPDATE whaleu_media\.(assets|upload_intents) SET/);
});
