import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { normalizeFramework7ActionNode } from './framework7-action-parity';
import { reviewedReferencePresentation } from './reviewed-reference-successor';

type Action = { tag: string; attrs: Record<string, string> };
const root = path.join(__dirname, '../src/pages');
const source = (page: string, extension = 'wxml') =>
  readFileSync(path.join(root, page, `${page}.${extension}`), 'utf8');
const inventory = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/core-product-action-inventory.json'),
    'utf8',
  ),
) as Record<string, Action[]>;
function actions(template: string): Action[] {
  return [...template.matchAll(/<([\w-]+)\b(?:"[^"]*"|'[^']*'|[^'">])*>/g)]
    .map((match) => ({
      tag: match[1]!,
      attrs: Object.fromEntries(
        [...match[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [
          a[1]!,
          a[2]!
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"'),
        ]),
      ),
    }))
    .filter(
      ({ tag, attrs }) =>
        tag === 'navigator' ||
        Object.keys(attrs).some((key) => /^(bind|catch)/.test(key)),
    );
}
for (const [page, original] of Object.entries(inventory)) {
  test(`${page} preserves every existing action, route, data binding and per-control safety gate`, () => {
    // Keep the original inventory. Only the authenticated community-detail
    // successor may inspect its sealed predecessor after proving the live delta.
    const current = actions(
      reviewedReferencePresentation(
        `src/pages/${page}/${page}.wxml`,
        source(page),
      ),
    ).map((action) =>
      [
        'campus-hub',
        'profile',
        'compose-entry',
        'community-compose',
        'community-detail',
        'community-thread',
      ].includes(page)
        ? normalizeFramework7ActionNode({ ...action, children: [] })
        : action,
    );
    for (const previous of original) {
      const index = current.findIndex(
        (candidate) =>
          candidate.tag === previous.tag &&
          Object.entries(previous.attrs).every(
            ([key, value]) => candidate.attrs[key] === value,
          ),
      );
      if (index !== -1) {
        current.splice(index, 1);
        continue;
      }
      // The user's later correction moves general settings out of profile editing.
      if (page === 'profile') {
        const event = previous.attrs.bindtap ?? previous.attrs.bindchange;
        if (event === 'onToggleMoreTools') {
          assert.doesNotMatch(source('profile'), /onToggleMoreTools/);
          continue;
        }
        if (event === 'onPreference' || event === 'onSavePreferences') {
          const relocated = actions(source('settings')).find(
            (candidate) =>
              candidate.attrs['bind:press'] === event ||
              candidate.attrs['bind:change'] === event,
          );
          assert.ok(relocated, event);
          assert.equal(
            relocated.tag,
            event === 'onPreference' ? 'wu-f7-toggle' : 'wu-f7-button',
          );
          for (const [key, value] of Object.entries(previous.attrs)) {
            const expected =
              key === 'disabled'
                ? value.replace(
                    / \|\| avatar\.(busy|canSave|needsRecovery)/g,
                    '',
                  )
                : value;
            const currentKey =
              key === 'bindtap'
                ? 'bind:press'
                : key === 'bindchange'
                  ? 'bind:change'
                  : key;
            assert.equal(
              relocated.attrs[currentKey],
              expected,
              `${event}: ${key}`,
            );
          }
          continue;
        }
        if (event === 'onCancelEdits') {
          assert.match(
            source('profile'),
            /wx:if="{{profileDirty}}" class="secondary" disabled="{{loading \|\| saving}}" bind:press="onCancelEdits"/,
          );
          assert.match(
            source('settings'),
            /wx:if="{{preferencesDirty}}" class="secondary" disabled="{{loading \|\| saving}}" bind:press="onCancelEdits"/,
          );
          continue;
        }
        if (previous.tag === 'navigator' && previous.attrs.url) {
          const url = previous.attrs.url;
          if (url === '/pages/public-profile/public-profile') {
            assert.match(
              source('profile'),
              /!profileDirty &amp;&amp; !preferencesDirty &amp;&amp; !details\.dirty/,
            );
            assert.ok(source('profile').includes(`url="${url}"`));
          } else {
            assert.ok(source('account-menu', 'ts').includes(`'${url}'`), url);
            assert.match(source('account-menu'), /url="{{item\.url}}"/);
          }
          continue;
        }
      }
      assert.fail(`${page}: missing ${JSON.stringify(previous)}`);
    }
  });
}

test('composer is a canvas with contextual options, one publish action and reachable request recovery', () => {
  const template = source('community-compose');
  assert.doesNotMatch(template, /WHALEU · 校园生活|值得记录的小事|准备好了吗/);
  assert.match(template, /class="writing-canvas"/);
  assert.equal(template.match(/bind:press="onSubmit"/g)?.length, 1);
  assert.match(template, /class="compose-submit-bar"/);
  for (const panel of ['identity', 'media', 'poll', 'formation', 'recovery'])
    assert.ok(template.includes(`data-panel="${panel}"`));
  assert.match(template, /uiPanel === 'recovery' \|\| frozen/);
  assert.match(template, /wx:if="{{blocker}}"/);
  assert.match(template, /wx:if="{{error}}"/);
  assert.match(
    source('community-compose', 'ts'),
    /this\.setData\(\{ uiPanel: '' \}\)/,
  );
});

test('reply and detail surfaces keep content flat, interactions docked and management contextual', () => {
  assert.match(source('community-detail'), /class="post-actions"/);
  assert.match(source('community-detail', 'wxss'), /position: fixed/);
  assert.match(
    source('community-thread'),
    /uiExpandedMenu === 'reply:' \+ reply\.id/,
  );
  assert.match(source('community-thread'), /viewSpaceQuery,uiExpandedMenu/);
  assert.match(source('community-thread'), /class="thread-reply-bar"/);
  assert.match(source('community-thread', 'ts'), /uiExpandedMenu: ''/);
  const detail = source('community-detail');
  for (const state of [
    'categoryManagement.confirming',
    'categoryManagement.frozen',
    'categoryManagement.receiptStatus',
    'ownerVisibility.confirming',
    'ownerVisibility.frozen',
    'ownerVisibility.receiptStatus',
    'postPin.confirming',
    'postPin.frozen',
    'postPin.receiptStatus',
  ])
    assert.ok(detail.includes(state));
});

test('editor uses grouped rows without losing privacy controls or exposing debug inventory', () => {
  const template = source('profile');
  assert.match(template, /class="card editor-bio-card"/);
  assert.match(template, /showDetailsVisibility \|\| details.dirty/);
  assert.doesNotMatch(
    template,
    /使用偏好|账户与更多功能|onSavePreferences|onToggleMoreTools/,
  );
  assert.match(source('settings'), /onSavePreferences/);
  assert.match(template, /cover\.busy \|\| cover\.error/);
  assert.match(template, /默认仅自己可见/);
  assert.match(template, /不收集生日/);
  assert.doesNotMatch(template, /真实 91 项|chooseAvatar 界面|新增回退能力/);
});

test('topic management disclosure safely handles initial nullable permission reads', () => {
  const toggle = actions(source('community-detail')).find(
    ({ attrs }) =>
      attrs['bind:press'] === 'onToggleMenu' &&
      attrs['data-menu'] === 'management',
  );
  assert.ok(toggle);
  const condition = toggle.attrs['wx:if']!;
  assert.match(
    condition,
    /categoryManagement\.management && categoryManagement\.management\.canChange/,
  );
  assert.match(condition, /postPin\.detail && \(postPin\.detail\.canPin/);
  const visible = new Function(
    'categoryManagement',
    'ownerVisibility',
    'postPin',
    `return Boolean(${condition.slice(2, -2)});`,
  ) as (category: object, owner: object, pin: object) => boolean;
  assert.equal(
    visible({ management: null }, { management: null }, { detail: null }),
    false,
  );
  assert.equal(visible({}, {}, {}), false);
  assert.equal(
    visible({ management: { canChange: true } }, {}, { detail: null }),
    true,
  );
  assert.equal(
    visible({ management: null }, {}, { detail: { canPin: true } }),
    true,
  );
  assert.equal(
    visible({ management: null }, {}, { detail: { canUnpin: true } }),
    true,
  );
  assert.equal(
    visible({ management: null }, { management: {} }, { detail: null }),
    true,
  );
});
