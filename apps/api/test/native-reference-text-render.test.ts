import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  symlinkSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
const require = createRequire(import.meta.url);
interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: (Node | string)[];
}
const { renderedReferenceText } =
  require('./support/native-reference-text-render.mjs') as {
    renderedReferenceText(
      nodes: (Node | string)[],
      pageFile: string,
      dist: string,
    ): string[];
  };
test('actual native reference component lifecycle and WXML prove rendered source without dispatching actions', () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'whaleu-reference-render-'));
  const alias = dist + '-artifact-alias';
  const source = fileURLToPath(new URL('../../wechat/src/', import.meta.url));
  const page = path.join(dist, 'pages/community-detail/community-detail');
  try {
    writeFileSync(path.join(dist, 'package.json'), '{"type":"commonjs"}');
    for (const name of [
      'components/reference-text/reference-text',
      'content-references/text',
    ]) {
      const output = path.join(dist, name + '.js');
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(
        output,
        ts.transpileModule(
          readFileSync(path.join(source, name + '.ts'), 'utf8'),
          {
            compilerOptions: {
              module: ts.ModuleKind.CommonJS,
              target: ts.ScriptTarget.ES2022,
            },
          },
        ).outputText,
      );
    }
    for (const suffix of ['json', 'wxml'])
      copyFileSync(
        path.join(source, 'components/reference-text/reference-text.' + suffix),
        path.join(dist, 'components/reference-text/reference-text.' + suffix),
      );
    mkdirSync(path.dirname(page), { recursive: true });
    const writeRegistration = (value: string) =>
      writeFileSync(
        page + '.json',
        JSON.stringify({ usingComponents: { 'wu-reference-text': value } }),
      );
    writeRegistration('../../components/reference-text/reference-text');
    const body =
      '<script>not markup</script> &amp; {{notAnExpression}}\n #1234567';
    const node: Node = {
      tag: 'wu-reference-text',
      attrs: {
        source: body,
        available: 'true',
        disabled: 'true',
        'row-key': 'comment:synthetic',
      },
      children: [],
    };
    const root: Node = { tag: 'view', attrs: {}, children: [node] };
    assert.deepEqual(renderedReferenceText([root, node], page, dist), [body]);
    symlinkSync(dist, alias, 'dir');
    assert.deepEqual(
      renderedReferenceText(
        [root],
        path.join(alias, path.relative(dist, page)),
        alias,
      ),
      [body],
    );
    renameSync(page + '.json', page + '.original.json');
    symlinkSync(page + '.original.json', page + '.json');
    assert.throws(
      () =>
        renderedReferenceText(
          [root],
          path.join(alias, path.relative(dist, page)),
          alias,
        ),
      /No page registration symlink substitution/,
    );
    unlinkSync(page + '.json');
    renameSync(page + '.original.json', page + '.json');
    assert.deepEqual(
      renderedReferenceText(
        [{ ...root, attrs: { hidden: 'true' } }, node],
        page,
        dist,
      ),
      [],
    );
    assert.deepEqual(
      renderedReferenceText(
        [{ ...root, attrs: { style: 'display: none' } }, node],
        page,
        dist,
      ),
      [],
    );
    assert.throws(
      () =>
        renderedReferenceText(
          [{ ...root, tag: 'unknown-component' }, node],
          page,
          dist,
        ),
      /Unknown custom ancestor/,
    );
    writeFileSync(
      page + '.json',
      JSON.stringify({
        usingComponents: {
          'wu-reference-text': '../../components/reference-text/reference-text',
          opaque: '../../components/unknown/unknown',
        },
      }),
    );
    assert.throws(
      () => renderedReferenceText([{ ...root, tag: 'opaque' }], page, dist),
      /Unknown custom ancestor/,
    );
    assert.throws(
      () =>
        renderedReferenceText([{ ...root, tag: 'notregistered' }], page, dist),
      /Unknown custom ancestor/,
    );
    writeRegistration('../../components/unknown/unknown');
    assert.throws(() => renderedReferenceText([root], page, dist));
    writeRegistration('../../components/reference-text/reference-text');
    assert.throws(() =>
      renderedReferenceText([root], path.join(dist, '../foreign/page'), dist),
    );
    // Disabled capabilities still display exact source; they never imply a press.
    assert.deepEqual(
      renderedReferenceText(
        [{ ...node, attrs: { ...node.attrs, available: 'false' } }],
        page,
        dist,
      ),
      [body],
    );
    const componentWxml = path.join(
      dist,
      'components/reference-text/reference-text.wxml',
    );
    const originalWxml = readFileSync(componentWxml, 'utf8');
    for (const visibility of ['hidden="{{true}}"', 'style="display: none"']) {
      writeFileSync(
        componentWxml,
        `<text ${visibility}>${originalWxml}</text>`,
      );
      assert.deepEqual(renderedReferenceText([root], page, dist), ['']);
    }
  } finally {
    rmSync(alias, { force: true });
    rmSync(dist, { recursive: true, force: true });
  }
});

test('thread reply body remains native text rather than reference component output', () => {
  const { parse, render } =
    require('../../wechat/scripts/smoke-ratings.mjs') as {
      parse(source: string): Node;
      render(
        nodes: (Node | string)[],
        scope: Record<string, unknown>,
        templates: Record<string, unknown>,
      ): (Node | string)[];
    };
  const source = readFileSync(
    new URL(
      '../../wechat/src/pages/community-thread/community-thread.wxml',
      import.meta.url,
    ),
    'utf8',
  );
  const tree = parse(source);
  const row = tree.children.find(
    (node): node is Node =>
      typeof node !== 'string' &&
      node.tag === 'template' &&
      node.attrs['name'] === 'reply-row',
  );
  assert.ok(row);
  const visit = (nodes: (Node | string)[]): Node[] =>
    nodes.flatMap((node) =>
      typeof node === 'string' ? [] : [node, ...visit(node.children)],
    );
  const bodies = visit(row.children).filter(
    (node) => node.tag === 'view' && node.attrs['class'] === 'body',
  );
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0]?.children, ['{{reply.text}}']);
  assert.equal(
    visit(row.children).filter((node) => node.tag === 'wu-reference-text')
      .length,
    0,
  );
  const body = '契约验证 reply <script>not markup</script> {{literal}}';
  const rendered = render(bodies, { reply: { text: body } }, {});
  assert.deepEqual(
    visit(rendered).flatMap((node) =>
      node.children.filter((child) => typeof child === 'string'),
    ),
    [body],
  );
  const worker = readFileSync(
    new URL(
      './support/community-text-review-native-worker.mjs',
      import.meta.url,
    ),
    'utf8',
  );
  const threadJourney = worker.slice(
    worker.indexOf("const thread = mount('community-thread'"),
    worker.indexOf('close(thread);'),
  );
  assert.match(threadJourney, /thread\s*\.nodes\(\)\s*\.some\(/);
  assert.doesNotMatch(threadJourney, /renderedReferenceText/);
});
