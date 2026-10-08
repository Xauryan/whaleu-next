import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
// Bounded repository-owned WXML condition/loop/template model, not native rendering.
function parse(source) {
  const root = { tag: 'root', attrs: {}, children: [] },
    stack = [root];
  for (const match of source.matchAll(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
    const token = match[0];
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('</'))
      assert.equal(stack.pop().tag, token.slice(2, -1).trim());
    else if (token.startsWith('<')) {
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
const expression = (source, scope) =>
  Function(
    ...Object.keys(scope),
    `return (${source});`,
  )(...Object.values(scope));
const interpolate = (text, scope) =>
  text.replace(/{{([\s\S]*?)}}/g, (_, source) => expression(source, scope));
function render(nodes, scope, templates) {
  const result = [];
  let matched = false;
  for (const node of nodes) {
    if (typeof node === 'string') {
      result.push(interpolate(node, scope));
      continue;
    }
    if (node.tag === 'import') continue;
    if ('wx:for' in node.attrs) {
      const { ['wx:for']: loop, ...attrs } = node.attrs;
      for (const [index, item] of expression(
        loop.slice(2, -2),
        scope,
      ).entries())
        result.push(
          ...render(
            [{ ...node, attrs }],
            { ...scope, [attrs['wx:for-item'] ?? 'item']: item, index },
            templates,
          ),
        );
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
    if (node.tag === 'template' && node.attrs.is) {
      const nested = expression(`({${node.attrs.data.slice(2, -2)}})`, scope);
      result.push(
        ...render(templates[node.attrs.is].children, nested, templates),
      );
      continue;
    }
    result.push({
      tag: node.tag,
      attrs: Object.fromEntries(
        Object.entries(node.attrs)
          .filter(([key]) => !key.startsWith('wx:'))
          .map(([key, value]) => [key, interpolate(value, scope)]),
      ),
      children: render(node.children, scope, templates),
    });
  }
  return result;
}
export async function smokeDirectory({ app, dist, mountPage, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { HttpDirectoryGateway } = require(
    path.join(dist, 'directory/gateway.js'),
  );
  const original = {
    directory: app.community.directory,
    credentials: app.identity.sessions.snapshot().credentials,
    navigateTo: globalThis.wx.navigateTo,
    setClipboardData: globalThis.wx.setClipboardData,
  };
  assert.ok(original.credentials);
  const regionId = '11111111-1111-4111-8111-111111111111',
    otherRegion = '44444444-4444-4444-8444-444444444444';
  const categoryId = '22222222-2222-4222-8222-222222222222',
    entryId = '33333333-3333-4333-8333-333333333333';
  const cursor = Buffer.alloc(32, 7).toString('base64url');
  const state = {
    kind: 'org',
    platform: 'qq',
    regionId,
    error: null,
    empty: false,
    paging: false,
    holdContext: null,
    galleryKnown: false,
  };
  const requests = [],
    copied = [],
    navigated = [];
  const category = (id) => ({
    id,
    kind: state.kind,
    name: '合成分类',
    description: '完整分类介绍',
    accent: 'cyan',
  });
  const entry = (id) => ({
    id,
    categoryId,
    kind: state.kind,
    platform: state.platform,
    name: '合成条目',
    introPreview: '完整预览',
    badge: { status: 'known', value: 'official' },
    avatar: { status: 'unavailable', value: null },
  });
  const detail = () => ({
    ...entry(entryId),
    introText: '完整介绍\n保留文字',
    introImages: state.galleryKnown
      ? { status: 'known', items: [] }
      : { status: 'unavailable', items: null },
    mainQr: { status: 'unavailable', value: null },
    managerWechatImage: {
      status: state.platform === 'wechat' ? 'unavailable' : 'not_applicable',
      value: null,
    },
    linkedOfficialAccountQr: {
      status: state.platform === 'official' ? 'not_applicable' : 'absent',
      value: null,
    },
    qqGroupNumber:
      state.platform === 'qq'
        ? { status: 'known', value: '0012345678901234' }
        : { status: 'not_applicable', value: null },
    createdAt: null,
    updatedAt: null,
    visits: { status: 'unavailable', value: null },
    managers: { status: 'unavailable', items: null },
    management: { status: 'unavailable' },
  });
  const api = new ApiClient(
    'https://api.example',
    {
      send: async (request) => {
        requests.push(request);
        assert.equal(request.method, 'GET');
        assert.equal(request.body, undefined);
        assert.ok(request.headers.Authorization);
        const url = new URL(request.url),
          ok = (body) => ({ status: 200, headers: {}, body });
        if (url.pathname === '/v1/directory/context') {
          if (state.holdContext) await state.holdContext.promise;
          return ok({ regionId: state.regionId });
        }
        if (state.error)
          return {
            status: state.error === 'DIRECTORY_UNAVAILABLE' ? 503 : 409,
            headers: {},
            body: { error: { code: state.error } },
          };
        if (url.pathname.endsWith(`/entries/${entryId}`)) {
          assert.equal(url.search, '');
          return ok(detail());
        }
        assert.equal(url.searchParams.get('kind'), state.kind);
        assert.equal(url.searchParams.get('limit'), '20');
        const categoryPage = url.pathname.endsWith('/categories');
        const item = categoryPage ? category : entry;
        const more = state.paging && !url.searchParams.has('cursor');
        if (url.searchParams.has('cursor'))
          assert.equal(url.searchParams.get('cursor'), cursor);
        const items = state.empty
          ? []
          : more
            ? Array.from({ length: 20 }, (_, i) =>
                item(
                  i === 0
                    ? categoryPage
                      ? categoryId
                      : entryId
                    : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
                ),
              )
            : [item(categoryPage ? categoryId : entryId)];
        return ok({
          items,
          continuation: more && !state.empty ? 'more' : 'end',
          nextCursor: more && !state.empty ? cursor : null,
        });
      },
    },
    app.identity.sessions,
    {
      refresh: async () => {
        throw new Error('No provider');
      },
    },
  );
  app.community.directory = new HttpDirectoryGateway(api);
  globalThis.wx.navigateTo = (options) => navigated.push(options);
  globalThis.wx.setClipboardData = (options) => {
    copied.push(options.data);
    options.success();
  };
  const templates = Object.fromEntries(
    parse(readFileSync(path.join(dist, 'directory/common.wxml'), 'utf8'))
      .children.filter((node) => typeof node !== 'string')
      .map((node) => [node.attrs.name, node]),
  );
  const pageSource = (mode) =>
    readFileSync(
      path.join(dist, `pages/directory-${mode}/directory-${mode}.wxml`),
      'utf8',
    );
  const presented = (mode, page) =>
    JSON.stringify(
      render(parse(pageSource(mode)).children, page.data, templates),
    );
  const mount = (mode, route) =>
    mountPage(
      path.join(dist, `pages/directory-${mode}/directory-${mode}.js`),
      route,
    );
  const route = () => ({ regionId, kind: state.kind, categoryId, entryId });
  for (const mode of ['hub', 'list', 'detail']) {
    const source = pageSource(mode);
    assert.equal(
      /<image|previewImage|rich-text|https?:\/\/|data-(?:number|contact)|apply|managebutton/i.test(
        source,
      ),
      false,
    );
  }
  for (const kind of ['school', 'org', 'official']) {
    state.kind = kind;
    const hub = mount('hub', { kind });
    await flush();
    assert.equal(hub.data.loaded, true);
    assert.equal(hub.data.kind, kind);
    assert.ok(presented('hub', hub).includes('合成分类'));
    hub.onCategory({ currentTarget: { dataset: { id: categoryId } } });
    hub.onCategory({ currentTarget: { dataset: { id: categoryId } } });
    assert.ok(
      navigated.at(-1).url.includes(`kind=${kind}&categoryId=${categoryId}`),
    );
    navigated.at(-1).success();
    hub.onHide();
    assert.equal(hub.data.categories.length, 0);
    hub.onShow();
    await flush();
    assert.equal(hub.data.kind, kind);
    hub.onUnload();
    for (const platform of ['qq', 'wechat', 'official']) {
      state.platform = platform;
      const list = mount('list', { regionId, kind, categoryId });
      await flush();
      assert.equal(list.data.entries[0].platform, platform);
      assert.ok(presented('list', list).includes('官方推广标记'));
      list.onEntry({ currentTarget: { dataset: { id: entryId } } });
      const path = navigated.at(-1).url;
      assert.ok(
        path.includes(
          `kind=${kind}&categoryId=${categoryId}&entryId=${entryId}`,
        ),
      );
      navigated.at(-1).success();
      list.onHide();
      const page = mount('detail', route());
      await flush();
      const content = presented('detail', page);
      assert.equal(content.includes('qq-group-layout'), platform === 'qq');
      assert.equal(
        content.includes('wechat-group-layout'),
        platform === 'wechat',
      );
      assert.equal(
        content.includes('official-account-layout'),
        platform === 'official',
      );
      for (const text of [
        '时间未知',
        '访问次数：暂不可用',
        '管理员资料：暂不可用',
        '管理功能：暂不可用',
        '暂不可确认或展示',
      ])
        assert.ok(content.includes(text));
      const before = copied.length;
      page.onCopyQq({
        currentTarget: { dataset: { number: 'stale-QQ-number' } },
      });
      await flush();
      assert.equal(copied.length - before, platform === 'qq' ? 1 : 0);
      if (platform === 'qq') assert.equal(copied.at(-1), '0012345678901234');
      page.onHide();
      page.onCopyQq();
      await flush();
      assert.equal(page.data.detail, null);
      page.onUnload();
      list.onShow();
      await flush();
      assert.equal(list.data.kind, kind);
      list.onUnload();
    }
  }
  state.kind = 'org';
  state.platform = 'qq';
  state.paging = true;
  let list = mount('list', { regionId, kind: state.kind, categoryId });
  await flush();
  list.onInput({ detail: { value: '  校园%_\\  ' } });
  list.onSubmit();
  await flush();
  list.onInput({ detail: { value: '未提交草稿' } });
  const beforeNext = requests.length;
  list.onNext();
  list.onNext();
  await flush();
  assert.equal(requests.length - beforeNext, 2);
  assert.equal(list.data.pageNumber, 2);
  assert.equal(new URL(requests.at(-1).url).searchParams.get('q'), '校园%_\\');
  list.onPrevious();
  await flush();
  assert.equal(list.data.pageNumber, 1);
  assert.equal(new URL(requests.at(-1).url).searchParams.get('cursor'), null);
  state.error = 'DISCOVERY_RESTART_REQUIRED';
  list.onNext();
  await flush();
  assert.equal(list.data.restartRequired, true);
  assert.equal(list.data.entries.length, 0);
  assert.ok(presented('list', list).includes('重新加载首批结果'));
  state.error = null;
  list.onRefresh();
  await flush();
  assert.equal(list.data.pageNumber, 1);
  list.onHide();
  list.onShow();
  await flush();
  assert.equal(list.data.inputDraft, '未提交草稿');
  assert.equal(list.data.submittedQuery, '校园%_\\');
  assert.equal(new URL(requests.at(-1).url).searchParams.get('cursor'), null);
  list.onClear();
  await flush();
  assert.equal(list.data.submittedQuery, '');
  state.paging = false;
  state.empty = true;
  list.onRefresh();
  await flush();
  assert.equal(list.data.loaded, true);
  assert.ok(presented('list', list).includes('当前分类暂无条目'));
  list.onInput({ detail: { value: '不存在' } });
  list.onSubmit();
  await flush();
  assert.ok(presented('list', list).includes('没有匹配的名称'));
  state.error = 'DIRECTORY_UNAVAILABLE';
  list.onRefresh();
  await flush();
  assert.equal(list.data.loaded, false);
  assert.ok(presented('list', list).includes('不代表目录为空'));
  state.error = null;
  state.empty = false;
  list.onHide();
  state.regionId = otherRegion;
  list.onShow();
  await flush();
  assert.equal(list.data.loaded, false);
  assert.match(list.data.error, /身份校区/);
  list.onUnload();
  state.regionId = regionId;
  list = mount('list', { regionId, kind: 'org', categoryId });
  await flush();
  list.onInput({ detail: { value: 'private search' } });
  list.onSubmit();
  await flush();
  list.onHide();
  app.identity.sessions.completeLogin(
    app.identity.sessions.beginLogin(),
    original.credentials,
  );
  list.onShow();
  await flush();
  assert.equal(list.data.inputDraft, '');
  assert.equal(list.data.submittedQuery, '');
  list.onUnload();
  const page = mount('detail', route());
  await flush();
  const copyCount = copied.length;
  page.onCopyQq();
  app.identityCampus.onSelectionChanged(original.credentials.accountId);
  await flush();
  assert.equal(copied.length, copyCount);
  assert.equal(page.data.detail, null);
  assert.equal(page.data.canCopy, false);
  page.onRefresh();
  await flush();
  const pending = deferred();
  state.holdContext = pending;
  page.onRefresh();
  await flush();
  page.onHide();
  pending.resolve();
  await flush();
  assert.equal(page.data.detail, null);
  state.holdContext = null;
  page.onShow();
  await flush();
  app.onHide();
  assert.equal(page.data.detail, null);
  page.onHide();
  page.onShow();
  await flush();
  assert.equal(page.data.loaded, true);
  page.onUnload();
  state.galleryKnown = true;
  const gallery = mount('detail', route());
  await flush();
  assert.ok(presented('detail', gallery).includes('没有介绍图片'));
  gallery.onUnload();
  const broken = mount('detail', {});
  await flush();
  assert.equal(broken.data.busy, false);
  assert.match(broken.data.error, /入口/);
  broken.onUnload();
  app.community.directory = original.directory;
  globalThis.wx.navigateTo = original.navigateTo;
  globalThis.wx.setClipboardData = original.setClipboardData;
  console.log(
    'Directory emitted smoke passed: three complete native pages, all kind/platform combinations, independent official badge, live identity context, fresh pagination/search/Back, strict current-DTO QQ copy, explicit unknown/empty/unavailable states, session/scope/hide cancellation and pure authenticated GETs; synthetic conditional model, not physical-device rendering',
  );
}
