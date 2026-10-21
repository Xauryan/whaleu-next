import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import {
  ToolEntryController,
  initialToolEntryView,
  type ToolEmbedPort,
} from '../src/campus-tools/controller';
import {
  disabledToolLocation,
  type ToolLocationPort,
  type ToolLocationResult,
} from '../src/campus-tools/location';
import {
  ToolImageReader,
  initialToolImageView,
  type ToolMediaDescriptor,
} from '../src/campus-tools/media';
import { ToolBrowseScope } from '../src/campus-tools/scope';
import { OptionalMediaPrincipalOwner } from '../src/media/optional-principal';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
import {
  entry,
  gateway,
  link,
  revision,
  route,
  slot,
} from './campus-tools-fixtures';
import { deferred, FakeClock, flush } from './helpers';
import { wireCredentials } from './identity-helpers';

const root = path.join(__dirname, '..');
const requireNative = createRequire(__filename);
const { parsePreviewWxml: parse, evaluatePreviewExpression: evaluate } =
  requireNative('../scripts/preview-wxml.mjs') as {
    parsePreviewWxml(source: string): PresentationNode;
    evaluatePreviewExpression(expression: string, scope: object): unknown;
  };
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, ext = 'wxml') =>
  read(`src/pages/${page}/${page}.${ext}`);
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const flatten = (node: PresentationNode): PresentationNode[] => [
  node,
  ...node.children.flatMap((child) =>
    typeof child === 'string' ? [] : flatten(child),
  ),
];
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
const before = JSON.parse(
  read('test/fixtures/framework7-campus-tools-before-actions.json'),
) as Record<
  string,
  { sourceSha256: string; typescriptSha256: string; actions: Action[] }
>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-campus-tools-before-protected.json'),
) as Record<string, string>;
function actions(
  raw: PresentationNode,
  parents: Record<string, string>[] = [],
): Action[] {
  const node = normalizeFramework7ActionNode(raw);
  const own = Object.fromEntries(
    Object.entries(node.attrs).filter(([key]) =>
      [
        'wx:if',
        'wx:elif',
        'wx:else',
        'wx:for',
        'wx:for-item',
        'wx:for-index',
        'wx:key',
      ].includes(key),
    ),
  );
  const scopes = Object.keys(own).length ? [...parents, own] : parents;
  return [
    ...(node.tag === 'navigator' ||
    Object.keys(node.attrs).some((key) => /^(bind|catch)/.test(key))
      ? [{ tag: node.tag, attrs: node.attrs, scopes }]
      : []),
    ...node.children.flatMap((child) =>
      typeof child === 'string' ? [] : actions(child, scopes),
    ),
  ];
}
for (const [page, baseline] of Object.entries(before)) {
  test(`${page}: exact pre-port action ancestry, datasets, loading/disabled and native callbacks survive`, () => {
    const current = actions(parse(source(page)));
    assert.equal(current.length, baseline.actions.length);
    for (const original of baseline.actions) {
      const index = current.findIndex(
        (candidate) =>
          candidate.tag === original.tag &&
          JSON.stringify(candidate.scopes) ===
            JSON.stringify(original.scopes) &&
          Object.entries(original.attrs).every(
            ([key, value]) => candidate.attrs[key] === value,
          ),
      );
      assert.notEqual(index, -1, JSON.stringify(original));
      current.splice(index, 1);
    }
    assert.equal(current.length, 0);
    assert.equal(hash(source(page, 'ts')), baseline.typescriptSha256);
  });
  test(`${page}: real registered F7 components preserve native ownership without nested controls or new overlays`, () => {
    const nodes = flatten(parse(source(page)));
    const config = JSON.parse(source(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    for (const kind of [
      'button',
      'block',
      ...(page === 'campus-tools-webview' ? [] : ['list', 'list-item']),
    ])
      assert.ok(
        nodes.some((node) => node.tag === `wu-f7-${kind}`),
        kind,
      );
    for (const node of nodes.filter((node) => node.tag.startsWith('wu-f7-'))) {
      const component = node.tag.slice(3);
      assert.equal(
        config.usingComponents[node.tag],
        `../../components/${component}/${component}`,
      );
      assert.equal(node.attrs['open-type'], undefined);
      if (['wu-f7-button', 'wu-f7-list-item'].includes(node.tag)) {
        assert.ok(
          !flatten(node)
            .slice(1)
            .some((child) =>
              /^(button|input|textarea|switch|navigator|wu-f7-button|wu-f7-input|wu-f7-toggle|wu-f7-list-item)$/.test(
                child.tag,
              ),
            ),
        );
      }
      if (node.tag === 'wu-f7-list-item')
        assert.equal(node.attrs.link, '{{true}}');
    }
    assert.ok(
      !nodes.some((node) =>
        /^(input|wu-f7-searchbar|wu-f7-input|wu-f7-sheet|wu-f7-dialog|wu-f7-actions|script|rich-text)$/.test(
          node.tag,
        ),
      ),
      'no new input or overlay interaction introduced on a page that had none',
    );
    assert.match(source(page, 'wxss'), /framework7-campus-tools\.wxss/);
    const css = read(`src/pages/${page}/framework7-campus-tools.wxss`);
    assert.match(css, /Framework7 v9\.2\.0/);
    assert.match(css, /@import '\.\.\/\.\.\/design\/framework7-ios\.wxss'/);
    assert.doesNotMatch(source(page), /https?:\/\/|data:image/);
  });
}
// Shared test-only Input normalization and mixed-attribute preview interpolation
// were reviewed separately; no protected production source changed. Their exact
// updated hashes remain enforced below, with independent helper regressions.
test('35 campus-tool controllers, platform policies, components and reviewed shared test helper match the frozen baseline', () => {
  assert.equal(Object.keys(protectedFiles).length, 35);
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) => !assertReviewedBusinessSuccessor(file, expected),
  ))
    assert.equal(hash(read(file)), expected, file);
  const manifest = JSON.parse(
    read('../../docs/vendor/framework7-v9.2.0/upstream-manifest.json'),
  );
  assert.equal(manifest.version, '9.2.0');
  assert.equal(manifest.commit, '7668f883c29f69dd2ad7bd8ac3b35b9124082b0b');
});
test('map/webview/image callbacks keep their exact native tags and source identities; disclosure remains native', () => {
  for (const [page, baseline] of Object.entries(before)) {
    const native = flatten(parse(source(page))).filter((node) =>
      ['map', 'web-view', 'image'].includes(node.tag),
    );
    for (const old of baseline.actions.filter((node) =>
      ['map', 'web-view', 'image'].includes(node.tag),
    ))
      assert.deepEqual(
        native.find((node) => node.tag === old.tag)?.attrs,
        old.attrs,
      );
    assert.equal(
      native.filter((node) => node.tag === 'web-view').length,
      page === 'campus-tools-webview' ? 1 : 0,
    );
  }
  const disclosure = flatten(parse(source('campus-tools-shuttle'))).filter(
    (node) => node.tag === 'button',
  );
  assert.equal(disclosure.length, 1);
  assert.equal(disclosure[0]!.attrs.bindtap, 'onToggleGroup');
});

interface Fixture {
  id: string;
  page: string;
  patch: Record<string, unknown>;
  expectedText: string[];
}
const fixtures = requireNative(
  '../scripts/fixtures/framework7-campus-tools-preview.mjs',
).default as Fixture[];
function visible(
  nodes: (PresentationNode | string)[],
  scope: Record<string, unknown>,
): string {
  let result = '',
    matched = false;
  for (const node of nodes) {
    if (typeof node === 'string') {
      result += node.replace(/{{([\s\S]*?)}}/g, (_, expression: string) =>
        String(evaluate(expression, scope) ?? ''),
      );
      continue;
    }
    const attrs = node.attrs;
    if (attrs['wx:for']) {
      const { ['wx:for']: loop, ...rest } = attrs;
      for (const [index, item] of (
        (evaluate(loop.slice(2, -2), scope) ?? []) as unknown[]
      ).entries())
        result += visible([{ ...node, attrs: rest }], {
          ...scope,
          [attrs['wx:for-item'] ?? 'item']: item,
          [attrs['wx:for-index'] ?? 'index']: index,
        });
      continue;
    }
    if ('wx:if' in attrs) matched = false;
    const condition = attrs['wx:if'] ?? attrs['wx:elif'];
    if ('wx:elif' in attrs && matched) continue;
    if (condition !== undefined) {
      if (!evaluate(condition.slice(2, -2), scope)) continue;
      matched = true;
    } else if ('wx:else' in attrs) {
      if (matched) continue;
      matched = true;
    } else matched = false;
    result += visible(node.children, scope);
  }
  return result;
}
test('26 source-preview fixtures cover all four pages without network/media/provider execution', () => {
  assert.equal(fixtures.length, 26);
  assert.equal(new Set(fixtures.map((item) => item.id)).size, 26);
  assert.deepEqual(
    [...new Set(fixtures.map((item) => item.page))].sort(),
    Object.keys(before).sort(),
  );
});
for (const fixture of fixtures)
  test(`${fixture.id}: synthetic guarded state renders meaningful source content`, () => {
    const data = {
      ...initialToolEntryView(),
      image: initialToolImageView(),
      authRecovery: false,
      ...fixture.patch,
    };
    const text = visible(parse(source(fixture.page)).children, data);
    for (const expected of fixture.expectedText)
      assert.ok(text.includes(expected), `${fixture.id}: ${expected}`);
    assert.doesNotMatch(
      text,
      /\{\{|undefined|NaN|当前已确认的工具资料|可信的嵌入能力/,
    );
    assert.equal(data.webviewSrc, '');
    assert.equal(data.image.src, '');
  });

interface Instance {
  [name: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(value: Record<string, unknown>): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
type Method = (this: Instance, event?: unknown) => unknown;
interface Definition {
  properties: Record<string, { value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, Method>;
  lifetimes?: Record<string, Method>;
  pageLifetimes?: Record<string, Method>;
}
function registration<T>(kind: 'Component' | 'Page', file: string): T {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals[kind];
  let definition: T | undefined;
  globals[kind] = (value: T) => {
    definition = value;
  };
  try {
    const target = requireNative.resolve(path.join(root, 'src', file));
    delete requireNative.cache[target];
    requireNative(target);
  } finally {
    globals[kind] = previous;
  }
  assert.ok(definition);
  return definition;
}
function component(
  name: string,
  properties: Record<string, unknown>,
  emit: (name: string, detail: unknown) => void,
) {
  const definition = registration<Definition>(
    'Component',
    `components/${name}/${name}.ts`,
  );
  const instance: Instance = {
    properties: {
      ...Object.fromEntries(
        Object.entries(definition.properties).map(([key, value]) => [
          key,
          structuredClone(value.value),
        ]),
      ),
      ...properties,
    },
    data: structuredClone(definition.data),
    setData(value) {
      Object.assign(this.data, value);
    },
    triggerEvent(name, detail, options) {
      assert.deepEqual(options, { bubbles: false, composed: false });
      emit(name, detail);
    },
  };
  for (const [key, method] of Object.entries(definition.methods))
    instance[key] = method.bind(instance);
  definition.lifetimes?.attached?.call(instance);
  return {
    instance,
    call: (method: string, event?: unknown) =>
      definition.methods[method]!.call(instance, event),
    hide: () => definition.pageLifetimes?.hide?.call(instance),
    detach: () => definition.lifetimes?.detached?.call(instance),
  };
}
type Owner = {
  [name: string]: unknown;
  data: Record<string, unknown>;
  setData(value: Record<string, unknown>): void;
};
type PageEvent = {
  detail?: unknown;
  currentTarget?: { dataset: Record<string, unknown> };
};
function owner(page: string): Owner {
  const definition = registration<Owner>('Page', `pages/${page}/${page}.ts`);
  return {
    ...definition,
    data: structuredClone(definition.data),
    setData(value) {
      Object.assign(this.data, value);
    },
  };
}
function invoke(page: Owner, method: string, event?: PageEvent) {
  return (page[method] as (event?: PageEvent) => unknown).call(page, event);
}
function connect(
  page: string,
  handler: string,
  target: Owner,
  extra: Record<string, unknown> = {},
) {
  const node = flatten(parse(source(page))).find(
    (item) => item.attrs['bind:press'] === handler,
  )!;
  assert.ok(node, `${page}: ${handler}`);
  const scope = { ...target.data, ...extra };
  const value = (raw: string) =>
    raw.startsWith('{{') && raw.endsWith('}}')
      ? evaluate(raw.slice(2, -2), scope)
      : raw;
  const dataset = Object.fromEntries(
    Object.entries(node.attrs)
      .filter(([key]) => key.startsWith('data-'))
      .map(([key, raw]) => [key.slice(5), value(raw)]),
  );
  const properties = Object.fromEntries(
    Object.entries(node.attrs)
      .filter(([key]) => ['disabled', 'loading', 'link'].includes(key))
      .map(([key, raw]) => [key, value(raw)]),
  );
  const emitted: { name: string; detail: unknown }[] = [];
  const native = component(node.tag.slice(3), properties, (name, detail) => {
    emitted.push({ name, detail });
    if (name === 'press')
      void invoke(target, handler, { detail, currentTarget: { dataset } });
  });
  return { ...native, emitted, dataset, properties };
}
function press(
  page: string,
  handler: string,
  target: Owner,
  extra: Record<string, unknown> = {},
) {
  const native = connect(page, handler, target, extra);
  native.call('onPress');
  return native;
}
async function setup(
  kind: 'map' | 'shuttle' | 'research' | 'web-link',
  location: ToolLocationPort = disabledToolLocation,
  embed?: ToolEmbedPort,
) {
  const page = `campus-tools-${kind === 'web-link' ? 'webview' : kind}`;
  const target = owner(page),
    sessions = new SessionStore(),
    scope = new ToolBrowseScope(),
    clock = new FakeClock(),
    remote = gateway(entry(kind)),
    copies: string[] = [],
    releases: string[] = [];
  const principals = new OptionalMediaPrincipalOwner(sessions);
  let downloads = 0;
  const reader = new ToolImageReader(
    principals,
    remote,
    {
      descriptor: async (_route, bindingId) => {
        const current = entry(kind);
        const selected =
          current.kind === 'shuttle'
            ? current.groups
                .flatMap((group) => group.slots)
                .find((item) => item.bindingId === bindingId)!
            : slot;
        return {
          protocol: 'campus-tools-media-v1',
          kind: 'campus-tool',
          ...route,
          entryRevision: revision,
          bindingId: selected.bindingId,
          assetId: selected.assetId,
          manifestDigest: selected.manifestDigest,
          width: 20,
          height: 20,
          variants: ['thumb-v1', 'display-v1'],
        } as ToolMediaDescriptor;
      },
    },
    {
      download: async () => ({ localId: `synthetic-${++downloads}` }),
      resolve: async (file) => `wxfile://tmp/${file.localId}.png`,
      release: async (file) => {
        releases.push(file.localId);
      },
    },
    scope,
    clock,
    (image) => target.setData({ image }),
    () => controller.sourceUnavailable(),
  );
  const controller = new ToolEntryController(
    route,
    kind,
    sessions,
    remote,
    scope,
    clock,
    {
      set: async (value) => {
        copies.push(value);
      },
    },
    (view) => target.setData(view as unknown as Record<string, unknown>),
    () => reader.clear(),
    location,
    embed,
  );
  target.controller = controller;
  target.reader = reader;
  target.route = route;
  await controller.load();
  return {
    page,
    target,
    sessions,
    scope,
    clock,
    remote,
    controller,
    reader,
    copies,
    releases,
    downloads: () => downloads,
    dispose: () => {
      controller.dispose();
      reader.dispose();
      principals.dispose();
    },
  };
}

test('real ListItem/Button→map Page preserves numeric marker datasets, native marker detail and no default location request', async () => {
  const f = await setup('map');
  try {
    const selected = press(f.page, 'onMarker', f.target, { item: { id: 6 } });
    assert.deepEqual(selected.dataset, { id: 6 });
    assert.deepEqual(selected.emitted, [{ name: 'press', detail: {} }]);
    assert.equal(
      (Reflect.get(f.target.data, 'marker') as { id: number }).id,
      6,
    );
    press(f.page, 'onCloseMarker', f.target);
    assert.equal(f.target.data.marker, null);
    invoke(f.target, 'onMarker', {
      detail: { markerId: 6 },
      currentTarget: { dataset: { id: 'bad' } },
    });
    assert.equal(
      (Reflect.get(f.target.data, 'marker') as { id: number }).id,
      6,
    );
    const disabled = press(f.page, 'onLocate', f.target);
    assert.equal(disabled.emitted.length, 0);
    press(f.page, 'onReset', f.target);
    assert.equal(f.target.data.located, false);
    f.scope.select('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    selected.call('onPress');
    assert.equal(f.target.data.marker, null);
    assert.equal(f.target.data.entry, null);
  } finally {
    f.dispose();
  }
});
test('real map Button→Page rejects duplicate location and fences late completion after reset and hide', async () => {
  const location = deferred<ToolLocationResult>();
  let requests = 0;
  const f = await setup('map', {
    enabled: true,
    locate: async () => {
      requests++;
      return location.promise;
    },
  });
  try {
    const stale = press(f.page, 'onLocate', f.target);
    await flush();
    assert.equal(requests, 1);
    assert.equal(f.target.data.locating, true);
    const locked = press(f.page, 'onLocate', f.target);
    assert.equal(locked.emitted.length, 0);
    stale.call('onPress');
    await flush();
    assert.equal(requests, 1);
    press(f.page, 'onReset', f.target);
    location.resolve({
      state: 'ready',
      coordinateSystem: 'gcj02',
      position: { latitude: 20, longitude: 100 },
    });
    await flush();
    assert.deepEqual(f.target.data.center, { latitude: 40, longitude: 116 });
    assert.equal(f.target.data.located, false);
    invoke(f.target, 'onHide');
    stale.hide();
    stale.call('onPress');
    assert.equal(stale.emitted.length, 2);
    assert.equal(f.target.controller, undefined);
    assert.equal(requests, 1);
  } finally {
    f.dispose();
  }
});
test('real research Button→Page keeps duplicate-copy, revision and session fences before clipboard effects', async () => {
  const f = await setup('research');
  try {
    const pending = deferred<ReturnType<typeof link>>();
    let reads = 0;
    f.remote.link = async () => {
      reads++;
      return pending.promise;
    };
    const stale = press(f.page, 'onCopy', f.target);
    assert.equal(f.target.data.busy, true);
    assert.equal(press(f.page, 'onCopy', f.target).emitted.length, 0);
    stale.call('onPress');
    assert.equal(reads, 1);
    pending.resolve(link());
    await flush();
    assert.deepEqual(f.copies, ['https://tools.example.com/resource']);
    f.remote.link = async () => ({
      ...link(),
      entryRevision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    press(f.page, 'onCopy', f.target);
    await flush();
    assert.equal(f.copies.length, 1);
    assert.equal(f.target.data.entry, null);
    await f.controller.load();
    const late = deferred<ReturnType<typeof link>>();
    f.remote.link = async () => late.promise;
    press(f.page, 'onCopy', f.target);
    f.sessions.completeLogin(f.sessions.beginLogin(), wireCredentials());
    late.resolve(link());
    await flush();
    assert.equal(f.copies.length, 1);
    assert.equal(f.target.data.entry, null);
  } finally {
    f.dispose();
  }
});
test('real shuttle ListItem/Button→Page keeps binding identity, image error/retry, pagination and collapse release', async () => {
  const f = await setup('shuttle');
  try {
    invoke(f.target, 'onToggleGroup', {
      currentTarget: { dataset: { id: 'shuttle' } },
    });
    assert.equal(
      (f.target.data.expandedGroups as Record<string, boolean>).shuttle,
      true,
    );
    const preview = press(f.page, 'onPreview', f.target, { slot });
    await flush();
    assert.deepEqual(preview.dataset, { binding: slot.bindingId });
    let image = f.target.data.image as ReturnType<typeof initialToolImageView>;
    assert.equal(image.status, 'ready');
    assert.equal(image.total, 2);
    assert.equal(image.selected, 0);
    const first = { ...image };
    assert.equal(press(f.page, 'onImagePrevious', f.target).emitted.length, 0);
    press(f.page, 'onImageNext', f.target);
    await flush();
    image = f.target.data.image as typeof image;
    assert.equal(image.selected, 1);
    assert.equal(press(f.page, 'onImageNext', f.target).emitted.length, 0);
    invoke(f.target, 'onImageError', {
      currentTarget: { dataset: { source: first.src, viewId: first.viewId } },
    });
    assert.equal((f.target.data.image as typeof image).status, 'ready');
    invoke(f.target, 'onImageError', {
      currentTarget: { dataset: { source: image.src, viewId: image.viewId } },
    });
    assert.equal((f.target.data.image as typeof image).status, 'unavailable');
    press(f.page, 'onImageRetry', f.target);
    await flush();
    assert.equal((f.target.data.image as typeof image).status, 'ready');
    assert.equal(f.downloads(), 3);
    invoke(f.target, 'onToggleGroup', {
      currentTarget: { dataset: { id: 'shuttle' } },
    });
    await flush();
    assert.equal((f.target.data.image as typeof image).expanded, false);
    assert.equal(f.releases.length, 3);
    preview.call('onPress');
    await flush();
    press(f.page, 'onCloseImage', f.target);
    await flush();
    assert.equal((f.target.data.image as typeof image).src, '');
    invoke(f.target, 'onHide');
    preview.call('onPress');
    await flush();
    assert.equal(
      f.downloads(),
      4,
      'hidden Page has no controller/reader, even if a stale row emits',
    );
  } finally {
    f.dispose();
  }
});
test('real research ListItem→Page cannot open an unknown binding and hide releases owned temporary images', async () => {
  const f = await setup('research');
  try {
    const dataEntry = f.target.data.entry as object;
    press(f.page, 'onPreview', f.target, {
      entry: { ...dataEntry, image: { bindingId: 'unknown' } },
    });
    await flush();
    assert.equal(f.downloads(), 0);
    press(f.page, 'onPreview', f.target);
    await flush();
    assert.equal(f.downloads(), 1);
    invoke(f.target, 'onHide');
    await flush();
    assert.equal(
      (f.target.data.image as ReturnType<typeof initialToolImageView>).src,
      '',
    );
    assert.equal(f.releases.length, 1);
  } finally {
    f.dispose();
  }
});
test('webview stays default-denied; actual refresh→Page admits only the existing trusted port and rejects stale native callbacks', async () => {
  const denied = await setup('web-link');
  try {
    assert.equal(denied.target.data.webviewSrc, '');
    assert.equal(denied.target.data.state, 'webview_unconfigured');
  } finally {
    denied.dispose();
  }
  let admissions = 0;
  const f = await setup('web-link', disabledToolLocation, {
    authorize: async () => {
      admissions++;
      return true;
    },
  });
  try {
    const old = {
      source: f.target.data.webviewSrc,
      viewId: f.target.data.webviewViewId,
    };
    assert.equal(old.source, 'https://tools.example.com/controlled');
    press(f.page, 'onRefresh', f.target);
    await flush();
    assert.equal(admissions, 2);
    assert.notEqual(f.target.data.webviewViewId, old.viewId);
    invoke(f.target, 'onWebviewError', { currentTarget: { dataset: old } });
    assert.equal(f.target.data.webviewSrc, old.source);
    const current = {
      source: f.target.data.webviewSrc,
      viewId: f.target.data.webviewViewId,
    };
    invoke(f.target, 'onWebviewLoad', { currentTarget: { dataset: current } });
    assert.equal(f.target.data.webviewLoaded, true);
    invoke(f.target, 'onWebviewMessage', {
      detail: { data: [{ command: 'copy', url: 'https://untrusted.invalid' }] },
    });
    assert.equal(f.copies.length, 0);
    invoke(f.target, 'onWebviewError', { currentTarget: { dataset: current } });
    assert.equal(f.target.data.webviewSrc, '');
  } finally {
    f.dispose();
  }
});
test('real recovery Button→Page never bypasses recovery, and Back de-duplicates then fences stale fallback after hide', () => {
  const globals = globalThis as unknown as Record<string, unknown>,
    previousApp = globals.getApp,
    previousWx = globals.wx;
  const target = owner('campus-tools-map');
  let guestAllowed = false,
    entries = 0,
    backs = 0,
    relaunches = 0;
  let failBack: (() => void) | undefined;
  globals.getApp = () => ({
    campusTools: {
      scope: new ToolBrowseScope(),
      needsRecovery: () => true,
      continueGuest: () => guestAllowed,
      createReader: () => {
        entries++;
        throw Error('must not create reader during recovery');
      },
    },
  });
  globals.wx = {
    navigateBack: (options: { fail: () => void }) => {
      backs++;
      failBack = options.fail;
    },
    reLaunch: () => {
      relaunches++;
    },
  };
  try {
    target.route = route;
    invoke(target, 'onShow');
    assert.equal(target.data.authRecovery, true);
    assert.equal(entries, 0);
    press('campus-tools-map', 'onContinueGuest', target);
    assert.match(String(target.data.error), /暂时无法确认访客状态/);
    assert.equal(entries, 0);
    guestAllowed = true;
    press('campus-tools-map', 'onContinueGuest', target);
    assert.equal(target.data.authRecovery, true);
    assert.equal(entries, 0);
    const back = press('campus-tools-map', 'onBack', target);
    back.call('onPress');
    assert.equal(backs, 1);
    invoke(target, 'onHide');
    failBack?.();
    assert.equal(relaunches, 0);
    back.hide();
    back.call('onPress');
    assert.equal(backs, 1);
  } finally {
    globals.getApp = previousApp;
    globals.wx = previousWx;
  }
});
