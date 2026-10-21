import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  publishPostSchema,
  publishCommentSchema,
} from '../src/community/contracts.js';
import { postIntent } from '../src/community/publication-intent.js';
import {
  canonicalEnvelope,
  approvalDigest,
  canonicalJson,
} from '../src/community/content-review/contracts.js';
import type { Authority } from '../src/community/community-policy.js';
import type { CommunitySpace } from '../src/community/contracts.js';
import type { EffectiveContentEnvelopeV1 } from '../src/community/content-review/contracts.js';
import {
  reconstructDefinition,
  definitionMatchesApproval,
} from '../src/community/content-review/definition-validation.js';
import { prepareTextSource } from '../src/community/text-source/source.js';
import {
  appendTextSource,
  reviewedTextSource,
  textSourceReadSchema,
  textSourceIntentHash,
  sourceTextAvailable,
  textSourceCapabilitySchema,
} from '../src/community/text-source/protocol.js';
import {
  withReviewedTextSource,
  sourcePublicationOperations,
} from '../src/community/text-source/publication.js';
import {
  reconstructTextSource,
  storedTextSourceSchema,
} from '../src/community/text-source/repository.js';

const ids = Array.from(
  { length: 6 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
);
const [accountId, spaceId, regionId, postId, requestId, decisionId] = ids as [
  string,
  string,
  string,
  string,
  string,
  string,
];
const plain = {
  version: 1,
  format: 'plain',
  readingFormatting: 'auto',
} as const;
const markdown = { version: 1, format: 'markdown' } as const;
const base = {
  clientRequestId: requestId,
  spaceId,
  category: 'discussion',
  text: 'First\r\n第二段 🐳',
  imageAssetIds: [],
  authorMode: 'named',
  commentsPolicy: 'open',
};
const legacy = (): EffectiveContentEnvelopeV1 => ({
  version: 1,
  accountId,
  purpose: 'publish_post',
  spaceId,
  category: 'discussion',
  authorMode: 'named',
  commentsPolicy: 'open',
  postId: null,
  rootCommentId: null,
  targetReplyId: null,
  text: 'First\n第二段 🐳',
  images: [],
  component: { kind: 'none' },
  trading: null,
  scope: {
    originalSpaceId: spaceId,
    originalRegionId: regionId,
    authorOriginRegionId: regionId,
    identityRegionId: regionId,
    topologySnapshotId: null,
    sync: 'none',
  },
});
const v6 = () =>
  canonicalEnvelope({ ...withReviewedTextSource(legacy(), plain), images: [] });
const sourceRow = () => ({
  content_kind: 'post' as const,
  content_id: postId,
  source_revision: 1 as const,
  source_version: 1 as const,
  source_format: 'plain' as const,
  reading_formatting: 'auto' as const,
  source_hash: prepareTextSource(legacy().text, plain, 'post')!.sourceHash,
  account_id: accountId,
  client_request_id: requestId,
  requested_author_mode: 'named' as const,
  original_intent_hash: textSourceIntentHash(
    'publish_post',
    postIntent(publishPostSchema.parse({ ...base, textSource: plain })),
  ),
  decision_id: decisionId,
  approval_digest: approvalDigest(v6()),
});

test('absent source keeps exact legacy post intent shape/order and canonical V1/V2 preimages', () => {
  const parsed = publishPostSchema.parse(base);
  assert.equal(Object.hasOwn(parsed, 'textSource'), false);
  assert.equal(
    JSON.stringify(postIntent(parsed)),
    JSON.stringify({
      spaceId,
      category: 'discussion',
      text: legacy().text,
      imageAssetIds: [],
      authorMode: 'named',
      commentsPolicy: 'open',
    }),
  );
  for (const input of [
    legacy(),
    { ...legacy(), version: 2, allowAnonymousDm: false },
  ]) {
    const envelope = canonicalEnvelope(input);
    assert.equal(Object.hasOwn(envelope, 'textSource'), false);
    assert.equal(
      approvalDigest(envelope),
      createHash('sha256')
        .update(
          `whaleu-content-approval:v${envelope.version}\n${canonicalJson(envelope)}`,
        )
        .digest('hex'),
    );
  }
  assert.deepEqual(
    postIntent(
      publishPostSchema.parse({ ...base, component: { kind: 'none' } }),
    ),
    postIntent(parsed),
  );
  assert.notDeepEqual(
    postIntent(publishPostSchema.parse({ ...base, allowAnonymousDm: false })),
    postIntent(parsed),
  );
});
test('source is explicit, canonical CRLF-only, appended last and separately hashed', () => {
  const absent = postIntent(publishPostSchema.parse(base));
  const auto = postIntent(
    publishPostSchema.parse({ ...base, textSource: plain }),
  );
  assert.deepEqual(Object.keys(auto), [...Object.keys(absent), 'textSource']);
  assert.equal(auto.text, legacy().text);
  assert.notEqual(
    textSourceIntentHash('publish_post', auto),
    createHash('sha256')
      .update(JSON.stringify({ operation: 'publish_post', intent: auto }))
      .digest('hex'),
  );
  const off = appendTextSource(absent, { ...plain, readingFormatting: 'off' });
  assert.notEqual(
    textSourceIntentHash('publish_post', auto),
    textSourceIntentHash('publish_post', off),
  );
  assert.notEqual(
    textSourceIntentHash('publish_post', auto),
    textSourceIntentHash('publish_post', appendTextSource(absent, markdown)),
  );
  assert.throws(() => textSourceIntentHash('publish_post', absent));
});
test('source DTO rejects unknown descriptors and unsupported ordinary combinations without downgrading', () => {
  for (const textSource of [
    null,
    {},
    { ...plain, sourceHash: 'a'.repeat(64) },
    { ...markdown, readingFormatting: 'auto' },
    { ...plain, version: 2 },
  ])
    assert.equal(
      publishPostSchema.safeParse({ ...base, textSource }).success,
      false,
    );
  for (const delta of [
    { allowAnonymousDm: true },
    { commentsPolicy: 'restricted' },
    { syncToRelatedCampuses: true },
    { category: 'feedback' },
    { category: 'trading' },
    {
      component: {
        kind: 'poll',
        question: 'q',
        selectionMode: 'single',
        options: ['one', 'two'],
      },
    },
  ])
    assert.equal(
      publishPostSchema.safeParse({ ...base, ...delta, textSource: plain })
        .success,
      false,
    );
  assert.ok(
    publishPostSchema.safeParse({
      ...base,
      allowAnonymousDm: false,
      textSource: plain,
    }).success,
  );
  assert.ok(
    publishCommentSchema.safeParse({
      clientRequestId: requestId,
      text: 'reply',
      authorMode: 'anonymous',
      textSource: markdown,
    }).success,
  );
});
test('v6 evidence binds mode/hash/policy and null versus false named DM exactly', () => {
  const source = v6();
  assert.equal(source.version, 6);
  const falseDm = canonicalEnvelope({
    ...withReviewedTextSource(
      {
        ...legacy(),
        version: 2,
        purpose: 'publish_post',
        authorMode: 'named',
        allowAnonymousDm: false,
      },
      plain,
    ),
    images: [],
  });
  assert.notEqual(approvalDigest(source), approvalDigest(falseDm));
  for (const mutation of [
    { text: 'changed' },
    { textSource: { ...plain, sourceHash: '0'.repeat(64) } },
    { allowAnonymousDm: true },
    { category: 'feedback' },
    { commentsPolicy: 'restricted' },
  ])
    assert.throws(() => canonicalEnvelope({ ...source, ...mutation }));
  assert.throws(() =>
    canonicalEnvelope({
      ...source,
      authorMode: 'anonymous',
      allowAnonymousDm: false,
    }),
  );
  assert.throws(() =>
    canonicalEnvelope({
      ...source,
      purpose: 'publish_comment',
      postId,
      allowAnonymousDm: false,
    }),
  );
  const off = canonicalEnvelope({
    ...source,
    textSource: reviewedTextSource(
      source.text,
      { ...plain, readingFormatting: 'off' },
      'post',
    ),
  });
  assert.notEqual(approvalDigest(source), approvalDigest(off));
});
test('stored source reconstructs independently; mode/hash/actor/id/policy tampering fails closed', () => {
  const row = sourceRow();
  assert.ok(
    reconstructTextSource(row, 'post', postId, accountId, legacy().text),
  );
  for (const delta of [
    { source_hash: 'a'.repeat(64) },
    { source_format: 'markdown' },
    { reading_formatting: null },
    { source_revision: 2 },
    { account_id: regionId },
    { content_id: regionId },
  ])
    assert.equal(
      reconstructTextSource(
        { ...row, ...delta } as typeof row,
        'post',
        postId,
        accountId,
        legacy().text,
      ),
      null,
    );
  assert.equal(
    storedTextSourceSchema.safeParse({ ...row, extra: 1 }).success,
    false,
  );
});
test('canonical definition cannot reinterpret a missing source row as legacy plain', () => {
  const envelope = v6();
  const post = {
    id: postId,
    space_id: spaceId,
    account_id: accountId,
    category: 'discussion' as const,
    text: legacy().text,
    author_mode: 'named' as const,
    comments_policy: 'open' as const,
    publication_envelope_version: 6 as const,
    allow_anonymous_dm: null,
    visibility: 'approved' as const,
    deleted_at: null,
    published_at: new Date(0),
    publication_state: 'published',
  };
  const facts = { images: [], options: [], creators: [] };
  assert.equal(
    reconstructDefinition('post', post, post, null, envelope.scope, [], facts)
      .kind,
    'unavailable',
  );
  for (const delta of [
    { original_intent_hash: '0'.repeat(64) },
    { requested_author_mode: 'anonymous' as const },
  ])
    assert.equal(
      reconstructDefinition('post', post, post, null, envelope.scope, [], {
        ...facts,
        textSource: { ...sourceRow(), ...delta },
      }).kind,
      'unavailable',
    );
  const stored = reconstructDefinition(
    'post',
    post,
    post,
    null,
    envelope.scope,
    [],
    { ...facts, textSource: sourceRow() },
  );
  assert.equal(stored.kind, 'allow');
  if (stored.kind !== 'allow') return;
  const approval = { decisionId, digest: approvalDigest(envelope), envelope };
  assert.ok(definitionMatchesApproval(stored.value, approval));
  assert.equal(
    definitionMatchesApproval(stored.value, {
      ...approval,
      decisionId: regionId,
    }),
    false,
  );
});
test('separate read decoder preserves exact legacy union and validates reviewed hash/eligibility', () => {
  const identity = {
    version: 1,
    kind: 'post',
    id: postId,
    postId,
    rootCommentId: null,
    text: 'legacy **literal**',
  };
  assert.deepEqual(
    textSourceReadSchema.parse({ ...identity, classification: 'legacyPlain' }),
    { ...identity, classification: 'legacyPlain' },
  );
  assert.equal(
    textSourceReadSchema.safeParse({
      ...identity,
      classification: 'legacyPlain',
      sourceRevision: 1,
    }).success,
    false,
  );
  const reviewed = {
    ...identity,
    text: '🐳'.repeat(300),
    classification: 'reviewedSource',
    sourceRevision: 1,
    textSource: reviewedTextSource('🐳'.repeat(300), plain, 'post'),
    readingFormattingEligible: true,
    presentationStatus: 'not_configured',
  };
  assert.ok(textSourceReadSchema.safeParse(reviewed).success);
  for (const delta of [
    { text: 'changed' },
    { readingFormattingEligible: false },
    { presentationStatus: 'ready' },
    { html: '<b>x</b>' },
  ])
    assert.equal(
      textSourceReadSchema.safeParse({ ...reviewed, ...delta }).success,
      false,
    );
});

test('temporary Markdown reference/media limits use entire raw source and do not change plain', () => {
  for (const text of [
    '#1234567',
    '`#1234567`',
    '```\n#1234567\n```',
    '[label](https://example.test/#1234567)',
    '![#1234567](https://example.test/x)',
    '\\#1234567',
    '#1',
    '#1234567890',
    'whaleu-asset:x',
  ]) {
    assert.equal(sourceTextAvailable(text, markdown), false);
    assert.throws(() =>
      withReviewedTextSource({ ...legacy(), text }, markdown),
    );
    const hash = prepareTextSource(text, markdown, 'post')!.sourceHash;
    assert.throws(() =>
      canonicalEnvelope({
        ...v6(),
        text,
        textSource: { ...markdown, sourceHash: hash },
      }),
    );
    assert.ok(sourceTextAvailable(text, plain));
    assert.doesNotThrow(() =>
      canonicalEnvelope({
        ...withReviewedTextSource({ ...legacy(), text }, plain),
        images: [],
      }),
    );
  }
  for (const text of ['# Heading', 'literal #number', '#１２３４５６７'])
    assert.ok(sourceTextAvailable(text, markdown));
  assert.throws(() =>
    canonicalEnvelope({
      ...v6(),
      images: [{ assetId: postId, digest: 'a'.repeat(64) }],
    }),
  );
});
test('separate capability cannot contradict limits or invent admitted operations', () => {
  const unavailable = {
    version: 1,
    authorMode: 'named',
    availability: 'unavailable',
    operations: [],
    formats: [],
    readingFormatting: [],
    media: 'unavailable',
    markdownReferences: 'unavailable',
    formatter: 'not_configured',
  };
  assert.ok(textSourceCapabilitySchema.safeParse(unavailable).success);
  for (const authorMode of [undefined, 'all', null])
    assert.equal(
      textSourceCapabilitySchema.safeParse({ ...unavailable, authorMode })
        .success,
      false,
    );
  assert.ok(
    textSourceCapabilitySchema.safeParse({
      ...unavailable,
      authorMode: 'anonymous',
    }).success,
  );
  assert.equal(
    textSourceCapabilitySchema.safeParse({
      ...unavailable,
      availability: 'available',
    }).success,
    false,
  );
  assert.equal(
    textSourceCapabilitySchema.safeParse({
      ...unavailable,
      formats: ['markdown'],
    }).success,
    false,
  );
  const available = {
    ...unavailable,
    availability: 'available',
    operations: ['publish_post'],
    formats: ['plain', 'markdown'],
    readingFormatting: ['auto', 'off'],
  };
  assert.ok(textSourceCapabilitySchema.safeParse(available).success);
  for (const delta of [
    { operations: ['publish_post', 'publish_post'] },
    { markdownReferences: 'available' },
    { media: 'available' },
    { formatter: 'ready' },
  ])
    assert.equal(
      textSourceCapabilitySchema.safeParse({ ...available, ...delta }).success,
      false,
    );
});
test('prior V1–V5 canonical fixtures preserve byte-for-byte envelopes and digests', () => {
  const fixtures = JSON.parse(
    readFileSync(
      new URL('./fixtures/text-source-legacy-goldens.json', import.meta.url),
      'utf8',
    ),
  ) as { envelope: unknown; canonical: string; digest: string }[];
  assert.equal(fixtures.length, 5);
  for (const fixture of fixtures) {
    const envelope = canonicalEnvelope(fixture.envelope);
    assert.equal(canonicalJson(envelope), fixture.canonical);
    assert.equal(approvalDigest(envelope), fixture.digest);
    assert.equal(Object.hasOwn(envelope, 'textSource'), false);
  }
});

test('source operation advisory respects requested identity and maps replies to existing comment action', () => {
  const space: CommunitySpace = {
    id: spaceId,
    name: 'Scope',
    kind: 'regional',
    operatingRegionId: regionId,
    isActive: true,
  };
  const authority: Authority = {
    phoneVerified: true,
    studentVerified: true,
    identityRegionId: regionId,
    crossRegionAllowed: true,
    unverifiedCommentsAllowed: true,
    unverifiedCategories: ['discussion'],
    restrictedActions: [],
    canManage: false,
  };
  assert.deepEqual(
    sourcePublicationOperations(authority, space, 'discussion', 'named'),
    ['publish_post', 'publish_comment', 'publish_reply'],
  );
  assert.deepEqual(
    sourcePublicationOperations(authority, space, 'discussion', 'anonymous'),
    ['publish_post', 'publish_comment', 'publish_reply'],
  );
  const foreign: Authority = {
    ...authority,
    runtime: true,
    scopeRelation: 'foreign',
  };
  assert.deepEqual(
    sourcePublicationOperations(foreign, space, 'discussion', 'named'),
    ['publish_post', 'publish_comment', 'publish_reply'],
  );
  assert.deepEqual(
    sourcePublicationOperations(foreign, space, 'discussion', 'anonymous'),
    ['publish_comment', 'publish_reply'],
  );
  const unverified: Authority = {
    ...authority,
    studentVerified: false,
    identityRegionId: null,
  };
  assert.deepEqual(
    sourcePublicationOperations(unverified, space, 'discussion', 'named'),
    ['publish_post', 'publish_comment', 'publish_reply'],
  );
  assert.deepEqual(
    sourcePublicationOperations(unverified, space, 'discussion', 'anonymous'),
    [],
  );
  assert.deepEqual(
    sourcePublicationOperations(
      { ...authority, restrictedActions: ['publish_comment'] },
      space,
      'discussion',
      'named',
    ),
    ['publish_post'],
  );
});
