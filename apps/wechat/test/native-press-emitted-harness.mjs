/** Bounded emitted F7 Button/ListItem press and Input/Searchbar input event bridges. This models platform delivery,
 * not WeChat rendering, hit testing, permissions, or device acceptance. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse, render } from '../scripts/smoke-ratings.mjs';
const require = createRequire(import.meta.url);
// Only these fixed public bridges exist. No arbitrary custom-event fallback.
export function createNativePressBridge(options) {
  return createNativeControlBridge(options, {
    eventType: 'press',
    method: 'onPress',
    nativeTag: 'button',
    nativeBinding: 'catchtap',
    supported: new Set(['f7-button', 'f7-list-item']),
  });
}
export function createNativeInputBridge(options) {
  return createNativeControlBridge(options, {
    eventType: 'input',
    method: 'onInput',
    nativeTag: 'input',
    nativeBinding: 'catchinput',
    // Searchbar shares the real native editor onInput contract. Its cancel,
    // clear, confirm and focus events are deliberately not forwarded here.
    supported: new Set(['f7-input', 'f7-searchbar']),
  });
}
const presentation = new Set(['f7-block', 'f7-list']);
const enabledAttribute = (value) => value === 'true' || value === '';
const camel = (name) =>
  name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const kebab = (name) =>
  name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const hidden = (node) =>
  enabledAttribute(node.attrs.hidden) ||
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(
    node.attrs.style ?? '',
  );

// The shared renderer intentionally stringifies attributes. Encode only dataset
// expressions during this private render, retaining native expression types and
// camel-cased full host datasets without changing the legacy raw-event path.
function datasetTree(node) {
  // The shared parser owns source-text decoding after tokenization. Neither
  // decoded source strings nor interpolated runtime values are decoded again.
  if (typeof node === 'string') return node;
  return {
    ...node,
    attrs: Object.fromEntries(
      Object.entries(node.attrs).map(([key, value]) => {
        const expression = /^{{([\s\S]*)}}$/.exec(value);
        if (node.tag === 'template' && node.attrs.is && key === 'data')
          return [
            key,
            `{{__emittedHarnessDataset: __emittedHarnessDataset, ${value.slice(2, -2)}}}`,
          ];
        return [
          key,
          key.startsWith('data-') && expression && !/}}|{{/.test(expression[1])
            ? `{{__emittedHarnessDataset([${expression[1]}])}}`
            : value,
        ];
      }),
    ),
    children: node.children.map(datasetTree),
  };
}
function renderTree(tree, data, templates) {
  const prefix = '\u0001dataset:';
  const rendered = render(
    tree.children.filter(
      (node) =>
        typeof node === 'string' || node.tag !== 'template' || !node.attrs.name,
    ),
    {
      ...data,
      __emittedHarnessDataset: (value) => prefix + JSON.stringify(value),
    },
    templates,
  );
  const entries = [];
  function visit(nodes, ancestors = [], location = '') {
    nodes.forEach((node, index) => {
      if (typeof node === 'string') return;
      const dataset = {};
      for (const [key, raw] of Object.entries(node.attrs)) {
        if (!key.startsWith('data-')) continue;
        const value = raw.startsWith(prefix)
          ? JSON.parse(raw.slice(prefix.length))[0]
          : raw;
        dataset[camel(key.slice(5))] = value;
        node.attrs[key] = String(value);
      }
      const address = `${location}/${index}`;
      entries.push({ node, dataset, ancestors, address });
      visit(node.children, [...ancestors, node], address);
    });
  }
  visit(rendered);
  return entries;
}

function createNativeControlBridge(
  { page, pageFile, dist, extension = 'js' },
  { eventType, method, nativeTag, nativeBinding, supported },
) {
  const bindings = [
    `bind:${eventType}`,
    `bind${eventType}`,
    `catch:${eventType}`,
    `catch${eventType}`,
  ];
  assert.ok(
    extension === 'js' || extension === 'ts',
    'Component entrypoint extension must be js or ts',
  );
  const config = JSON.parse(readFileSync(`${pageFile}.json`, 'utf8'));
  const components = config.usingComponents ?? {};
  const componentPath = (tag) => {
    const relative = components[tag];
    if (!relative) return null;
    const resolved = relative.startsWith('/')
      ? path.resolve(dist, `.${relative}`)
      : path.resolve(path.dirname(pageFile), relative);
    assert.ok(
      resolved.startsWith(`${dist}${path.sep}`),
      'Component stays inside the selected emitted artifact',
    );
    return resolved;
  };
  const componentKind = (tag) => {
    const file = componentPath(tag);
    return file && path.basename(file);
  };
  const templates = {},
    visited = new Set();
  function readTree(file) {
    assert.ok(file.startsWith(`${dist}${path.sep}`));
    if (visited.has(file)) return;
    visited.add(file);
    const tree = datasetTree(parse(readFileSync(file, 'utf8')));
    function visit(nodes) {
      for (const node of nodes) {
        if (typeof node === 'string') continue;
        if (node.tag === 'import')
          readTree(path.resolve(path.dirname(file), node.attrs.src));
        if (node.tag === 'template' && node.attrs.name)
          templates[node.attrs.name] = node;
        visit(node.children);
      }
    }
    visit(tree.children);
    return tree;
  }
  const tree = readTree(`${pageFile}.wxml`);
  const records = () => renderTree(tree, page.data, templates);
  const matches = (entry, handler, dataset) =>
    supported.has(componentKind(entry.node.tag)) &&
    bindings.some((key) => entry.node.attrs[key] === handler) &&
    Object.entries(dataset).every(
      ([key, value]) => String(entry.dataset[camel(key)]) === String(value),
    );
  const find = (handler, dataset = {}) =>
    records().find((entry) => matches(entry, handler, dataset));
  const fingerprint = (entry) =>
    JSON.stringify([
      entry.address,
      entry.node.tag,
      entry.node.attrs,
      entry.dataset,
      entry.ancestors.map((node) => [node.tag, node.attrs]),
    ]);
  const captures = new Set(),
    emissions = [];
  let visible = true,
    attached = true;
  const allowed = (entry) =>
    visible &&
    attached &&
    ![...entry.ancestors, entry.node].some(
      (node) =>
        hidden(node) ||
        enabledAttribute(node.attrs.disabled) ||
        enabledAttribute(node.attrs.loading),
    ) &&
    !entry.ancestors.some(
      (node) =>
        components[node.tag] && !presentation.has(componentKind(node.tag)),
    ) &&
    (eventType !== 'input' ||
      !enabledAttribute(entry.node.attrs['read-only'])) &&
    !['open-type', 'form-type'].some((key) => key in entry.node.attrs);
  const definitions = new Map();
  function definition(tag) {
    const file = componentPath(tag);
    if (definitions.has(file)) return definitions.get(file);
    assert.equal(
      JSON.parse(readFileSync(`${file}.json`, 'utf8')).component,
      true,
    );
    let registered;
    const previous = globalThis.Component;
    globalThis.Component = (value) => {
      assert.equal(registered, undefined, 'One emitted Component registration');
      registered = value;
    };
    try {
      delete require.cache[require.resolve(`${file}.${extension}`)];
      require(`${file}.${extension}`);
    } finally {
      if (previous === undefined) delete globalThis.Component;
      else globalThis.Component = previous;
    }
    assert.ok(registered, 'Actual emitted entrypoint calls Component');
    assert.equal(typeof registered.methods?.[method], 'function');
    const value = {
      registered,
      tree: datasetTree(parse(readFileSync(`${file}.wxml`, 'utf8'))),
    };
    definitions.set(file, value);
    return value;
  }
  function capture(handler, dataset = {}) {
    const initial = find(handler, dataset);
    assert.ok(initial, `Actual WXML renders native F7 ${eventType}=${handler}`);
    const identity = fingerprint(initial);
    const { registered, tree: componentTree } = definition(initial.node.tag);
    const properties = Object.fromEntries(
      Object.entries(registered.properties ?? {}).map(([name, property]) => {
        const raw = initial.node.attrs[kebab(name)];
        const value =
          raw === undefined
            ? structuredClone(property.value)
            : property.type === Boolean
              ? enabledAttribute(raw)
              : property.type === Number
                ? Number(raw)
                : raw;
        return [name, value];
      }),
    );
    let detached = false;
    const initiallyActive = visible && attached;
    const current = () => {
      if (detached || !initiallyActive) return null;
      const entry = records().find(
        (candidate) => fingerprint(candidate) === identity,
      );
      return entry ?? null;
    };
    const instance = {
      properties,
      data: structuredClone(registered.data ?? {}),
      triggerEvent(type, detail, options) {
        assert.equal(
          type,
          eventType,
          `Only the emitted isolated ${eventType} event is supported`,
        );
        assert.deepEqual(options, { bubbles: false, composed: false });
        const entry = current();
        if (!entry || !allowed(entry)) return;
        if (
          eventType === 'input' &&
          (!instance.data.mounted ||
            !instance.data.pageVisible ||
            properties.disabled ||
            properties.readOnly)
        )
          return;
        const event = {
          type,
          detail: structuredClone(detail),
          currentTarget: { dataset: structuredClone(entry.dataset) },
          target: { dataset: structuredClone(entry.dataset) },
        };
        emissions.push({
          ...structuredClone(event),
          options: structuredClone(options),
          tag: entry.node.tag,
        });
        assert.equal(typeof page[handler], 'function');
        page[handler](event);
      },
    };
    Object.assign(instance, registered.methods);
    instance.setData = (patch, callback) => {
      Object.assign(instance.data, patch);
      callback?.();
    };
    registered.lifetimes?.attached?.call(instance);
    const inner = renderTree(
      componentTree,
      { ...instance.data, ...properties },
      {},
    ).find(
      (entry) =>
        entry.node.tag === nativeTag &&
        entry.node.attrs[nativeBinding] === method,
    );
    const handle = {
      node: initial.node,
      instance,
      definition: registered,
      detach() {
        if (detached) return;
        detached = true;
        registered.lifetimes?.detached?.call(instance);
        captures.delete(handle);
      },
      sync() {
        if (!current()) handle.detach();
      },
      lifecycle(name) {
        registered.pageLifetimes?.[name]?.call(instance);
      },
      [eventType](
        nativeEvent = {
          currentTarget: { dataset: structuredClone(inner?.dataset ?? {}) },
        },
      ) {
        const entry = current();
        if (
          !entry ||
          !allowed(entry) ||
          !inner ||
          hidden(inner.node) ||
          enabledAttribute(inner.node.attrs.disabled) ||
          ['open-type', 'form-type'].some((key) => key in inner.node.attrs)
        )
          return false;
        const before = emissions.length;
        registered.methods[method].call(instance, nativeEvent);
        return emissions.length !== before;
      },
    };
    captures.add(handle);
    return handle;
  }
  return {
    find: (handler, dataset) => find(handler, dataset)?.node,
    capture,
    isComponent: (tag) => Boolean(components[tag]),
    emissions,
    sync() {
      for (const handle of [...captures]) handle.sync();
    },
    lifecycle(name) {
      if (name === 'show') {
        if (attached) visible = true;
      } else visible = false;
      if (name === 'detach') attached = false;
      for (const handle of [...captures]) {
        handle.lifecycle(name);
        if (name !== 'show') handle.detach();
      }
    },
  };
}
