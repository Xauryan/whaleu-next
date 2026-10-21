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
    path.join(__dirname, 'fixtures/information-actions-before.json'),
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
test('information pages use original native icons, semantic material and content instead of duplicate hero titles', () => {
  for (const page of Object.keys(before)) {
    const source = read(page);
    const config = JSON.parse(read(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    assert.equal(
      config.usingComponents['wu-icon'],
      '../../components/icon/icon',
    );
    assert.match(source, /<wu-icon/);
    assert.doesNotMatch(source, /class="(?:title|eyebrow|hero|card)"|WHALEU/);
    assert.doesNotMatch(source, /https?:\/\/|data:image|rich-text/);
    assert.match(
      read(page, 'wxss'),
      page === 'school-services'
        ? /framework7-forms\.wxss/
        : /information-presentation\.wxss/,
    );
  }
  const styles = readFileSync(
    path.join(root, 'organizations/information-presentation.wxss'),
    'utf8',
  );
  assert.match(styles, /min-height: 88rpx/);
  assert.match(styles, /var\(--wu-surface\)/);
  assert.match(styles, /var\(--wu-text\)/);
  assert.match(styles, /var\(--wu-danger\)/);
});
test('organization editor retains current authority and original-key recovery separately from presentation disclosures', () => {
  const source = read('organization-editor');
  assert.match(source, /wx:if="{{pending}}"/);
  assert.ok(
    source.indexOf('class="save-actions"') <
      source.indexOf('class="media-section-heading"'),
  );
  assert.match(source, /wx:if="{{publicRead \|\| showMedia}}"/);
  assert.match(source, /wx:if="{{pendingImages.length}}"/);
  assert.match(source, /data-revision="{{item.applicationRevision}}"/);
  assert.match(source, /detail.permissions.edit &amp;&amp; !publicRead/);
  assert.match(source, /publicDetail.management.available/);
  assert.match(source, /detail.permissions.transferOwner/);
  assert.match(source, /旧所有者降为管理员/);
  assert.match(source, /内容版本 {{revision}} · 权限版本 {{authorityVersion}}/);
  assert.doesNotMatch(source, /managerContact.*(?:image|src)=/);
  const native = read('organization-editor', 'ts');
  assert.match(
    native,
    /this\.controller === controller && this\.uploader === uploader/,
  );
  assert.match(native, /this\.data\.slots\.some/);
  assert.match(native, /expandedMedia: \{\}/);
  assert.match(native, /this\.reader\?\.clear\(\)/);
  assert.match(native, /directoryScopeChanges\?\.subscribe/);
});
test('announcement list and detail preserve source, media and current-campus gates without acknowledging reads', () => {
  const list = read('announcements');
  assert.match(list, /data-source="native"/);
  assert.match(list, /data-source="accepted"/);
  assert.match(list, /历史资料不可用，不代表没有历史公告/);
  assert.match(list, /查看公告不会记录弹窗确认/);
  const detail = read('announcement-detail');
  assert.match(detail, /wx:if="{{loaded &amp;&amp; detail}}"/);
  assert.match(detail, /wx:if="{{detail.media.status === 'available'}}"/);
  assert.match(detail, /wx:if="{{detail.media.status === 'unavailable'}}"/);
  for (const page of ['announcements', 'announcement-detail']) {
    assert.doesNotMatch(
      read(page, 'ts'),
      /acknowledge|dismissPopup|onClosePopup/,
    );
    assert.match(read(page, 'ts'), /runtime\.browsingScopeChanges\.subscribe/);
    assert.match(read(page, 'ts'), /runtime\.safetyChanges\.subscribe/);
    assert.match(read(page, 'ts'), /showInfo: false/);
  }
  assert.match(
    read('announcement-detail', 'ts'),
    /this\.data\.detail\?\.revision !== view\.detail\?\.revision/,
  );
});
test('school service contacts stay explicit, disabled services cannot render actions and QR source remains controlled', () => {
  const source = read('school-services');
  assert.match(source, /item.state === 'unconfigured'/);
  assert.match(source, /item.state === 'disabled'/);
  assert.match(source, /<block wx:else>/);
  assert.match(
    source,
    /data-field="joinUrl" disabled="{{busy}}" bind:press="onCopy"/,
  );
  assert.match(source, /复制官方入群链接/);
  assert.doesNotMatch(source, /url="{{item\.data\.joinUrl}}"|web-view/);
  assert.match(source, /wx:if="{{qr.src}}" src="{{qr.src}}"/);
  assert.match(
    read('school-services', 'ts'),
    /this\.controller\?\.previewContext/,
  );
  assert.match(read('school-services', 'ts'), /this\.reader\?\.clear\(\)/);
  assert.match(source, /status !== '当前学校服务资料'/);
});
test('information preview fixtures cover every page plus unavailable/recovery states without external or private payloads', () => {
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/information-preview.mjs',
  ) as {
    default: {
      id: string;
      page: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  assert.equal(new Set(fixtures.map((fixture) => fixture.page)).size, 5);
  assert.equal(fixtures.length, 16);
  for (const fixture of fixtures) {
    assert.ok(fixture.expectedText.length >= 2);
    assert.doesNotMatch(
      JSON.stringify(fixture.patch),
      /https?:\/\/|accessToken|privateAuthor|providerId|accountId/,
    );
  }
  for (const page of Object.keys(before))
    assert.ok(
      fixtures.some(
        (fixture) =>
          fixture.page === page &&
          /recovery|retry|error|history/.test(fixture.id),
      ),
    );
});
interface PresentationPage {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  onToggleInfo(): void;
  onToggleMembers?(): void;
  onToggleMediaSection?(): void;
  onToggleMedia?(event: { currentTarget: { dataset: { slot: string } } }): void;
  onHide(): void;
  onUnload(): void;
  controller?: { dispose(): void };
  reader?: { dispose(): void };
  uploader?: { dispose(): void };
}
async function presentationPage(name: string): Promise<PresentationPage> {
  let definition: PresentationPage | undefined;
  const previous = globalThis.Page;
  globalThis.Page = ((value: PresentationPage) => {
    definition = value;
  }) as typeof Page;
  try {
    if (name === 'announcements')
      await import('../src/pages/announcements/announcements.js');
    else if (name === 'announcement-detail')
      await import('../src/pages/announcement-detail/announcement-detail.js');
    else if (name === 'organization-editor')
      await import('../src/pages/organization-editor/organization-editor.js');
    else await import('../src/pages/school-services/school-services.js');
  } finally {
    globalThis.Page = previous;
  }
  assert.ok(definition);
  const page: PresentationPage = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch) {
      this.data = { ...this.data, ...patch };
    },
  };
  return page;
}
test('page-local disclosures are reversible, reject nonexistent slots and reset on hide without a new service action', async () => {
  for (const name of [
    'announcements',
    'announcement-detail',
    'organization-editor',
    'school-services',
  ]) {
    const page = await presentationPage(name);
    const initialData = structuredClone(page.data);
    page.onToggleInfo();
    assert.equal(page.data.showInfo, true, name);
    page.onToggleInfo();
    assert.deepEqual(
      page.data,
      initialData,
      `${name}: reversible display-only toggle`,
    );
    page.onToggleInfo();
    if (name === 'organization-editor') {
      page.onToggleMediaSection!();
      assert.equal(page.data.showMedia, true);
      page.onToggleMembers!();
      assert.equal(page.data.showMembers, true);
      page.setData({ slots: [{ slot: 'avatar' }], expandedMedia: {} });
      page.onToggleMedia!({
        currentTarget: { dataset: { slot: 'missing-slot' } },
      });
      assert.deepEqual(page.data.expandedMedia, {});
      page.onToggleMedia!({ currentTarget: { dataset: { slot: 'avatar' } } });
      assert.deepEqual(page.data.expandedMedia, { avatar: true });
      page.onToggleMedia!({ currentTarget: { dataset: { slot: 'avatar' } } });
      assert.deepEqual(page.data.expandedMedia, { avatar: false });
    }
    let disposed = 0;
    page.controller = {
      dispose() {
        disposed++;
      },
    };
    page.onHide();
    assert.equal(disposed, 1, `${name}: existing disposal retained`);
    assert.equal(page.data.showInfo, false, `${name}: hide clears disclosure`);
    assert.equal(page.controller, undefined);
    if (name === 'organization-editor') {
      assert.equal(page.data.showMembers, false);
      assert.equal(page.data.showMedia, false);
      assert.deepEqual(page.data.expandedMedia, {});
      assert.deepEqual(page.data.pendingImages, []);
    }
    page.onUnload();
    assert.equal(disposed, 1, `${name}: repeated teardown is safe`);
  }
});
