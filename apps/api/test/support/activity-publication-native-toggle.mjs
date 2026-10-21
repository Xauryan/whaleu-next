/** Test-only activity publisher QR bridge. Executes the selected artifact's real
 * F7 Toggle registration and native switch method; not a generic event bridge,
 * renderer/device proof, or evidence of publication/server acceptance. */
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse, render } from '../../../wechat/scripts/smoke-ratings.mjs';
const require = createRequire(import.meta.url);
const camel = (key) => key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
// Missing/explicit false is safe. Unknown values must never enable a control.
const blocked = (value) => value !== undefined && value !== 'false';
const hidden = (node) =>
  blocked(node.attrs.hidden) ||
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(
    node.attrs.style ?? '',
  );
const nativeAncestors = new Set(['view', 'block', 'scroll-view', 'label']);
const presentations = new Map([
  ['wu-f7-block', 'f7-block'],
  ['wu-f7-list', 'f7-list'],
]);

// The unchanged shared renderer stringifies attributes. Preserve only full
// dataset expressions here, using its existing parser/template semantics.
function datasetTree(node) {
  if (typeof node === 'string') return node;
  return {
    ...node,
    attrs: Object.fromEntries(
      Object.entries(node.attrs).map(([key, value]) => {
        const expression = /^{{([\s\S]*)}}$/.exec(value);
        if (node.tag === 'template' && node.attrs.is && key === 'data')
          return [key, `{{__qrDataset: __qrDataset, ${value.slice(2, -2)}}}`];
        return [
          key,
          key.startsWith('data-') && expression && !/}}|{{/.test(expression[1])
            ? `{{__qrDataset([${expression[1]}])}}`
            : value,
        ];
      }),
    ),
    children: node.children.map(datasetTree),
  };
}
function entries(tree, data, templates = {}) {
  const prefix = '\u0001qr-dataset:';
  const nodes = render(
    tree.children.filter(
      (n) => typeof n === 'string' || n.tag !== 'template' || !n.attrs.name,
    ),
    {
      ...data,
      __qrDataset: (value) => prefix + JSON.stringify(value),
    },
    templates,
  );
  const result = [];
  function visit(children, ancestors = [], address = '') {
    children.forEach((node, index) => {
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
      const location = `${address}/${index}`;
      result.push({ node, dataset, ancestors, address: location });
      visit(node.children, [...ancestors, node], location);
    });
  }
  visit(nodes);
  return result;
}
const fingerprint = (entry) =>
  JSON.stringify([
    entry.address,
    entry.node.tag,
    entry.node.attrs,
    entry.dataset,
    entry.ancestors.map((node) => [node.tag, node.attrs]),
  ]);

export function createActivityPublicationToggleBridge({
  page,
  pageFile,
  dist,
}) {
  const root = realpathSync(path.resolve(dist));
  const selectedPage = path.join(
    root,
    'pages/activity-publish/activity-publish',
  );
  assert.equal(
    path.resolve(pageFile),
    selectedPage,
    'Only the selected activity-publish Page is supported',
  );
  function artifact(file) {
    const resolved = path.resolve(file);
    assert.ok(
      resolved.startsWith(`${root}${path.sep}`),
      'Path must stay in the selected emitted artifact',
    );
    assert.equal(
      realpathSync(resolved),
      resolved,
      'Artifact files must not redirect to another artifact',
    );
    return resolved;
  }
  for (const extension of ['js', 'wxml', 'json'])
    artifact(`${selectedPage}.${extension}`);
  assert.equal(
    typeof page.onQr,
    'function',
    'Actual publisher onQr must exist',
  );
  assert.equal(typeof page.setData, 'function');
  const components =
    JSON.parse(readFileSync(artifact(`${selectedPage}.json`), 'utf8'))
      .usingComponents ?? {};
  function registeredPath(tag, kind) {
    const target = components[tag];
    assert.equal(
      typeof target,
      'string',
      `Missing exact registration for ${tag}`,
    );
    const resolved = target.startsWith('/')
      ? path.resolve(root, `.${target}`)
      : path.resolve(path.dirname(selectedPage), target);
    assert.equal(
      resolved,
      path.join(root, `components/${kind}/${kind}`),
      `Wrong emitted ${tag} registration`,
    );
    for (const extension of ['js', 'wxml', 'json'])
      artifact(`${resolved}.${extension}`);
    assert.equal(
      JSON.parse(readFileSync(`${resolved}.json`, 'utf8')).component,
      true,
      'Registered artifact must be a Component',
    );
    return resolved;
  }
  const componentFile = registeredPath('wu-f7-toggle', 'f7-toggle');
  const templates = {},
    visited = new Set();
  function readTree(file) {
    const target = artifact(file);
    if (visited.has(target)) return;
    visited.add(target);
    const tree = datasetTree(parse(readFileSync(target, 'utf8')));
    function visit(nodes) {
      for (const node of nodes) {
        if (typeof node === 'string') continue;
        if (node.tag === 'import')
          readTree(path.resolve(path.dirname(target), node.attrs.src));
        if (node.tag === 'template' && node.attrs.name)
          templates[node.attrs.name] = node;
        visit(node.children);
      }
    }
    visit(tree.children);
    return tree;
  }
  const tree = readTree(`${selectedPage}.wxml`);
  const records = () => entries(tree, page.data, templates);
  const selected = () => {
    const found = records().filter(
      (entry) =>
        entry.node.tag === 'wu-f7-toggle' &&
        entry.node.attrs['bind:change'] === 'onQr',
    );
    assert.ok(
      found.length <= 1,
      'Publisher must not have ambiguous QR toggle bindings',
    );
    return found[0];
  };
  let definition;
  const previous = globalThis.Component;
  globalThis.Component = (value) => {
    assert.equal(
      definition,
      undefined,
      'Exactly one real emitted Component registration',
    );
    definition = value;
  };
  try {
    delete require.cache[require.resolve(`${componentFile}.js`)];
    require(`${componentFile}.js`);
  } finally {
    if (previous === undefined) delete globalThis.Component;
    else globalThis.Component = previous;
  }
  assert.ok(definition, 'Actual emitted Toggle must register Component');
  assert.equal(definition.options?.styleIsolation, 'isolated');
  for (const method of ['onChange'])
    assert.equal(typeof definition.methods?.[method], 'function');
  for (const lifetime of ['attached', 'detached'])
    assert.equal(typeof definition.lifetimes?.[lifetime], 'function');
  assert.equal(typeof definition.observers?.checked, 'function');
  const componentTree = datasetTree(
    parse(readFileSync(artifact(`${componentFile}.wxml`), 'utf8')),
  );
  const captures = new Set(),
    emissions = [];
  let visible = false,
    attached = true,
    showDepth = 0,
    revision = 0;
  const allowed = (entry) =>
    visible &&
    attached &&
    ![...entry.ancestors, entry.node].some(
      (node) =>
        hidden(node) ||
        ['disabled', 'loading', 'read-only', 'readOnly'].some((key) =>
          blocked(node.attrs[key]),
        ) ||
        ['open-type', 'form-type'].some((key) => key in node.attrs),
    ) &&
    entry.ancestors.every((node) => {
      if (nativeAncestors.has(node.tag)) return !components[node.tag];
      const kind = presentations.get(node.tag);
      if (!kind) return false;
      registeredPath(node.tag, kind);
      return true;
    });
  function properties(entry) {
    return Object.fromEntries(
      Object.entries(definition.properties).map(([key, spec]) => {
        const raw = entry.node.attrs[kebab(key)];
        if (raw === undefined) return [key, structuredClone(spec.value)];
        if (spec.type === Boolean) {
          assert.ok(
            ['true', 'false', ''].includes(raw),
            `Unknown boolean ${key} fails closed`,
          );
          return [key, raw !== 'false'];
        }
        assert.equal(
          spec.type,
          String,
          'Only actual Toggle property types are supported',
        );
        return [key, raw];
      }),
    );
  }
  function capture() {
    const initial = selected();
    assert.ok(initial, 'Actual publisher WXML must render bind:change="onQr"');
    const identity = fingerprint(initial),
      owner = page.controller,
      handler = page.onQr;
    const capturedRevision = revision,
      initiallyActive = visible && attached;
    let detached = false,
      invoking = false,
      delivering = false;
    const current = () => {
      if (
        detached ||
        !initiallyActive ||
        capturedRevision !== revision ||
        page.controller !== owner ||
        page.onQr !== handler
      )
        return null;
      const entry = selected();
      return entry && fingerprint(entry) === identity ? entry : null;
    };
    const instance = {
      properties: properties(initial),
      data: structuredClone(definition.data),
      ...definition.methods,
      setData(patch, callback) {
        Object.assign(this.data, patch);
        callback?.();
      },
      triggerEvent(type, detail, options) {
        assert.equal(
          type,
          'change',
          'Only actual Toggle change may be delivered',
        );
        assert.deepEqual(options, { bubbles: false, composed: false });
        assert.deepEqual(Object.keys(detail ?? {}), ['value']);
        assert.equal(typeof detail.value, 'boolean');
        const entry = current();
        if (
          !invoking ||
          delivering ||
          !entry ||
          !allowed(entry) ||
          instance.data.mounted !== true ||
          instance.data.pageVisible !== true ||
          instance.properties.disabled ||
          instance.properties.readOnly
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
        delivering = true;
        try {
          handler.call(page, event);
        } finally {
          delivering = false;
        }
      },
    };
    definition.lifetimes.attached.call(instance);
    const inner = () =>
      entries(componentTree, {
        ...instance.data,
        ...instance.properties,
      }).filter(
        (entry) =>
          entry.node.tag === 'switch' &&
          entry.node.attrs.catchchange === 'onChange',
      );
    assert.equal(
      inner().length,
      1,
      'Actual Toggle WXML must expose one native switch catchchange',
    );
    const handle = {
      instance,
      definition,
      node: initial.node,
      detach() {
        if (detached) return;
        detached = true;
        definition.lifetimes.detached.call(instance);
        captures.delete(handle);
      },
      sync() {
        if (!delivering) {
          handle.detach();
          return;
        }
        // The emitted model reconciles BEFORE its event. The owner's synchronous
        // setData must reach the real checked observer before callback/return.
        const entry = selected();
        if (
          !entry ||
          entry.address !== initial.address ||
          page.controller !== owner ||
          page.onQr !== handler ||
          !allowed(entry)
        ) {
          handle.detach();
          return;
        }
        Object.assign(instance.properties, properties(entry));
        definition.observers.checked.call(
          instance,
          instance.properties.checked,
        );
      },
      lifecycle(name) {
        definition.pageLifetimes?.[name]?.call(instance);
      },
      change(nativeEvent) {
        const entry = current(),
          switches = inner(),
          native = switches[0];
        if (
          !entry ||
          !allowed(entry) ||
          switches.length !== 1 ||
          native.node.attrs.type !== 'switch' ||
          native.ancestors.some((node) => !nativeAncestors.has(node.tag)) ||
          [...native.ancestors, native.node].some(
            (node) =>
              hidden(node) ||
              blocked(node.attrs.disabled) ||
              blocked(node.attrs.loading) ||
              blocked(node.attrs['read-only']) ||
              ['open-type', 'form-type'].some((key) => key in node.attrs),
          ) ||
          instance.data.mounted !== true ||
          instance.data.pageVisible !== true ||
          instance.properties.disabled ||
          instance.properties.readOnly
        ) {
          handle.detach();
          return false;
        }
        const before = emissions.length;
        const expected =
          typeof nativeEvent?.detail?.value === 'boolean' &&
          nativeEvent.detail.value !== instance.properties.checked;
        invoking = true;
        try {
          definition.methods[native.node.attrs.catchchange].call(
            instance,
            nativeEvent,
          );
          assert.equal(
            emissions.length - before,
            expected ? 1 : 0,
            'Actual model emits exactly once for a valid transition, otherwise zero',
          );
          return emissions.length === before + 1;
        } finally {
          invoking = false;
          handle.detach();
        }
      },
    };
    captures.add(handle);
    return handle;
  }
  const originalSetData = page.setData;
  const sync = () => {
    revision++;
    for (const control of [...captures]) control.sync();
  };
  page.setData = function (patch, callback) {
    let synchronized = false;
    const result = originalSetData.call(this, patch, function (...args) {
      synchronized = true;
      sync();
      return callback?.apply(this, args);
    });
    if (!synchronized) sync();
    return result;
  };
  for (const [method, lifecycle] of [
    ['onShow', 'show'],
    ['onHide', 'hide'],
    ['onUnload', 'detach'],
  ]) {
    const original = page[method];
    page[method] = function (...args) {
      // Preserve existing mount guards. A synchronous cleanup onHide inside
      // onShow is not platform hide; never revive from async onShow completion.
      if (lifecycle !== 'hide' || showDepth === 0) {
        visible = lifecycle === 'show' && attached;
        if (lifecycle === 'detach') attached = false;
        for (const control of [...captures]) {
          control.lifecycle(lifecycle);
          control.detach();
        }
      }
      if (lifecycle === 'show') showDepth++;
      try {
        return original?.apply(this, args);
      } finally {
        if (lifecycle === 'show') showDepth--;
      }
    };
  }
  return { capture, emissions };
}
