import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  MeContentController,
  filterMeContent,
  type MeContentCard,
} from '../src/pages/me/controller';
import {
  discoverySetup,
  likedItem,
  likedList,
  namedPost,
  profileList,
  publicProfile,
} from './discovery-helpers';
import { attachment } from './support/media-read-fixtures';
import { post } from './community-helpers';

test('Me thumbnails retain only descriptors of authorized named own posts, not anonymous history', async () => {
  const s = discoverySetup();
  s.behavior.profile = async () => publicProfile({ isOwn: true });
  const own = { ...namedPost(), images: [attachment] };
  s.behavior.list = async () =>
    profileList({ items: [own, post({ images: [attachment] })] });
  const controller = new MeContentController(s.runtime, () => undefined);
  await controller.load();
  assert.equal(controller.snapshot().items.length, 1);
  assert.deepEqual(controller.snapshot().items[0]!.images, [attachment]);
  controller.dispose();
  assert.equal(controller.snapshot().items.length, 0);
});

test('private liked descriptors stay in their own tab and are revoked on tab switch', async () => {
  const s = discoverySetup();
  const item = likedItem();
  s.behavior.liked = async () =>
    likedList({
      items: [{ ...item, preview: { ...item.preview, images: [attachment] } }],
    });
  s.behavior.profile = async () => publicProfile({ isOwn: true });
  s.behavior.list = async () => profileList({ items: [] });
  const controller = new MeContentController(s.runtime, () => undefined);
  await controller.setTab('liked');
  assert.deepEqual(controller.snapshot().items[0]!.images, [attachment]);
  const switching = controller.setTab('posts');
  assert.equal(controller.snapshot().items.length, 0);
  await switching;
  assert.equal(controller.snapshot().items.length, 0);
  controller.dispose();
});

test('Me native thumbnail markup preserves aspect boxes and error identity; lifecycle waits for committed rendering', () => {
  const root = path.join(__dirname, '../src/pages/me');
  const markup = readFileSync(path.join(root, 'me.wxml'), 'utf8');
  const script = readFileSync(path.join(root, 'me.ts'), 'utf8');
  assert.match(markup, /id="view-{{item.id}}"/);
  assert.match(markup, /class="content-thumbnail-box" style="padding-top:/);
  assert.match(markup, /mode="aspectFit"/);
  assert.match(markup, /data-view-id="{{contentImages\[item.id\].viewId}}"/);
  assert.match(
    script,
    /this\.setData\(\{ content, visibleContentItems \}, committed\)/,
  );
  assert.match(script, /content\.availability === 'available'/);
  assert.match(script, /`me:\$\{content.tab\}:\$\{content.mode\}`/);
  assert.match(script, /this\.contentThumbnails\?\.dispose\(\)/);
  assert.doesNotMatch(script, /wx\.downloadFile|wx\.previewImage/);
});

test('profile search filters only already loaded cards and preserves authorized descriptor identity', () => {
  const card: MeContentCard = {
    id: 'one',
    text: 'Campus library',
    author: '示例同学',
    context: '日常',
    imageCount: 1,
    images: [attachment],
    kind: 'post',
    likeCount: null,
    url: '#',
  };
  const items = [card];
  assert.equal(filterMeContent(items, '  '), items);
  assert.deepEqual(filterMeContent(items, 'LIBRARY'), [card]);
  assert.deepEqual(filterMeContent(items, '示例'), [card]);
  assert.deepEqual(filterMeContent(items, '不存在'), []);
  assert.equal(filterMeContent(items, 'campus')[0]!.images, card.images);
  assert.equal(items.length, 1);
});
