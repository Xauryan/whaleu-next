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
  const event = async (handler, dataset = {}, value = '') => {
    const rendered = nodes().find(
      (node) =>
        typeof node !== 'string' &&
        (node.attrs.bindtap === handler || node.attrs.bindinput === handler) &&
        Object.entries(dataset).every(
          ([key, v]) => node.attrs[`data-${key}`] === String(v),
        ),
    );
    assert.ok(rendered, `emitted WXML renders ${handler}`);
    assert.notEqual(rendered.attrs.disabled, 'true');
    assert.equal(typeof page[handler], 'function');
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
