import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePost, decodePostIntent } from '../src/community/contract';
import {
  decodeBallotIntent,
  decodeBallotReceipt,
  decodeOwnBallot,
  decodePoll,
  decodePollComponent,
} from '../src/community/poll-contract';
import {
  ballotId,
  ballotReceipt,
  createdAt,
  intent,
  optionOne,
  optionThree,
  optionTwo,
  otherId,
  poll,
  pollPost,
  postId,
  requestId,
} from './community-helpers';
const component = () => ({
  kind: 'poll',
  question: '  合成问题🐳  ',
  selectionMode: 'single',
  options: ['甲', '乙', '吃瓜🍉'],
});
test('poll new writes enforce codepoints, exact component, required body, ordinary options and optional final slot', () => {
  assert.deepEqual(decodePollComponent(component()), component());
  assert.equal(
    decodePostIntent(intent({ component: decodePollComponent(component()) }))
      .component?.kind,
    'poll',
  );
  const long = {
    ...component(),
    question: '🐳'.repeat(255),
    options: ['🐳'.repeat(255), '乙'],
  };
  assert.deepEqual(decodePollComponent(long), long);
  for (const value of [
    { ...component(), question: '' },
    { ...component(), question: '  ' },
    { ...component(), question: '🐳'.repeat(256) },
    { ...component(), question: 'a\rb' },
    { ...component(), question: '\ud800' },
    { ...component(), options: ['甲'] },
    { ...component(), options: ['甲', '乙', '丙', '丁', '戊', '吃瓜🍉'] },
    { ...component(), options: ['甲', '吃瓜🍉'] },
    { ...component(), options: ['吃瓜🍉', '甲', '乙'] },
    { ...component(), options: ['甲', ' 甲 '] },
    { ...component(), options: ['甲', ' '] },
    { ...component(), options: ['甲', '🐳'.repeat(256)] },
    { ...component(), deadline: null },
    { ...component(), group: { capacity: 2 } },
    { ...component(), selectionMode: 1 },
    { kind: 'group' },
    { kind: 'none', question: 'hidden' },
  ])
    assert.throws(() => decodePollComponent(value));
  assert.throws(() =>
    decodePostIntent({ ...intent(), text: ' ', component: component() }),
  );
  assert.throws(() =>
    decodePostIntent({
      ...intent(),
      component: component(),
      link: { url: 'https://example.test' },
    }),
  );
  const old = decodePostIntent(intent());
  assert.equal(
    Object.prototype.hasOwnProperty.call(old, 'component'),
    false,
    'old frozen C1 intent must not be rewritten with a default',
  );
  assert.deepEqual(
    decodePostIntent(intent({ component: { kind: 'none' } })).component,
    { kind: 'none' },
  );
});
test('poll read preserves imported raw text and dates without reapplying write limits or labels policy', () => {
  const raw = poll({
    question: '长'.repeat(500) + '\r\n\t\u0085',
    options: poll().options.map((option) => ({
      ...option,
      label: option.position === 0 ? '原\r\n' + '🐳'.repeat(300) : '',
    })),
    deadline: '2020-01-01T00:00:00.000Z',
    expired: true,
    viewer: {
      hasVoted: false,
      selectedOptionIds: [],
      canVote: false,
      reason: 'POLL_EXPIRED',
    },
  });
  assert.deepEqual(decodePoll(raw), raw);
  assert.deepEqual(decodePost(pollPost(raw)).component, {
    kind: 'poll',
    poll: raw,
  });
  assert.throws(() => decodePoll({ ...raw, question: '\ud800' }));
  assert.throws(() =>
    decodePoll({ ...raw, deadline: '2026-02-31T00:00:00.000Z' }),
  );
});
test('poll counts distinguish two voters from five selections and exact own immutable choices', () => {
  const raw = poll({
    selectionMode: 'multiple',
    voterCount: 2,
    selectionCount: 5,
    options: poll().options.map((option) => ({
      ...option,
      count: option.position === 2 ? 1 : 2,
    })),
    viewer: {
      hasVoted: true,
      selectedOptionIds: [optionOne, optionTwo, optionThree],
      canVote: false,
      reason: 'POLL_ALREADY_VOTED',
    },
  });
  assert.deepEqual(decodePoll(raw), raw);
  for (const value of [
    { ...raw, selectionCount: 2 },
    { ...raw, voterCount: 1 },
    { ...raw, selectionMode: 'single' },
    {
      ...raw,
      options: raw.options.map((option) => ({ ...option, position: 1 })),
    },
    { ...raw, viewer: { ...raw.viewer, selectedOptionIds: [otherId] } },
    {
      ...raw,
      viewer: { ...raw.viewer, selectedOptionIds: [optionOne, optionOne] },
    },
    { ...raw, viewer: { ...raw.viewer, selectedOptionIds: [] } },
    { ...raw, viewer: { ...raw.viewer, canVote: true, reason: null } },
    { ...poll(), expired: true },
    {
      ...poll(),
      viewer: { ...poll().viewer, reason: 'COMMUNITY_UNAVAILABLE' },
    },
  ])
    assert.throws(() => decodePoll(value));
});
test('strict nested poll and receipt DTOs reject voter identity, extra data and nonterminal outcomes', () => {
  const raw = poll();
  for (const value of [
    { ...raw, voterIds: [otherId] },
    { ...raw, accountId: otherId },
    { ...raw, viewer: { ...raw.viewer, accountId: otherId } },
    {
      ...raw,
      options: [
        { ...raw.options[0], voters: [otherId] },
        ...raw.options.slice(1),
      ],
    },
    { ...raw, viewer: { ...raw.viewer, otherChoices: [optionOne] } },
  ])
    assert.throws(() => decodePoll(value));
  assert.throws(() =>
    decodePost({
      ...pollPost(),
      component: { kind: 'poll', poll: poll({ postId: otherId }) },
    }),
  );
  assert.deepEqual(decodeBallotReceipt(ballotReceipt()), ballotReceipt());
  for (const value of [
    { ...ballotReceipt(), accountId: otherId },
    { ...ballotReceipt(), operation: 'publish_post' },
    { ...ballotReceipt(), selectionCount: 1 },
    { ...ballotReceipt(), outcome: 'pending' },
    {
      requestId,
      operation: 'cast_poll_ballot',
      outcome: 'rejected',
      code: 'COMMUNITY_UNAVAILABLE',
    },
    {
      requestId,
      operation: 'cast_poll_ballot',
      outcome: 'rejected',
      code: 'SESSION_REVOKED',
    },
  ])
    assert.throws(() => decodeBallotReceipt(value));
  for (const code of [
    'POLL_EXPIRED',
    'POLL_ALREADY_VOTED',
    'PHONE_VERIFICATION_REQUIRED',
    'POLL_OPTIONS_INVALID',
  ])
    assert.equal(
      decodeBallotReceipt({
        requestId,
        operation: 'cast_poll_ballot',
        outcome: 'rejected',
        code,
      }).outcome,
      'rejected',
    );
  const own = { postId, ballotId, createdAt, selectedOptionIds: [optionOne] };
  assert.deepEqual(decodeOwnBallot(own), own);
  assert.throws(() => decodeOwnBallot({ ...own, question: 'hidden content' }));
  assert.throws(() => decodeOwnBallot({ ...own, accountId: otherId }));
});
test('ballot input canonicalizes a set, rejects coercions, duplicates, uppercase variants and actor selectors', () => {
  assert.deepEqual(
    decodeBallotIntent({
      clientRequestId: requestId,
      optionIds: [optionTwo, optionOne],
    }).optionIds,
    [optionOne, optionTwo],
  );
  for (const optionIds of [
    [],
    [optionOne, optionOne],
    [optionOne, optionOne.toUpperCase()],
    [1],
    ['1'],
    [optionOne.toUpperCase()],
  ])
    assert.throws(() =>
      decodeBallotIntent({ clientRequestId: requestId, optionIds }),
    );
  assert.throws(() =>
    decodeBallotIntent({
      clientRequestId: requestId,
      optionIds: [optionOne],
      accountId: otherId,
    }),
  );
});
