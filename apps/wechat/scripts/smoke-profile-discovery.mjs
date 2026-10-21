import { createNativePressBridge } from '../test/native-press-emitted-harness.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  parsePreviewWxml,
  evaluatePreviewExpression,
} from './preview-wxml.mjs';
const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

// Emitted native handlers + real transport/strict decoders. Synthetic API only; not device/provider QA.
export async function smokeProfileDiscovery({
  app,
  dist,
  mountPage,
  flush,
  postWire,
  rootWire,
  replyWire,
}) {
  // Resolve the actual emitted native binding and dispatch through Component.
  // Host datasets stay on the original Page boundary; no direct tap alias.
  let buttonDefinition;
  const previousComponent = globalThis.Component;
  const buttonFile = path.join(dist, 'components/f7-button/f7-button.js');
  globalThis.Component = (definition) => {
    buttonDefinition = definition;
  };
  try {
    delete require.cache[require.resolve(buttonFile)];
    require(buttonFile);
  } finally {
    globalThis.Component = previousComponent;
  }
  assert.ok(buttonDefinition);
  const flatten = (node) => [
    node,
    ...node.children.flatMap((child) =>
      typeof child === 'string' ? [] : flatten(child),
    ),
  ];
  const bindings = flatten(
    parsePreviewWxml(
      readFileSync(
        path.join(dist, 'pages/community-liked/community-liked.wxml'),
        'utf8',
      ),
    ),
  );
  const likedPress = (page, handler, patch = {}) => {
    const node = bindings.find((item) => item.attrs['bind:press'] === handler);
    assert.equal(node?.tag, 'wu-f7-button', handler);
    const scope = { ...page.data, ...patch };
    const evaluate = (value) =>
      value?.startsWith('{{')
        ? evaluatePreviewExpression(value.slice(2, -2), scope)
        : value;
    const dataset = Object.fromEntries(
      Object.entries(node.attrs)
        .filter(([key]) => key.startsWith('data-'))
        .map(([key, value]) => [key.slice(5), evaluate(value)]),
    );
    let dispatched = 0;
    const instance = {
      properties: Object.fromEntries(
        Object.entries(buttonDefinition.properties).map(([name, value]) => [
          name,
          structuredClone(value.value),
        ]),
      ),
      data: structuredClone(buttonDefinition.data),
      setData(patch) {
        Object.assign(this.data, patch);
      },
      triggerEvent(name, detail, options) {
        assert.equal(name, 'press');
        assert.deepEqual(options, { bubbles: false, composed: false });
        dispatched += 1;
        page[handler]({ detail, currentTarget: { dataset } });
      },
    };
    instance.properties.disabled = Boolean(evaluate(node.attrs.disabled));
    instance.properties.loading = Boolean(evaluate(node.attrs.loading));
    buttonDefinition.lifetimes?.attached?.call(instance);
    buttonDefinition.methods.onPress.call(instance);
    buttonDefinition.lifetimes?.detached?.call(instance);
    assert.equal(
      dispatched,
      instance.properties.disabled || instance.properties.loading ? 0 : 1,
    );
  };
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { ClientError } = require(path.join(dist, 'api/errors.js'));
  const { HttpDiscoveryGateway } = require(
    path.join(dist, 'profile/discovery-gateway.js'),
  );
  const { HttpBlockGateway } = require(
    path.join(dist, 'community/block-gateway.js'),
  );
  const { AuthorNavigator } = require(
    path.join(dist, 'profile/author-navigation.js'),
  );
  const original = {
    discovery: app.community.discovery,
    blocks: app.community.blocks,
    gateway: app.community.gateway,
    privacy: app.community.identityPrivacy,
    newRequestId: app.community.newRequestId,
    navigateTo: globalThis.wx.navigateTo,
    credentials: app.identity.sessions.snapshot().credentials,
  };
  assert.ok(original.credentials);
  const profileId = 'abababab-abab-4bab-8bab-abababababab',
    relationshipId = 'acacacac-acac-4cac-8cac-acacacacacac';
  const secondId = 'adadadad-adad-4dad-8dad-adadadadadad',
    anonymousId = 'aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae';
  const author = {
    kind: 'named',
    experienceDisplay: {
      title: { status: 'unavailable', value: null },
      color: { status: 'unavailable', value: null },
      level: { status: 'unavailable', value: null },
    },
    profileId,
    displayName: '合成公开昵称',
    avatar: null,
  };
  const namedPost = () => ({
    ...postWire(),
    component: { kind: 'none' },
    author,
    viewer: { ...postWire().viewer, isSelf: false, canDelete: false },
  });
  const anonymousPost = {
    ...namedPost(),
    id: anonymousId,
    author: postWire().author,
  };
  const basic = () => ({
    status: 'available',
    profileId,
    isOwn: false,
    displayName: author.displayName,
    bio: 'x\u0085y',
    avatar: null,
    affiliation: null,
    publicUid: null,
    schoolUidStatus: 'unavailable',
    experienceDisplay: author.experienceDisplay,
    totalInteractions: null,
    totalInteractionsStatus: 'unavailable',
    postsHidden: hidden,
    postCount: hidden ? 0 : scanMode ? null : 2,
    postCountStatus: hidden || !scanMode ? 'known' : 'unavailable',
    tradeCount: 0,
    tradeCountStatus: 'known',
  });
  const blocked = () => ({
    status: 'blocked_by_you',
    profileId,
    relationship: { relationshipId, blocked: true, revision: String(revision) },
  });
  const like = (id, likeId, likedAt) => ({
    kind: 'post',
    targetId: id,
    postId: id,
    rootCommentId: null,
    likedAt,
    likeId,
    preview: {
      text: '合成点赞历史',
      images: [],
      author,
      createdAt: postWire().publishedAt,
      isSelf: false,
    },
  });
  const requests = [],
    pages = [],
    receipts = new Map(),
    navigation = [];
  let hidden = false,
    isBlocked = false,
    revision = 0,
    loseBlock = true,
    ownRef = profileId,
    sequence = 1,
    scanMode = false,
    expireCursor = false,
    listGate;
  const api = new ApiClient(
    'https://api.example',
    {
      send: async (request) => {
        requests.push(request);
        const url = new URL(request.url);
        const response = (body) => ({ status: 200, headers: {}, body });
        if (url.pathname === '/v1/me/public-profile-ref')
          return response({ profileId: ownRef });
        if (url.pathname === `/v1/profiles/${profileId}`)
          return response(isBlocked ? blocked() : basic());
        if (
          url.pathname === `/v1/profiles/${profileId}/posts` ||
          url.pathname === `/v1/profiles/${profileId}/trading`
        ) {
          assert.equal(request.method, 'GET');
          assert.equal(request.body, undefined);
          const after = url.searchParams.get('cursor');
          if (scanMode && !hidden && !isBlocked) {
            if (after && expireCursor)
              return {
                status: 409,
                headers: {},
                body: { error: { code: 'DISCOVERY_RESTART_REQUIRED' } },
              };
            const n = after ? Number(after.split('_').pop()) : 0;
            return response({
              status: 'available',
              profileId,
              items:
                n < 2
                  ? []
                  : [
                      {
                        ...namedPost(),
                        id: secondId,
                        publishedAt: '2001-01-01T00:00:00.000Z',
                      },
                    ],
              total: null,
              totalStatus: 'unavailable',
              nextCursor: n < 2 ? `profile_scan_${n + 1}` : null,
              continuation: n < 2 ? 'scan_pending' : 'end',
            });
          }
          const body = isBlocked
            ? blocked()
            : hidden
              ? {
                  status: 'hidden',
                  profileId,
                  items: [],
                  total: 0,
                  totalStatus: 'known',
                  nextCursor: null,
                  continuation: 'end',
                }
              : {
                  status: 'available',
                  profileId,
                  items: url.pathname.endsWith('/trading')
                    ? []
                    : [
                        {
                          ...namedPost(),
                          id: after ? secondId : namedPost().id,
                        },
                      ],
                  total: url.pathname.endsWith('/trading') ? 0 : 2,
                  totalStatus: 'known',
                  continuation:
                    after || url.pathname.endsWith('/trading') ? 'end' : 'more',
                  nextCursor:
                    after || url.pathname.endsWith('/trading')
                      ? null
                      : 'profile_second',
                };
          if (listGate) {
            const gate = listGate;
            listGate = undefined;
            await gate.promise;
          }
          return response(body);
        }
        if (url.pathname === '/v1/me/community/liked') {
          const after = url.searchParams.get('cursor');
          if (scanMode) {
            if (after && expireCursor)
              return {
                status: 409,
                headers: {},
                body: { error: { code: 'DISCOVERY_RESTART_REQUIRED' } },
              };
            const n = after ? Number(after.split('_').pop()) : 0;
            return response({
              items: n < 2 ? [] : [like(secondId, anonymousId, null)],
              visibleLikedCount: null,
              visibleLikedCountStatus: 'unavailable',
              nextCursor: n < 2 ? `liked_scan_${n + 1}` : null,
              continuation: n < 2 ? 'scan_pending' : 'end',
            });
          }
          return response({
            items: [
              like(
                after ? secondId : namedPost().id,
                after ? anonymousId : relationshipId,
                after ? null : postWire().publishedAt,
              ),
            ],
            visibleLikedCount: 2,
            visibleLikedCountStatus: 'known',
            nextCursor: after ? null : 'liked_second',
            continuation: after ? 'end' : 'more',
          });
        }
        if (url.pathname.startsWith('/v1/me/safety/block-requests/'))
          return response(receipts.get(url.pathname.split('/').pop()));
        if (url.pathname.startsWith('/v1/me/safety/blocks')) {
          assert.equal(request.method, 'PUT');
          const intent = request.body;
          const block = intent.blocked;
          if (block)
            assert.deepEqual(intent.source, { kind: 'profile', id: profileId });
          else assert.equal(intent.expectedRevision, String(revision));
          isBlocked = block;
          revision++;
          const receipt = {
            requestId: intent.clientRequestId,
            operation: block ? 'block_named' : 'unblock_named',
            outcome: 'applied',
            relationshipId,
            blocked: block,
            revision: String(revision),
          };
          const result = {
            receipt,
            current: {
              relationshipId,
              blocked: block,
              revision: String(revision),
            },
          };
          receipts.set(intent.clientRequestId, result);
          if (block && loseBlock) {
            loseBlock = false;
            throw new ClientError('network', 'Synthetic response lost');
          }
          return response(result);
        }
        throw new Error(`Unexpected synthetic request ${url.pathname}`);
      },
    },
    app.identity.sessions,
    {
      refresh: async () => {
        throw new Error('No refresh expected');
      },
    },
  );
  app.community.discovery = new HttpDiscoveryGateway(api);
  app.community.blocks = new HttpBlockGateway(api);
  app.community.gateway = {};
  app.community.identityPrivacy = undefined;
  app.community.newRequestId = async () =>
    `bcbcbcbc-bcbc-4cbc-8cbc-${String(sequence++).padStart(12, '0')}`;
  globalThis.wx.navigateTo = (options) => navigation.push(options);
  const personalBridges = new Map();
  const personalPress = (page, handler, dataset = {}) => {
    const bridge = personalBridges.get(page);
    if (!bridge.find(handler, dataset)) return false;
    const control = bridge.capture(handler, dataset);
    try {
      return control.press();
    } finally {
      control.detach();
    }
  };
  const mount = (route, query) => {
    const page = mountPage(
      path.join(dist, `pages/${route}/${route}.js`),
      query,
    );
    pages.push(page);
    if (route === 'public-profile')
      personalBridges.set(
        page,
        createNativePressBridge({
          page,
          pageFile: path.join(dist, 'pages/public-profile/public-profile'),
          dist,
        }),
      );
    return page;
  };
  try {
    const page = mount('public-profile', { profileId });
    await flush();
    assert.equal(page.data.profile.status, 'available');
    assert.equal(page.data.profile.bio, 'x\u0085y');
    personalPress(page, 'onMore');
    personalPress(page, 'onMore');
    await flush();
    assert.equal(page.data.pageNumber, 2);
    assert.deepEqual(
      page.data.items.map((x) => x.id),
      [secondId],
    );
    hidden = true;
    personalPress(page, 'onPrevious');
    await flush();
    assert.equal(page.data.profile.postsHidden, true);
    assert.equal(page.data.profile.postCount, 0);
    assert.deepEqual(page.data.items, []);
    const count = requests.length;
    page.onPrevious(); // Hidden-post negative controller probe.
    assert.equal(requests.length, count);
    hidden = false;
    personalPress(page, 'onReload');
    await flush();
    page.onProfileDetails(); // aria-expanded disclosure remains a native control.
    personalPress(page, 'onBlockProfile');
    assert.deepEqual(page.data.block.confirmSource, {
      kind: 'profile',
      id: profileId,
    });
    page.onConfirmBlock();
    assert.equal(page.data.profile, null);
    page.onConfirmBlock();
    await flush();
    assert.equal(page.data.block.frozen, true);
    assert.equal(page.data.profile, null);
    const lostCount = requests.length;
    page.onReload();
    page.onMore();
    page.onPrevious(); // Deliberate negative controller probes while block recovery is frozen.
    await flush();
    assert.equal(requests.length, lostCount);
    personalPress(page, 'onBlockReceipt');
    await flush();
    assert.equal(page.data.block.frozen, false);
    assert.equal(page.data.profile.status, 'blocked_by_you');
    assert.equal(
      JSON.stringify(page.data.profile).includes(author.displayName),
      false,
    );
    personalPress(page, 'onUnblockProfile');
    await flush();
    assert.equal(page.data.profile.status, 'available');
    assert.equal(page.data.items.length, 1);
    listGate = deferred();
    const gate = listGate;
    personalPress(page, 'onMore');
    await flush();
    page.onHide();
    assert.equal(page.data.profile, null);
    gate.resolve();
    await flush();
    assert.deepEqual(page.data.items, []);
    page.onShow();
    await flush();
    assert.equal(page.data.pageNumber, 1);
    page.onUnload();
    scanMode = true;
    for (const route of ['public-profile', 'community-liked']) {
      const scan = mount(
        route,
        route === 'public-profile' ? { profileId } : undefined,
      );
      await flush();
      assert.equal(scan.data.loaded, true);
      assert.equal(scan.data.continuation, 'scan_pending');
      assert.equal(scan.data.canLoadMore, true);
      assert.deepEqual(scan.data.items, []);
      assert.doesNotMatch(scan.data.status, /当前没有/);
      if (route === 'public-profile') {
        assert.equal(scan.data.profile.postCount, null);
        assert.equal(scan.data.profile.postCountStatus, 'unavailable');
        assert.equal(scan.data.total, null);
      } else assert.equal(scan.data.visibleLikedCount, null);
      const before = requests.length;
      await flush();
      assert.equal(
        requests.length,
        before,
        'No automatic polling through hidden batches',
      );
      if (route === 'community-liked') likedPress(scan, 'onMore');
      else personalPress(scan, 'onMore');
      if (route === 'community-liked') likedPress(scan, 'onMore');
      else personalPress(scan, 'onMore');
      await flush();
      assert.equal(scan.data.pageNumber, 2);
      assert.equal(scan.data.continuation, 'scan_pending');
      assert.deepEqual(scan.data.items, []);
      if (route === 'community-liked') likedPress(scan, 'onMore');
      else personalPress(scan, 'onMore');
      await flush();
      assert.equal(scan.data.pageNumber, 3);
      assert.equal(scan.data.items.length, 1);
      assert.equal(scan.data.continuation, 'end');
      assert.equal(scan.data.canLoadMore, false);
      if (route === 'community-liked')
        assert.equal(scan.data.items[0].likedAt, null);
      else
        assert.equal(
          scan.data.items[0].publishedAt,
          '2001-01-01T00:00:00.000Z',
        );
      if (route === 'community-liked') likedPress(scan, 'onPrevious');
      else personalPress(scan, 'onPrevious');
      await flush();
      assert.deepEqual(scan.data.items, []);
      assert.equal(scan.data.continuation, 'scan_pending');
      expireCursor = true;
      if (route === 'community-liked') likedPress(scan, 'onMore');
      else personalPress(scan, 'onMore');
      await flush();
      assert.equal(scan.data.loaded, false);
      assert.equal(scan.data.continuation, null);
      assert.equal(scan.data.canLoadMore, false);
      assert.match(scan.data.status, /分页已失效/);
      assert.deepEqual(scan.data.items, []);
      expireCursor = false;
      if (route === 'community-liked') likedPress(scan, 'onReload');
      else personalPress(scan, 'onReload');
      await flush();
      assert.equal(scan.data.pageNumber, 1);
      assert.equal(scan.data.continuation, 'scan_pending');
      scan.onHide();
      assert.equal(scan.data.continuation, null);
      assert.deepEqual(scan.data.items, []);
      scan.onUnload();
    }
    scanMode = false;
    ownRef = null;
    const own = mount('public-profile', {});
    await flush();
    assert.equal(own.data.noProfile, true);
    assert.equal(own.data.total, null);
    assert.equal(own.data.profile, null);
    own.onUnload();
    const likes = mount('community-liked');
    await flush();
    assert.equal(likes.data.items.length, 1);
    likedPress(likes, 'onMore');
    await flush();
    assert.equal(likes.data.items[0].likedAt, null);
    assert.equal(likes.data.pageNumber, 2);
    likedPress(likes, 'onPrevious');
    await flush();
    assert.equal(likes.data.pageNumber, 1);
    assert.equal(likes.data.items.length, 1);
    app.onHide();
    assert.deepEqual(likes.data.items, []);
    assert.equal(likes.data.visibleLikedCount, null);
    likes.onUnload();
    // Register real emitted handlers with already-decoded current content; event data never supplies the profile ID.
    const register = (route, data) => {
      let page;
      const previous = globalThis.Page;
      globalThis.Page = (value) => {
        page = value;
      };
      const module = path.join(dist, `pages/${route}/${route}.js`);
      delete require.cache[require.resolve(module)];
      require(module);
      globalThis.Page = previous;
      page.data = { ...page.data, ...data };
      page.setData = (patch) => {
        page.data = { ...page.data, ...patch };
      };
      page.authorNavigator = new AuthorNavigator(globalThis.wx);
      pages.push(page);
      return page;
    };
    const event = (id, kind) => ({
      currentTarget: {
        dataset: { id, kind, profileId: secondId, accountId: secondId },
      },
    });
    const root = {
      ...rootWire(),
      author,
      replyPreview: { items: [{ ...replyWire(), author }], nextCursor: null },
    };
    const reply = {
      ...replyWire(),
      author,
      target: { kind: 'comment', id: root.id, status: 'available', author },
    };
    const cases = [
      [
        'community-feed',
        { posts: [namedPost(), anonymousPost] },
        event(namedPost().id),
        event(anonymousId),
      ],
      [
        'community-saved',
        { items: [{ post: namedPost() }, { post: anonymousPost }] },
        event(namedPost().id),
        event(anonymousId),
      ],
      [
        'community-mine',
        { tradingPosts: [namedPost(), anonymousPost] },
        event(namedPost().id),
        event(anonymousId),
      ],
      [
        'community-detail',
        {
          post: namedPost(),
          comments: [root],
          formationView: {
            loaded: true,
            busy: false,
            formation: {
              members: [
                { id: secondId, author },
                { id: anonymousId, author: postWire().author },
              ],
            },
          },
        },
        event(secondId, 'member'),
        event(anonymousId, 'member'),
      ],
      [
        'community-thread',
        {
          post: namedPost(),
          root,
          replies: [
            reply,
            { ...reply, id: anonymousId, author: postWire().author },
          ],
          contextReplies: [],
        },
        event(reply.id, 'reply'),
        event(anonymousId, 'reply'),
      ],
    ];
    for (const [route, data, allowed, denied] of cases) {
      const page = register(route, {
        ...data,
        loaded: true,
        busy: false,
        needsReload: false,
        identityOverlay: { items: { [anonymousId]: { profileId } } },
      });
      const before = navigation.length;
      page.onAuthor(denied);
      page.onAuthor(event('forged', 'post'));
      assert.equal(navigation.length, before);
      page.onAuthor(allowed);
      page.onAuthor(allowed);
      assert.equal(navigation.length, before + 1);
      assert.equal(
        navigation[before].url,
        `/pages/public-profile/public-profile?profileId=${profileId}`,
      );
      navigation[before].success();
      page.onHide();
      page.onAuthor(allowed);
      assert.equal(navigation.length, before + 1);
    }
    const template = readFileSync(
      path.join(dist, 'pages/community-liked/community-liked.wxml'),
      'utf8',
    );
    assert.match(template, /时间未知/);
    assert.match(template, /准确总数暂不可用/);
    assert.match(template, /continuation === 'end'/);
    assert.match(template, /scan_pending.*继续查看/);
    assert.equal(
      /rich-text|style="\{\{|openid|studentNumber/.test(template),
      false,
    );
    const profileTemplate = readFileSync(
      path.join(dist, 'pages/public-profile/public-profile.wxml'),
      'utf8',
    );
    assert.match(profileTemplate, /上一页/);
    assert.match(profileTemplate, /下一页/);
    assert.match(profileTemplate, /总数暂不可用/);
    assert.match(profileTemplate, /continuation === 'end'/);
    assert.match(profileTemplate, /scan_pending.*继续查看/);
    assert.equal(
      /加载更多|累计|lifetime|rich-text|style="\{\{/.test(profileTemplate),
      false,
    );
    assert.equal(
      requests.some(
        (r) => r.method === 'PUT' && !r.url.includes('/safety/blocks'),
      ),
      false,
    );
  } finally {
    for (const page of pages) page.onUnload?.();
    app.community.discovery = original.discovery;
    app.community.blocks = original.blocks;
    app.community.gateway = original.gateway;
    app.community.identityPrivacy = original.privacy;
    app.community.newRequestId = original.newRequestId;
    globalThis.wx.navigateTo = original.navigateTo;
    app.identity.sessions.completeLogin(
      app.identity.sessions.beginLogin(),
      original.credentials,
    );
  }
  console.log(
    'Public-profile compiled native smoke passed: strict nullable counts and manual scan continuation, privacy-aware next/previous, explicit expired-cursor reload, null self-ref, old and undated history, profile-sourced lost-response block recovery, hide clearing and canonical named-only author navigation',
  );
}
