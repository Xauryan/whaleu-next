import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  prepareProfileMediaSchema,
  profileMediaParentSchema,
} from '../src/media/contracts-profile.js';
import { prepareMediaSchema } from '../src/media/contracts.js';
import { prepareMediaV2Schema } from '../src/media/contracts-v2.js';
import { prepareMediaV3Schema } from '../src/media/contracts-v3.js';
import { prepareMediaV4Schema } from '../src/media/contracts-v4.js';
import {
  prepareProfileCoverMediaSchema,
  profileCoverMediaRequestHash,
  profileCoverMediaStatusSchema,
  profileCoverMediaRecoverySchema,
  profileCoverMediaParentSchema,
  profileCoverMediaGrantSchema,
} from '../src/media/contracts-profile-cover.js';

const prepare = () => ({
  protocol: 'profile-cover-v1' as const,
  clientRequestId: randomUUID(),
  expectedRevision: 0,
  slot: 'cover' as const,
  declaration: {
    mime: 'image/png' as const,
    bytes: 12,
    sha256: 'a'.repeat(64),
  },
});
test('Profile media independently versions its source declaration and exact request hash', () => {
  const actor = randomUUID(),
    input = prepare();
  assert.deepEqual(prepareProfileCoverMediaSchema.parse(input), input);
  assert.equal(
    profileCoverMediaRequestHash(actor, input),
    createHash('sha256')
      .update(
        'whaleu-profile-cover-prepare:v1\n' +
          JSON.stringify({
            protocol: 'profile-cover-v1',
            actorAccountId: actor,
            clientRequestId: input.clientRequestId,
            expectedRevision: input.expectedRevision,
            slot: input.slot,
            declaration: input.declaration,
          }),
      )
      .digest('hex'),
  );
  for (const patch of [
    { expectedRevision: 1 },
    { declaration: { ...input.declaration, bytes: 13 } },
    { declaration: { ...input.declaration, sha256: 'b'.repeat(64) } },
  ])
    assert.notEqual(
      profileCoverMediaRequestHash(actor, { ...input, ...patch }),
      profileCoverMediaRequestHash(actor, input),
    );
  for (const schema of [
    prepareProfileMediaSchema,
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
    { protocolVersion: 18 },
    { ordinal: 0 },
    { purpose: 'profile-cover-image' },
  ])
    assert.equal(
      prepareProfileCoverMediaSchema.safeParse({ ...input, ...extra }).success,
      false,
    );
  assert.equal(
    prepareProfileCoverMediaSchema.safeParse({ ...input, slot: 'banner' })
      .success,
    false,
  );
  assert.equal(
    prepareProfileCoverMediaSchema.safeParse({
      ...input,
      expectedRevision: 2147483647,
    }).success,
    false,
  );
});
test('Profile status has no Community draft/publication identity and historical commands grant no image authority', () => {
  const base = {
    protocol: 'profile-cover-v1',
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
  assert.equal(profileCoverMediaStatusSchema.safeParse(ready).success, true);
  assert.equal(
    profileCoverMediaStatusSchema.safeParse({ ...ready, draftExpiresAt: 3 })
      .success,
    false,
  );
  const bound = {
    ...base,
    status: 'bound_history',
    assetId: randomUUID(),
    bindingId: randomUUID(),
    command: {
      protocol: 'profile-cover-v1',
      clientRequestId: randomUUID(),
      requestHash: 'b'.repeat(64),
      resultingRevision: 1,
      operation: 'select_cover',
    },
    attachmentState: 'detached',
  };
  assert.equal(profileCoverMediaStatusSchema.safeParse(bound).success, true);
  for (const extra of [
    { url: 'https://invalid.test' },
    { manifest: {} },
    { width: 12 },
    { appearanceId: randomUUID() },
    { publication: null },
  ])
    assert.equal(
      profileCoverMediaStatusSchema.safeParse({ ...bound, ...extra }).success,
      false,
    );
  const { editId, ...missing } = bound;
  assert.ok(editId);
  assert.equal(profileCoverMediaStatusSchema.safeParse(missing).success, false);
  assert.equal(
    profileCoverMediaRecoverySchema.safeParse({
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
  assert.equal(
    profileCoverMediaRecoverySchema.safeParse(cancelled).success,
    true,
  );
  assert.equal(
    profileCoverMediaRecoverySchema.safeParse({
      ...cancelled,
      editId: randomUUID(),
    }).success,
    false,
  );
});
test('Profile exact parent and grants cannot expand to arbitrary owner or source slots', () => {
  const parent = {
    ownerKind: 'profile',
    resourceKind: 'cover',
    resourceId: randomUUID(),
    contentVersion: 1,
  };
  assert.equal(profileCoverMediaParentSchema.safeParse(parent).success, true);
  for (const patch of [
    { resourceKind: 'banner' },
    { ownerKind: 'community' },
    { contentVersion: 2 },
    { accountId: randomUUID() },
  ])
    assert.equal(
      profileCoverMediaParentSchema.safeParse({ ...parent, ...patch }).success,
      false,
    );
  assert.equal(
    profileCoverMediaGrantSchema.safeParse({
      version: 1,
      protocol: 'profile-cover-v1',
    }).success,
    false,
  );
});

test('Cover and avatar parents and source declarations are mutually exclusive', () => {
  const cover = prepare();
  const avatar = { ...cover, protocol: 'profile-media-v1', slot: 'avatar' };
  assert.equal(prepareProfileMediaSchema.safeParse(avatar).success, true);
  assert.equal(prepareProfileCoverMediaSchema.safeParse(avatar).success, false);
  assert.equal(prepareProfileMediaSchema.safeParse(cover).success, false);
  const parent = {
    ownerKind: 'profile',
    resourceKind: 'cover',
    resourceId: randomUUID(),
    contentVersion: 1,
  };
  assert.equal(profileCoverMediaParentSchema.safeParse(parent).success, true);
  assert.equal(profileMediaParentSchema.safeParse(parent).success, false);
  assert.equal(
    profileCoverMediaParentSchema.safeParse({
      ...parent,
      resourceKind: 'avatar',
    }).success,
    false,
  );
});

test('Profile cover SQL keeps avatar routing narrow and protocol18 evidence independent', async () => {
  const { readFileSync } = await import('node:fs');
  const sql = readFileSync(
    new URL('../migrations/0163_profile_cover_media.sql', import.meta.url),
    'utf8',
  );
  assert.match(
    sql,
    /protocol_version=18 AND owner_kind='profile' AND resource_kind='cover'/,
  );
  assert.match(
    sql,
    /protocol_version=5 AND owner_kind='profile' AND resource_kind='avatar'/,
  );
  assert.match(sql, /protocol_version NOT IN\(5,18\)/);
  assert.match(sql, /CREATE TABLE whaleu_media\.profile_cover_request_markers/);
  assert.match(
    sql,
    /REFERENCES whaleu_media\.upload_request_fences\(actor_id,client_request_id\) DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(sql, /f\.protocol_namespace IS DISTINCT FROM 18/);
  assert.match(sql, /i\.protocol_version<>18/);
  assert.match(sql, /e\.request_hash=NEW\.request_hash/);
  assert.match(sql, /e\.expires_at=NEW\.expires_at/);
  assert.match(
    sql,
    /media_profile_cover_binding_retention_final[^\n]+DEFERRABLE INITIALLY DEFERRED/,
  );
  assert.match(sql, /approved IS DISTINCT FROM true/);
  assert.match(
    sql,
    /jsonb_build_object\('version',18,'operation','select_cover','assets',cover_assets\)/,
  );
  assert.match(
    sql,
    /avatar_media_complete[^\n]+WHEN\(NEW.owner_kind='profile' AND NEW.resource_kind='avatar'\)/,
  );
  assert.doesNotMatch(
    sql,
    /CREATE OR REPLACE FUNCTION whaleu_profile\.avatar_definition_complete/,
  );
  assert.doesNotMatch(sql, /DROP TRIGGER media_binding_guard/);
  assert.doesNotMatch(sql, /UPDATE whaleu_media\.(assets|upload_intents) SET/);
  assert.match(
    sql,
    /a1_media_owner_epoch BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON whaleu_media\.profile_cover_request_markers/,
  );
  assert.match(
    sql,
    /WHEN 'profile-avatar-image','profile-cover-image','verification-evidence-image' THEN RETURN 'private_self_service'/,
  );
});

test('Cover migration preserves every pre-existing policy classifier and Media17 owner exclusion', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (file: string) =>
    readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
  const cover = read('0163_profile_cover_media.sql');
  const previous = read('0136_account_policy_consumers.sql');
  for (const name of ['keys', 'action']) {
    const expression = new RegExp(
      `CREATE (?:OR REPLACE )?FUNCTION whaleu_safety.account_policy_consumer_${name}\\(.*?END\\$\\$;`,
      's',
    );
    const old = previous.match(expression)?.[0];
    const current = cover
      .match(expression)?.[0]
      .replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION')
      .replace(
        / WHEN 'whaleu_profile.cover_edits','whaleu_profile.cover_command_receipts' THEN RETURN [^\n]+\n/,
        '',
      )
      .replace(
        "'profile-avatar-image','profile-cover-image','verification-evidence-image'",
        "'profile-avatar-image','verification-evidence-image'",
      );
    assert.ok(old);
    assert.equal(current, old);
  }
  const oldTrigger = read('0125_major_discussion_media.sql').match(
    /CREATE CONSTRAINT TRIGGER media_scope_consumption_complete[^\n]+/,
  )?.[0];
  const newTrigger = cover
    .match(
      /CREATE CONSTRAINT TRIGGER media_scope_consumption_complete[^\n]+/,
    )?.[0]
    .replace(
      " AND NOT(NEW.owner_kind='profile' AND NEW.resource_kind='cover')",
      '',
    );
  assert.ok(oldTrigger);
  assert.equal(newTrigger, oldTrigger);
});

test('Cover readiness expires independently and legacy avatar deadlines cannot alias cover edits', async () => {
  const { readFileSync } = await import('node:fs');
  const lifecycle = readFileSync(
    new URL('../src/media/lifecycle-repository.ts', import.meta.url),
    'utf8',
  );
  assert.match(
    lifecycle,
    /protocol_version IN \(8,9,10,11,12,13,14,15,16,17,18\) AND i\.expires_at<=clock_timestamp\(\)/,
  );
  assert.match(
    lifecycle,
    /JOIN whaleu_profile\.avatar_edits e\s+ON[^\n]+a\.owner_kind='profile' AND a\.resource_kind='avatar'/,
  );
});
