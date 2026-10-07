import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundedText,
  decodeAuthor,
  decodeCapabilities,
  decodeComment,
  decodeCommentCapabilities,
  decodeCommentIntent,
  decodeFeed,
  decodeMedia,
  decodeOwnPublications,
  decodePost,
  decodePostIntent,
  decodeReceipt,
  decodeSpaces,
} from '../src/community/contract';
import {
  anonymous,
  capabilities,
  comment,
  commentCapabilities,
  createdAt,
  intent,
  otherId,
  post,
  receipt,
  space,
  spaceId,
} from './community-helpers';
test('strict tagged anonymous projections reject identity leakage recursively', () => {
  assert.equal(decodePost(post()).author.kind, 'anonymous');
  for (const extra of [
    { accountId: otherId },
    { profileId: otherId },
    { campusId: otherId },
    { nickname: 'private' },
    { originalAuthor: { accountId: otherId } },
  ])
    assert.throws(() => decodeAuthor({ ...anonymous(), ...extra }));
  assert.throws(() =>
    decodePost({ ...post(), viewer: { ...post().viewer, accountId: otherId } }),
  );
  assert.throws(() =>
    decodeAuthor({
      ...anonymous(),
      avatar: {
        assetId: otherId,
        width: 2,
        height: 2,
        displayUrl: 'https://media.example/a',
        thumbnailUrl: 'https://media.example/b',
        expiresAt: null,
        ownerId: otherId,
      },
    }),
  );
  assert.equal(
    /accountId|profileId|campusId|accessToken/.test(
      JSON.stringify(decodePost(post())),
    ),
    false,
  );
});
test('media only accepts exact safe HTTPS views and bounded dimensions, never paths or arbitrary schemes', () => {
  const media = {
    assetId: otherId,
    width: 200,
    height: 300,
    displayUrl: 'https://media.example/a',
    thumbnailUrl: 'https://media.example/b?sig=abc',
    expiresAt: createdAt,
  };
  assert.deepEqual(decodeMedia(media), media);
  for (const url of [
    'http://media.example/a',
    'javascript:alert(1)',
    'file:///tmp/a',
    'https://u:p@media.example/a',
    'https://media.example\\evil/a',
    'https://media.example/a\n',
  ])
    assert.throws(() => decodeMedia({ ...media, displayUrl: url }));
  for (const width of [0, -1, 1.5, 32769, '200'])
    assert.throws(() => decodeMedia({ ...media, width }));
  assert.throws(() =>
    decodeMedia({ ...media, expiresAt: '2026-02-31T00:00:00.000Z' }),
  );
});
test('feed, comments, spaces and recovery contracts reject forged variants and pagination', () => {
  assert.equal(
    decodeFeed({
      items: [post()],
      nextCursor: null,
      continuation: 'login_required',
    }).items.length,
    1,
  );
  for (const value of [
    { items: [post()], nextCursor: 'abc', continuation: 'login_required' },
    { items: [post(), post()], nextCursor: null, continuation: 'end' },
    { items: [], nextCursor: null, continuation: 'available' },
    { items: [], nextCursor: 'x'.repeat(1025), continuation: 'available' },
  ])
    assert.throws(() => decodeFeed(value));
  assert.throws(() => decodePost({ ...post(), likeCount: -1 }));
  assert.throws(() =>
    decodePost({ ...post(), viewer: { ...post().viewer, isSelf: 0 } }),
  );
  assert.throws(() => decodeComment({ ...comment(), text: '', images: [] }));
  assert.throws(() =>
    decodeSpaces({
      regional: space({ kind: 'global', operatingRegionId: null }),
      global: [],
    }),
  );
  assert.throws(() =>
    decodeSpaces({ regional: space({ operatingRegionId: null }), global: [] }),
  );
  assert.deepEqual(decodeSpaces({ regional: null, global: [] }), {
    regional: null,
    global: [],
  });
  assert.throws(() =>
    decodeOwnPublications({
      items: [
        {
          id: otherId,
          spaceId,
          category: 'discussion',
          status: 'hidden',
          publishedAt: createdAt,
          text: 'hidden',
        },
      ],
      nextCursor: null,
    }),
  );
});
test('receipts require matching strict terminal union and reject transient/auth as terminal rejection', () => {
  assert.deepEqual(decodeReceipt(receipt()), receipt());
  for (const code of [
    'COMMUNITY_UNAVAILABLE',
    'MEDIA_UNAVAILABLE',
    'SESSION_REVOKED',
    'REQUEST_NOT_FOUND',
    'MADE_UP',
  ])
    assert.throws(() =>
      decodeReceipt({
        requestId: intent().clientRequestId,
        operation: 'publish_post',
        outcome: 'rejected',
        code,
      }),
    );
  assert.equal(
    decodeReceipt({
      requestId: intent().clientRequestId,
      operation: 'publish_post',
      outcome: 'rejected',
      code: 'CONTENT_REJECTED',
    }).outcome,
    'rejected',
  );
  assert.throws(() => decodeReceipt({ ...receipt(), outcome: 'pending' }));
  assert.throws(() =>
    decodeReceipt({
      ...receipt(),
      requestId: otherId.replace('-4999-', '-5999-'),
    }),
  );
});
test('exact publication intent preserves Unicode whitespace and prohibits forged fields and arbitrary image URLs', () => {
  assert.equal(
    decodePostIntent(intent({ text: '  🐳\n内容\t ' })).text,
    '  🐳\n内容\t ',
  );
  assert.throws(() => decodePostIntent({ ...intent(), verified: true }));
  assert.throws(() =>
    decodePostIntent({ ...intent(), imageUrls: ['https://evil.example/pic'] }),
  );
  assert.throws(() =>
    decodePostIntent(intent({ imageAssetIds: [otherId, otherId] })),
  );
  for (const text of [' ', 'x'.repeat(2501), '\ud800', 'a\rb', 'a\u0085b'])
    assert.throws(() => decodePostIntent(intent({ text })));
  assert.equal(boundedText('🐳'.repeat(2500), 1, 2500), true);
  assert.throws(() =>
    decodeCommentIntent({
      clientRequestId: intent().clientRequestId,
      text: ' ',
      imageAssetIds: [],
      authorMode: 'named',
    }),
  );
});
test('capabilities fail closed and comment policy is independent with explicit forced mode', () => {
  assert.deepEqual(decodeCapabilities(capabilities()), capabilities());
  assert.throws(() =>
    decodeCapabilities(
      capabilities({ publish: { availability: 'unavailable', reason: null } }),
    ),
  );
  assert.throws(() =>
    decodeCapabilities({ ...capabilities(), mediaAvailability: 'available' }),
  );
  assert.throws(() =>
    decodeCapabilities(capabilities({ authorModes: ['named', 'named'] })),
  );
  assert.deepEqual(
    decodeCommentCapabilities(commentCapabilities()),
    commentCapabilities(),
  );
  assert.throws(() =>
    decodeCommentCapabilities(
      commentCapabilities({
        authorModes: ['named'],
        forcedAuthorMode: 'anonymous',
      }),
    ),
  );
});

test('cursor and capability codes reject trailing newline even where a regex dollar-anchor would match', () => {
  assert.throws(() =>
    decodeFeed({ items: [], nextCursor: 'abc\n', continuation: 'available' }),
  );
  assert.throws(() =>
    decodeCapabilities(
      capabilities({
        publish: { availability: 'denied', reason: 'COMMUNITY_UNAVAILABLE\n' },
      }),
    ),
  );
  assert.throws(() => decodePost({ ...post(), id: post().id + '\n' }));
});
