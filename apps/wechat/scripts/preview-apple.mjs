/** Browser approximation of repository WXML/WXSS, NOT WeChat/device acceptance.
 * Fixtures are explicit visual QA samples, never shipped runtime content. */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  parsePreviewWxml as parse,
  evaluatePreviewExpression as expression,
  evaluatePreviewAttribute,
} from './preview-wxml.mjs';
import {
  validateCorePreviewHtml,
  validateMenuPreviewHtml,
  validateProductPreviewHtml,
} from './validate-core-preview.mjs';
import sharp from 'sharp';
import { nativeComponentPreviewState } from './preview-native-component.mjs';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'src');
// Original geometric preview fixture only; never a runtime profile upload.
const coverFixture =
  'data:image/png;base64,' +
  (
    await sharp(path.join(root, 'scripts/fixtures/profile-cover.svg'))
      .png()
      .toBuffer()
  ).toString('base64');
// Batch fixtures are repository-owned synthetic data, never runtime defaults.
const batches = [];
for (const name of [
  'ratings',
  'private-chat',
  'campus-tools',
  'errands',
  'dining',
  'discovery',
  'auth',
  'activities',
  'information',
  'support',
  'notification-details',
  'personal-secondary',
  'moderation',
  'rating-management',
  'school-operations',
  'framework7',
  'framework7-forms',
  'framework7-identity',
  'framework7-overlays',
  'framework7-profile-verification',
  'framework7-campus-tools',
  'framework7-collections',
  'framework7-information',
  'framework7-notifications',
  'framework7-ratings',
  'framework7-private-chat',
  'framework7-composer',
  'framework7-dining',
  'framework7-courses',
  'framework7-personal',
  'framework7-activities',
  'framework7-errands',
  'framework7-support',
  'framework7-discussions',
  'framework7-rating-recovery',
  'framework7-school-operations',
  'framework7-moderation',
  'framework7-campus-menu',
  'personal-timetable',
]) {
  if (!process.argv.includes(`--batch=${name}`)) continue;
  const { default: fixtures } = await import(`./fixtures/${name}-preview.mjs`);
  if (!Array.isArray(fixtures) || fixtures.length === 0)
    throw new Error(`Empty preview fixture batch: ${name}`);
  for (const fixture of fixtures) {
    if (
      !/^[a-z][a-z0-9-]+$/.test(fixture.id) ||
      !/^[a-z][a-z0-9-]+$/.test(fixture.page) ||
      !fixture.patch ||
      typeof fixture.patch !== 'object' ||
      !Array.isArray(fixture.expectedText) ||
      fixture.expectedText.length === 0
    )
      throw new Error(`Invalid preview fixture in ${name}`);
    if (batches.some((item) => item.id === fixture.id))
      throw new Error(`Duplicate preview fixture: ${fixture.id}`);
    batches.push({ ...fixture, batch: name });
  }
}
const outputArgument = process.argv.find((value) =>
  value.startsWith('--output='),
);
const output = outputArgument
  ? path.resolve(outputArgument.slice('--output='.length))
  : path.join(root, 'preview');
mkdirSync(output, { recursive: true });
const escape = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;');

const interpolate = (text, scope) =>
  text.replace(/{{([\s\S]*?)}}/g, (_, exp) => expression(exp, scope) ?? '');
function parseFile(file, ancestors = []) {
  const resolved = path.resolve(file);
  if (!resolved.startsWith(source + path.sep) || ancestors.includes(resolved))
    throw new Error(`Unsafe or cyclic WXML include: ${resolved}`);
  const tree = parse(readFileSync(resolved, 'utf8'));
  const expand = (nodes) =>
    nodes.flatMap((node) => {
      if (typeof node === 'string') return [node];
      if (node.tag === 'include') {
        const included = parseFile(
          path.resolve(path.dirname(resolved), node.attrs.src),
          [...ancestors, resolved],
        );
        return included.children.filter(
          (child) =>
            typeof child === 'string' ||
            !['import', 'template', 'wxs'].includes(child.tag),
        );
      }
      return [{ ...node, children: expand(node.children) }];
    });
  return { ...tree, children: expand(tree.children) };
}
function templatesFor(file, collected = {}) {
  const tree = parseFile(file);
  for (const node of tree.children) {
    if (typeof node === 'string') continue;
    if (node.tag === 'import')
      templatesFor(path.resolve(path.dirname(file), node.attrs.src), collected);
    if (node.tag === 'template' && node.attrs.name)
      collected[node.attrs.name] = node.children;
  }
  return collected;
}
function render(nodes, scope, templates, slots = {}) {
  let result = '',
    matched = false;
  for (const node of nodes) {
    if (typeof node === 'string') {
      result += escape(interpolate(node, scope));
      continue;
    }
    const attrs = node.attrs;
    if (node.tag === 'import' || (node.tag === 'template' && attrs.name))
      continue;
    if (attrs['wx:for']) {
      const { ['wx:for']: loop, ...remaining } = attrs;
      const items = expression(loop.slice(2, -2), scope) ?? [];
      items.forEach((item, index) => {
        result += render(
          [{ ...node, attrs: remaining }],
          {
            ...scope,
            [attrs['wx:for-item'] ?? 'item']: item,
            [attrs['wx:for-index'] ?? 'index']: index,
          },
          templates,
          slots,
        );
      });
      continue;
    }
    if ('wx:if' in attrs) matched = false;
    const condition = attrs['wx:if'] ?? attrs['wx:elif'];
    if ('wx:elif' in attrs && matched) continue;
    if (condition !== undefined) {
      if (!expression(condition.slice(2, -2), scope)) continue;
      matched = true;
    } else if ('wx:else' in attrs) {
      if (matched) continue;
      matched = true;
    } else matched = false;
    if (node.tag === 'template' && attrs.is) {
      result += render(
        templates[attrs.is] ?? [],
        expression(`({${attrs.data.slice(2, -2)}})`, scope) ?? {},
        templates,
        slots,
      );
      continue;
    }
    // page-meta controls native page chrome/scroll, not visible content.
    // Static HTML cannot establish its WeChat scroll-lock behavior.
    if (node.tag === 'page-meta') continue;
    if (node.tag === 'slot') {
      result += slots[attrs.name ?? 'default']?.() ?? '';
      continue;
    }
    if (
      node.tag === 'wu-reference-text' ||
      /^(?:wu-)?f7-(button|block|list|list-item|segmented|input|searchbar|toggle|sheet|actions|dialog)$/.test(
        node.tag,
      )
    ) {
      const name = node.tag.replace(/^wu-/, '');
      usedNativeComponents.add(name);
      const componentFile = path.join(source, 'components', name, name + '.ts');
      let definition;
      const previous = globalThis.Component;
      globalThis.Component = (value) => {
        definition = value;
      };
      try {
        delete require.cache[require.resolve(componentFile)];
        require(componentFile);
      } finally {
        globalThis.Component = previous;
      }
      if (!definition)
        throw new Error('Missing native component definition: ' + name);
      const data = nativeComponentPreviewState(definition, attrs, (value) =>
        evaluatePreviewAttribute(value, scope),
      );
      const componentSlots = {};
      for (const child of node.children) {
        const slot =
          typeof child === 'string'
            ? 'default'
            : (child.attrs.slot ?? 'default');
        const previousSlot = componentSlots[slot];
        componentSlots[slot] = () =>
          (previousSlot?.() ?? '') + render([child], scope, templates, slots);
      }
      const template = path.join(source, 'components', name, name + '.wxml');
      result += `<div class="preview-component-${name}">${render(parseFile(template).children, data, templatesFor(template), componentSlots)}</div>`;
      continue;
    }
    if (node.tag === 'wu-icon') {
      const name = interpolate(attrs.name ?? 'home', scope);
      const tone = interpolate(attrs.tone ?? 'default', scope);
      const size = Number(interpolate(attrs.size ?? '24', scope)) || 24;
      const image = (variant, className) => {
        if (!/^[a-z-]+$/.test(name) || !/^[a-z-]+$/.test(variant))
          throw new Error(`Invalid preview icon: ${variant}/${name}`);
        const file = path.join(source, 'assets/icons', variant, `${name}.png`);
        if (!existsSync(file))
          throw new Error(`Missing preview icon: ${variant}/${name}`);
        return `<img class="${className}" alt="" src="data:image/png;base64,${readFileSync(file).toString('base64')}" />`;
      };
      const content =
        tone === 'default' || tone === 'inverse'
          ? image(tone === 'inverse' ? 'dark' : 'light', 'preview-icon-light') +
            image(tone === 'inverse' ? 'light' : 'dark', 'preview-icon-dark')
          : image(tone, '');
      result += `<span class="preview-icon" style="width:${size}px;height:${size}px">${content}</span>`;
      continue;
    }
    if (node.tag === 'wu-safe-top') {
      result +=
        '<div class="preview-safe-top" style="height:44px" aria-hidden="true"></div>';
      continue;
    }
    if (node.tag === 'wu-tab-bar') {
      const component = parse(
        readFileSync(
          path.join(source, 'components/tab-bar/tab-bar.wxml'),
          'utf8',
        ),
      );
      result += `<div class="tab-component">${render(component.children, { selected: interpolate(attrs.selected, scope), navigationError: '' }, {})}</div>`;
      continue;
    }
    if (node.tag === 'map' || node.tag === 'web-view') {
      result += `<div class="preview-native-placeholder ${escape(interpolate(attrs.class ?? '', scope))}" style="display:flex;align-items:center;justify-content:center;padding:32px 20px;text-align:center;color:var(--wu-secondary);background:var(--wu-fill-secondary,#eee)">${node.tag === 'map' ? '原生地图区域 · 静态预览不绘制地图' : '原生网页区域 · 静态预览不加载网页'}</div>`;
      continue;
    }
    if (node.tag === 'progress') {
      const raw = Number(interpolate(attrs.percent ?? '0', scope));
      const percent = Number.isFinite(raw)
        ? Math.max(0, Math.min(100, raw))
        : 0;
      result += `<div class="preview-progress ${escape(interpolate(attrs.class ?? '', scope))}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" style="height:6px;border-radius:3px;overflow:hidden;background:var(--wu-fill-secondary,#ddd)"><div style="height:100%;width:${percent}%;background:var(--wu-accent,#007aff)"></div></div>`;
      continue;
    }
    const tag =
      {
        view: 'div',
        text: 'span',
        navigator: 'a',
        'scroll-view': 'div',
        block: 'div',
        image: 'img',
        switch: 'input',
        radio: 'input',
        checkbox: 'input',
        'checkbox-group': 'div',
        'radio-group': 'div',
        picker: 'div',
      }[node.tag] ?? node.tag;
    const htmlAttrs = Object.entries(attrs)
      .filter(([key]) =>
        [
          'src',
          'class',
          'style',
          'id',
          'placeholder',
          'value',
          'disabled',
          'checked',
          'type',
          'aria-label',
          'aria-role',
        ].includes(key),
      )
      .map(([key, value]) => {
        const resolved = interpolate(value, scope);
        // Only our exact generated fixture is admitted. Never expose native paths or remote URLs.
        if (key === 'src')
          return node.tag === 'image' && resolved === coverFixture
            ? ` src="${escape(resolved)}"`
            : '';
        if (
          key === 'style' &&
          /url\s*\(|@import|expression\s*\(/i.test(resolved)
        )
          return '';
        if (key === 'disabled' || key === 'checked')
          return resolved === 'true' ? ` ${key}` : '';
        if (key === 'class' && node.tag === 'switch')
          return ` class="${escape(resolved)} preview-switch"`;
        return ` ${key}="${escape(resolved)}"`;
      })
      .join('');
    const imageFit =
      node.tag === 'image' && ['aspectFill', 'aspectFit'].includes(attrs.mode)
        ? ` style="object-fit:${attrs.mode === 'aspectFill' ? 'cover' : 'contain'}"`
        : '';
    const body =
      node.tag === 'textarea'
        ? escape(interpolate(attrs.value ?? '', scope))
        : render(node.children, scope, templates, slots);
    const controlType =
      node.tag === 'switch'
        ? ` type="checkbox"${'class' in attrs ? '' : ' class="preview-switch"'}`
        : node.tag === 'checkbox'
          ? ' type="checkbox"'
          : node.tag === 'radio'
            ? ' type="radio"'
            : '';
    const scrolling =
      node.tag === 'scroll-view' && 'scroll-y' in attrs
        ? ' style="overflow-y:auto"'
        : '';
    result += ['img', 'input'].includes(tag)
      ? `<${tag}${htmlAttrs}${imageFit}${controlType}>`
      : `<${tag}${htmlAttrs}${imageFit}${scrolling}>${body}</${tag}>`;
  }
  return result;
}
const usedNativeComponents = new Set();
function css(file, host = '.tab-component') {
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8')
    .replace(/@import\s+['"]([^'"]+)['"];?/g, (_, relative) =>
      css(path.resolve(path.dirname(file), relative), host),
    )
    .replace(/(-?[\d.]+)rpx/g, (_, v) => `${Number(v) * 0.52}px`)
    .replace(/\bpage\s*\{/g, 'body {')
    .replaceAll(':host', host);
}
for (const previewName of [
  'community-feed',
  'campus-hub',
  'inbox',
  'inbox-sample',
  'me',
  'me-sample',
  'public-profile',
  'profile',
  'compose-entry',
  'login',
  'community-compose',
  'community-detail',
  'community-thread',
  'campus-hub-sample',
  'compose-entry-sample',
  'community-compose-sample',
  'community-detail-sample',
  'community-thread-sample',
  'profile-sample',
  'me-menu-sample',
  'settings-sample',
  'account-menu',
  ...batches.map((fixture) => fixture.id),
]) {
  const fixture = batches.find((item) => item.id === previewName);
  const page =
    fixture?.page ??
    (previewName === 'me-menu-sample'
      ? 'me'
      : previewName.endsWith('-sample')
        ? previewName.slice(0, -7)
        : previewName);
  const emitted = process.argv.includes('--source')
    ? path.join(source, `pages/${page}/${page}.ts`)
    : path.join(root, `dist/pages/${page}/${page}.js`);
  if (!existsSync(emitted)) {
    if (fixture) throw new Error(`Missing fixture page: ${fixture.page}`);
    continue;
  }
  let definition;
  globalThis.Page = (value) => {
    definition = value;
  };
  delete require.cache[require.resolve(emitted)];
  require(emitted);
  const data = { ...definition.data };
  if (previewName === 'inbox-sample')
    Object.assign(
      data,
      JSON.parse(
        readFileSync(path.join(root, 'scripts/fixtures/inbox.json'), 'utf8'),
      ),
    );
  if (['me-sample', 'me-menu-sample'].includes(previewName))
    Object.assign(data, {
      coverRead: { ...data.coverRead, localSrc: coverFixture },
      profile: {
        ...data.profile,
        hasSession: true,
        loaded: true,
        nickname: '示例同学',
        bio: '示例个人简介',
        selectedCampusName: '测试大学 · 主校区',
      },
      schoolUidView: {
        ...data.schoolUidView,
        loaded: true,
        busy: false,
        schoolUid: { status: 'assigned', formattedUid: '000123' },
      },
      stats: {
        ...data.stats,
        loaded: true,
        following: { status: 'known', value: 8 },
        followers: { status: 'known', value: 17 },
        receivedInteractions: { status: 'unavailable', value: null },
      },
      details: {
        ...data.details,
        hasSession: true,
        loaded: true,
        region: '示例地区',
        gender: 'female',
        age: 21,
        showRegion: true,
        showGender: true,
        showAge: true,
      },
      content: {
        ...data.content,
        availability: 'available',
        hasSession: true,
        loaded: true,
        total: 3,
        totalStatus: 'known',
        continuation: 'end',
        items: [
          {
            id: 'qa1',
            text: '今天的图书馆靠窗座位，终于等到了。\n书读到一半，阳光刚好落在桌角。',
            author: '示例同学',
            context: '校园日常',
            imageCount: 1,
            images: [{ width: 4, height: 3 }],
            kind: 'post',
            likeCount: 12,
            url: '#',
          },
          {
            id: 'qa2',
            text: '在校园发现一条很适合散步的小路。',
            author: '示例同学',
            context: '校园日常',
            imageCount: 0,
            images: [],
            kind: 'post',
            likeCount: 6,
            url: '#',
          },
          {
            id: 'qa3',
            text: '周末一起去操场跑步吗？\n慢慢跑就好。',
            author: '示例同学',
            context: '校园日常',
            imageCount: 0,
            images: [],
            kind: 'post',
            likeCount: 2,
            url: '#',
          },
        ],
      },
    });

  if (previewName === 'me-menu-sample') data.showMenu = true;
  if (previewName === 'settings-sample')
    Object.assign(data, {
      hasSession: true,
      loaded: true,
      loading: false,
      saving: false,
      needsReload: false,
      preferencesDirty: false,
      error: '',
      status: '',
      preferences: JSON.parse(
        readFileSync(path.join(root, 'scripts/fixtures/settings.json'), 'utf8'),
      ),
    });

  // Explicit synthetic layout data only. Never imported by the native runtime.
  const coreSample =
    previewName.endsWith('-sample') &&
    ![
      'me-sample',
      'me-menu-sample',
      'inbox-sample',
      'settings-sample',
    ].includes(previewName);
  if (coreSample) {
    const author = {
      kind: 'named',
      displayName: '示例同学',
      experienceDisplay: null,
    };
    const viewer = {
      isSelf: false,
      isLiked: false,
      isSaved: false,
      canComment: true,
      canSave: true,
      canDelete: false,
      canPin: false,
    };
    const post = {
      id: 'sample-post',
      author,
      viewer,
      space: { id: 'sample-space', name: '示例校园' },
      text: '下课后，沿着操场走了一圈。\n今天的晚风刚刚好。',
      publishedAt: '10 分钟前',
      images: [],
      likeCount: 12,
      saveCount: 3,
      commentCount: 2,
      replyCount: 1,
    };
    const rootComment = {
      id: 'sample-comment',
      author: { ...author, displayName: '示例同学甲' },
      viewer,
      text: '这里也很适合慢跑，傍晚的人不多。',
      createdAt: '5 分钟前',
      images: [],
      likeCount: 3,
      replyCount: 1,
      replyPreview: { items: [], nextCursor: null },
    };
    const reply = {
      id: 'sample-reply',
      author: { ...author, displayName: '示例同学乙' },
      viewer,
      text: '明天也去走走。',
      createdAt: '2 分钟前',
      images: [],
      likeCount: 1,
      target: {
        status: 'available',
        kind: 'comment',
        id: rootComment.id,
        author: rootComment.author,
      },
    };
    Object.assign(data, {
      loaded: true,
      hasSession: true,
      busy: false,
      loading: false,
      status: '',
      error: '',
    });
    if (page === 'campus-hub')
      Object.assign(data, {
        campusLabel: '示例大学 · 主校区',
        campus: {
          ...data.campus,
          busy: false,
          state: 'ready',
          error: '',
          status: '',
        },
      });
    if (page === 'compose-entry')
      Object.assign(data, {
        campusId: 'sample-campus',
        campusName: '示例校园',
        campuses: [
          {
            id: 'sample-campus',
            fullName: '示例大学 · 主校区',
            isActive: true,
          },
        ],
        globalSpaces: [{ id: 'sample-global', name: '校园交流' }],
        space: post.space,
      });
    if (page === 'community-compose')
      Object.assign(data, {
        text: '下课后，沿着操场走了一圈。\n今天的晚风刚刚好。',
        effectiveIdentity: '公开身份 · 示例校园',
        canSubmit: true,
        canSelectImage: true,
        mediaNotice: '',
        canAddPoll: true,
        canAddFormation: true,
        canOpenIdentityCampus: true,
      });
    if (page === 'community-detail')
      Object.assign(data, {
        post,
        comments: [
          rootComment,
          {
            ...rootComment,
            id: 'sample-comment-2',
            author: reply.author,
            text: '晚饭后散步的好去处。',
            likeCount: 1,
            replyCount: 0,
          },
        ],
        sort: 'likes',
        order: 'desc',
        pageNumber: 1,
      });
    if (page === 'community-thread')
      Object.assign(data, { post, root: rootComment, replies: [reply] });
    if (page === 'profile')
      Object.assign(data, {
        configured: true,
        canGoBack: true,
        nickname: '示例同学',
        bio: '',
        bioLength: 0,
        selectedCampusName: '示例大学 · 主校区',
        schoolUidView: {
          ...data.schoolUidView,
          loaded: true,
          schoolUid: { status: 'assigned', formattedUid: '000001' },
        },
        details: {
          ...data.details,
          loaded: true,
          hasSession: true,
          regionInput: '示例地区',
          ageInput: '',
          gender: '',
          busy: false,
        },
        coverRead: {
          ...data.coverRead,
          status: 'ready',
          localSrc: coverFixture,
        },
      });
  }

  if (page === 'community-feed')
    Object.assign(data, {
      loaded: true,
      busy: false,
      hasSession: false,
      campusName: '北航',
      campusId: '10000000-0000-4000-8000-000000000001',
      space: {
        id: '20000000-0000-4000-8000-000000000002',
        name: '北航',
        kind: 'regional',
      },
      status: '',
      posts: [],
    });
  if (fixture) Object.assign(data, structuredClone(fixture.patch));
  if (page === 'me') data.visibleContentItems = data.content.items;
  usedNativeComponents.clear();
  const file = path.join(source, `pages/${page}/${page}.wxml`);
  const html = render(parseFile(file).children, data, templatesFor(file));
  // WeChat's native navigation is configured in JSON, not WXML. Approximate it only for this settings frame.
  const nativeTitle =
    page === 'settings' || page === 'account-menu' || fixture
      ? JSON.parse(
          readFileSync(path.join(source, `pages/${page}/${page}.json`), 'utf8'),
        ).navigationBarTitleText
      : '';
  const nativeHeader = nativeTitle
    ? `<div class="preview-native-safe"></div><div class="preview-native-bar"><span class="preview-native-back">${render([{ tag: 'wu-icon', attrs: { name: 'chevron-right', size: '22' }, children: [] }], {}, {})}</span><span>${escape(nativeTitle)}</span><span></span></div>`
    : '';
  const usableViewport = (value) =>
    nativeHeader ? value.replace(/\b100vh\b/g, 'calc(100vh - 88px)') : value;
  const nativeComponentStyles = [...usedNativeComponents]
    .map((name) =>
      css(
        path.join(source, 'components', name, name + '.wxss'),
        '.preview-component-' + name,
      ),
    )
    .join('\n');
  const styles =
    nativeComponentStyles +
    css(path.join(source, 'app.wxss')) +
    css(path.join(source, `pages/${page}/${page}.wxss`)) +
    css(path.join(source, 'components/tab-bar/tab-bar.wxss'));
  writeFileSync(
    path.join(output, `${previewName}.html`),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>WhaleU ${page} · visual QA approximation</title><style>*{box-sizing:border-box}body{margin:0}button,input,textarea{font:inherit}button{border:0;cursor:pointer}a{display:block;text-decoration:none;color:inherit}span{white-space:inherit}button[size=mini]{min-height:32px}input{display:block}.preview-icon{display:inline-flex;flex:none;vertical-align:middle;line-height:0}.preview-icon img{width:100%;height:100%}.preview-icon-dark{display:none}@media(prefers-color-scheme:dark){.preview-icon-light{display:none}.preview-icon-dark{display:block}} .native-navigation{height:44px;display:flex;justify-content:space-between;align-items:center;padding:0 20px;font-size:12px;color:var(--wu-secondary)}.preview-switch{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:51px;height:31px;border:0;border-radius:18px;background:var(--wu-separator,#e5e5ea);margin:0}.preview-switch:before{content:"";position:absolute;left:2px;top:2px;width:27px;height:27px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0002}.preview-switch:checked{background:#007aff}.preview-switch:checked:before{left:22px}.preview-native-safe{height:44px;background:var(--wu-bg,#f5f5f7)}.preview-native-bar{height:44px;display:grid;grid-template-columns:44px 1fr 44px;align-items:center;text-align:center;font-size:17px;font-weight:600;background:var(--wu-bg,#f5f5f7)}.preview-native-back{transform:rotate(180deg);display:flex;justify-content:center}${usableViewport(styles)}</style><body>${nativeHeader}${usableViewport(html)}</body></html>`,
  );
}
console.log(
  `Rendered source-based WXML/WXSS approximations to ${output}. Not native-device proof.`,
);

const titles = {
  'community-feed': '首页 · 本校',
  'campus-hub': '校园',
  'inbox-sample': '消息 · 示例数据',
  inbox: '消息 · 未登录',
  'me-sample': '我的 · 示例数据',
  me: '我的 · 未登录',
  'public-profile': '公开主页 · 初始状态',
  profile: '编辑资料 · 初始状态',
  'compose-entry': '发布入口',
  login: '登录',
  'community-compose': '写帖子',
  'community-detail': '主题详情 · 初始状态',
  'community-thread': '回复 · 初始状态',
  'campus-hub-sample': '校园 · 示例数据',
  'compose-entry-sample': '发布入口 · 示例数据',
  'community-compose-sample': '发布主题 · 示例数据',
  'community-detail-sample': '主题详情 · 示例数据',
  'community-thread-sample': '回复 · 示例数据',
  'profile-sample': '编辑资料 · 示例数据',
  'me-menu-sample': '我的菜单 · 示例数据',
  'settings-sample': '系统设置 · 示例数据',
  'account-menu': '我的服务 · 入口清单',
};
const cards = Object.entries(titles)
  .filter(([name]) => existsSync(path.join(output, `${name}.html`)))
  .flatMap(([name, title]) => {
    const themes =
      name.endsWith('-sample') ||
      name === 'community-feed' ||
      name === 'account-menu'
        ? ['light', 'dark']
        : ['light'];
    const original = readFileSync(path.join(output, `${name}.html`), 'utf8');
    return themes.map((theme) => {
      const content = original.replace(
        /@media\s*\(prefers-color-scheme:\s*dark\)/g,
        theme === 'dark' ? '@media all' : '@media not all',
      );
      return `<section><h2>${escape(title)} · ${theme === 'dark' ? '深色' : '浅色'}</h2><iframe title="${escape(title)}" srcdoc="${escape(content)}"></iframe></section>`;
    });
  })
  .join('');

writeFileSync(
  path.join(output, 'index.html'),
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhaleU 原生小程序 · 双主题界面评审</title><style>body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}header{padding:36px 28px 12px;max-width:1000px}h1{font-size:30px;letter-spacing:-1px}p{color:#6e6e73;line-height:1.7}main{display:flex;flex-wrap:wrap;gap:28px;padding:16px 28px 40px}section{width:390px}h2{font-size:17px}iframe{width:390px;height:844px;border:1px solid #d2d2d7;border-radius:28px;background:white;box-shadow:0 12px 35px #0000000a}@media(prefers-color-scheme:dark){body{background:#101012;color:#f5f5f7}p{color:#aeaeb2}iframe{border-color:#38383a}}</style><header><h1>WhaleU · 双主题界面评审</h1><p>“我的”使用主题、回复、收藏、赞过四个主分类，主题和回复下设公开、分身二级分类；地区、性别、年龄各自使用独立的小胶囊，地区带定位图标；隐藏或未填写字段不展示。首页采用双列内容布局，消息页顶部为赞和收藏、新增关注、回复和@，下方只呈现真实私信和有实际事件的通知发信人，不再按业务模块铺设入口。明暗主题按用户参考截图的结构对照，未复制截图内的个人信息、聊天内容或图片。主页使用实际 UID 和可选资料，右上角为编辑／扫码／分享；快捷入口为浏览记录、校园认证与钱包。背景图样例是独立绘制的几何图，仅用于预览上传后的布局，非用户照片；实际上传仍需要配置可信媒体处理服务，钱包尚未接入。同时展示未登录状态与明确标注的虚构样例，样例仅存在于预览，不进入产品；图标为独立绘制，未复制 SF Symbols 或打包 Apple 字体。</p><p>这是原生 WXML / WXSS 源代码生成的静态 HTML 布局近似预览，不是微信真机截图。按钮不可操作，示例人物和帖子仅用于布局评审，没有连接后端；“北航”仅为校园标签排版样例。正式视觉、键盘、安全区与交互验收仍需微信开发者工具及真机。</p></header><main>${cards}</main></html>`,
);

const coreTitles = {
  'campus-hub-sample': '校园',
  'compose-entry-sample': '发布入口',
  'community-compose-sample': '发布主题',
  'community-detail-sample': '主题详情',
  'community-thread-sample': '回复',
  'profile-sample': '编辑资料',
};
const coreCards = Object.entries(coreTitles)
  .flatMap(([name, title]) => {
    const original = readFileSync(path.join(output, `${name}.html`), 'utf8');
    return ['light', 'dark'].map((theme) => {
      const content = original.replace(
        /@media\s*\(prefers-color-scheme:\s*dark\)/g,
        theme === 'dark' ? '@media all' : '@media not all',
      );
      return `<section><h2>${escape(title)} · ${theme === 'dark' ? '深色' : '浅色'} · 示例数据</h2><iframe title="${escape(title)}" srcdoc="${escape(content)}"></iframe></section>`;
    });
  })
  .join('');
writeFileSync(
  path.join(output, 'core-product.html'),
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhaleU 核心产品页面</title><style>body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}header{padding:28px 24px 12px;max-width:980px}h1{font-size:26px;font-weight:600}p{color:#6e6e73;line-height:1.6}main{display:flex;flex-wrap:wrap;gap:24px;padding:12px 24px 40px}section{width:390px}h2{font-size:15px;font-weight:500}iframe{width:390px;height:844px;border:1px solid #ddd;border-radius:24px;background:white}</style><header><h1>WhaleU · 核心页面</h1><p>校园、发布、主题详情、回复与编辑资料。首页、消息、我的保持原有设计。</p><p>原生 WXML/WXSS 源代码生成的静态布局近似预览，并非微信截图。仅使用标注的虚构样例；按钮不可操作，未连接服务。背景图为独立绘制的几何示例。键盘、安全区与实际交互仍需微信开发者工具及真机验收。</p></header><main>${coreCards}</main></html>`,
);

validateCorePreviewHtml(
  readFileSync(path.join(output, 'core-product.html'), 'utf8'),
);
console.log('Core preview semantic validation: all 12 frames passed.');

const menuCards = Object.entries({
  'me-menu-sample': '我的菜单',
  'settings-sample': '系统设置',
})
  .flatMap(([name, title]) => {
    const original = readFileSync(path.join(output, `${name}.html`), 'utf8');
    return ['light', 'dark'].map((theme) => {
      const content = original.replace(
        /@media\s*\(prefers-color-scheme:\s*dark\)/g,
        theme === 'dark' ? '@media all' : '@media not all',
      );
      return `<section><h2>${escape(title)} · ${theme === 'dark' ? '深色' : '浅色'} · 示例数据</h2><iframe title="${escape(title)}" srcdoc="${escape(content)}"></iframe></section>`;
    });
  })
  .join('');
const menuDocument = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhaleU 菜单与系统设置</title><style>body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}header{padding:28px 24px 12px;max-width:900px}h1{font-size:26px;font-weight:600}p{color:#6e6e73;line-height:1.6}main{display:flex;flex-wrap:wrap;gap:24px;padding:12px 24px 40px}section{width:390px}h2{font-size:15px;font-weight:500}iframe{width:390px;height:844px;border:1px solid #ddd;border-radius:24px;background:white}</style><header><h1>WhaleU · 菜单与系统设置</h1><p>左侧菜单展开状态与独立系统设置页。编辑资料不再包含使用偏好和账户功能；我的主页主体保持原样。</p><p>由当前原生 WXML/WXSS 源代码生成的静态 HTML 近似预览，不是微信截图。人物、内容和开关状态均为虚构示例，未连接服务；按钮不可操作，菜单和设置内容可在画面内滚动。系统设置的微信原生导航栏及开关为近似呈现。安全区、键盘与真实交互仍需开发者工具及真机验收。</p></header><main>${menuCards}</main></html>`;
validateMenuPreviewHtml(menuDocument);
writeFileSync(path.join(output, 'menu-settings.html'), menuDocument);
console.log('Menu/settings semantic validation: all 4 frames passed.');

// New product batches are separate artifacts; delivered v11/v12 files remain immutable.
for (const batch of new Set(batches.map((fixture) => fixture.batch))) {
  const fixtures = batches.filter((fixture) => fixture.batch === batch);
  const cards = fixtures
    .flatMap((fixture) => {
      const original = readFileSync(
        path.join(output, `${fixture.id}.html`),
        'utf8',
      );
      return ['light', 'dark'].map((theme) => {
        const content = original.replace(
          /@media\s*\(prefers-color-scheme:\s*dark\)/g,
          theme === 'dark' ? '@media all' : '@media not all',
        );
        return `<section><h2>${escape(fixture.title)} · ${theme === 'dark' ? '深色' : '浅色'} · 示例数据</h2><iframe title="${escape(fixture.title)}" srcdoc="${escape(content)}"></iframe></section>`;
      });
    })
    .join('');
  const document = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhaleU 产品页面评审</title><style>body{margin:0;background:#f5f5f7;color:#1d1d1f;font:16px -apple-system,BlinkMacSystemFont,sans-serif}header{padding:28px 24px;max-width:900px}p{color:#6e6e73;line-height:1.6}main{display:flex;flex-wrap:wrap;gap:24px;padding:0 24px 40px}section{width:390px}h2{font-size:15px;font-weight:500}iframe{width:390px;height:844px;border:1px solid #ddd;border-radius:24px;background:white}</style><header><h1>WhaleU · 产品页面评审</h1><p>当前原生 WXML/WXSS 源代码的静态布局近似预览，不是微信截图。全部内容均为虚构样例，未连接服务；按钮不可操作，地图与内嵌网页只标示原生组件区域。安全区、键盘及真实交互仍需微信开发者工具和真机验收。</p></header><main>${cards}</main></html>`;
  const checks = validateProductPreviewHtml(document, fixtures);
  writeFileSync(path.join(output, `${batch}-product.html`), document);
  writeFileSync(
    path.join(output, `${batch}-validation.json`),
    JSON.stringify(checks, null, 2),
  );
  console.log(
    `${batch} semantic validation: all ${checks.length} frames passed.`,
  );
}

// Visual-review cases render the actual native component source, never a parallel mock.
if (process.argv.includes('--components=framework7')) {
  const cases = [];
  for (const variant of ['plain', 'fill', 'tonal', 'outline']) {
    for (const state of ['enabled', 'disabled', 'loading']) {
      cases.push({
        id: `button-${variant}-${state}`,
        title: `${variant} · ${state}`,
        markup: `<wu-f7-button variant="${variant}" disabled="{{${state === 'disabled'}}}" loading="{{${state === 'loading'}}}" aria-label="继续查看">继续查看</wu-f7-button>`,
        scope: {},
        expected: ['继续查看'],
      });
    }
  }
  cases.push(
    {
      id: 'button-size',
      title: 'Small / normal / large; native 44px hit targets',
      markup:
        '<wu-f7-button size="small" variant="fill">小按钮</wu-f7-button><wu-f7-button size="normal" variant="tonal" round="{{true}}">圆角按钮</wu-f7-button><wu-f7-button size="large" variant="fill">继续查看校园资料</wu-f7-button>',
      scope: {},
      expected: ['小按钮', '继续查看校园资料'],
    },
    {
      id: 'list',
      title: 'Inset List / static, linked and disabled rows',
      markup:
        '<wu-f7-list strong="{{true}}" inset="{{true}}"><wu-f7-list-item title="校园地点" subtitle="地图与位置" link="{{true}}" media="{{true}}"><wu-icon slot="media" name="map" size="24"/></wu-f7-list-item><wu-f7-list-item title="本机记录" text="静态内容，不触发导航"/><wu-f7-list-item title="暂不可用" after="已停用" link="{{true}}" disabled="{{true}}" last="{{true}}"/></wu-f7-list>',
      scope: {},
      expected: ['校园地点', '本机记录', '暂不可用'],
    },
    {
      id: 'list-loading',
      title: 'ListItem loading / long multilingual content',
      markup:
        '<wu-f7-list strong="{{true}}"><wu-f7-list-item title="校园图书馆 Campus Library 学习资料查询" subtitle="一段较长的中文与 English 说明" link="{{true}}" loading="{{true}}" last="{{true}}"/></wu-f7-list>',
      scope: {},
      expected: ['Campus Library', 'English'],
    },
    {
      id: 'block',
      title: 'Content Block / header and footer',
      markup:
        '<wu-f7-block strong="{{true}}" inset="{{true}}" title="资料范围" footer="仅展示此校园已发布的资料">这里是组件示例内容，不连接真实服务。</wu-f7-block>',
      scope: {},
      expected: ['资料范围', '组件示例内容'],
    },
  );
  for (const disabled of [false, true]) {
    cases.push({
      id: `segmented-${disabled}`,
      title: `Controlled Segmented · disabled=${disabled}`,
      markup: `<wu-f7-segmented options="{{options}}" value="second" disabled="{{${disabled}}}" label="浏览类型"/>`,
      scope: {
        options: [
          { value: 'first', label: '校园' },
          { value: 'second', label: '全站' },
          { value: 'third', label: '暂不可用', disabled: true },
        ],
      },
      expected: ['校园', '全站', '暂不可用'],
    });
  }
  for (const state of ['normal', 'error', 'disabled', 'readonly']) {
    cases.push({
      id: `input-${state}`,
      title: `Native Input · ${state}`,
      markup: `<wu-f7-input label="显示名称" value="校园同行" placeholder="填写显示名称" clearable="{{true}}" disabled="{{${state === 'disabled'}}}" read-only="{{${state === 'readonly'}}}" error-text="${state === 'error' ? '请检查名称格式' : ''}" />`,
      scope: {},
      expected: ['显示名称', ...(state === 'error' ? ['请检查名称格式'] : [])],
    });
  }
  cases.push({
    id: 'searchbar',
    title: 'Controlled Searchbar · explicit submit and cancel',
    markup:
      '<wu-f7-searchbar value="图书馆" placeholder="搜索校园内容" show-cancel="{{true}}" />',
    scope: {},
    expected: ['取消'],
  });
  for (const checked of [false, true]) {
    for (const disabled of [false, true]) {
      cases.push({
        id: `toggle-${checked}-${disabled}`,
        title: `Native-backed Toggle · checked=${checked}, disabled=${disabled}`,
        markup: `<wu-f7-toggle label="显示通知预览" checked="{{${checked}}}" disabled="{{${disabled}}}" />`,
        scope: {},
        expected: ['显示通知预览'],
      });
    }
  }
  const { default: overlayCases } =
    await import('./fixtures/framework7-overlay-components-preview.mjs');
  cases.push(...overlayCases);
  const frames = [];
  const checks = [];
  for (const sample of cases) {
    usedNativeComponents.clear();
    const body = render(parse(sample.markup).children, sample.scope, {});
    const sourceCss =
      css(path.join(source, 'design/framework7-ios.wxss')) +
      [...usedNativeComponents]
        .map((name) =>
          css(
            path.join(source, 'components', name, name + '.wxss'),
            '.preview-component-' + name,
          ),
        )
        .join('\n');
    checks.push({ id: sample.id, expectedText: sample.expected });
    for (const theme of ['light', 'dark']) {
      const themed = sourceCss.replace(
        /@media\s*\(prefers-color-scheme:\s*dark\)/g,
        theme === 'dark' ? '@media all' : '@media not all',
      );
      const frame = `<!doctype html><meta charset="utf-8"><style>body{margin:0}.f7-catalog-stage{min-height:100vh;padding:16px;box-sizing:border-box;background:var(--f7-page-bg-color)}${themed}</style><body><div class="f7-ios-theme f7-catalog-stage">${body}</div></body>`;
      frames.push(
        `<section><h2>${escape(sample.title)} · ${theme}</h2><iframe title="${escape(sample.title)}" srcdoc="${escape(frame)}"></iframe></section>`,
      );
    }
  }
  const document = `<!doctype html><meta charset="utf-8"><title>WhaleU Native Framework7 Port</title><style>body{font:15px system-ui;margin:24px;background:#f4f4f4}main{display:flex;flex-wrap:wrap;gap:20px}section{width:390px}iframe{width:390px;height:600px;border:0;border-radius:18px}h2{font-size:16px}</style><h1>Framework7 v9.2.0 iOS → 原生组件评审</h1><p>项目自建转写，不是官方小程序运行时。由真实组件 WXML/WXSS 与虚构状态生成，非微信截图；点击与系统无障碍仍需原生验证。44px 最小触控区域是明确的平台适配，未复制字体或 SF Symbols。</p><main>${frames.join('')}</main>`;
  writeFileSync(path.join(output, 'framework7-components.html'), document);
  writeFileSync(
    path.join(output, 'framework7-components-validation.json'),
    JSON.stringify(validateProductPreviewHtml(document, checks), null, 2) +
      '\n',
  );
  console.log(
    `Framework7 component semantic validation: all ${checks.length * 2} frames passed.`,
  );
}
