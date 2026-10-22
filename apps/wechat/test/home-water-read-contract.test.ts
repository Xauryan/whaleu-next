import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiClient,
  type Endpoint,
  type RequestOptions,
} from '../src/api/client';
import {
  categories,
  type ReadableCategory,
  decodeFeed,
  decodeOwnPublications,
  decodePost,
  decodePostIntent,
  isCategory,
  isReadableCategory,
} from '../src/community/contract';
import { HttpCommunityGateway } from '../src/community/gateway';
import { decodeHotPage } from '../src/community/hot-contract';
import {
  decodeSearchHit,
  decodeSearchIntent,
  decodeSearchPage,
  searchTargetPath,
} from '../src/community/search-contract';
import { FollowingGateway } from '../src/following/gateway';
import { Cancellation } from '../src/platform/contracts';
import { ClientError } from '../src/api/errors';
import {
  intent,
  commentId,
  setup,
  otherId,
  post,
  postId,
  publicExperienceDisplay,
  spaceId,
} from './community-helpers';
import { hitFromPost } from './search-helpers';
import {
  decodeCategoryManagement,
  decodeReclassificationCommand,
  reclassificationLabels,
} from '../src/category-reclassification/contract';
import type { TextSourceCapability } from '../src/community/text-source-contract';
import type { PendingAttempt } from '../src/community/pending-attempt';
import { ComposeController } from '../src/pages/community-compose/controller';

const waterPost = () => post({ category: 'water' });
const page = (item = waterPost()) => ({
  items: [item],
  nextCursor: null,
  continuation: 'end',
});
const publication = () => ({
  id: postId,
  spaceId,
  category: 'water',
  status: 'published',
  publishedAt: waterPost().publishedAt,
});
function fixture(value: unknown) {
  const calls: { endpoint: Endpoint<unknown>; options: RequestOptions }[] = [];
  const api = {
    request: async <T>(endpoint: Endpoint<T>, options: RequestOptions) => {
      calls.push({ endpoint, options });
      return endpoint.decode(value);
    },
  } as unknown as ApiClient;
  return {
    gateway: new HttpCommunityGateway(api),
    following: new FollowingGateway(api),
    calls,
  };
}

test('water is a bounded read category, never a client publication or search-filter option', () => {
  assert.equal(isReadableCategory('water'), true);
  assert.equal(isCategory('water'), false);
  assert.equal(
    categories.some((category: string) => category === 'water'),
    false,
  );
  assert.throws(() => decodePostIntent({ ...intent(), category: 'water' }));
  assert.throws(() =>
    decodeSearchIntent({ spaceId, category: 'water', q: '原文' }),
  );
  for (const category of ['future_category', 'Water', '', null, 9]) {
    assert.equal(isReadableCategory(category), false);
    assert.throws(() => decodePost({ ...waterPost(), category }));
    assert.throws(() =>
      decodeOwnPublications({
        items: [{ ...publication(), category }],
        nextCursor: null,
      }),
    );
  }
});

test('feed, detail, own publications and shared response readers decode water without rewriting its destination', async () => {
  assert.equal(decodePost(waterPost()).category, 'water');
  assert.equal(decodeFeed(page()).items[0]!.category, 'water');
  assert.equal(decodeHotPage(page()).items[0]!.category, 'water');
  assert.equal(
    decodeOwnPublications({ items: [publication()], nextCursor: null })
      .items[0]!.category,
    'water',
  );
  const hit = hitFromPost(waterPost());
  assert.equal(decodeSearchHit(hit).category, 'water');
  assert.equal(
    decodeSearchPage({ ...page(), items: [hit], effectiveTypes: ['post'] })
      .items[0]!.category,
    'water',
  );
  assert.equal(
    searchTargetPath(hit.target, spaceId),
    `/pages/community-detail/community-detail?postId=${postId}&viewSpaceId=${spaceId}`,
  );
  assert.equal(
    (
      await fixture(waterPost()).gateway.post(
        postId,
        new Cancellation(),
        spaceId,
      )
    ).category,
    'water',
  );
  assert.equal(
    (await fixture(page()).gateway.feed({ spaceId }, new Cancellation()))
      .items[0]!.category,
    'water',
  );
});

test('water readers keep anonymous identity, space scope and response-filter validation intact', async () => {
  const water = waterPost();
  for (const field of ['accountId', 'profileId', 'campusId']) {
    const author = { ...water.author, [field]: otherId };
    assert.throws(() => decodePost({ ...water, author }));
    assert.throws(() => decodeSearchHit({ ...hitFromPost(water), author }));
  }
  assert.throws(() =>
    decodePost({ ...water, space: { ...water.space, kind: 'global' } }),
  );
  assert.throws(() =>
    decodeSearchHit({
      ...hitFromPost(water),
      space: { ...water.space, kind: 'global' },
    }),
  );
  assert.throws(() => decodePost({ ...water, allowAnonymousDm: true }));
  assert.throws(() => decodePost({ ...water, discussionCount: 2 }));
  assert.throws(() =>
    decodeOwnPublications({
      items: [{ ...publication(), text: water.text }],
      nextCursor: null,
    }),
  );
  await assert.rejects(
    fixture(page()).gateway.feed(
      { spaceId, category: 'discussion' },
      new Cancellation(),
    ),
    { kind: 'protocol' },
  );
  await assert.rejects(
    fixture(page()).gateway.feed({ spaceId: otherId }, new Cancellation()),
    { kind: 'protocol' },
  );
  await assert.rejects(
    fixture(page()).following.feed({ spaceId }, new Cancellation()),
    { kind: 'protocol' },
  );
  const namedWater = post({
    category: 'water',
    author: {
      kind: 'named',
      profileId: otherId,
      displayName: '公开鲸鱼',
      avatar: null,
      experienceDisplay: publicExperienceDisplay(),
    },
  });
  assert.equal(
    (
      await fixture(page(namedWater)).following.feed(
        { spaceId },
        new Cancellation(),
      )
    ).items[0]!.category,
    'water',
  );
  await assert.rejects(
    fixture(page(namedWater)).following.feed(
      { spaceId, category: 'discussion' },
      new Cancellation(),
    ),
    { kind: 'protocol' },
  );
});

const childCapability = (
  authorMode: 'named' | 'anonymous',
): TextSourceCapability => ({
  version: 1,
  authorMode,
  availability: 'available',
  operations: ['publish_comment', 'publish_reply'],
  formats: ['plain', 'markdown'],
  readingFormatting: ['auto', 'off'],
  media: 'unavailable',
  markdownReferences: 'unavailable',
  formatter: 'not_configured',
});

test('water source capability uses its actual read scope without widening legacy posting capabilities', async () => {
  const f = fixture(childCapability('anonymous'));
  const result = await f.gateway.textSourceCapabilities(
    spaceId,
    'water',
    'anonymous',
    new Cancellation(),
  );
  assert.deepEqual(result.operations, ['publish_comment', 'publish_reply']);
  assert.equal(
    f.calls[0]!.endpoint.path,
    '/v1/community/text-source-capabilities',
  );
  assert.deepEqual(f.calls[0]!.options.query, {
    spaceId,
    category: 'water',
    authorMode: 'anonymous',
  });
  await assert.rejects(
    f.gateway.textSourceCapabilities(
      spaceId,
      'future_category' as ReadableCategory,
      'anonymous',
      new Cancellation(),
    ),
    { kind: 'protocol' },
  );
  assert.equal(f.calls.length, 1);
});

test('water management reads current category without enabling category mutation', () => {
  const management = {
    postId,
    currentCategory: 'water',
    revision: 0,
    canChange: false,
    targets: [],
  };
  assert.equal(decodeCategoryManagement(management).currentCategory, 'water');
  assert.equal(reclassificationLabels.water, '水区');
  assert.throws(() =>
    decodeCategoryManagement({
      ...management,
      currentCategory: 'future_category',
    }),
  );
  assert.throws(() =>
    decodeCategoryManagement({
      ...management,
      canChange: true,
      targets: [],
    }),
  );
  assert.throws(() =>
    decodeCategoryManagement({ ...management, targets: ['water'] }),
  );
  assert.throws(() =>
    decodeReclassificationCommand({
      clientRequestId: intent().clientRequestId,
      postId,
      expectedRevision: 0,
      targetCategory: 'water',
    }),
  );
});

test('water comment and reply composers retain plain and Markdown source choices and original author mode', async () => {
  for (const destination of [
    { operation: 'publish_comment', postId },
    {
      operation: 'publish_reply',
      postId,
      rootCommentId: commentId,
      targetReplyId: null,
    },
  ] as const) {
    for (const format of ['plain', 'markdown'] as const) {
      const s = setup();
      const calls: ReadableCategory[] = [];
      const submissions: PendingAttempt[] = [];
      s.gateway.postImpl = async () => waterPost();
      Object.assign(s.gateway, {
        textSourceCapabilities: async (
          _spaceId: string,
          category: ReadableCategory,
          mode: 'named' | 'anonymous',
        ) => {
          calls.push(category);
          return childCapability(mode);
        },
        submitReview: async (attempt: PendingAttempt) => {
          submissions.push(attempt);
          return {
            requestId: attempt.payload.clientRequestId,
            operation: attempt.operation,
            status: 'pending',
          };
        },
        reviewStatus: async (attempt: PendingAttempt) => ({
          requestId: attempt.payload.clientRequestId,
          operation: attempt.operation,
          status: 'pending',
        }),
      });
      s.gateway.receiptImpl = async () => {
        throw new ClientError('http', 'missing', {
          httpStatus: 404,
          serverCode: 'REQUEST_NOT_FOUND',
        });
      };
      const controller = new ComposeController(
        s.runtime,
        destination,
        () => undefined,
      );
      await controller.load();
      assert.deepEqual(calls, ['water', 'water']);
      controller.setText('水区原回复');
      controller.setSourceFormat(format);
      await controller.submit();
      assert.equal(submissions.length, 1);
      assert.equal(submissions[0]!.operation, destination.operation);
      assert.equal(submissions[0]!.payload.authorMode, 'anonymous');
      assert.deepEqual(
        submissions[0]!.payload.textSource,
        format === 'markdown'
          ? { version: 1, format }
          : { version: 1, format, readingFormatting: 'auto' },
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          submissions[0]!.payload,
          'category',
        ),
        false,
      );
      controller.dispose();
    }
  }
});
