import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { splitFeedColumns } from '../src/pages/community-feed/waterfall';
import { post } from './community-helpers';

const source = (extension: string) =>
  readFileSync(
    join(__dirname, `../src/pages/community-feed/community-feed.${extension}`),
    'utf8',
  );

test('waterfall keeps every real post exactly once with stable append order and object identity', () => {
  const posts = Object.freeze(
    Array.from({ length: 7 }, (_, index) =>
      Object.freeze(post({ id: `post-${index}` })),
    ),
  );
  const [left, right] = splitFeedColumns(posts);
  assert.deepEqual(
    left.map((item) => item.id),
    ['post-0', 'post-2', 'post-4', 'post-6'],
  );
  assert.deepEqual(
    right.map((item) => item.id),
    ['post-1', 'post-3', 'post-5'],
  );
  assert.equal(new Set([...left, ...right]).size, posts.length);
  assert.equal(left[1], posts[2]);
  assert.equal(right[0], posts[1]);
  assert.deepEqual(splitFeedColumns(posts.slice(0, 4)), [
    left.slice(0, 2),
    right.slice(0, 2),
  ]);
  assert.deepEqual(splitFeedColumns([]), [[], []]);
  assert.deepEqual(splitFeedColumns([posts[0]!]), [[posts[0]], []]);
});

test('Home renders one source template in two independent columns without invented media', () => {
  const template = source('wxml');
  const style = source('wxss');
  assert.equal((template.match(/class="waterfall-column"/g) ?? []).length, 2);
  for (const column of [0, 1]) {
    assert.ok(template.includes(`wx:for="{{postColumns[${column}]}}"`));
  }
  assert.equal(
    (template.match(/<template name="waterfall-post">/g) ?? []).length,
    1,
  );
  assert.equal(
    (template.match(/<template is="waterfall-post"/g) ?? []).length,
    2,
  );
  assert.equal(
    (template.match(/id="view-\{\{item.id\}\}"/g) ?? []).length,
    1,
    'the actual post id remains the viewport-observer target',
  );
  assert.match(style, /\.feed-waterfall\s*\{[^}]*align-items: flex-start;/);
  assert.match(style, /\.waterfall-column\s*\{[^}]*flex-direction: column;/);
  assert.match(template, /\{\{item\.text\}\}/);
  assert.match(template, /图片需授权读取，进入帖子查看/);
  assert.doesNotMatch(template, /https?:\/\/|unsplash/i);
  assert.match(template, /src="\{\{feedImages\[item.id\].localSrc\}\}"/);
  assert.match(template, /mode="aspectFit"/);
  assert.match(template, /binderror="onFeedImageError"/);
  assert.match(
    template,
    /item.images\[0\].height \/ item.images\[0\].width \* 100/,
  );
  assert.match(
    template,
    /wx:if="\{\{item.images.length\}\}" class="post-thumbnail-box"/,
  );
  assert.doesNotMatch(template, /class="home-title"|class="feed-heading"/);
});

test('Home waterfall keeps native identity-safe handlers, source gating, and pin suppression', () => {
  const template = source('wxml');
  const script = source('ts');
  assert.match(
    template,
    /homeTab !== 'following' \|\| hasSession &amp;&amp; followingAvailable/,
  );
  assert.match(
    template,
    /homeTab === 'following' &amp;&amp; following &amp;&amp; space \|\| !following &amp;&amp; space/,
  );
  assert.match(
    template,
    /<template wx:if="\{\{!following\}\}" is="scoped-post-pin"/,
  );
  assert.match(script, /postColumns: splitFeedColumns\(posts\)/);
  assert.match(script, /posts\.map\(\(post\) => post\.id\)/);
  assert.match(
    template,
    /item.author.kind === 'named'[\s\S]*bindtap="onAuthorAvatar"/,
  );
  assert.match(
    template,
    /<view wx:else class="post-avatar anonymous-avatar"[^>]*><wu-icon name="shield"/,
  );
  for (const handler of [
    'onAuthor',
    'onAuthorAvatar',
    'onPostMenu',
    'onReportPost',
    'onBlockPost',
    'onRatingTargetLink',
    'onToggleHomeMenu',
    'onToggleCampusPicker',
    'onToggleReadingNotes',
    'onRefresh',
  ]) {
    assert.ok(template.includes(`bindtap="${handler}"`), handler);
    assert.ok(script.includes(`${handler}(`), handler);
  }
  assert.match(template, /class="post-footer"[\s\S]*name="heart"/);
  assert.match(template, /name="bookmark"[\s\S]*\{\{item.saveCount\}\}/);
  assert.match(template, /class="post-menu"[\s\S]*report-progress/);
  assert.match(
    template,
    /postId=\{\{item.id\}\}&amp;viewSpaceId=\{\{space.id\}\}/,
  );
});
