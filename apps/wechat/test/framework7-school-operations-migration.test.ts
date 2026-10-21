import { assertReviewedNativeHarnessSuccessor } from './reviewed-native-harness-successor';
import { assertReviewedNoticeExposureSuccessor } from './reviewed-notice-exposure-successor';
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
const requireNative = createRequire(__filename);
const root = path.join(__dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const hash = (file: string) =>
  createHash('sha256').update(read(file)).digest('hex');
const { parsePreviewWxml: parse } = requireNative(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
const baseline = JSON.parse(
  read('test/fixtures/framework7-school-operations-before-actions.json'),
) as Record<string, { sourceSha256: string; actions: Action[] }>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-school-operations-before-protected.json'),
) as Record<string, string>;
const pages = Object.keys(baseline)
  .filter((f) => f.startsWith('src/pages/'))
  .map((f) => f.split('/')[2]!);
const evidence = (f: string) =>
  `test/fixtures/framework7-school-operations-original-${f.split('/').join('__')}.txt`;
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
function actions(
  raw: PresentationNode,
  parents: Record<string, string>[] = [],
): Action[] {
  const node = normalizeFramework7ActionNode(raw);
  const own = Object.fromEntries(
    Object.entries(node.attrs).filter(([k]) =>
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
      ].includes(k),
    ),
  );
  const scopes = Object.keys(own).length ? [...parents, own] : parents;
  return [
    ...([
      'navigator',
      'input',
      'textarea',
      'switch',
      'picker',
      'radio',
      'checkbox',
    ].includes(node.tag) ||
    Object.keys(node.attrs).some((k) => /^(bind|catch)/.test(k))
      ? [{ tag: node.tag, attrs: node.attrs, scopes }]
      : []),
    ...node.children.flatMap((c) =>
      typeof c === 'string' ? [] : actions(c, scopes),
    ),
  ];
}
const flatten = (n: PresentationNode): PresentationNode[] => [
  n,
  ...n.children.flatMap((c) => (typeof c === 'string' ? [] : flatten(c))),
];
for (const [file, before] of Object.entries(baseline))
  test(`${file}: preserves every action, exact dataset, native field constraint and complete guard stack`, () => {
    assert.equal(hash(evidence(file)), before.sourceSha256);
    const target =
      file === 'src/errands/admin-command.wxml'
        ? 'src/school-operations/f7-admin-command.wxml'
        : file;
    const current = actions(parse(read(target)));
    assert.equal(current.length, before.actions.length);
    for (const old of before.actions) {
      const index = current.findIndex(
        (next) =>
          next.tag === old.tag &&
          JSON.stringify(next.scopes) === JSON.stringify(old.scopes) &&
          Object.entries(old.attrs).every(([k, v]) => next.attrs[k] === v),
      );
      assert.notEqual(index, -1, JSON.stringify(old));
      current.splice(index, 1);
    }
    assert.deepEqual(current, []);
  });
test('164 protected files and frozen legacy adapter evidence remain byte-identical except explicit reviewed business successors', () => {
  assert.equal(Object.keys(protectedFiles).length, 164);
  for (const [file, before] of Object.entries(protectedFiles).filter(
    ([file, expected]) =>
      !assertReviewedNoticeExposureSuccessor(file, expected) &&
      !assertReviewedBusinessSuccessor(file, expected) &&
      !assertReviewedNativeHarnessSuccessor(file, expected),
  ))
    assert.equal(
      hash(
        file.startsWith('scripts/') ||
          file === 'test/school-operations-presentation.test.ts'
          ? evidence(file)
          : file,
      ),
      before,
      file,
    );
  if (
    !assertReviewedNativeHarnessSuccessor(
      'test/native-press-emitted-harness.mjs',
      'f271187e9a5a7110e8d9632b2b88213191e32a878946e9cf5e1ffcfd5ceccd05',
    )
  )
    assert.equal(
      hash('test/native-press-emitted-harness.mjs'),
      'f271187e9a5a7110e8d9632b2b88213191e32a878946e9cf5e1ffcfd5ceccd05',
    );
});
for (const page of pages)
  test(`${page}: registered fixed native Button/Block only, no DOM, router or new overlay`, () => {
    const prefix = `src/pages/${page}/${page}`;
    const config = JSON.parse(read(prefix + '.json')) as {
      usingComponents: Record<string, string>;
    };
    const nodes = flatten(parse(read(prefix + '.wxml')));
    assert.ok(nodes.some((n) => n.tag === 'wu-f7-button'));
    assert.ok(nodes.some((n) => n.tag === 'wu-f7-block'));
    assert.equal(nodes.filter((n) => n.tag === 'button').length, 0);
    for (const node of nodes.filter((n) => n.tag.startsWith('wu-f7-'))) {
      assert.ok(['wu-f7-button', 'wu-f7-block'].includes(node.tag));
      assert.equal(
        config.usingComponents[node.tag],
        `../../components/${node.tag.slice(3)}/${node.tag.slice(3)}`,
      );
      assert.equal(node.attrs['open-type'], undefined);
      assert.equal(node.attrs['form-type'], undefined);
    }
    assert.doesNotMatch(
      read(prefix + '.wxml'),
      /web-view|wu-f7-(dialog|sheet|actions)|https?:\/\/|data:image/,
    );
    assert.match(read(prefix + '.wxss'), /framework7-school-operations\.wxss/);
    const app = JSON.parse(read('src/app.json')) as { pages: string[] };
    assert.ok(app.pages.includes(`pages/${page}/${page}`));
  });
test('the isolated admin confirmation uses its actual import and preserves native typed/duration controls', () => {
  for (const page of ['errand-admin', 'errand-restrictions'])
    assert.match(
      read(`src/pages/${page}/${page}.wxml`),
      /import src="\.\.\/\.\.\/school-operations\/f7-admin-command\.wxml"/,
    );
  const template = read('src/school-operations/f7-admin-command.wxml');
  assert.match(
    template,
    /<textarea[^>]+bindinput="onAdminReason"[^>]+maxlength="-1"/,
  );
  assert.match(template, /<picker[^>]+bindchange="onAdminDuration"/);
  assert.match(
    template,
    /<switch[^>]+bindchange="onAdminPublisherRestriction"/,
  );
  assert.match(template, /tone="danger"[^>]*variant="fill"/);
});
test('preview exports preserve all 50 existing fictional cases, exact state and strict text markers', () => {
  type Fixture = {
    id: string;
    page: string;
    patch: Record<string, unknown>;
    expectedText: string[];
  };
  const old = (
    requireNative('../scripts/fixtures/school-operations-preview.mjs') as {
      default: Fixture[];
    }
  ).default;
  const next = (
    requireNative(
      '../scripts/fixtures/framework7-school-operations-preview.mjs',
    ) as { default: Fixture[] }
  ).default;
  assert.equal(next.length, 50);
  assert.equal(new Set(next.map((f) => f.id)).size, 50);
  old.forEach((f, i) => {
    assert.equal(next[i]!.id, `framework7-${f.id}`);
    assert.deepEqual(next[i]!.patch, f.patch);
    assert.deepEqual(next[i]!.expectedText, f.expectedText);
    assert.equal(next[i]!.page, f.page);
  });
});
