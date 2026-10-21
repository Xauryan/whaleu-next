/** Ratings' presentation-only emitted control adapter. Actual native F7
 * registrations execute; original Page/controller methods remain authoritative.
 * This does not prove WeChat keyboard, viewport, focus or device behavior. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse, render } from '../scripts/smoke-ratings.mjs';
import { createNativePressBridge } from './native-press-emitted-harness.mjs';
const require = createRequire(import.meta.url);
const flatten = (nodes) =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [] : [node, ...flatten(node.children)],
  );
const camel = (name) =>
  name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
const kebab = (name) =>
  name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
export function createRatingEmittedBridge({ page, pageFile, dist }) {
  const templates = {},
    visited = new Set();
  function tree(file) {
    assert.ok(file.startsWith(`${dist}${path.sep}`));
    if (visited.has(file)) return;
    visited.add(file);
    const parsed = parse(readFileSync(file, 'utf8'));
    for (const node of flatten(parsed.children)) {
      if (node.tag === 'import')
        tree(path.resolve(path.dirname(file), node.attrs.src));
      if (node.tag === 'template' && node.attrs.name)
        templates[node.attrs.name] = node;
    }
    return parsed;
  }
  const parsed = tree(`${pageFile}.wxml`);
  const nodes = () =>
    flatten(
      render(
        parsed.children.filter(
          (node) =>
            typeof node === 'string' ||
            node.tag !== 'template' ||
            !node.attrs.name,
        ),
        page.data,
        templates,
      ),
    );
  const press = createNativePressBridge({ page, pageFile, dist });
  let visible = true,
    attached = true;
  for (const [method, lifecycle] of [
    ['onShow', 'show'],
    ['onHide', 'hide'],
    ['onUnload', 'detach'],
  ]) {
    const original = page[method];
    page[method] = function (...args) {
      if (lifecycle === 'show') visible = attached;
      else visible = false;
      if (lifecycle === 'detach') attached = false;
      press.lifecycle(lifecycle);
      return original?.apply(this, args);
    };
  }
  const originalSetData = page.setData;
  page.setData = function (...args) {
    const result = originalSetData.apply(this, args);
    press.sync();
    return result;
  };
  const matching = (node, handler, dataset, events) =>
    events.some((event) => node.attrs[event] === handler) &&
    Object.entries(dataset).every(
      ([key, value]) => node.attrs[`data-${key}`] === String(value),
    );
  function direct(handler, dataset) {
    const node = press.find(handler, dataset);
    if (node) {
      const control = press.capture(handler, dataset);
      try {
        return control.press();
      } finally {
        control.detach();
      }
    }
    const raw = nodes().find((node) =>
      matching(node, handler, dataset, ['bindtap', 'catchtap']),
    );
    if (
      !raw ||
      !visible ||
      !attached ||
      raw.attrs.disabled === 'true' ||
      raw.attrs.loading === 'true'
    )
      return false;
    assert.ok(
      !press.isComponent(raw.tag),
      'Never forward an unexecuted custom component event',
    );
    assert.equal(typeof page[handler], 'function');
    const fullDataset = Object.fromEntries(
      Object.entries(raw.attrs)
        .filter(([key]) => key.startsWith('data-'))
        .map(([key, value]) => [camel(key.slice(5)), value]),
    );
    page[handler]({ currentTarget: { dataset: fullDataset } });
    return true;
  }
  function tap(handler, dataset = {}) {
    if (!visible || !attached) return false;
    if (
      press.find(handler, dataset) ||
      nodes().some((node) =>
        matching(node, handler, dataset, ['bindtap', 'catchtap']),
      )
    )
      return direct(handler, dataset);
    // Existing product disclosures must be opened through their real control,
    // never by fabricating a rendered node or mutating Page data.
    const panel =
      handler === 'onScore'
        ? 'score'
        : handler === 'onSort'
          ? 'sort'
          : handler === 'onRegion'
            ? 'scope'
            : handler === 'onSection'
              ? 'more'
              : handler === 'onDelete' && dataset.id
                ? `${pageFile.includes('rating-thread') ? 'reply' : 'comment'}:${dataset.id}`
                : null;
    if (
      panel &&
      page.data.uiPanel !== panel &&
      press.find('onTogglePanel', { panel })
    )
      direct('onTogglePanel', { panel });
    return direct(handler, dataset);
  }
  function input(handler, value, dataset = {}) {
    const node = nodes().find((node) =>
      matching(node, handler, dataset, ['bind:input']),
    );
    if (!node || !visible || !attached) return false;
    const config = JSON.parse(readFileSync(`${pageFile}.json`, 'utf8'));
    const relative = config.usingComponents?.[node.tag];
    assert.ok(relative, 'Actual registered input component');
    const file = path.resolve(path.dirname(pageFile), relative);
    assert.ok(file.startsWith(`${dist}${path.sep}`));
    assert.equal(path.basename(file), 'f7-input');
    let definition;
    const previous = globalThis.Component;
    globalThis.Component = (registered) => {
      definition = registered;
    };
    try {
      delete require.cache[require.resolve(`${file}.js`)];
      require(`${file}.js`);
    } finally {
      if (previous === undefined) delete globalThis.Component;
      else globalThis.Component = previous;
    }
    assert.ok(definition);
    const properties = Object.fromEntries(
      Object.entries(definition.properties).map(([key, property]) => {
        const raw = node.attrs[kebab(key)];
        return [
          key,
          raw === undefined
            ? structuredClone(property.value)
            : property.type === Boolean
              ? raw === 'true'
              : property.type === Number
                ? Number(raw)
                : raw,
        ];
      }),
    );
    let emitted = false;
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
        assert.equal(
          detail.value,
          value,
          'Raw native buffer crosses Component unchanged',
        );
        emitted = true;
        page[handler]({ detail, currentTarget: { dataset } });
      },
    };
    definition.lifetimes.attached.call(instance);
    try {
      const inner = flatten(
        render(
          parse(readFileSync(`${file}.wxml`, 'utf8')).children,
          { ...instance.data, ...properties },
          {},
        ),
      ).find(
        (node) => node.tag === 'input' && node.attrs.catchinput === 'onInput',
      );
      assert.ok(inner, 'Actual native editor boundary');
      if (inner.attrs.disabled !== 'true')
        definition.methods.onInput.call(instance, {
          detail: { value, cursor: value.length },
        });
    } finally {
      definition.lifetimes.detached.call(instance);
    }
    return emitted;
  }
  return { tap, input, nodes, emissions: press.emissions, find: press.find };
}
