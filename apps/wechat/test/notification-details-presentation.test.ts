import { assertReviewedNoticeExposureSuccessor } from './reviewed-notice-exposure-successor';
import { assertReviewedNoticeReadSuccessor } from './reviewed-notice-read-successor';
import { assertReviewedSocialSuccessor } from './reviewed-social-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { normalizeFramework7ActionNode } from './framework7-action-parity';
import {
  noticeRows,
  noticeTime,
  noticeStatus,
  noticeScheduleTime,
  systemNoticeRows,
} from '../src/notifications/details';

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: (Node | string)[];
}
interface Action {
  tag: string;
  attrs: Record<string, string>;
  ancestors: Record<string, string>[];
}
interface Fixture {
  id: string;
  page: string;
  title: string;
  patch: Record<string, unknown>;
  expectedText: string[];
}
const requireNative = createRequire(__filename);
const { parsePreviewWxml } = requireNative('../scripts/preview-wxml.mjs') as {
  parsePreviewWxml(source: string): Node;
};
const { default: fixtures } = requireNative(
  '../scripts/fixtures/notification-details-preview.mjs',
) as { default: Fixture[] };
const root = path.join(__dirname, '../src');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, extension = 'wxml') =>
  read(`pages/${page}/${page}.${extension}`);
const inventory = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/notification-details-action-inventory.json'),
    'utf8',
  ),
) as {
  pages: Record<string, Action[]>;
  protectedHashes: Record<string, string>;
  registrars: Record<string, { before: string; after: string }>;
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const relevant = (attrs: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(attrs).filter(
      ([key]) =>
        /^(bind|catch|data-)/.test(key) ||
        [
          'url',
          'disabled',
          'loading',
          'wx:if',
          'wx:elif',
          'wx:else',
          'aria-expanded',
        ].includes(key),
    ),
  );
function actions(
  node: Node | string,
  ancestors: Record<string, string>[] = [],
): Action[] {
  if (typeof node === 'string') return [];
  node = normalizeFramework7ActionNode(node);
  const guards = Object.fromEntries(
    Object.entries(node.attrs).filter(([key]) =>
      [
        'wx:if',
        'wx:elif',
        'wx:else',
        'wx:for',
        'wx:for-item',
        'wx:key',
      ].includes(key),
    ),
  );
  const current =
    node.tag === 'navigator' ||
    Object.keys(node.attrs).some((key) => /^(bind|catch)/.test(key))
      ? [{ tag: node.tag, attrs: relevant(node.attrs), ancestors }]
      : [];
  return [
    ...current,
    ...node.children.flatMap((child) =>
      actions(
        child,
        Object.keys(guards).length ? [...ancestors, guards] : ancestors,
      ),
    ),
  ];
}
for (const [page, baseline] of Object.entries(inventory.pages)) {
  test(`${page}: every action retains its original data, disabled gate and ancestor guards`, () => {
    const current = actions(parsePreviewWxml(source(page)));
    for (const old of baseline)
      assert.ok(
        current.some(
          (candidate) =>
            candidate.tag === old.tag &&
            Object.entries(old.attrs).every(
              ([key, value]) => candidate.attrs[key] === value,
            ) &&
            old.ancestors.every((guard) =>
              candidate.ancestors.some((ancestor) =>
                Object.entries(guard).every(
                  ([key, value]) => ancestor[key] === value,
                ),
              ),
            ),
        ),
        `Missing or weakened ${page}: ${JSON.stringify(old)}`,
      );
  });
}

test('owner readers, route validation and receipt dispatch remain byte-for-byte unchanged', () => {
  for (const [file, hash] of Object.entries(inventory.protectedHashes).filter(
    ([file, expected]) =>
      !assertReviewedNoticeExposureSuccessor(file, expected) &&
      !assertReviewedNoticeReadSuccessor(file, expected) &&
      !assertReviewedSocialSuccessor(file, expected),
  ))
    assert.equal(sha(read(file)), hash, file);
});

test('shared discussion registrars change presentation only in notices, never other page modes', () => {
  for (const [file, hashes] of Object.entries(inventory.registrars)) {
    const content = read(file).replace(
      "import { noticeRows, noticeStatus } from '../notifications/details';\n",
      '',
    );
    const name = file.startsWith('window') ? 'Window' : 'Major';
    const start = content.indexOf(
      `export function register${name}DiscussionNoticesPage`,
    );
    const next = content.indexOf('\nexport function ', start + 1);
    assert.equal(
      sha(content.slice(0, start)),
      hashes.before,
      `${file}: earlier modes`,
    );
    assert.equal(
      sha(content.slice(next === -1 ? content.length : next)),
      hashes.after,
      `${file}: later modes`,
    );
    const notices = content.slice(start, next === -1 ? content.length : next);
    assert.equal(notices.match(/noticeRows\(view\.items\)/g)?.length, 1);
    assert.match(notices, /this\.gallery\?\.dispose\(\)/);
    assert.match(notices, /this\.controller\?\.dispose\(\)/);
    assert.match(notices, /this\.navigator\?\.dispose\(\)/);
  }
});

test('display mapping preserves raw dates, receipt namespaces, unread state, stable order and payload identity', () => {
  const now = new Date(2026, 9, 20, 12).getTime();
  const first = Object.freeze({
    key: 'community:same-id',
    noticeId: 'same-id',
    source: 'community',
    createdAt: new Date(2025, 9, 19, 9, 30).toISOString(),
    readAt: null,
    preview: { text: '真实预览' },
  });
  const second = Object.freeze({
    ...first,
    key: 'system:same-id',
    source: 'system',
    createdAt: new Date(2026, 9, 20, 8, 15).toISOString(),
    readAt: '2026-10-20T08:20:00Z',
  });
  const input = Object.freeze([first, second]);
  const rows = noticeRows(input, now);
  assert.deepEqual(
    rows.map((item) => item.key),
    ['community:same-id', 'system:same-id'],
  );
  assert.deepEqual(
    rows.map(({ timeLabel: _time, ...item }) => item),
    input,
  );
  assert.equal(rows[0]?.timeLabel, '2025年10月19日 09:30');
  assert.equal(rows[1]?.timeLabel, '10月20日 08:15');
  assert.equal(rows[0]?.preview, first.preview);
  assert.equal(noticeTime('not-a-date', now), '');
  assert.equal(noticeTime('', now), '');
  assert.equal('timeLabel' in first, false);
  assert.doesNotMatch(
    read('notifications/details.ts'),
    /sort\(|reverse\(|acknowledge|navigate|readAt:|noticeId:/,
  );
});

test('all seven detail pages use scoped semantic colors, native icons and 44px controls without diagnostic card stacks', () => {
  for (const page of Object.keys(inventory.pages)) {
    const content = source(page);
    assert.match(content, /class="notice-page/);
    assert.match(content, /<wu-icon/);
    assert.match(source(page, 'wxss'), /notifications\/details\.wxss/);
    const config = JSON.parse(source(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    assert.match(
      config.usingComponents['wu-icon'] ?? '',
      /components\/icon\/icon$/,
    );
    assert.doesNotMatch(
      content,
      /WHALEU|class="(?:card|hero|eyebrow)"|打开查看消息|匿名|评论|https?:\/\/|data:image|<rich-text/,
    );
    assert.doesNotMatch(content, /class="(?:sheet|modal|overlay)"/);
  }
  const css = read('notifications/details.wxss');
  for (const token of [
    '--wu-text',
    '--wu-secondary',
    '--wu-surface',
    '--wu-separator',
    '--wu-accent',
    '--wu-danger',
  ])
    assert.ok(css.includes(`var(${token})`));
  assert.match(css, /min-height: 88rpx/);
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /safe-area-inset-bottom/);
});

// Render actual source branches to text, never a hand-authored surrogate page.
function evaluate(value: string, scope: Record<string, unknown>): unknown {
  try {
    return Function(
      'scope',
      `with(scope){return (${value});}`,
    )(new Proxy(scope, { has: () => true }));
  } catch {
    return undefined;
  }
}
function interpolate(value: string, scope: Record<string, unknown>): string {
  return value.replace(/{{([\s\S]*?)}}/g, (_, expression: string) =>
    String(evaluate(expression, scope) ?? ''),
  );
}
function visibleText(
  nodes: (Node | string)[],
  scope: Record<string, unknown>,
): string {
  let output = '';
  let matched = false;
  for (const node of nodes) {
    if (typeof node === 'string') {
      output += interpolate(node, scope);
      continue;
    }
    if (['import', 'template', 'wu-icon'].includes(node.tag)) continue;
    const attrs = node.attrs;
    if (attrs['wx:for']) {
      const { ['wx:for']: loop, ...rest } = attrs;
      const items = evaluate(loop.slice(2, -2), scope) as unknown[] | undefined;
      output += (items ?? [])
        .map((item, index) =>
          visibleText([{ ...node, attrs: rest }], {
            ...scope,
            [attrs['wx:for-item'] ?? 'item']: item,
            [attrs['wx:for-index'] ?? 'index']: index,
          }),
        )
        .join(' ');
      continue;
    }
    if ('wx:if' in attrs) matched = false;
    const condition = attrs['wx:if'] ?? attrs['wx:elif'];
    if ('wx:elif' in attrs && matched) continue;
    if (condition !== undefined) {
      if (!evaluate(condition.slice(2, -2), scope)) continue;
      matched = true;
    } else if ('wx:else' in attrs) {
      if (matched) continue;
      matched = true;
    } else matched = false;
    output += ` ${visibleText(node.children, scope)} `;
  }
  return output;
}

test('synthetic loaded/recovery fixtures bind real source content and never leak templates, private refs or remote assets', () => {
  const pages = new Set<string>();
  const ids = new Set<string>();
  for (const fixture of fixtures) {
    assert.ok(!ids.has(fixture.id), fixture.id);
    ids.add(fixture.id);
    pages.add(fixture.page);
    assert.ok(fixture.expectedText.length > 0);
    const text =
      (
        JSON.parse(source(fixture.page, 'json')) as {
          navigationBarTitleText: string;
        }
      ).navigationBarTitleText +
      visibleText(
        parsePreviewWxml(source(fixture.page)).children,
        fixture.patch,
      );
    for (const marker of fixture.expectedText) {
      assert.ok(marker.trim(), fixture.id);
      assert.ok(
        text.includes(marker),
        `${fixture.id}: missing ${marker}\n${text}`,
      );
    }
    assert.doesNotMatch(
      text,
      /undefined|\[object Object\]|{{|wx:|bindtap|<view|post-a|reply-a|fixture-[a-z]|11111111-|https?:\/\/|打开查看消息/,
    );
    assert.doesNotMatch(
      JSON.stringify(fixture),
      /https?:\/\/|assetId|\/tmp\/|\/workspace\/|cloud:\/\//,
    );
  }
  assert.deepEqual([...pages].sort(), Object.keys(inventory.pages).sort());
  assert.ok(
    fixtures.filter((fixture) =>
      /recovery|unavailable|invalid/.test(fixture.id),
    ).length >= 7,
  );
});

test('aggregate source pagination, explicit per-owner acknowledgments and unsupported follow/activity truth remain visible', () => {
  const social = source('social-notices');
  const socialActions = actions(parsePreviewWxml(social));
  const read = socialActions.find(
    (action) => action.attrs.bindtap === 'onRead',
  )!;
  assert.equal(read.attrs['data-id'], '{{item.id}}');
  assert.equal(read.attrs.disabled, '{{item.busy}}');
  const more = socialActions.find(
    (action) => action.attrs.bindtap === 'onMore',
  )!;
  assert.equal(more.attrs['data-source'], '{{item.key}}');
  assert.equal(more.attrs.disabled, '{{item.busy}}');
  assert.match(social, /item.busy \|\| !item.available/);
  const systemRead = actions(parsePreviewWxml(source('system-notices'))).find(
    (action) => action.attrs.bindtap === 'onRead',
  )!;
  assert.equal(systemRead.attrs['data-id'], '{{item.key}}');
  assert.equal(systemRead.attrs.disabled, '{{busy}}');
  assert.match(source('notice-thread'), /暂未接入活动通知服务/);
  assert.match(social, /暂未接入关注通知服务/);
  for (const page of [
    'community-updates',
    'rating-updates',
    'system-notices',
  ]) {
    assert.match(
      source(page, 'ts'),
      /(?:noticeRows|systemNoticeRows)\(view.items\)/,
    );
    assert.match(source(page, 'ts'), /this.controller\?\.dispose\(\)/);
    assert.doesNotMatch(
      source(page, 'ts'),
      /createIntersectionObserver|setTimeout/,
    );
  }
});

test('routine success messages are hidden without suppressing unknown, interrupted or per-action outcomes', () => {
  assert.equal(noticeStatus('已读取本账号的社区站内更新'), '');
  assert.equal(noticeStatus('当前通知已核验'), '');
  assert.equal(noticeStatus('已读取更多本地评分回复更新'), '');
  for (const status of [
    '已读结果尚未确认，可重试此条或刷新；重复确认不会重复计数',
    '此条更新已标记为已读',
    '已停止等待，预览和分页已清除；已发送的已读操作仍可能完成',
    '未知的服务状态',
  ])
    assert.equal(noticeStatus(status), status);
  for (const page of [
    'community-updates',
    'rating-updates',
    'window-discussion-notices',
    'major-discussion-notices',
    'system-notices',
  ])
    assert.doesNotMatch(source(page), /class="notice-heading"/);
  assert.match(source('social-notices'), /class="notice-heading">\s*{{title}}/);
});

test('system restriction display preserves exact seconds/fractions, original DTOs, null ends and unknown dates', () => {
  const instant = new Date(2026, 9, 20, 9, 30, 17)
    .toISOString()
    .replace('.000Z', '.123456Z');
  const row = Object.freeze({
    createdAt: instant,
    startsAt: instant,
    endsAt: null,
    releasedAt: 'not-a-date',
    punishment: Object.freeze({ startsAt: instant, endsAt: instant }),
  });
  const mapped = systemNoticeRows([row])[0]!;
  assert.equal(mapped.startTimeLabel, '2026年10月20日 09:30:17.123456');
  assert.equal(mapped.endTimeLabel, '');
  assert.equal(mapped.releaseTimeLabel, '');
  assert.equal(mapped.punishmentEndTimeLabel, mapped.startTimeLabel);
  assert.equal(mapped.punishment, row.punishment);
  assert.equal(mapped.startsAt, instant);
  assert.equal(mapped.endsAt, null);
  assert.equal(noticeScheduleTime(null), '');
  assert.match(
    source('system-notices'),
    /item.endsAt === null \? '永久' : '时间暂不可用'/,
  );
  assert.match(
    source('system-notices'),
    /item.punishment.endsAt === null \? '永久' : '时间暂不可用'/,
  );
});
