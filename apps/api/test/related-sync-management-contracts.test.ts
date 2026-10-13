import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import {
  pinCommandSchema,
  pinDetailQuerySchema,
  pinDetailSchema,
} from '../src/community/post-pins/contracts.js';
import { pinIntentHash } from '../src/community/post-pins/service.js';
import {
  adminPostRemovalCommandSchema,
  adminPostRemovalManagementQuerySchema,
  adminPostRemovalManagementSchema,
  adminPostRemovalReceiptSchema,
} from '../src/community/admin-removal/contracts.js';
import { adminPostRemovalIntentHash } from '../src/community/admin-removal/evidence.js';
import {
  adminDiscussionRemovalCommandSchema,
  adminDiscussionRemovalManagementQuerySchema,
  adminDiscussionRemovalManagementSchema,
  adminDiscussionRemovalReceiptSchema,
} from '../src/community/admin-discussion-removal/contracts.js';
import { adminDiscussionRemovalIntentHash } from '../src/community/admin-discussion-removal/evidence.js';
import { moderationManagementSchema } from '../src/profile/moderation/contracts.js';
import { avatarModerationManagementSchema } from '../src/profile/avatar-moderation/contracts.js';
import { categoryManagementSchema } from '../src/community/category-reclassification/contracts.js';
import { PostPinAuthorityFacade } from '../src/authorization/post-pin-authority.facade.js';
import { requireContentDistributionGrant } from '../src/authorization/content-distribution-grant.js';
import type { AuthorizationService } from '../src/authorization/authorization.service.js';
import type { PoolClient } from 'pg';

const actor = '11111111-1111-4111-8111-111111111111';
const postId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const spaceId = '44444444-4444-4444-8444-444444444444';
const viewSpaceId = spaceId;
const otherSpace = '55555555-5555-4555-8555-555555555555';
const expectedHash = (domain: string, command: unknown) =>
  createHash('sha256')
    .update(domain + '\n' + canonicalJson({ actor, command }))
    .digest('hex');

test('destination pin v2 binds the exact slot for every operation and preserves unversioned bytes', () => {
  for (const operation of ['pin', 'unpin', 'read'] as const) {
    const input = {
      clientRequestId: requestId,
      operation,
      postId,
      ...(operation === 'pin' ? {} : { pinId: randomUUID() }),
    };
    const legacy = pinCommandSchema.parse(input);
    assert.equal(
      pinIntentHash(actor, legacy),
      expectedHash('whaleu:post-pin:v1', legacy),
    );
    const command = pinCommandSchema.parse({ ...input, version: 2, spaceId });
    assert.equal(
      pinIntentHash(actor, command),
      expectedHash('whaleu:post-pin:v2', command),
    );
    assert.notEqual(
      pinIntentHash(actor, command),
      pinIntentHash(actor, legacy),
    );
    assert.notEqual(
      pinIntentHash(actor, command),
      pinIntentHash(
        actor,
        pinCommandSchema.parse({ ...input, version: 2, spaceId: otherSpace }),
      ),
    );
    for (const extra of [
      { spaceId },
      { version: 2 },
      { version: 3, spaceId },
      { version: 2, spaceId, grantId: actor },
    ])
      assert.equal(
        pinCommandSchema.safeParse({ ...input, ...extra }).success,
        false,
      );
  }
  assert.deepEqual(pinDetailQuerySchema.parse({ viewSpaceId }), {
    viewSpaceId,
  });
  assert.ok(
    pinDetailSchema.safeParse({
      postId,
      spaceId,
      status: 'available',
      pin: null,
      canPin: false,
      canUnpin: false,
    }).success,
  );
});

test('pure-removal v3 is strict and destination-bound, with no compound-punishment fields', () => {
  for (const kind of ['post', 'comment', 'reply'] as const) {
    const isPost = kind === 'post';
    const schema = isPost
      ? adminPostRemovalCommandSchema
      : adminDiscussionRemovalCommandSchema;
    const management = isPost
      ? adminPostRemovalManagementSchema
      : adminDiscussionRemovalManagementSchema;
    const query = isPost
      ? adminPostRemovalManagementQuerySchema
      : adminDiscussionRemovalManagementQuerySchema;
    const receiptSchema = isPost
      ? adminPostRemovalReceiptSchema
      : adminDiscussionRemovalReceiptSchema;
    const target = { kind, id: postId },
      action = isPost ? 'remove_post' : 'remove_discussion';
    const input = {
      clientRequestId: requestId,
      target,
      action,
      expectedTargetVersion: 'a'.repeat(64),
      version: 3,
      viewSpaceId,
    };
    const command = schema.parse(input);
    const hash = isPost
      ? adminPostRemovalIntentHash(
          actor,
          adminPostRemovalCommandSchema.parse(command),
        )
      : adminDiscussionRemovalIntentHash(
          actor,
          adminDiscussionRemovalCommandSchema.parse(command),
        );
    assert.equal(
      hash,
      expectedHash(
        `whaleu:admin-${isPost ? 'post' : 'discussion'}-removal-command:v3`,
        command,
      ),
    );
    assert.equal(
      query.safeParse({ ...target, version: '3', viewSpaceId }).success,
      true,
    );
    assert.equal(query.safeParse({ ...target, version: '3' }).success, false);
    assert.equal(query.safeParse({ ...target, viewSpaceId }).success, false);
    const view = {
      target,
      targetVersion: input.expectedTargetVersion,
      canRemove: true,
      version: 3,
      viewSpaceId,
    };
    assert.ok(management.safeParse(view).success);
    assert.equal(
      management.safeParse({ ...view, punishmentOptions: {} }).success,
      false,
    );
    for (const key of [
      'punishment',
      'selection',
      'grantId',
      'originalRegionId',
      'subjectId',
    ])
      assert.equal(schema.safeParse({ ...input, [key]: {} }).success, false);
    const receipt = {
      requestId,
      target,
      action,
      expectedTargetVersion: input.expectedTargetVersion,
      version: 3,
      viewSpaceId,
      outcome: 'applied',
      eventId: randomUUID(),
      recordedAt: '2026-10-13T17:00:00.000Z',
    };
    assert.ok(receiptSchema.safeParse(receipt).success);
    assert.equal(
      receiptSchema.safeParse({ ...receipt, punishment: {} }).success,
      false,
    );
    assert.equal(
      receiptSchema.safeParse({ ...receipt, selection: {} }).success,
      false,
    );
  }
});

test('unsupported Profile responses cannot carry identity, display, revision or appearance data', () => {
  for (const kind of ['post', 'comment', 'reply'] as const) {
    const target = { kind, id: postId };
    for (const [schema, capability] of [
      [moderationManagementSchema, 'canReset'],
      [avatarModerationManagementSchema, 'canClearCustomAvatar'],
    ] as const) {
      const unavailable = {
        target,
        [capability]: false,
        availability: 'unavailable',
        blocker: 'related_sync_unsupported',
      };
      assert.deepEqual(schema.parse(unavailable), unavailable);
      for (const key of [
        'subjectId',
        'profileId',
        'displayName',
        'revision',
        'expectedAppearanceId',
        'avatar',
        'grantId',
      ])
        assert.equal(
          schema.safeParse({ ...unavailable, [key]: postId }).success,
          false,
          key,
        );
    }
  }
  const category = {
    postId,
    currentCategory: 'discussion',
    revision: 0,
    canChange: false,
    targets: [],
    blocker: 'related_sync_unsupported',
  };
  assert.ok(categoryManagementSchema.safeParse(category).success);
  assert.equal(
    categoryManagementSchema.safeParse({ ...category, canChange: true })
      .success,
    false,
  );
  assert.equal(
    categoryManagementSchema.safeParse({ ...category, targets: ['pets'] })
      .success,
    false,
  );
});

test('developer retains canonical pin scope and never receives a remote-related pin grant', async () => {
  const grantId = randomUUID();
  const authority = {
    grants: async () => [
      { id: grantId, role: 'developer', operatingRegionId: null },
    ],
  } as unknown as AuthorizationService;
  const facade = new PostPinAuthorityFacade(authority);
  const tx = {
    query: async () => ({ rows: [{ until: null, current: true }] }),
  } as unknown as PoolClient;
  assert.equal(await facade.require(actor, spaceId, tx), grantId);
  assert.equal(await facade.require(actor, spaceId, tx, false), grantId);
  await assert.rejects(facade.require(actor, spaceId, tx, true), {
    code: 'AUTHORIZATION_REQUIRED',
  });
});

test('eligible destination grants distinguish unavailable distribution from known denial', async () => {
  for (const unavailable of [false, true]) {
    let queries = 0;
    const tx = {
      query: async (sql: string) => {
        queries += 1;
        assert.match(sql, /related_content_destination_grant_allowed/);
        assert.match(sql, /'allowed','unavailable'/);
        return {
          rows: unavailable
            ? [
                {
                  id: randomUUID(),
                  view_space_id: viewSpaceId,
                  until: null,
                  facts: { distribution: { status: 'unavailable' } },
                },
              ]
            : [],
        };
      },
    } as unknown as PoolClient;
    await assert.rejects(
      requireContentDistributionGrant(actor, postId, viewSpaceId, tx),
      {
        code: unavailable
          ? 'AUTHORIZATION_UNAVAILABLE'
          : 'AUTHORIZATION_REQUIRED',
      },
    );
    assert.equal(
      queries,
      1,
      'denied and unavailable candidates never wait on a grant',
    );
  }
});
