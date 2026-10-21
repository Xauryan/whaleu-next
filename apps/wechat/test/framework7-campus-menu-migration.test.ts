import { assertReviewedNativeHarnessSuccessor } from './reviewed-native-harness-successor';
import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';

const root = path.join(__dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const { parsePreviewWxml: parse } = createRequire(__filename)(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(value: string): PresentationNode };
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
function actions(
  node: PresentationNode,
  scopes: Record<string, string>[] = [],
): Action[] {
  const n = normalizeFramework7ActionNode(node);
  const own = Object.fromEntries(
    Object.entries(n.attrs).filter(([key]) =>
      /^(wx:|hidden$|disabled$|loading$)/.test(key),
    ),
  );
  const next = Object.keys(own).length ? [...scopes, own] : scopes;
  return [
    ...(n.tag === 'navigator' ||
    Object.keys(n.attrs).some((key) => /^(bind|catch)/.test(key))
      ? [{ tag: n.tag, attrs: n.attrs, scopes: next }]
      : []),
    ...n.children.flatMap((child) =>
      typeof child === 'string' ? [] : actions(child, next),
    ),
  ];
}
const baseline = JSON.parse(
  read('test/fixtures/framework7-campus-menu-before-actions.json'),
) as Record<string, { sha256: string; actions: Action[] }>;
for (const [page, before] of Object.entries(baseline)) {
  test(`${page}: exact original navigation, datasets and authority scopes remain`, () => {
    const current = actions(parse(read(`src/pages/${page}/${page}.wxml`)));
    if (page === 'campus-hub') {
      const index = current.findIndex(
        (candidate) =>
          candidate.tag === 'navigator' &&
          candidate.attrs.url ===
            '/pages/personal-timetable/personal-timetable',
      );
      assert.notEqual(
        index,
        -1,
        'The separately implemented private timetable must have exactly one real entry',
      );
      const added = current.splice(index, 1)[0]!;
      assert.deepEqual(added.attrs, {
        class: 'academic-card',
        url: '/pages/personal-timetable/personal-timetable',
        'aria-label': '手动课表，仅当前账户可见',
        'hover-class': 'hub-pressed',
      });
      assert.deepEqual(
        added.scopes,
        [],
        'Private timetable entry is not gated by public campus catalog availability; its own pages enforce account access',
      );
    }
    assert.equal(current.length, before.actions.length);
    for (const previous of before.actions) {
      const index = current.findIndex(
        (candidate) =>
          candidate.tag === previous.tag &&
          JSON.stringify(candidate.scopes) ===
            JSON.stringify(previous.scopes) &&
          Object.entries(previous.attrs).every(
            ([key, value]) => candidate.attrs[key] === value,
          ),
      );
      assert.notEqual(index, -1, JSON.stringify(previous));
      current.splice(index, 1);
    }
    assert.deepEqual(current, []);
  });
}
test('campus/menu Page logic, authoritative routing and frozen bridge stay byte-identical except explicit reviewed business successors', () => {
  const protectedFiles = JSON.parse(
    read('test/fixtures/framework7-campus-menu-before-protected.json'),
  ) as Record<string, string>;
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) =>
      !assertReviewedBusinessSuccessor(file, expected) &&
      !assertReviewedNativeHarnessSuccessor(file, expected),
  ))
    assert.equal(
      createHash('sha256')
        .update(readFileSync(path.join(root, '../..', file)))
        .digest('hex'),
      expected,
      file,
    );
});
test('native navigator rows have no nested interactive ListItem or slot controls', () => {
  for (const page of Object.keys(baseline)) {
    const tree = parse(read(`src/pages/${page}/${page}.wxml`));
    const walk = (n: PresentationNode, navigator: boolean) => {
      const inside = navigator || n.tag === 'navigator';
      if (inside && n.tag === 'wu-f7-list-item') {
        assert.equal(n.attrs.link, undefined);
        assert.equal(n.attrs['bind:press'], undefined);
      }
      if (n.attrs.slot)
        assert.ok(!['button', 'navigator', 'input', 'switch'].includes(n.tag));
      for (const child of n.children)
        if (typeof child !== 'string') walk(child, inside);
    };
    walk(tree, false);
  }
});
test('manual timetable is a real private owner entry; academic grades stay unavailable and bottom navigation stays native', () => {
  const markup = read('src/pages/campus-hub/campus-hub.wxml');
  assert.match(markup, /url="\/pages\/personal-timetable\/personal-timetable"/);
  assert.match(markup, /手动课表，仅当前账户可见/);
  assert.match(markup, /成绩查询，暂未接入教务服务/);
  assert.doesNotMatch(markup, /navigator[^>]+grade/);
  assert.match(markup, /<wu-tab-bar selected="campus"/);
  assert.match(markup, /wx:elif="{{authRecovery}}"/);
  assert.match(markup, /wx:elif="{{campus.error \|\| navigationError}}"/);
  assert.match(markup, /bind:press="onRetry"/);
});
