/** Bounded source/emitted include projection for the two category Page wrappers.
 * The frozen native press bridge does not implement <include>. This adapter
 * expands only the exact static category include, in an isolated temporary tree.
 * It is not evidence of native compiler/style/layout behavior. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parse, render } from '../scripts/smoke-ratings.mjs';
const require = createRequire(import.meta.url);
import { createNativePressBridge } from './native-press-emitted-harness.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function createRecoveryPressBridge(options) {
  const { pageFile, dist } = options;
  const source = readFileSync(`${pageFile}.wxml`, 'utf8');
  if (!source.includes('<include'))
    return { ...createNativePressBridge(options), disposeProjection() {} };
  const route = path.basename(pageFile);
  assert.ok(
    ['rating-category-manage', 'rating-category-editor'].includes(route),
  );
  const include = /^\s*<include src="([^"{}]+)"\s*\/>\s*$/.exec(source);
  assert.ok(include, 'Only one complete static include wrapper is supported');
  assert.equal(include[1], '../../ratings/framework7-recovery-category.wxml');
  const target = path.resolve(path.dirname(pageFile), include[1]);
  assert.equal(
    target,
    path.join(dist, 'ratings/framework7-recovery-category.wxml'),
  );
  assert.notEqual(target, `${pageFile}.wxml`, 'No cyclic include');
  assert.ok(
    target.startsWith(`${dist}${path.sep}`),
    'No include escapes source/artifact',
  );
  const included = readFileSync(target, 'utf8');
  assert.doesNotMatch(
    included,
    /<(?:include|import)\b/,
    'Nested or cyclic includes/import rebasing are not supported',
  );
  const projection = source.replace(include[0].trim(), included);
  assert.equal(
    projection,
    source.slice(0, source.indexOf('<include')) +
      included +
      source.slice(source.indexOf('/>') + 2),
    'Exact deterministic expansion only',
  );
  const staging = mkdtempSync(
    path.join(tmpdir(), 'whaleu-rating-recovery-include-'),
  );
  const stagedPage = path.join(staging, path.relative(dist, pageFile));
  mkdirSync(path.dirname(stagedPage), { recursive: true });
  writeFileSync(`${stagedPage}.wxml`, projection);
  cpSync(`${pageFile}.json`, `${stagedPage}.json`);
  // Actual registrations and their dependency graph are copied byte-for-byte.
  cpSync(path.join(dist, 'components'), path.join(staging, 'components'), {
    recursive: true,
  });
  assert.equal(
    sha(
      readFileSync(
        path.join(
          staging,
          `components/f7-button/f7-button.${options.extension ?? 'js'}`,
        ),
      ),
    ),
    sha(
      readFileSync(
        path.join(
          dist,
          `components/f7-button/f7-button.${options.extension ?? 'js'}`,
        ),
      ),
    ),
  );
  const bridge = createNativePressBridge({
    ...options,
    dist: staging,
    pageFile: stagedPage,
  });
  return {
    ...bridge,
    projection: {
      source: path.relative(dist, `${pageFile}.wxml`),
      sourceSha256: sha(source),
      include: path.relative(dist, target),
      includeSha256: sha(included),
      projectionSha256: sha(projection),
      model: 'exact-static-include-projection',
    },
    disposeProjection() {
      bridge.lifecycle('detach');
      rmSync(staging, { recursive: true, force: true });
    },
  };
}

/** Follow the literal import/include selected by a Page, not a legacy template. */
export function readRecoveryDependency(pageFile, dist, kind = 'import') {
  assert.ok(['import', 'include'].includes(kind));
  const source = readFileSync(`${pageFile}.wxml`, 'utf8');
  const matches = [
    ...source.matchAll(new RegExp(`<${kind} src="([^"{}]+)"\\s*\\/>`, 'g')),
  ];
  assert.equal(matches.length, 1, `One static ${kind} dependency`);
  const file = path.resolve(path.dirname(pageFile), matches[0][1]);
  assert.ok(file.startsWith(`${dist}${path.sep}`));
  return readFileSync(file, 'utf8');
}
export function pressRecoveryControl(options, handler, dataset = {}) {
  const bridge = createRecoveryPressBridge(options);
  try {
    if (!bridge.find(handler, dataset)) return false;
    const control = bridge.capture(handler, dataset);
    try {
      return control.press();
    } finally {
      control.detach();
    }
  } finally {
    bridge.disposeProjection();
  }
}
export function inputRecoveryControl(
  { page, pageFile, dist, extension = 'js' },
  handler,
  value,
  dataset = {},
) {
  const source = readFileSync(`${pageFile}.wxml`, 'utf8');
  assert.doesNotMatch(
    source,
    /<include\b/,
    'Input helper has no include fallback',
  );
  const tree = parse(source),
    templates = {};
  for (const node of tree.children) {
    if (typeof node !== 'string' && node.tag === 'import') {
      const target = path.resolve(path.dirname(pageFile), node.attrs.src);
      assert.ok(target.startsWith(`${dist}${path.sep}`));
      for (const definition of parse(readFileSync(target, 'utf8')).children)
        if (typeof definition !== 'string' && definition.tag === 'template')
          templates[definition.attrs.name] = definition;
    }
  }
  const flatten = (nodes) =>
    nodes.flatMap((node) =>
      typeof node === 'string' ? [] : [node, ...flatten(node.children)],
    );
  const node = flatten(render(tree.children, page.data, templates)).find(
    (node) =>
      node.tag === 'wu-f7-input' &&
      node.attrs['bind:input'] === handler &&
      Object.entries(dataset).every(
        ([key, value]) => node.attrs[`data-${key}`] === String(value),
      ),
  );
  assert.ok(node, `Actual native Input ${handler}`);
  const config = JSON.parse(readFileSync(`${pageFile}.json`, 'utf8'));
  const component = path.resolve(
    path.dirname(pageFile),
    config.usingComponents[node.tag],
  );
  assert.equal(component, path.join(dist, 'components/f7-input/f7-input'));
  assert.match(
    readFileSync(`${component}.wxml`, 'utf8'),
    /catchinput="onInput"/,
  );
  let definition;
  const previous = globalThis.Component;
  globalThis.Component = (value) => {
    definition = value;
  };
  try {
    delete require.cache[require.resolve(`${component}.${extension}`)];
    require(`${component}.${extension}`);
  } finally {
    globalThis.Component = previous;
  }
  assert.ok(definition);
  const properties = Object.fromEntries(
    Object.entries(definition.properties).map(([key, property]) => {
      const attr = key.replace(
          /[A-Z]/g,
          (letter) => `-${letter.toLowerCase()}`,
        ),
        raw = node.attrs[attr];
      return [
        key,
        raw === undefined
          ? structuredClone(property.value)
          : property.type === Boolean
            ? raw === 'true' || raw === ''
            : property.type === Number
              ? Number(raw)
              : raw,
      ];
    }),
  );
  const deliveredDataset = Object.fromEntries(
    Object.entries(node.attrs)
      .filter(([key]) => key.startsWith('data-'))
      .map(([key, value]) => [key.slice(5), value]),
  );
  let emitted = 0;
  const instance = {
    properties,
    data: structuredClone(definition.data),
    ...definition.methods,
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent(type, detail, options) {
      assert.equal(type, 'input');
      assert.deepEqual(options, { bubbles: false, composed: false });
      emitted++;
      page[handler]({ detail, currentTarget: { dataset: deliveredDataset } });
    },
  };
  definition.lifetimes.attached.call(instance);
  try {
    definition.methods.onInput.call(instance, {
      detail: { value, cursor: value.length },
    });
  } finally {
    definition.lifetimes.detached.call(instance);
  }
  return emitted === 1;
}
