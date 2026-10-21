import { createRatingEmittedBridge } from './rating-native-emitted-harness.mjs';
import { createRecoveryPressBridge } from './framework7-rating-recovery-native-harness.mjs';
/** Actual emitted Pages and emitted WXML; synthetic API owners only, no model or device claims. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, render } from '../scripts/smoke-ratings.mjs';
const require = createRequire(import.meta.url),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(
  process.env.WHALEU_WECHAT_DIST ?? path.join(root, 'dist'),
);
const emitted = (name) => require(path.join(dist, `${name}.js`));
const { SessionStore } = emitted('auth/session');
const { ClientError } = emitted('api/errors');
const { PendingRatingStore } = emitted('ratings/pending');
const { PendingAssistanceStore } = emitted('ratings/assistance-pending');
const { PendingRatingLinkStore } = emitted('community/rating-link-pending');
const { assistanceIntentHash } = emitted('ratings/assistance-contract');
const { batchPublicationReference } = emitted('media/batch-publication');
const {
  categoryScopedHarness,
  managedCampus,
} = require('./category-scoped-helpers.ts');
const { categoryTestId } = require('./category-management-helpers.ts');
const {
  FakeScopedGateway,
  scopedContext,
} = require('./rating-scoped-helpers.ts');
const { target, targetId, revision } = require('./ratings-helpers.ts');
const { capabilities, post, postId } = require('./community-helpers.ts');
const { wireCredentials } = require('./identity-helpers.ts');
const drain = async () => {
  for (let i = 0; i < 400; i++) await Promise.resolve();
};
const flatten = (nodes) =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [node] : [node, ...flatten(node.children)],
  );
function expanded(file) {
  assert.ok(file.startsWith(`${dist}${path.sep}`));
  return readFileSync(file, 'utf8').replace(
    /<include\s+src="([^"]+)"\s*\/>/g,
    (_all, src) => expanded(path.resolve(path.dirname(file), src)),
  );
}
// Only the two category wrappers use the exact static include projection. Keep
// the native Input boundary separate from the retained raw textarea events.
function categoryControls(page, pageFile, nodes) {
  assert.ok(
    ['rating-category-editor', 'rating-category-manage'].includes(
      path.basename(pageFile),
    ),
  );
  const press = createRecoveryPressBridge({ page, pageFile, dist });
  let visible = true,
    attached = true;
  for (const [method, lifecycle] of [
    ['onShow', 'show'],
    ['onHide', 'hide'],
    ['onUnload', 'detach'],
  ]) {
    const original = page[method];
    page[method] = function (...args) {
      // Category onShow first clears its prior controller through onHide.
      // Deliver the new Component show only after that reset has finished.
      if (lifecycle === 'show') {
        const result = original?.apply(this, args);
        visible = attached;
        press.lifecycle('show');
        return result;
      }
      visible = false;
      if (lifecycle === 'detach') attached = false;
      press.lifecycle(lifecycle);
      if (lifecycle === 'detach') press.disposeProjection();
      return original?.apply(this, args);
    };
  }
  const originalSetData = page.setData;
  page.setData = function (...args) {
    const result = originalSetData.apply(this, args);
    press.sync();
    return result;
  };
  return {
    tap(handler, dataset) {
      if (!visible || !attached || !press.find(handler, dataset)) return false;
      const control = press.capture(handler, dataset);
      try {
        return control.press();
      } finally {
        control.detach();
      }
    },
    input(handler, value, dataset) {
      if (!visible || !attached) return false;
      const node = nodes().find(
        (node) =>
          typeof node !== 'string' &&
          node.tag === 'wu-f7-input' &&
          node.attrs['bind:input'] === handler &&
          Object.entries(dataset).every(
            ([key, v]) => node.attrs[`data-${key}`] === String(v),
          ),
      );
      assert.ok(node, `Actual category native Input ${handler}`);
      const config = JSON.parse(readFileSync(`${pageFile}.json`, 'utf8'));
      const relative = config.usingComponents?.[node.tag];
      assert.ok(relative, 'Actual registered category input component');
      const component = path.resolve(path.dirname(pageFile), relative);
      assert.equal(component, path.join(dist, 'components/f7-input/f7-input'));
      let definition;
      const previous = globalThis.Component;
      globalThis.Component = (registered) => {
        definition = registered;
      };
      try {
        delete require.cache[require.resolve(`${component}.js`)];
        require(`${component}.js`);
      } finally {
        if (previous === undefined) delete globalThis.Component;
        else globalThis.Component = previous;
      }
      assert.ok(definition, 'Actual emitted category Input registration');
      const properties = Object.fromEntries(
        Object.entries(definition.properties).map(([key, property]) => {
          const raw =
            node.attrs[
              key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
            ];
          return [
            key,
            raw === undefined
              ? structuredClone(property.value)
              : property.type === Boolean
                ? raw === 'true' || raw === ''
                : property.type === Number
                  ? Number(raw)
                  : raw,
          ];
        }),
      );
      const fullDataset = Object.fromEntries(
        Object.entries(node.attrs)
          .filter(([key]) => key.startsWith('data-'))
          .map(([key, value]) => [
            key
              .slice(5)
              .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
            value,
          ]),
      );
      let emissions = 0;
      const instance = {
        properties,
        data: structuredClone(definition.data),
        ...definition.methods,
        setData(patch) {
          Object.assign(this.data, patch);
        },
        triggerEvent(type, detail, options) {
          assert.equal(type, 'input');
          assert.deepEqual(options, { bubbles: false, composed: false });
          assert.equal(detail.value, value, 'Native input buffer is unchanged');
          emissions++;
          page[handler]({ detail, currentTarget: { dataset: fullDataset } });
        },
      };
      definition.lifetimes.attached.call(instance);
      try {
        const inner = flatten(
          render(
            parse(readFileSync(`${component}.wxml`, 'utf8')).children,
            { ...instance.data, ...properties },
            {},
          ),
        ).find(
          (node) =>
            typeof node !== 'string' &&
            node.tag === 'input' &&
            node.attrs.catchinput === 'onInput',
        );
        assert.ok(inner, 'Actual native category editor boundary');
        if (inner.attrs.disabled !== 'true')
          definition.methods.onInput.call(instance, {
            detail: { value, cursor: value.length },
          });
      } finally {
        definition.lifetimes.detached.call(instance);
      }
      return emissions === 1;
    },
  };
}
function mount(name, runtime, wx) {
  let page;
  globalThis.Page = (value) => {
    page = value;
  };
  globalThis.getApp = () => ({ community: runtime });
  globalThis.wx = wx;
  const file = path.join(dist, `pages/${name}/${name}.js`);
  delete require.cache[require.resolve(file)];
  require(file);
  assert.ok(page);
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
          (n) => typeof n === 'string' || n.tag !== 'template' || !n.attrs.name,
        ),
        page.data,
        templates,
      ),
    );
  const native = ['rating-scoped', 'community-compose'].includes(name)
    ? createRatingEmittedBridge({
        page,
        pageFile: path.join(dist, `pages/${name}/${name}`),
        dist,
      })
    : ['rating-category-editor', 'rating-category-manage'].includes(name)
      ? categoryControls(page, path.join(dist, `pages/${name}/${name}`), nodes)
      : null;
  const event = async (handler, dataset = {}, value = '') => {
    const rendered = nodes().find(
      (node) =>
        typeof node !== 'string' &&
        (node.attrs.bindtap === handler ||
          node.attrs.bindinput === handler ||
          node.attrs['bind:press'] === handler ||
          node.attrs['bind:input'] === handler) &&
        Object.entries(dataset).every(
          ([key, v]) => node.attrs[`data-${key}`] === String(v),
        ),
    );
    assert.ok(rendered, `emitted WXML renders ${handler}`);
    assert.notEqual(rendered.attrs.disabled, 'true');
    assert.equal(typeof page[handler], 'function');
    if (rendered.attrs['bind:press'] === handler) {
      assert.ok(native, 'Supported actual ratings component owner');
      assert.ok(native.tap(handler, dataset));
    } else if (rendered.attrs['bind:input'] === handler) {
      assert.ok(native, 'Supported actual ratings input owner');
      assert.ok(native.input(handler, value, dataset));
    } else
      await page[handler]({ currentTarget: { dataset }, detail: { value } });
    await drain();
  };
  return { page, nodes, event };
}
function harness() {
  const s = categoryScopedHarness();
  s.controller.dispose();
  s.current.now = Date.now();
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const reads = [],
    generated = [],
    statuses = [],
    navigations = [];
  let next = 20000,
    result = null,
    outcome = 'generated';
  const runtime = {
    ...s.runtime,
    sessions,
    pendingRatings: new PendingRatingStore(s.storage, 'emitted-category'),
    pendingAssistance: new PendingAssistanceStore(
      s.storage,
      'emitted-assistance',
    ),
    pendingRatingLinks: new PendingRatingLinkStore(s.storage, 'emitted-link'),
    newRequestId: async () => categoryTestId(next++),
  };
  runtime.assistance = {
    create: async (request) => {
      generated.push(structuredClone(request));
      const text =
        request.purpose === 'category_description'
          ? '探索校园精彩评分分类'
          : '这门课程怎么样？';
      const metadata = {
        version: 1,
        requestId: request.requestId,
        purpose: request.purpose,
        intentHash: assistanceIntentHash(request),
        outcome,
      };
      statuses.push(metadata);
      result = {
        status: 'available',
        version: 1,
        actorId: s.accountId,
        requestId: request.requestId,
        purpose: request.purpose,
        draftId: request.draftId,
        inputRevision: request.inputRevision,
        intentHash: metadata.intentHash,
        inputDigest: 'a'.repeat(64),
        resultId: categoryTestId(next++),
        resultDigest: createHash('sha256')
          .update(`whaleu:ratings:assistance:result:v1\n${text}`)
          .digest('hex'),
        profileRevision: 'synthetic-rating-suggestion-v1',
        outputContract: 1,
        text,
        expiresAt: new Date(Date.now() + 100000).toISOString(),
      };
      return metadata;
    },
    result: async (id) => {
      reads.push(id);
      return result;
    },
    status: async () => statuses.at(-1),
    cancel: async () => statuses.at(-1),
  };
  const wx = {
    navigateTo: ({ url, success }) => {
      navigations.push(url);
      success?.();
    },
  };
  return {
    ...s,
    runtime,
    generated,
    reads,
    statuses,
    navigations,
    wx,
    setOutcome: (value) => {
      outcome = value;
    },
  };
}
function privateProjection(page) {
  for (const patch of page.patches)
    assert.doesNotMatch(
      JSON.stringify(patch),
      /"contextToken"|"tokenDigest"|"accessToken"|"refreshToken"|"inputDigest"|"resultDigest"/,
    );
}
export async function runRatingsAssistanceEmittedSmoke(t) {
  const previous = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: globalThis.wx,
  };
  try {
    await t.test(
      'root generate/preview/adopt/edit/prepare/explicit commit and hide are real native events',
      async () => {
        const s = harness(),
          h = mount('rating-category-editor', s.runtime, s.wx);
        h.page.onLoad({ scope: 'campus', campusId: managedCampus });
        h.page.onShow();
        await drain();
        await h.event('onOperation', { operation: 'create_categories_scoped' });
        await h.event('onNodeText', { key: 'n0', field: 'name' }, '校园课程');
        await h.event(
          'onNodeText',
          { key: 'n0', field: 'description' },
          '原来简介',
        );
        await h.event('onGenerateDescription', { key: 'n0' });
        assert.equal(h.page.data.nodes[0].description, '原来简介');
        assert.equal(s.prepared.length, 0);
        assert.equal(s.committed.length, 0);
        assert.equal(h.page.data.assistance.preview, '探索校园精彩评分分类');
        await h.event('onAdoptDescription');
        assert.equal(s.reads.length, 2);
        assert.equal(h.page.data.nodes[0].description, '探索校园精彩评分分类');
        await h.event(
          'onNodeText',
          { key: 'n0', field: 'description' },
          '采用后手动修改',
        );
        await h.event('onPrepare');
        assert.equal(s.prepared.length, 1);
        assert.equal(s.committed.length, 0);
        await h.event('onCommit');
        assert.equal(s.committed.length, 1);
        assert.equal(
          s.committed[0].payload.nodes[0].description,
          '采用后手动修改',
        );
        privateProjection(h.page);
        h.page.onHide();
        assert.equal(h.page.data.assistance.preview, '');
        h.page.onUnload();
      },
    );
    await t.test(
      'course entry -> fresh manual card -> explicit title adoption -> v5 Review/retry -> current-name card navigation',
      async () => {
        const s = harness(),
          scoped = new FakeScopedGateway(),
          capability = {
            systemKey: 'course',
            targetId,
            selector: { kind: 'global' },
            expectedTargetRevision: revision,
            expectedCategoryRevision: revision,
            expectedSourceRevision: revision,
          };
        scoped.contextWork = async (request) => ({
          ...scopedContext(request, Date.now()),
          identityCampusId: managedCampus,
        });
        scoped.detail = async () =>
          target({ name: '🐳'.repeat(13), ratingTargetLink: capability });
        s.runtime.ratingScoped = scoped;
        s.runtime.gateway.capabilitiesImpl = async () =>
          capabilities({
            authorModes: ['named'],
            ratingTargetLink: {
              availability: 'allowed',
              reason: null,
              authorModes: ['named', 'anonymous'],
            },
          });
        let review = 'pending',
          submitted,
          published;
        Object.assign(s.runtime.gateway, {
          submitReview: async (attempt) => {
            submitted = structuredClone(attempt);
            return {
              requestId: attempt.payload.clientRequestId,
              operation: 'publish_post',
              status: review,
            };
          },
          reviewStatus: async (attempt) => ({
            requestId: attempt.payload.clientRequestId,
            operation: 'publish_post',
            status: review,
          }),
          receipt: async () => {
            throw new ClientError('http', 'absent', {
              httpStatus: 404,
              serverCode: 'REQUEST_NOT_FOUND',
            });
          },
          publishPost: async (payload) => {
            published = structuredClone(payload);
            return {
              requestId: payload.clientRequestId,
              operation: 'publish_post',
              outcome: 'created',
              resourceId: postId,
              createdAt: new Date().toISOString(),
            };
          },
        });
        const entry = mount('rating-scoped', s.runtime, s.wx);
        entry.page.onLoad({ mode: 'detail', scope: 'global', targetId });
        entry.page.onShow();
        await drain();
        await entry.event('onRatingLinkCompose');
        const path = s.navigations.at(-1);
        assert.ok(path.startsWith('/pages/community-compose/'));
        assert.ok(!path.includes('🐳'));
        assert.equal(s.generated.length, 0);
        entry.page.onHide();
        const query = Object.fromEntries(
          new URL(`https://synthetic.invalid${path}`).searchParams,
        );
        const compose = mount('community-compose', s.runtime, s.wx);
        compose.page.onLoad(query);
        compose.page.onShow();
        await drain();
        assert.equal(compose.page.data.ratingLinkLabel, '🐳'.repeat(12));
        assert.equal(compose.page.data.text, '');
        await compose.event('onText', {}, '正文保持独立');
        await compose.event('onGenerateRatingLabel');
        assert.equal(compose.page.data.text, '正文保持独立');
        assert.equal(compose.page.data.ratingLinkLabel, '🐳'.repeat(12));
        await compose.event('onAdoptRatingLabel');
        assert.equal(compose.page.data.ratingLinkLabel, '这门课程怎么样？');
        await compose.event('onRatingLabel', {}, '我手动选择的标签');
        await compose.event('onSubmit');
        assert.equal(submitted.version, 5);
        assert.equal(submitted.kind, 'community_rating_target_link_v5');
        assert.equal(published, undefined);
        assert.equal(s.runtime.pending.load(s.accountId), null);
        assert.equal(compose.page.data.assistance.preview, '');
        review = 'approved';
        await compose.event('onRetry');
        assert.equal(published.text, '正文保持独立');
        assert.equal(published.component.label, '我手动选择的标签');
        assert.equal(s.runtime.pendingRatingLinks.load(s.accountId), null);
        assert.ok(batchPublicationReference(submitted).intentHash);
        privateProjection(compose.page);
        compose.page.onHide();
        const card = {
          kind: 'rating_target_link',
          label: published.component.label,
          target: {
            id: targetId,
            name: '同一对象后来审核的新名称',
            locator: { targetId, selector: { kind: 'global' } },
          },
        };
        s.runtime.gateway.postImpl = async () =>
          post({ id: postId, component: card });
        const detail = mount('community-detail', s.runtime, s.wx);
        detail.page.onLoad({ postId: postId });
        detail.page.onShow();
        await drain();
        assert.equal(
          detail.page.data.post.component.target.name,
          card.target.name,
        );
        await detail.event('onRatingTargetLink', { id: postId });
        assert.equal(
          s.navigations.at(-1),
          `/pages/rating-scoped/rating-scoped?mode=detail&scope=global&targetId=${targetId}`,
        );
        detail.page.onHide();
        detail.page.onUnload();
        compose.page.onUnload();
        entry.page.onUnload();
      },
    );
  } finally {
    Object.assign(globalThis, previous);
  }
}
