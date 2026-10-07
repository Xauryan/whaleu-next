import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  profilePostsQuerySchema,
  profileTradingQuerySchema,
  emptyBodySchema,
  emptyQuerySchema,
} from '../src/profile-discovery/contracts.js';
import {
  decodeProfileCursor,
  encodeProfileCursor,
  profileCursorScope,
} from '../src/profile-discovery/cursor.js';
import { blockRequestSchema } from '../src/safety/contracts.js';
import { reportRequestSchema } from '../src/safety/reporting/contracts.js';
import { identityBatchSchema } from '../src/identity-privacy/contracts.js';
import { ProfileVisibilityFacade } from '../src/safety/profile-visibility.facade.js';
import type { SafetyRepository } from '../src/safety/repository.js';
import { ApplicationError } from '../src/http/application-error.js';

test('public discovery uses strict bounded read queries without private selectors or new browsing gates', () => {
  assert.deepEqual(profilePostsQuerySchema.parse({}), { limit: 20 });
  assert.deepEqual(
    profileTradingQuerySchema.parse({ limit: '50', tradingSubtype: 'qiugou' }),
    { limit: 50, tradingSubtype: 'qiugou' },
  );
  for (const input of [
    { accountId: randomUUID() },
    { profileId: randomUUID() },
    { limit: '0' },
    { limit: '01' },
    { limit: 20 },
    { limit: '51' },
    { limit: ['1', '2'] },
    { cursor: 'x'.repeat(1025) },
    { cursor: '=' },
    { tradingSubtype: 'shuma' },
  ])
    assert.equal(profilePostsQuerySchema.safeParse(input).success, false);
  assert.equal(
    profileTradingQuerySchema.safeParse({ tradingSubtype: 'for_sale' }).success,
    false,
  );
  assert.deepEqual(emptyBodySchema.parse(undefined), {});
  for (const schema of [emptyBodySchema, emptyQuerySchema])
    assert.equal(schema.safeParse({ accountId: randomUUID() }).success, false);
});

test('profile cursors bind profile, kind, subtype, viewer, session and limit without private bytes', () => {
  const profileId = randomUUID(),
    accountId = randomUUID(),
    sessionId = randomUUID(),
    id = randomUUID();
  const session = { accountId, sessionId, expiresAt: 1, refreshExpiresAt: 2 };
  const query = { limit: 20 };
  const scope = profileCursorScope(profileId, 'posts', query, session);
  const at = '2001-01-01T00:00:00.000Z';
  const cursor = encodeProfileCursor(at, id, scope);
  assert.deepEqual(decodeProfileCursor(cursor, scope), { at, id });
  const bytes = Buffer.from(cursor, 'base64url').toString();
  for (const privateId of [accountId, sessionId])
    assert.ok(!bytes.includes(privateId));
  const alternatives = [
    profileCursorScope(randomUUID(), 'posts', query, session),
    profileCursorScope(profileId, 'trading', query, session),
    profileCursorScope(profileId, 'posts', { limit: 10 }, session),
    profileCursorScope(profileId, 'posts', query, {
      ...session,
      accountId: randomUUID(),
    }),
    profileCursorScope(profileId, 'posts', query, {
      ...session,
      sessionId: randomUUID(),
    }),
    profileCursorScope(profileId, 'posts', query, null),
    profileCursorScope(
      profileId,
      'posts',
      { ...query, tradingSubtype: 'qiugou' },
      session,
    ),
  ];
  for (const other of alternatives)
    assert.throws(() => decodeProfileCursor(cursor, other));
  for (const corrupt of [
    '=',
    'x'.repeat(1025),
    Buffer.from(JSON.stringify({ ...JSON.parse(bytes), accountId })).toString(
      'base64url',
    ),
    Buffer.from(JSON.stringify({ ...JSON.parse(bytes), at: 'now' })).toString(
      'base64url',
    ),
    `${cursor}=`,
  ])
    assert.throws(() => decodeProfileCursor(corrupt, scope));
});

test('profile block sources never expand report or privileged identity target kinds', () => {
  const source = { kind: 'profile', id: randomUUID() };
  assert.equal(
    blockRequestSchema.safeParse({
      clientRequestId: randomUUID(),
      source,
      blocked: true,
    }).success,
    true,
  );
  assert.equal(
    reportRequestSchema.safeParse({
      clientRequestId: randomUUID(),
      target: source,
    }).success,
    false,
  );
  assert.equal(
    identityBatchSchema.safeParse({ targets: [source] }).success,
    false,
  );
});

test('real profile safety preserves own outgoing relationship but hides incoming private state', async () => {
  const viewer = randomUUID(),
    target = randomUUID(),
    tx = {} as PoolClient;
  const relationship = {
    relationshipId: randomUUID(),
    blocked: true as const,
    revision: '2',
  };
  let called = 0;
  const records = {
    directions: async (a: string, b: string, purpose: string) => {
      assert.equal(a, viewer);
      assert.equal(b, target);
      assert.equal(purpose, 'public_profile');
      called++;
      return { outgoing: true, incoming: true };
    },
    outgoingReference: async () => relationship,
  } as unknown as SafetyRepository;
  const facade = new ProfileVisibilityFacade(records);
  assert.deepEqual(await facade.read(null, target, tx), {
    status: 'available',
  });
  assert.deepEqual(await facade.read(target, target, tx), {
    status: 'available',
  });
  assert.equal(called, 0);
  assert.deepEqual(await facade.read(viewer, target, tx), {
    status: 'blocked_by_you',
    relationship,
  });
  records.directions = async () => ({ outgoing: false, incoming: true });
  assert.deepEqual(await facade.read(viewer, target, tx), {
    status: 'unavailable',
  });
  records.directions = async () => ({ outgoing: false, incoming: false });
  assert.deepEqual(await facade.read(viewer, target, tx), {
    status: 'available',
  });
  records.directions = async () => null;
  await assert.rejects(
    facade.read(viewer, target, tx),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === 'SAFETY_UNAVAILABLE',
  );
});
