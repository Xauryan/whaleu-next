import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeDishCommand,
  decodeDishOwn,
  decodeDishPage,
  decodeDishReceipt,
  dishIdentity,
  dishName,
  matchDishReceipt,
} from '../src/dish-recommendations/contract';
import {
  cancelled,
  command,
  id,
  otherId,
  own,
  page,
  receipt,
  recommend,
  retract,
  scoreRevision,
} from './dish-recommendations-helpers';
test('exact 1..10 Unicode codepoints including emoji, 0, spaces and distinct normalization are preserved', () => {
  for (const name of [
    '0',
    ' A ',
    'A',
    'a',
    'é',
    'e\u0301',
    '😀'.repeat(10),
    '合成菜品',
  ]) {
    assert.equal(dishName(name), true);
    assert.equal(decodeDishCommand(command({ dishName: name })).dishName, name);
    assert.equal(dishIdentity(name), Buffer.from(name, 'utf8').toString('hex'));
  }
  assert.notEqual(dishIdentity('é'), dishIdentity('e\u0301'));
  for (const name of [
    '',
    '   ',
    '\n',
    'A\u0000',
    '\u007f',
    '\u009f',
    '\ud800',
    '\udc00',
    '😀'.repeat(11),
    'a'.repeat(11),
    null,
    0,
  ])
    assert.equal(dishName(name), false);
});
test('privacy-strict list and own contracts distinguish unknown history, never recommended, active and inactive', () => {
  for (const value of [
    { kind: 'unavailable' },
    { kind: 'not_recommended' },
    own(true),
    own(false),
  ])
    assert.deepEqual(decodeDishOwn(value), value);
  const item = {
    dishName: '菜',
    dishIdentity: dishIdentity('菜'),
    recommendationCount: 2,
    isRecommended: true,
    myMembershipRevision: scoreRevision,
  };
  assert.deepEqual(decodeDishPage(page({ items: [item] })).items, [item]);
  for (const value of [
    page({ items: [item, item] }),
    page({ items: [{ ...item, dishIdentity: '00' }] }),
    page({ items: [{ ...item, recommendationCount: 0 }] }),
    page({ items: [{ ...item, recommendationCount: 1001 }] }),
    page({ items: [{ ...item, myMembershipRevision: null }] }),
    { ...page(), actorIds: [id] },
    page({ nextCursor: 'next' }),
    page({ membershipRevision: '0' }),
  ])
    assert.throws(() => decodeDishPage(value));
  assert.throws(() => decodeDishOwn({ ...own(), accountId: id }));
});
test('dish receipt cannot echo denied text, cross operations/keys/names or reuse membership revision', () => {
  for (const operation of [recommend, retract])
    for (const result of [
      receipt(command(), operation),
      cancelled(command(), operation),
    ])
      matchDishReceipt(id, operation, command(), decodeDishReceipt(result));
  for (const result of [
    receipt(command(), retract),
    receipt(command({ dishName: '其他' })),
    receipt(command({ clientRequestId: otherId })),
    receipt(command(), recommend, otherId),
  ])
    assert.throws(() =>
      matchDishReceipt(id, recommend, command(), decodeDishReceipt(result)),
    );
  assert.throws(() =>
    decodeDishReceipt({ ...cancelled(), dishName: 'rejected text' }),
  );
  assert.throws(() =>
    decodeDishReceipt({ ...receipt(), operation: 'window.score.set.v1' }),
  );
  assert.throws(() => decodeDishReceipt({ ...receipt(), active: false }));
  assert.throws(() =>
    matchDishReceipt(
      id,
      recommend,
      command({ expectedMembershipRevision: scoreRevision }),
      receipt(),
    ),
  );
});
