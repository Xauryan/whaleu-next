import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertSameBrowserWindow } from './support/official-account-browser.js';
import { browserVisibilityDiagnostics } from './support/browser-visibility-diagnostics.js';
const targets = [
  { role: 'primary' as const, targetId: 'AAA', sessionId: 'PRIMARY' },
  { role: 'other' as const, targetId: 'BBB' },
];
function fixture(fail = false) {
  const calls: {
    method: string;
    params: Record<string, unknown>;
    session?: string | undefined;
  }[] = [];
  const lines: string[] = [];
  let time = 0;
  const command = async <T>(
    method: string,
    params: object = {},
    session?: string,
  ): Promise<T> => {
    calls.push({ method, params: params as Record<string, unknown>, session });
    if (fail) throw new Error('SECRET unavailable');
    if (method === 'Target.getTargetInfo')
      return {
        targetInfo: {
          targetId: (params as { targetId: string }).targetId,
          browserContextId: 'CCC',
          url: 'SECRET',
        },
      } as T;
    if (method === 'Browser.getWindowForTarget') return { windowId: 1 } as T;
    if (method === 'Target.attachToTarget') return { sessionId: 'OTHER' } as T;
    if (method === 'Runtime.evaluate')
      return {
        result: {
          value: {
            hidden: false,
            visibilityState: 'visible',
            hasFocus: true,
            readyState: 'complete',
            secret: 'SECRET',
          },
        },
      } as T;
    return {} as T;
  };
  return {
    calls,
    lines,
    command,
    diagnostics: browserVisibilityDiagnostics(
      command,
      (line) => lines.push(line),
      () => time++,
    ),
  };
}
test('metadata capture uses explicit target sessions and bounded safe fields', async () => {
  const f = fixture();
  for (let i = 0; i < 50; i++)
    f.diagnostics.record({
      method: 'Target.targetInfoChanged',
      params: {
        targetInfo: { targetId: 'AAA', url: 'SECRET', title: 'SECRET' },
      },
    });
  await f.diagnostics.capture('before-background', targets);
  const data = JSON.parse(f.lines[0]!.slice('[browser-visibility] '.length));
  assert.equal(data.events.length, 16);
  assert.equal(data.targets.length, 2);
  assert.deepEqual(
    data.targets.map((x: Record<string, unknown>) => [
      x['targetVerified'],
      x['browserContextId'],
      x['windowId'],
    ]),
    [
      [true, 'CCC', 1],
      [true, 'CCC', 1],
    ],
  );
  assert.deepEqual(
    f.calls
      .filter((x) => x.method === 'Runtime.evaluate')
      .map((x) => x.session),
    ['PRIMARY', 'OTHER'],
  );
  assert.equal(
    f.calls.filter((x) => x.method === 'Target.attachToTarget').length,
    1,
  );
  assert.deepEqual(f.calls.at(-1), {
    method: 'Target.detachFromTarget',
    params: { sessionId: 'OTHER' },
    session: '',
  });
  assert.ok(!f.lines.join('').includes('SECRET'));
  assert.ok(
    data.events.every(
      (x: { ms: number }, i: number, a: { ms: number }[]) =>
        i === 0 || x.ms >= a[i - 1]!.ms,
    ),
  );
});
test('original action order and thrown object survive unavailable diagnostics', async () => {
  const f = fixture(true);
  const actions: string[] = [];
  const original = new Error('original 15-second visibility failure');
  await f.diagnostics.enable();
  await assert.rejects(
    f.diagnostics.around('background', targets, async () => {
      actions.push('activate-other');
      actions.push('until-hidden');
      throw original;
    }),
    (e) => e === original,
  );
  assert.deepEqual(actions, ['activate-other', 'until-hidden']);
  assert.match(f.lines.join(''), /background-failed/);
  assert.match(f.lines.join(''), /"supported":false/);
  assert.ok(!f.lines.join('').includes('SECRET'));
});
test('successful original action is unchanged by diagnostic write failure', async () => {
  const f = fixture();
  const diagnostics = browserVisibilityDiagnostics(f.command, () => {
    throw new Error('sink unavailable');
  });
  const actions: string[] = [];
  await diagnostics.around('foreground', targets, async () => {
    actions.push('activate-primary', 'close-other', 'until-visible');
  });
  assert.deepEqual(actions, [
    'activate-primary',
    'close-other',
    'until-visible',
  ]);
});
test('helper requires a real sibling tab while retaining deadline and security flags', async () => {
  const source = await readFile(
    new URL('./support/official-account-browser.ts', import.meta.url),
    'utf8',
  );
  const background = source.slice(
    source.indexOf('      background: async () => {'),
  );
  const commands = [
    ...background.matchAll(
      /'Target\.(createTarget|activateTarget|closeTarget)'/g,
    ),
  ].map((x) => x[1]);
  assert.deepEqual(commands, [
    'activateTarget',
    'closeTarget',
    'activateTarget',
    'activateTarget',
  ]);
  assert.match(background, /openPrimarySiblingTab\(\s*command,\s*listeners,/);
  assert.ok(!background.includes("'Target.createTarget'"));
  assert.match(source, /userGesture: true/);
  assert.match(source, /window\.open\(/);
  assert.match(
    background,
    /assertSameBrowserWindow\(\s*primaryWindow\.windowId,\s*otherWindow\.windowId,?\s*\)/,
  );
  assert.ok(
    background.indexOf('assertSameBrowserWindow(') <
      background.indexOf("visibility.mark('background-activate-start')"),
  );
  assert.match(background, /await closeOther\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(source, /const deadline = Date\.now\(\) \+ 15000/);
  assert.match(
    background,
    /await until\(\s*'document.hidden',\s*'real tab background visibility',\s*deadline,?\s*\)/,
  );
  assert.match(
    background,
    /await until\('!document.hidden', 'real tab foreground visibility'\)/,
  );
  assert.ok(!source.includes("'--no-sandbox'"));
  const diagnostic = await readFile(
    new URL('./support/browser-visibility-diagnostics.ts', import.meta.url),
    'utf8',
  );
  for (const forbidden of [
    'Object.defineProperty',
    'dispatchEvent',
    'setWebLifecycleState',
    'setFocusEmulationEnabled',
    '--disable-setuid-sandbox',
  ])
    for (const text of [diagnostic, source])
      assert.ok(!text.includes(forbidden));
  assert.equal([...diagnostic.matchAll(/Runtime.evaluate/g)].length, 1);
});

test('never-completing diagnostics have one small capture budget and preserve original failure', async () => {
  const calls: string[] = [],
    lines: string[] = [];
  const command = <T>(method: string): Promise<T> => {
    calls.push(method);
    return new Promise(() => {});
  };
  const diagnostics = browserVisibilityDiagnostics(
    command,
    (line) => lines.push(line),
    undefined,
    15,
  );
  const original = new Error('original visibility assertion');
  let actions = 0;
  const start = performance.now();
  await assert.rejects(
    diagnostics.around('background', targets, async () => {
      actions++;
      throw original;
    }),
    (error) => error === original,
  );
  assert.equal(actions, 1);
  assert.ok(
    performance.now() - start < 500,
    'two captures must not wait on underlying 15-second transport deadlines',
  );
  assert.deepEqual(calls, ['Target.getTargetInfo', 'Target.getTargetInfo']);
  assert.equal(lines.length, 2);
  assert.ok(
    lines.every(
      (line) =>
        JSON.parse(line.slice('[browser-visibility] '.length)).budgetExhausted,
    ),
  );
});

test('late attachment is detached exactly once without late evaluation or unhandled rejection', async () => {
  const calls: string[] = [],
    unhandled: unknown[] = [];
  let resolveAttach!: (value: { sessionId: string }) => void;
  const listener = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    const command = async <T>(method: string): Promise<T> => {
      calls.push(method);
      if (method === 'Target.attachToTarget')
        return (await new Promise<{ sessionId: string }>((resolve) => {
          resolveAttach = resolve;
        })) as T;
      if (method === 'Target.detachFromTarget')
        throw new Error('SECRET late detach failure');
      return {} as T;
    };
    const diagnostics = browserVisibilityDiagnostics(
      command,
      () => {
        throw new Error('sink failed');
      },
      undefined,
      15,
    );
    await diagnostics.capture('background-failed', [targets[1]!]);
    assert.equal(calls.at(-1), 'Target.attachToTarget');
    resolveAttach({ sessionId: 'LATE' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      calls.filter((x) => x === 'Target.detachFromTarget').length,
      1,
    );
    assert.ok(!calls.includes('Runtime.evaluate'));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('late rejected observations are consumed and discovery is also bounded', async () => {
  let reject!: (error: Error) => void;
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    const command = <T>(): Promise<T> =>
      new Promise((_, fail) => {
        reject = fail;
      });
    const lines: string[] = [];
    const diagnostics = browserVisibilityDiagnostics(
      command,
      (line) => lines.push(line),
      undefined,
      15,
    );
    await diagnostics.enable();
    reject(new Error('SECRET late failure'));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(unhandled, []);
    assert.match(lines.join(''), /"supported":false/);
    assert.ok(!lines.join('').includes('SECRET'));
  } finally {
    process.off('unhandledRejection', listener);
  }
});

test('real sibling tab guard rejects mismatched or unavailable window identity', () => {
  assert.doesNotThrow(() => assertSameBrowserWindow(42, 42));
  for (const [primary, other] of [
    [42, 43],
    [42, undefined],
    [undefined, 42],
    [undefined, undefined],
    [null, null],
    ['42', '42'],
    [-1, -1],
    [NaN, NaN],
    [1.5, 1.5],
  ]) {
    assert.throws(
      () => assertSameBrowserWindow(primary, other),
      /Real tab visibility requires matching browser windows/,
    );
  }
  assert.throws(() => assertSameBrowserWindow(42, 43), /primary=42, other=43/);
  assert.throws(
    () => assertSameBrowserWindow(42, undefined),
    /primary=42, other=unavailable/,
  );
});
