import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  publishPostSchema,
  publishCommentSchema,
  feedQuerySchema,
} from '../src/community/contracts.js';
import { decodeCursor, encodeCursor } from '../src/community/cursor.js';
import {
  requirePublication,
  requireAction,
  UnavailableAuthorization,
  UnavailableContentGate,
  UnavailableMedia,
  UnavailableVisibility,
} from '../src/community/community-policy.js';
import { ApplicationError } from '../src/http/application-error.js';
import { publicationHash } from '../src/community/publication.repository.js';
import { verified } from './support/community-fixtures.js';
const post = {
  clientRequestId: randomUUID(),
  spaceId: randomUUID(),
  category: 'discussion',
  text: '甲\r\n🐳',
  authorMode: 'anonymous',
};
const code = (expected: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === expected;
test('strict publication canonicalization preserves text, materializes defaults and rejects forged authorities and unsafe inputs', () => {
  const parsed = publishPostSchema.parse(post);
  assert.equal(parsed.text, '甲\n🐳');
  assert.deepEqual(parsed.imageAssetIds, []);
  assert.equal(parsed.commentsPolicy, 'open');
  for (const change of [
    { isVerified: true },
    { accountId: randomUUID() },
    { admin: true },
    { imageUrls: ['https://example.com/a'] },
    { text: ' ' },
    { text: 'x\0' },
    { text: 'x\u0085' },
    { text: '\ud800' },
    { text: '🐳'.repeat(2501) },
    {
      imageAssetIds: [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ],
    },
  ])
    assert.equal(
      publishPostSchema.safeParse({ ...post, ...change }).success,
      false,
    );
  assert.equal(
    publishPostSchema.safeParse({ ...post, text: '🐳'.repeat(2500) }).success,
    true,
  );
  const id = randomUUID();
  assert.equal(
    publishPostSchema.safeParse({ ...post, imageAssetIds: [id, id] }).success,
    false,
  );
  assert.equal(
    publishCommentSchema.safeParse({
      clientRequestId: randomUUID(),
      text: '',
      authorMode: 'named',
      imageAssetIds: [id],
    }).success,
    true,
  );
  assert.equal(
    publishCommentSchema.safeParse({
      clientRequestId: randomUUID(),
      text: '',
      authorMode: 'named',
    }).success,
    false,
  );
  for (const value of [
    { spaceId: post.spaceId, limit: '11' },
    { spaceId: [post.spaceId, post.spaceId] },
    { spaceId: post.spaceId, verified: true },
    { spaceId: post.spaceId, limit: 10 },
  ])
    assert.equal(feedQuerySchema.safeParse(value).success, false);
  assert.notEqual(
    publicationHash('publish_post', parsed),
    publicationHash('publish_comment', parsed),
  );
});
test('cursor is strict, versioned and bound to scope and size', () => {
  const scope = 'feed:' + randomUUID();
  const seek = { at: '2026-10-07T00:00:00.000Z', id: randomUUID() };
  const cursor = encodeCursor(seek, scope, 10);
  assert.deepEqual(decodeCursor(cursor, scope, 10), seek);
  for (const args of [
    [cursor, scope, 9],
    [cursor, 'another', 10],
    ['!', scope, 10],
    [
      Buffer.from(
        JSON.stringify({ v: 1, scope, limit: 10, ...seek, extra: true }),
      ).toString('base64url'),
      scope,
      10,
    ],
  ] as const)
    assert.throws(() => decodeCursor(args[0], args[1], args[2]));
});
test('authority matrix is explicit, independent of browsing preference and rejects missing or cross-region evidence', () => {
  const region = randomUUID();
  const space = {
    id: randomUUID(),
    kind: 'regional' as const,
    name: 'Synthetic',
    isActive: true,
    operatingRegionId: region,
  };
  const authority = verified(region);
  requirePublication(
    authority,
    space,
    'discussion',
    'anonymous',
    'publish_post',
  );
  assert.throws(
    () =>
      requirePublication(
        { ...authority, phoneVerified: false },
        space,
        'discussion',
        'named',
        'publish_post',
      ),
    code('PHONE_VERIFICATION_REQUIRED'),
  );
  assert.throws(
    () =>
      requirePublication(
        { ...authority, identityRegionId: null },
        space,
        'discussion',
        'named',
        'publish_post',
      ),
    code('IDENTITY_CAMPUS_REQUIRED'),
  );
  assert.throws(
    () =>
      requirePublication(
        {
          ...authority,
          identityRegionId: randomUUID(),
          crossRegionAllowed: true,
        },
        space,
        'discussion',
        'anonymous',
        'publish_post',
      ),
    code('AUTHOR_MODE_NOT_ALLOWED'),
  );
  const unverified = {
    ...authority,
    studentVerified: false,
    unverifiedCategories: ['discussion' as const],
    unverifiedCommentsAllowed: true,
  };
  requirePublication(unverified, space, 'discussion', 'named', 'publish_post');
  requireAction(unverified, 'like');
  assert.throws(
    () =>
      requirePublication(
        unverified,
        space,
        'discussion',
        'anonymous',
        'publish_post',
      ),
    code('AUTHOR_MODE_NOT_ALLOWED'),
  );
  assert.throws(
    () =>
      requirePublication(
        unverified,
        space,
        'discussion',
        'named',
        'publish_comment',
        'anonymous',
      ),
    code('AUTHOR_MODE_NOT_ALLOWED'),
  );
  assert.throws(
    () =>
      requirePublication(
        unverified,
        { ...space, kind: 'global', operatingRegionId: null },
        'discussion',
        'named',
        'publish_post',
      ),
    code('STUDENT_VERIFICATION_REQUIRED'),
  );
  assert.throws(
    () =>
      requireAction({ ...authority, restrictedActions: ['delete'] }, 'delete'),
    code('COMMUNITY_ACTION_RESTRICTED'),
  );
});
test('ordinary dependency adapters always fail closed', async () => {
  assert.deepEqual(await new UnavailableAuthorization().resolve(), {
    kind: 'unavailable',
  });
  assert.deepEqual(await new UnavailableContentGate().check(), {
    kind: 'unavailable',
  });
  assert.deepEqual(await new UnavailableVisibility().check(), {
    kind: 'unavailable',
  });
  assert.deepEqual(await new UnavailableMedia().resolveOwned(), {
    kind: 'unavailable',
  });
});

test('media projection rejects malformed expiry, credentials, controls, asset substitution and dimensions', async () => {
  const { CommunitySerializer } =
    await import('../src/community/community-serialization.js');
  const assetId = randomUUID();
  const repository = {
    images: async () => [{ assetId, digest: 'a'.repeat(64) }],
  } as unknown as import('../src/community/community.repository.js').CommunityRepository;
  const view = {
    assetId,
    width: 100,
    height: 100,
    displayUrl: 'https://synthetic.invalid/full',
    thumbnailUrl: 'https://synthetic.invalid/thumb',
    expiresAt: null,
  };
  for (const change of [
    { expiresAt: '2099-99-99T00:00:00.000Z' },
    { expiresAt: '2099-02-30T00:00:00.000Z' },
    { expiresAt: '2000-01-01T00:00:00.000Z' },
    { displayUrl: 'https://user:secret@synthetic.invalid/image' },
    { displayUrl: 'https://synthetic.invalid/\nimage' },
    { width: 0 },
    { height: 20001 },
    { assetId: randomUUID() },
  ]) {
    const media = {
      display: async () => ({
        kind: 'allow' as const,
        value: [{ ...view, ...change }],
      }),
      resolveOwned: async () => ({ kind: 'unavailable' as const }),
    };
    const serializer = new CommunitySerializer(
      {} as import('../src/community/saved/repository.js').SavedRepository,
      repository,
      {} as import('../src/profile/author-display.service.js').AuthorDisplayService,
      media,
      {} as import('../src/community/community-access.service.js').CommunityAccessService,
      {} as import('../src/community/polls/poll-read.service.js').PollReadService,
      {} as import('../src/community/formation/service.js').FormationService,
      {} as import('../src/community/trading/repository.js').TradingRepository,
    );
    await assert.rejects(
      serializer.images('post', randomUUID(), {} as import('pg').PoolClient),
      code('MEDIA_UNAVAILABLE'),
    );
  }
});
