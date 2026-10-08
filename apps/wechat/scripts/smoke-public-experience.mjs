import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);

// A bounded conditional model of the emitted shared template, not WeChat rendering.
// This only evaluates repository-owned expressions, never API input as code.
function parseTemplate(source) {
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  for (const match of source.matchAll(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
    const token = match[0];
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('</')) {
      assert.equal(stack.pop().tag, token.slice(2, -1).trim());
    } else if (token.startsWith('<')) {
      const tag = /^<([\w-]+)/.exec(token)?.[1];
      assert.ok(tag);
      const attrs = Object.fromEntries(
        [...token.matchAll(/([\w:-]+)="([^"]*)"/g)].map((item) => [
          item[1],
          item[2].replaceAll('&amp;', '&'),
        ]),
      );
      if (/\bwx:else(?:\s|>|\/)/.test(token)) attrs['wx:else'] = '';
      const node = { tag, attrs, children: [] };
      stack.at(-1).children.push(node);
      if (!token.endsWith('/>')) stack.push(node);
    } else if (token.trim()) stack.at(-1).children.push(token);
  }
  assert.equal(stack.length, 1);
  return root;
}
function expression(source, scope) {
  return Function(
    ...Object.keys(scope),
    `return (${source});`,
  )(...Object.values(scope));
}
function interpolate(text, scope) {
  return text.replace(/{{([\s\S]*?)}}/g, (_, source) =>
    expression(source, scope),
  );
}
function render(nodes, scope) {
  const output = [];
  let matched = false;
  for (const node of nodes) {
    if (typeof node === 'string') {
      output.push(interpolate(node, scope));
      continue;
    }
    if ('wx:if' in node.attrs) matched = false;
    const condition = node.attrs['wx:if'] ?? node.attrs['wx:elif'];
    if ('wx:elif' in node.attrs && matched) continue;
    if (condition !== undefined) {
      if (!expression(condition.slice(2, -2), scope)) continue;
      matched = true;
    } else if ('wx:else' in node.attrs) {
      if (matched) continue;
      matched = true;
    } else matched = false;
    output.push({
      tag: node.tag,
      attrs: Object.fromEntries(
        Object.entries(node.attrs)
          .filter(([key]) => !key.startsWith('wx:'))
          .map(([key, value]) => [key, interpolate(value, scope)]),
      ),
      children: render(node.children, scope),
    });
  }
  return output;
}
const known = (value) => ({ status: 'known', value });
const unavailable = () => ({ status: 'unavailable', value: null });
const absent = () => ({
  title: unavailable(),
  color: unavailable(),
  level: unavailable(),
});
const selected = () => ({
  title: known({ key: 'level_29', name: '一代宗师' }),
  color: known(25),
  level: unavailable(),
});
const routes = [
  'public-profile',
  'community-feed',
  'community-detail',
  'community-thread',
  'community-saved',
  'community-liked',
  'community-mine',
  'community-updates',
];

export async function smokePublicExperience({
  app,
  dist,
  mountPage,
  flush,
  postWire,
}) {
  const {
    decodePublicExperienceDisplay,
    PUBLIC_EXPERIENCE_COLOR_STYLES: colors,
  } = require(path.join(dist, 'experience/public-display.js'));
  const { decodeAuthor, decodeFeed } = require(
    path.join(dist, 'community/contract.js'),
  );
  const { authorProfilePath } = require(
    path.join(dist, 'profile/author-navigation.js'),
  );
  const shared = readFileSync(
    path.join(dist, 'experience/public-display.wxml'),
    'utf8',
  );
  const style = readFileSync(
    path.join(dist, 'experience/public-display.wxss'),
    'utf8',
  );
  const template = parseTemplate(shared).children[0];
  assert.equal(template.attrs.name, 'public-experience-display');
  assert.match(style, /\.public-experience-title-text/);
  assert.match(style, /background: #ffffff/);
  assert.ok(Object.isFrozen(colors));
  assert.equal(colors.length, 26);
  let combinations = 0;
  for (const title of [selected().title, known(null), unavailable()])
    for (const color of [known(0), known(25), known(null), unavailable()])
      for (const level of [known(1), known(30), unavailable()])
        for (const detailed of [false, true]) {
          const display = decodePublicExperienceDisplay({
            title,
            color,
            level,
          });
          const rendered = render(template.children, {
            display,
            colors,
            detailed,
          });
          const text = JSON.stringify(rendered);
          assert.equal(text.includes('一代宗师'), title.value !== null);
          assert.equal(text.includes('Lv.'), level.status === 'known');
          if (level.status === 'known')
            assert.ok(text.includes(`Lv.${level.value}`));
          assert.equal(
            text.includes('未选择头衔'),
            detailed && title.status === 'known' && title.value === null,
          );
          assert.equal(
            text.includes('头衔暂不可用'),
            detailed && title.status === 'unavailable',
          );
          assert.equal(
            text.includes('未选择颜色'),
            detailed && color.status === 'known' && color.value === null,
          );
          assert.equal(
            text.includes('颜色暂不可用'),
            detailed && color.status === 'unavailable',
          );
          assert.equal(
            text.includes('等级暂不可用'),
            detailed && level.status === 'unavailable',
          );
          assert.equal(
            text.includes('头衔色'),
            color.value !== null && title.value === null,
          );
          if (color.value !== null)
            assert.ok(text.includes(colors[color.value]));
          if (
            !detailed &&
            title.value === null &&
            color.value === null &&
            level.value === null
          )
            assert.deepEqual(rendered, []);
          assert.doesNotMatch(
            text,
            /balance|earnedAt|recordedAt|sourceId|ownerId|accountId|entitlements|revision/,
          );
          combinations++;
        }
  assert.equal(combinations, 72);

  let badgeCalls = 0;
  for (const route of routes) {
    const asset = `pages/${route}/${route}`;
    const markup = readFileSync(path.join(dist, `${asset}.wxml`), 'utf8');
    assert.match(
      markup,
      /<import src="\.\.\/\.\.\/experience\/public-display\.wxml"\s*\/>/,
    );
    assert.match(
      readFileSync(path.join(dist, `${asset}.wxss`), 'utf8'),
      /@import ["']\.\.\/\.\.\/experience\/public-display\.wxss["']/,
    );
    const tree = parseTemplate(markup);
    const visit = (node, ancestors = []) => {
      if (typeof node === 'string') return;
      if (node.attrs.is === 'public-experience-display') {
        badgeCalls++;
        assert.match(node.attrs.data, /colors:experienceColorStyles/);
        if (node.attrs.data.includes('display:profile.experienceDisplay'))
          assert.ok(
            ancestors.some((parent) =>
              parent.attrs['wx:if']?.includes("profile.status === 'available'"),
            ),
          );
        else assert.match(node.attrs['wx:if'], /\.kind === 'named'/);
      }
      if (['root-comment', 'reply-row'].includes(node.attrs.is))
        assert.match(node.attrs.data, /experienceColorStyles/);
      for (const child of node.children) visit(child, [...ancestors, node]);
    };
    visit(tree);
    let page;
    const previous = globalThis.Page;
    try {
      globalThis.Page = (value) => {
        page = value;
      };
      const module = path.join(dist, `${asset}.js`);
      delete require.cache[require.resolve(module)];
      require(module);
    } finally {
      globalThis.Page = previous;
    }
    assert.ok(page);
    assert.deepEqual(page.data.experienceColorStyles, colors);
  }
  assert.equal(badgeCalls, 17);
  const profileMarkup = readFileSync(
    path.join(dist, 'pages/public-profile/public-profile.wxml'),
    'utf8',
  );
  assert.match(profileMarkup, /获赞与码住：暂不可用/);
  assert.doesNotMatch(profileMarkup, /头衔、等级|外校同学|displayAvailability/);

  const profileId = 'abababab-abab-4bab-8bab-abababababab';
  const named = (display = selected()) => ({
    kind: 'named',
    profileId,
    displayName: '合成公开头衔',
    avatar: null,
    experienceDisplay: display,
  });
  const anonymous = postWire().author;
  assert.equal(anonymous.kind, 'anonymous');
  const posts = [
    { ...postWire(), component: { kind: 'none' }, author: named() },
    {
      ...postWire(),
      id: 'acacacac-acac-4cac-8cac-acacacacacac',
      component: { kind: 'none' },
      author: named({ title: known(null), color: known(0), level: known(1) }),
    },
    {
      ...postWire(),
      id: 'adadadad-adad-4dad-8dad-adadadadadad',
      component: { kind: 'none' },
      author: anonymous,
    },
  ];
  const rows = decodeFeed({
    items: posts,
    nextCursor: null,
    continuation: 'end',
  }).items;
  assert.equal(rows[0].author.experienceDisplay.level.value, null);
  assert.equal(rows[1].author.experienceDisplay.color.value, 0);
  assert.deepEqual(Object.keys(rows[2].author).sort(), [
    'avatar',
    'displayName',
    'isPostAuthor',
    'kind',
    'personaId',
  ]);
  for (const item of rows)
    assert.equal(
      authorProfilePath(item.author),
      item.author.kind === 'named'
        ? `/pages/public-profile/public-profile?profileId=${profileId}`
        : null,
    );
  assert.throws(() => decodeAuthor({ ...anonymous, experienceDisplay: null }));

  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { HttpDiscoveryGateway } = require(
    path.join(dist, 'profile/discovery-gateway.js'),
  );
  const original = {
    discovery: app.community.discovery,
    gateway: app.community.gateway,
    privacy: app.community.identityPrivacy,
  };
  const requests = [];
  const pages = [];
  let display = selected();
  let status = 'available';
  let delayed;
  const basic = () => ({
    status: 'available',
    profileId,
    isOwn: false,
    displayName: named().displayName,
    bio: '合成公开简介',
    avatar: null,
    affiliation: null,
    publicUid: null,
    experienceDisplay: display,
    totalInteractions: null,
    totalInteractionsStatus: 'unavailable',
    postsHidden: false,
    postCount: 2,
    postCountStatus: 'known',
    tradeCount: 0,
    tradeCountStatus: 'known',
  });
  const api = new ApiClient(
    'https://api.example',
    {
      send: async (request) => {
        requests.push(request);
        assert.equal(request.method, 'GET');
        const url = new URL(request.url);
        if (url.pathname === `/v1/profiles/${profileId}`) {
          const body = status === 'available' ? basic() : { status, profileId };
          if (delayed) await delayed;
          return { status: 200, headers: {}, body };
        }
        if (url.pathname === `/v1/profiles/${profileId}/posts`)
          return {
            status: 200,
            headers: {},
            body: {
              status: 'available',
              profileId,
              items: posts.slice(0, 2),
              total: 2,
              totalStatus: 'known',
              nextCursor: null,
              continuation: 'end',
            },
          };
        throw new Error(`Unexpected public-display request ${url.pathname}`);
      },
    },
    app.identity.sessions,
    {
      refresh: async () => {
        throw new Error('Unexpected refresh');
      },
    },
  );
  app.community.discovery = new HttpDiscoveryGateway(api);
  app.community.gateway = {};
  app.community.identityPrivacy = undefined;
  try {
    const page = mountPage(
      path.join(dist, 'pages/public-profile/public-profile.js'),
      { profileId },
    );
    pages.push(page);
    await flush();
    assert.deepEqual(page.data.profile.experienceDisplay, selected());
    assert.equal(page.data.items[1].author.experienceDisplay.color.value, 0);
    assert.equal(page.data.profile.totalInteractions, null);
    const canonicalKeys = Object.keys(page.data.items[0].author).sort();
    assert.deepEqual(canonicalKeys, [
      'avatar',
      'displayName',
      'experienceDisplay',
      'kind',
      'profileId',
    ]);
    display = { title: known(null), color: known(0), level: unavailable() };
    page.onReload();
    await flush();
    assert.deepEqual(page.data.profile.experienceDisplay, display);
    display = absent();
    page.onReload();
    await flush();
    assert.deepEqual(page.data.profile.experienceDisplay, absent());
    status = 'unavailable';
    page.onReload();
    await flush();
    assert.deepEqual(page.data.profile, { status: 'unavailable', profileId });
    assert.deepEqual(page.data.items, []);
    status = 'available';
    display = selected();
    let release;
    delayed = new Promise((resolve) => {
      release = resolve;
    });
    page.onReload();
    await flush();
    assert.equal(page.data.profile, null);
    page.onCancel();
    release();
    await flush();
    assert.equal(page.data.profile, null);
    assert.deepEqual(page.data.items, []);
    delayed = undefined;
    page.onReload();
    await flush();
    assert.deepEqual(page.data.profile.experienceDisplay, selected());
    page.onHide();
    assert.equal(page.data.profile, null);
    assert.deepEqual(page.data.items, []);
    page.onShow();
    await flush();
    assert.deepEqual(page.data.profile.experienceDisplay, selected());
    app.community.privateViews.clear();
    assert.equal(page.data.profile, null);
    assert.deepEqual(page.data.items, []);
    assert.ok(requests.length > 0);
  } finally {
    for (const page of pages) page.onUnload?.();
    app.community.discovery = original.discovery;
    app.community.gateway = original.gateway;
    app.community.identityPrivacy = original.privacy;
  }
  console.log(
    'Public experience emitted smoke passed: 72 shared-template conditions, 8 pages/17 named-only badge calls, immutable safe palette, canonical mixed author rows, real discovery gateway reload/cancel/hide/reopen and unavailable clearing. No physical-device rendering claim.',
  );
}
