import { setup as experienceSetup, requestId } from './experience-helpers';
import type { ExperienceView } from '../src/experience/controller';
import { ExperienceRuntime } from '../src/experience/runtime';
import { PendingExperienceStore } from '../src/experience/pending';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import type { WhaleuApp } from '../src/app';
import type { WxApi } from '../src/platform/wechat';
import type { ExperienceRanking } from '../src/experience/ranking-contract';
import type { ExperienceRankingView } from '../src/pages/experience-ranking/controller';
import { deferred, flush } from './helpers';
import {
  rankingHarness,
  rankingItem,
  rankingPage,
} from './experience-ranking-helpers';
import { wireCredentials } from './identity-helpers';
interface NativeRankingPage {
  data: ExperienceRankingView;
  setData(patch: Record<string, unknown>): void;
  onShow(): void;
  onHide(): void;
  onUnload(): void;
  onRefresh(): void;
  onCancel(): void;
  onProfile(event: { currentTarget: { dataset: { profileId: string } } }): void;
}
let definition: NativeRankingPage | undefined;
async function loadDefinition(): Promise<NativeRankingPage> {
  if (!definition) {
    const previous = globalThis.Page;
    globalThis.Page = ((options: object) => {
      definition = options as NativeRankingPage;
    }) as typeof Page;
    try {
      await import('../src/pages/experience-ranking/experience-ranking.js');
    } finally {
      globalThis.Page = previous;
    }
  }
  assert.ok(definition);
  return definition;
}
test('actual Page routes only current decoded profile, coalesces navigation and clears across hide/reopen/runtime replacement', async () => {
  const s = rankingHarness(false),
    nativeGlobal = globalThis as typeof globalThis & { wx: WxApi },
    prior = { getApp: globalThis.getApp, wx: nativeGlobal.wx };
  const app = { community: s.runtime } as WhaleuApp;
  globalThis.getApp = (() => app) as typeof getApp;
  const routes: Parameters<NonNullable<WxApi['navigateTo']>>[0][] = [];
  nativeGlobal.wx = {
    navigateTo: (options) => {
      routes.push(options);
    },
  } as WxApi;
  let page: NativeRankingPage | undefined;
  try {
    const registered = await loadDefinition();
    page = {
      ...registered,
      data: { ...registered.data },
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };
    page.onShow();
    await flush();
    assert.equal(page.data.loaded, true);
    page.onProfile({ currentTarget: { dataset: { profileId: 'private-id' } } });
    assert.equal(routes.length, 0);
    const event = {
      currentTarget: { dataset: { profileId: rankingItem().profileId } },
    };
    page.onProfile(event);
    page.onProfile(event);
    assert.equal(routes.length, 1);
    assert.equal(
      routes[0]!.url,
      `/pages/public-profile/public-profile?profileId=${rankingItem().profileId}`,
    );
    page.onHide();
    assert.deepEqual(page.data.items, []);
    routes[0]!.fail({ message: 'private' });
    assert.equal(page.data.error, '');
    page.onShow();
    await flush();
    assert.equal(s.calls.length, 2);
    const late = deferred<ExperienceRanking>();
    s.behavior.ranking = () => late.promise;
    page.onRefresh();
    await flush();
    assert.deepEqual(page.data.items, []);
    page.onProfile(event);
    assert.equal(routes.length, 1);
    const replacement = rankingHarness(false);
    replacement.behavior.ranking = async () =>
      rankingPage({ items: [rankingItem(2)] });
    app.community = replacement.runtime;
    page.onRefresh();
    await flush();
    late.resolve(rankingPage());
    await flush();
    assert.deepEqual(
      page.data.items.map(
        (x: ExperienceRanking['items'][number]) => x.profileId,
      ),
      [rankingItem(2).profileId],
    );
    page.onHide();
    replacement.sessions.completeLogin(
      replacement.sessions.beginLogin(),
      wireCredentials(),
    );
    page.onShow();
    await flush();
    assert.equal(page.data.hasSession, true);
    page.onUnload();
    assert.deepEqual(page.data.items, []);
    replacement.controller.dispose();
  } finally {
    page?.onUnload();
    s.controller.dispose();
    globalThis.getApp = prior.getApp;
    nativeGlobal.wx = prior.wx;
  }
});
test('native registration, events, explicit bounded coverage and entry preserve personal journal implementation', () => {
  const root = join(__dirname, '../src');
  const template = readFileSync(
    join(root, 'pages/experience-ranking/experience-ranking.wxml'),
    'utf8',
  );
  assert.ok(
    JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')).pages.includes(
      'pages/experience-ranking/experience-ranking',
    ),
  );
  for (const event of ['onRefresh', 'onCancel', 'onProfile'])
    assert.match(template, new RegExp(`bindtap="${event}"`));
  assert.match(template, /历史覆盖不完整/);
  assert.match(template, /scan_limited/);
  assert.match(template, /public-experience-display/);
  assert.doesNotMatch(
    template,
    /\{\{index|wx:for-index|<image|accountId|balance|total_exp/,
  );
  const entry = readFileSync(
    join(root, 'pages/experience/experience.wxml'),
    'utf8',
  );
  assert.match(entry, /url="\/pages\/experience-ranking\/experience-ranking"/);
  assert.match(entry, /放弃未保存的选择并查看/);
  const page = readFileSync(
    join(root, 'pages/experience-ranking/experience-ranking.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    page,
    /pending|signIn\(|redeemTitle\(|identity-view|setStorage|\.sort\(/,
  );
});

test('leaving actual personal experience Page discards only dirty UI and preserves all original recovery journals without replay', async () => {
  const personal = experienceSetup(),
    list = rankingHarness();
  personal.controller.dispose();
  const nativeGlobal = globalThis as typeof globalThis & { wx: WxApi },
    prior = {
      getApp: globalThis.getApp,
      wx: nativeGlobal.wx,
      Page: globalThis.Page,
    };
  const app = {
    community: list.runtime,
    experience: personal.runtime,
  } as WhaleuApp;
  globalThis.getApp = (() => app) as typeof getApp;
  nativeGlobal.wx = {} as WxApi;
  interface PersonalPage {
    data: ExperienceView;
    setData(patch: Record<string, unknown>): void;
    onShow(): void;
    onHide(): void;
    onUnload(): void;
    onToggleTitleRules(): void;
    onColor(event: { currentTarget: { dataset: { id: number } } }): void;
  }
  let definition: PersonalPage | undefined,
    page: PersonalPage | undefined,
    ranking: NativeRankingPage | undefined;
  try {
    globalThis.Page = ((value: object) => {
      definition = value as PersonalPage;
    }) as typeof Page;
    await import('../src/pages/experience/experience.js');
    assert.ok(definition);
    page = {
      ...definition,
      data: { ...definition.data },
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };
    page.onShow();
    await flush();
    page.onColor({ currentTarget: { dataset: { id: 0 } } });
    assert.equal(page.data.appearanceDirty, true);
    const accountId = wireCredentials().accountId;
    personal.runtime.pending.freeze({
      version: 1,
      accountId,
      intent: { operation: 'sign_in', requestId },
    });
    personal.runtime.pending.freeze({
      version: 1,
      accountId,
      intent: {
        operation: 'appearance',
        requestId: '77777777-7777-4777-8777-222222222222',
        expectedRevision: '1',
        titleKey: null,
        colorId: 0,
      },
    });
    personal.runtime.pending.redemption.freeze(
      accountId,
      '77777777-7777-4777-8777-333333333333',
    );
    const journals = structuredClone([...personal.storage.data]),
      calls = structuredClone(personal.gateway.calls);
    const beforeToggle = structuredClone(page.data);
    page.onToggleTitleRules();
    assert.deepEqual(page.data, { ...beforeToggle, rulesExpanded: true });
    type Node =
      string | { tag: string; attrs: Record<string, string>; children: Node[] };
    const model = createRequire(__filename)('../scripts/smoke-ratings.mjs') as {
      parse(source: string): Exclude<Node, string>;
      render(nodes: Node[], scope: unknown, templates: object): Node[];
    };
    const tree = model.parse(
      readFileSync(
        join(__dirname, '../src/pages/experience/experience.wxml'),
        'utf8',
      ),
    );
    const flatten = (nodes: Node[]): Exclude<Node, string>[] =>
      nodes.flatMap((node) =>
        typeof node === 'string' ? [] : [node, ...flatten(node.children)],
      );
    const text = (nodes: Node[]): string =>
      nodes
        .map((node): string =>
          typeof node === 'string' ? node : text(node.children),
        )
        .join(' ');
    const directory = flatten(model.render(tree.children, page.data, {})).find(
      (node) => node.attrs.id === 'level-title-rules',
    )!;
    assert.ok(directory);
    const rendered = text(directory.children);
    assert.equal((rendered.match(/规则解锁等级：/g) ?? []).length, 15);
    for (const rule of page.data.levelTitleRules)
      assert.ok(rendered.includes(rule.name));
    assert.doesNotMatch(rendered, /良辰美景|鲸小语|已解锁|未解锁/);
    assert.deepEqual(
      flatten(directory.children)
        .filter((node) => node.attrs.bindtap)
        .map((node) => node.attrs.bindtap),
      ['onToggleTitleRules'],
    );
    page.onToggleTitleRules();
    assert.deepEqual(page.data, beforeToggle);
    const collapsed = flatten(model.render(tree.children, page.data, {})).find(
      (node) => node.attrs.id === 'level-title-rules',
    )!;
    assert.doesNotMatch(text(collapsed.children), /规则解锁等级：/);
    assert.deepEqual([...personal.storage.data], journals);
    assert.deepEqual(personal.gateway.calls, calls);
    page.onToggleTitleRules();
    page.onHide();
    assert.equal(page.data.rulesExpanded, false);
    assert.deepEqual(page.data.levelTitleRules, []);
    assert.equal(page.data.appearanceDirty, false);
    const registered = await loadDefinition();
    ranking = {
      ...registered,
      data: { ...registered.data },
      setData(patch) {
        this.data = { ...this.data, ...patch };
      },
    };
    ranking.onShow();
    await flush();
    assert.equal(ranking.data.loaded, true);
    ranking.onHide();
    assert.deepEqual([...personal.storage.data], journals);
    assert.deepEqual(
      personal.gateway.calls,
      calls,
      'List must never replay sign-in, appearance, redemption or notice acknowledgements',
    );
    const replacement = experienceSetup();
    replacement.controller.dispose();
    const newOrigin = new ExperienceRuntime(
      replacement.sessions,
      replacement.gateway,
      new PendingExperienceStore(
        personal.storage,
        'https://replacement.example.invalid',
      ),
      async () => requestId,
    );
    try {
      app.experience = newOrigin;
      page.onShow();
      await flush();
      assert.equal(page.data.loaded, true);
      assert.equal(page.data.rulesExpanded, false);
      assert.equal(page.data.levelTitleRules.length, 15);
      assert.equal(page.data.signInPending, false);
      assert.equal(page.data.appearancePending, false);
      assert.equal(page.data.redemptionPending, false);
      page.onToggleTitleRules();
      page.onUnload();
      assert.deepEqual(page.data.levelTitleRules, []);
      assert.equal(page.data.rulesExpanded, false);
      assert.deepEqual([...personal.storage.data], journals);
      assert.deepEqual(personal.gateway.calls, calls);
    } finally {
      newOrigin.dispose();
      replacement.runtime.dispose();
    }
  } finally {
    ranking?.onUnload();
    page?.onUnload();
    personal.runtime.dispose();
    list.controller.dispose();
    globalThis.Page = prior.Page;
    globalThis.getApp = prior.getApp;
    nativeGlobal.wx = prior.wx;
  }
});
