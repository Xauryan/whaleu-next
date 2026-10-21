import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { PendingBlockStore } from '../src/community/block-pending';
import { PendingFollowStore } from '../src/following/pending';
import type { CommunityRuntime } from '../src/community/runtime';
import type { FollowView } from '../src/following/controller';
import { SafetyChanges } from '../src/community/safety-changes';
import type { BlockGateway } from '../src/community/block-gateway';
import type { BlockIntent } from '../src/community/block-contract';
import type { ExperienceView } from '../src/experience/controller';
import type { BlockMutationView } from '../src/community/block-controller';
import {
  setup as experienceSetup,
  requestId,
  receipt,
} from './experience-helpers';
import { discoverySetup, profileId, publicProfile } from './discovery-helpers';
import { setup as communitySetup, otherId } from './community-helpers';
import { blockEntry, blockResult } from './block-helpers';
import { rankingHarness, rankingItem } from './experience-ranking-helpers';
import { deferred, flush as shortFlush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
const root = path.join(__dirname, '..');
const nativeRequire = createRequire(__filename);
const { parsePreviewWxml: parse } = nativeRequire(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, ext = 'wxml') =>
  read(`src/pages/${page}/${page}.${ext}`);
const pages = [
  'public-profile',
  'community-blocks',
  'experience',
  'experience-ranking',
  'wallet',
];
const flatten = (node: PresentationNode): PresentationNode[] => [
  node,
  ...node.children.flatMap((child) =>
    typeof child === 'string' ? [] : flatten(child),
  ),
];
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
const baseline = JSON.parse(
  read('test/fixtures/framework7-personal-before-actions.json'),
) as Record<string, { sourceSha256: string; actions: Action[] }>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-personal-before-protected.json'),
) as Record<string, string>;
function actions(
  raw: PresentationNode,
  parents: Record<string, string>[] = [],
): Action[] {
  let node = normalizeFramework7ActionNode(raw);
  if (
    node.tag === 'button' &&
    ['onTab', 'onTradingSubtype'].includes(node.attrs.bindtap ?? '')
  )
    node = { ...node, tag: 'view' };
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
        'hidden',
        'disabled',
        'loading',
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
for (const [file, before] of Object.entries(baseline))
  test(`${file}: exact actions, datasets, disabled/loading and ancestor gates`, () => {
    const current = actions(
      parse(
        read(
          file === 'src/community/block-recovery.wxml'
            ? 'src/pages/public-profile/personal-recovery.wxml'
            : file,
        ),
      ),
    );
    assert.equal(current.length, before.actions.length);
    for (const old of before.actions) {
      const i = current.findIndex(
        (next) =>
          next.tag === old.tag &&
          JSON.stringify(next.scopes) === JSON.stringify(old.scopes) &&
          Object.entries(old.attrs).every(
            ([key, value]) => next.attrs[key] === value,
          ),
      );
      assert.notEqual(i, -1, JSON.stringify(old));
      current.splice(i, 1);
    }
  });
test('123 baseline-protected business, privacy, accepted page, token and component files remain byte-identical except explicit reviewed business successors', () => {
  assert.equal(Object.keys(protectedFiles).length, 123);
  for (const [file, hash] of Object.entries(protectedFiles).filter(
    ([file, expected]) => !assertReviewedBusinessSuccessor(file, expected),
  ))
    assert.equal(
      createHash('sha256').update(read(file)).digest('hex'),
      hash,
      file,
    );
});
for (const page of pages)
  test(`${page}: registered pinned native components without browser or overlay runtime`, () => {
    const nodes = flatten(parse(source(page))),
      config = JSON.parse(source(page, 'json')) as {
        usingComponents: Record<string, string>;
      };
    assert.ok(nodes.some((n) => n.tag === 'wu-f7-block'));
    if (page !== 'wallet')
      assert.ok(nodes.some((n) => n.tag === 'wu-f7-button'));
    for (const n of nodes.filter((n) => n.tag.startsWith('wu-f7-'))) {
      assert.equal(
        config.usingComponents[n.tag],
        `../../components/${n.tag.slice(3)}/${n.tag.slice(3)}`,
      );
      assert.equal(n.attrs['open-type'], undefined);
    }
    assert.doesNotMatch(
      source(page),
      /web-view|wu-f7-(sheet|dialog|actions)|data:image|https?:\/\//,
    );
    assert.match(source(page, 'wxss'), /framework7-personal\.wxss/);
  });
test('native accessibility/media/secret-editor constraints and honest unavailable finance remain explicit', () => {
  const experience = flatten(parse(source('experience'))),
    profile = flatten(parse(source('public-profile')));
  assert.ok(
    experience
      .filter((n) => 'aria-expanded' in n.attrs)
      .every((n) => n.tag === 'button'),
  );
  assert.equal(
    experience.find((n) => n.attrs.class?.includes('experience-swatch'))?.tag,
    'button',
  );
  assert.equal(
    experience.find((n) => n.tag === 'progress')?.attrs.percent,
    '{{summary.progress.percent}}',
  );
  const input = experience.find((n) => n.tag === 'wu-f7-input')!;
  assert.equal(input.attrs.password, '{{true}}');
  assert.equal(input.attrs.maxlength, '128');
  assert.equal(input.attrs.disabled, '{{busy}}');
  assert.equal(
    profile.find((n) => n.attrs.bindtap === 'onProfileDetails')?.attrs[
      'aria-expanded'
    ],
    '{{showProfileDetails}}',
  );
  assert.equal(
    profile.find((n) => n.attrs.binderror === 'onCoverError')?.attrs[
      'show-menu-by-longpress'
    ],
    '{{false}}',
  );
  const recovery = flatten(
    parse(read('src/pages/public-profile/personal-recovery.wxml')),
  );
  assert.equal(
    recovery.find((n) => n.attrs.bindtap === 'onConfirmBlock')?.tag,
    'button',
  );
  assert.doesNotMatch(
    source('wallet'),
    /balance|\b0\.00\b|充值|提现|onPay|经验/,
  );
  assert.match(source('wallet', 'ts'), /钱包服务暂未接入/);
});
interface Owner {
  [key: string]: unknown;
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>, callback?: () => void): void;
}
interface Instance {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
type Method = (this: Instance, event?: unknown) => unknown;
interface Definition {
  properties: Record<string, { type: unknown; value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, Method>;
  lifetimes?: Record<string, Method>;
  pageLifetimes?: Record<string, Method>;
}
interface Capture {
  press(): boolean;
  detach(): void;
  lifecycle(name: string): void;
}
interface Bridge {
  capture(handler: string, dataset?: Record<string, unknown>): Capture;
  find(
    handler: string,
    dataset?: Record<string, unknown>,
  ): PresentationNode | undefined;
  lifecycle(name: string): void;
  emissions: Array<{
    type: string;
    detail: unknown;
    currentTarget: { dataset: Record<string, unknown> };
  }>;
}
const { createNativePressBridge } = nativeRequire(
  './native-press-emitted-harness.mjs',
) as {
  createNativePressBridge(options: {
    page: Owner;
    pageFile: string;
    dist: string;
    extension: 'ts';
  }): Bridge;
};
const model = nativeRequire('../scripts/smoke-ratings.mjs') as {
  parse(source: string): PresentationNode;
  render(
    nodes: (PresentationNode | string)[],
    scope: unknown,
    templates: Record<string, PresentationNode>,
  ): PresentationNode[];
};
function registration<T>(kind: 'Page' | 'Component', file: string): T {
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = globals[kind];
  let value: T | undefined;
  globals[kind] = (definition: T) => {
    value = definition;
  };
  try {
    const target = nativeRequire.resolve(path.join(root, 'src', file));
    delete nativeRequire.cache[target];
    nativeRequire(target);
  } finally {
    globals[kind] = previous;
  }
  assert.ok(value);
  return value;
}
function invoke(target: Owner, name: string, event?: unknown) {
  return (target[name] as (event?: unknown) => unknown).call(target, event);
}
async function flush() {
  for (let i = 0; i < 20; i++) await shortFlush();
}
function mount(
  page: string,
  app: Record<string, unknown>,
  query: unknown = {},
) {
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = { wx: globals.wx, getApp: globals.getApp },
    navigation: string[] = [];
  globals.wx = {
    navigateTo: ({ url, success }: { url: string; success?: () => void }) => {
      navigation.push(url);
      success?.();
    },
  };
  globals.getApp = () => app;
  const definition = registration<Owner>('Page', `pages/${page}/${page}.ts`);
  const target: Owner = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch, callback) {
      Object.assign(this.data, patch);
      callback?.();
    },
  };
  if (typeof target.onLoad === 'function') invoke(target, 'onLoad', query);
  invoke(target, 'onShow');
  const bridge = createNativePressBridge({
    page: target,
    pageFile: path.join(root, `src/pages/${page}/${page}`),
    dist: path.join(root, 'src'),
    extension: 'ts',
  });
  return {
    target,
    bridge,
    navigation,
    press(handler: string, dataset: Record<string, unknown> = {}) {
      const c = bridge.capture(handler, dataset);
      const result = c.press();
      c.detach();
      return result;
    },
    hide() {
      bridge.lifecycle('hide');
      invoke(target, 'onHide');
    },
    close() {
      bridge.lifecycle('detach');
      invoke(target, 'onUnload');
      globals.wx = previous.wx;
      globals.getApp = previous.getApp;
    },
  };
}
function editor(target: Owner, handler: string) {
  const templates = {};
  const rendered = model.render(
    model.parse(source('experience')).children,
    target.data,
    templates,
  );
  const node = rendered
    .flatMap(flatten)
    .find(
      (node) =>
        node.tag === 'wu-f7-input' && node.attrs['bind:input'] === handler,
    );
  assert.ok(node, `visible actual input ${handler}`);
  const definition = registration<Definition>(
    'Component',
    'components/f7-input/f7-input.ts',
  );
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
            ? raw === 'true'
            : property.type === Number
              ? Number(raw)
              : raw,
      ];
    }),
  );
  let emitted = 0;
  const instance: Instance = {
    properties,
    data: structuredClone(definition.data),
    ...definition.methods,
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent(name, detail, options) {
      assert.deepEqual(options, { bubbles: false, composed: false });
      emitted++;
      invoke(target, node.attrs[`bind:${name}`]!, { detail });
    },
  };
  definition.lifetimes!.attached!.call(instance);
  const inner = flatten(
    parse(read('src/components/f7-input/f7-input.wxml')),
  ).find((node) => node.tag === 'input')!;
  assert.equal(inner.attrs.catchinput, 'onInput');
  assert.equal(inner.attrs.catchconfirm, 'onConfirm');
  return {
    input(value: string) {
      return definition.methods.onInput!.call(instance, {
        detail: { value, cursor: value.length },
      });
    },
    confirm(value: string) {
      return definition.methods.onConfirm!.call(instance, {
        detail: { value },
      });
    },
    hide() {
      definition.pageLifetimes!.hide!.call(instance);
    },
    detach() {
      definition.lifetimes!.detached!.call(instance);
    },
    emitted: () => emitted,
    properties,
    data: instance.data,
  };
}
const view = (target: Owner) => target.data as unknown as ExperienceView;
test('actual Button → experience Page → controller freezes sign-in, suppresses repeat, preserves boolean retry and rejects stale lifecycle taps', async () => {
  const s = experienceSetup();
  s.controller.dispose();
  const f = mount('experience', { experience: s.runtime });
  try {
    await flush();
    const old = f.bridge.capture('onSignIn');
    s.gateway.signInImpl = async () => {
      throw new ClientError('timeout', 'safe');
    };
    assert.equal(f.press('onSignIn'), true);
    assert.equal(f.press('onSignIn'), false);
    await flush();
    assert.equal(view(f.target).signInPending, true);
    const frozen = structuredClone(
      s.runtime.pending.load(wireCredentials().accountId, 'sign_in'),
    );
    assert.ok(frozen);
    s.gateway.receiptImpl = async () => {
      throw new ClientError('business', 'safe', {
        serverCode: 'EXPERIENCE_REQUEST_NOT_FOUND',
      });
    };
    s.gateway.signInImpl = async (i) => receipt({ requestId: i.requestId });
    f.press('onRecover', { operation: 'sign_in', retry: true });
    await flush();
    const sent = s.gateway.calls.filter((c) => c.method === 'signIn');
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0]!.body, sent[1]!.body);
    assert.equal(
      s.runtime.pending.load(wireCredentials().accountId, 'sign_in'),
      null,
    );
    assert.equal(
      f.bridge.emissions.find((e) => e.currentTarget.dataset.retry === true)
        ?.currentTarget.dataset.operation,
      'sign_in',
    );
    f.hide();
    assert.equal(old.press(), false);
    old.detach();
  } finally {
    f.close();
    s.runtime.dispose();
  }
});
test('actual Input/Button → experience Page → controller preserves raw redemption and stores only immutable handle through lost result/hide/recovery', async () => {
  const s = experienceSetup();
  s.controller.dispose();
  s.gateway.redemptionImpl = async () => ({ status: 'available' });
  const sent: unknown[] = [];
  s.gateway.redeemTitleImpl = async (i) => {
    sent.push(i);
    throw new ClientError('timeout', 'safe');
  };
  const f = mount('experience', { experience: s.runtime });
  try {
    await flush();
    invoke(f.target, 'onToggleSection', {
      currentTarget: { dataset: { field: 'redemption' } },
    });
    const input = editor(f.target, 'onRedemptionInput');
    assert.equal(input.properties.password, true);
    assert.equal(input.properties.maxlength, 128);
    input.input('  Raw-Secret  ');
    assert.equal(view(f.target).redemptionCode, '  Raw-Secret  ');
    f.press('onRedeemTitle');
    assert.equal(f.press('onRedeemTitle'), false);
    await flush();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { requestId, code: '  Raw-Secret  ' });
    assert.equal(view(f.target).redemptionCode, '');
    const handle = s.runtime.pending.redemption.load(
      wireCredentials().accountId,
    );
    assert.ok(handle);
    assert.doesNotMatch(JSON.stringify([...s.storage.data]), /Raw-Secret/);
    assert.equal(view(f.target).redemptionPending, true);
    input.hide();
    input.input('late');
    assert.equal(view(f.target).redemptionCode, '');
    input.detach();
    s.gateway.receiptImpl = async () => ({
      requestId,
      operation: 'redeem_title',
      outcome: 'granted',
      titleKey: 'redeem_liangchenmeijing',
    });
    f.press('onRecoverRedemption');
    await flush();
    assert.equal(
      s.runtime.pending.redemption.load(wireCredentials().accountId),
      null,
    );
    f.hide();
    assert.equal(view(f.target).redemptionCode, '');
  } finally {
    f.close();
    s.runtime.dispose();
  }
});
test('actual Button → experience owned title draft/save/cancel keeps numeric color identity and original appearance intent', async () => {
  const s = experienceSetup();
  s.controller.dispose();
  const f = mount('experience', { experience: s.runtime });
  try {
    await flush();
    invoke(f.target, 'onToggleSection', {
      currentTarget: { dataset: { field: 'appearance' } },
    });
    f.press('onTitle', { key: 'level_1' });
    f.press('onColor', { id: '' });
    assert.equal(view(f.target).appearanceDirty, true);
    f.press('onCancelSelection');
    assert.equal(view(f.target).appearanceDirty, false);
    f.press('onTitle', { key: 'level_1' });
    f.press('onSave');
    assert.equal(f.press('onSave'), false);
    await flush();
    assert.equal(s.gateway.currentAppearance.titleKey, 'level_1');
    assert.equal(
      s.gateway.calls.filter((c) => c.method === 'selectAppearance').length,
      1,
    );
  } finally {
    f.close();
    s.runtime.dispose();
  }
});
test('actual Button → blocked-list Page → controller retains unknown-original unblock and native recovery, without leaking identity', async () => {
  const s = communitySetup(),
    sent: BlockIntent[] = [];
  const blocks: BlockGateway = {
    apply: async (i) => {
      sent.push(i);
      throw new ClientError('timeout', 'safe');
    },
    receipt: async () => blockResult(sent[0]!),
    list: async () => ({ items: [blockEntry()], nextCursor: null }),
    state: async () => ({
      relationshipId: otherId,
      blocked: true,
      revision: '1',
    }),
  };
  const pendingBlocks = new PendingBlockStore(s.storage, 'synthetic'),
    runtime = {
      ...s.runtime,
      blocks,
      pendingBlocks,
      safetyChanges: new SafetyChanges(s.runtime.privateViews),
    };
  const f = mount('community-blocks', { community: runtime });
  try {
    await flush();
    const stale = f.bridge.capture('onUnblock', { id: otherId });
    f.press('onUnblock', { id: otherId });
    assert.equal(f.press('onUnblock', { id: otherId }), false);
    await flush();
    assert.equal((f.target.data.block as BlockMutationView).frozen, true);
    assert.ok(pendingBlocks.load(s.accountId));
    assert.doesNotMatch(
      JSON.stringify(sent),
      /profileId|displayName|accountId|source/,
    );
    f.press('onBlockReceipt');
    await flush();
    assert.equal(pendingBlocks.load(s.accountId), null);
    f.hide();
    assert.equal(stale.press(), false);
    stale.detach();
  } finally {
    f.close();
  }
});
test('actual public-profile buttons preserve named-only discovery, tab filters and late read/lifecycle privacy fences', async () => {
  const s = discoverySetup();
  const f = mount('public-profile', { community: s.runtime }, { profileId });
  try {
    await flush();
    assert.equal(f.target.data.loaded, true);
    f.press('onTab', { key: 'trading' });
    await flush();
    assert.equal(f.target.data.tab, 'trading');
    f.press('onTradingSubtype', { key: 'shuma' });
    await flush();
    assert.equal(f.target.data.tradingSubtype, 'shuma');
    const old = f.bridge.capture('onReload');
    const late = deferred<ReturnType<typeof publicProfile>>();
    s.behavior.profile = () => late.promise;
    f.press('onReload');
    await flush();
    assert.equal(f.target.data.profile, null);
    assert.equal(f.bridge.find('onPrivateMessage'), undefined);
    f.hide();
    late.resolve(publicProfile());
    await flush();
    assert.equal(f.target.data.profile, null);
    assert.equal(old.press(), false);
    old.detach();
  } finally {
    f.close();
  }
});
test('actual ListItem → ranking Page → AuthorNavigator only opens current public profile; wallet has no action', async () => {
  const s = rankingHarness(false);
  s.controller.dispose();
  const f = mount('experience-ranking', { community: s.runtime });
  try {
    await flush();
    f.press('onProfile', { profileId: rankingItem().profileId });
    assert.equal(
      f.navigation[0],
      `/pages/public-profile/public-profile?profileId=${rankingItem().profileId}`,
    );
    const old = f.bridge.capture('onProfile', {
      profileId: rankingItem().profileId,
    });
    f.hide();
    assert.equal(old.press(), false);
    old.detach();
    invoke(f.target, 'onProfile', {
      currentTarget: { dataset: { profileId: 'forged' } },
    });
    assert.equal(f.navigation.length, 1);
  } finally {
    f.close();
  }
  const wallet = mount('wallet', {});
  try {
    assert.equal(wallet.target.data.error, '钱包服务暂未接入');
    assert.equal(wallet.bridge.find('onPay'), undefined);
    assert.deepEqual(actions(parse(source('wallet'))), []);
  } finally {
    wallet.close();
  }
});
test('press bridge decodes text entities exactly once, preserves typed host dataset and rejects disabled/stale captures', (t) => {
  const dist = mkdtempSync(path.join(os.tmpdir(), 'personal-press-entities-'));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  cpSync(
    path.join(root, 'src/components/f7-button'),
    path.join(dist, 'components/f7-button'),
    { recursive: true },
  );
  const pageFile = path.join(dist, 'pages/probe/probe');
  mkdirSync(path.dirname(pageFile), { recursive: true });
  writeFileSync(
    pageFile + '.json',
    JSON.stringify({
      usingComponents: {
        'wu-f7-button': '../../components/f7-button/f7-button',
      },
    }),
  );
  writeFileSync(
    pageFile + '.wxml',
    `<wu-f7-button disabled="{{disabled}}" data-count="{{count}}" data-retry="{{true}}" bind:press="onHit">{{count &gt; 0 &amp;&amp; count === 2 ? 'ready' : 'other'}} A &amp;gt; B &lt; C &quot;x&quot; &apos;y&apos;</wu-f7-button>`,
  );
  const received: unknown[] = [];
  const target: Owner = {
    data: { count: 2, disabled: false },
    setData(patch) {
      Object.assign(this.data, patch);
    },
    onHit(event: unknown) {
      received.push(event);
    },
  };
  const bridge = createNativePressBridge({
    page: target,
    pageFile,
    dist,
    extension: 'ts',
  });
  assert.deepEqual(bridge.find('onHit')?.children, [
    `ready A &gt; B < C "x" 'y'`,
  ]);
  const active = bridge.capture('onHit');
  assert.equal(active.press(), true);
  assert.deepEqual(bridge.emissions[0]!.currentTarget.dataset, {
    count: 2,
    retry: true,
  });
  const stale = bridge.capture('onHit');
  target.setData({ count: 3 });
  assert.equal(stale.press(), false);
  target.setData({ disabled: true });
  assert.equal(bridge.capture('onHit').press(), false);
  bridge.lifecycle('detach');
  assert.equal(active.press(), false);
  assert.equal(received.length, 1);
});
test('actual public follow/block buttons retain same-target retry, native destructive consent and public-content withdrawal', async () => {
  const s = discoverySetup(),
    followingCalls: unknown[][] = [],
    blockCalls: BlockIntent[] = [];
  let loseFollow = true,
    following = false;
  const pendingFollowing = new PendingFollowStore(s.storage, 'personal-follow'),
    pendingBlocks = new PendingBlockStore(s.storage, 'personal-block');
  const runtime: CommunityRuntime = {
    ...s.runtime,
    pendingFollowing,
    pendingBlocks,
    following: {
      feed: async () => ({ items: [], continuation: 'end', nextCursor: null }),
      status: async (id) => ({ profileId: id, following }),
      set: async (id, desired, request) => {
        followingCalls.push([id, desired, request]);
        if (loseFollow) throw new ClientError('timeout', 'safe');
        following = desired;
        return {
          profileId: id,
          following: desired,
          requestId: request,
          outcome: 'applied',
        };
      },
    },
    blocks: {
      list: async () => ({ items: [], nextCursor: null }),
      state: async () => ({
        relationshipId: otherId,
        blocked: true,
        revision: '1',
      }),
      apply: async (intent) => {
        blockCalls.push(intent);
        throw new ClientError('timeout', 'safe');
      },
      receipt: async () => blockResult(blockCalls[0]!),
    },
  };
  const f = mount('public-profile', { community: runtime }, { profileId });
  try {
    await flush();
    assert.equal((f.target.data.follow as FollowView).following, false);
    f.press('onFollow');
    assert.equal(f.press('onFollow'), false);
    await flush();
    assert.equal((f.target.data.follow as FollowView).frozen, true);
    assert.ok(pendingFollowing.load(s.accountId));
    loseFollow = false;
    f.press('onFollowRetry');
    await flush();
    assert.deepEqual(followingCalls[1], followingCalls[0]);
    assert.equal(pendingFollowing.load(s.accountId), null);
    assert.equal((f.target.data.follow as FollowView).following, true);
    assert.equal(f.bridge.find('onBlockProfile'), undefined);
    invoke(f.target, 'onProfileDetails'); // Native aria-expanded disclosure is retained.
    f.press('onBlockProfile');
    assert.deepEqual((f.target.data.block as BlockMutationView).confirmSource, {
      kind: 'profile',
      id: profileId,
    });
    assert.equal(blockCalls.length, 0);
    invoke(f.target, 'onConfirmBlock'); // Retained native destructive confirmation.
    await flush();
    assert.equal(f.target.data.profile, null);
    assert.deepEqual(f.target.data.items, []);
    assert.equal(f.bridge.find('onFollow'), undefined);
    assert.equal((f.target.data.block as BlockMutationView).frozen, true);
    s.behavior.profile = async () => ({
      status: 'blocked_by_you',
      profileId,
      relationship: { relationshipId: otherId, blocked: true, revision: '1' },
    });
    f.press('onBlockReceipt');
    await flush();
    assert.deepEqual(
      f.target.data.profile,
      await s.behavior.profile(profileId, {} as never),
    );
    assert.equal(f.bridge.find('onFollow'), undefined);
    assert.ok(f.bridge.find('onUnblockProfile'));
  } finally {
    f.close();
  }
});
