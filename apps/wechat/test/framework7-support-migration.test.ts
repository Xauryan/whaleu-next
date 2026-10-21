import { assertReviewedNativeHarnessSuccessor } from './reviewed-native-harness-successor';
import { assertReviewedNoticeExposureSuccessor } from './reviewed-notice-exposure-successor';
import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import type { FeedbackView } from '../src/pages/feedback/controller';
import type { TradingContactsView } from '../src/community/trading-controller';
import type { ModerationView } from '../src/account-moderation/controller';
import type {
  Command,
  Receipt,
  PunishmentView,
  AppealView,
} from '../src/account-moderation/contract';
import type { ModerationGateway } from '../src/account-moderation/gateway';
import { PendingModerationStore } from '../src/account-moderation/pending';
import type {
  ReportMutationView,
  ReportProgressView,
} from '../src/community/report-controller';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
import {
  setup,
  post,
  postId,
  otherId,
  space,
  spaceId,
  createdAt,
} from './community-helpers';
import {
  reportHarness,
  reportProgress,
  juryProgress,
  reportReceipt,
} from './report-helpers';
import { deferred, flush as shortFlush } from './helpers';
import { wireCredentials } from './identity-helpers';
const root = path.join(__dirname, '..');
const nativeRequire = createRequire(__filename);
const { parsePreviewWxml: parse } = nativeRequire(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, ext = 'wxml') =>
  read(`src/pages/${page}/${page}.${ext}`);
const pages = [
  'feedback',
  'feedback-contacts',
  'report-progress',
  'account-status',
  'safety-appeal',
  'status',
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
  read('test/fixtures/framework7-support-before-actions.json'),
) as Record<string, { sourceSha256: string; actions: Action[] }>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-support-before-protected.json'),
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
  test(`${file}: all original actions, datasets, loading/disabled and ancestor gates survive`, () => {
    const current = actions(parse(read(file)));
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
test('protected business, privacy, accepted pages, components and original test evidence remain byte-identical except explicit reviewed business successors', () => {
  assert.equal(Object.keys(protectedFiles).length, 137);
  const successors = JSON.parse(
    read('test/fixtures/framework7-support-reviewed-moderation-successor.json'),
  ) as Record<
    string,
    {
      before: string;
      beforeEvidence: string;
      after: string;
      successorEvidence: string;
    }
  >;
  assert.deepEqual(
    Object.keys(successors).sort(),
    ['json', 'wxml', 'wxss']
      .map(
        (extension) =>
          `src/pages/feedback-notices/feedback-notices.${extension}`,
      )
      .sort(),
  );
  for (const [file, hash] of Object.entries(protectedFiles).filter(
    ([file, expected]) =>
      !assertReviewedNoticeExposureSuccessor(file, expected) &&
      !assertReviewedBusinessSuccessor(file, expected) &&
      !assertReviewedNativeHarnessSuccessor(file, expected),
  )) {
    const successor = successors[file];
    if (successor) {
      assert.equal(successor.before, hash);
      assert.equal(
        createHash('sha256')
          .update(read(successor.beforeEvidence))
          .digest('hex'),
        hash,
        file,
      );
      assert.equal(
        createHash('sha256').update(read(file)).digest('hex'),
        successor.after,
        file,
      );
      assert.match(read(successor.successorEvidence), /feedback-notices/);
      continue;
    }
    const evidence =
      file === 'test/support-product-presentation.test.ts'
        ? 'test/fixtures/framework7-support-original-presentation.txt'
        : file;
    assert.equal(
      createHash('sha256').update(read(evidence)).digest('hex'),
      hash,
      file,
    );
  }
});
for (const page of pages)
  test(`${page}: uses only registered frozen native components without DOM or new overlays`, () => {
    const nodes = flatten(parse(source(page)));
    const config = JSON.parse(source(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    assert.ok(nodes.some((node) => node.tag === 'wu-f7-block'));
    if (page !== 'status')
      assert.ok(nodes.some((node) => node.tag === 'wu-f7-button'));
    for (const node of nodes.filter((node) => node.tag.startsWith('wu-f7-'))) {
      assert.ok(
        ['wu-f7-button', 'wu-f7-block', 'wu-f7-list'].includes(node.tag),
      );
      const kind = node.tag.slice(3);
      assert.equal(
        config.usingComponents[node.tag],
        `../../components/${kind}/${kind}`,
      );
      assert.equal(node.attrs['open-type'], undefined);
    }
    assert.doesNotMatch(
      source(page),
      /web-view|wu-f7-(sheet|dialog|actions)|https?:\/\/|data:image/,
    );
    assert.match(source(page, 'wxss'), /framework7-support\.wxss/);
  });
test('textarea, navigation and shared post-pin exceptions remain explicit and native', () => {
  const textarea = flatten(parse(source('safety-appeal'))).find(
    (n) => n.tag === 'textarea',
  )!;
  assert.equal(textarea.attrs.bindinput, 'onText');
  assert.equal(textarea.attrs.maxlength, '4000');
  assert.equal(textarea.attrs.disabled, '{{busy || frozen}}');
  assert.match(
    source('feedback'),
    /import src="\.\.\/\.\.\/post-pins\/management\.wxml"/,
  );
  assert.match(
    source('feedback'),
    /import src="\.\.\/\.\.\/post-pins\/feed\.wxml"/,
  );
  assert.equal(
    actions(parse(source('status'))).filter((a) => a.tag === 'navigator')
      .length,
    2,
  );
});
test('the dedicated preview fixtures preserve all 23 reviewed fictional cases and markers', () => {
  type Fixture = {
    id: string;
    page: string;
    patch: Record<string, unknown>;
    expectedText: string[];
  };
  const original = (
    nativeRequire('../scripts/fixtures/support-preview.mjs') as {
      default: Fixture[];
    }
  ).default;
  const migrated = (
    nativeRequire('../scripts/fixtures/framework7-support-preview.mjs') as {
      default: Fixture[];
    }
  ).default;
  assert.equal(migrated.length, 23);
  assert.equal(new Set(migrated.map((fixture) => fixture.id)).size, 23);
  for (const [index, fixture] of migrated.entries()) {
    assert.equal(
      fixture.id,
      original[index]!.id.replace(/^support-/, 'framework7-support-'),
    );
    assert.equal(fixture.page, original[index]!.page);
    assert.deepEqual(fixture.patch, original[index]!.patch);
    assert.deepEqual(fixture.expectedText, original[index]!.expectedText);
  }
});
interface Owner {
  [key: string]: unknown;
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>, callback?: () => void): void;
}
interface Capture {
  press(): boolean;
  detach(): void;
}
interface Bridge {
  capture(handler: string, dataset?: Record<string, unknown>): Capture;
  find(
    handler: string,
    dataset?: Record<string, unknown>,
  ): PresentationNode | undefined;
  lifecycle(name: string): void;
  emissions: Array<{ currentTarget: { dataset: Record<string, unknown> } }>;
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
function invoke(target: Owner, name: string, event?: unknown) {
  return (target[name] as (event?: unknown) => unknown).call(target, event);
}
async function flush() {
  for (let i = 0; i < 20; i++) await shortFlush();
}
function mount(page: string, runtime: CommunityRuntime, query: unknown = {}) {
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = { wx: globals.wx, getApp: globals.getApp, Page: globals.Page },
    clipboard: string[] = [];
  globals.wx = {
    setClipboardData: ({
      data,
      success,
    }: {
      data: string;
      success: () => void;
    }) => {
      clipboard.push(data);
      success();
    },
  };
  globals.getApp = () => ({ community: runtime });
  let definition: Owner | undefined;
  globals.Page = (value: Owner) => {
    definition = value;
  };
  const file = nativeRequire.resolve(
    path.join(root, `src/pages/${page}/${page}.ts`),
  );
  try {
    delete nativeRequire.cache[file];
    nativeRequire(file);
  } finally {
    globals.Page = previous.Page;
  }
  assert.ok(definition);
  const target: Owner = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch, callback) {
      Object.assign(this.data, patch);
      callback?.();
    },
  };
  if (typeof target.onLoad === 'function') invoke(target, 'onLoad', query);
  if (typeof target.onShow === 'function') invoke(target, 'onShow');
  const bridge = createNativePressBridge({
    page: target,
    pageFile: path.join(root, `src/pages/${page}/${page}`),
    dist: path.join(root, 'src'),
    extension: 'ts',
  });
  return {
    target,
    bridge,
    clipboard,
    press(handler: string, dataset: Record<string, unknown> = {}) {
      const captured = bridge.capture(handler, dataset);
      const result = captured.press();
      captured.detach();
      return result;
    },
    hide() {
      bridge.lifecycle('hide');
      invoke(target, 'onHide');
    },
    close() {
      bridge.lifecycle('detach');
      invoke(target, 'onUnload');
      Object.assign(globals, previous);
    },
  };
}
const reportView = (page: Owner) => page.data.report as ReportMutationView;
const voteView = (page: Owner) => page.data.juryVote as ReportMutationView;
const progressView = (page: Owner) =>
  page.data.reportProgress as ReportProgressView;
const contactsView = (page: Owner) => page.data.contacts as TradingContactsView;
const moderationView = (page: Owner) => page.data as unknown as ModerationView;

test('actual Button → feedback Page/controller refresh, continuation and stale/busy guards preserve public feed scope', async () => {
  const s = setup();
  let reads = 0;
  const cursors: unknown[] = [];
  Object.assign(s.gateway, {
    feedbackTopic: async () => ({ space: space({ kind: 'global' }) }),
  });
  s.gateway.feedImpl = async (query) => {
    reads++;
    cursors.push(query.cursor);
    return {
      items: [
        post({
          category: 'feedback',
          space: { id: spaceId, kind: 'global', name: '合成公开反馈' },
          feedback: { authorSchool: '合成大学', hasContacts: false },
        }),
      ],
      nextCursor: reads === 1 ? 'cursor-next' : null,
      continuation: reads === 1 ? 'available' : 'end',
    };
  };
  const m = mount('feedback', s.runtime);
  try {
    await flush();
    assert.equal((m.target.data as unknown as FeedbackView).loaded, true);
    assert.equal(reads, 1);
    const stale = m.bridge.capture('onMore');
    assert.equal(m.press('onMore'), true);
    assert.equal(stale.press(), false);
    await flush();
    assert.deepEqual(cursors, [undefined, 'cursor-next']);
    assert.equal((m.target.data as unknown as FeedbackView).posts.length, 1);
    const old = m.bridge.capture('onRefresh');
    assert.equal(m.press('onRefresh'), true);
    assert.equal(old.press(), false);
    assert.equal(m.press('onRefresh'), false);
    await flush();
    assert.equal(reads, 3);
    const hidden = m.bridge.capture('onRefresh');
    m.hide();
    assert.equal(hidden.press(), false);
  } finally {
    m.close();
  }
});

test('actual Button → contact Page/controller checks every reveal/copy and never reuses stale private values', async () => {
  const s = setup();
  let reads = 0,
    denied = false;
  s.gateway.postImpl = async () =>
    post({
      category: 'feedback',
      feedback: { authorSchool: '合成大学', hasContacts: true },
    });
  Object.assign(s.gateway, {
    feedbackContacts: async () => {
      reads++;
      if (denied)
        throw new ClientError('http', 'denied', {
          httpStatus: 403,
          serverCode: 'FORBIDDEN',
        });
      return {
        postId,
        contacts: { wechat: `fictional-${reads}`, qq: '', phone: '' },
      };
    },
  });
  const m = mount('feedback-contacts', s.runtime, { postId });
  try {
    await flush();
    assert.equal(reads, 0);
    assert.equal(m.bridge.find('onCopy'), undefined);
    assert.equal(m.press('onReveal'), true);
    await flush();
    assert.equal(reads, 1);
    const stale = m.bridge.capture('onCopy', { field: 'wechat' });
    assert.equal(m.press('onCopy', { field: 'wechat' }), true);
    assert.equal(stale.press(), false);
    await flush();
    assert.deepEqual(m.clipboard, ['fictional-2']);
    assert.deepEqual(
      m.bridge.emissions[m.bridge.emissions.length - 1]?.currentTarget.dataset,
      {
        field: 'wechat',
      },
    );
    denied = true;
    assert.equal(m.press('onCopy', { field: 'wechat' }), true);
    await flush();
    assert.equal(contactsView(m.target).contacts, null);
    assert.equal(contactsView(m.target).enabled, false);
    assert.equal(m.bridge.find('onCopy'), undefined);
    assert.equal(m.press('onReveal'), false);
    assert.equal(m.clipboard.length, 1);
    denied = false;
    assert.equal(m.press('onReload'), true);
    await flush();
    assert.equal(m.press('onReveal'), true);
    await flush();
    const hidden = m.bridge.capture('onCopy', { field: 'wechat' });
    m.hide();
    assert.equal(hidden.press(), false);
    assert.equal(contactsView(m.target).contacts, null);
  } finally {
    m.close();
  }
});

test('actual report controls freeze one immutable intent and recover target-free without granting removed-content access', async () => {
  const s = reportHarness();
  s.controller.dispose();
  s.behavior.apply = async () => {
    throw new ClientError('timeout', 'synthetic lost result');
  };
  let m = mount('report-progress', s.runtime, { kind: 'post', id: postId });
  try {
    await flush();
    assert.equal(progressView(m.target).canReport, true);
    assert.equal(m.press('onReport'), true);
    assert.equal(reportView(m.target).confirmation?.operation, 'report');
    assert.equal(m.press('onDismissReport'), true);
    assert.equal(s.sent.length, 0);
    m.press('onReport');
    const stale = m.bridge.capture('onConfirmReport');
    assert.equal(m.press('onConfirmReport'), true);
    assert.equal(stale.press(), false);
    await flush();
    assert.equal(s.sent.length, 1);
    assert.equal(reportView(m.target).frozen, true);
    const pending = s.runtime.pendingReports.load(s.accountId)!;
    m.close();
    m = mount('report-progress', s.runtime);
    await flush();
    assert.equal(m.target.data.hasTarget, false);
    assert.equal(m.bridge.find('onReport'), undefined);
    s.behavior.receipt = async () => {
      throw new ClientError('http', 'missing', {
        serverCode: 'REQUEST_NOT_FOUND',
      });
    };
    m.press('onReportReceipt');
    await flush();
    assert.deepEqual(s.runtime.pendingReports.load(s.accountId), pending);
    s.behavior.apply = async (intent) => reportReceipt(intent);
    m.press('onReportRetry');
    await flush();
    assert.equal(s.sent.length, 2);
    assert.deepEqual(s.sent[1], pending.intent);
    assert.equal(reportView(m.target).frozen, false);
    assert.equal(m.bridge.find('onReport'), undefined);
  } finally {
    m.close();
  }
});

test('actual jury buttons preserve vote dataset, confirmation and busy suppression without exposing protected tallies', async () => {
  const s = reportHarness('vote');
  s.controller.dispose();
  s.behavior.progress = async () => juryProgress();
  const pending = deferred<ReturnType<typeof reportReceipt>>();
  s.behavior.apply = async () => pending.promise;
  const m = mount('report-progress', s.runtime, { kind: 'post', id: postId });
  try {
    await flush();
    assert.equal(progressView(m.target).showTallies, false);
    assert.equal(m.press('onJuryChoice', { vote: 'remove' }), true);
    assert.equal(voteView(m.target).confirmation?.operation, 'vote');
    assert.equal(
      (voteView(m.target).confirmation as { vote: string }).vote,
      'remove',
    );
    assert.deepEqual(
      m.bridge.emissions[m.bridge.emissions.length - 1]?.currentTarget.dataset,
      {
        vote: 'remove',
      },
    );
    m.press('onDismissJuryVote');
    m.press('onJuryChoice', { vote: 'keep' });
    m.press('onConfirmJuryVote');
    await flush();
    assert.equal(s.sent.length, 1);
    assert.equal(m.press('onJuryChoice', { vote: 'remove' }), false);
    pending.resolve(reportReceipt(s.sent[0]));
    await flush();
    assert.equal(voteView(m.target).frozen, false);
    assert.equal(s.sent[0]?.operation, 'vote');
    const stale = m.bridge.capture('onReloadReportProgress');
    s.behavior.progress = async () => ({ ...reportProgress(), isSelf: true });
    m.press('onReloadReportProgress');
    assert.equal(stale.press(), false);
    await flush();
    assert.equal(m.bridge.find('onReport'), undefined);
    assert.equal(m.bridge.find('onJuryChoice'), undefined);
  } finally {
    m.close();
  }
});

const punishment = (): PunishmentView => ({
  punishmentId: postId,
  kind: 'interaction_mute',
  revision: '1',
  reason: '合成处罚',
  startsAt: createdAt,
  endsAt: null,
  recordedAt: createdAt,
  state: 'active',
  terminal: null,
  canAppeal: true,
  openAppealId: null,
});
const appeal = (): AppealView => ({
  appealId: otherId,
  punishment: punishment(),
  text: '合成私人申诉',
  submittedAt: createdAt,
  state: 'pending',
  decision: null,
});
function moderationHarness() {
  const s = setup(),
    sent: Array<{ command: Command; cancel: boolean }> = [],
    historyAfter: Array<string | undefined> = [],
    selections: string[] = [];
  const store = new PendingModerationStore(
    s.storage,
    'https://synthetic.support.example',
  );
  const result = (command: Command, cancel = false): Receipt => {
    assert.equal(command.action, 'submit_appeal');
    if (command.action !== 'submit_appeal')
      throw Error('Only consumer appeal submission is allowed');
    return {
      ...(cancel
        ? { outcome: 'rejected' as const, code: 'SAFETY_MODERATION_CANCELLED' }
        : {
            outcome: 'applied' as const,
            recordedAt: createdAt,
            appealId: otherId,
            reusedOpenCase: false,
          }),
      requestId: command.clientRequestId,
      action: command.action,
      punishment: command.punishment,
    };
  };
  const forbidden = async (): Promise<never> => {
    throw Error('Consumer attempted an admin gateway');
  };
  const gateway: ModerationGateway = {
    status: async () => ({
      coverage: 'complete',
      effective: 'interaction_mute',
      checkedAt: createdAt,
      current: [punishment()],
    }),
    ownPunishment: async () => punishment(),
    history: async (_cancel, after) => {
      historyAfter.push(after);
      return {
        items: [punishment()],
        nextCursor: after ? null : 'history-next',
      };
    },
    appeals: async () => ({ items: [appeal()], nextCursor: null }),
    appeal: async (id) => {
      selections.push(id);
      return appeal();
    },
    punishments: forbidden,
    punishment: forbidden,
    punishmentHistory: forbidden,
    appealQueue: forbidden,
    appealManagement: forbidden,
    submit: async (command, _cancel, cancel = false) => {
      sent.push({ command, cancel });
      assert.deepEqual(store.load(s.accountId)?.command, command);
      return result(command, cancel);
    },
    receipt: async () => ({ state: 'not_recorded' }),
  };
  const runtime: CommunityRuntime = {
    ...s.runtime,
    accountModeration: gateway,
    pendingAccountModeration: store,
  };
  return {
    ...s,
    runtime,
    gateway,
    store,
    sent,
    result,
    historyAfter,
    selections,
  };
}

test('actual account-status buttons recheck coverage and paginate original-account history without changing safety state', async () => {
  const s = moderationHarness(),
    m = mount('account-status', s.runtime);
  try {
    await flush();
    assert.equal(
      moderationView(m.target).accountStatus?.effective,
      'interaction_mute',
    );
    m.press('onHistory');
    await flush();
    assert.equal(moderationView(m.target).history.length, 1);
    m.press('onMoreHistory');
    await flush();
    assert.deepEqual(s.historyAfter, [undefined, 'history-next']);
    assert.equal(moderationView(m.target).history.length, 2);
    s.gateway.status = async () => ({
      coverage: 'unavailable',
      effective: 'clear',
      checkedAt: createdAt,
      current: [],
    });
    const old = m.bridge.capture('onReload');
    assert.equal(m.press('onReload'), true);
    assert.equal(old.press(), false);
    assert.equal(m.press('onReload'), false);
    await flush();
    assert.equal(
      moderationView(m.target).accountStatus?.coverage,
      'unavailable',
    );
    assert.equal(s.sent.length, 0);
    const hidden = m.bridge.capture('onReload');
    m.hide();
    assert.equal(hidden.press(), false);
    assert.equal(moderationView(m.target).accountStatus, null);
  } finally {
    m.close();
  }
});

test('actual private appeal buttons preserve selection dataset, explicit confirmation, immutable retry and cleared private projections', async () => {
  const s = moderationHarness();
  const normalSubmit = s.gateway.submit;
  s.gateway.submit = async (...args) => {
    await normalSubmit(...args);
    throw new ClientError('timeout', 'synthetic lost response');
  };
  let m = mount('safety-appeal', s.runtime, { punishmentId: postId });
  try {
    await flush();
    assert.equal(
      moderationView(m.target).selectedPunishment?.punishmentId,
      postId,
    );
    assert.equal(m.press('onRequestAppeal'), false);
    // The 4000-character textarea remains a native editor, not an F7 component.
    const editor = flatten(parse(source('safety-appeal'))).find(
      (n) => n.tag === 'textarea' && n.attrs.bindinput === 'onText',
    );
    assert.ok(editor);
    invoke(m.target, 'onText', { detail: { value: '合成私人申诉' } });
    m.press('onRequestAppeal');
    assert.equal(moderationView(m.target).confirming, 'submit_appeal');
    m.press('onClose');
    assert.equal(s.sent.length, 0);
    m.press('onRequestAppeal');
    const stale = m.bridge.capture('onSubmit');
    m.press('onSubmit');
    assert.equal(stale.press(), false);
    await flush();
    assert.equal(s.sent.length, 1);
    assert.equal(moderationView(m.target).frozen, true);
    const original = s.store.load(s.accountId)!;
    assert.equal(original.command.action, 'submit_appeal');
    assert.equal(moderationView(m.target).selectedPunishment, null);
    assert.equal(m.bridge.find('onSubmit'), undefined);
    m.close();
    m = mount('safety-appeal', s.runtime);
    await flush();
    m.press('onRecover');
    await flush();
    assert.deepEqual(s.store.load(s.accountId), original);
    assert.equal(s.sent.length, 1);
    s.gateway.submit = normalSubmit;
    m.press('onRetry');
    await flush();
    assert.equal(s.sent.length, 2);
    assert.deepEqual(s.sent[1]?.command, original.command);
    assert.equal(moderationView(m.target).frozen, false);
    assert.equal(s.store.load(s.accountId), null);
    m.press('onSelectAppeal', { id: otherId });
    await flush();
    assert.deepEqual(s.selections, [otherId]);
    assert.equal(moderationView(m.target).selectedAppeal?.appealId, otherId);
    assert.deepEqual(
      m.bridge.emissions[m.bridge.emissions.length - 1]?.currentTarget.dataset,
      {
        id: otherId,
      },
    );
    const old = m.bridge.capture('onReload');
    s.sessions.logout();
    assert.equal(old.press(), false);
    assert.equal(moderationView(m.target).selectedAppeal, null);
    assert.equal(moderationView(m.target).text, '');
  } finally {
    m.close();
  }
});

test('actual recovery cancellation requires its own confirmation and cannot roll back an already-recorded result', async () => {
  const s = moderationHarness();
  const command: Command = {
    clientRequestId: '77777777-7777-4777-8777-777777777777',
    action: 'submit_appeal',
    punishment: {
      punishmentId: postId,
      kind: 'interaction_mute',
      revision: '1',
    },
    text: '原私人申诉',
  };
  s.store.freeze({
    version: 1,
    origin: s.store.origin,
    accountId: s.accountId,
    phase: 'submit',
    command,
  });
  let m = mount('safety-appeal', s.runtime);
  try {
    await flush();
    assert.equal(moderationView(m.target).frozen, true);
    m.press('onCancelRequest');
    assert.equal(moderationView(m.target).confirming, 'cancel');
    assert.equal(s.sent.length, 0);
    m.press('onClose');
    assert.equal(s.store.load(s.accountId)?.phase, 'submit');
    const foreign = m.bridge.capture('onRetry');
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('c'),
      accountId: otherId,
      sessionId: postId,
    });
    assert.equal(foreign.press(), false);
    assert.equal(moderationView(m.target).pendingCommand, null);
    assert.equal(s.store.load(otherId), null);
    assert.deepEqual(s.store.load(s.accountId)?.command, command);
    m.close();
    s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
    m = mount('safety-appeal', s.runtime);
    await flush();
    s.gateway.submit = async (value, _cancel, cancelling) => {
      assert.equal(cancelling, true);
      assert.equal(s.store.load(s.accountId)?.phase, 'cancel');
      s.sent.push({ command: value, cancel: !!cancelling });
      return s.result(value);
    };
    m.press('onCancelRequest');
    m.press('onConfirmCancel');
    await flush();
    assert.equal(s.sent.length, 1);
    assert.deepEqual(s.sent[0], { command, cancel: true });
    assert.equal(moderationView(m.target).recordedReceipt?.outcome, 'applied');
    assert.equal(moderationView(m.target).frozen, false);
    assert.equal(s.store.load(s.accountId), null);
  } finally {
    m.close();
  }
});

test('late contact response after account replacement never reaches clipboard or private view', async () => {
  const s = setup(),
    pending = deferred<{
      postId: string;
      contacts: { wechat: string; qq: string; phone: string };
    }>();
  s.gateway.postImpl = async () =>
    post({
      category: 'feedback',
      feedback: { authorSchool: '合成大学', hasContacts: true },
    });
  Object.assign(s.gateway, { feedbackContacts: async () => pending.promise });
  const m = mount('feedback-contacts', s.runtime, { postId });
  try {
    await flush();
    m.press('onReveal');
    await shortFlush();
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('c'),
      accountId: otherId,
      sessionId: postId,
    });
    pending.resolve({
      postId,
      contacts: { wechat: 'must-not-leak', qq: '', phone: '' },
    });
    await flush();
    assert.equal(contactsView(m.target).contacts, null);
    assert.deepEqual(m.clipboard, []);
    assert.equal(m.bridge.find('onCopy'), undefined);
  } finally {
    m.close();
  }
});
