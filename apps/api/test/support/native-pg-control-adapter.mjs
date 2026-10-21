/** Test-only native event adapter. Reuses the validated emitted F7 models.
 * Only the two actual category wrappers get an exact static include projection.
 * No gateway/controller substitutions and no arbitrary custom event fallback. */
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
import {
  createNativePressBridge,
  createNativeInputBridge,
} from '../../../wechat/test/native-press-emitted-harness.mjs';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const enabled = (value) => value === 'true' || value === '';
const hidden = (node) =>
  enabled(node.attrs.hidden) ||
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(
    node.attrs.style ?? '',
  );
const camel = (value) =>
  value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

export function createNativePgControls({
  page,
  pageFile,
  dist,
  renderNodes,
  extension = 'js',
}) {
  dist = path.resolve(dist);
  pageFile = path.resolve(pageFile);
  assert.ok(
    pageFile.startsWith(`${dist}${path.sep}`),
    'Page stays inside selected artifact',
  );
  const source = readFileSync(`${pageFile}.wxml`, 'utf8');
  const registrations =
    JSON.parse(readFileSync(`${pageFile}.json`, 'utf8')).usingComponents ?? {};
  const presentationAncestor = (tag) => {
    const relative = registrations[tag];
    if (!relative)
      return !tag.includes('-') || ['scroll-view', 'cover-view'].includes(tag);
    const file = relative.startsWith('/')
      ? path.resolve(dist, `.${relative}`)
      : path.resolve(path.dirname(pageFile), relative);
    return ['f7-block', 'f7-list'].some(
      (kind) => file === path.join(dist, 'components', kind, kind),
    );
  };
  let staging, projection;
  let selectedPage = pageFile,
    selectedDist = dist;
  if (/<include\b/.test(source)) {
    assert.ok(
      ['rating-category-editor', 'rating-category-manage'].includes(
        path.basename(pageFile),
      ),
      'Only the two actual category wrappers support includes',
    );
    const include = /^\s*<include src="([^"{}]+)"\s*\/>\s*$/.exec(source);
    assert.ok(include, 'Only one complete static include wrapper is supported');
    assert.equal(include[1], '../../ratings/framework7-recovery-category.wxml');
    const target = path.resolve(path.dirname(pageFile), include[1]);
    assert.equal(
      target,
      path.join(dist, 'ratings/framework7-recovery-category.wxml'),
    );
    assert.ok(
      target.startsWith(`${dist}${path.sep}`),
      'Include stays inside selected artifact',
    );
    const included = readFileSync(target, 'utf8');
    assert.doesNotMatch(
      included,
      /<(?:include|import)\b/,
      'Nested includes/imports are not supported',
    );
    const expanded =
      source.slice(0, source.indexOf('<include')) +
      included +
      source.slice(source.indexOf('/>') + 2);
    staging = mkdtempSync(path.join(tmpdir(), 'whaleu-pg-category-controls-'));
    try {
      selectedPage = path.join(staging, path.relative(dist, pageFile));
      selectedDist = staging;
      mkdirSync(path.dirname(selectedPage), { recursive: true });
      // Copy bytes without parsing/decoding: the existing parser alone decodes text.
      writeFileSync(`${selectedPage}.wxml`, expanded);
      cpSync(`${pageFile}.json`, `${selectedPage}.json`);
      cpSync(path.join(dist, 'components'), path.join(staging, 'components'), {
        recursive: true,
      });
      projection = {
        sourceSha256: sha(source),
        includeSha256: sha(included),
        projectionSha256: sha(expanded),
        source: path.relative(dist, `${pageFile}.wxml`),
        include: path.relative(dist, target),
      };
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  let press, input;
  try {
    const options = {
      page,
      pageFile: selectedPage,
      dist: selectedDist,
      extension,
    };
    press = createNativePressBridge(options);
    input = createNativeInputBridge(options);
  } catch (error) {
    if (staging) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  let visible = true,
    attached = true,
    synchronousShowDepth = 0;
  const sync = () => {
    press.sync();
    input.sync();
  };
  const originalSetData = page.setData;
  page.setData = function (...args) {
    const result = originalSetData.apply(this, args);
    sync();
    return result;
  };
  for (const [method, lifecycle] of [
    ['onShow', 'show'],
    ['onHide', 'hide'],
    ['onUnload', 'detach'],
  ]) {
    const original = page[method];
    page[method] = function (...args) {
      // Match the validated harness: only synchronous cleanup inside onShow is
      // exempt from platform hide. Async show completion cannot revive a page.
      if (lifecycle !== 'hide' || synchronousShowDepth === 0) {
        visible = lifecycle === 'show' && attached;
        if (lifecycle === 'detach') attached = false;
        press.lifecycle(lifecycle);
        input.lifecycle(lifecycle);
      }
      if (lifecycle === 'show') synchronousShowDepth++;
      try {
        return original?.apply(this, args);
      } finally {
        if (lifecycle === 'show') synchronousShowDepth--;
        if (lifecycle === 'detach' && staging) {
          rmSync(staging, { recursive: true, force: true });
          staging = undefined;
        }
      }
    };
  }
  const bindings = ['bindtap', 'bindinput', 'bind:press', 'bind:input'];
  function records(nodes, ancestors = []) {
    return nodes.flatMap((node) =>
      typeof node === 'string'
        ? []
        : [
            { node, ancestors },
            ...records(node.children, [...ancestors, node]),
          ],
    );
  }
  function dispatch(handler, dataset = {}, value = '') {
    assert.ok(visible && attached, 'Page must be visible and mounted');
    const record = records(renderNodes()).find(
      ({ node }) =>
        bindings.some((key) => node.attrs[key] === handler) &&
        Object.entries(dataset).every(
          ([key, value]) => node.attrs[`data-${key}`] === String(value),
        ),
    );
    assert.ok(record, `Actual WXML renders supported event=${handler}`);
    const { node, ancestors } = record;
    assert.ok(
      ![...ancestors, node].some(
        (entry) =>
          hidden(entry) ||
          enabled(entry.attrs.disabled) ||
          enabled(entry.attrs.loading),
      ),
      `${handler} must be visible and enabled`,
    );
    assert.ok(
      !ancestors.some((entry) => !presentationAncestor(entry.tag)),
      'Events never bypass an unknown custom component ancestor',
    );
    if (
      node.attrs['bind:press'] === handler ||
      node.attrs['bind:input'] === handler
    ) {
      const isInput = node.attrs['bind:input'] === handler;
      const control = (isInput ? input : press).capture(handler, dataset);
      try {
        assert.ok(
          isInput
            ? control.input({ detail: { value, cursor: value.length } })
            : control.press(),
          `${handler} must execute its live registered native F7 model`,
        );
      } finally {
        control.detach();
      }
      return;
    }
    assert.ok(
      !press.isComponent(node.tag),
      'Unknown custom components never use raw event fallback',
    );
    assert.ok(
      (node.attrs.bindinput === handler &&
        ['input', 'textarea'].includes(node.tag)) ||
        (node.attrs.bindtap === handler && node.tag === 'button'),
      'Only native editor/button events are supported',
    );
    assert.ok(
      !['open-type', 'form-type'].some((key) => key in node.attrs),
      'Permission/form controls need their own explicit bridge',
    );
    assert.equal(typeof page[handler], 'function');
    const fullDataset = Object.fromEntries(
      Object.entries(node.attrs)
        .filter(([key]) => key.startsWith('data-'))
        .map(([key, value]) => [camel(key.slice(5)), value]),
    );
    return page[handler]({
      currentTarget: { dataset: fullDataset },
      detail: { value },
    });
  }
  return { dispatch, press, input, projection };
}
