import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { normalizeFramework7ActionNode } from './framework7-action-parity';

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: (Node | string)[];
}
interface Action {
  event: string;
  action: string;
  dataset: Record<string, string>;
  guards: string[];
}
const requireNative = createRequire(__filename);
const { parsePreviewWxml } = requireNative('../scripts/preview-wxml.mjs') as {
  parsePreviewWxml(source: string): Node;
};
const root = path.join(__dirname, '../src/pages');
const before = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/discovery-actions-before.json'),
    'utf8',
  ),
) as Record<string, Action[]>;
const read = (page: string, extension = 'wxml') =>
  readFileSync(path.join(root, page, `${page}.${extension}`), 'utf8');
function actions(source: string): Action[] {
  const result: Action[] = [];
  function walk(nodes: (Node | string)[], parents: string[] = []) {
    for (let node of nodes) {
      if (typeof node === 'string') continue;
      node = normalizeFramework7ActionNode(node);
      const guards = [
        ...parents,
        ...Object.entries(node.attrs)
          .filter(([key]) =>
            [
              'wx:if',
              'wx:elif',
              'wx:else',
              'wx:for',
              'wx:for-item',
              'wx:for-index',
              'wx:key',
              'disabled',
            ].includes(key),
          )
          .map(([key, value]) => `${key}:${value}`),
      ];
      const events = Object.entries(node.attrs).filter(
        ([key]) => key.startsWith('bind') || key.startsWith('catch'),
      );
      if (node.tag === 'navigator')
        events.push([
          'navigate',
          node.attrs.url ?? `open:${node.attrs['open-type']}`,
        ]);
      for (const [event, action] of events) {
        result.push({
          event,
          action,
          dataset: Object.fromEntries(
            Object.entries(node.attrs).filter(([key]) =>
              key.startsWith('data-'),
            ),
          ),
          guards,
        });
      }
      walk(
        node.children,
        guards.filter((guard) => !guard.startsWith('disabled:')),
      );
    }
  }
  walk(parsePreviewWxml(source).children);
  return result;
}
for (const [page, baseline] of Object.entries(before)) {
  test(`${page}: every pre-redesign action retains datasets and ancestor/disabled guards`, () => {
    const current = actions(read(page));
    for (const old of baseline) {
      const candidates = current.filter(
        (item) =>
          item.event === old.event &&
          item.action === old.action &&
          JSON.stringify(item.dataset) === JSON.stringify(old.dataset),
      );
      assert.ok(candidates.length, `${page}: missing ${old.action}`);
      assert.ok(
        candidates.some((item) =>
          old.guards.every((guard) => item.guards.includes(guard)),
        ),
        `${page}: weakened ${old.action} guards: ${old.guards.join(', ')}`,
      );
    }
  });
}
test('discovery pages register real native icons and use semantic theme materials without duplicate native titles', () => {
  for (const page of Object.keys(before)) {
    const source = read(page);
    const config = JSON.parse(read(page, 'json')) as {
      navigationBarTitleText: string;
      usingComponents: Record<string, string>;
    };
    assert.equal(
      config.usingComponents['wu-icon'],
      '../../components/icon/icon',
    );
    assert.ok(source.includes('<wu-icon'));
    assert.doesNotMatch(source, /<view class="(?:title|home-title)">/);
    assert.doesNotMatch(
      source,
      /{{item\.(?:createdAt|publishedAt|savedAt|likedAt)}}/,
    );
    assert.doesNotMatch(read(page, 'wxss'), /@import.*community-feed/);
    assert.match(
      readFileSync(path.join(root, 'community-search/discovery.wxss'), 'utf8'),
      /var\(--wu-surface\)/,
    );
    assert.match(
      readFileSync(path.join(root, 'community-search/discovery.wxss'), 'utf8'),
      /var\(--wu-text\)/,
    );
  }
});
test('search stays literal and scoped, and incomplete scans never become empty-result claims', () => {
  const source = read('community-search');
  assert.match(
    source,
    /wx:if="{{loaded &amp;&amp; !hits.length &amp;&amp; continuation === 'end'}}"/,
  );
  assert.match(source, /{{segment.text}}/);
  assert.match(
    source,
    /data-kind="{{item.kind}}" data-id="{{item.contentId}}" bind:press="onHit"/,
  );
  assert.doesNotMatch(source, /rich-text|[?&]q=/);
  assert.match(source, /输入尚未提交/);
  assert.match(source, /showFilters/);
  assert.match(source, /语义搜索返回有限的相关结果/);
});
test('collections keep independent recovery and private author boundaries, without inventing publication bodies', () => {
  const saved = read('community-saved');
  assert.match(saved, /is="saved-recovery"/);
  assert.match(
    saved,
    /wx:if="{{identityOverlay.developerEnabled}}" is="identity-overlay"/,
  );
  const mine = read('community-mine');
  assert.match(mine, /is="owner-post-visibility"/);
  const publications = mine
    .split('wx:for="{{publications}}"')[1]
    ?.split('wx:for="{{tradingPosts}}"')[0];
  assert.ok(publications);
  assert.doesNotMatch(publications, /item\.text|item\.images|item\.author/);
  assert.match(publications, /item\.ownerVisibility\.canChange/);
  assert.match(read('community-hot'), /id="view-{{item.id}}"/);
  assert.match(
    read('community-hot', 'ts'),
    /view\.loaded && view\.hasSession && !view\.busy/,
  );
  assert.doesNotMatch(
    read('community-hot'),
    /class="[^"\n]*(?:overlay|backdrop)/,
  );
});
test('local recovery and rating presentation preserves every original template action and gate', () => {
  for (const [original, local] of [
    ['community/saved-recovery.wxml', 'community-saved/saved-recovery.wxml'],
    ['community/rating-link-card.wxml', 'community-hot/rating-link-card.wxml'],
  ]) {
    assert.ok(original && local);
    const baseline = actions(
      readFileSync(path.join(root, '..', original), 'utf8'),
    );
    const current = actions(readFileSync(path.join(root, local), 'utf8'));
    for (const old of baseline)
      assert.ok(
        current.some(
          (item) =>
            item.event === old.event &&
            item.action === old.action &&
            JSON.stringify(item.dataset) === JSON.stringify(old.dataset) &&
            old.guards.every((guard) => item.guards.includes(guard)),
        ),
        `${local}: preserve ${old.action}`,
      );
  }
});
test('directory retains source-separated pagination, authoritative clipboard gating and current image controls', () => {
  const list = read('directory-list');
  assert.match(list, /{{entries}}/);
  assert.match(list, /{{nativeDirectory.items}}/);
  assert.match(
    list,
    /bind:press="onNativeMore" disabled="{{nativeDirectory.busy}}"/,
  );
  assert.match(list, /不合并计数/);
  const detail = read('directory-detail');
  assert.match(detail, /wx:if="{{loaded &amp;&amp; detail}}"/);
  assert.match(
    detail,
    /disabled="{{busy \|\| copyBusy \|\| !canCopy}}" loading="{{copyBusy}}" bind:press="onCopyQq"/,
  );
  assert.match(
    detail,
    /wx:if="{{nativeDetail.publicDetail.management.available}}"/,
  );
  assert.match(
    detail,
    /data-slot="{{item.slot}}" bind:press="onNativePreview"/,
  );
  assert.match(detail, /wx:if="{{nativeImage.src}}"/);
  assert.doesNotMatch(detail, /https?:\/\/|data:image|fake|placeholderQr/);
});
test('all discovery preview fixtures require content markers and contain only explicit synthetic data', () => {
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/discovery-preview.mjs',
  ) as {
    default: {
      id: string;
      page: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  assert.equal(new Set(fixtures.map((fixture) => fixture.page)).size, 8);
  assert.ok(fixtures.length >= 15);
  for (const fixture of fixtures) {
    assert.ok(fixture.expectedText.length >= 3);
    assert.doesNotMatch(
      JSON.stringify(fixture.patch),
      /https?:\/\/|accountId|accessToken|privateAuthor|providerId/,
    );
  }
});
