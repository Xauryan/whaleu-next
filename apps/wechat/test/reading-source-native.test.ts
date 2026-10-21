import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ApiClient } from '../src/api/client';
import { Cancellation } from '../src/platform/contracts';
import {
  HttpReadingCommunityGateway,
  withReadingSources,
} from '../src/community/reading-gateway';
import {
  decodeReadingPost,
  decodeReadingComment,
  decodeReadingContext,
  decodeReadingComments,
  decodeReadingReplies,
} from '../src/community/reading-contract';
import {
  DEFAULT_TEXT_SOURCE,
  textSourceHash,
  sourceEligible,
  type SourceKind,
  type TextSourceDescriptor,
} from '../src/community/text-source-contract';
import { renderTextSource } from '../src/community/text-source-renderer';
import {
  DetailController,
  type DetailView,
} from '../src/pages/community-detail/controller';
import {
  ThreadController,
  type ThreadView,
} from '../src/pages/community-thread/controller';
import {
  comment,
  commentId,
  post,
  postId,
  reply,
  replyId,
  otherId,
  spaceId,
  publicExperienceDisplay,
  setup,
} from './community-helpers';
import { ScriptedTransport, response, deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
const legacy = { classification: 'legacyPlain' };
function reviewed(
  kind: SourceKind,
  content: {
    id: string;
    text: string;
    postId?: string;
    rootCommentId?: string;
  },
  descriptor: TextSourceDescriptor = DEFAULT_TEXT_SOURCE,
) {
  const eligible = sourceEligible(content.text, descriptor, kind);
  return {
    classification: 'reviewedSource',
    value: {
      version: 2,
      source: {
        version: 1,
        classification: 'reviewedSource',
        kind,
        id: content.id,
        postId: kind === 'post' ? content.id : content.postId,
        rootCommentId:
          kind === 'post'
            ? null
            : kind === 'comment'
              ? content.id
              : content.rootCommentId,
        text: content.text,
        sourceRevision: 1,
        textSource: {
          ...descriptor,
          sourceHash: textSourceHash(content.text, descriptor),
        },
        readingFormattingEligible: eligible,
        presentationStatus: eligible ? 'not_configured' : 'ineligible',
      },
      presentation: { status: 'source' },
    },
  };
}
const p = post({ text: '# 明确的 Markdown\n**粗体**与😀' });
const pn = () => ({
  content: p,
  body: reviewed('post', p, { version: 1, format: 'markdown' }),
});
const r = reply({ text: '原样回复😀' });
const rn = () => ({ content: r, body: reviewed('reply', r) });
const c = comment({
  text: '根回复',
  replyCount: 1,
  replyPreview: { items: [r], nextCursor: null },
});
const cn = () => ({
  content: c,
  body: reviewed('comment', c),
  replyPreviewBodies: [{ id: r.id, body: reviewed('reply', r) }],
});
const pd = () => ({ version: 2, ...pn() });
const cd = () => ({ version: 2, ...cn() });
const cp = () => ({ version: 2, items: [cn()], nextCursor: null });
const rp = () => ({ version: 2, items: [rn()], nextCursor: null });
const ctx = () => ({
  version: 2,
  comment: cn(),
  reply: rn(),
  replies: { items: [rn()], nextCursor: null },
});
function http() {
  const s = setup(),
    transport = new ScriptedTransport();
  const api = new ApiClient('https://api.example', transport, s.sessions, {
    refresh: async () => s.sessions.snapshot(),
  });
  return {
    ...s,
    transport,
    api,
    reading: new HttpReadingCommunityGateway(api),
    readingRuntime: withReadingSources(s.runtime, api),
  };
}
test('versioned source discriminator, exact preview binding and native rendering compose without changing legacy DTO', () => {
  const read = decodeReadingPost(pd());
  assert.equal(read.readingBody?.classification, 'reviewedSource');
  if (read.readingBody?.classification !== 'reviewedSource')
    throw new Error('source absent');
  const rendered = renderTextSource({ presentation: read.readingBody.value });
  assert.equal(rendered.rawSource, p.text);
  assert.equal(rendered.mode, 'markdown');
  const plain = decodeReadingPost({ version: 2, content: p, body: legacy });
  assert.equal(
    plain.readingBody?.classification,
    'legacyPlain',
    'Markdown-looking legacy text stays legacy',
  );
  assert.equal(
    decodeReadingComment(cd()).replyPreview.items[0]?.readingBody
      ?.classification,
    'reviewedSource',
  );
  assert.equal(
    decodeReadingContext(ctx()).reply?.readingBody?.classification,
    'reviewedSource',
  );
  assert.equal(decodeReadingComments(cp()).items.length, 1);
  assert.equal(decodeReadingReplies(rp()).items.length, 1);
});
test('unknown/missing discriminator, source mismatch, preview substitutions, private author keys and duplicate pages fail closed', () => {
  const mismatched = reviewed('post', {
    ...p,
    text: 'other exact hashed source',
  });
  for (const value of [
    { ...pd(), body: undefined },
    { ...pd(), body: { classification: 'unknown' } },
    { ...pd(), body: mismatched },
    { ...pd(), body: { ...legacy, value: reviewed('post', p).value } },
    { ...pd(), content: { ...p, author: { ...p.author, accountId: otherId } } },
  ])
    assert.throws(() => decodeReadingPost(value));
  for (const previews of [
    [],
    [{ id: otherId, body: legacy }],
    [
      {
        id: replyId,
        body: reviewed('reply', { ...r, rootCommentId: otherId }),
      },
    ],
    [
      { id: replyId, body: legacy },
      { id: replyId, body: legacy },
    ],
  ])
    assert.throws(() =>
      decodeReadingComment({ ...cd(), replyPreviewBodies: previews }),
    );
  assert.throws(() => decodeReadingComments({ ...cp(), items: [cn(), cn()] }));
  assert.throws(() => decodeReadingReplies({ ...rp(), items: [rn(), rn()] }));
  assert.throws(() =>
    decodeReadingContext({
      ...ctx(),
      reply: { content: { ...r, rootCommentId: otherId }, body: legacy },
    }),
  );
});
test('actual feature gateway uses all six authenticated v2 routes and preserves viewSpace and query contract', async () => {
  const s = http(),
    cancel = new Cancellation();
  for (const value of [pd(), cp(), cd(), rp(), { version: 2, ...rn() }, ctx()])
    s.transport.reply(value);
  await s.reading.post(postId, cancel, spaceId);
  await s.reading.comments(postId, null, cancel, {
    sort: 'time',
    order: 'asc',
    limit: 3,
    previewLimit: 5,
  });
  await s.reading.comment(commentId, cancel);
  await s.reading.replies(commentId, null, cancel, 7);
  await s.reading.reply(replyId, cancel);
  await s.reading.discussionContext(postId, { replyId }, cancel);
  assert.equal(s.transport.requests.length, 6);
  assert.ok(
    s.transport.requests.every(
      (request) =>
        request.headers.Authorization &&
        new URL(request.url).pathname.startsWith('/v2/community/'),
    ),
  );
  assert.equal(
    new URL(s.transport.requests[0]!.url).searchParams.get('viewSpaceId'),
    spaceId,
  );
  assert.equal(
    new URL(s.transport.requests[1]!.url).searchParams.get('sort'),
    'time',
  );
  assert.equal(
    new URL(s.transport.requests[1]!.url).searchParams.get('previewLimit'),
    '5',
  );
  assert.equal(
    new URL(s.transport.requests[3]!.url).searchParams.get('limit'),
    '7',
  );
  assert.equal(
    new URL(s.transport.requests[5]!.url).searchParams.get('replyId'),
    replyId,
  );
  assert.equal(s.readingRuntime.sessions, s.runtime.sessions);
  assert.equal(s.readingRuntime.pending, s.runtime.pending);
  assert.equal(s.readingRuntime.privateViews, s.runtime.privateViews);
});
test('source denial is terminal and never retried through v1 or legacy cached content', async () => {
  const s = http(),
    views: DetailView[] = [];
  const controller = new DetailController(s.readingRuntime, postId, (v) =>
    views.push(v),
  );
  s.transport.reply(pd());
  s.transport.reply(cp());
  await controller.load();
  assert.equal(
    views[views.length - 1]?.post?.readingBody?.classification,
    'reviewedSource',
  );
  s.transport.reply(
    { error: { code: 'COMMUNITY_UNAVAILABLE', message: 'unavailable' } },
    503,
  );
  await controller.load();
  assert.equal(views[views.length - 1]?.post, null);
  assert.deepEqual(views[views.length - 1]?.comments, []);
  assert.equal(s.transport.requests.length, 3);
  assert.ok(
    s.transport.requests.every((v) =>
      new URL(v.url).pathname.startsWith('/v2/'),
    ),
  );
  controller.dispose();
});
test('optional malformed plan falls back only within the same valid authorized source, hash failure clears the page', async () => {
  const s = http(),
    views: DetailView[] = [],
    controller = new DetailController(s.readingRuntime, postId, (v) =>
      views.push(v),
    );
  const value = pd();
  s.transport.reply({
    ...value,
    body: {
      ...value.body,
      value: {
        ...value.body.value,
        presentation: { status: 'formatted', plan: { text: 'injected' } },
      },
    },
  });
  s.transport.reply(cp());
  await controller.load();
  const body = views[views.length - 1]?.post?.readingBody;
  assert.equal(body?.classification, 'reviewedSource');
  if (body?.classification !== 'reviewedSource')
    throw new Error('source absent');
  assert.equal(body.value.presentation.status, 'source');
  assert.equal(body.value.source.text, p.text);
  s.transport.reply({
    ...value,
    body: {
      ...value.body,
      value: {
        ...value.body.value,
        source: { ...value.body.value.source, text: 'tampered' },
      },
    },
  });
  await controller.load();
  assert.equal(views[views.length - 1]?.post, null);
  assert.equal(s.transport.requests.length, 3);
  controller.dispose();
});
test('account switch and root hide clear source/plan/author state and late real gateway responses cannot repopulate', async () => {
  for (const hide of [false, true]) {
    const s = http(),
      views: DetailView[] = [],
      controller = new DetailController(s.readingRuntime, postId, (v) =>
        views.push(v),
      );
    s.transport.reply(pd());
    s.transport.reply(cp());
    await controller.load();
    const late = deferred<ReturnType<typeof response>>();
    s.transport.steps.push(() => late.promise);
    const work = controller.load();
    await flush();
    if (hide) s.runtime.privateViews!.clear();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: otherId,
      });
    assert.equal(views[views.length - 1]?.post, null);
    assert.deepEqual(views[views.length - 1]?.comments, []);
    late.resolve(response(pd()));
    await work;
    assert.equal(views[views.length - 1]?.post, null);
    assert.equal(s.transport.requests.length, 3);
    assert.equal(
      JSON.stringify(views[views.length - 1]).includes(p.text),
      false,
    );
    controller.dispose();
  }
});
test('thread source/preview/context retains original ancestry and anonymous-parent privacy guards', async () => {
  const s = http(),
    views: ThreadView[] = [],
    controller = new ThreadController(
      s.readingRuntime,
      postId,
      commentId,
      replyId,
      (v) => views.push(v),
    );
  for (const value of [pd(), cd(), rp(), ctx()]) s.transport.reply(value);
  await controller.load();
  assert.equal(
    views[views.length - 1]?.root?.readingBody?.classification,
    'reviewedSource',
  );
  assert.equal(
    views[views.length - 1]?.replies[0]?.readingBody?.classification,
    'reviewedSource',
  );
  const named = {
    ...p,
    author: {
      kind: 'named',
      profileId: otherId,
      displayName: 'Named',
      avatar: null,
      experienceDisplay: publicExperienceDisplay(),
    },
  };
  for (const value of [{ ...pd(), content: named }, cd(), rp(), ctx()])
    s.transport.reply(value);
  await controller.load();
  assert.equal(views[views.length - 1]?.post, null);
  assert.equal(views[views.length - 1]?.root, null);
  assert.deepEqual(views[views.length - 1]?.replies, []);
  controller.dispose();
});
test('main gateway has no feature read/renderer import and detail/thread select the actual feature facade', () => {
  const shared = readFileSync(
    path.join(__dirname, '../src/community/gateway.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    shared,
    /from ['"].*(?:reading-gateway|reading-contract|text-source-read-contract|text-source-renderer)['"]/,
  );
  for (const page of ['community-detail', 'community-thread']) {
    const script = readFileSync(
      path.join(__dirname, `../src/pages/${page}/${page}.ts`),
      'utf8',
    );
    const template = readFileSync(
      path.join(__dirname, `../src/pages/${page}/${page}.wxml`),
      'utf8',
    );
    assert.match(script, /withReadingSources\(existingRuntime,/);
    assert.match(template, /readingBody\.classification === 'reviewedSource'/);
    assert.match(template, /wu-source-text/);
  }
});
