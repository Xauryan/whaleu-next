import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  mediaCancelV2Schema,
  mediaRequestRecoverySchema,
  mediaStatusV2Schema,
  prepareMediaV2Schema,
} from '../src/media/contracts-v2.js';
import { requireCurrentMediaSession } from '../src/identity/current-media-session.js';
import type { CurrentMediaSession } from '../src/identity/current-media-session.js';

const statusBase = () => ({
  version: 2,
  intentId: randomUUID(),
  requestId: randomUUID(),
  requestHash: 'a'.repeat(64),
  serverNow: 1,
});
test('v2 lifecycle facts exclude read descriptors and correlate cancellation/recovery unions', () => {
  const base = statusBase();
  const terminal = {
    ...base,
    status: 'terminal',
    reason: 'cancelled',
    cleanup: 'retained',
  };
  const bound = {
    ...base,
    status: 'bound_history',
    assetId: randomUUID(),
    bindingId: randomUUID(),
    publication: null,
    attachmentState: 'detached',
  };
  assert.equal(mediaStatusV2Schema.safeParse(bound).success, true);
  for (const prohibited of [
    { width: 1 },
    { url: 'https://example.invalid/image' },
    { manifest: {} },
    { bearer: 'secret' },
  ])
    assert.equal(
      mediaStatusV2Schema.safeParse({ ...bound, ...prohibited }).success,
      false,
    );
  assert.equal(
    mediaCancelV2Schema.safeParse({
      version: 2,
      result: 'bound_history',
      status: bound,
    }).success,
    true,
  );
  assert.equal(
    mediaCancelV2Schema.safeParse({
      version: 2,
      result: 'cancelled',
      status: bound,
    }).success,
    false,
  );
  assert.equal(
    mediaCancelV2Schema.safeParse({
      version: 2,
      result: 'already_terminal',
      status: terminal,
    }).success,
    true,
  );
  assert.equal(
    mediaRequestRecoverySchema.safeParse({
      version: 2,
      requestId: base.requestId,
      requestHash: base.requestHash,
      serverNow: 1,
      state: 'active',
      status: terminal,
    }).success,
    false,
  );
  assert.equal(
    mediaRequestRecoverySchema.safeParse({
      version: 2,
      requestId: base.requestId,
      requestHash: null,
      serverNow: 1,
      state: 'not_recorded',
      status: null,
    }).success,
    false,
  );
  assert.equal(
    mediaStatusV2Schema.safeParse({
      ...base,
      status: 'ready_unbound',
      assetId: randomUUID(),
      readyRetentionUntil: 3,
      draftExpiresAt: 2,
      bindBefore: 2,
      mediaProof: 'current',
    }).success,
    true,
  );
});
test('grant metadata cannot reconstruct a transaction-current Identity capability', () => {
  const forged = {
    accountId: randomUUID(),
    sessionId: randomUUID(),
    expiresAt: Date.now() + 10000,
    refreshExpiresAt: Date.now() + 20000,
  };
  assert.throws(() =>
    requireCurrentMediaSession(forged as CurrentMediaSession, {} as PoolClient),
  );
});

test('v2 prepare rejects noncanonical UUID case instead of silently changing identity', () => {
  const id = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
  const value = {
    clientRequestId: id,
    purpose: 'community-post-image',
    draftId: id,
    spaceId: id,
    slot: 'images',
    ordinal: 0,
    declaration: { mime: 'image/png', bytes: 1, sha256: 'a'.repeat(64) },
  };
  assert.equal(prepareMediaV2Schema.safeParse(value).success, true);
  assert.equal(
    prepareMediaV2Schema.safeParse({
      ...value,
      clientRequestId: id.toUpperCase(),
    }).success,
    false,
  );
});
