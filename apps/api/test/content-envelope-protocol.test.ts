import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  approvalDigest,
  canonicalEnvelope,
  canonicalJson,
} from '../src/community/content-review/contracts.js';
import type {
  ContentEnvelopeProtocolAgreement,
  EffectiveContentEnvelope,
  EffectiveContentEnvelopeV1,
  EffectiveContentEnvelopeV2,
  EffectiveContentEnvelopeV3,
  EffectiveContentEnvelopeV4,
  EffectiveContentEnvelopeV5,
  EffectiveContentEnvelopeV6,
} from '../src/community/content-review/contracts.js';
import type { ReviewedRatingTargetLink } from '../src/community/rating-target-link/contracts.js';
import { reviewedTextSource } from '../src/community/text-source/protocol.js';
import type { ReviewedTextSource } from '../src/community/text-source/protocol.js';

// These compile-time checks are exercised by the normal strict API type gate.
// Pure execution alone must not be reported as a semantic typecheck.
type RequireAgreement<T extends true> = T;
type Same<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
export type EnvelopeVersionRegressionAgreement = [
  RequireAgreement<ContentEnvelopeProtocolAgreement>,
  RequireAgreement<
    Same<EffectiveContentEnvelope['version'], 1 | 2 | 3 | 4 | 5 | 6>
  >,
  RequireAgreement<
    Same<
      Extract<EffectiveContentEnvelope, { version: 1 }>,
      EffectiveContentEnvelopeV1
    >
  >,
  RequireAgreement<
    Same<
      Extract<EffectiveContentEnvelope, { version: 2 }>,
      EffectiveContentEnvelopeV2
    >
  >,
  RequireAgreement<
    Same<
      Extract<EffectiveContentEnvelope, { version: 3 }>,
      EffectiveContentEnvelopeV3
    >
  >,
  RequireAgreement<
    Same<
      Extract<EffectiveContentEnvelope, { version: 4 }>,
      EffectiveContentEnvelopeV4
    >
  >,
  RequireAgreement<
    Same<
      Extract<EffectiveContentEnvelope, { version: 5 }>,
      EffectiveContentEnvelopeV5
    >
  >,
  RequireAgreement<
    Same<
      Extract<EffectiveContentEnvelope, { version: 6 }>,
      EffectiveContentEnvelopeV6
    >
  >,
  RequireAgreement<Same<EffectiveContentEnvelopeV5['images'], []>>,
  RequireAgreement<Same<EffectiveContentEnvelopeV6['images'], []>>,
  RequireAgreement<
    Same<EffectiveContentEnvelopeV5['component'], ReviewedRatingTargetLink>
  >,
  RequireAgreement<
    Same<EffectiveContentEnvelopeV6['component'], { kind: 'none' }>
  >,
  RequireAgreement<
    Same<EffectiveContentEnvelopeV6['textSource'], ReviewedTextSource>
  >,
  RequireAgreement<
    Same<EffectiveContentEnvelopeV6['allowAnonymousDm'], false | null>
  >,
  RequireAgreement<
    Same<
      Extract<
        'textSource' | 'allowAnonymousDm',
        keyof EffectiveContentEnvelopeV5
      >,
      never
    >
  >,
  RequireAgreement<
    Same<
      EffectiveContentEnvelopeV1['images'],
      { assetId: string; digest: string }[]
    >
  >,
];

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const base: EffectiveContentEnvelopeV1 = {
  version: 1,
  accountId: id(1),
  purpose: 'publish_post',
  spaceId: id(2),
  category: 'discussion',
  authorMode: 'named',
  commentsPolicy: 'open',
  postId: null,
  rootCommentId: null,
  targetReplyId: null,
  text: 'Protocol exact source\n第二段 🐳',
  images: [],
  component: { kind: 'none' },
  trading: null,
  scope: {
    originalSpaceId: id(2),
    originalRegionId: id(3),
    authorOriginRegionId: id(3),
    identityRegionId: id(3),
    topologySnapshotId: null,
    sync: 'none',
  },
};
const rating: ReviewedRatingTargetLink = {
  kind: 'rating_target_link',
  targetId: id(4),
  label: '课程',
  binding: {
    version: 1,
    targetId: id(4),
    categoryId: id(5),
    targetRevision: id(6),
    definitionRevision: id(7),
    contentVersion: 1,
    originSourceId: id(8),
    sourceId: id(9),
    sourceRevision: id(10),
    placementRevision: id(11),
    categoryRevision: id(12),
    catalogId: id(13),
    headRevision: id(14),
    protocolGeneration: id(15),
    sourceDigest: 'a'.repeat(64),
    selector: { kind: 'global' },
    originRegionId: null,
    systemKey: 'course',
    ancestry: [{ categoryId: id(5), revision: id(12) }],
  },
};
const legacyInputs: [
  EffectiveContentEnvelopeV1,
  EffectiveContentEnvelopeV2,
  EffectiveContentEnvelopeV3,
  EffectiveContentEnvelopeV4,
  EffectiveContentEnvelopeV5,
] = [
  {
    ...base,
    text: base.text.replace('\n', '\r\n'),
    images: [{ assetId: id(16), digest: 'b'.repeat(64) }],
  },
  {
    ...base,
    version: 2,
    purpose: 'publish_post',
    authorMode: 'named',
    allowAnonymousDm: false,
  },
  {
    ...base,
    version: 3,
    purpose: 'publish_post',
    category: 'feedback',
    commentsPolicy: 'open',
    feedback: { contacts: { wechat: '', qq: '', phone: '' } },
    scope: { ...base.scope, originalRegionId: null },
  },
  {
    ...base,
    version: 4,
    allowAnonymousDm: false,
    scope: {
      originalSpaceId: id(2),
      originalRegionId: id(3),
      authorOriginRegionId: id(3),
      identityRegionId: id(3),
      topologySnapshotId: id(17),
      configurationRevisionId: id(18),
      identityCampusId: id(19),
      identitySelectionId: id(20),
      affiliationSnapshotId: id(21),
      affiliationAssertionId: id(22),
      sync: 'related',
      syncPolicyId: id(23),
      publicationGroupId: id(24),
      publicationMembersDigest: 'c'.repeat(64),
    },
  },
  {
    ...base,
    version: 5,
    purpose: 'publish_post',
    category: 'discussion',
    images: [],
    trading: null,
    component: rating,
  },
];
const sourceInputs = (
  [
    { version: 1, format: 'plain', readingFormatting: 'auto' },
    { version: 1, format: 'plain', readingFormatting: 'off' },
    { version: 1, format: 'markdown' },
  ] as const
).map<EffectiveContentEnvelopeV6>((descriptor) => ({
  ...base,
  version: 6,
  images: [],
  component: { kind: 'none' },
  commentsPolicy: 'open',
  trading: null,
  allowAnonymousDm: null,
  textSource: reviewedTextSource(base.text, descriptor, 'post'),
}));

// Captured before the repair from the immutable v2 parser; never regenerated in tests.
const frozenVectors = [
  {
    version: 1,
    canonical:
      '{"accountId":"00000000-0000-4000-8000-000000000001","authorMode":"named","category":"discussion","commentsPolicy":"open","component":{"kind":"none"},"images":[{"assetId":"00000000-0000-4000-8000-000000000016","digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}],"postId":null,"purpose":"publish_post","rootCommentId":null,"scope":{"affiliationAssertionId":null,"affiliationSnapshotId":null,"authorOriginRegionId":"00000000-0000-4000-8000-000000000003","configurationRevisionId":null,"identityCampusId":null,"identityRegionId":"00000000-0000-4000-8000-000000000003","identitySelectionId":null,"originalRegionId":"00000000-0000-4000-8000-000000000003","originalSpaceId":"00000000-0000-4000-8000-000000000002","sync":"none","topologySnapshotId":null},"spaceId":"00000000-0000-4000-8000-000000000002","targetReplyId":null,"text":"Protocol exact source\\n第二段 🐳","trading":null,"version":1}',
    digest: 'facf12bc0907563c81936e5d2a1391d1cb6c7549b044017c056b829316d078ff',
  },
  {
    version: 2,
    canonical:
      '{"accountId":"00000000-0000-4000-8000-000000000001","allowAnonymousDm":false,"authorMode":"named","category":"discussion","commentsPolicy":"open","component":{"kind":"none"},"images":[],"postId":null,"purpose":"publish_post","rootCommentId":null,"scope":{"affiliationAssertionId":null,"affiliationSnapshotId":null,"authorOriginRegionId":"00000000-0000-4000-8000-000000000003","configurationRevisionId":null,"identityCampusId":null,"identityRegionId":"00000000-0000-4000-8000-000000000003","identitySelectionId":null,"originalRegionId":"00000000-0000-4000-8000-000000000003","originalSpaceId":"00000000-0000-4000-8000-000000000002","sync":"none","topologySnapshotId":null},"spaceId":"00000000-0000-4000-8000-000000000002","targetReplyId":null,"text":"Protocol exact source\\n第二段 🐳","trading":null,"version":2}',
    digest: '7e3d69fb25e87038e38d67878b078a2002fd8784b817ee2fc049756fed1260d1',
  },
  {
    version: 3,
    canonical:
      '{"accountId":"00000000-0000-4000-8000-000000000001","authorMode":"named","category":"feedback","commentsPolicy":"open","component":{"kind":"none"},"feedback":{"contacts":{"phone":"","qq":"","wechat":""}},"images":[],"postId":null,"purpose":"publish_post","rootCommentId":null,"scope":{"affiliationAssertionId":null,"affiliationSnapshotId":null,"authorOriginRegionId":"00000000-0000-4000-8000-000000000003","configurationRevisionId":null,"identityCampusId":null,"identityRegionId":"00000000-0000-4000-8000-000000000003","identitySelectionId":null,"originalRegionId":null,"originalSpaceId":"00000000-0000-4000-8000-000000000002","sync":"none","topologySnapshotId":null},"spaceId":"00000000-0000-4000-8000-000000000002","targetReplyId":null,"text":"Protocol exact source\\n第二段 🐳","trading":null,"version":3}',
    digest: '4dd477c448271fe0441c68a06cae238f5d34e19bc57d52362ddfa1b026d375a8',
  },
  {
    version: 4,
    canonical:
      '{"accountId":"00000000-0000-4000-8000-000000000001","allowAnonymousDm":false,"authorMode":"named","category":"discussion","commentsPolicy":"open","component":{"kind":"none"},"images":[],"postId":null,"purpose":"publish_post","rootCommentId":null,"scope":{"affiliationAssertionId":"00000000-0000-4000-8000-000000000022","affiliationSnapshotId":"00000000-0000-4000-8000-000000000021","authorOriginRegionId":"00000000-0000-4000-8000-000000000003","configurationRevisionId":"00000000-0000-4000-8000-000000000018","identityCampusId":"00000000-0000-4000-8000-000000000019","identityRegionId":"00000000-0000-4000-8000-000000000003","identitySelectionId":"00000000-0000-4000-8000-000000000020","originalRegionId":"00000000-0000-4000-8000-000000000003","originalSpaceId":"00000000-0000-4000-8000-000000000002","publicationGroupId":"00000000-0000-4000-8000-000000000024","publicationMembersDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","sync":"related","syncPolicyId":"00000000-0000-4000-8000-000000000023","topologySnapshotId":"00000000-0000-4000-8000-000000000017"},"spaceId":"00000000-0000-4000-8000-000000000002","targetReplyId":null,"text":"Protocol exact source\\n第二段 🐳","trading":null,"version":4}',
    digest: '8ec06b1f4e23298a291a7dc44e5a4919344975151e269cdf6dac27d7ebcc8033',
  },
  {
    version: 5,
    canonical:
      '{"accountId":"00000000-0000-4000-8000-000000000001","authorMode":"named","category":"discussion","commentsPolicy":"open","component":{"binding":{"ancestry":[{"categoryId":"00000000-0000-4000-8000-000000000005","revision":"00000000-0000-4000-8000-000000000012"}],"catalogId":"00000000-0000-4000-8000-000000000013","categoryId":"00000000-0000-4000-8000-000000000005","categoryRevision":"00000000-0000-4000-8000-000000000012","contentVersion":1,"definitionRevision":"00000000-0000-4000-8000-000000000007","headRevision":"00000000-0000-4000-8000-000000000014","originRegionId":null,"originSourceId":"00000000-0000-4000-8000-000000000008","placementRevision":"00000000-0000-4000-8000-000000000011","protocolGeneration":"00000000-0000-4000-8000-000000000015","selector":{"kind":"global"},"sourceDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sourceId":"00000000-0000-4000-8000-000000000009","sourceRevision":"00000000-0000-4000-8000-000000000010","systemKey":"course","targetId":"00000000-0000-4000-8000-000000000004","targetRevision":"00000000-0000-4000-8000-000000000006","version":1},"kind":"rating_target_link","label":"课程","targetId":"00000000-0000-4000-8000-000000000004"},"images":[],"postId":null,"purpose":"publish_post","rootCommentId":null,"scope":{"affiliationAssertionId":null,"affiliationSnapshotId":null,"authorOriginRegionId":"00000000-0000-4000-8000-000000000003","configurationRevisionId":null,"identityCampusId":null,"identityRegionId":"00000000-0000-4000-8000-000000000003","identitySelectionId":null,"originalRegionId":"00000000-0000-4000-8000-000000000003","originalSpaceId":"00000000-0000-4000-8000-000000000002","sync":"none","topologySnapshotId":null},"spaceId":"00000000-0000-4000-8000-000000000002","targetReplyId":null,"text":"Protocol exact source\\n第二段 🐳","trading":null,"version":5}',
    digest: '91598ea09f58642e0d168bf5231f89a664f32af81a860fbe33f027733c682dae',
  },
  {
    version: 6,
    canonical:
      '{"accountId":"00000000-0000-4000-8000-000000000001","allowAnonymousDm":null,"authorMode":"named","category":"discussion","commentsPolicy":"open","component":{"kind":"none"},"images":[],"postId":null,"purpose":"publish_post","rootCommentId":null,"scope":{"affiliationAssertionId":null,"affiliationSnapshotId":null,"authorOriginRegionId":"00000000-0000-4000-8000-000000000003","configurationRevisionId":null,"identityCampusId":null,"identityRegionId":"00000000-0000-4000-8000-000000000003","identitySelectionId":null,"originalRegionId":"00000000-0000-4000-8000-000000000003","originalSpaceId":"00000000-0000-4000-8000-000000000002","sync":"none","topologySnapshotId":null},"spaceId":"00000000-0000-4000-8000-000000000002","targetReplyId":null,"text":"Protocol exact source\\n第二段 🐳","textSource":{"format":"plain","readingFormatting":"auto","sourceHash":"903aaebaa28e678fb64822e88875d374f164b1aedff641b97213a49b229b6e1e","version":1},"trading":null,"version":6}',
    digest: '05439fe00f4257108fe30094fc2ec0b446cf0cb7fa5ea9d2f32d7bb2a92d5e2a',
  },
  {
    version: 6,
    canonical:
      '{"accountId":"00000000-0000-4000-8000-000000000001","allowAnonymousDm":null,"authorMode":"named","category":"discussion","commentsPolicy":"open","component":{"kind":"none"},"images":[],"postId":null,"purpose":"publish_post","rootCommentId":null,"scope":{"affiliationAssertionId":null,"affiliationSnapshotId":null,"authorOriginRegionId":"00000000-0000-4000-8000-000000000003","configurationRevisionId":null,"identityCampusId":null,"identityRegionId":"00000000-0000-4000-8000-000000000003","identitySelectionId":null,"originalRegionId":"00000000-0000-4000-8000-000000000003","originalSpaceId":"00000000-0000-4000-8000-000000000002","sync":"none","topologySnapshotId":null},"spaceId":"00000000-0000-4000-8000-000000000002","targetReplyId":null,"text":"Protocol exact source\\n第二段 🐳","textSource":{"format":"plain","readingFormatting":"off","sourceHash":"903aaebaa28e678fb64822e88875d374f164b1aedff641b97213a49b229b6e1e","version":1},"trading":null,"version":6}',
    digest: '6064ea094fe111291e70c72bcb48e65d3285bb063447047c349e8f29083fedb8',
  },
  {
    version: 6,
    canonical:
      '{"accountId":"00000000-0000-4000-8000-000000000001","allowAnonymousDm":null,"authorMode":"named","category":"discussion","commentsPolicy":"open","component":{"kind":"none"},"images":[],"postId":null,"purpose":"publish_post","rootCommentId":null,"scope":{"affiliationAssertionId":null,"affiliationSnapshotId":null,"authorOriginRegionId":"00000000-0000-4000-8000-000000000003","configurationRevisionId":null,"identityCampusId":null,"identityRegionId":"00000000-0000-4000-8000-000000000003","identitySelectionId":null,"originalRegionId":"00000000-0000-4000-8000-000000000003","originalSpaceId":"00000000-0000-4000-8000-000000000002","sync":"none","topologySnapshotId":null},"spaceId":"00000000-0000-4000-8000-000000000002","targetReplyId":null,"text":"Protocol exact source\\n第二段 🐳","textSource":{"format":"markdown","sourceHash":"4eb9803c4fb059f8632ebe71db25d94184988e1d99b3daff48dc489e24752694","version":1},"trading":null,"version":6}',
    digest: '44896d1fabfcc67682beb73a9d804ef6919cbe15405752cccc007231d364777a',
  },
] as const;

for (const [index, input] of [...legacyInputs, ...sourceInputs].entries()) {
  test(`version ${input.version} exact canonical bytes and digest match frozen v2 vector ${index}`, () => {
    const envelope = canonicalEnvelope(input);
    assert.equal(envelope.version, frozenVectors[index]!.version);
    assert.equal(canonicalJson(envelope), frozenVectors[index]!.canonical);
    assert.equal(approvalDigest(envelope), frozenVectors[index]!.digest);
    assert.equal(Object.hasOwn(envelope, 'textSource'), input.version === 6);
    assert.ok(Object.isFrozen(envelope));
    assert.ok(Object.isFrozen(envelope.images));
  });
}

test('rating v5 and source v6 stay separate strict discriminated definitions', () => {
  const v5 = canonicalEnvelope(legacyInputs[4]);
  const v6 = canonicalEnvelope(sourceInputs[0]);
  assert.equal(v5.version, 5);
  assert.equal(v6.version, 6);
  assert.equal(v5.component.kind, 'rating_target_link');
  assert.equal(v6.component.kind, 'none');
  assert.deepEqual(v5.images, []);
  assert.deepEqual(v6.images, []);
  assert.notEqual(approvalDigest(v5), approvalDigest(v6));
  for (const invalid of [
    { ...v5, textSource: sourceInputs[0]!.textSource },
    { ...v5, allowAnonymousDm: null },
    { ...v5, component: { kind: 'none' } },
    { ...v6, component: rating },
    { ...v5, version: 6 },
    { ...v6, version: 5 },
    { ...v6, textSource: undefined },
  ])
    assert.throws(() => canonicalEnvelope(invalid));
});

test('both rating and source reject nonempty images while legacy media remains valid', () => {
  const images = [{ assetId: id(16), digest: 'b'.repeat(64) }];
  for (const input of [legacyInputs[4], ...sourceInputs]) {
    assert.throws(() => canonicalEnvelope({ ...input, images }));
    assert.throws(() => canonicalEnvelope({ ...input, images: undefined }));
    assert.throws(() => canonicalEnvelope({ ...input, images: null }));
  }
  const legacy = canonicalEnvelope({ ...base, images });
  assert.equal(legacy.version, 1);
  assert.deepEqual(legacy.images, images);
});

test('plain auto/off and explicit Markdown remain distinct v6 Review evidence', () => {
  const [auto, off, markdown] = sourceInputs;
  assert.ok(auto && off && markdown);
  assert.equal(auto.textSource.sourceHash, off.textSource.sourceHash);
  assert.notEqual(auto.textSource.sourceHash, markdown.textSource.sourceHash);
  assert.equal(new Set(sourceInputs.map(approvalDigest)).size, 3);
  for (const input of sourceInputs) {
    assert.throws(() =>
      canonicalEnvelope({
        ...input,
        textSource: { ...input.textSource, unexpected: true },
      }),
    );
    assert.throws(() =>
      canonicalEnvelope({
        ...input,
        textSource: { ...input.textSource, sourceHash: '0'.repeat(64) },
      }),
    );
    assert.throws(() =>
      canonicalEnvelope({ ...input, allowAnonymousDm: true }),
    );
  }
});
