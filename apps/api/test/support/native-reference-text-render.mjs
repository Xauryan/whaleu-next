/** Test-only bounded rendering of the one actual native reference-text component.
 * Executes emitted attached/detached and WXML, not source-attribute-as-rendered text.
 * No events, arbitrary custom component expansion, network or native-device claim. */
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse, render } from '../../../wechat/scripts/smoke-ratings.mjs';
import { nativeComponentPreviewState } from '../../../wechat/scripts/preview-native-component.mjs';
const require = createRequire(import.meta.url);
const hidden = (node) =>
  node.attrs.hidden === 'true' ||
  node.attrs.hidden === '' ||
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(
    node.attrs.style ?? '',
  );

export function renderedReferenceText(nodes, pageFile, dist) {
  const requestedDist = path.resolve(dist);
  const requestedPage = path.resolve(pageFile);
  const relativePage = path.relative(requestedDist, requestedPage);
  assert.ok(
    relativePage &&
      !path.isAbsolute(relativePage) &&
      relativePage !== '..' &&
      !relativePage.startsWith('..' + path.sep),
    'Page registration must be within the explicitly selected artifact root',
  );
  // The whole artifact root may be a verified read-only reuse link. Resolve
  // that root once, while still rejecting substitutions inside the artifact.
  dist = realpathSync(requestedDist);
  pageFile = path.resolve(dist, relativePage);
  assert.equal(
    realpathSync(pageFile + '.json'),
    pageFile + '.json',
    'No page registration symlink substitution',
  );
  const registration =
    JSON.parse(readFileSync(pageFile + '.json', 'utf8')).usingComponents ?? {};
  const expected = path.join(dist, 'components/reference-text/reference-text');
  const resolve = (value) =>
    value.startsWith('/')
      ? path.resolve(dist, '.' + value)
      : path.resolve(path.dirname(pageFile), value);
  const records = [];
  const visited = new Set();
  function walk(items, ancestors = []) {
    for (const node of items) {
      if (typeof node === 'string' || visited.has(node)) continue;
      visited.add(node);
      if (node.tag === 'wu-reference-text') records.push({ node, ancestors });
      walk(node.children, [...ancestors, node]);
    }
  }
  walk(nodes);
  if (!records.length) return [];
  assert.equal(typeof registration['wu-reference-text'], 'string');
  assert.equal(resolve(registration['wu-reference-text']), expected);
  for (const suffix of ['.js', '.json', '.wxml'])
    assert.equal(
      realpathSync(expected + suffix),
      expected + suffix,
      'No component path/symlink substitution',
    );
  assert.equal(
    JSON.parse(readFileSync(expected + '.json', 'utf8')).component,
    true,
  );
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Component');
  let definition;
  try {
    globalThis.Component = (value) => {
      assert.equal(definition, undefined);
      definition = value;
    };
    delete require.cache[require.resolve(expected + '.js')];
    require(expected + '.js');
  } finally {
    if (original) Object.defineProperty(globalThis, 'Component', original);
    else delete globalThis.Component;
    delete require.cache[require.resolve(expected + '.js')];
  }
  assert.ok(definition, 'Actual emitted component registers');
  const tree = parse(readFileSync(expected + '.wxml', 'utf8'));
  function text(items) {
    return items
      .map((node) => {
        if (typeof node === 'string') return node;
        assert.ok(
          ['text', 'slot'].includes(node.tag),
          'Only the actual inert reference text structure is rendered',
        );
        return hidden(node) ? '' : text(node.children);
      })
      .join('');
  }
  return records
    .filter(({ node, ancestors }) => ![...ancestors, node].some(hidden))
    .map(({ node, ancestors }) => {
      for (const parent of ancestors) {
        const registered = registration[parent.tag];
        if (
          registered === undefined &&
          [
            'view',
            'text',
            'block',
            'scroll-view',
            'cover-view',
            'button',
            'navigator',
          ].includes(parent.tag)
        )
          continue;
        assert.ok(
          typeof registered === 'string' &&
            ['f7-block', 'f7-list'].some(
              (name) =>
                resolve(registered) ===
                path.join(dist, 'components', name, name),
            ),
          'Unknown custom ancestor cannot prove visible text',
        );
      }
      const data = nativeComponentPreviewState(
        definition,
        node.attrs,
        (value) => value,
      );
      return text(render(tree.children, data, {}));
    });
}
