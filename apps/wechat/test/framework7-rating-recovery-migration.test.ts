import { assertReviewedNativeHarnessSuccessor } from './reviewed-native-harness-successor';
import { assertReviewedNoticeExposureSuccessor } from './reviewed-notice-exposure-successor';
import {
  assertReviewedNoticeReadSuccessor,
  reviewedNoticePresentation,
} from './reviewed-notice-read-successor';
import { assertReviewedSocialSuccessor } from './reviewed-social-successor';
import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import { ratingCategoryScopedOperations } from '../src/ratings/category-scoped-contract';
import { SafetyChanges } from '../src/community/safety-changes';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
import {
  registerNative,
  renderNativePageText,
} from './framework7-rating-recovery-render';
import { harness, targetId, categoryId } from './ratings-helpers';
import {
  ownerHarness,
  ownerIntent,
  ownerReceipt,
} from './rating-owner-management-helpers';
import { editingHarness } from './rating-owner-editing-helpers';
import { categoryScopedHarness, managedRoute } from './category-scoped-helpers';
import { randomResult } from './rating-random-helpers';
import { deferred, flush as tick } from './helpers';
import * as major from './major-discussion-helpers';
import * as window from './window-discussion-helpers';
const root = path.resolve(__dirname, '..'),
  nativeRequire = createRequire(__filename);
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const sha = (source: string) =>
  createHash('sha256').update(source).digest('hex');
const { parsePreviewWxml: parse } = nativeRequire(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
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
  read('test/fixtures/framework7-rating-recovery-before-actions.json'),
) as Record<
  string,
  { target: string; sourceSha256: string; actions: Action[] }
>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-rating-recovery-before-protected.json'),
) as Record<string, string>;
const pages = Object.keys(baseline)
  .filter((file) => file.startsWith('src/pages/'))
  .map((file) => file.split('/')[2]!);
function actions(
  raw: PresentationNode,
  parents: Record<string, string>[] = [],
): Action[] {
  const node = normalizeFramework7ActionNode(raw),
    own = Object.fromEntries(
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
        ].includes(key),
      ),
    ),
    scopes = Object.keys(own).length ? [...parents, own] : parents;
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
function chains(node: PresentationNode) {
  const children = node.children.filter(
    (c): c is PresentationNode => typeof c !== 'string',
  );
  children.forEach((child, index) => {
    if ('wx:else' in child.attrs || 'wx:elif' in child.attrs)
      assert.ok(
        children[index - 1] &&
          ('wx:if' in children[index - 1]!.attrs ||
            'wx:elif' in children[index - 1]!.attrs),
      );
    chains(child);
  });
}
for (const [original, before] of Object.entries(baseline))
  test(`${original}: exact original actions, datasets, scopes, disabled/loading and input constraints`, () => {
    const tree = parse(
        reviewedNoticePresentation(before.target, read(before.target)),
      ),
      current = actions(tree);
    assert.equal(current.length, before.actions.length);
    for (const captured of before.actions) {
      const old = structuredClone(captured);
      if (
        original === 'src/ratings/category-scoped.wxml' &&
        old.attrs.bindtap === 'onChoice' &&
        old.attrs['data-field'] === 'lifecycleAction'
      ) {
        assert.equal(
          old.attrs.class,
          "management-action management-choice {{lifecycleAction === '{{item.value}}' ? 'is-selected' : ''}}",
        );
        old.attrs.class =
          "management-action management-choice {{lifecycleAction === item.value ? 'is-selected' : ''}}";
      }
      const index = current.findIndex(
        (next) =>
          next.tag === old.tag &&
          JSON.stringify(next.scopes) === JSON.stringify(old.scopes) &&
          Object.entries(old.attrs).every(
            ([key, value]) => next.attrs[key] === value,
          ),
      );
      assert.notEqual(index, -1, JSON.stringify(old));
      assert.ok(
        Object.keys(current[index]!.attrs)
          .filter((key) => !(key in old.attrs))
          .every((key) => ['variant', 'size', 'tone'].includes(key)),
      );
      current.splice(index, 1);
    }
    assert.equal(current.length, 0);
    chains(tree);
    const originalSource = read(
      `test/fixtures/framework7-rating-recovery-original-${original.split('/').join('__')}.txt`,
    );
    assert.equal(sha(originalSource), before.sourceSha256);
    const text = (source: string) =>
      flatten(parse(source))
        .flatMap((node) =>
          node.children.filter(
            (child): child is string => typeof child === 'string',
          ),
        )
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
    assert.equal(
      text(reviewedNoticePresentation(before.target, read(before.target))),
      text(originalSource),
      'All warnings, unknown states and scope copy remain exact',
    );
  });
test('immutable pre-edit baseline and 183 protected sources cannot be rerecorded to pass', () => {
  assert.equal(
    sha(read('test/fixtures/framework7-rating-recovery-before-actions.json')),
    '0be8a6ee1335b4842178a6d70d23f56cc0ce919a3989fe53b2b0b0cec47f2db2',
  );
  assert.equal(
    sha(read('test/fixtures/framework7-rating-recovery-before-protected.json')),
    '702ad98406037a0238bfa4e80aa22358f5dd174bc009eb22eca9fde5ec1c1f10',
  );
  assert.equal(
    Object.values(baseline).reduce(
      (sum, entry) => sum + entry.actions.length,
      0,
    ),
    282,
  );
  assert.equal(Object.keys(protectedFiles).length, 183);
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) =>
      !assertReviewedNoticeExposureSuccessor(file, expected) &&
      !assertReviewedBusinessSuccessor(file, expected) &&
      !assertReviewedNativeHarnessSuccessor(file, expected) &&
      !assertReviewedNoticeReadSuccessor(file, expected) &&
      !assertReviewedSocialSuccessor(file, expected),
  )) {
    const adapter =
      (file.startsWith('test/') || file.startsWith('scripts/')) &&
      !file.endsWith('native-press-emitted-harness.mjs');
    const target = adapter
      ? `test/fixtures/framework7-rating-recovery-original-${path.basename(file)}.txt`
      : file;
    assert.equal(sha(read(target)), expected, file);
  }
  assert.equal(
    sha(
      read(
        'test/fixtures/framework7-rating-recovery-original-smoke-ratings-r3r.mjs.txt',
      ),
    ),
    '7b712d627f43edd27ee62344e51ebc847ece1950a82cae2891a7a83cc4d7f831',
  );
  if (
    !assertReviewedNativeHarnessSuccessor(
      'test/native-press-emitted-harness.mjs',
      'f271187e9a5a7110e8d9632b2b88213191e32a878946e9cf5e1ffcfd5ceccd05',
    )
  )
    assert.equal(
      sha(read('test/native-press-emitted-harness.mjs')),
      'f271187e9a5a7110e8d9632b2b88213191e32a878946e9cf5e1ffcfd5ceccd05',
    );
});
function expanded(file: string, seen = new Set<string>()): PresentationNode[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const nodes = flatten(parse(read(file)));
  return nodes.concat(
    nodes
      .filter((n) => n.tag === 'include' || n.tag === 'import')
      .flatMap((n) =>
        expanded(path.join(path.dirname(file), n.attrs.src!), seen),
      ),
  );
}
for (const page of pages)
  test(`${page}: isolated native components, unchanged native textarea/media/overlay boundaries`, () => {
    const prefix = `src/pages/${page}/${page}`,
      nodes = expanded(prefix + '.wxml'),
      config = JSON.parse(read(prefix + '.json')) as {
        usingComponents: Record<string, string>;
      };
    assert.ok(nodes.some((n) => n.tag === 'wu-f7-button'));
    assert.ok(nodes.some((n) => n.tag === 'wu-f7-block'));
    for (const node of nodes.filter((n) => n.tag.startsWith('wu-f7-'))) {
      const name = node.tag.slice(3);
      assert.equal(
        config.usingComponents[node.tag],
        `../../components/${name}/${name}`,
      );
      assert.equal(node.attrs['open-type'], undefined);
      if (node.tag === 'wu-f7-button')
        assert.ok(
          !flatten(node)
            .slice(1)
            .some(
              (n) =>
                /^(button|input|textarea|navigator|wu-f7-button|wu-f7-input)$/.test(
                  n.tag,
                ) || Object.keys(n.attrs).some((k) => /^(bind|catch)/.test(k)),
            ),
        );
    }
    assert.ok(
      !nodes.some((n) =>
        /^(button|input|web-view|wu-f7-sheet|wu-f7-dialog|wu-f7-actions)$/.test(
          n.tag,
        ),
      ),
    );
    assert.match(read(prefix + '.wxss'), /ratings\/framework7-recovery\.wxss/);
    assert.doesNotMatch(
      read(prefix + '.wxml'),
      /https?:\/\/|rich-text|data:image/,
    );
  });
test('42 fictional source fixtures expand actual imports, native Component WXML and slots', () => {
  const { default: fixtures } = nativeRequire(
    '../scripts/fixtures/framework7-rating-recovery-preview.mjs',
  ) as {
    default: {
      id: string;
      page: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  assert.equal(fixtures.length, 42);
  assert.equal(new Set(fixtures.map((f) => f.id)).size, 42);
  assert.deepEqual(
    [...new Set(fixtures.map((f) => f.page))].sort(),
    [...pages].sort(),
  );
  for (const fixture of fixtures) {
    const text = renderNativePageText(fixture.page, fixture.patch);
    for (const marker of fixture.expectedText)
      assert.ok(
        text.includes(marker),
        `${fixture.id}: missing ${marker}\n${text}`,
      );
    assert.doesNotMatch(
      text,
      /undefined|\[object Object\]|{{|wx:|bindtap|<view/,
    );
    assert.doesNotMatch(
      JSON.stringify(fixture),
      /https?:\/\/|\/tmp\/|\/workspace\/|cloud:\/\//,
    );
  }
});
interface Owner {
  [key: string]: unknown;
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>, callback?: () => void): void;
}
interface Handle {
  press(): boolean;
  detach(): void;
}
interface Bridge {
  capture(handler: string, dataset?: Record<string, unknown>): Handle;
  find(
    handler: string,
    dataset?: Record<string, unknown>,
  ): PresentationNode | undefined;
  lifecycle(name: string): void;
  sync(): void;
  emissions: unknown[];
  disposeProjection(): void;
}
const { createRecoveryPressBridge } = nativeRequire(
  './framework7-rating-recovery-native-harness.mjs',
) as {
  createRecoveryPressBridge(options: {
    page: Owner;
    pageFile: string;
    dist: string;
    extension: 'ts';
  }): Bridge;
};
const invoke = (owner: Owner, name: string, event?: unknown) =>
  (owner[name] as (event?: unknown) => unknown).call(owner, event);
async function flush() {
  for (let i = 0; i < 20; i++) await tick();
}
function mount(page: string, runtime: CommunityRuntime, query: unknown = {}) {
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = { wx: globals.wx, getApp: globals.getApp };
  globals.wx = {
    navigateTo: ({ success }: { success?: () => void }) => success?.(),
  };
  globals.getApp = () => ({ community: runtime });
  const definition = registerNative<Owner>('Page', `pages/${page}/${page}.ts`),
    owner: Owner = {
      ...definition,
      data: structuredClone(definition.data),
      setData(patch, callback) {
        Object.assign(this.data, patch);
        callback?.();
      },
    };
  const bridge = createRecoveryPressBridge({
    page: owner,
    pageFile: path.join(root, `src/pages/${page}/${page}`),
    dist: path.join(root, 'src'),
    extension: 'ts',
  });
  invoke(owner, 'onLoad', query);
  invoke(owner, 'onShow');
  return {
    owner,
    bridge,
    press(handler: string, dataset: Record<string, unknown> = {}) {
      const control = bridge.capture(handler, dataset);
      const result = control.press();
      control.detach();
      return result;
    },
    close() {
      bridge.lifecycle('detach');
      invoke(owner, 'onUnload');
      bridge.disposeProjection();
      Object.assign(globals, previous);
    },
  };
}
test('owner deletion: actual emitted control requires explicit confirmation, suppresses duplicate/hidden commands and preserves unknown identity', async () => {
  const s = ownerHarness();
  s.controller.dispose();
  let commands = 0;
  const pending = deferred<ReturnType<typeof ownerReceipt>>();
  s.gateway.command = async () => {
    commands++;
    return pending.promise;
  };
  const f = mount('target-owner-delete', s.runtime, { targetId });
  try {
    await flush();
    assert.equal(f.bridge.find('onConfirmDelete'), undefined);
    assert.equal(f.press('onDelete'), true);
    const old = f.bridge.capture('onConfirmDelete');
    assert.equal(old.press(), true);
    await flush();
    assert.equal(commands, 1);
    assert.equal(old.press(), false);
    const journal = s.pendingRatings.load(s.accountId);
    assert.ok(journal);
    f.bridge.lifecycle('hide');
    assert.equal(old.press(), false);
    invoke(f.owner, 'onHide');
    pending.reject(new ClientError('network', 'Unknown synthetic outcome'));
    await flush();
    assert.deepEqual(s.pendingRatings.load(s.accountId), journal);
  } finally {
    f.close();
  }
});
test('owner deletion recovery: original request and explicit cancellation survive the new template boundary', async () => {
  const s = ownerHarness();
  s.controller.dispose();
  s.pendingRatings.freeze({
    version: 6,
    accountId: s.accountId,
    intent: ownerIntent(),
  });
  const f = mount('target-owner-delete', s.runtime, {});
  try {
    await flush();
    assert.equal(f.owner.data.frozen, true);
    assert.ok(f.bridge.find('onRecover'));
    assert.ok(f.bridge.find('onRetry'));
    assert.equal(f.bridge.find('onConfirmCancelDeletion'), undefined);
    assert.equal(f.press('onCancelDeletion'), true);
    assert.equal(f.press('onDismissCancelDeletion'), true);
    assert.equal(s.calls.includes('cancel'), false);
    assert.equal(f.press('onCancelDeletion'), true);
    assert.equal(f.press('onConfirmCancelDeletion'), true);
    await flush();
    assert.equal(s.calls.filter((c) => c === 'cancel').length, 1);
  } finally {
    f.close();
  }
});
test('owner editing: emitted confirmation and stale dismissed control never submit an unconfirmed draft', async () => {
  const s = editingHarness();
  s.controller.dispose();
  const f = mount('target-owner-edit', s.runtime, { targetId });
  try {
    await flush();
    assert.equal(f.press('onEdit'), true);
    const stale = f.bridge.capture('onConfirmEdit');
    assert.equal(f.press('onDismissEdit'), true);
    assert.equal(stale.press(), false);
    assert.equal(s.calls.includes('prepare'), false);
    assert.equal(f.press('onEdit'), true);
    assert.equal(f.press('onConfirmEdit'), true);
    await flush();
    assert.equal(s.calls.filter((c) => c === 'prepare').length, 0);
    assert.equal(s.calls.filter((c) => c === 'command').length, 1);
  } finally {
    f.close();
  }
});
test('random draw: native press honors in-flight loading, original candidate result and hidden-page lifetime', async () => {
  const s = harness();
  s.controller.dispose();
  const pending = deferred<ReturnType<typeof randomResult>>();
  let calls = 0;
  const runtime: CommunityRuntime = {
    ...s.runtime,
    ratingRandom: {
      draw: async () => {
        calls++;
        return pending.promise;
      },
    },
  };
  const f = mount('rating-random', runtime, { categoryId });
  try {
    await flush();
    const draw = f.bridge.capture('onDraw');
    assert.equal(draw.press(), true);
    await flush();
    assert.equal(draw.press(), false);
    assert.equal(calls, 1);
    pending.resolve(randomResult());
    await flush();
    assert.ok(f.owner.data.result);
    const target = f.bridge.capture('onTarget');
    f.bridge.lifecycle('hide');
    assert.equal(target.press(), false);
    invoke(f.owner, 'onHide');
    assert.equal(f.owner.data.uiPanel, '');
  } finally {
    f.close();
  }
});
test('category scoped editor: actual include emits operation dataset and preserves preview-before-commit', async () => {
  const s = categoryScopedHarness();
  s.controller.dispose();
  s.current.now = Date.now();
  const f = mount('rating-category-editor', s.runtime, managedRoute);
  try {
    await flush();
    assert.equal(f.bridge.find('onCommit'), undefined);
    const operations = f.owner.data.operations as {
      operation?: string;
      key?: string;
      allowed: boolean;
    }[];
    assert.ok(operations.length);
    const node = expanded('src/ratings/framework7-recovery-category.wxml').find(
      (n) => n.attrs['bind:press'] === 'onOperation',
    );
    assert.ok(node);
    const operation = 'edit_category_base_scoped';
    assert.equal(f.press('onOperation', { operation }), true);
    await flush();
    assert.ok(f.bridge.find('onPrepare'));
    assert.equal(f.bridge.find('onCommit'), undefined);
  } finally {
    f.close();
  }
});
for (const family of ['major', 'window'] as const)
  test(`${family} recovery: native own-lookup and explicit unlike preserve membership CAS`, async () => {
    const h = family === 'major' ? major : window,
      s = h.discussionHarness('recovery');
    s.controller.dispose();
    const runtime = { ...s.runtime, safetyChanges: new SafetyChanges() };
    const f = mount(`${family}-discussion-recovery`, runtime);
    try {
      await flush();
      invoke(f.owner, family === 'major' ? 'onOwnMajor' : 'onOwnWindow', {
        detail: { value: h.id },
      });
      invoke(f.owner, 'onOwnComment', { detail: { value: h.rootId } });
      assert.equal(f.press('onLookupOwn'), true);
      await flush();
      assert.equal(f.owner.data.canUnlike, true);
      assert.equal(f.press('onUnlike'), true);
      assert.equal(s.calls.includes('submit'), false);
      assert.equal(f.press('onSubmit'), true);
      await flush();
      const sent = s.calls.find((c) => c === 'submit');
      assert.ok(sent);
      const command = s.commands[0]!.command as {
        active?: boolean;
        expectedMembershipRevision?: string;
      };
      assert.equal(command.active, false);
      assert.equal(command.expectedMembershipRevision, h.scoreRevision);
    } finally {
      f.close();
    }
  });

interface InputInstance {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  triggerEvent(type: string, detail: unknown, options: unknown): void;
}
type InputMethod = (this: InputInstance, event?: unknown) => void;
interface InputDefinition {
  properties: Record<string, { value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, InputMethod>;
  lifetimes: Record<string, InputMethod>;
  pageLifetimes: Record<string, InputMethod>;
}
function inputControl(
  page: string,
  owner: Owner,
  handler: string,
  scopePatch: Record<string, unknown> = {},
  pick: (n: PresentationNode) => boolean = () => true,
) {
  const node = expanded(`src/pages/${page}/${page}.wxml`).find(
    (n) =>
      n.tag === 'wu-f7-input' && n.attrs['bind:input'] === handler && pick(n),
  );
  assert.ok(node);
  const { evaluatePreviewExpression: evaluate } = nativeRequire(
    '../scripts/preview-wxml.mjs',
  ) as {
    evaluatePreviewExpression(
      expression: string,
      scope: Record<string, unknown>,
    ): unknown;
  };
  const scope = { ...owner.data, ...scopePatch },
    value = (raw: string) =>
      raw.startsWith('{{') ? evaluate(raw.slice(2, -2), scope) : raw;
  const definition = registerNative<InputDefinition>(
      'Component',
      'components/f7-input/f7-input.ts',
    ),
    properties = Object.fromEntries(
      Object.entries(definition.properties).map(([key, p]) => [
        key,
        structuredClone(p.value),
      ]),
    );
  for (const [key, raw] of Object.entries(node.attrs)) {
    const prop = key.replace(/-([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    if (prop in properties) {
      const actual = value(raw);
      properties[prop] =
        typeof properties[prop] === 'number' && typeof actual === 'string'
          ? Number(actual)
          : actual;
    }
  }
  const dataset = Object.fromEntries(
    Object.entries(node.attrs)
      .filter(([key]) => key.startsWith('data-'))
      .map(([key, raw]) => [key.slice(5), value(raw)]),
  );
  let count = 0;
  const instance: InputInstance = {
    properties,
    data: structuredClone(definition.data),
    ...definition.methods,
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent(type, detail, options) {
      assert.equal(type, 'input');
      assert.deepEqual(options, { bubbles: false, composed: false });
      count++;
      invoke(owner, handler, { detail, currentTarget: { dataset } });
    },
  };
  definition.lifetimes.attached!.call(instance);
  return {
    input(raw: string) {
      definition.methods.onInput!.call(instance, {
        detail: { value: raw, cursor: raw.length },
      });
    },
    hide() {
      definition.pageLifetimes.hide!.call(instance);
    },
    detach() {
      definition.lifetimes.detached!.call(instance);
    },
    emitted: () => count,
  };
}
test('native Input registration retains raw owner name and suppresses hidden/disabled editing', async () => {
  const s = editingHarness();
  s.controller.dispose();
  const f = mount('target-owner-edit', s.runtime, { targetId });
  try {
    await flush();
    const control = inputControl('target-owner-edit', f.owner, 'onName');
    control.input('  原始名称 😀  ');
    assert.equal(f.owner.data.name, '  原始名称 😀  ');
    control.hide();
    control.input('hidden overwrite');
    assert.equal(control.emitted(), 1);
    assert.equal(f.press('onEdit'), true);
    const disabled = inputControl('target-owner-edit', f.owner, 'onName');
    disabled.input('confirmation overwrite');
    assert.equal(disabled.emitted(), 0);
    assert.equal(f.owner.data.name, '  原始名称 😀  ');
    control.detach();
    disabled.detach();
  } finally {
    f.close();
  }
});
test('category one-line input preserves data-key/data-field and exact draft text through real Component → Page', async () => {
  const s = categoryScopedHarness();
  s.controller.dispose();
  s.current.now = Date.now();
  const f = mount('rating-category-editor', s.runtime, {
    scope: 'campus',
    campusId: managedRoute.campusId,
  });
  try {
    await flush();
    assert.equal(
      f.press('onOperation', { operation: 'create_categories_scoped' }),
      true,
    );
    const node = (f.owner.data.nodes as Record<string, unknown>[])[0]!;
    const control = inputControl(
      'rating-category-editor',
      f.owner,
      'onNodeText',
      { item: node },
      (n) => n.attrs['data-field'] === 'name',
    );
    control.input('  原始分类 😀  ');
    assert.equal(
      (f.owner.data.nodes as Record<string, unknown>[])[0]!.name,
      '  原始分类 😀  ',
    );
    control.detach();
  } finally {
    f.close();
  }
});
for (const operation of ratingCategoryScopedOperations)
  test(`category ${operation}: actual emitted prepare → complete preview → commit retains frozen CAS intent`, async () => {
    const s = categoryScopedHarness();
    s.controller.dispose();
    s.current.now = Date.now();
    const f = mount(
      'rating-category-editor',
      s.runtime,
      operation === 'create_categories_scoped' ||
        operation === 'create_system_category_scoped'
        ? { scope: 'campus', campusId: managedRoute.campusId }
        : managedRoute,
    );
    try {
      await flush();
      assert.equal(f.press('onOperation', { operation }), true);
      if (operation === 'create_categories_scoped') {
        const control = inputControl(
          'rating-category-editor',
          f.owner,
          'onNodeText',
          { item: (f.owner.data.nodes as unknown[])[0] },
          (n) => n.attrs['data-field'] === 'name',
        );
        control.input('原生新分类');
        control.detach();
      }
      if (operation === 'create_system_category_scoped') {
        assert.equal(
          f.press('onSystemKey', { key: 'synthetic_general' }),
          true,
        );
        const control = inputControl(
          'rating-category-editor',
          f.owner,
          'onText',
          {},
          (n) => n.attrs['data-field'] === 'name',
        );
        control.input('原生系统分类');
        control.detach();
      }
      if (operation === 'set_category_override_scoped')
        assert.equal(f.press('onResetOverride'), true);
      assert.equal(f.bridge.find('onCommit'), undefined);
      assert.equal(f.press('onPrepare'), true);
      await flush();
      assert.ok(f.owner.data.preview, String(f.owner.data.error));
      assert.equal(s.committed.length, 0);
      const frozen = s.pending();
      assert.ok(frozen);
      assert.equal(frozen.version, 10);
      assert.equal(f.press('onCommit'), true);
      await flush();
      assert.equal(s.committed.length, 1);
      assert.equal(s.pending(), null);
      assert.equal(f.owner.data.preview, null);
      assert.deepEqual(s.prepared[0], s.committed[0]);
    } finally {
      f.close();
    }
  });
test('inherited lifecycle class defect is corrected only in isolated presentation; each real option retains value and allowed guard', async () => {
  const s = categoryScopedHarness();
  s.controller.dispose();
  s.current.now = Date.now();
  const f = mount('rating-category-editor', s.runtime, managedRoute);
  try {
    await flush();
    assert.equal(
      f.press('onOperation', { operation: 'set_category_lifecycle_scoped' }),
      true,
    );
    const options = f.owner.data.lifecycleActions as {
      value: string;
      allowed: boolean;
    }[];
    assert.ok(options.length >= 2);
    for (const option of options) {
      const node = f.bridge.find('onChoice', {
        field: 'lifecycleAction',
        value: option.value,
      });
      assert.ok(node);
      const old = f.owner.data.lifecycleAction;
      assert.equal(
        f.press('onChoice', { field: 'lifecycleAction', value: option.value }),
        option.allowed,
      );
      assert.equal(
        f.owner.data.lifecycleAction,
        option.allowed ? option.value : old,
      );
      if (option.allowed) {
        const selected = f.bridge.find('onChoice', {
          field: 'lifecycleAction',
          value: option.value,
        });
        assert.match(selected!.attrs.class!, /is-selected/);
        assert.equal(selected!.attrs.variant, 'fill');
      }
    }
    assert.doesNotMatch(
      renderNativePageText('rating-category-editor', f.owner.data),
      /undefined|{{/,
    );
  } finally {
    f.close();
  }
});
