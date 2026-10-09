import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalRatingText,
  decodeRatingCategory,
  decodeRatingCategoryPage,
  decodeRatingComment,
  decodeRatingCommentPage,
  decodeRatingContext,
  decodeRatingIntent,
  decodeRatingMyScore,
  decodeRatingReceipt,
  decodeRatingSummary,
  decodeRatingTarget,
  decodeRatingTargetPage,
  matchRatingReceipt,
} from '../src/ratings/contract';
import {
  body,
  category,
  categoryId,
  categoryPage,
  comment,
  commentPage,
  emptySummary,
  intent,
  myScore,
  otherId,
  personaId,
  receipt,
  regionId,
  rejected,
  revision,
  summary,
  target,
  targetPage,
} from './ratings-helpers';

test('strict rating text uses Unicode code points, canonical CRLF/trim, and no silent truncation or Unicode normalization', () => {
  assert.equal(canonicalRatingText(' \r\n甲\r\n😀\t乙\r\n '), '甲\n😀\t乙');
  assert.equal(canonicalRatingText('😀'.repeat(500)), '😀'.repeat(500));
  assert.equal(canonicalRatingText('e\u0301'), 'e\u0301');
  assert.equal(canonicalRatingText(' '.repeat(10), 500, false), '');
  for (const value of [
    '',
    ' \t\r\n ',
    '😀'.repeat(501),
    'a\rb',
    'a\u0000b',
    'a\u007fb',
    'a\u0085b',
    '\ud800',
    '\udfff',
    5,
    null,
  ])
    assert.throws(() => canonicalRatingText(value));
});

test('strict score intents accept only integer 1 through 5, nullable first revision and explicit scope', () => {
  const command = intent();
  assert.equal(command.operation, 'set_score');
  if (command.operation !== 'set_score') return;
  for (const score of [1, 5])
    assert.equal(
      (
        decodeRatingIntent({
          ...command,
          payload: { ...command.payload, score, expectedRevision: null },
        }) as typeof command
      ).payload.score,
      score,
    );
  for (const score of [0, 6, -1, 1.5, NaN, Infinity, '5', null])
    assert.throws(() =>
      decodeRatingIntent({
        ...command,
        payload: { ...command.payload, score },
      }),
    );
  for (const patch of [
    { expectedRevision: '0' },
    { expectedTargetRevision: null },
    { regionId: 'global' },
    { score: 0, withdraw: true },
    { accountId: otherId },
  ])
    assert.throws(() =>
      decodeRatingIntent({
        ...command,
        payload: { ...command.payload, ...patch },
      }),
    );
  assert.throws(() =>
    decodeRatingIntent({ ...command, targetId: '../targets' }),
  );
  assert.throws(() =>
    decodeRatingIntent({ ...command, authorAccountId: otherId }),
  );
});

test('text publication is independent of score and rejects media, implicit body coercion and extra legacy fields', () => {
  const command = intent('create_comment');
  assert.equal(command.operation, 'create_comment');
  if (command.operation !== 'create_comment') return;
  const decoded = decodeRatingIntent({
    ...command,
    payload: { ...command.payload, body: ` \r\n${body}\r\n ` },
  });
  assert.equal(
    decoded.operation === 'create_comment' && decoded.payload.body,
    body,
  );
  for (const patch of [
    { body: '' },
    { body: 5 },
    { score: 5 },
    { imageUrls: ['https://example.test/private'] },
    { assetIds: [otherId] },
    { authorMode: 'hidden' },
  ])
    assert.throws(() =>
      decodeRatingIntent({
        ...command,
        payload: { ...command.payload, ...patch },
      }),
    );
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.payload));
});

test('anonymous comments enforce target-scoped persona and reject hidden real identity at every DTO object depth', () => {
  assert.deepEqual(decodeRatingComment(comment()), comment());
  for (const key of [
    'accountId',
    'user_id',
    'original_user_id',
    'profileId',
    'studentNumber',
    'recipientId',
    'schoolId',
    'identity',
  ])
    for (const value of [otherId, { accountId: otherId }]) {
      assert.throws(() => decodeRatingComment({ ...comment(), [key]: value }));
      assert.throws(() =>
        decodeRatingComment({
          ...comment(),
          author: { ...comment().author, [key]: value },
        }),
      );
      assert.throws(() =>
        decodeRatingComment({
          ...comment(),
          allowedActions: { delete: true, [key]: value },
        }),
      );
      assert.throws(() =>
        decodeRatingCommentPage({
          ...commentPage(),
          context: { ...commentPage().context, [key]: value },
        }),
      );
    }
  assert.throws(() => decodeRatingComment({ ...comment(), targetId: otherId }));
  const foreign = comment({
    id: otherId,
    targetId: otherId,
    author: {
      mode: 'anonymous',
      targetId: otherId,
      personaId: regionId,
      displayName: 'Other target persona',
    },
  });
  assert.equal(decodeRatingComment(foreign).author.mode, 'anonymous');
  assert.notEqual(
    foreign.author.mode === 'anonymous' && foreign.author.personaId,
    personaId,
  );
  assert.throws(() =>
    decodeRatingCommentPage({ ...commentPage(), items: [foreign] }),
  );
});

test('public named projection and server-owned deletion capability are exact', () => {
  const named = comment({
    author: {
      mode: 'named',
      profileId: otherId,
      displayName: 'Synthetic public name',
    },
  });
  assert.deepEqual(decodeRatingComment(named), named);
  assert.throws(() =>
    decodeRatingComment({
      ...named,
      author: { ...named.author, accountId: otherId },
    }),
  );
  assert.throws(() => decodeRatingComment({ ...comment(), isMine: false }));
  assert.deepEqual(
    decodeRatingComment(
      comment({ isMine: false, allowedActions: { delete: false } }),
    ).allowedActions,
    { delete: false },
  );
  for (const extra of [
    { likeCount: 0 },
    { images: [] },
    { replies: [] },
    { subscription: false },
  ])
    assert.throws(() => decodeRatingComment({ ...comment(), ...extra }));
});

test('no-score null, unavailable summary, and known empty summary are distinct without a zero score', () => {
  assert.deepEqual(decodeRatingMyScore({ myScore: null }), { myScore: null });
  assert.deepEqual(decodeRatingMyScore(myScore(1)), myScore(1));
  assert.deepEqual(decodeRatingSummary({ status: 'unavailable' }), {
    status: 'unavailable',
  });
  assert.deepEqual(decodeRatingSummary(emptySummary()), emptySummary());
  for (const value of [
    { myScore: 0 },
    { myScore: { score: 0, revision } },
    { myScore: null, count: 0 },
    { myScore: { score: 5, revision, accountId: otherId } },
  ])
    assert.throws(() => decodeRatingMyScore(value));
  for (const value of [
    { status: 'unavailable', count: 0 },
    { ...emptySummary(), average: 0 },
    { ...emptySummary(), average: 1 },
    { ...summary(), count: 2 },
    { ...summary(), sum: 4 },
    { ...summary(), average: null },
    { ...summary(), average: 3.01 },
    {
      ...summary(),
      distribution: { '1': 0, '2': 0, '3': 1, '4': 0, '5': 0, '0': 0 },
    },
  ])
    assert.throws(() => decodeRatingSummary(value));
  const rounded = {
    ...summary(),
    count: 3,
    sum: 10,
    average: 3.3,
    distribution: { '1': 0, '2': 0, '3': 2, '4': 1, '5': 0 },
  };
  assert.deepEqual(decodeRatingSummary(rounded), rounded);
});

test('catalog and target projection carry no creator identity or fabricated media and bind bounded pages', () => {
  assert.deepEqual(decodeRatingCategory(category()), category());
  assert.deepEqual(decodeRatingTarget(target()), target());
  assert.deepEqual(decodeRatingCategoryPage(categoryPage()), categoryPage());
  assert.deepEqual(decodeRatingTargetPage(targetPage()), targetPage());
  assert.deepEqual(decodeRatingContext({ homeRegion: null, regions: [] }), {
    homeRegion: null,
    regions: [],
  });
  for (const patch of [
    { level: 0 },
    { level: 4 },
    { parentId: categoryId },
    { name: ' noncanonical ' },
    { kind: 'unknown/route' },
    { revision: 'bad' },
    { accountId: otherId },
  ])
    assert.throws(() => decodeRatingCategory({ ...category(), ...patch }));
  for (const patch of [
    { creatorAccountId: otherId },
    { avatarUrl: 'https://example.test' },
    { allowedActions: { ...target().allowedActions, subscribe: true } },
    { allowedActions: { ...target().allowedActions, authorModes: [] } },
  ])
    assert.throws(() => decodeRatingTarget({ ...target(), ...patch }));
  for (const page of [
    categoryPage({ nextCursor: 'a'.repeat(43) }),
    categoryPage({ continuation: 'more' }),
    categoryPage({ items: Array.from({ length: 51 }, () => category()) }),
    categoryPage({ items: [category(), category()] }),
  ])
    assert.throws(() => decodeRatingCategoryPage(page));
  assert.equal(
    decodeRatingCommentPage(
      commentPage({
        items: [],
        nextCursor: 'a'.repeat(43),
        continuation: 'scan',
      }),
    ).continuation,
    'scan',
  );
});

test('all receipts are minimal immutable operation facts and cannot replay body, score, author or current capabilities', () => {
  for (const operation of [
    'set_score',
    'create_comment',
    'delete_comment',
  ] as const) {
    const command = intent(operation);
    for (const result of [
      receipt(command),
      rejected(command),
      ...(operation === 'create_comment' ? [] : [receipt(command, 'noop')]),
    ]) {
      assert.deepEqual(decodeRatingReceipt(result), result);
      assert.doesNotThrow(() => matchRatingReceipt(command, result));
      for (const extra of [
        { body },
        { score: 5 },
        { author: comment().author },
        { comment: comment() },
        { accountId: otherId },
        { allowedActions: target().allowedActions },
      ])
        assert.throws(() => decodeRatingReceipt({ ...result, ...extra }));
    }
    assert.throws(() =>
      matchRatingReceipt(command, { ...receipt(command), requestId: otherId }),
    );
    assert.throws(() =>
      matchRatingReceipt(command, { ...receipt(command), targetId: otherId }),
    );
    assert.throws(() =>
      matchRatingReceipt(command, {
        ...receipt(command),
        operation: operation === 'set_score' ? 'delete_comment' : 'set_score',
      }),
    );
  }
  assert.throws(() =>
    decodeRatingReceipt({ ...receipt(), subjectId: otherId }),
  );
  assert.throws(() =>
    matchRatingReceipt(intent('delete_comment'), {
      ...receipt(intent('delete_comment')),
      subjectId: otherId,
    }),
  );
  assert.throws(() =>
    decodeRatingReceipt({ ...rejected(), code: 'CONTENT_REVIEW_UNAVAILABLE' }),
  );
  assert.throws(() =>
    decodeRatingReceipt({
      ...receipt(),
      occurredAt: '2026-10-08T12:00:00.1234567Z',
    }),
  );
});

test('creation never noops and score noop must preserve an existing exact expected revision', () => {
  assert.throws(() =>
    decodeRatingReceipt(receipt(intent('create_comment'), 'noop')),
  );
  const command = intent();
  if (command.operation !== 'set_score') throw new Error('fixture');
  assert.doesNotThrow(() =>
    matchRatingReceipt(command, receipt(command, 'noop')),
  );
  assert.throws(() =>
    matchRatingReceipt(command, {
      ...receipt(command, 'noop'),
      revision: otherId,
    }),
  );
  assert.throws(() =>
    matchRatingReceipt(
      { ...command, payload: { ...command.payload, expectedRevision: null } },
      receipt(command, 'noop'),
    ),
  );
});

for (const authorModes of [['anonymous'], ['anonymous', 'named']] as const)
  test(`target rejects author mode contract without named-first: ${authorModes.join(',')}`, () => {
    assert.throws(
      () =>
        decodeRatingTarget({
          ...target(),
          allowedActions: { ...target().allowedActions, authorModes },
        }),
      { kind: 'protocol' },
    );
  });
