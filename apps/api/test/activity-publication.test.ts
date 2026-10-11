import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  activityPublicationContentSchema,
  requirePublishableContent,
  activityReviewEnvelopeSchema,
  activityReviewDigest,
  activityPublicationCommandSchema,
  publicationCommandHash,
} from '../src/activities/publication/contracts.js';
const content = {
  title: '活动',
  description: '',
  types: ['offline'],
  activityTime: '周末',
  activityLocation: '图书馆',
  endAt: null,
  showOrganizerQr: false,
};
test('activity field limits follow actual old WXML, preserve explicit types and never invent 2099', () => {
  assert.ok(
    activityPublicationContentSchema.safeParse({
      ...content,
      title: '字'.repeat(50),
      description: '字'.repeat(1000),
      activityTime: '字'.repeat(200),
      activityLocation: '字'.repeat(200),
    }).success,
  );
  for (const [key, n] of [
    ['title', 51],
    ['description', 1001],
    ['activityTime', 201],
    ['activityLocation', 201],
  ] as const)
    assert.equal(
      activityPublicationContentSchema.safeParse({
        ...content,
        [key]: '字'.repeat(n),
      }).success,
      false,
    );
  assert.equal(requirePublishableContent(content).endAt, null);
  assert.throws(() =>
    requirePublishableContent({ ...content, activityTime: '' }),
  );
  assert.throws(() =>
    requirePublishableContent({ ...content, activityLocation: '' }),
  );
  assert.throws(() => requirePublishableContent({ ...content, title: ' ' }));
  assert.throws(() => requirePublishableContent({ ...content, types: [] }));
  assert.deepEqual(
    requirePublishableContent({
      ...content,
      types: ['reward', 'online'],
      activityTime: '',
      activityLocation: '',
    }).types,
    ['reward', 'online'],
  );
  assert.throws(() =>
    activityPublicationContentSchema.parse({
      ...content,
      types: ['online', 'online'],
    }),
  );
  assert.throws(() =>
    activityPublicationContentSchema.parse({ ...content, title: 'x\u202ey' }),
  );
});
test('activity review is independently typed exact owner/organization/media and cannot consume a community post envelope', () => {
  const envelope = {
    version: 1,
    purpose: 'publish_activity',
    accountId: randomUUID(),
    activityId: randomUUID(),
    draftRevision: 2,
    organization: { source: 'managed', organizationId: randomUUID() },
    organizationRevision: 2,
    authorityVersion: `2:${randomUUID()}`,
    regionId: randomUUID(),
    organizerLabel: '组织',
    content,
    media: [
      { slot: 'cover', assetId: randomUUID(), manifestDigest: 'a'.repeat(64) },
    ],
    organizerQr: null,
  };
  const parsed = activityReviewEnvelopeSchema.parse(envelope),
    digest = activityReviewDigest(parsed);
  assert.notEqual(
    digest,
    activityReviewDigest({ ...parsed, organizationRevision: 3 }),
  );
  assert.notEqual(
    digest,
    activityReviewDigest({
      ...parsed,
      content: { ...parsed.content, title: '另一活动' },
    }),
  );
  assert.notEqual(
    digest,
    activityReviewDigest({
      ...parsed,
      media: [{ ...parsed.media[0]!, manifestDigest: 'b'.repeat(64) }],
    }),
  );
  assert.throws(() =>
    activityReviewEnvelopeSchema.parse({
      ...envelope,
      purpose: 'publish_post',
    }),
  );
  assert.throws(() =>
    activityReviewEnvelopeSchema.parse({
      ...envelope,
      media: [{ ...envelope.media[0], slot: 'avatar' }],
    }),
  );
  assert.throws(() =>
    activityReviewEnvelopeSchema.parse({
      ...envelope,
      content: { ...content, showOrganizerQr: true },
    }),
  );
});
test('publication original-key hash is account and draft isolated with strict immutable command', () => {
  const actor = randomUUID(),
    id = randomUUID(),
    command = {
      action: 'publish' as const,
      clientRequestId: randomUUID(),
      expectedRevision: 2,
    };
  const hash = publicationCommandHash(actor, id, command);
  assert.notEqual(hash, publicationCommandHash(randomUUID(), id, command));
  assert.notEqual(hash, publicationCommandHash(actor, randomUUID(), command));
  assert.notEqual(
    hash,
    publicationCommandHash(actor, id, { ...command, expectedRevision: 3 }),
  );
  assert.throws(() =>
    activityPublicationCommandSchema.parse({ ...command, force: true }),
  );
  assert.throws(() =>
    activityPublicationCommandSchema.parse({ ...command, action: 'delete' }),
  );
});
