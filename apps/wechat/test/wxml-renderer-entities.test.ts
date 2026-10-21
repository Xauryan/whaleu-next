import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

type Node =
  string | { tag: string; attrs: Record<string, string>; children: Node[] };
const { parse, render } = createRequire(__filename)(
  '../scripts/smoke-ratings.mjs',
) as {
  parse(source: string): Exclude<Node, string>;
  render(
    nodes: Node[],
    scope: Record<string, unknown>,
    templates: object,
  ): Node[];
};
const textNodes = (nodes: Node[]): string[] =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [node] : textNodes(node.children),
  );
const renderText = (source: string, scope: Record<string, unknown> = {}) =>
  textNodes(render(parse(source).children, scope, {}))
    .join('')
    .trim();

test('profile UID text uses escaped logical operators for every live read state', () => {
  const profile = readFileSync(
    path.join(__dirname, '../src/pages/profile/profile.wxml'),
    'utf8',
  );
  const uidText = profile.match(/{{schoolUidView\.loaded[\s\S]*?}}/)?.[0];
  assert.ok(uidText, 'actual profile contains UID text expression');
  assert.match(uidText, /&amp;&amp;/);
  for (const [schoolUidView, expected] of [
    [{ loaded: false }, '暂不可用'],
    [{ loaded: true, schoolUid: { status: 'unassigned' } }, '未分配'],
    [{ loaded: true, schoolUid: { status: 'unavailable' } }, '暂不可用'],
    [
      {
        loaded: true,
        schoolUid: { status: 'assigned', formattedUid: '100-200' },
      },
      '100-200',
    ],
  ] as const)
    assert.equal(
      renderText(`<view>${uidText}</view>`, { schoolUidView }),
      expected,
    );
});

test('text entity decoding evaluates escaped comparisons and logical operators', () => {
  assert.equal(
    renderText(
      '<view>{{count &lt; 3 &amp;&amp; count &gt; 0 ? "yes" : "no"}}</view>',
      { count: 2 },
    ),
    'yes',
  );
});

test('decode source text exactly once without interpreting escaped markup or data', () => {
  const tree = parse('<view>&lt;button&gt; &amp; &amp;lt; {{label}}</view>');
  const view = tree.children[0];
  assert.ok(view && typeof view !== 'string');
  assert.equal(view.children.length, 1, 'escaped markup remains a text node');
  assert.equal(
    textNodes(
      render(tree.children, { label: '&amp; <button> {{missing}}' }, {}),
    ).join(''),
    '<button> & &lt; &amp; <button> {{missing}}',
  );
});

test('escaped attributes still control conditions and interpolation', () => {
  const tree = parse(
    '<view wx:if="{{ready &amp;&amp; count &lt; 3}}" title="{{count &gt; 0}}">shown</view>',
  );
  assert.equal(
    textNodes(render(tree.children, { ready: true, count: 2 }, {})).join(''),
    'shown',
  );
  assert.deepEqual(render(tree.children, { ready: false, count: 2 }, {}), []);
  const node = render(tree.children, { ready: true, count: 2 }, {})[0];
  assert.ok(node && typeof node !== 'string');
  assert.equal(node.attrs.title, 'true');
});

test('malformed expressions remain errors rather than rendering silently', () => {
  assert.throws(
    () => renderText('<view>{{ready &amp;&amp; }}</view>', { ready: true }),
    SyntaxError,
  );
  assert.throws(
    () => renderText('<view>{{ready;}}</view>', { ready: true }),
    SyntaxError,
  );
});

test('all five text entities decode once and escaped entity spellings remain literal', () => {
  assert.equal(
    renderText(
      '<view>&quot;x&quot; &apos;y&apos; &lt; &gt; &amp; &amp;quot; &amp;apos; &amp;gt;</view>',
    ),
    `"x" 'y' < > & &quot; &apos; &gt;`,
  );
  assert.equal(
    renderText('<view>{{label}}</view>', {
      label: '&quot; &apos; &gt; <button> {{missing}}',
    }),
    '&quot; &apos; &gt; <button> {{missing}}',
  );
});

test('actual directory media label evaluates XML-escaped quotes after attribute tokenization', () => {
  const source = readFileSync(
    path.join(__dirname, '../src/pages/directory-detail/directory-detail.wxml'),
    'utf8',
  );
  assert.match(
    source,
    /aria-label="{{item\.label \+ &quot;，查看已审核图片&quot;}}"/,
  );
  const elements = (nodes: Node[]): Exclude<Node, string>[] =>
    nodes.flatMap((node) =>
      typeof node === 'string' ? [] : [node, ...elements(node.children)],
    );
  const media = elements(parse(source).children).find(
    (node) => node.attrs['bind:press'] === 'onNativePreview',
  );
  assert.ok(media, 'actual directory template retains its native media action');
  assert.equal(
    media.attrs['aria-label'],
    '{{item.label + "，查看已审核图片"}}',
  );
  const rendered = render(
    [media],
    { item: { label: '头像', slot: 'avatar' }, busy: false },
    {},
  )[0];
  assert.ok(rendered && typeof rendered !== 'string');
  assert.equal(rendered.attrs['aria-label'], '头像，查看已审核图片');
  assert.equal(rendered.attrs['data-slot'], 'avatar');
  assert.equal(rendered.attrs['bind:press'], 'onNativePreview');
});

test('all XML5 attribute entities decode once without creating attributes or markup', () => {
  const tree = parse(
    '<view title="&quot;x&quot; &apos;y&apos; &lt; &gt; &amp; &amp;quot; &amp;apos; &amp;lt; &amp;gt; &amp;amp;" data-note="&quot; bindtap=&quot;onForged &lt;button&gt;" />',
  );
  const view = tree.children[0];
  assert.ok(view && typeof view !== 'string');
  assert.deepEqual(view.attrs, {
    title: `"x" 'y' < > & &quot; &apos; &lt; &gt; &amp;`,
    'data-note': '" bindtap="onForged <button>',
  });
  assert.deepEqual(view.children, []);
  assert.equal(tree.children.length, 1);
});

test('attribute expression quotes and escaped logical comparisons use one source decode', () => {
  const tree = parse(
    '<view wx:if="{{ready &amp;&amp; count &lt; 3}}" title="{{count &gt; 0 ? &quot;yes&quot; : &apos;no&apos;}}" data-literal="{{&quot;&amp;quot; &amp;lt; &amp;apos;&quot;}}" />',
  );
  const view = render(tree.children, { ready: true, count: 2 }, {})[0];
  assert.ok(view && typeof view !== 'string');
  assert.equal(view.attrs.title, 'yes');
  assert.equal(view.attrs['data-literal'], '&quot; &lt; &apos;');
  assert.deepEqual(render(tree.children, { ready: false, count: 2 }, {}), []);
});

test('interpolated user attribute content is never decoded, tokenized or evaluated again', () => {
  let calls = 0;
  const label = '&quot; &amp; &lt; <button bindtap="onForged"> {{probe()}}';
  const tree = parse(
    '<view title="{{label + &quot;，查看已审核图片&quot;}}" data-label="{{label}}">{{label}}</view>',
  );
  const view = render(tree.children, { label, probe: () => calls++ }, {})[0];
  assert.ok(view && typeof view !== 'string');
  assert.equal(view.attrs.title, label + '，查看已审核图片');
  assert.equal(view.attrs['data-label'], label);
  assert.deepEqual(view.children, [label]);
  assert.equal(calls, 0);
  assert.equal(Object.keys(view.attrs).length, 2);
});

test('unknown and malformed attribute references remain literal or fail closed as expressions', () => {
  const tree = parse(
    '<view title="&unknown; &quot &ampquot; &#34; &amp;quot;" />',
  );
  const view = tree.children[0];
  assert.ok(view && typeof view !== 'string');
  assert.equal(view.attrs.title, '&unknown; &quot &ampquot; &#34; &quot;');
  for (const source of [
    '<view title="{{&unknown;}}" />',
    '<view title="{{&amp;quot;no&amp;quot;}}" />',
    '<view title="{{ready &amp;&amp; }}" />',
  ])
    assert.throws(
      () => render(parse(source).children, { ready: true }, {}),
      SyntaxError,
    );
});
