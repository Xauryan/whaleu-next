import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = (page: string, extension: string) =>
  readFileSync(
    path.join(__dirname, `../src/pages/${page}/${page}.${extension}`),
    'utf8',
  );

test('Me uses the supplied profile geometry, original dark cover, native safe top and honest loaded-content search', () => {
  const template = source('me', 'wxml');
  const styles = source('me', 'wxss');
  const configuration = JSON.parse(source('me', 'json')) as {
    navigationStyle: string;
    usingComponents: Record<string, string>;
  };
  const header = template.slice(0, template.indexOf('class="profile-content"'));
  assert.equal(configuration.navigationStyle, 'custom');
  assert.equal(
    configuration.usingComponents['wu-safe-top'],
    '../../components/safe-top/safe-top',
  );
  assert.match(header, /<wu-safe-top \/>/);
  assert.match(header, /class="edit-profile-pill"/);
  assert.match(header, /<text>编辑主页<\/text>/);
  assert.ok(
    header.indexOf('class="profile-social-summary"') <
      header.indexOf('class="profile-bio"'),
  );
  assert.ok(
    header.indexOf('class="profile-bio"') <
      header.indexOf('class="profile-detail-tags"'),
  );
  assert.equal(header.match(/class="shortcut"/g)?.length, 3);
  assert.match(styles, /linear-gradient\(145deg, #25282a/);
  assert.doesNotMatch(header, /https?:|background-image|\.jpe?g|\.webp/);
  assert.match(template, /name="lock"/);
  assert.match(template, /contentSearchOpen/);
  assert.match(template, /bindtap="onContentSearchToggle"/);
  assert.match(template, /bindinput="onContentSearchInput"/);
  assert.match(template, /仅搜索当前已加载的内容，不包含未加载的历史/);
});

test('profile editor prioritizes safe avatar and genuine grouped fields while retaining secondary recovery controls and theme tokens', () => {
  const template = source('profile', 'wxml');
  const styles = source('profile', 'wxss');
  const script = source('profile', 'ts');
  assert.match(template, /class="editor-avatar-stage"/);
  assert.match(template, /name="camera"/);
  assert.match(template, /src="{{avatarRead\.localSrc}}"/);
  assert.match(template, /class="editor-field-row"/);
  assert.match(template, /schoolUidView\.schoolUid\.formattedUid/);
  assert.ok(
    template.indexOf('class="editor-avatar-stage"') <
      template.indexOf('class="card editor-fields"'),
  );
  assert.doesNotMatch(template, /使用偏好|账户与更多功能|editor-more-tools/);
  assert.match(source('settings', 'wxml'), /onSavePreferences/);
  assert.match(source('account-menu', 'ts'), /系统设置/);
  assert.match(template, /默认仅自己可见/);
  assert.match(template, /不收集生日/);
  assert.doesNotMatch(template, /type="date"|bindchange="onBirthday/);
  assert.match(template, /url="\/pages\/public-profile\/public-profile"/);
  assert.match(
    template,
    /!profileDirty &amp;&amp; !preferencesDirty &amp;&amp; !details\.dirty/,
  );
  for (const handler of [
    'onChooseCustomAvatar',
    'onSaveAvatar',
    'onRecoverAvatar',
    'onRetryAvatar',
    'onCancelAvatarCommand',
    'onSaveProfile',
    'onSaveDetails',
    'onDetailsVisibility',
    'onReloadDetails',
    'onToggleAvatarTools',
  ]) {
    assert.ok(template.includes(`="${handler}"`), handler);
    assert.ok(script.includes(`${handler}(`), handler);
  }
  assert.match(styles, /framework7-profile-verification\.wxss/);
  assert.match(styles, /background: var\(--f7-list-strong-bg-color/);
  assert.match(styles, /color: var\(--f7-text-color/);
  assert.doesNotMatch(template, /https?:|\.jpe?g|\.webp|id="birthday"/);
});

test('profile cleanup keeps actual bio, quiet unavailable stats, bounded menu icons and requested destinations', () => {
  const me = source('me', 'wxml');
  const header = me.slice(0, me.indexOf('class="profile-content"'));
  assert.match(header, /profile\.loaded &amp;&amp; profile\.bio/);
  assert.match(header, /class="profile-bio">{{profile\.bio}}/);
  assert.match(header, /填写简介/);
  assert.doesNotMatch(
    header,
    /校内 UID|仅统计当前可见关系|— 表示暂不可用|把校园里的小事/,
  );
  for (const route of ['browsing-history', 'verification', 'wallet'])
    assert.ok(header.includes(`/pages/${route}/${route}`));
  assert.match(header, /src="{{coverRead\.localSrc}}"/);
  assert.match(header, /binderror="onCoverError"/);
  assert.doesNotMatch(me, /name="{{item\.icon}}"/);
  for (const icon of [
    'post',
    'bag',
    'chart',
    'settings',
    'graduation',
    'campus',
    'shield',
    'blocked-user',
    'message',
  ])
    assert.ok(me.includes(`item.icon === '${icon}' ? '${icon}'`));
  const editor = source('profile', 'wxml');
  assert.match(editor, /bind:press="onToggleCoverTools"/);
  assert.ok(editor.includes("coverRead.status === 'none' ? '未设置'"));
  assert.match(editor, /wx:if="{{cover\.uploadAvailable}}"/);
  assert.match(editor, /bind:press="onChooseCover"/);
  assert.match(editor, /bind:press="onSaveCover"/);
  assert.match(editor, /保存后会显示在公开主页/);
});

test('three separate demographic capsules preserve the region pin and opted-in gender icons without private annotations', () => {
  const template = source('me', 'wxml');
  const header = template.slice(0, template.indexOf('class="profile-content"'));
  assert.equal(header.match(/class="profile-detail-capsule"/g)?.length, 3);
  assert.match(
    header,
    /details\.showRegion &amp;&amp; details\.region}}" class="profile-detail-capsule"><wu-icon name="location"/,
  );
  const publicMarkup = source('public-profile', 'wxml');
  assert.equal(publicMarkup.match(/class="profile-metadata-chip"/g)?.length, 3);
  assert.match(
    publicMarkup,
    /publicDetails\.details\.region !== null}}" class="profile-metadata-chip">\s*<wu-icon name="location"/,
  );
  assert.doesNotMatch(
    publicMarkup,
    /class="profile-metadata profile-detail-capsule"/,
  );
  assert.match(header, /details\.showRegion &amp;&amp; details\.region/);
  assert.match(header, /details\.showAge &amp;&amp; details\.age !== null/);
  assert.match(header, /details\.showGender &amp;&amp; details\.gender/);
  assert.ok(header.includes("details.gender === 'male' ? 'blue' : 'pink'"));
  assert.ok(header.includes("details.gender === 'male' ? 'male' : 'female'"));
  assert.doesNotMatch(header, /仅自己|detail-private/);
  const editor = source('profile', 'wxml');
  assert.doesNotMatch(editor, /gender === 'other'/);
});
