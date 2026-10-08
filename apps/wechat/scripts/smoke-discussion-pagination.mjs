import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Real emitted page handlers and gateway decoders, using only synthetic local data.
export async function smokeDiscussionPagination({
  app,
  dist,
  mountPage,
  flush,
  postWire,
  rootWire,
  replyWire,
  accountId,
}) {
  const { HttpCommunityGateway } = require(
    path.join(dist, 'community/gateway.js'),
  );
  const { ClientError } = require(path.join(dist, 'api/errors.js'));
  const originalGateway = app.community.gateway;
  const postId = postWire().id;
  const rootId = rootWire().id;
  const replyId = replyWire().id;
  const extraReplyId = '34343434-3434-4434-8434-343434343434';
  const draftKey = `reply:${postId}:${rootId}:${replyId}`;
  const originalDraft = app.community.drafts.load(accountId, draftKey);
  const draft = {
    version: 1,
    text: 'unsent original-target draft',
    authorMode: 'anonymous',
    commentsPolicy: 'open',
  };
  app.community.drafts.save(accountId, draftKey, draft);
  let fresh = false;
  let restart = false;
  let deferPage = false;
  let finishPage;
  let pageCancellation;
  let contexts = 0;
  const reads = [];
  const currentReply = () => ({
    ...replyWire(),
    text: fresh ? 'fresh reply' : 'old reply',
  });
  const firstRoots = () =>
    Array.from({ length: 10 }, (_, index) => ({
      ...rootWire(),
      id: index
        ? `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
        : rootId,
      text: fresh ? `fresh root ${index}` : `old root ${index}`,
      replyCount: index ? 0 : 3,
      replyPreview: {
        items: index ? [] : [currentReply()],
        nextCursor: index ? null : 'reply-preview',
      },
    }));
  const secondRoots = () => [
    {
      ...rootWire(),
      id: '45454545-4545-4545-8545-454545454545',
      replyCount: 0,
      replyPreview: { items: [], nextCursor: null },
    },
  ];
  app.community.gateway = new HttpCommunityGateway({
    async request(endpoint, options) {
      assert.equal(
        endpoint.method,
        'GET',
        'Pagination must never send mutations',
      );
      const route = endpoint.path;
      if (route === `/v1/community/posts/${postId}`)
        return endpoint.decode({
          ...postWire(),
          component: { kind: 'none' },
          commentCount: 11,
          replyCount: 3,
          discussionCount: 14,
        });
      if (route === `/v1/community/posts/${postId}/comments`) {
        const after = options.query.cursor ?? null;
        reads.push({
          after,
          sort: options.query.sort,
          order: options.query.order,
        });
        assert.equal(options.query.limit, 10);
        assert.equal(options.query.previewLimit, 2);
        if (restart && after)
          throw new ClientError('http', 'safe', {
            httpStatus: 409,
            serverCode: 'DISCUSSION_RESTART_REQUIRED',
          });
        const result = {
          items: after ? secondRoots() : firstRoots(),
          nextCursor: after
            ? null
            : fresh
              ? 'root-next-fresh'
              : 'root-next-old',
        };
        if (deferPage && after) {
          pageCancellation = options.cancellation;
          return new Promise((resolve) => {
            finishPage = () => resolve(endpoint.decode(result));
          });
        }
        return endpoint.decode(result);
      }
      if (route === `/v1/community/comments/${rootId}/replies`) {
        assert.equal(options.query.cursor, 'reply-preview');
        return endpoint.decode({
          items: [{ ...replyWire(), id: extraReplyId }],
          nextCursor: null,
        });
      }
      if (route === `/v1/community/posts/${postId}/discussion-context`) {
        assert.deepEqual(options.query, { replyId });
        contexts++;
        return endpoint.decode({
          comment: { ...rootWire(), text: `located context ${contexts}` },
          reply: currentReply(),
          replies: {
            items: [currentReply()],
            nextCursor: 'independent-context',
          },
        });
      }
      if (route === `/v1/community/posts/${postId}/update-preferences`)
        return endpoint.decode({
          postId,
          savedUpdatesEnabled: true,
          externalUpdatesEnabled: false,
          revision: '0',
          canSetPreference: true,
          reason: null,
          inAppCapability: 'local',
          inAppProcessing: 'manual_only',
          externalCapability: 'unavailable',
        });
      throw new Error(`Unexpected pagination route: ${route}`);
    },
  });
  let page;
  try {
    page = mountPage(
      path.join(dist, 'pages/community-detail/community-detail.js'),
      { postId, replyId },
    );
    await flush();
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.comments.length, 10);
    assert.equal(page.data.pageNumber, 1);
    assert.equal(page.data.canPrevious, false);
    assert.equal(page.data.locatedReplyId, replyId);
    page.onMoreReplies({ currentTarget: { dataset: { id: rootId } } });
    await flush();
    assert.equal(page.data.comments[0].replyPreview.items.length, 2);

    deferPage = true;
    page.onMore();
    page.onMore();
    page.onPrevious();
    assert.deepEqual(page.data.comments, []);
    assert.equal(page.data.locatedComment, null);
    await flush();
    assert.equal(reads.length, 2);
    finishPage();
    await flush();
    assert.equal(page.data.comments.length, 1);
    assert.equal(page.data.comments[0].id, secondRoots()[0].id);
    assert.equal(page.data.pageNumber, 2);
    assert.equal(page.data.canPrevious, true);
    assert.equal(page.data.locatedComment.text, 'located context 2');

    fresh = true;
    deferPage = false;
    page.onPrevious();
    assert.deepEqual(page.data.comments, []);
    await flush();
    assert.equal(page.data.comments.length, 10);
    assert.equal(page.data.comments[0].text, 'fresh root 0');
    assert.equal(page.data.comments[0].replyPreview.items.length, 1);
    assert.equal(
      page.data.comments[0].replyPreview.items[0].text,
      'fresh reply',
    );
    assert.equal(page.data.locatedComment.text, 'located context 3');
    page.onMore();
    await flush();
    assert.deepEqual(
      reads.map((read) => read.after),
      [null, 'root-next-old', null, 'root-next-fresh'],
    );
    page.onOrder({
      currentTarget: { dataset: { sort: 'likes', order: 'asc' } },
    });
    await flush();
    assert.equal(page.data.pageNumber, 1);
    assert.equal(page.data.canPrevious, false);
    assert.deepEqual(reads.at(-1), {
      after: null,
      sort: 'likes',
      order: 'asc',
    });

    restart = true;
    page.onMore();
    await flush();
    assert.equal(page.data.loaded, false);
    assert.equal(page.data.post, null);
    assert.deepEqual(page.data.comments, []);
    assert.equal(page.data.locatedComment, null);
    assert.equal(page.data.canPrevious, false);
    assert.match(page.data.error, /重新加载/);
    const count = reads.length;
    page.onPrevious();
    page.onMore();
    await flush();
    assert.equal(reads.length, count);
    restart = false;
    page.onReload();
    await flush();
    assert.equal(page.data.pageNumber, 1);
    deferPage = true;
    page.onMore();
    await flush();
    page.onCancel();
    assert.equal(pageCancellation.isCancelled, true);
    finishPage();
    await flush();
    assert.equal(page.data.loaded, false);
    assert.deepEqual(page.data.comments, []);
    assert.equal(page.data.pageNumber, 0);
    assert.equal(page.data.canPrevious, false);
    assert.deepEqual(app.community.drafts.load(accountId, draftKey), draft);
    const template = readFileSync(
      path.join(dist, 'pages/community-detail/community-detail.wxml'),
      'utf8',
    );
    assert.match(template, /bindtap="onPrevious"[^>]*>上一页/);
    assert.match(template, /bindtap="onMore"[^>]*>下一页/);
    assert.match(template, /pageNumber/);
    assert.match(template, /copyCommentId=\{\{item.id\}\}/);
    assert.match(template, /rootCommentId=\{\{item.id\}\}/);
  } finally {
    page?.onUnload();
    app.community.gateway = originalGateway;
    if (originalDraft)
      app.community.drafts.save(accountId, draftKey, originalDraft);
    else app.community.drafts.clear(accountId, draftKey);
  }
}
