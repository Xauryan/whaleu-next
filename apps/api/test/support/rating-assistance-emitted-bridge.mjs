/** Loads only the built client. This bridge replaces wx platform I/O, never a
 * gateway, controller, Review decision, server resolver or publication owner. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as nodeRequest } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, render } from '../../../wechat/scripts/smoke-ratings.mjs';
const require = createRequire(import.meta.url);
const nativeRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../wechat',
);
const dist = path.resolve(
  process.env.WHALEU_WECHAT_DIST ?? path.join(nativeRoot, 'dist'),
);
const origin = 'https://native-rating-assistance.invalid';
const emitted = (name) => require(path.join(dist, `${name}.js`));
const flatten = (nodes) =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [node] : [node, ...flatten(node.children)],
  );
function expanded(file) {
  assert.ok(
    file.startsWith(`${dist}${path.sep}`),
    'WXML stays inside emitted output',
  );
  return readFileSync(file, 'utf8').replace(
    /<include\s+src="([^"]+)"\s*\/>/g,
    (_all, src) => expanded(path.resolve(path.dirname(file), src)),
  );
}
export function emittedAssistanceClient(f, actor = f.creator) {
  const { SessionStore } = emitted('auth/session');
  const { AuthService } = emitted('auth/auth-service');
  const { HttpAuthGateway } = emitted('auth/http-auth-gateway');
  const { ApiClient } = emitted('api/client');
  const { WechatTransport } = emitted('platform/wechat');
  const { systemClock } = emitted('platform/clock');
  const { createCommunityRuntime } = emitted('community/runtime');
  const values = new Map(),
    navigations = [],
    exchanges = [],
    failures = [],
    pages = [];
  let activeRequests = 0;
  const previous = {
    Page: globalThis.Page,
    wx: globalThis.wx,
    getApp: globalThis.getApp,
  };
  const wx = {
    getStorageSync: (key) => structuredClone(values.get(key)),
    setStorageSync: (key, value) => values.set(key, structuredClone(value)),
    removeStorageSync: (key) => values.delete(key),
    getRandomValues: (input) =>
      input.success({
        randomValues: Uint8Array.from(randomBytes(input.length)).buffer,
      }),
    navigateTo: (input) => {
      navigations.push(input.url);
      input.success?.();
    },
    request(input) {
      const url = new URL(input.url);
      assert.equal(
        url.origin,
        origin,
        'Loopback fixture is the only network destination',
      );
      const body =
        input.data === undefined ? undefined : JSON.stringify(input.data);
      activeRequests++;
      let completed = false;
      const finish = () => {
        if (!completed) {
          completed = true;
          activeRequests--;
        }
      };
      const req = nodeRequest(
        {
          hostname: '127.0.0.1',
          port: f.port,
          path: `${url.pathname}${url.search}`,
          method: input.method,
          headers: {
            ...input.header,
            ...(body === undefined
              ? {}
              : { 'content-length': Buffer.byteLength(body) }),
          },
          agent: false,
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.once('error', () => {
            finish();
            input.fail({ errMsg: 'Local HTTP read failed' });
          });
          response.once('end', () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const headers = Object.fromEntries(
                Object.entries(response.headers)
                  .filter(([, v]) => v !== undefined)
                  .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]),
              );
              const status = response.statusCode ?? 0;
              // No query strings, tokens or request/response bodies in transport evidence.
              exchanges.push({
                path: url.pathname,
                method: input.method,
                authorized: Object.entries(input.header).some(
                  ([key, value]) =>
                    key.toLowerCase() === 'authorization' &&
                    value === `Bearer ${actor.accessToken}`,
                ),
                status,
              });
              if (url.pathname.startsWith('/v2/ratings/assistance/')) {
                assert.equal(headers['cache-control'], 'no-store');
                assert.match(headers.vary ?? '', /\bAuthorization\b/i);
              }
              finish();
              input.success({
                statusCode: status,
                header: headers,
                data: raw === '' ? '' : JSON.parse(raw),
              });
            } catch (error) {
              failures.push(error);
              finish();
              input.fail({ errMsg: 'Local response contract failed' });
            }
          });
        },
      );
      req.once('error', () => {
        finish();
        input.fail({ errMsg: 'Local HTTP request failed' });
      });
      req.setTimeout(input.timeout, () => req.destroy());
      if (body !== undefined) req.write(body);
      req.end();
      return { abort: () => req.destroy() };
    },
  };
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), actor);
  const transport = new WechatTransport(wx, systemClock);
  const auth = new AuthService(
    sessions,
    new HttpAuthGateway(origin, transport, systemClock),
    {
      login: async () => {
        throw Error('External login is not part of a disposable fixture');
      },
    },
    systemClock,
  );
  const api = new ApiClient(origin, transport, sessions, auth);
  const runtime = createCommunityRuntime({ sessions, api }, wx, origin);
  globalThis.wx = wx;
  globalThis.getApp = () => ({ community: runtime });
  const idle = async (page) => {
    let stable = 0;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await delay(20);
      if (failures.length) throw failures[0];
      if (
        activeRequests === 0 &&
        !page?.data.busy &&
        !page?.data.assistance?.busy
      )
        stable++;
      else stable = 0;
      if (stable >= 3) return;
    }
    assert.fail(
      `Emitted page did not settle: ${page?.data.status ?? ''}; ${page?.data.error ?? ''}`,
    );
  };
  function mount(name) {
    let page;
    globalThis.Page = (value) => {
      page = value;
    };
    const file = path.join(dist, `pages/${name}/${name}.js`);
    delete require.cache[require.resolve(file)];
    require(file);
    assert.ok(page, `actual emitted ${name} Page registered`);
    page.patches = [];
    page.setData = (patch, done) => {
      page.patches.push(structuredClone(patch));
      page.data = { ...page.data, ...patch };
      done?.();
    };
    const templates = {},
      visited = new Set();
    function tree(file) {
      if (visited.has(file)) return null;
      visited.add(file);
      const parsed = parse(expanded(file));
      for (const node of flatten(parsed.children))
        if (typeof node !== 'string') {
          if (node.tag === 'import')
            tree(path.resolve(path.dirname(file), node.attrs.src));
          if (node.tag === 'template' && node.attrs.name)
            templates[node.attrs.name] = node;
        }
      return parsed;
    }
    const parsed = tree(path.join(dist, `pages/${name}/${name}.wxml`));
    const nodes = () =>
      flatten(
        render(
          parsed.children.filter(
            (n) =>
              typeof n === 'string' || n.tag !== 'template' || !n.attrs.name,
          ),
          page.data,
          templates,
        ),
      );
    const event = async (handler, dataset = {}, value = '') => {
      const control = nodes().find(
        (node) =>
          typeof node !== 'string' &&
          (node.attrs.bindtap === handler ||
            node.attrs.bindinput === handler) &&
          Object.entries(dataset).every(
            ([k, v]) => node.attrs[`data-${k}`] === String(v),
          ),
      );
      assert.ok(
        control,
        `emitted ${name} WXML renders ${handler}: ${page.data.error}`,
      );
      assert.notEqual(control.attrs.disabled, 'true', `${handler} is enabled`);
      assert.equal(typeof page[handler], 'function');
      await page[handler]({ currentTarget: { dataset }, detail: { value } });
      await idle(page);
    };
    const show = async (query) => {
      page.onLoad(query);
      page.onShow();
      await idle(page);
      assert.equal(page.data.error, '', `${name} loads current owner state`);
    };
    const hide = () => {
      page.onHide?.();
      page.onUnload?.();
    };
    const mounted = { page, nodes, event, show, hide };
    pages.push(mounted);
    return mounted;
  }
  return {
    runtime,
    sessions,
    values,
    navigations,
    exchanges,
    mount,
    idle,
    close() {
      for (const p of pages) p.hide();
      Object.assign(globalThis, previous);
    },
  };
}
export function assertPrivateNativeProjection(page) {
  for (const patch of page.patches)
    assert.doesNotMatch(
      JSON.stringify(patch),
      /"contextToken"|"tokenDigest"|"accessToken"|"refreshToken"|"inputDigest"|"resultDigest"/,
    );
}

/** Synthetic model output is the only injected business dependency. Every
 * authority, preparation, approval, read and publication below is real HTTP/PG. */
export async function runAssistanceNativeRoundtrip(t, f, provider) {
  const native = emittedAssistanceClient(f);
  t.after(() => native.close());
  const actor = f.creator;
  const count = (path) =>
    native.exchanges.filter((e) => e.path === path).length;
  const assertMetadataOnly = () => {
    const journal = native.runtime.pendingAssistance.load(actor.accountId);
    assert.ok(journal);
    assert.doesNotMatch(
      JSON.stringify(journal),
      /共同分享|这门课程|独立正文|原始简介|"text"|"input"|"context"|"token"/,
    );
    return journal;
  };
  await t.test(
    'emitted root editor generates, rereads on explicit adoption, edits, prepares and commits through its existing owner',
    async () => {
      const h = native.mount('rating-category-editor');
      await h.show({ scope: 'campus', campusId: f.campusA });
      await h.event('onOperation', { operation: 'create_categories_scoped' });
      await h.event('onNodeText', { key: 'n0', field: 'name' }, '原生建议分类');
      await h.event(
        'onNodeText',
        { key: 'n0', field: 'description' },
        '原始简介',
      );
      await h.event('onGenerateDescription', { key: 'n0' });
      assert.equal(h.page.data.nodes[0].description, '原始简介');
      assert.equal(h.page.data.assistance.preview, '共同分享真实课程体验');
      assert.equal(native.runtime.pendingRatings.load(actor.accountId), null);
      const suggestion = assertMetadataOnly(),
        resultPath = `/v2/ratings/assistance/requests/${suggestion.requestId}/result`;
      assert.equal(count(resultPath), 1);
      assert.equal(provider.sends.length, 1);
      await h.event('onAdoptDescription');
      assert.equal(
        count(resultPath),
        2,
        'adoption requires a fresh owner-qualified result read',
      );
      assert.equal(h.page.data.nodes[0].description, '共同分享真实课程体验');
      await h.event(
        'onNodeText',
        { key: 'n0', field: 'description' },
        '采用以后手动编辑',
      );
      assert.equal(
        h.page.data.assistance.preview,
        '',
        'editing clears the adopted suggestion panel',
      );
      await h.event('onPrepare');
      const pending = native.runtime.pendingRatings.load(actor.accountId);
      assert.ok(
        pending,
        'the existing category owner freezes its own exact command',
      );
      assert.equal(pending.intent.operation, 'create_categories_scoped');
      assert.equal(
        pending.intent.payload.nodes[0].description,
        '采用以后手动编辑',
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
            [actor.accountId, pending.intent.payload.clientRequestId],
          )
        ).rows[0].n,
        0,
        'preparation is not publication',
      );
      await f.approveManagement(actor, pending.intent);
      await h.event('onCommit');
      assert.equal(native.runtime.pendingRatings.load(actor.accountId), null);
      const receipt = (
        await f.pool.query(
          'SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, pending.intent.payload.clientRequestId],
        )
      ).rows[0]?.receipt;
      assert.equal(receipt?.outcome, 'applied');
      assert.ok(h.page.data.receiptStatus);
      assertPrivateNativeProjection(h.page);
      h.hide();
      assert.equal(h.page.data.assistance.preview, '');
    },
  );
  let target, postId, published, pending;
  await t.test(
    'source-backed inherited course entry hands off IDs, adopts an optional label, then uses actual v5 Review and explicit publication',
    async () => {
      const category = await f.createLinkCategory('course', true);
      target = await f.createLinkTarget(category, '🐳'.repeat(13));
      const entry = native.mount('rating-scoped');
      await entry.show({
        mode: 'detail',
        scope: 'campus',
        campusId: f.campusA,
        targetId: target.id,
      });
      await entry.event('onRatingLinkCompose');
      const route = native.navigations.at(-1);
      assert.ok(
        route.startsWith('/pages/community-compose/community-compose?'),
      );
      assert.doesNotMatch(route, /🐳|共同分享|name=|label=|token/i);
      const query = Object.fromEntries(
        new URL(`https://fixture.invalid${route}`).searchParams,
      );
      assert.equal(query.ratingActorId, actor.accountId);
      assert.equal(query.ratingTargetId, target.id);
      entry.hide();
      const h = native.mount('community-compose');
      await h.show(query);
      assert.equal(h.page.data.ratingLinkLabel, '🐳'.repeat(12));
      assert.equal(h.page.data.text, '');
      await h.event('onText', {}, '独立正文由用户明确填写');
      await h.event('onGenerateRatingLabel');
      assert.equal(
        h.page.data.ratingLinkLabel,
        '🐳'.repeat(12),
        'generation never auto-overwrites',
      );
      assert.equal(h.page.data.text, '独立正文由用户明确填写');
      assert.equal(h.page.data.assistance.preview, '这门课程怎么样？');
      const suggestion = assertMetadataOnly(),
        resultPath = `/v2/ratings/assistance/requests/${suggestion.requestId}/result`;
      assert.equal(count(resultPath), 1);
      await h.event('onAdoptRatingLabel');
      assert.equal(count(resultPath), 2);
      assert.equal(h.page.data.ratingLinkLabel, '这门课程怎么样？');
      await h.event('onRatingLabel', {}, '手动编辑后的标签');
      assert.equal(provider.sends.length, 2);
      await h.event('onSubmit');
      pending = native.runtime.pendingRatingLinks.load(actor.accountId);
      assert.ok(pending);
      assert.equal(pending.kind, 'community_rating_target_link_v5');
      assert.equal(pending.version, 5);
      assert.equal(native.runtime.pending.load(actor.accountId), null);
      assert.equal(h.page.data.reviewStatus, 'pending');
      assert.equal(h.page.data.assistance.preview, '');
      assert.equal(
        h.page.data.text,
        '',
        'frozen v5 recovery displays no identifying body',
      );
      assert.equal(h.page.data.ratingLinkLabel, '');
      assert.equal(
        count('/v1/community/posts'),
        0,
        'Review queueing never auto-publishes',
      );
      const exact = (
        await f.pool.query(
          'SELECT envelope FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [actor.accountId, pending.payload.clientRequestId],
        )
      ).rows[0].envelope;
      assert.equal(exact.version, 5);
      assert.equal(exact.component.binding.ancestry.length, 3);
      assert.equal(exact.component.label, '手动编辑后的标签');
      assert.equal(exact.text, '独立正文由用户明确填写');
      await f.approveLinkCommunity(actor, pending.payload.clientRequestId);
      assert.equal(
        count('/v1/community/posts'),
        0,
        'local approval alone never publishes',
      );
      await h.event('onRetry');
      postId = h.page.data.resourceId;
      assert.ok(postId, h.page.data.error);
      assert.equal(h.page.data.status, '发布成功');
      assert.equal(
        native.runtime.pendingRatingLinks.load(actor.accountId),
        null,
      );
      published = structuredClone(pending.payload);
      assert.equal(published.component.label, '手动编辑后的标签');
      assertPrivateNativeProjection(entry.page);
      assertPrivateNativeProjection(h.page);
      h.hide();
    },
  );
  await t.test(
    'emitted post WXML resolves accepted current target metadata and navigates by safe IDs without rewriting the original receipt or authored text',
    async () => {
      assert.ok(target && postId && published && pending);
      const original = (
        await f.pool.query(
          'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
          [actor.accountId, published.clientRequestId],
        )
      ).rows[0].receipt;
      const h = native.mount('community-detail');
      await h.show({ postId });
      assert.equal(h.page.data.post.component.kind, 'rating_target_link');
      assert.equal(h.page.data.post.component.target.name, '🐳'.repeat(13));
      assert.equal(h.page.data.post.component.label, published.component.label);
      h.hide();
      await f.editLinkTarget(target.id, '已通过审核的课程新名称');
      const fresh = native.mount('community-detail');
      await fresh.show({ postId });
      assert.equal(
        fresh.page.data.post.component.target.name,
        '已通过审核的课程新名称',
      );
      assert.equal(fresh.page.data.post.text, published.text);
      assert.equal(
        fresh.page.data.post.component.label,
        published.component.label,
      );
      const text = fresh
        .nodes()
        .filter((n) => typeof n === 'string')
        .join(' ');
      assert.match(text, /已通过审核的课程新名称/);
      assert.match(text, /手动编辑后的标签/);
      await fresh.event('onRatingTargetLink', { id: postId });
      assert.equal(
        native.navigations.at(-1),
        `/pages/rating-scoped/rating-scoped?mode=detail&scope=campus&campusId=${f.campusA}&targetId=${target.id}`,
      );
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, published.clientRequestId],
          )
        ).rows[0].receipt,
        original,
      );
      assertPrivateNativeProjection(fresh.page);
      assert.ok(
        native.exchanges.every(
          (e) =>
            e.authorized ||
            (e.method === 'GET' &&
              [
                '/v1/campuses',
                '/v1/profile-avatar-catalog',
                '/v1/community/spaces',
              ].includes(e.path)),
        ),
        `all feature requests use the real session; only existing public catalogs omit it: ${JSON.stringify(native.exchanges.filter((e) => !e.authorized))}`,
      );
      assert.equal(
        provider.sends.length,
        2,
        'post reads and navigation never trigger generation',
      );
      fresh.hide();
    },
  );
}
