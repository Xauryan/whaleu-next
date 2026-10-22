import { prepareTextSource } from '../src/community/text-source/source.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  canonicalEnvelope,
  canonicalJson,
  approvalDigest,
} from '../src/community/content-review/contracts.js';
import { homeOriginalIntentHash } from '../src/community/home-feed-policy/review-evidence.js';
import { reviewedTextSource } from '../src/community/text-source/protocol.js';
import { postIntent } from '../src/community/publication-intent.js';
import {
  publishPostSchema,
  legacyCategorySchema,
  categorySchema,
  readableCategorySchema,
} from '../src/community/contracts.js';
import { LEGACY_HOME_POLICY_COMMIT } from '../src/community/home-feed-policy/policy.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = {
  originalSpaceId: id(2),
  originalRegionId: id(3),
  authorOriginRegionId: id(3),
  identityRegionId: id(3),
  topologySnapshotId: null,
  sync: 'none' as const,
};
function fixture(source = false, text = '三个字') {
  const requestedIntent = postIntent(
    publishPostSchema.parse({
      clientRequestId: id(9),
      spaceId: id(2),
      category: 'discussion',
      text,
      imageAssetIds: [],
      authorMode: 'named',
      commentsPolicy: 'open',
      ...(source ? { textSource: { version: 1, format: 'markdown' } } : {}),
    }),
  );
  return {
    version: 7,
    accountId: id(1),
    purpose: 'publish_post',
    spaceId: id(2),
    category: 'water',
    authorMode: 'named',
    commentsPolicy: 'open',
    postId: null,
    rootCommentId: null,
    targetReplyId: null,
    text,
    images: [],
    component: { kind: 'none' },
    trading: null,
    scope,
    allowAnonymousDm: null,
    textSource: source
      ? reviewedTextSource(text, { version: 1, format: 'markdown' }, 'post')
      : null,
    home: {
      version: 1,
      admission: {
        id: id(4),
        revision: 1,
        digest: 'a'.repeat(64),
        sourceCommit: LEGACY_HOME_POLICY_COMMIT,
        validUntil: '2030-01-01T00:00:00Z',
      },
      requestedIntent,
      requestedIntentHash: homeOriginalIntentHash(requestedIntent as never),
      requestedRegionId: id(3),
      legacyChoose: 2,
      targetWaterSpaceId: id(2),
      targetWaterRegionId: id(3),
      auditExempt: false,
      result: 'short_text',
    },
  };
}
type TamperedPostFixture = Omit<ReturnType<typeof fixture>, 'home'> & {
  home: Omit<ReturnType<typeof fixture>['home'], 'result' | 'admission'> & {
    result: string | null;
    admission: Omit<
      ReturnType<typeof fixture>['home']['admission'],
      'sourceCommit'
    > & { sourceCommit: string };
  };
};
test('V7 binds composed short plain/Markdown source without changing source hash', () => {
  for (const source of [false, true]) {
    const input = fixture(source);
    const parsed = canonicalEnvelope(input);
    assert.equal(parsed.version, 7);
    assert.equal(approvalDigest(parsed).length, 64);
    if (parsed.version === 7)
      assert.deepEqual(parsed.textSource, input.textSource);
    assert.ok(Object.isFrozen(parsed));
  }
});
test('V7 rejects tampered result, original hash, effective placement, admission and source', () => {
  for (const mutate of [
    (v: TamperedPostFixture) => (v.home.result = null),
    (v: TamperedPostFixture) => (v.home.requestedIntentHash = 'b'.repeat(64)),
    (v: TamperedPostFixture) => (v.category = 'discussion'),
    (v: TamperedPostFixture) => (v.spaceId = id(8)),
    (v: TamperedPostFixture) => (v.scope.originalRegionId = id(8)),
    (v: TamperedPostFixture) => (v.home.auditExempt = true),
    (v: TamperedPostFixture) =>
      (v.home.admission.sourceCommit = '0'.repeat(40)),
    (v: TamperedPostFixture) => (v.textSource!.sourceHash = 'b'.repeat(64)),
    (v: TamperedPostFixture) =>
      (v.home.requestedIntent.textSource!.format = 'plain'),
    (v: TamperedPostFixture) => (v.purpose = 'publish_comment'),
    (v: TamperedPostFixture) => (v.version = 8),
  ]) {
    const input = structuredClone(fixture(true));
    mutate(input);
    assert.throws(() => canonicalEnvelope(input));
  }
});
test('V7 retains preexisting Markdown reference publication fence', () => {
  const input = fixture(true);
  input.text = '#10000000';
  input.home.requestedIntent.text = input.text;
  input.home.requestedIntentHash = homeOriginalIntentHash(
    input.home.requestedIntent as never,
  );
  input.home.result = 'reference_only';
  input.textSource = {
    version: 1,
    format: 'markdown',
    sourceHash: prepareTextSource(
      input.text,
      { version: 1, format: 'markdown' },
      'post',
    )!.sourceHash,
  };
  assert.throws(() => canonicalEnvelope(input));
});
test('V7 source absence cannot discard original explicit source evidence', () => {
  const input = fixture(true);
  input.textSource = null;
  assert.throws(() => canonicalEnvelope(input));
});
test('unrestricted global V7 does not demand author campus fallback; related flow remains outside V7', () => {
  const input = fixture(false, 'ordinary longer text');
  input.category = 'discussion';
  input.home.result = null as never;
  input.home.requestedRegionId = null as never;
  input.scope = { ...scope, originalRegionId: null as never };
  input.home.targetWaterSpaceId = null as never;
  input.home.targetWaterRegionId = null as never;
  input.home.legacyChoose = 100;
  assert.equal(canonicalEnvelope(input).version, 7);
  input.home.requestedIntent.syncToRelatedCampuses = true;
  input.home.requestedIntentHash = homeOriginalIntentHash(
    input.home.requestedIntent as never,
  );
  assert.throws(() => canonicalEnvelope(input));
});
test('restricted legacy sync intent is preserved while effective scope has no sync', () => {
  const input = fixture();
  input.home.requestedIntent.syncToRelatedCampuses = true;
  input.home.requestedIntentHash = homeOriginalIntentHash(
    input.home.requestedIntent as never,
  );
  assert.equal(canonicalEnvelope(input).scope.sync, 'none');
});
test('postIntent hash preserves ordered original legacy and explicit-source domains', () => {
  for (const source of [false, true]) {
    const input = fixture(source),
      intent = input.home.requestedIntent;
    const expected = createHash('sha256')
      .update(
        (source ? 'whaleu-community-text-source-intent:v1\n' : '') +
          JSON.stringify({ operation: 'publish_post', intent }),
      )
      .digest('hex');
    assert.equal(homeOriginalIntentHash(intent as never), expected);
    const reversed = Object.fromEntries(Object.entries(intent).reverse());
    assert.equal(homeOriginalIntentHash(reversed as never), expected);
  }
});
test('historical category schemas remain frozen while readable water is additive', () => {
  assert.equal(legacyCategorySchema.safeParse('water').success, false);
  assert.equal(categorySchema.safeParse('water').success, false);
  assert.equal(readableCategorySchema.safeParse('water').success, true);
  const input = fixture();
  const { home, textSource, allowAnonymousDm, ...old } = input;
  void home;
  void textSource;
  void allowAnonymousDm;
  for (const version of [1, 2, 3, 4, 5, 6])
    assert.throws(() => canonicalEnvelope({ ...old, version }));
  assert.equal(
    canonicalJson({ z: 1, a: [true, null] }),
    '{"a":[true,null],"z":1}',
  );
});
test('actual normalized image and poll accessories exempt; unproven result cannot override', () => {
  for (const accessory of ['image', 'poll'] as const) {
    const input = fixture();
    input.category = 'discussion';
    input.home.result = null as never;
    if (accessory === 'image') {
      input.images = [{ assetId: id(7), digest: 'c'.repeat(64) }] as never;
      input.home.requestedIntent.imageAssetIds = [id(7)];
    } else {
      const poll = {
        kind: 'poll' as const,
        question: 'pick',
        selectionMode: 'single' as const,
        options: ['one', 'two'],
      };
      input.component = poll;
      input.home.requestedIntent.component = poll;
    }
    input.home.requestedIntentHash = homeOriginalIntentHash(
      input.home.requestedIntent as never,
    );
    assert.equal(canonicalEnvelope(input).category, 'discussion');
    input.home.result = 'short_text';
    input.category = 'water';
    assert.throws(() => canonicalEnvelope(input));
  }
});
test('city restriction binds explicitly mapped water destination without rewriting requested intent', () => {
  const input = fixture();
  input.home.legacyChoose = 100;
  input.home.requestedRegionId = null as never;
  input.home.targetWaterSpaceId = id(8);
  input.spaceId = id(8);
  input.scope = { ...scope, originalSpaceId: id(8) };
  const originalHash = input.home.requestedIntentHash;
  const parsed = canonicalEnvelope(input);
  assert.equal(parsed.spaceId, id(8));
  if (parsed.version === 7) {
    assert.equal(parsed.home.requestedIntent.spaceId, id(2));
    assert.equal(parsed.home.requestedIntentHash, originalHash);
  }
});
function discussionFixture(
  purpose: 'publish_comment' | 'publish_reply',
  source: boolean,
) {
  const parent = fixture(true);
  const { home, ...base } = parent;
  void home;
  const text = 'child text';
  return {
    ...base,
    version: 8,
    purpose,
    text,
    postId: id(20),
    rootCommentId: purpose === 'publish_reply' ? id(21) : null,
    targetReplyId: null,
    homeParent: {
      postId: id(20),
      decisionId: id(22),
      digest: approvalDigest(canonicalEnvelope(parent)),
    },
    textSource: source
      ? reviewedTextSource(
          text,
          { version: 1, format: 'markdown' },
          purpose === 'publish_comment' ? 'comment' : 'reply',
        )
      : null,
  };
}
type TamperedDiscussionFixture = Omit<
  ReturnType<typeof discussionFixture>,
  'purpose' | 'postId' | 'targetReplyId' | 'allowAnonymousDm' | 'images'
> & {
  purpose: 'publish_post' | 'publish_comment' | 'publish_reply';
  postId: string | null;
  targetReplyId: string | null;
  allowAnonymousDm: boolean | null;
  images: { assetId: string; digest: string }[];
  home?: ReturnType<typeof fixture>['home'];
};
test('V8 supports source and legacy-body water children without classifying child text', () => {
  for (const purpose of ['publish_comment', 'publish_reply'] as const)
    for (const source of [false, true]) {
      const input = discussionFixture(purpose, source);
      const child = canonicalEnvelope(input);
      assert.equal(child.version, 8);
      assert.equal(child.category, 'water');
      assert.equal(Object.hasOwn(child, 'home'), false);
      if (child.version === 8)
        assert.deepEqual(child.textSource, input.textSource);
      const changed = canonicalEnvelope({
        ...input,
        homeParent: { ...input.homeParent, digest: 'c'.repeat(64) },
      });
      assert.notEqual(approvalDigest(child), approvalDigest(changed));
    }
});
test('V8 validates parent identity, ancestry, media limits and forbids reclassification evidence', () => {
  for (const mutate of [
    (v: TamperedDiscussionFixture) => (v.homeParent.postId = id(99)),
    (v: TamperedDiscussionFixture) => (v.homeParent.digest = 'broken'),
    (v: TamperedDiscussionFixture) => (v.home = fixture().home),
    (v: TamperedDiscussionFixture) => (v.purpose = 'publish_post'),
    (v: TamperedDiscussionFixture) => (v.postId = null),
    (v: TamperedDiscussionFixture) => (v.rootCommentId = id(99)),
    (v: TamperedDiscussionFixture) => (v.targetReplyId = id(99)),
    (v: TamperedDiscussionFixture) => (v.allowAnonymousDm = false),
    (v: TamperedDiscussionFixture) => (v.text = '字'.repeat(501)),
    (v: TamperedDiscussionFixture) =>
      (v.images = [1, 2, 3, 4].map((n) => ({
        assetId: id(n + 30),
        digest: 'd'.repeat(64),
      }))),
    (v: TamperedDiscussionFixture) => (v.version = 9),
  ]) {
    const input = discussionFixture('publish_comment', false);
    mutate(input);
    assert.throws(() => canonicalEnvelope(input));
  }
  const reply = discussionFixture('publish_reply', false);
  assert.throws(() => canonicalEnvelope({ ...reply, rootCommentId: null }));
  const images = [{ assetId: id(30), digest: 'd'.repeat(64) }];
  assert.equal(canonicalEnvelope({ ...reply, images, text: '' }).version, 8);
  assert.throws(() =>
    canonicalEnvelope({ ...discussionFixture('publish_reply', true), images }),
  );
});
test('V8 explicit source still rejects raw Markdown reference syntax', () => {
  const input = discussionFixture('publish_comment', true);
  const text = '#10000000';
  const textSource = {
    version: 1,
    format: 'markdown',
    sourceHash: prepareTextSource(
      text,
      { version: 1, format: 'markdown' },
      'comment',
    )!.sourceHash,
  };
  assert.throws(() => canonicalEnvelope({ ...input, text, textSource }));
});
