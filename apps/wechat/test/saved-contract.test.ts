import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePost } from '../src/community/contract';
import {
  decodePostUpdatePreferences,
  decodeSavedIntent,
  decodeSavedList,
  decodeSavedReceipt,
  decodeSavedStatuses,
  matchSavedReceipt,
  type PostUpdatePreferences,
  type SavedIntent,
  type SavedReceipt,
} from '../src/community/saved-contract';
import {
  createdAt,
  formationPost,
  otherId,
  pollPost,
  post,
  postId,
  requestId,
  tradingPost,
  tradingView,
} from './community-helpers';

const preferences = (): PostUpdatePreferences => ({
  postId,
  savedUpdatesEnabled: true,
  externalUpdatesEnabled: true,
  revision: '0',
  canSetPreference: true,
  reason: null,
  inAppCapability: 'unavailable',
  externalCapability: 'unavailable',
});
const intent = (): SavedIntent => ({
  clientRequestId: requestId,
  operation: 'set_post_saved',
  postId,
  desired: true,
  channel: null,
});
const receipt = (): SavedReceipt => ({
  requestId,
  operation: 'set_post_saved',
  postId,
  desired: true,
  channel: null,
  outcome: 'applied',
});
const savedPost = (value = post()) => ({
  ...value,
  saveCount: 1,
  viewer: {
    ...value.viewer,
    isSaved: true,
    canSave: true,
    canSetUpdatePreference: true,
  },
});
const entry = () => ({
  post: savedPost(),
  savedAt: createdAt,
  saveEpochId: otherId,
});
const list = () => ({
  items: [entry()],
  nextCursor: null,
  visibleSavedCount: 1,
});
const status = () => ({
  postId,
  status: 'available',
  saveCount: 1,
  isSaved: true,
  savedAt: createdAt,
  saveEpochId: otherId,
  preferences: preferences(),
});

test('Saved intents and immutable receipts bind exact post, operation, channel and desired state', () => {
  for (const operation of [
    'set_post_saved',
    'set_post_update_preference',
  ] as const) {
    for (const desired of [false, true]) {
      for (const channel of operation === 'set_post_saved'
        ? ([null] as const)
        : (['saved', 'external'] as const)) {
        const requested = { ...intent(), operation, channel, desired };
        const applied = { ...receipt(), operation, channel, desired };
        assert.deepEqual(decodeSavedIntent(requested), requested);
        assert.deepEqual(decodeSavedReceipt(applied), applied);
        assert.ok(Object.isFrozen(decodeSavedIntent(requested)));
        assert.ok(Object.isFrozen(decodeSavedReceipt(applied)));
        matchSavedReceipt(requested, decodeSavedReceipt(applied));
        for (const code of [
          'POST_NOT_FOUND',
          'COMMUNITY_SCOPE_UNAVAILABLE',
          'PHONE_VERIFICATION_REQUIRED',
          'COMMUNITY_ACTION_RESTRICTED',
        ]) {
          const rejected = { ...applied, outcome: 'rejected', code };
          assert.deepEqual(decodeSavedReceipt(rejected), rejected);
          matchSavedReceipt(requested, decodeSavedReceipt(rejected));
        }
      }
    }
  }
  for (const outcome of ['applied', 'rejected'] as const) {
    const result: SavedReceipt =
      outcome === 'rejected'
        ? { ...receipt(), outcome, code: 'POST_NOT_FOUND' }
        : receipt();
    for (const changed of [
      { ...result, requestId: otherId },
      { ...result, postId: otherId },
      { ...result, desired: false },
      {
        ...result,
        operation: 'set_post_update_preference' as const,
        channel: 'saved' as const,
      },
    ])
      assert.throws(() => matchSavedReceipt(intent(), changed), {
        kind: 'protocol',
      });
    const requested = {
      ...intent(),
      operation: 'set_post_update_preference' as const,
      channel: 'saved' as const,
    };
    assert.throws(
      () =>
        matchSavedReceipt(requested, {
          ...result,
          operation: 'set_post_update_preference',
          channel: 'external',
        }),
      { kind: 'protocol' },
    );
  }
});

test('Saved intent decoder rejects coercions, forged operation/channel combinations and extra private fields', () => {
  for (const bad of [
    null,
    [],
    { ...intent(), clientRequestId: 'bad' },
    { ...intent(), clientRequestId: '77777777-7777-1777-8777-777777777777' },
    { ...intent(), postId: 'bad' },
    { ...intent(), desired: 1 },
    { ...intent(), desired: 'true' },
    { ...intent(), operation: ['set_post_saved'] },
    { ...intent(), operation: 'set_post_update_preference' },
    { ...intent(), operation: 'set_post_update_preference', channel: 'all' },
    {
      ...intent(),
      operation: 'set_post_update_preference',
      channel: ['saved'],
    },
    { ...intent(), channel: 'saved' },
    { ...intent(), accountId: otherId },
    { ...intent(), savedAt: createdAt },
    { ...intent(), saveCount: 1 },
  ])
    assert.throws(() => decodeSavedIntent(bad), { kind: 'protocol' });
});

test('Saved receipts admit only terminal scalar outcomes and no mutable state or delivery claims', () => {
  for (const bad of [
    { ...receipt(), outcome: 'pending' },
    { ...receipt(), outcome: 'created' },
    { ...receipt(), outcome: ['applied'] },
    { ...receipt(), outcome: { toString: () => 'applied' } },
    { ...receipt(), desired: 'true' },
    { ...receipt(), channel: 'external' },
    { ...receipt(), operation: 'publish_post' },
    { ...receipt(), requestId: otherId, clientRequestId: requestId },
    { ...receipt(), requestId: '77777777-7777-1777-8777-777777777777' },
    { ...receipt(), outcome: 'rejected' },
    { ...receipt(), outcome: 'rejected', code: 'REQUEST_NOT_FOUND' },
    { ...receipt(), outcome: 'rejected', code: 'SESSION_REVOKED' },
    { ...receipt(), code: 'POST_NOT_FOUND' },
    ...[
      'saveCount',
      'isSaved',
      'savedAt',
      'saveEpochId',
      'preferences',
      'accountId',
      'profileId',
      'post',
      'contacts',
      'providerStatus',
      'delivered',
    ].map((field) => ({ ...receipt(), [field]: 'private-or-mutable' })),
  ])
    assert.throws(() => decodeSavedReceipt(bad), { kind: 'protocol' });
});

test('independent per-post preference bits preserve decimal revisions without implying delivery capability', () => {
  for (const savedUpdatesEnabled of [false, true]) {
    for (const externalUpdatesEnabled of [false, true]) {
      const raw = {
        ...preferences(),
        savedUpdatesEnabled,
        externalUpdatesEnabled,
        revision: '900719925474099312345',
      };
      assert.deepEqual(decodePostUpdatePreferences(raw), raw);
      assert.ok(Object.isFrozen(decodePostUpdatePreferences(raw)));
    }
  }
  for (const reason of [
    'POST_NOT_FOUND',
    'COMMUNITY_SCOPE_UNAVAILABLE',
    'PHONE_VERIFICATION_REQUIRED',
    'COMMUNITY_ACTION_RESTRICTED',
    'COMMUNITY_UNAVAILABLE',
  ]) {
    assert.equal(
      decodePostUpdatePreferences({
        ...preferences(),
        canSetPreference: false,
        reason,
      }).reason,
      reason,
    );
  }
  for (const bad of [
    { ...preferences(), savedUpdatesEnabled: 1 },
    { ...preferences(), externalUpdatesEnabled: 'false' },
    { ...preferences(), canSetPreference: true, reason: 'POST_NOT_FOUND' },
    { ...preferences(), canSetPreference: false },
    { ...preferences(), canSetPreference: false, reason: 'REQUEST_NOT_FOUND' },
    { ...preferences(), inAppCapability: 'available' },
    { ...preferences(), externalCapability: 'delivered' },
    { ...preferences(), notificationsEnabled: true },
    { ...preferences(), providerConsent: true },
    ...[
      0,
      -1,
      '',
      '01',
      '-1',
      '1.0',
      '1e3',
      ' 1',
      '1 ',
      '1\n',
      '1'.repeat(31),
    ].map((revision) => ({ ...preferences(), revision })),
  ])
    assert.throws(() => decodePostUpdatePreferences(bad), { kind: 'protocol' });
});

test('Saved list keeps canonical poll, formation, urgent and resolved trading summaries and private aggregate semantics', () => {
  for (const value of [
    post(),
    pollPost(),
    formationPost(),
    tradingPost({
      trading: tradingView({ urgency: 'urgent', resolution: 'resolved' }),
    }),
  ]) {
    const raw = {
      ...list(),
      items: [{ ...entry(), post: savedPost(value) }],
      visibleSavedCount: 8,
    };
    const decoded = decodeSavedList(raw);
    assert.deepEqual(decoded, raw);
    assert.equal(decoded.items[0]!.post.saveCount, 1);
    assert.equal(decoded.visibleSavedCount, 8);
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.items));
    assert.ok(Object.isFrozen(decoded.items[0]));
    assert.equal(JSON.stringify(decoded).includes('synthetic-wechat'), false);
  }
  assert.deepEqual(
    decodeSavedList({ items: [], nextCursor: null, visibleSavedCount: 0 })
      .items,
    [],
  );
});

test('Saved list rejects duplicate identities, invalid epochs, inconsistent counts and leaked resource data', () => {
  const item = entry();
  for (const bad of [
    { ...list(), visibleSavedCount: 0 },
    { ...list(), visibleSavedCount: 1.5 },
    { ...list(), visibleSavedCount: '1' },
    { ...list(), visibleSavedCount: 2147483648 },
    { ...list(), nextCursor: 'bad&cursor' },
    { items: [], nextCursor: 'more', visibleSavedCount: 0 },
    { ...list(), items: [item, item], visibleSavedCount: 2 },
    {
      ...list(),
      items: [item, { ...item, post: { ...item.post, id: requestId } }],
      visibleSavedCount: 2,
    },
    { ...list(), items: [{ ...item, savedAt: 'not-a-time' }] },
    { ...list(), items: [{ ...item, saveEpochId: null }] },
    { ...list(), items: [{ ...item, saveEpochId: 'not-an-id' }] },
    { ...list(), items: [{ ...item, accountId: otherId }] },
    { ...list(), items: [{ ...item, post: { ...item.post, saveCount: 0 } }] },
    {
      ...list(),
      items: [
        {
          ...item,
          post: {
            ...item.post,
            viewer: { ...item.post.viewer, isSaved: false },
          },
        },
      ],
    },
    {
      ...list(),
      items: [
        { ...item, post: { ...item.post, contacts: { phone: 'private' } } },
      ],
    },
    {
      ...list(),
      items: [
        {
          ...item,
          post: {
            ...item.post,
            author: { ...item.post.author, accountId: otherId },
          },
        },
      ],
    },
    { ...list(), accountId: otherId },
    { ...list(), hiddenSavedCount: 12 },
    {
      ...list(),
      items: Array.from({ length: 51 }, () => item),
      visibleSavedCount: 51,
    },
  ])
    assert.throws(() => decodeSavedList(bad), { kind: 'protocol' });
});

test('Saved batch exposes only typed self-state and indistinguishable unavailable targets', () => {
  const raw = {
    items: [status(), { postId: requestId, status: 'unavailable' }],
  };
  assert.deepEqual(decodeSavedStatuses(raw), raw);
  const decoded = decodeSavedStatuses(raw);
  assert.ok(Object.isFrozen(decoded.items));
  assert.ok(Object.isFrozen(decoded.items[0]));
  const unsaved = {
    ...status(),
    isSaved: false,
    savedAt: null,
    saveEpochId: null,
    saveCount: 7,
  };
  assert.deepEqual(decodeSavedStatuses({ items: [unsaved] }).items[0], unsaved);
  for (const bad of [
    { items: [] },
    { items: [status(), status()] },
    { items: Array.from({ length: 101 }, () => status()) },
    { items: [status()], visibleSavedCount: 1 },
    { items: [{ postId, status: 'unavailable', saveCount: 0 }] },
    { items: [{ postId, status: 'unavailable', accountId: otherId }] },
    { items: [{ postId, status: 'hidden' }] },
    {
      items: [
        { ...status(), preferences: { ...preferences(), postId: otherId } },
      ],
    },
    { items: [{ ...status(), isSaved: false }] },
    { items: [{ ...status(), savedAt: null }] },
    { items: [{ ...status(), saveEpochId: null }] },
    { items: [{ ...status(), saveCount: 0 }] },
    { items: [{ ...status(), saveCount: -1 }] },
    { items: [{ ...status(), saveCount: '1' }] },
    { items: [{ ...status(), accountId: otherId }] },
    {
      items: [
        { ...status(), preferences: { ...preferences(), quotaRemaining: 5 } },
      ],
    },
  ])
    assert.throws(() => decodeSavedStatuses(bad), { kind: 'protocol' });
});

test('canonical posts require exact Saved booleans and server-derived counts without adding a student or discussion gate', () => {
  const value = savedPost();
  const restricted = {
    ...value,
    commentsPolicy: 'restricted',
    viewer: { ...value.viewer, canComment: false },
  };
  assert.equal(decodePost(restricted).viewer.canSave, true);
  for (const bad of [
    { ...value, saveCount: undefined },
    { ...value, saveCount: '1' },
    { ...value, saveCount: -1 },
    { ...value, saveCount: 1.5 },
    { ...value, viewer: { ...value.viewer, isSaved: undefined } },
    { ...value, viewer: { ...value.viewer, canSave: 'true' } },
    { ...value, viewer: { ...value.viewer, canSetUpdatePreference: 1 } },
    { ...value, saverAccountIds: [otherId] },
  ])
    assert.throws(() => decodePost(bad), { kind: 'protocol' });
});

test('Saved intent and receipt IDs enforce established lowercase canonical UUID contracts', () => {
  const lowerPost = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const lowerRequest = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const canonical = {
    ...intent(),
    postId: lowerPost,
    clientRequestId: lowerRequest,
  };
  assert.deepEqual(decodeSavedIntent(canonical), canonical);
  for (const changed of [
    { ...canonical, postId: lowerPost.toUpperCase() },
    { ...canonical, clientRequestId: lowerRequest.toUpperCase() },
  ])
    assert.throws(() => decodeSavedIntent(changed), { kind: 'protocol' });
  for (const changed of [
    { ...receipt(), postId: lowerPost.toUpperCase() },
    { ...receipt(), requestId: lowerRequest.toUpperCase() },
  ])
    assert.throws(() => decodeSavedReceipt(changed), { kind: 'protocol' });
});
