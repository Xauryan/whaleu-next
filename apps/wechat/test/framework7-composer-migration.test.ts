import { batchPublicationReference } from '../src/media/batch-publication';
import type { PendingAttempt } from '../src/community/pending-attempt';
import { assertReviewedReadingSuccessor } from './reviewed-reading-successor';
import { assertReviewedBusinessSuccessor } from './reviewed-reading-successor';
import {
  assertReviewedReferenceSuccessor,
  reviewedReferencePresentation,
} from './reviewed-reading-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import type { Post } from '../src/community/contract';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
import {
  comment,
  intent,
  commentId,
  post,
  postId,
  receipt,
  reply,
  replyId,
  setup,
  spaceId,
  otherId,
} from './community-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { reportHarness } from './report-helpers';
const root = path.join(__dirname, '..');
const requireNative = createRequire(__filename);
const { parsePreviewWxml: parse } = requireNative(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, ext = 'wxml') =>
  read(`src/pages/${page}/${page}.${ext}`);
const flatten = (node: PresentationNode): PresentationNode[] => [
  node,
  ...node.children.flatMap((child) =>
    typeof child === 'string' ? [] : flatten(child),
  ),
];
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
const baseline = JSON.parse(
  read('test/fixtures/framework7-composer-before-actions.json'),
) as Record<string, { sourceSha256: string; actions: Action[] }>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-composer-before-protected.json'),
) as Record<string, string>;
function actions(
  raw: PresentationNode,
  parents: Record<string, string>[] = [],
): Action[] {
  const node = normalizeFramework7ActionNode(raw);
  const own = Object.fromEntries(
    Object.entries(node.attrs).filter(([key]) =>
      [
        'wx:if',
        'wx:elif',
        'wx:else',
        'wx:for',
        'wx:for-item',
        'wx:for-index',
        'wx:key',
      ].includes(key),
    ),
  );
  const scopes = Object.keys(own).length ? [...parents, own] : parents;
  return [
    ...(node.tag === 'navigator' ||
    Object.keys(node.attrs).some((key) => /^(bind|catch)/.test(key))
      ? [{ tag: node.tag, attrs: node.attrs, scopes }]
      : []),
    ...node.children.flatMap((child) =>
      typeof child === 'string' ? [] : actions(child, scopes),
    ),
  ];
}
function conditionalChains(node: PresentationNode) {
  const children = node.children.filter(
    (child): child is PresentationNode => typeof child !== 'string',
  );
  children.forEach((child, index) => {
    if ('wx:else' in child.attrs || 'wx:elif' in child.attrs)
      assert.ok(
        children[index - 1] &&
          ('wx:if' in children[index - 1]!.attrs ||
            'wx:elif' in children[index - 1]!.attrs),
        `${child.tag}: intact conditional chain`,
      );
    conditionalChains(child);
  });
}
for (const [file, before] of Object.entries(baseline))
  test(`${file}: exact original actions, ancestor guards, datasets, loading and disabled constraints survive`, () => {
    const tree = parse(reviewedReferencePresentation(file, read(file)));
    const current = actions(tree);
    assert.equal(current.length, before.actions.length);
    for (const old of before.actions) {
      const index = current.findIndex(
        (next) =>
          next.tag === old.tag &&
          JSON.stringify(next.scopes) === JSON.stringify(old.scopes) &&
          Object.entries(old.attrs).every(
            ([key, value]) => next.attrs[key] === value,
          ),
      );
      assert.notEqual(index, -1, JSON.stringify(old));
      current.splice(index, 1);
    }
    assert.equal(current.length, 0);
    conditionalChains(tree);
    conditionalChains(parse(read(file)));
  });

const pages = [
  'compose-entry',
  'community-compose',
  'community-detail',
  'community-thread',
];
for (const page of pages)
  test(`${page}: native Framework7 controls preserve the flat hierarchy without new overlays`, () => {
    const nodes = flatten(parse(source(page)));
    const config = JSON.parse(source(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    for (const kind of ['button', 'block', 'list', 'list-item'])
      assert.ok(nodes.some((node) => node.tag === `wu-f7-${kind}`));
    for (const node of nodes.filter((item) => item.tag.startsWith('wu-f7-'))) {
      const name = node.tag.slice(3);
      assert.equal(
        config.usingComponents[node.tag],
        `../../components/${name}/${name}`,
      );
      assert.equal(node.attrs['open-type'], undefined);
      if (node.tag === 'wu-f7-list-item') {
        assert.equal(node.attrs.link, '{{true}}');
        assert.ok(
          !flatten(node)
            .slice(1)
            .some(
              (child) =>
                child.tag === 'navigator' ||
                /^(button|input|textarea|switch|wu-f7-button|wu-f7-input)$/.test(
                  child.tag,
                ) ||
                Object.keys(child.attrs).some((key) =>
                  /^(bind|catch)/.test(key),
                ),
            ),
        );
      }
    }
    assert.ok(
      !nodes.some((node) =>
        /^(wu-f7-sheet|wu-f7-dialog|wu-f7-actions|web-view|input)$/.test(
          node.tag,
        ),
      ),
    );
    assert.match(source(page, 'wxss'), /framework7-composer\.wxss/);
    assert.doesNotMatch(source(page), /rich-text|data:image|https?:\/\//);
  });
test('all four Page/controller sources, shared contracts, pending journals, media/privacy gateways and accepted roots remain byte-identical except explicit reviewed business successors', () => {
  assert.equal(Object.keys(protectedFiles).length, 217);
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) =>
      !assertReviewedReferenceSuccessor(file, expected) &&
      !assertReviewedReadingSuccessor(file, expected) &&
      !assertReviewedBusinessSuccessor(file, expected),
  ))
    assert.equal(hash(read(file)), expected, file);
});
test('native observer anchors, media privacy, platform permissions and original confirmation surfaces stay native', () => {
  const detail = flatten(parse(source('community-detail')));
  assert.equal(
    detail.find((node) => node.attrs.id === 'view-{{post.id}}')?.tag,
    'view',
  );
  assert.equal(
    detail.find((node) => node.attrs['open-type'] === 'share')?.tag,
    'button',
  );
  for (const page of ['community-detail', 'community-thread']) {
    const nodes = flatten(parse(source(page)));
    for (const name of [
      'onAuthorAvatar',
      'onSelectGallery',
      'onGalleryDismiss',
      'onGalleryRetry',
      'onConfirmDelete',
      'onDismissDelete',
    ])
      assert.ok(
        nodes.some(
          (node) => node.tag === 'button' && node.attrs.bindtap === name,
        ),
        `${page}: ${name}`,
      );
    const images = nodes.filter((node) => node.tag === 'image');
    assert.ok(images.length);
    for (const image of images)
      assert.equal(image.attrs['show-menu-by-longpress'], '{{false}}');
    assert.doesNotMatch(
      source(page),
      /src="{{(?:post|root|reply|item)\.images/,
    );
    assert.match(source(page), /identityOverlay\.developerEnabled/);
    assert.match(source(page), /分身/);
  }
  const compose = flatten(parse(source('community-compose')));
  assert.equal(
    compose.find((node) => node.attrs.bindinput === 'onText')?.tag,
    'textarea',
  );
  for (const name of [
    'onRelatedCampusSync',
    'onAllowAnonymousDm',
    'onRestricted',
    'onFeedbackConsent',
    'onContactConsent',
    'onFormationConsent',
  ])
    assert.equal(
      compose.find((node) => node.attrs.bindchange === name)?.tag,
      'switch',
    );
  assert.equal(
    compose.filter((node) => node.attrs['bind:press'] === 'onSubmit').length,
    1,
  );
});

interface Owner {
  [key: string]: unknown;
  data: Record<string, unknown>;
  setData(value: Record<string, unknown>, callback?: () => void): void;
}
interface Instance {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(value: Record<string, unknown>): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
type Method = (this: Instance, event?: unknown) => unknown;
interface Definition {
  properties: Record<string, { type?: unknown; value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, Method>;
  lifetimes?: Record<string, Method>;
  pageLifetimes?: Record<string, Method>;
}
function registration<T>(kind: 'Page' | 'Component', file: string): T {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals[kind];
  let definition: T | undefined;
  globals[kind] = (value: T) => {
    definition = value;
  };
  try {
    const target = requireNative.resolve(path.join(root, 'src', file));
    delete requireNative.cache[target];
    requireNative(target);
  } finally {
    globals[kind] = previous;
  }
  assert.ok(definition);
  return definition;
}
function invoke(target: Owner, name: string, event?: unknown) {
  return (target[name] as (event?: unknown) => unknown).call(target, event);
}
function mount(page: string, runtime: CommunityRuntime, query?: unknown) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = { wx: globals.wx, getApp: globals.getApp };
  const navigation: string[] = [];
  globals.wx = {
    navigateTo: ({ url, success }: { url: string; success?: () => void }) => {
      navigation.push(url);
      success?.();
    },
    getStorageSync: () => undefined,
    setStorageSync: () => undefined,
  };
  globals.getApp = () => ({ community: runtime });
  const definition = registration<Owner>('Page', `pages/${page}/${page}.ts`);
  const target: Owner = {
    ...definition,
    data: structuredClone(definition.data),
    setData(value, callback) {
      Object.assign(this.data, value);
      callback?.();
    },
  };
  if (target.onLoad) invoke(target, 'onLoad', query);
  invoke(target, 'onShow');
  return {
    target,
    navigation,
    close() {
      invoke(target, 'onUnload');
      globals.wx = previous.wx;
      globals.getApp = previous.getApp;
    },
  };
}
function control(
  page: string,
  handler: string,
  target: Owner,
  patch: Record<string, unknown> = {},
  selector?: (node: PresentationNode) => boolean,
) {
  const node = flatten(parse(source(page))).find(
    (item) =>
      (item.attrs['bind:press'] === handler ||
        item.attrs['bind:input'] === handler) &&
      (!selector || selector(item)),
  )!;
  assert.ok(node, `${page}: actual native ${handler} binding`);
  const scope = { ...target.data, ...patch };
  const evaluate = (raw: string) =>
    raw.startsWith('{{')
      ? Function('scope', `with(scope){return (${raw.slice(2, -2)});}`)(scope)
      : raw;
  const dataset = Object.fromEntries(
    Object.entries(node.attrs)
      .filter(([key]) => key.startsWith('data-'))
      .map(([key, value]) => [key.slice(5), evaluate(value)]),
  );
  const name = node.tag.slice(3);
  const definition = registration<Definition>(
    'Component',
    `components/${name}/${name}.ts`,
  );
  let dispatched = 0;
  const properties = Object.fromEntries(
    Object.entries(definition.properties).map(([key, prop]) => {
      const attr = key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
      const raw = node.attrs[attr];
      let value =
        raw === undefined ? structuredClone(prop.value) : evaluate(raw);
      if (prop.type === Number) value = Number(value);
      return [key, value];
    }),
  );
  const instance: Instance = {
    ...definition.methods,
    properties,
    data: structuredClone(definition.data),
    setData(value) {
      Object.assign(this.data, value);
    },
    triggerEvent(event, detail, options) {
      assert.ok(event === 'press' || event === 'input');
      assert.deepEqual(options, { bubbles: false, composed: false });
      dispatched++;
      invoke(target, handler, { detail, currentTarget: { dataset } });
    },
  };
  definition.lifetimes?.attached?.call(instance);
  return {
    press: () => definition.methods.onPress!.call(instance),
    input: (value: string) =>
      definition.methods.onInput!.call(instance, {
        detail: { value, cursor: value.length },
      }),
    hide: () => definition.pageLifetimes?.hide?.call(instance),
    detach: () => definition.lifetimes?.detached?.call(instance),
    dispatched: () => dispatched,
    instance,
  };
}
function press(
  page: string,
  handler: string,
  target: Owner,
  patch: Record<string, unknown> = {},
  selector?: (node: PresentationNode) => boolean,
) {
  const component = control(page, handler, target, patch, selector);
  component.press();
  component.detach();
  return component.dispatched();
}

test('real ListItem/Button → compose-entry Page → FeedController retains destination ownership, inactive/busy gates and no hidden navigation', async () => {
  const s = setup();
  const f = mount('compose-entry', s.runtime);
  try {
    await flush();
    const campuses = f.target.data.campuses as {
      id: string;
      isActive: boolean;
    }[];
    assert.ok(campuses.length);
    const campus = campuses[0]!;
    assert.equal(
      press('compose-entry', 'onCampus', f.target, {
        item: { ...campus, isActive: false },
      }),
      0,
    );
    assert.equal(
      press('compose-entry', 'onCampus', f.target, {
        item: campus,
        busy: true,
      }),
      0,
    );
    press('compose-entry', 'onCampus', f.target, { item: campus });
    await flush();
    assert.equal(f.target.data.campusId, campus.id);
    assert.ok(s.gateway.calls.some((call) => call.method === 'spaces'));
    press('compose-entry', 'onContinue', f.target);
    assert.equal(f.navigation.length, 1);
    assert.ok(f.navigation[0]!.includes(spaceId));
    const stale = control('compose-entry', 'onContinue', f.target);
    stale.hide();
    stale.press();
    stale.detach();
    stale.press();
    assert.equal(stale.dispatched(), 0);
    invoke(f.target, 'onHide');
    press('compose-entry', 'onCampus', f.target, { item: campus });
    assert.equal(f.target.controller, undefined);
  } finally {
    f.close();
  }
});

test('real Input and Button → composer Page → controller keep exact drafts, anonymous identity, frozen request key and retry payload', async () => {
  const s = setup();
  const f = mount('community-compose', s.runtime, {
    spaceId,
    category: 'discussion',
  });
  try {
    await flush();
    press(
      'community-compose',
      'onToggleComposePanel',
      f.target,
      {},
      (node) => node.attrs['data-panel'] === 'identity',
    );
    assert.equal(f.target.data.uiPanel, 'identity');
    press(
      'community-compose',
      'onMode',
      f.target,
      {},
      (node) => node.attrs['data-mode'] === 'anonymous',
    );
    assert.equal(f.target.data.authorMode, 'anonymous');
    // Textarea remains the platform-native multiline/IME owner.
    invoke(f.target, 'onText', { detail: { value: '  原文\r\n🐳  ' } });
    invoke(f.target, 'onPollEnabled', { detail: { value: true } });
    const input = control('community-compose', 'onPollQuestion', f.target);
    input.input('  周末一起做什么？  ');
    assert.equal(
      (f.target.data.pollDraft as { question: string }).question,
      '  周末一起做什么？  ',
    );
    input.hide();
    input.input('stale hidden');
    input.detach();
    input.input('stale detached');
    assert.equal(input.dispatched(), 1);
    invoke(f.target, 'onPollEnabled', { detail: { value: false } });
    s.gateway.publishPostImpl = async () => {
      throw new ClientError('timeout', 'lost receipt');
    };
    press('community-compose', 'onSubmit', f.target);
    await flush();
    const pending = s.runtime.pending.load(s.accountId)!;
    assert.ok(pending);
    assert.equal(pending.payload.authorMode, 'anonymous');
    assert.equal(pending.payload.text, '  原文\n🐳  ');
    assert.equal(f.target.data.frozen, true);
    assert.equal(
      press(
        'community-compose',
        'onMode',
        f.target,
        {},
        (node) => node.attrs['data-mode'] === 'named',
      ),
      0,
    );
    const frozenInput = control(
      'community-compose',
      'onPollQuestion',
      f.target,
    );
    frozenInput.input('changed');
    frozenInput.detach();
    assert.equal(frozenInput.dispatched(), 0);
    s.gateway.receiptImpl = async () => {
      throw new ClientError('network', 'still unknown');
    };
    press('community-compose', 'onReceipt', f.target);
    await flush();
    assert.equal(
      s.gateway.calls.filter((call) => call.method === 'receipt').slice(-1)[0]!
        .args[0],
      pending.payload.clientRequestId,
    );
    press('community-compose', 'onCancel', f.target);
    assert.deepEqual(s.runtime.pending.load(s.accountId), pending);
    s.gateway.publishPostImpl = async (payload) =>
      receipt({ requestId: payload.clientRequestId });
    press('community-compose', 'onRetry', f.target);
    await flush();
    const sends = s.gateway.calls.filter(
      (call) => call.method === 'publishPost',
    );
    assert.equal(sends.length, 2);
    assert.deepEqual(sends[0]!.args[0], sends[1]!.args[0]);
    assert.equal(s.runtime.pending.load(s.accountId), null);
  } finally {
    f.close();
  }
});

test('real detail Buttons → Page → controller preserve sort/cursors, cancellation, unavailable data and account boundaries', async () => {
  const s = setup();
  s.gateway.commentsImpl = async (_id, after) => ({
    items: [comment()],
    nextCursor: after ? null : 'original-next',
  });
  const f = mount('community-detail', s.runtime, { postId });
  try {
    await flush();
    assert.equal(f.target.data.loaded, true);
    press(
      'community-detail',
      'onOrder',
      f.target,
      {},
      (node) =>
        node.attrs['data-sort'] === 'time' &&
        node.attrs['data-order'] === 'asc',
    );
    await flush();
    assert.deepEqual(
      s.gateway.calls.filter((call) => call.method === 'comments').slice(-1)[0]!
        .args[3],
      { sort: 'time', order: 'asc' },
    );
    press('community-detail', 'onMore', f.target);
    await flush();
    assert.equal(
      s.gateway.calls.filter((call) => call.method === 'comments').slice(-1)[0]!
        .args[1],
      'original-next',
    );
    press('community-detail', 'onPrevious', f.target);
    await flush();
    const late = deferred<Post>();
    s.gateway.postImpl = async () => late.promise;
    press('community-detail', 'onReload', f.target);
    assert.equal(press('community-detail', 'onReload', f.target), 0);
    press('community-detail', 'onCancel', f.target);
    late.resolve(post());
    await flush();
    assert.equal(f.target.data.post, null);
    assert.deepEqual(f.target.data.comments, []);
    const stale = control('community-detail', 'onReload', f.target);
    stale.hide();
    stale.press();
    stale.detach();
    stale.press();
    assert.equal(stale.dispatched(), 0);
    invoke(f.target, 'onHide');
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('replacement'),
      accountId: otherId,
    });
    assert.equal(f.target.data.post, null);
  } finally {
    f.close();
  }
});

test('real detail like Button preserves original mutation authority, frozen intent and private hide', async () => {
  const s = setup();
  const f = mount('community-detail', s.runtime, { postId });
  try {
    await flush();
    s.gateway.likeImpl = async () => {
      throw new ClientError('network', 'lost receipt');
    };
    press('community-detail', 'onLike', f.target);
    await flush();
    const pending = s.runtime.pendingPostLikes.load(s.accountId)!;
    assert.ok(pending);
    assert.equal(press('community-detail', 'onLike', f.target), 0);
    assert.equal(
      s.gateway.calls.filter((call) => call.method === 'like').length,
      1,
    );
    // Existing shared recovery template remains native and its exact controller is unchanged.
    invoke(f.target, 'onPostLikeCancel');
    assert.deepEqual(s.runtime.pendingPostLikes.load(s.accountId), pending);
    invoke(f.target, 'onHide');
    assert.equal(f.target.data.post, null);
    assert.equal(
      s.gateway.calls.some(
        (call) =>
          call.method === 'deletePost' || call.method === 'deleteComment',
      ),
      false,
    );
  } finally {
    f.close();
  }
});

test('real thread Buttons → Page → controller keep reply datasets, original like key, pagination and hide/session fences', async () => {
  const s = setup();
  s.gateway.repliesImpl = async (_root, after) => ({
    items: [reply()],
    nextCursor: after ? null : 'reply-next',
  });
  const f = mount('community-thread', s.runtime, {
    postId,
    rootCommentId: commentId,
  });
  try {
    await flush();
    assert.equal(f.target.data.loaded, true);
    press('community-thread', 'onMore', f.target);
    await flush();
    assert.equal(
      s.gateway.calls.filter((call) => call.method === 'replies').slice(-1)[0]!
        .args[1],
      'reply-next',
    );
    s.gateway.discussionLikeImpl = async () => {
      throw new ClientError('network', 'lost receipt');
    };
    press('community-thread', 'onLikeReply', f.target, { reply: reply() });
    await flush();
    const pending = s.runtime.pendingDiscussion.load(s.accountId)!;
    assert.equal(pending.targetId, replyId);
    assert.equal(pending.operation, 'set_reply_like');
    assert.equal(press('community-thread', 'onLikeRoot', f.target), 0);
    invoke(f.target, 'onInteractionCancel');
    assert.deepEqual(s.runtime.pendingDiscussion.load(s.accountId), pending);
    s.gateway.discussionLikeImpl = async (kind, id, desired, requestId) => ({
      requestId,
      operation: kind === 'reply' ? 'set_reply_like' : 'set_comment_like',
      resourceId: id,
      desired,
      outcome: 'applied',
    });
    invoke(f.target, 'onInteractionRetry');
    await flush();
    const attempts = s.gateway.calls.filter(
      (call) => call.method === 'discussionLike',
    );
    assert.deepEqual(
      attempts[0]!.args.slice(0, 4),
      attempts[1]!.args.slice(0, 4),
    );
    assert.equal(s.runtime.pendingDiscussion.load(s.accountId), null);
    const stale = control('community-thread', 'onLikeRoot', f.target);
    stale.hide();
    stale.press();
    stale.detach();
    stale.press();
    assert.equal(stale.dispatched(), 0);
    const late = deferred<Post>();
    s.gateway.postImpl = async () => late.promise;
    press('community-thread', 'onReload', f.target);
    invoke(f.target, 'onHide');
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('replacement'),
      accountId: otherId,
    });
    late.resolve(post());
    await flush();
    assert.equal(f.target.data.post, null);
    assert.equal(f.target.data.root, null);
    assert.deepEqual(f.target.data.replies, []);
  } finally {
    f.close();
  }
});

test('real trading Input preserves exact decimal and contact drafts without rounding, implicit consent or dispatch', async () => {
  const s = setup();
  const f = mount('community-compose', s.runtime, {
    spaceId,
    category: 'trading',
  });
  try {
    await flush();
    assert.equal(f.target.data.isTrading, true);
    const priceNode = flatten(parse(source('community-compose'))).find(
      (node) =>
        node.attrs['bind:input'] === 'onTradingField' &&
        node.attrs['data-field'] === 'price',
    )!;
    assert.equal(priceNode.attrs.placeholder, '如 12.345，不会四舍五入');
    const price = control(
      'community-compose',
      'onTradingField',
      f.target,
      {},
      (node) => node.attrs['data-field'] === 'price',
    );
    price.input('12.345');
    assert.equal(
      (f.target.data.tradingDraft as { price: string }).price,
      '12.345',
    );
    const contact = control(
      'community-compose',
      'onTradingField',
      f.target,
      {},
      (node) => node.attrs['data-field'] === 'wechat',
    );
    contact.input('  fictional-draft  ');
    const draft = f.target.data.tradingDraft as {
      wechat: string;
      contactConsent: boolean;
    };
    assert.equal(draft.wechat, '  fictional-draft  ');
    assert.equal(draft.contactConsent, false);
    price.hide();
    price.input('rounded');
    price.detach();
    contact.detach();
    contact.input('stale');
    assert.equal(price.dispatched(), 1);
    assert.equal(contact.dispatched(), 1);
    assert.equal(
      s.gateway.calls.some((call) => /publish|upload/.test(call.method)),
      false,
    );
    invoke(f.target, 'onHide');
    assert.equal(f.target.data.text, '');
  } finally {
    f.close();
  }
});

test('rendered source bridge enforces original ancestor menus, typed datasets, disabled states and hide before native component dispatch', async () => {
  const { createNativePressBridge } = requireNative(
    './native-press-emitted-harness.mjs',
  ) as {
    createNativePressBridge(options: {
      page: Owner;
      pageFile: string;
      dist: string;
      extension: 'ts';
    }): {
      capture(
        handler: string,
        dataset?: Record<string, unknown>,
      ): { press(): boolean; detach(): void };
      find(handler: string, dataset?: Record<string, unknown>): unknown;
      lifecycle(name: string): void;
    };
  };
  const s = setup();
  s.gateway.postImpl = async () => {
    const value = post();
    return { ...value, viewer: { ...value.viewer, isSelf: false } };
  };
  s.gateway.commentsImpl = async () => ({
    items: [
      comment({
        viewer: {
          isSelf: false,
          canDelete: false,
          isLiked: false,
          canPin: false,
        },
      }),
    ],
    nextCursor: null,
  });
  const f = mount('community-detail', s.runtime, { postId });
  try {
    await flush();
    const bridge = createNativePressBridge({
      page: f.target,
      pageFile: path.join(root, 'src/pages/community-detail/community-detail'),
      dist: path.join(root, 'src'),
      extension: 'ts',
    });
    assert.equal(
      bridge.find('onAdminDiscussionRemoval', {
        kind: 'comment',
        id: commentId,
      }),
      undefined,
    );
    const menu = bridge.capture('onToggleMenu', {
      menu: `comment:${commentId}`,
    });
    assert.equal(menu.press(), true);
    menu.detach();
    const admin = bridge.capture('onAdminDiscussionRemoval', {
      surface: 'root',
      kind: 'comment',
      id: commentId,
    });
    assert.equal(admin.press(), true);
    admin.detach();
    assert.equal(
      f.navigation.slice(-1)[0],
      `/pages/admin-discussion-removal/admin-discussion-removal?kind=comment&id=${commentId}`,
    );
    const stale = bridge.capture('onAdminDiscussionRemoval', {
      surface: 'root',
      kind: 'comment',
      id: commentId,
    });
    f.target.data.uiExpandedMenu = '';
    assert.equal(stale.press(), false);
    stale.detach();
    const like = bridge.capture('onLike');
    bridge.lifecycle('hide');
    assert.equal(like.press(), false);
    assert.equal(
      s.gateway.calls.some((call) => call.method === 'like'),
      false,
    );
  } finally {
    f.close();
  }
});

test('real detail save/delete/report entry Buttons reach original controllers without bypassing confirmation or emitting opposite mutations', async () => {
  const s = reportHarness();
  const f = mount('community-detail', s.runtime, { postId });
  try {
    await flush();
    press('community-detail', 'onSavedToggle', f.target);
    await flush();
    const saved = s.gateway.calls.filter(
      (call) => call.method === 'applySaved',
    );
    assert.equal(saved.length, 1);
    assert.equal((saved[0]!.args[0] as { postId: string }).postId, postId);
    assert.equal((saved[0]!.args[0] as { desired: boolean }).desired, true);
    assert.equal(s.runtime.pendingSaved.load(s.accountId), null);
    press('community-detail', 'onDeletePost', f.target);
    assert.deepEqual(f.target.data.deleteTarget, { kind: 'post', id: postId });
    assert.equal(
      s.gateway.calls.some((call) => call.method === 'deletePost'),
      false,
    );
    invoke(f.target, 'onDismissDelete');
    invoke(f.target, 'onConfirmDelete');
    await flush();
    assert.equal(
      s.gateway.calls.some((call) => call.method === 'deletePost'),
      false,
    );
    const value = post();
    s.gateway.postImpl = async () => ({
      ...value,
      viewer: { ...value.viewer, isSelf: false },
    });
    press('community-detail', 'onReload', f.target);
    await flush();
    press('community-detail', 'onReportPost', f.target);
    const report = f.target.data.report as {
      confirmation: {
        operation: string;
        target: { kind: string; id: string };
      } | null;
    };
    assert.equal(report.confirmation?.operation, 'report');
    assert.equal(report.confirmation?.target.kind, 'post');
    assert.equal(report.confirmation?.target.id, postId);
    assert.equal(s.sent.length > 0, false);
    invoke(f.target, 'onDismissReport');
    invoke(f.target, 'onConfirmReport');
    await flush();
    assert.equal(
      (f.target.data.report as { confirmation: unknown }).confirmation,
      null,
    );
    assert.equal(s.sent.length > 0, false);
  } finally {
    f.close();
    s.controller.dispose();
  }
});

for (const missing of [null, undefined])
  test(`actual composer bindings retain ${String(missing)} legacy source descriptor with current capability; explicit selection alone changes format`, async () => {
    const { createNativePressBridge } = requireNative(
      './native-press-emitted-harness.mjs',
    ) as {
      createNativePressBridge(options: {
        page: Owner;
        pageFile: string;
        dist: string;
        extension: 'ts';
      }): {
        find(
          handler: string,
          dataset?: Record<string, unknown>,
        ): PresentationNode | undefined;
        capture(
          handler: string,
          dataset?: Record<string, unknown>,
        ): { press(): boolean; detach(): void };
        lifecycle(name: string): void;
      };
    };
    const s = setup();
    Object.assign(s.gateway, {
      textSourceCapabilities: async (
        _space: string,
        _category: string,
        authorMode: 'named' | 'anonymous',
      ) => ({
        version: 1,
        authorMode,
        availability: 'available',
        operations: ['publish_post', 'publish_comment', 'publish_reply'],
        formats: ['plain', 'markdown'],
        readingFormatting: ['auto', 'off'],
        media: 'unavailable',
        markdownReferences: 'unavailable',
        formatter: 'not_configured',
      }),
      submitReview: async (attempt: PendingAttempt) => ({
        requestId: attempt.payload.clientRequestId,
        operation: attempt.operation,
        status: 'pending',
      }),
      reviewStatus: async (attempt: PendingAttempt) => ({
        requestId: attempt.payload.clientRequestId,
        operation: attempt.operation,
        status: 'pending',
      }),
    });
    const draftKey = `post:${spaceId}:discussion`;
    s.runtime.drafts.save(s.accountId, draftKey, {
      version: 1,
      text: '历史原文😀',
      authorMode: 'named',
      commentsPolicy: 'open',
    });
    const original = s.runtime.drafts.load(s.accountId, draftKey);
    const f = mount('community-compose', s.runtime, {
      spaceId,
      category: 'discussion',
    });
    try {
      await flush();
      assert.equal(f.target.data.loaded, true);
      assert.equal(f.target.data.canChooseTextSource, true);
      assert.equal(
        f.target.data.textSource,
        null,
        'real legacy controller state is not auto-upgraded',
      );
      const beforeRender = s.runtime.drafts.load(s.accountId, draftKey);
      assert.equal(beforeRender?.textSource, undefined);
      // undefined is an additional native template boundary, not a fabricated
      // controller default or a replacement for the genuine null legacy case.
      f.target.data.textSource = missing;
      const bridge = createNativePressBridge({
        page: f.target,
        pageFile: path.join(
          root,
          'src/pages/community-compose/community-compose',
        ),
        dist: path.join(root, 'src'),
        extension: 'ts',
      });
      assert.equal(
        bridge.find('onSourceFormat', { format: 'plain' })?.attrs.variant,
        'tonal',
      );
      assert.equal(
        bridge.find('onSourceFormat', { format: 'markdown' })?.attrs.variant,
        'plain',
      );
      assert.equal(bridge.find('onSourcePreview'), undefined);
      assert.equal(f.target.data.textSource, missing);
      assert.deepEqual(
        s.runtime.drafts.load(s.accountId, draftKey),
        beforeRender,
        'rendering neither initializes source nor rewrites the loaded draft',
      );
      const blocked = bridge.capture('onSourceFormat', { format: 'markdown' });
      f.target.data.busy = true;
      assert.equal(blocked.press(), false);
      blocked.detach();
      f.target.data.busy = false;
      const choose = bridge.capture('onSourceFormat', { format: 'markdown' });
      assert.equal(
        choose.press(),
        true,
        'real component dispatch reaches actual Page/controller only on explicit action',
      );
      choose.detach();
      assert.deepEqual(f.target.data.textSource, {
        version: 1,
        format: 'markdown',
      });
      assert.equal(f.target.data.text, original?.text);
      assert.deepEqual(
        s.runtime.drafts.load(s.accountId, draftKey)?.textSource,
        { version: 1, format: 'markdown' },
      );
      assert.equal(
        bridge.find('onSourceFormat', { format: 'markdown' })?.attrs.variant,
        'tonal',
      );
      const stale = bridge.capture('onSourceFormat', { format: 'plain' });
      bridge.lifecycle('hide');
      assert.equal(stale.press(), false);
      stale.detach();
      assert.deepEqual(f.target.data.textSource, {
        version: 1,
        format: 'markdown',
      });
    } finally {
      f.close();
    }
  });

test('actual frozen legacy pending composer renders null source without inventing descriptor or changing request/hash', async () => {
  const { createNativePressBridge } = requireNative(
    './native-press-emitted-harness.mjs',
  ) as {
    createNativePressBridge(options: {
      page: Owner;
      pageFile: string;
      dist: string;
      extension: 'ts';
    }): { find(handler: string, dataset?: Record<string, unknown>): unknown };
  };
  const s = setup();
  Object.assign(s.gateway, {
    textSourceCapabilities: async (
      _space: string,
      _category: string,
      authorMode: 'named' | 'anonymous',
    ) => ({
      version: 1,
      authorMode,
      availability: 'available',
      operations: ['publish_post', 'publish_comment', 'publish_reply'],
      formats: ['plain', 'markdown'],
      readingFormatting: ['auto', 'off'],
      media: 'unavailable',
      markdownReferences: 'unavailable',
      formatter: 'not_configured',
    }),
    submitReview: async (attempt: PendingAttempt) => ({
      requestId: attempt.payload.clientRequestId,
      operation: attempt.operation,
      status: 'pending',
    }),
    reviewStatus: async (attempt: PendingAttempt) => ({
      requestId: attempt.payload.clientRequestId,
      operation: attempt.operation,
      status: 'pending',
    }),
  });
  s.gateway.receiptImpl = async () => {
    throw new ClientError('http', 'missing', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  const original = s.runtime.pending.freeze({
    version: 1,
    accountId: s.accountId,
    operation: 'publish_post',
    payload: intent({ text: '历史待确认原文😀' }),
  });
  const f = mount('community-compose', s.runtime, {
    spaceId,
    category: 'discussion',
  });
  try {
    await flush();
    assert.equal(f.target.data.loaded, true);
    assert.equal(f.target.data.frozen, true);
    assert.equal(f.target.data.textSource, null);
    const bridge = createNativePressBridge({
      page: f.target,
      pageFile: path.join(
        root,
        'src/pages/community-compose/community-compose',
      ),
      dist: path.join(root, 'src'),
      extension: 'ts',
    });
    assert.equal(bridge.find('onSourceFormat'), undefined);
    assert.equal(bridge.find('onSourcePreview'), undefined);
    invoke(f.target, 'onSourceFormat', {
      currentTarget: { dataset: { format: 'markdown' } },
    });
    assert.equal(
      f.target.data.textSource,
      null,
      'frozen handler cannot reroute immutable request',
    );
    const retained = s.runtime.pending.load(s.accountId);
    assert.deepEqual(retained, original);
    assert.ok(retained);
    assert.equal(
      batchPublicationReference(retained).intentHash,
      batchPublicationReference(original).intentHash,
    );
    assert.equal(
      s.runtime.pending.load(s.accountId)?.payload.textSource,
      undefined,
    );
  } finally {
    f.close();
  }
});
