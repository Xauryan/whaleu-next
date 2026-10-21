import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = (page: string, extension: string) =>
  readFileSync(
    join(__dirname, `../src/pages/${page}/${page}.${extension}`),
    'utf8',
  );

test('feed and hot use the original icon component without typographic or CSS icon substitutes', () => {
  for (const page of ['community-feed', 'community-hot']) {
    const config = JSON.parse(source(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    assert.equal(
      config.usingComponents['wu-icon'],
      '../../components/icon/icon',
    );
    const template = source(page, 'wxml');
    assert.doesNotMatch(template, /[♡○…›⌄＋✓★☆−]|•••/);
    assert.doesNotMatch(
      template + source(page, 'wxss'),
      /search-symbol|location-dot|avatar-head|avatar-shoulders|comment-symbol|stat-symbol/,
    );
    for (const icon of ['person', 'heart', 'message', 'bookmark']) {
      assert.match(template, new RegExp(`<wu-icon name="${icon}"`));
    }
    assert.match(
      template,
      /name="bookmark" tone="\{\{item.viewer.isSaved \? 'accent' : 'default'\}\}"/,
    );
    for (const count of ['likeCount', 'saveCount']) {
      assert.match(template, new RegExp(`\\{\\{item\\.${count}\\}\\}`));
    }
    if (page === 'community-hot') {
      assert.match(
        template,
        /wx:if="\{\{item.images.length\}\}" class="media-unavailable"/,
      );
      assert.doesNotMatch(template, /<image[^>]+src="\{\{item.images/);
    }
    assert.match(template, /aria-label="\{\{item.likeCount\}\} 个赞"/);
    assert.match(
      template,
      /{{item.commentCount === null \? '—' : item.commentCount}}/,
    );
    assert.match(
      template,
      /aria-label="{{item.commentCount === null \? '回复数量暂不可用' : item.commentCount \+ ' 条根回复'}}"/,
    );
    assert.match(template, /图片暂不可用|图片需授权读取，进入帖子查看/);
  }
});

test('feed icon replacements retain conditional selection and identity-safe actions', () => {
  const template = source('community-feed', 'wxml');
  assert.match(template, /<text wx:if="\{\{!item.isActive\}\}"[^>]*>暂不可用/);
  assert.match(
    template,
    /name="\{\{campusId === item.id \? 'check' : 'chevron-right'\}\}"/,
  );
  assert.match(
    template,
    /<button wx:if="\{\{item.author.kind === 'named'\}\}"[^>]*aria-label="查看公开身份头像"[^>]*bindtap="onAuthorAvatar"[^>]*><wu-icon name="person"/,
  );
  assert.match(
    template,
    /<view wx:else class="post-avatar anonymous-avatar" aria-label="分身身份"><wu-icon name="shield"/,
  );
  assert.match(
    template,
    /aria-label="更多帖子操作"[^>]*bindtap="onPostMenu"><wu-icon name="more"/,
  );
});
