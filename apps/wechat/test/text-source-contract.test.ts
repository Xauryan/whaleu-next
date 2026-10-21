import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isRecord } from '../src/api/errors';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ApiClient } from '../src/api/client';
import { HttpReadingCommunityGateway } from '../src/community/reading-gateway';
import { decodeSourcePresentation } from '../src/community/text-source-read-contract';
import {
  decodeCommentIntent,
  decodePostIntent,
} from '../src/community/contract';
import { decodeReplyIntent } from '../src/community/discussion-contract';
import { batchPublicationReference } from '../src/media/batch-publication';
import { Cancellation } from '../src/platform/contracts';
import {
  canonicalSourceText,
  decodeTextSourceDescriptor,
  decodeTextSourceCapability,
  textSourceHash,
  sourceEligible,
  DEFAULT_TEXT_SOURCE,
  type TextSourceDescriptor,
} from '../src/community/text-source-contract';
import {
  intent,
  setup,
  postId,
  commentId,
  requestId,
} from './community-helpers';
import { ScriptedTransport, deferred, flush, response } from './helpers';
import { wireCredentials } from './identity-helpers';

// Execute the real API leaf at the test runtime boundary, without importing its
// NodeNext production graph into the Mini Program's strict ES2020 compilation.
async function apiFunction(
  module: string,
  name: string,
): Promise<(...args: unknown[]) => unknown> {
  const loaded: unknown = await import(
    pathToFileURL(path.resolve(__dirname, '../../api/src/community', module))
      .href
  );
  assert.ok(isRecord(loaded));
  const fn = loaded[name];
  assert.ok(typeof fn === 'function');
  return (...args: unknown[]): unknown => Reflect.apply(fn, undefined, args);
}
const source = (
  text = ('鲸'.repeat(119) + '。').repeat(3),
  descriptor: TextSourceDescriptor = DEFAULT_TEXT_SOURCE,
) => ({
  version: 1,
  classification: 'reviewedSource',
  kind: 'post',
  id: postId,
  postId,
  rootCommentId: null,
  text,
  sourceRevision: 1,
  textSource: { ...descriptor, sourceHash: textSourceHash(text, descriptor) },
  readingFormattingEligible: sourceEligible(text, descriptor, 'post'),
  presentationStatus: sourceEligible(text, descriptor, 'post')
    ? 'not_configured'
    : 'ineligible',
});
const envelope = (text?: string) => ({
  version: 2,
  source: source(text),
  presentation: { status: 'source' },
});

test('native canonical source hashes match API UTF-8, CRLF and scalar thresholds without NFC or trim', async () => {
  const prepareTextSource = await apiFunction(
    'text-source/source.ts',
    'prepareTextSource',
  );
  for (const raw of [
    '  文本\r\n末尾  ',
    '😀'.repeat(150),
    '鲸'.repeat(300),
    'e\u0301\n全角Ａ',
    '# title\n**bold**',
  ]) {
    for (const descriptor of [
      DEFAULT_TEXT_SOURCE,
      { version: 1, format: 'plain', readingFormatting: 'off' },
      { version: 1, format: 'markdown' },
    ] as const) {
      const server = prepareTextSource(raw, descriptor, 'post');
      assert.ok(isRecord(server));
      assert.ok(typeof server.canonicalText === 'string');
      assert.equal(canonicalSourceText(raw, 'post'), server.canonicalText);
      assert.equal(
        textSourceHash(server.canonicalText, descriptor),
        server.sourceHash,
      );
      assert.equal(
        sourceEligible(server.canonicalText, descriptor, 'post'),
        server.readingFormattingEligible,
      );
    }
  }
  assert.equal(
    sourceEligible('😀'.repeat(150), DEFAULT_TEXT_SOURCE, 'post'),
    false,
  );
  assert.equal(
    sourceEligible('😀'.repeat(200), DEFAULT_TEXT_SOURCE, 'comment'),
    true,
  );
  for (const raw of ['a\rb', '\u0000', '\u0085', '\ud800', '😀'.repeat(2501)])
    assert.throws(() => canonicalSourceText(raw, 'post'));
});

test('explicit descriptor never guesses Markdown or accepts unknown policy/provider keys', () => {
  assert.equal(decodeTextSourceDescriptor(DEFAULT_TEXT_SOURCE).format, 'plain');
  assert.deepEqual(
    decodeTextSourceDescriptor({ version: 1, format: 'markdown' }),
    { version: 1, format: 'markdown' },
  );
  for (const value of [
    { version: 1, format: 'markdown', readingFormatting: 'auto' },
    { ...DEFAULT_TEXT_SOURCE, provider: 'anything' },
    { ...DEFAULT_TEXT_SOURCE, readingFormatting: 'yes' },
    null,
  ])
    assert.throws(() => decodeTextSourceDescriptor(value));
  assert.throws(() =>
    decodePostIntent(
      intent({ textSource: DEFAULT_TEXT_SOURCE, imageAssetIds: [postId] }),
    ),
  );
  assert.throws(() =>
    decodePostIntent(
      intent({ textSource: DEFAULT_TEXT_SOURCE, allowAnonymousDm: true }),
    ),
  );
  assert.throws(() =>
    decodeCommentIntent({
      clientRequestId: requestId,
      text: '![x](whaleu-asset:x)',
      authorMode: 'named',
      imageAssetIds: [],
      textSource: { version: 1, format: 'markdown' },
    }),
  );
});

test('native post/comment/reply source hashes bind exact descriptor; old intent hash remains old domain', async () => {
  const serverIntentHash = await apiFunction(
    'text-source/protocol.ts',
    'textSourceIntentHash',
  );
  const s = setup();
  for (const descriptor of [
    DEFAULT_TEXT_SOURCE,
    { version: 1, format: 'plain', readingFormatting: 'off' },
    { version: 1, format: 'markdown' },
  ] as const) {
    const body = decodePostIntent(
      intent({ text: ' 原文\n😀 ', textSource: descriptor }),
    );
    const expected = {
      spaceId: body.spaceId,
      category: body.category,
      text: body.text,
      imageAssetIds: body.imageAssetIds,
      authorMode: body.authorMode,
      commentsPolicy: body.commentsPolicy,
      textSource: descriptor,
    };
    assert.equal(
      batchPublicationReference({
        version: 1,
        accountId: s.accountId,
        operation: 'publish_post',
        payload: body,
      }).intentHash,
      serverIntentHash('publish_post', expected),
    );
    const comment = decodeCommentIntent({
      clientRequestId: requestId,
      text: body.text,
      authorMode: 'anonymous',
      imageAssetIds: [],
      textSource: descriptor,
    });
    assert.equal(
      batchPublicationReference({
        version: 1,
        accountId: s.accountId,
        operation: 'publish_comment',
        postId,
        payload: comment,
      }).intentHash,
      serverIntentHash('publish_comment', {
        postId,
        text: comment.text,
        imageAssetIds: [],
        authorMode: comment.authorMode,
        textSource: descriptor,
      }),
    );
    const reply = decodeReplyIntent({ ...comment, targetReplyId: null });
    assert.equal(
      batchPublicationReference({
        version: 1,
        accountId: s.accountId,
        operation: 'publish_reply',
        postId,
        rootCommentId: commentId,
        payload: reply,
      }).intentHash,
      serverIntentHash('publish_reply', {
        rootCommentId: commentId,
        targetReplyId: null,
        text: comment.text,
        imageAssetIds: [],
        authorMode: comment.authorMode,
        textSource: descriptor,
      }),
    );
  }
  const body = intent();
  assert.equal(
    batchPublicationReference({
      version: 1,
      accountId: s.accountId,
      operation: 'publish_post',
      payload: body,
    }).intentHash,
    createHash('sha256')
      .update(
        JSON.stringify({
          operation: 'publish_post',
          intent: {
            spaceId: body.spaceId,
            category: body.category,
            text: body.text,
            imageAssetIds: body.imageAssetIds,
            authorMode: body.authorMode,
            commentsPolicy: body.commentsPolicy,
          },
        }),
      )
      .digest('hex'),
  );
});

test('only optional presentation failures fall back, mandatory source/hash/ancestry failures never do', async () => {
  const formatSource = await apiFunction(
    'reading-formatting/formatter.ts',
    'formatSource',
  );
  const raw = envelope();
  const outcome = formatSource({
    kind: 'post',
    id: postId,
    sourceRevision: 1,
    sourceHash: raw.source.textSource.sourceHash,
    publicationRequestId: requestId,
    text: raw.source.text,
    descriptor: DEFAULT_TEXT_SOURCE,
  });
  assert.ok(isRecord(outcome));
  assert.equal(outcome.kind, 'plan');
  assert.ok(isRecord(outcome.plan));
  if (outcome.kind !== 'plan') throw new Error('formatter failed');
  const result = decodeSourcePresentation({
    ...raw,
    presentation: { status: 'formatted', plan: outcome.plan },
  });
  assert.equal(result.presentation.status, 'formatted');
  if (result.presentation.status !== 'formatted')
    throw new Error('plan missing');
  assert.equal(
    result.presentation.plan.spans
      .map(({ start, end }) => result.source.text.slice(start, end))
      .join(''),
    raw.source.text,
  );
  for (const plan of [
    { ...outcome.plan, formatter: 'unknown' },
    { ...outcome.plan, spans: [{ start: 1, end: raw.source.text.length }] },
    { ...outcome.plan, text: 'injected' },
  ])
    assert.equal(
      decodeSourcePresentation({
        ...raw,
        presentation: { status: 'formatted', plan },
      }).presentation.status,
      'source',
    );
  assert.throws(() =>
    decodeSourcePresentation({
      ...raw,
      source: { ...raw.source, text: 'tampered' },
    }),
  );
  assert.throws(() =>
    decodeSourcePresentation({
      ...raw,
      source: { ...raw.source, rootCommentId: commentId },
    }),
  );
  assert.throws(() =>
    decodeSourcePresentation({
      ...raw,
      source: { ...raw.source, authorAccountId: postId },
    }),
  );
  const emoji = envelope('鲸'.repeat(299) + '😀');
  assert.equal(
    decodeSourcePresentation({
      ...emoji,
      presentation: {
        status: 'formatted',
        plan: {
          ...outcome.plan,
          mode: 'grouped',
          reason: 'grouped',
          spans: [
            { start: 0, end: 300 },
            { start: 300, end: 301 },
          ],
        },
      },
    }).presentation.status,
    'source',
  );
});

test('source capability exact shape binds author mode and never invents formatter/provider readiness', () => {
  const available = {
    version: 1,
    authorMode: 'named',
    availability: 'available',
    operations: ['publish_post'],
    formats: ['plain', 'markdown'],
    readingFormatting: ['auto', 'off'],
    media: 'unavailable',
    markdownReferences: 'unavailable',
    formatter: 'not_configured',
  };
  assert.equal(decodeTextSourceCapability(available).availability, 'available');
  for (const value of [
    { ...available, formatter: 'ready' },
    { ...available, operations: ['publish_post', 'publish_post'] },
    { ...available, availability: 'unavailable' },
  ])
    assert.throws(() => decodeTextSourceCapability(value));
});

function http() {
  const s = setup(),
    transport = new ScriptedTransport();
  return {
    ...s,
    transport,
    gateway: new HttpReadingCommunityGateway(
      new ApiClient('https://api.example', transport, s.sessions, {
        refresh: async () => s.sessions.snapshot(),
      }),
    ),
  };
}
test('real source gateway requires authentication, exact target and unchanged authorized source fallback', async () => {
  const s = http();
  s.transport.reply(envelope());
  const read = await s.gateway.textSource('post', postId, new Cancellation());
  assert.equal(read.source.text, source().text);
  assert.ok(s.transport.requests[0]!.headers.Authorization);
  assert.match(
    s.transport.requests[0]!.url,
    /\/v2\/community\/text-sources\/post\//,
  );
  s.transport.reply({
    ...envelope(),
    source: { ...source(), id: commentId, postId: commentId },
  });
  await assert.rejects(
    s.gateway.textSource('post', postId, new Cancellation()),
  );
  s.transport.reply({ error: { code: 'POST_NOT_FOUND' } }, 404);
  await assert.rejects(
    s.gateway.textSource('post', postId, new Cancellation()),
  );
  assert.equal(
    s.transport.requests.length,
    3,
    'No legacy or guest fallback request on source denial',
  );
  s.sessions.logout();
  await assert.rejects(
    s.gateway.textSource('post', postId, new Cancellation()),
  );
  assert.equal(s.transport.requests.length, 3);
});

test('late source gateway responses cannot cross account change or cancellation', async () => {
  const s = http(),
    late = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => late.promise);
  const pending = s.gateway.textSource('post', postId, new Cancellation());
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: commentId,
  });
  late.resolve(response(envelope()));
  await assert.rejects(pending);
  const cancelled = new Cancellation();
  cancelled.cancel();
  await assert.rejects(s.gateway.textSource('post', postId, cancelled));
  assert.equal(s.transport.requests.length, 1);
});
