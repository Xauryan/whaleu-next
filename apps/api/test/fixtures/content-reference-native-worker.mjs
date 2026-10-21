/** Actual emitted native Page + reference Component -> authenticated loopback HTTP.
 * No source fallback, response fixtures, viewport evidence or Tencent rendering.
 * The owning test supplies only synthetic credentials and already published IDs.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const {
  NativeExperienceTransport,
  nativeOrigin,
} = require('../support/experience-native-bridge.ts');
const dist = fileURLToPath(new URL('../../../wechat/dist/', import.meta.url));
const referenceBase = '/v1/community/content-references';
const moduleAt = (name) => {
  const file = path.join(dist, `${name}.js`);
  assert.ok(
    existsSync(file),
    `Missing emitted native module: ${name}; build before this suite`,
  );
  return require(file);
};
async function bounded(promise, label, ms = 12000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Native reference deadline: ${label}`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(check, label) {
  const deadline = Date.now() + 12000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      `Native reference did not settle: ${label}`,
    );
    await delay(5);
  }
}
function journey(input) {
  const { SessionStore } = moduleAt('auth/session');
  const { ApiClient } = moduleAt('api/client');
  const { createCommunityRuntime } = moduleAt('community/runtime');
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), input.credentials);
  const transport = new NativeExperienceTransport(input.port);
  let active = 0;
  const send = transport.send.bind(transport);
  transport.send = async (request) => {
    active++;
    try {
      return await send(request);
    } finally {
      active--;
    }
  };
  const api = new ApiClient(
    nativeOrigin,
    transport,
    sessions,
    {
      refresh: async () => {
        throw new Error('Fixture credentials unexpectedly expired');
      },
    },
    6000,
  );
  const storage = new Map(),
    navigations = [],
    mounted = new Set();
  const previous = Object.fromEntries(
    ['wx', 'getApp', 'Page', 'Component'].map((key) => [key, globalThis[key]]),
  );
  globalThis.wx = {
    getStorageSync: (key) => structuredClone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key) => storage.delete(key),
    nextTick: (callback) => callback(),
    navigateTo(options) {
      navigations.push(options.url);
      options.success();
    },
    login() {
      throw new Error('Reference read must not initiate provider login');
    },
    request() {
      throw new Error(
        'All native API requests must use the verified loopback transport',
      );
    },
    getRandomValues() {
      throw new Error('Reference read must not create a mutation identity');
    },
    setClipboardData() {
      throw new Error(
        'Reference selection must not write clipboard automatically',
      );
    },
  };
  const identity = { sessions, api };
  const app = {
    identity,
    community: createCommunityRuntime(identity, globalThis.wx, nativeOrigin),
  };
  globalThis.getApp = () => app;
  const pageFile = path.join(dist, 'pages/community-detail/community-detail');
  const wxml = readFileSync(`${pageFile}.wxml`, 'utf8');
  const config = JSON.parse(readFileSync(`${pageFile}.json`, 'utf8'));
  assert.equal(
    config.usingComponents['wu-reference-text'],
    '../../components/reference-text/reference-text',
  );
  const host = [...wxml.matchAll(/<wu-reference-text\s[^>]+\/>/g)]
    .map((match) => match[0])
    .find((tag) => tag.includes('source="{{post.text}}"'));
  assert.ok(
    host,
    'Actual emitted Page must bind the source post through reference-text',
  );
  const referenceHandler = /bind:referencepress="([^"]+)"/.exec(host)?.[1];
  assert.equal(referenceHandler, 'onReferencePress');
  assert.ok(host.includes('row-key="{{\'post:\' + post.id}}"'));
  let componentDefinition;
  globalThis.Component = (value) => {
    componentDefinition = value;
  };
  const componentFile = path.join(
    dist,
    'components/reference-text/reference-text.js',
  );
  delete require.cache[require.resolve(componentFile)];
  require(componentFile);
  assert.ok(componentDefinition, 'Actual emitted Component registration');
  const componentWxml = readFileSync(
    componentFile.replace(/\.js$/, '.wxml'),
    'utf8',
  );
  assert.match(componentWxml, /catchtap="onTap"/);
  assert.match(componentWxml, /bindlongpress="onLongPress"/);
  assert.match(componentWxml, /selectable="\{\{true\}\}"/);
  function mount(query) {
    let definition;
    globalThis.Page = (value) => {
      definition = value;
    };
    const entry = `${pageFile}.js`;
    delete require.cache[require.resolve(entry)];
    require(entry);
    assert.ok(definition, 'Actual emitted detail Page registration');
    const controls = new Set();
    let visible = true;
    const page = {
      ...definition,
      data: structuredClone(definition.data),
      setData(patch, callback) {
        Object.assign(this.data, structuredClone(patch));
        for (const control of controls) control.sync();
        callback?.();
      },
    };
    const props = () => ({
      source: page.data.post?.text ?? '',
      available: page.data.references.available,
      rowKey: `post:${page.data.post?.id ?? ''}`,
      generation: page.data.references.generation,
      disabled:
        page.data.busy ||
        page.data.needsReload ||
        page.data.references.busy ||
        page.data.block.busy ||
        page.data.block.frozen ||
        page.data.report.busy ||
        page.data.report.frozen ||
        page.data.interaction.busy ||
        page.data.interaction.frozen,
    });
    const handle = {
      page,
      async idle(expected = true) {
        await until(
          () => !page.data.busy && (page.data.loaded || !!page.data.error),
          'real detail read',
        );
        assert.equal(
          page.data.loaded,
          expected,
          `Real native detail outcome: ${page.data.error || page.data.status}`,
        );
        await until(() => active === 0, 'all page-owned HTTP');
        await delay(20);
        await until(() => active === 0, 'final page-owned HTTP');
      },
      capture() {
        const events = [];
        const instance = {
          properties: {
            ...Object.fromEntries(
              Object.entries(componentDefinition.properties).map(
                ([key, schema]) => [key, schema.value],
              ),
            ),
            ...props(),
          },
          data: structuredClone(componentDefinition.data),
          setData(value) {
            Object.assign(this.data, structuredClone(value));
          },
          triggerEvent(name, detail, options) {
            events.push({ name, detail: structuredClone(detail), options });
            assert.deepEqual(options, { bubbles: false, composed: false });
            if (name === 'referencepress') page[referenceHandler]({ detail });
            else throw new Error('Post source must not open a fallback thread');
          },
        };
        for (const [key, method] of Object.entries(componentDefinition.methods))
          instance[key] = method.bind(instance);
        const control = {
          instance,
          events,
          sync() {
            const next = props();
            if (
              Object.entries(next).some(
                ([key, value]) => instance.properties[key] !== value,
              )
            ) {
              Object.assign(instance.properties, next);
              componentDefinition.observers[
                'source, available, rowKey, generation, disabled'
              ].call(instance);
            }
          },
          event(code) {
            const index = instance.data.segments.findIndex(
              (segment) => segment.code === code,
            );
            assert.ok(
              index >= 0,
              'Real source must contain the requested parsed code',
            );
            return {
              currentTarget: {
                dataset: { revision: instance.data.revision, index },
              },
            };
          },
          tap(
            code,
            { longpress = false, cancel = false, synthesized = false } = {},
          ) {
            const event = this.event(code);
            if (!synthesized) instance.onStart(event);
            if (longpress) instance.onLongPress(event);
            if (cancel) instance.onCancel(event);
            instance.onTap(event);
          },
          hide() {
            componentDefinition.pageLifetimes.hide.call(instance);
          },
          detach() {
            componentDefinition.lifetimes.detached.call(instance);
            controls.delete(control);
          },
        };
        componentDefinition.lifetimes.attached.call(instance);
        controls.add(control);
        return control;
      },
      hide() {
        if (!visible) return;
        visible = false;
        for (const control of controls) control.hide();
        page.onHide();
      },
      show() {
        visible = true;
        for (const control of controls)
          componentDefinition.pageLifetimes.show.call(control.instance);
        page.onShow();
      },
      unload() {
        for (const control of [...controls]) control.detach();
        page.onUnload();
        mounted.delete(handle);
      },
    };
    mounted.add(handle);
    page.onLoad(query);
    page.onShow();
    return handle;
  }
  return {
    sessions,
    transport,
    navigations,
    mount,
    app,
    async settle() {
      await until(() => active === 0, 'pending HTTP after cancellation');
      await delay(20);
    },
    close() {
      for (const handle of [...mounted]) handle.unload();
      app.community.views?.dispose();
      app.community.privateViews.clear();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}
process.once('message', async (input) => {
  let j;
  try {
    assert.ok(['inactive', 'ready'].includes(input.phase));
    assert.ok(
      Number.isInteger(input.port) && input.port > 0 && input.port < 65536,
    );
    j = journey(input);
    let source = j.mount({
      postId: input.sourcePostId,
      viewSpaceId: input.viewSpaceId,
    });
    await source.idle();
    assert.equal(source.page.data.post.id, input.sourcePostId);
    const control = source.capture();
    assert.ok(
      control.instance.data.segments.map((segment) => segment.text).join('') ===
        source.page.data.post.text,
      'Native source reconstruction must be byte-exact',
    );
    const refs = () =>
      j.transport.exchanges.filter((exchange) =>
        exchange.path.startsWith(referenceBase),
      );
    assert.ok(
      refs().some(
        (exchange) =>
          exchange.path.startsWith(`${referenceBase}/capability`) &&
          exchange.status === 200,
      ),
    );
    if (input.phase === 'inactive') {
      assert.equal(source.page.data.references.available, false);
      assert.deepEqual(source.page.data.references.codes, {});
      assert.equal(control.instance.data.segments.length, 1);
      assert.equal(control.instance.data.segments[0].kind, 'text');
      control.instance.onTap({
        currentTarget: {
          dataset: { revision: control.instance.data.revision, index: 0 },
        },
      });
      await j.settle();
      assert.equal(j.navigations.length, 0);
      assert.ok(refs().every((exchange) => exchange.method === 'GET'));
    } else {
      assert.equal(source.page.data.references.available, true);
      assert.equal(
        source.page.data.references.codes[`post:${input.sourcePostId}`],
        input.sourceCode,
      );
      assert.ok(
        refs().some(
          (exchange) =>
            exchange.path.startsWith(`${referenceBase}/lookup`) &&
            exchange.status === 200,
        ),
      );
      const first = input.targets[0];
      const before = refs().length;
      control.tap(first.code, { longpress: true });
      control.tap(first.code, { cancel: true });
      await j.settle();
      assert.equal(refs().length, before);
      assert.equal(j.navigations.length, 0);
      control.detach();
      for (const target of input.targets) {
        const c = source.capture(),
          prior = j.navigations.length;
        c.tap(target.code, { synthesized: true });
        await until(
          () => j.navigations.length === prior + 1,
          `fresh ${target.kind} resolve`,
        );
        const navigation = new URL(
          j.navigations.at(-1),
          'https://native-navigation.invalid',
        );
        assert.equal(
          navigation.pathname,
          '/pages/community-detail/community-detail',
        );
        const expected = {
          postId: target.postId,
          ...(target.rootCommentId
            ? { rootCommentId: target.rootCommentId }
            : {}),
          ...(target.replyId ? { replyId: target.replyId } : {}),
          viewSpaceId: input.viewSpaceId,
        };
        assert.deepEqual(Object.fromEntries(navigation.searchParams), expected);
        source.hide();
        c.detach();
        const destination = j.mount(expected);
        await destination.idle();
        assert.equal(destination.page.data.post.id, target.postId);
        assert.equal(
          destination.page.data.locatedComment?.id ?? null,
          target.rootCommentId ?? null,
        );
        assert.equal(
          destination.page.data.locatedReply?.id ?? null,
          target.replyId ?? null,
        );
        destination.unload();
        source.show();
        await source.idle();
        assert.equal(
          source.page.data.post.id,
          input.sourcePostId,
          'Returning rereads original source without retargeting',
        );
      }
      // The same code is independently resolved again; no positive authority cache.
      assert.equal(
        refs().filter((exchange) =>
          exchange.path.startsWith(`${referenceBase}/resolve`),
        ).length,
        input.targets.length,
      );
      for (const boundary of ['hide', 'logout']) {
        const c = source.capture(),
          gate = j.transport.holdNext(`${referenceBase}/resolve`, 'POST');
        const beforeNavigation = j.navigations.length;
        c.tap(first.code);
        await bounded(gate.arrived, `${boundary} resolve receipt`);
        if (boundary === 'hide') source.hide();
        else j.sessions.logout();
        gate.release();
        await j.settle();
        assert.equal(
          j.navigations.length,
          beforeNavigation,
          `Late ${boundary} resolve must not navigate`,
        );
        assert.equal(source.page.data.references.available, false);
        assert.deepEqual(source.page.data.references.codes, {});
        c.detach();
        source.unload();
        if (boundary === 'hide') {
          source = j.mount({
            postId: input.sourcePostId,
            viewSpaceId: input.viewSpaceId,
          });
          await source.idle();
        }
      }
      assert.ok(
        j.transport.exchanges.some(
          (exchange) =>
            exchange.path.includes('/discussion-context') &&
            exchange.status === 200,
        ),
        'Destination root/reply context must be reread from real API',
      );
    }
    assert.ok(
      refs().every((exchange) => exchange.authorized),
      'Every reference route must authenticate',
    );
    assert.ok(
      j.transport.exchanges.every(
        (exchange) =>
          exchange.method === 'GET' ||
          (exchange.method === 'POST' &&
            [`${referenceBase}/lookup`, `${referenceBase}/resolve`].some(
              (route) => exchange.path.split('?')[0] === route,
            )),
      ),
      'Renderer/navigation must not send mutations, view receipts or notification acknowledgments',
    );
    const report = {
      event: 'done',
      phase: input.phase,
      referenceRequests: refs().length,
      navigations: j.navigations.length,
    };
    j.close();
    j = undefined;
    process.send?.(report, () => process.disconnect());
  } catch (error) {
    j?.close();
    process.exitCode = 1;
    process.send?.(
      {
        event: 'failure',
        message: error instanceof Error ? error.stack : String(error),
      },
      () => process.disconnect(),
    );
  }
});
