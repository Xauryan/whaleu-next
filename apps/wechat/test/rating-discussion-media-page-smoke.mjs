import { createRecoveryPressBridge } from './framework7-rating-recovery-native-harness.mjs';
/** Real emitted Page and repository WXML condition model; not device rendering. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, render } from '../scripts/smoke-ratings.mjs';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(
  process.env.WHALEU_WECHAT_DIST ?? path.join(root, 'dist'),
);
const extension = process.env.WHALEU_WECHAT_EXTENSION ?? 'js';
const oldPage = globalThis.Page;
let page;
globalThis.Page = (definition) => {
  page = definition;
};
try {
  require(
    path.join(
      dist,
      `pages/rating-discussion-media/rating-discussion-media.${extension}`,
    ),
  );
} finally {
  globalThis.Page = oldPage;
}
assert.ok(page);
const template = parse(
  readFileSync(
    path.join(
      dist,
      'pages/rating-discussion-media/rating-discussion-media.wxml',
    ),
    'utf8',
  ),
);
const flatten = (nodes) =>
  nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
const rendered = () => flatten(render(template.children, page.data));
const button = (handler) =>
  rendered().filter(
    (node) =>
      node.tag === 'wu-f7-button' && node.attrs['bind:press'] === handler,
  );
assert.equal(page.data.maximum, 9);
assert.equal(page.data.text, '');
assert.equal(button('onPublish').length, 0);
for (const maximum of [9, 3]) {
  page.data = {
    ...page.data,
    maximum,
    composerOpen: true,
    authorMode: 'named',
    authorModes: ['named'],
    text: '',
    editor: {
      ...page.data.editor,
      frozen: false,
      selected: Array.from({ length: maximum }, (_, ordinal) => ({
        memberId: `member-${ordinal}`,
        ready: true,
      })),
    },
  };
  assert.equal(button('onChoose')[0].attrs.disabled, 'true');
  assert.equal(
    button('onPublish')[0].attrs.disabled,
    'false',
    'a ready pure-image draft remains publishable',
  );
  assert.equal(button('onRemove').length, maximum);
  page.data = { ...page.data, editor: { ...page.data.editor, selected: [] } };
  assert.equal(
    button('onPublish')[0].attrs.disabled,
    'true',
    'empty body plus zero images cannot publish',
  );
  assert.equal(button('onChoose')[0].attrs.disabled, 'false');
}
page.data = {
  ...page.data,
  editor: {
    ...page.data.editor,
    frozen: true,
    selected: [{ memberId: 'original', ready: true }],
  },
};
for (const handler of ['onChoose', 'onPublish', 'onRemove', 'onMove'])
  assert.ok(
    button(handler).every((node) => node.attrs.disabled === 'true'),
    `${handler}: frozen original request`,
  );
page.data = {
  ...page.data,
  composerOpen: false,
  rows: [
    {
      id: 'root',
      body: '',
      author: 'Synthetic',
      imageCount: 9,
      reply: false,
      canReply: true,
    },
  ],
  likes: { root: { status: 'unavailable' } },
};
assert.equal(button('onImage').length, 1);
assert.equal(button('onThread').length, 1);
assert.equal(
  rendered().filter((node) => node.tag === 'image').length,
  0,
  'metadata never becomes a storage URL',
);
// Presentation delivery to the actual registered Page. These are bounded
// controller-delegate spies, not claims of an executed upload/business command.
const calls = [];
page.controller = {
  publish() {
    calls.push(['publish']);
  },
  reorder(id, direction) {
    calls.push(['reorder', id, direction]);
  },
  closeImage() {
    calls.push(['release']);
  },
};
page.data = {
  ...page.data,
  busy: false,
  composerOpen: true,
  authorMode: 'named',
  text: '',
  editor: {
    ...page.data.editor,
    frozen: false,
    selected: [{ memberId: 'original', ready: true }],
  },
};
const bridge = createRecoveryPressBridge({
  page,
  dist,
  extension,
  pageFile: path.join(
    dist,
    'pages/rating-discussion-media/rating-discussion-media',
  ),
});
const publish = bridge.capture('onPublish');
assert.equal(publish.press(), true);
const move = bridge.capture('onMove', { id: 'original', direction: '-1' });
assert.equal(move.press(), true);
assert.deepEqual(calls, [['publish'], ['reorder', 'original', -1]]);
page.data.editor.frozen = true;
assert.equal(publish.press(), false);
assert.equal(move.press(), false);
page.data.gallery = { open: true, localSrc: '', index: 0, count: 2 };
const release = bridge.capture('onCloseImage');
assert.equal(release.press(), true);
assert.deepEqual(calls.at(-1), ['release']);
bridge.lifecycle('hide');
assert.equal(release.press(), false);
bridge.disposeProjection();
let disposed = 0;
page.controller = {
  dispose() {
    disposed++;
  },
};
page.navigator = {
  dispose() {
    disposed++;
  },
};
page.onHide();
assert.equal(disposed, 2);
assert.equal(page.controller, undefined);
assert.equal(page.navigator, undefined);
page.route = { targetId: 'old' };
page.onUnload();
assert.deepEqual(page.route, {});
console.log(
  'Emitted Ratings discussion Page/WXML root9/reply3 pure-image and recovery controls passed',
);
