import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openPrimarySiblingTab } from './support/official-account-browser.js';

type Packet = {
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};
type Info = Record<string, unknown>;
type Options = {
  patch?: Info;
  primaryPatch?: Info;
  baselineSibling?: boolean;
  duplicate?: boolean;
  gesture?: unknown;
  windowSession?: string;
  missingWindowOpen?: boolean;
  missingCreated?: boolean;
  delayedTarget?: boolean;
  delayedFragment?: boolean;
  blocked?: boolean;
  evaluateError?: Error;
  listError?: Error;
  closeError?: Error;
  pendingEvaluation?: boolean;
  pendingPreflight?: boolean;
  differentWindow?: boolean;
  missingWindow?: boolean;
  staleSnapshot?: boolean;
};
function fixture(options: Options = {}) {
  const listeners = new Set<(packet: Packet) => void>();
  const calls: {
    method: string;
    params: Record<string, unknown>;
    session: string;
  }[] = [];
  const closed: unknown[] = [];
  const primary: Info = {
    targetId: 'AAA',
    type: 'page',
    url: 'http://private.invalid/operator',
    browserContextId: 'CCC',
    ...options.primaryPatch,
  };
  const unrelated: Info = {
    targetId: 'DDD',
    type: 'page',
    url: 'about:blank',
    browserContextId: 'CCC',
  };
  let lists = 0;
  let url = '';
  let current: Info[] = [];
  let resolveEvaluation: ((value: unknown) => void) | undefined;
  const emit = (packet: Packet) => {
    for (const listener of listeners) listener(packet);
  };
  const target = (targetId = 'BBB'): Info => ({
    targetId,
    type: 'page',
    url,
    openerId: 'AAA',
    browserContextId: 'CCC',
    ...options.patch,
  });
  const report = () => {
    const infos = [target(), ...(options.duplicate ? [target('EEE')] : [])];
    current = infos;
    for (const info of infos) {
      if (!options.missingCreated)
        emit({ method: 'Target.targetCreated', params: { targetInfo: info } });
    }
  };
  const command: Parameters<typeof openPrimarySiblingTab>[0] = async <T>(
    method: string,
    params: object = {},
    session = '',
  ): Promise<T> => {
    const data = params as Record<string, unknown>;
    calls.push({ method, params: data, session });
    if (method === 'Target.setDiscoverTargets') return {} as T;
    if (method === 'Target.getTargetInfo') return { targetInfo: primary } as T;
    if (method === 'Target.getTargets') {
      lists++;
      if (lists === 1 && options.pendingPreflight)
        return await new Promise<T>((resolve) => {
          resolveEvaluation = (value) => resolve(value as T);
        });
      if (lists === 1)
        return {
          targetInfos: [
            primary,
            unrelated,
            ...(options.baselineSibling ? [{ targetId: 'BBB' }] : []),
          ],
        } as T;
      if (options.listError) throw options.listError;
      if (options.staleSnapshot) {
        const newer = target();
        emit({
          method: 'Target.targetInfoChanged',
          params: { targetInfo: newer },
        });
        return {
          targetInfos: [primary, unrelated, { ...newer, url: 'about:blank' }],
        } as T;
      }
      return { targetInfos: [primary, unrelated, ...current] } as T;
    }
    if (method === 'Browser.getWindowForTarget')
      return {
        windowId: options.missingWindow
          ? undefined
          : options.differentWindow && data['targetId'] === 'BBB'
            ? 43
            : 42,
      } as T;
    if (method === 'Runtime.evaluate') {
      assert.ok(listeners.size > 0, 'listeners must exist before the open');
      assert.equal(session, 'PRIMARY');
      assert.equal(data['userGesture'], true);
      assert.equal(data['returnByValue'], true);
      const match = String(data['expression']).match(
        /^window\.open\((".*"), '_blank'\) !== null$/,
      );
      assert.ok(match, 'only a featureless real window.open is accepted');
      url = JSON.parse(match[1]!) as string;
      assert.match(url, /^about:blank#whaleu-visibility-[0-9a-f-]{36}$/);
      if (!options.missingWindowOpen)
        emit({
          method: 'Page.windowOpen',
          sessionId: options.windowSession ?? 'PRIMARY',
          params: {
            url,
            windowName: '_blank',
            userGesture: options.gesture ?? true,
          },
        });
      if (!options.blocked) {
        if (options.delayedTarget) setTimeout(report, 5);
        else if (options.delayedFragment) {
          const initial = { ...target(), url: 'about:blank' };
          current = [initial];
          emit({
            method: 'Target.targetCreated',
            params: { targetInfo: initial },
          });
          setTimeout(() => {
            current = [target()];
            emit({
              method: 'Target.targetInfoChanged',
              params: { targetInfo: current[0] },
            });
          }, 5);
        } else report();
      }
      if (options.evaluateError) throw options.evaluateError;
      if (options.pendingEvaluation)
        return await new Promise<T>((resolve) => {
          resolveEvaluation = (value) => resolve(value as T);
        });
      return { result: { value: !options.blocked } } as T;
    }
    if (method === 'Target.closeTarget') {
      closed.push(data['targetId']);
      if (options.closeError) throw options.closeError;
      return { success: true } as T;
    }
    throw new Error(`Unexpected command: ${method}`);
  };
  return {
    listeners,
    calls,
    closed,
    emit,
    resolveEvaluation: (value: unknown) => resolveEvaluation?.(value),
    run: (budget = 500) =>
      openPrimarySiblingTab(
        command,
        listeners,
        { targetId: 'AAA', sessionId: 'PRIMARY' },
        Date.now() + budget,
      ),
  };
}

test('primary session opens a new owned page without global createTarget or tab substitution', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { targetId: 'BBB' });
  assert.deepEqual(f.closed, []);
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    [
      'Target.setDiscoverTargets',
      'Target.getTargetInfo',
      'Target.getTargets',
      'Runtime.evaluate',
      'Target.getTargets',
      'Browser.getWindowForTarget',
      'Browser.getWindowForTarget',
    ],
  );
  assert.ok(
    f.calls
      .filter((call) => call.method !== 'Runtime.evaluate')
      .every((call) => call.session === ''),
  );
});

test('a target arriving after the evaluate and snapshot responses is still identified, without opening again', async () => {
  const f = fixture({ delayedTarget: true });
  assert.deepEqual(await f.run(), { targetId: 'BBB' });
  assert.equal(
    f.calls.filter((call) => call.method === 'Runtime.evaluate').length,
    1,
  );
  assert.equal(f.listeners.size, 0);
});

test('late fragment commit completes the same created target identity', async () => {
  const f = fixture({ delayedFragment: true });
  assert.deepEqual(await f.run(), { targetId: 'BBB' });
  assert.equal(
    f.calls.filter((call) => call.method === 'Runtime.evaluate').length,
    1,
  );
});

for (const [label, options] of [
  ['preexisting page', { baselineSibling: true }],
  ['different opener', { patch: { openerId: 'DDD' } }],
  ['absent opener', { patch: { openerId: undefined } }],
  ['different context', { patch: { browserContextId: 'FFF' } }],
  ['missing context', { patch: { browserContextId: undefined } }],
  ['non-page wrapper', { patch: { type: 'tab' } }],
  ['invalid target ID', { patch: { targetId: '../unowned' } }],
  ['primary reused as child', { patch: { targetId: 'AAA' } }],
] satisfies [string, Options][]) {
  test(`rejects ${label} without closing unowned targets or trying another candidate`, async () => {
    const f = fixture(options);
    await assert.rejects(f.run(), /newly created by the primary page/);
    assert.deepEqual(f.closed, []);
    assert.equal(
      f.calls.filter((call) => call.method === 'Runtime.evaluate').length,
      1,
    );
    assert.equal(f.listeners.size, 0);
  });
}

test('ambiguous newly owned pages fail closed and close only those owned pages', async () => {
  const f = fixture({ duplicate: true });
  await assert.rejects(f.run(), /identity is ambiguous/);
  assert.deepEqual(f.closed.sort(), ['BBB', 'EEE']);
  assert.equal(f.listeners.size, 0);
});

test('browser-reported gesture is required even when evaluate requested it', async () => {
  const f = fixture({ gesture: false });
  await assert.rejects(f.run(), /browser-reported user gesture/);
  assert.deepEqual(f.closed, ['BBB']);
});

for (const [label, options] of [
  ['missing gesture event', { missingWindowOpen: true }],
  ['gesture in the wrong session', { windowSession: 'OTHER' }],
  ['missing actual target-created event', { missingCreated: true }],
] satisfies [string, Options][]) {
  test(`${label} expires within the supplied original deadline and cleans its owned page`, async () => {
    const f = fixture(options);
    const start = performance.now();
    await assert.rejects(f.run(20), /existing visibility deadline/);
    assert.ok(performance.now() - start < 500);
    assert.deepEqual(f.closed, ['BBB']);
    assert.equal(f.listeners.size, 0);
  });
}

test('blocked creation does not fabricate a page or close existing tabs', async () => {
  const f = fixture({ blocked: true });
  await assert.rejects(f.run(), /did not open the real sibling/);
  assert.deepEqual(f.closed, []);
  assert.equal(f.listeners.size, 0);
});

for (const kind of ['evaluateError', 'listError'] as const) {
  test(`${kind} preserves the original error even when owned cleanup rejects`, async () => {
    const original = new Error('original creation failure');
    const f = fixture({
      [kind]: original,
      closeError: new Error('cleanup failure'),
    });
    await assert.rejects(f.run(), (error) => error === original);
    assert.deepEqual(f.closed, ['BBB']);
    assert.equal(f.listeners.size, 0);
  });
}

test('a pending evaluation expires; its late resolution cannot start more commands', async () => {
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    const f = fixture({ pendingEvaluation: true });
    await assert.rejects(f.run(20), /existing visibility deadline/);
    assert.deepEqual(f.closed, ['BBB']);
    const count = f.calls.length;
    f.resolveEvaluation({ result: { value: true } });
    await delay(10);
    assert.equal(f.calls.length, count);
    assert.equal(f.listeners.size, 0);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('an expired original deadline never starts another open', async () => {
  const f = fixture();
  await assert.rejects(f.run(-1), /existing visibility deadline/);
  assert.ok(!f.calls.some((call) => call.method === 'Runtime.evaluate'));
  assert.deepEqual(f.closed, []);
});

test('invalid primary identity fails before opening', async () => {
  const f = fixture({ primaryPatch: { targetId: 'DDD' } });
  await assert.rejects(f.run(), /Primary browser target identity/);
  assert.ok(!f.calls.some((call) => call.method === 'Runtime.evaluate'));
  assert.deepEqual(f.closed, []);
});

test('newer target-info events are not overwritten by a stale snapshot reply', async () => {
  const f = fixture({ staleSnapshot: true });
  assert.deepEqual(await f.run(), { targetId: 'BBB' });
});

for (const options of [{ differentWindow: true }, { missingWindow: true }]) {
  test(`wrong or unavailable actual window fails and cleans only the owned page: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await assert.rejects(f.run(), /matching browser windows/);
    assert.deepEqual(f.closed, ['BBB']);
    assert.equal(f.listeners.size, 0);
    assert.equal(
      f.calls.filter((call) => call.method === 'Runtime.evaluate').length,
      1,
    );
  });
}

test('missing primary context fails closed before any open', async () => {
  const f = fixture({ primaryPatch: { browserContextId: undefined } });
  await assert.rejects(f.run(), /Primary browser target identity/);
  assert.ok(!f.calls.some((call) => call.method === 'Runtime.evaluate'));
  assert.deepEqual(f.closed, []);
});

test('preflight consumes the same deadline; a late baseline cannot initiate an open', async () => {
  const f = fixture({ pendingPreflight: true });
  await assert.rejects(f.run(20), /existing visibility deadline/);
  const count = f.calls.length;
  f.resolveEvaluation({ targetInfos: [{ targetId: 'AAA' }] });
  await delay(10);
  assert.equal(f.calls.length, count);
  assert.ok(!f.calls.some((call) => call.method === 'Runtime.evaluate'));
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.closed, []);
});
