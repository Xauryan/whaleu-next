import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { publishPostSchema } from '../src/community/contracts.js';
import {
  formationComponentSchema,
  joinFormationSchema,
} from '../src/community/formation/contracts.js';
import {
  formationJoinHash,
  formationJoinReason,
  safeFormationDisplayText,
} from '../src/community/formation/service.js';
import { postIntent } from '../src/community/publication-intent.js';
import { publicationHash } from '../src/community/publication.repository.js';
import { requireAction } from '../src/community/community-policy.js';
import { verified } from './support/community-fixtures.js';
const contacts = { wechat: 'chosen-wechat', qq: '', phone: '' };
const component = {
  kind: 'formation',
  capacity: 2,
  theme: '周末爬山',
  contacts,
  contactSharing: 'members_v1',
};
test('formation new writes require source bounds, exact types and explicit chosen-contact sharing', () => {
  assert.equal(formationComponentSchema.safeParse(component).success, true);
  for (const capacity of [1, 20])
    assert.equal(
      formationComponentSchema.safeParse({ ...component, capacity }).success,
      true,
    );
  assert.equal(
    formationComponentSchema.safeParse({ ...component, theme: '🐳'.repeat(12) })
      .success,
    true,
  );
  for (const extra of [
    { capacity: 0 },
    { capacity: 21 },
    { capacity: '2' },
    { capacity: 1.5 },
    { theme: '' },
    { theme: ' ' },
    { theme: '🐳'.repeat(13) },
    { theme: 'a\0' },
    { theme: '\ud800' },
    { contactSharing: undefined },
    { contactSharing: true },
    { contactSharing: 'public' },
    { contacts: { wechat: ' ', qq: '', phone: '' } },
    { contacts: { wechat: 'a'.repeat(101), qq: '', phone: '' } },
    { contacts: { wechat: '', qq: '界'.repeat(17), phone: '' } },
    { contacts: { wechat: '', qq: '', phone: '1'.repeat(21) } },
    { contacts: { wechat: 'a', qq: '', phone: '', accountId: randomUUID() } },
    { deadline: null },
    { creator: randomUUID() },
  ])
    assert.equal(
      formationComponentSchema.safeParse({ ...component, ...extra }).success,
      false,
      JSON.stringify(extra),
    );
  assert.deepEqual(
    formationComponentSchema.parse({
      ...component,
      theme: '  组局  ',
      contacts: { wechat: ' ' + '🐳'.repeat(25) + ' ', qq: '', phone: '' },
    }).contacts,
    { wechat: '🐳'.repeat(25), qq: '', phone: '' },
  );
});
test('formation is exclusive with polls, internal links and trading; full intent binds contacts and consent', () => {
  const body = publishPostSchema.parse({
    clientRequestId: randomUUID(),
    spaceId: randomUUID(),
    category: 'discussion',
    text: 'body',
    authorMode: 'anonymous',
  });
  const old = {
    spaceId: body.spaceId,
    category: body.category,
    text: body.text,
    imageAssetIds: [],
    authorMode: body.authorMode,
    commentsPolicy: 'open',
  };
  for (const absent of [undefined, { kind: 'none' } as const])
    assert.equal(
      publicationHash(
        'publish_post',
        postIntent({ ...body, component: absent }),
      ),
      publicationHash('publish_post', old),
    );
  const formed = publishPostSchema.parse({ ...body, component });
  for (const change of [
    { theme: 'other' },
    { capacity: 3 },
    { contacts: { ...contacts, phone: '123' } },
  ]) {
    const altered = publishPostSchema.parse({
      ...body,
      component: { ...component, ...change },
    });
    assert.notEqual(
      publicationHash('publish_post', postIntent(formed)),
      publicationHash('publish_post', postIntent(altered)),
    );
  }
  for (const change of [
    { text: ' ' },
    { component: { ...component, options: ['a', 'b'] } },
    { component: { ...component, link: {} } },
    {
      category: 'trading',
      authorMode: 'named',
      trading: { subtype: 'shuma', price: '1', location: 'here', contacts },
    },
  ])
    assert.equal(
      publishPostSchema.safeParse({ ...body, component, ...change }).success,
      false,
    );
});
test('join schema and deterministic intent exclude selectors, retain contacts, normalize UUID casing', () => {
  const post = randomUUID(),
    clientRequestId = randomUUID();
  const input = joinFormationSchema.parse({
    clientRequestId,
    contacts,
    contactSharing: 'members_v1',
  });
  assert.equal(
    formationJoinHash(post, input),
    formationJoinHash(post.toUpperCase(), input),
  );
  assert.notEqual(
    formationJoinHash(post, input),
    formationJoinHash(post, { ...input, contacts: { ...contacts, qq: '123' } }),
  );
  for (const change of [
    { accountId: post },
    { isCreator: true },
    { contactSharing: undefined },
    { contacts: { phone: '1' } },
  ])
    assert.equal(
      joinFormationSchema.safeParse({ ...input, ...change }).success,
      false,
    );
});
test('join/contacts actions need phone proof and their own restriction without student/campus gate', () => {
  const authority = {
    ...verified(randomUUID()),
    studentVerified: false,
    identityRegionId: null,
    restrictedActions: ['publish_post' as const],
  };
  requireAction(authority, 'join_formation');
  requireAction(authority, 'read_formation_contacts');
  assert.equal(formationJoinReason('actor', authority, false, 'open'), null);
  assert.equal(
    formationJoinReason(null, null, false, 'open'),
    'AUTHENTICATION_REQUIRED',
  );
  assert.equal(
    formationJoinReason('actor', null, false, 'open'),
    'COMMUNITY_UNAVAILABLE',
  );
  assert.equal(
    formationJoinReason(
      'actor',
      { ...authority, phoneVerified: false },
      false,
      'open',
    ),
    'PHONE_VERIFICATION_REQUIRED',
  );
  assert.equal(
    formationJoinReason(
      'actor',
      { ...authority, restrictedActions: ['join_formation'] },
      false,
      'open',
    ),
    'COMMUNITY_ACTION_RESTRICTED',
  );
  assert.equal(
    formationJoinReason('actor', authority, false, 'full'),
    'FORMATION_FULL',
  );
  assert.equal(
    formationJoinReason('actor', authority, true, 'full'),
    'FORMATION_ALREADY_JOINED',
  );
  assert.equal(
    formationJoinReason('actor', authority, false, 'unavailable'),
    'FORMATION_UNAVAILABLE',
  );
});
test('historical display preserves Unicode and raw spacing without new-write limits, bounded and fail-closed', () => {
  assert.equal(
    safeFormationDisplayText(' historical ' + '🐳'.repeat(100) + '\r\n'),
    true,
  );
  assert.equal(safeFormationDisplayText('x\0'), false);
  assert.equal(safeFormationDisplayText('\ud800'), false);
  assert.equal(safeFormationDisplayText('x'.repeat(1024 * 1024 + 1)), false);
});
