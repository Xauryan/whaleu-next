import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeBlockIntent,
  decodeBlockResult,
  decodeBlocksList,
  decodeBlockState,
  matchBlockResult,
} from '../src/community/block-contract';
import {
  blockEntry,
  blockIntent,
  blockResult,
  unblockIntent,
} from './block-helpers';
import { otherId, postId, requestId } from './community-helpers';

test('strict block intent only accepts content references or opaque own cleanup and rejects private identities/snapshots', () => {
  for (const value of [blockIntent(), unblockIntent()])
    assert.deepEqual(decodeBlockIntent(value), value);
  for (const value of [
    { ...blockIntent(), accountId: otherId },
    { ...blockIntent(), source: { kind: 'anonymous', id: postId } },
    {
      ...blockIntent(),
      source: { kind: 'post', id: postId, actorAccountId: otherId },
    },
    { ...blockIntent(), display: { displayName: 'private snapshot' } },
    { ...unblockIntent(), expectedRevision: 1 },
    { ...unblockIntent(), source: { kind: 'post', id: postId } },
    { ...unblockIntent(), blocked: true },
  ])
    assert.throws(() => decodeBlockIntent(value));
});
test('minimal immutable receipt differs from current latest state and must match exact own operation', () => {
  const value = blockResult(blockIntent(), false, '2');
  assert.deepEqual(decodeBlockResult(value), value);
  assert.equal(value.receipt.outcome, 'applied');
  assert.equal(value.current?.blocked, false);
  matchBlockResult(blockIntent(), value);
  const rejected = {
    receipt: {
      requestId,
      operation: 'block_named',
      outcome: 'rejected',
      code: 'BLOCK_TARGET_NOT_ALLOWED',
    },
    current: null,
  };
  assert.deepEqual(decodeBlockResult(rejected), rejected);
  for (const raw of [
    { ...value, accountId: otherId },
    {
      ...value,
      receipt: { ...value.receipt, source: { kind: 'post', id: postId } },
    },
    { ...value, current: { ...value.current, revision: '0' } },
    { ...value, current: { ...value.current, revision: '1' } },
    { ...value, current: { ...value.current, relationshipId: postId } },
    { ...rejected, current: value.current },
    {
      ...rejected,
      receipt: { ...rejected.receipt, code: 'RAW_DATABASE_ERROR' },
    },
  ])
    assert.throws(() => decodeBlockResult(raw));
  assert.throws(() => matchBlockResult(unblockIntent(), value));
  assert.throws(() =>
    matchBlockResult({ ...blockIntent(), clientRequestId: otherId }, value),
  );
  assert.throws(() =>
    decodeBlockState({ ...value.current, actorAccountId: postId }),
  );
});
test('own block list safe unavailable targets remain removable without raw profile or original source', () => {
  for (const display of [
    { kind: 'unavailable', displayName: null },
    { kind: 'current', displayName: '公开昵称' },
    { kind: 'snapshot', displayName: '已允许的历史昵称' },
  ]) {
    const raw = { items: [{ ...blockEntry(), display }], nextCursor: null };
    assert.deepEqual(decodeBlocksList(raw), raw);
  }
  for (const display of [
    { kind: 'unavailable', displayName: 'leak' },
    { kind: 'current', displayName: null },
    { kind: 'current', displayName: 'public', avatarUrl: 'private' },
  ])
    assert.throws(() =>
      decodeBlocksList({
        items: [{ ...blockEntry(), display }],
        nextCursor: null,
      }),
    );
  assert.throws(() =>
    decodeBlocksList({ items: [blockEntry(), blockEntry()], nextCursor: null }),
  );
  assert.throws(() =>
    decodeBlocksList({
      items: [{ ...blockEntry(), accountId: otherId }],
      nextCursor: null,
    }),
  );
});
