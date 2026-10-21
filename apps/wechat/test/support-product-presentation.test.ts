import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { normalizeFramework7ActionNode } from './framework7-action-parity';
import { initialModerationView } from '../src/account-moderation/controller';
import { initialFeedbackView } from '../src/pages/feedback/controller';
import { initialCommunityView } from '../src/community/controller';
import { initialTradingContactsView } from '../src/community/trading-controller';
import {
  initialReportMutationView,
  initialReportProgressView,
} from '../src/community/report-controller';
import {
  initialPinFeedView,
  initialPinDetailView,
} from '../src/post-pins/controller';

type Node =
  string | { tag: string; attrs: Record<string, string>; children: Node[] };
type Element = Exclude<Node, string>;
type Action = {
  tag: string;
  attrs: Record<string, string>;
  ancestors: Record<string, string>[];
};
type Fixture = {
  id: string;
  page: string;
  title: string;
  patch: Record<string, unknown>;
  expectedText: string[];
};
const require = createRequire(__filename);
const { parsePreviewWxml: parse } = require('../scripts/preview-wxml.mjs') as {
  parsePreviewWxml(source: string): Element;
};
const { render: renderNodes } = require('../scripts/smoke-ratings.mjs') as {
  render(
    nodes: Node[],
    data: Record<string, unknown>,
    templates: Record<string, Element>,
  ): Node[];
};
const fixtures = (
  require('../scripts/fixtures/support-preview.mjs') as { default: Fixture[] }
).default;
const root = path.resolve(__dirname, '../src');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, extension = 'wxml') =>
  read(`pages/${page}/${page}.${extension}`);
const defaults = (page: string): Record<string, unknown> => {
  if (page === 'feedback')
    return {
      ...initialFeedbackView(),
      postPin: initialPinFeedView(),
      postPinManagement: initialPinDetailView(),
    };
  if (page === 'feedback-contacts')
    return {
      ...initialCommunityView(),
      loaded: false,
      contacts: initialTradingContactsView(),
    };
  if (page === 'report-progress')
    return {
      hasTarget: false,
      addressError: '',
      report: initialReportMutationView(),
      juryVote: initialReportMutationView('vote'),
      reportProgress: initialReportProgressView(),
    };
  if (page === 'status')
    return {
      title: '鲸语校园',
      stage: '开发预览',
      summary: '功能仍在完善，当前构建不代表正式服务已开放。',
      notice: '此构建未连接生产服务，也不会自动登录。请勿作为正式版本发布。',
    };
  return {
    ...initialModerationView(page === 'account-status' ? 'status' : 'appeal'),
  };
};
function document(page: string) {
  const templates: Record<string, Element> = {};
  const seen = new Set<string>();
  const collect = (file: string): Element => {
    const tree = parse(read(file));
    if (seen.has(file)) return tree;
    seen.add(file);
    for (const node of tree.children) {
      if (typeof node === 'string') continue;
      if (node.tag === 'import')
        collect(path.join(path.dirname(file), node.attrs.src!));
      if (node.tag === 'template' && node.attrs.name)
        templates[node.attrs.name] = node;
    }
    return tree;
  };
  return { tree: collect(`pages/${page}/${page}.wxml`), templates };
}
const flatten = (nodes: Node[]): Node[] =>
  nodes.flatMap((n) =>
    typeof n === 'string' ? [n] : [n, ...flatten(n.children)],
  );
function render(page: string, patch: Record<string, unknown> = {}) {
  const { tree, templates } = document(page);
  return flatten(
    renderNodes(tree.children, { ...defaults(page), ...patch }, templates),
  );
}
const text = (nodes: Node[]) =>
  nodes
    .filter((n) => typeof n === 'string')
    .join(' ')
    .replace(/\s+/g, ' ');
const elements = (nodes: Node[]) =>
  nodes.filter((n): n is Element => typeof n !== 'string');
const actions = (nodes: Node[], handler: string) =>
  elements(nodes).filter(
    (n) =>
      n.attrs.bindtap === handler ||
      n.attrs['bind:press'] === handler ||
      n.attrs.bindinput === handler,
  );
const fixture = (id: string) => fixtures.find((f) => f.id === id)!.patch;

for (const f of fixtures)
  test(`${f.id} renders all mandatory markers without live data or providers`, () => {
    assert.ok(f.expectedText.length > 0);
    const output = text(render(f.page, f.patch));
    for (const marker of f.expectedText)
      assert.ok(output.includes(marker), `${f.id}: ${marker}`);
    assert.doesNotMatch(output, /undefined|\{\{|<template|匿名|评论/);
  });

const inventory = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/support-action-inventory.json'),
    'utf8',
  ),
) as { before: Record<string, Action[]>; after: Record<string, Action[]> };
function inventoryOf(template: string): Action[] {
  const result: Action[] = [];
  const walk = (nodes: Node[], ancestors: Record<string, string>[] = []) => {
    for (const raw of nodes) {
      if (typeof raw === 'string') continue;
      let n = normalizeFramework7ActionNode(raw);
      // Only the two reviewed presentational shells change ancestor tag names.
      if (n.tag === 'wu-f7-block' || n.tag === 'wu-f7-list')
        n = { ...n, tag: 'view' };
      const guards = Object.fromEntries(
        Object.entries(n.attrs).filter(([k]) =>
          [
            'wx:if',
            'wx:elif',
            'wx:else',
            'wx:for',
            'wx:for-item',
            'wx:key',
            'name',
            'is',
          ].includes(k),
        ),
      );
      if (
        Object.keys(n.attrs).some(
          (k) => k.startsWith('bind') || k.startsWith('catch') || k === 'url',
        )
      )
        result.push({
          tag: n.tag,
          attrs: Object.fromEntries(
            Object.entries(n.attrs).filter(
              ([k]) =>
                k.startsWith('bind') ||
                k.startsWith('catch') ||
                k.startsWith('data-') ||
                k === 'url' ||
                k === 'disabled' ||
                k.startsWith('wx:') ||
                k === 'maxlength',
            ),
          ),
          ancestors,
        });
      walk(
        n.children,
        Object.keys(guards).length
          ? [...ancestors, { tag: n.tag, ...guards }]
          : ancestors,
      );
    }
  };
  walk(parse(template).children);
  return result;
}
for (const [file, expected] of Object.entries(inventory.after))
  test(`${file} action identifiers, disabled gates and ancestor guards match reviewed inventory`, () => {
    assert.deepEqual(inventoryOf(read(file)), expected);
  });

test('every retained action preserves the original payload and disabled expression', () => {
  const oldActions = Object.values(inventory.before).flat();
  const current = Object.values(inventory.after).flat();
  for (const action of current.filter(
    (a) => a.attrs.bindtap || a.attrs.bindinput,
  )) {
    const key = action.attrs.bindtap ? 'bindtap' : 'bindinput';
    const originals = oldActions.filter(
      (a) => a.attrs[key] === action.attrs[key],
    );
    assert.ok(originals.length, `New unreviewed handler: ${action.attrs[key]}`);
    assert.ok(
      originals.some((old) =>
        Object.entries(old.attrs)
          .filter(
            ([name]) =>
              name === 'disabled' ||
              name.startsWith('data-') ||
              name === 'maxlength',
          )
          .every(([name, value]) => action.attrs[name] === value),
      ),
      `Changed mutation/recovery guard: ${action.attrs[key]}`,
    );
  }
});

test('feedback stays public, guest-safe, and excludes admin-only reminders; pin gates untouched', () => {
  const guest = render('feedback', {
    ...fixture('support-feedback-feed'),
    hasSession: false,
  });
  assert.ok(text(guest).includes('登录后参与讨论'));
  assert.ok(
    !elements(guest).some(
      (n) =>
        n.attrs.url?.includes('community-compose') ||
        n.attrs.url?.includes('community-detail'),
    ),
  );
  assert.doesNotMatch(
    source('feedback'),
    /feedback-notices|我的工单|已通知管理员/,
  );
  assert.match(
    source('feedback'),
    /template is="post-pin-management" data="\{\{management:postPinManagement\}\}"/,
  );
  assert.match(
    source('feedback'),
    /所有学校都能看到正文、审核通过的图片、公开身份或分身及认证学校/,
  );
});

test('contact values appear only after current checks and copy preserves field + busy gates', () => {
  const initial = render(
    'feedback-contacts',
    fixture('support-contacts-ready'),
  );
  assert.equal(actions(initial, 'onCopy').length, 0);
  assert.equal(actions(initial, 'onReveal')[0]?.attrs.disabled, 'false');
  const denied = render('feedback-contacts', fixture('support-contacts-error'));
  assert.equal(actions(denied, 'onReveal')[0]?.attrs.disabled, 'true');
  assert.equal(actions(denied, 'onCopy').length, 0);
  const busy = render('feedback-contacts', {
    ...fixture('support-contacts-revealed'),
    contacts: {
      ...initialTradingContactsView(),
      enabled: true,
      busy: true,
      contacts: { wechat: 'fictional_contact', qq: '', phone: '' },
    },
  });
  assert.equal(actions(busy, 'onCopy')[0]?.attrs['data-field'], 'wechat');
  assert.equal(actions(busy, 'onCopy')[0]?.attrs.disabled, 'true');
});

test('jury visibility, protected tallies, self-report and frozen submission gates survive layout changes', () => {
  const state = fixture('support-report-jury');
  const p = state.reportProgress as Record<string, unknown>;
  const progress = p.progress as Record<string, unknown>;
  const full = render('report-progress', state);
  assert.equal(actions(full, 'onJuryChoice').length, 2);
  assert.ok(!elements(full).some((n) => n.attrs.class === 'tally'));
  const ineligible = render('report-progress', {
    ...state,
    reportProgress: {
      ...p,
      canVote: false,
      progress: { ...progress, isSelf: true },
    },
  });
  assert.equal(actions(ineligible, 'onJuryChoice').length, 0);
  assert.equal(actions(ineligible, 'onReport').length, 0);
  const frozen = render('report-progress', {
    ...state,
    juryVote: { ...(state.juryVote as Record<string, unknown>), frozen: true },
  });
  assert.ok(
    actions(frozen, 'onJuryChoice').every((n) => n.attrs.disabled === 'true'),
  );
  const missing = render('report-progress', fixture('support-report-recovery'));
  assert.equal(actions(missing, 'onJuryChoice').length, 0);
  assert.equal(actions(missing, 'onReport').length, 0);
  assert.equal(actions(missing, 'onReportReceipt').length, 1);
  assert.equal(actions(missing, 'onReportRetry').length, 1);
});

test('unknown account coverage never becomes a clear state; per-punishment appeal gates remain distinct', () => {
  const clear = fixture('support-account-clear');
  const unknown = render('account-status', {
    ...clear,
    accountStatus: {
      ...(clear.accountStatus as Record<string, unknown>),
      coverage: 'unavailable',
    },
  });
  assert.match(text(unknown), /状态暂不能确认/);
  assert.doesNotMatch(text(unknown), /暂无生效处罚|当前无生效的禁言或封号/);
  const restricted = fixture('support-account-restricted');
  const account = restricted.accountStatus as {
    current: Record<string, unknown>[];
  };
  const locked = render('account-status', {
    ...restricted,
    frozen: true,
    accountStatus: {
      ...account,
      current: [
        {
          ...account.current[0],
          canAppeal: false,
          openAppealId: 'existing-case',
        },
      ],
    },
  });
  assert.ok(
    !elements(locked).some((n) => n.attrs.url?.includes('?punishmentId=')),
  );
  assert.ok(
    elements(locked).some((n) =>
      n.attrs.url?.includes('?appealId=existing-case'),
    ),
  );
  assert.equal(actions(locked, 'onHistory')[0]?.attrs.disabled, 'true');
});

test('private appeal form cannot bypass canAppeal, busy, frozen or explicit confirmation', () => {
  const form = fixture('support-appeal-form');
  const selected = form.selectedPunishment as Record<string, unknown>;
  const blocked = render('safety-appeal', {
    ...form,
    selectedPunishment: { ...selected, canAppeal: false },
  });
  assert.equal(actions(blocked, 'onText').length, 0);
  assert.equal(actions(blocked, 'onRequestAppeal').length, 0);
  assert.equal(actions(blocked, 'onSubmit').length, 0);
  for (const lock of [{ busy: true }, { frozen: true }, { text: '' }]) {
    const nodes = render('safety-appeal', { ...form, ...lock });
    assert.equal(actions(nodes, 'onRequestAppeal')[0]?.attrs.disabled, 'true');
    assert.equal(actions(nodes, 'onSubmit').length, 0);
  }
  const confirmed = render(
    'safety-appeal',
    fixture('support-appeal-confirmation'),
  );
  assert.equal(actions(confirmed, 'onSubmit').length, 1);
  assert.equal(actions(confirmed, 'onClose').length, 1);
  assert.match(text(confirmed), /仅你和当前有权的超级管理员可见/);
  for (const page of ['account-status', 'safety-appeal'])
    assert.doesNotMatch(
      source(page),
      /onRequestRelease|onRequestDecision|onReason|canDecide|pages\/feedback/,
    );
});

test('appeal original recovery remains reachable without selected case and keeps cancellation consequence', () => {
  const nodes = render('safety-appeal', fixture('support-appeal-recovery'));
  for (const name of ['onRecover', 'onRetry', 'onCancelRequest'])
    assert.equal(actions(nodes, name).length, 1);
  assert.equal(actions(nodes, 'onSubmit').length, 0);
  assert.match(text(nodes), /查询不到回执不代表失败/);
  const cancel = render('safety-appeal', fixture('support-appeal-cancel'));
  assert.equal(actions(cancel, 'onConfirmCancel').length, 1);
  assert.match(text(cancel), /不会回滚/);
});

test('six pages use native local icons, scoped semantic materials and honest build disclosure', () => {
  const app = JSON.parse(read('app.json')) as { pages: string[] };
  for (const page of [
    'feedback',
    'feedback-contacts',
    'report-progress',
    'account-status',
    'safety-appeal',
    'status',
  ]) {
    assert.ok(app.pages.includes(`pages/${page}/${page}`));
    assert.equal(
      (
        JSON.parse(source(page, 'json')) as {
          usingComponents: Record<string, string>;
        }
      ).usingComponents['wu-icon'],
      '../../components/icon/icon',
    );
    assert.doesNotMatch(
      source(page),
      /https?:\/\/|avatarUrl|<image|WHALEU|eyebrow/,
    );
    assert.doesNotMatch(source(page, 'wxss'), /community\/forms/);
  }
  assert.match(read('pages/account-status/support.wxss'), /min-height: 88rpx/);
  assert.match(source('status', 'ts'), /此构建未连接生产服务/);
});
