import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeFormation,
  decodeFormationComponent,
  decodeFormationContactView,
  decodeFormationJoinIntent,
  decodeFormationReceipt,
  decodeOwnFormationMembership,
} from '../src/community/formation-contract';
import { decodePost, decodePostIntent } from '../src/community/contract';
import {
  formation,
  formationPost,
  formationReceipt,
  requestId,
  postId,
  otherId,
  createdAt,
  intent,
} from './community-helpers';
const contacts = { wechat: 'synthetic', qq: '', phone: '' };
const component = {
  kind: 'formation',
  capacity: 2,
  theme: '组队',
  contacts,
  contactSharing: 'members_v1',
};
test('formation component strict union rejects capacity/coercions/extra component fields, Unicode and consent errors', () => {
  assert.equal(
    decodeFormationComponent({ ...component, capacity: 1 }).capacity,
    1,
  );
  assert.equal(
    decodeFormationComponent({ ...component, capacity: 20 }).capacity,
    20,
  );
  for (const capacity of [0, 21, 1.5, '2', null, NaN])
    assert.throws(() => decodeFormationComponent({ ...component, capacity }));
  for (const bad of [
    { ...component, theme: '鲸'.repeat(13) },
    { ...component, theme: '\ud800' },
    { ...component, theme: ' ' },
    { ...component, contactSharing: false },
    { ...component, contactSharing: 'public' },
    { ...component, options: ['a', 'b'] },
    { ...component, contacts: { ...contacts, accountId: otherId } },
    { ...component, contacts: { wechat: '', qq: '', phone: '' } },
  ])
    assert.throws(() => decodeFormationComponent(bad));
  assert.deepEqual(
    decodeFormationComponent({
      ...component,
      theme: '  组队  ',
      contacts: { ...contacts, wechat: '  synthetic  ' },
    }),
    component,
  );
  assert.throws(() =>
    decodePostIntent(
      intent({ category: 'trading', component: component as never }),
    ),
  );
  assert.throws(() =>
    decodePostIntent({
      ...intent(),
      component: { ...component, kind: 'link' },
    }),
  );
});
test('public formation rejects raw actor/contact leaks recursively, creator persona changes and anonymous joiners', () => {
  const value = formation(),
    creator = value.members[0]!;
  for (const bad of [
    { ...value, contacts },
    { ...value, accountId: otherId },
    { ...value, members: [{ ...creator, contacts }] },
    {
      ...value,
      members: [
        { ...creator, author: { ...creator.author, accountId: otherId } },
      ],
    },
    { ...value, members: [{ ...creator, isCreator: false }] },
    { ...value, viewer: { ...value.viewer, accountId: otherId } },
  ])
    assert.throws(() => decodeFormation(bad));
  assert.throws(() =>
    decodePost({
      ...formationPost(),
      component: {
        kind: 'formation',
        formation: {
          ...value,
          members: [
            {
              ...creator,
              author: {
                kind: 'named',
                profileId: otherId,
                displayName: 'leak',
                avatar: null,
              },
            },
          ],
        },
      },
    }),
  );
  assert.equal(decodePost(formationPost()).author.kind, 'anonymous');
});
test('capacity-one is full and disabled, filtered roster count is retained, duplicate/out-of-order/self contradictions fail', () => {
  assert.equal(
    decodeFormation(
      formation({
        capacity: 1,
        status: 'full',
        viewer: {
          isMember: false,
          isCreator: false,
          canJoin: false,
          reason: 'FORMATION_FULL',
          canReadContacts: false,
        },
      }),
    ).status,
    'full',
  );
  assert.throws(() =>
    decodeFormation(formation({ capacity: 1, status: 'open' })),
  );
  assert.equal(decodeFormation(formation({ members: [] })).memberCount, 1);
  for (const bad of [
    formation({ memberCount: 0 }),
    formation({ memberCount: 3 }),
    formation({
      members: [formation().members[0]!, formation().members[0]!],
      memberCount: 2,
      status: 'full',
    }),
    formation({
      viewer: {
        isMember: false,
        isCreator: false,
        canJoin: true,
        reason: null,
        canReadContacts: true,
      },
    }),
  ])
    assert.throws(() => decodeFormation(bad));
});
test('member contact read preserves historical approved values verbatim, strict empty filtered projection and safe Unicode envelope', () => {
  const old = ' \t历史\r\n' + '鲸'.repeat(101);
  const value = {
    postId,
    members: [
      { membershipId: otherId, contacts: { wechat: old, qq: '', phone: '' } },
    ],
  };
  assert.equal(
    decodeFormationContactView(value).members[0]!.contacts.wechat,
    old,
  );
  assert.deepEqual(
    decodeFormationContactView({ postId, members: [] }).members,
    [],
  );
  assert.throws(() =>
    decodeFormationContactView({ ...value, accountId: otherId }),
  );
  assert.throws(() =>
    decodeFormationContactView({
      postId,
      members: [
        {
          ...value.members[0],
          contacts: { wechat: '\ud800', qq: '', phone: '' },
        },
      ],
    }),
  );
  assert.equal(
    decodeFormation(formation({ theme: '历史'.repeat(100) })).theme,
    '历史'.repeat(100),
  );
});
test('minimal receipts and own recovery never admit content, contacts, identity or forged terminal meanings', () => {
  const receipt = formationReceipt();
  assert.deepEqual(decodeFormationReceipt(receipt), receipt);
  for (const extra of [
    'contacts',
    'members',
    'accountId',
    'profileId',
    'theme',
  ])
    assert.throws(() =>
      decodeFormationReceipt({ ...receipt, [extra]: contacts }),
    );
  assert.throws(() =>
    decodeFormationReceipt({ ...receipt, operation: 'cast_poll_ballot' }),
  );
  assert.throws(() =>
    decodeFormationReceipt({
      requestId,
      operation: 'join_formation',
      outcome: 'rejected',
      code: 'REQUEST_NOT_FOUND',
    }),
  );
  const own = {
    postId,
    membershipId: otherId,
    joinedAt: createdAt,
    isCreator: false,
  };
  assert.deepEqual(decodeOwnFormationMembership(own), own);
  assert.throws(() => decodeOwnFormationMembership({ ...own, contacts }));
  assert.throws(() =>
    decodeFormationJoinIntent({
      clientRequestId: requestId,
      contacts,
      contactSharing: 'members_v1',
      profileId: otherId,
    }),
  );
});
