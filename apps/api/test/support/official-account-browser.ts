/** Real Chromium/CDP transport. No browser, DOM, fetch or application mocks.
 * CI must install the exact official runtime below; absence/version drift FAILS
 * this gate (never a skipped successful journey). Installation is not done here.
 */
import assert from 'node:assert/strict';
import { browserVisibilityDiagnostics } from './browser-visibility-diagnostics.js';
import {
  browserDiagnostics,
  browserProcessClosed,
  removeBrowserProfile,
} from './browser-test-diagnostics.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
export const officialBrowserVersion =
  process.env['WHALEU_OFFICIAL_BROWSER_PROFILE'] === 'local-chromium-154'
    ? 'explicit local Chromium 154 diagnostic'
    : 'playwright-core 1.58.2 pinned Chromium';
const require = createRequire(import.meta.url);
async function runtime() {
  const profile =
    process.env['WHALEU_OFFICIAL_BROWSER_PROFILE'] ?? 'playwright-core-1.58.2';
  const explicit = process.env['WHALEU_OFFICIAL_BROWSER_BINARY'];
  if (profile === 'local-chromium-154') {
    assert.equal(
      explicit,
      '/usr/bin/chromium',
      'Local system runtime requires explicit named binary/profile',
    );
    assert.ok(
      !process.env['CI'],
      'System Chromium local profile is forbidden in CI',
    );
    return { binary: '/usr/bin/chromium', expected: '154.0.8037.57', profile };
  }
  assert.equal(profile, 'playwright-core-1.58.2', 'Unknown browser profile');
  const root = dirname(require.resolve('playwright-core/package.json'));
  const pkg = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ) as { version: string };
  assert.equal(
    pkg.version,
    '1.58.2',
    'Browser package must match package-lock pin',
  );
  const manifest = JSON.parse(
    await readFile(join(root, 'browsers.json'), 'utf8'),
  ) as {
    browsers: { name: string; browserVersion?: string; revision: string }[];
  };
  const chromium = manifest.browsers.find(
    (browser) => browser.name === 'chromium',
  );
  assert.ok(
    chromium?.browserVersion,
    'Pinned package must describe Chromium exact version',
  );
  const installed = require('playwright-core') as {
    chromium: { executablePath(): string };
  };
  return {
    binary: explicit ?? installed.chromium.executablePath(),
    expected: chromium.browserVersion,
    profile: `${profile}/revision-${chromium.revision}`,
  };
}
interface Packet {
  id?: number;
  result?: unknown;
  error?: { message: string };
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}
type Command = <T = Record<string, unknown>>(
  method: string,
  params?: object,
  session?: string,
) => Promise<T>;
type TargetInfo = {
  targetId?: unknown;
  type?: unknown;
  url?: unknown;
  openerId?: unknown;
  browserContextId?: unknown;
};
/** Open through the actual primary page, not global last-active-window order.
 * The marker never leaves about:blank; no application state or visibility is
 * patched. The browser must report the user gesture and a newly owned page. */
export async function openPrimarySiblingTab(
  command: Command,
  listeners: Set<(packet: Packet) => void>,
  primary: { targetId: string; sessionId: string },
  deadline: number,
  visibility?: Pick<ReturnType<typeof browserVisibilityDiagnostics>, 'capture'>,
) {
  let primaryInfo: TargetInfo | undefined;
  const baseline = new Set<unknown>();
  const url = `about:blank#whaleu-visibility-${randomUUID()}`;
  const created = new Set<string>();
  const observed = new Map<unknown, TargetInfo>();
  const eventRevisions = new Map<unknown, number>();
  let eventRevision = 0;
  const owned = new Set<string>();
  const windowOpens: boolean[] = [];
  const closing = new Map<string, Promise<void>>();
  let failing = false;
  let active = true;
  let changed: (() => void) | undefined;
  const signal = () => {
    changed?.();
    changed = undefined;
  };
  const expired = new Error(
    'Real sibling tab creation exceeded the existing visibility deadline',
  );
  const requireActive = () => {
    if (!active || Date.now() >= deadline) throw expired;
  };
  const closeOwned = (targetId: string) => {
    let pending = closing.get(targetId);
    if (!pending) {
      pending = command('Target.closeTarget', { targetId }, '')
        .then(() => {})
        .catch(() => {});
      closing.set(targetId, pending);
    }
    return pending;
  };
  const isOwned = (info: TargetInfo) =>
    typeof info.targetId === 'string' &&
    /^[a-fA-F0-9]{1,64}$/.test(info.targetId) &&
    !baseline.has(info.targetId) &&
    info.type === 'page' &&
    info.url === url &&
    info.openerId === primary.targetId &&
    !!primaryInfo &&
    info.browserContextId === primaryInfo.browserContextId;
  const rememberOwned = (info: TargetInfo) => {
    observed.set(info.targetId, info);
    if (isOwned(info) && typeof info.targetId === 'string') {
      owned.add(info.targetId);
      if (failing) void closeOwned(info.targetId);
    }
  };
  const record = (packet: Packet) => {
    if (
      packet.method === 'Page.windowOpen' &&
      packet.sessionId === primary.sessionId &&
      packet.params?.['url'] === url &&
      packet.params?.['windowName'] === '_blank'
    )
      windowOpens.push(packet.params['userGesture'] === true);
    if (
      !packet.sessionId &&
      ['Target.targetCreated', 'Target.targetInfoChanged'].includes(
        packet.method ?? '',
      )
    ) {
      const info = packet.params?.['targetInfo'] as TargetInfo | undefined;
      if (!info) return;
      if (
        packet.method === 'Target.targetCreated' &&
        typeof info.targetId === 'string' &&
        !baseline.has(info.targetId)
      )
        created.add(info.targetId);
      eventRevisions.set(info.targetId, ++eventRevision);
      rememberOwned(info);
    }
    signal();
  };
  let timer: NodeJS.Timeout | undefined;
  const expiration = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        active = false;
        signal();
        reject(expired);
      },
      Math.max(0, Math.min(15000, deadline - Date.now())),
    );
  });
  const open = async () => {
    requireActive();
    // Discovery is required for identity proof, unlike best-effort diagnostics.
    await command('Target.setDiscoverTargets', { discover: true }, '');
    requireActive();
    const primaryAnswer = await command<{
      targetInfo?: TargetInfo;
    }>('Target.getTargetInfo', { targetId: primary.targetId }, '');
    requireActive();
    primaryInfo = primaryAnswer.targetInfo;
    assert.ok(
      primaryInfo?.targetId === primary.targetId &&
        primaryInfo.type === 'page' &&
        typeof primaryInfo.browserContextId === 'string' &&
        primaryInfo.browserContextId.length > 0,
      'Primary browser target identity is unavailable',
    );
    const before = await command<{ targetInfos?: TargetInfo[] }>(
      'Target.getTargets',
      {},
      '',
    );
    requireActive();
    assert.ok(
      Array.isArray(before.targetInfos),
      'Browser target list unavailable',
    );
    for (const info of before.targetInfos) baseline.add(info.targetId);
    assert.ok(
      baseline.has(primary.targetId),
      'Primary browser target is not live',
    );
    // Observe before initiating the open: creation can precede its response.
    listeners.add(record);
    const answer = await command<{
      result?: { value?: unknown };
      exceptionDetails?: unknown;
    }>(
      'Runtime.evaluate',
      {
        expression: `window.open(${JSON.stringify(url)}, '_blank') !== null`,
        userGesture: true,
        awaitPromise: true,
        returnByValue: true,
      },
      primary.sessionId,
    );
    requireActive();
    assert.ok(
      !answer.exceptionDetails && answer.result?.value === true,
      'Primary page did not open the real sibling tab',
    );
    // Reconcile the authoritative list after the open, never pick a preexisting
    // tab or substitute a candidate after identity/window validation fails.
    const snapshotRevision = eventRevision;
    const after = await command<{ targetInfos?: TargetInfo[] }>(
      'Target.getTargets',
      {},
      '',
    );
    requireActive();
    assert.ok(
      Array.isArray(after.targetInfos),
      'Browser target list unavailable',
    );
    for (const info of after.targetInfos) {
      // A snapshot response must not overwrite a newer target-info event.
      if ((eventRevisions.get(info.targetId) ?? 0) <= snapshotRevision)
        rememberOwned(info);
    }
    // about:blank's fragment navigation can commit after window.open returns.
    // Wait for the same owned target's facts, never open again or choose an
    // alternate candidate. This shares the original hidden-state deadline.
    for (;;) {
      requireActive();
      const matches = [...observed.values()].filter((info) => info.url === url);
      assert.ok(matches.length <= 1, 'Real sibling tab identity is ambiguous');
      if (matches.length === 1) {
        const other = matches[0]!;
        assert.ok(
          typeof other.targetId === 'string' && isOwned(other),
          'Real sibling tab must be newly created by the primary page in its context',
        );
        if (windowOpens.length) {
          assert.deepEqual(
            windowOpens,
            [true],
            'Real sibling tab requires one primary-page browser-reported user gesture',
          );
          if (created.has(other.targetId)) {
            const primaryWindow = await command<{ windowId?: unknown }>(
              'Browser.getWindowForTarget',
              { targetId: primary.targetId },
              '',
            );
            requireActive();
            const otherWindow = await command<{ windowId?: unknown }>(
              'Browser.getWindowForTarget',
              { targetId: other.targetId },
              '',
            );
            requireActive();
            assertSameBrowserWindow(
              primaryWindow.windowId,
              otherWindow.windowId,
            );
            return { targetId: other.targetId };
          }
        }
      }
      await new Promise<void>((resolve) => {
        changed = resolve;
      });
    }
  };
  try {
    return await Promise.race([open(), expiration]);
  } catch (error) {
    active = false;
    signal();
    failing = true;
    // Capture only bounded safe target/context/window fields, before cleanup.
    // The actual version is already recorded at browser startup.
    if (visibility) {
      const matching = [...observed.values()].find(
        (info) => info.url === url && typeof info.targetId === 'string',
      );
      await visibility
        .capture('background-failed', [
          { role: 'primary', ...primary },
          ...(matching && typeof matching.targetId === 'string'
            ? [{ role: 'other' as const, targetId: matching.targetId }]
            : []),
        ])
        .catch(() => {});
    }
    await Promise.all([...owned].map(closeOwned));
    throw error;
  } finally {
    active = false;
    signal();
    clearTimeout(timer);
    listeners.delete(record);
  }
}
/** Consume late replies while preserving the original visibility deadline. */
function beforeVisibilityDeadline<T>(
  operation: () => Promise<T>,
  deadline: number,
  message: string,
): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error(message));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), remaining);
    Promise.resolve()
      .then(() => {
        if (Date.now() >= deadline) throw new Error(message);
        return operation();
      })
      .then(
        (value) => {
          clearTimeout(timer);
          if (Date.now() >= deadline) reject(new Error(message));
          else resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}
/** Fail closed: shared storage context does not imply a shared tab strip. */
export function assertSameBrowserWindow(primary: unknown, other: unknown) {
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  assert.ok(
    valid(primary) && valid(other) && primary === other,
    `Real tab visibility requires matching browser windows: primary=${valid(primary) ? primary : 'unavailable'}, other=${valid(other) ? other : 'unavailable'}`,
  );
}
export async function officialBrowser() {
  const diagnostics = browserDiagnostics();
  const selected = await runtime();
  let helper: string | undefined;
  if (
    process.env['CI'] ||
    process.env['WHALEU_OFFICIAL_SANDBOX_HELPER'] ||
    process.env['WHALEU_OFFICIAL_BROWSER_SANDBOX']
  ) {
    const verifier =
      require('../../../../scripts/official-browser-sandbox.mjs') as {
        verifyOfficialBrowserSandbox(): Promise<string | undefined>;
      };
    helper = await verifier.verifyOfficialBrowserSandbox();
  }
  const directory = await mkdtemp(join(tmpdir(), 'official-browser-'));
  const child = spawn(
    selected.binary,
    [
      '--headless=new',
      '--remote-debugging-pipe',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      '--disable-default-apps',
      '--metrics-recording-only',
      `--user-data-dir=${directory}`,
      'about:blank',
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: helper
        ? { ...process.env, CHROME_DEVEL_SANDBOX: helper }
        : process.env,
    },
  );
  const closed = browserProcessClosed(child);
  // Do not disable Chromium's sandbox. The dedicated CI job needs a supported
  // non-root user / sandbox setup, not a silent --no-sandbox fallback.
  let serial = 0,
    buffer = '',
    sessionId = '',
    stopped = false;
  const listeners = new Set<(packet: Packet) => void>();
  const waiting = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  const fail = (error: Error) => {
    for (const item of waiting.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    waiting.clear();
  };
  (child.stdio[3] as Writable).on('error', fail);
  (child.stdio[4] as Readable).on('error', fail);
  let startupStderr = '';
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    startupStderr = (startupStderr + chunk).slice(-8192);
  });
  child.on('error', () => {
    stopped = true;
    fail(new Error('Pinned Chromium unavailable: operator journey NOT RUN'));
  });
  child.on('exit', (code, signal) => {
    console.log(
      '[browser-cleanup] chromium-exit',
      JSON.stringify({ code, signal }),
    );
    stopped = true;
    fail(new Error('Chromium exited before CDP completed'));
  });
  (child.stdio[4] as Readable)
    .setEncoding('utf8')
    .on('data', (chunk: string) => {
      buffer += chunk;
      for (
        let end = buffer.indexOf('\0');
        end >= 0;
        end = buffer.indexOf('\0')
      ) {
        const packet = JSON.parse(buffer.slice(0, end)) as Packet;
        diagnostics.record(packet);
        buffer = buffer.slice(end + 1);
        if (packet.id !== undefined) {
          const item = waiting.get(packet.id);
          if (!item) continue;
          waiting.delete(packet.id);
          clearTimeout(item.timer);
          if (packet.error) item.reject(new Error(packet.error.message));
          else item.resolve(packet.result);
        } else for (const listener of listeners) listener(packet);
      }
    });
  const command = <T = Record<string, unknown>>(
    method: string,
    params: object = {},
    session = sessionId,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        waiting.delete(id);
        diagnostics.flush('command-timeout');
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      waiting.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      (child.stdio[3] as Writable).write(
        JSON.stringify({
          id,
          method,
          params,
          ...(session ? { sessionId: session } : {}),
        }) + '\0',
      );
    });
  const close = async () => {
    diagnostics.flush('cleanup');
    fail(new Error('Browser closed'));
    if (!stopped) {
      console.log('[browser-cleanup] chromium-exit: waiting');
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(timeout);
    }
    console.log('[browser-cleanup] profile-remove: begin');
    try {
      await removeBrowserProfile(directory, closed);
      console.log('[browser-cleanup] profile-remove: done');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      console.log(
        '[browser-cleanup] profile-remove: failed',
        typeof code === 'string' && /^[A-Z_]{1,32}$/.test(code)
          ? code
          : 'UNKNOWN',
      );
      throw error;
    }
  };
  try {
    const version = await command<{ product: string }>('Browser.getVersion');
    assert.equal(
      version.product.split('/')[1],
      selected.expected,
      'Browser runtime must match its exact reviewed pin',
    );
    process.stdout.write(
      `[official-browser] ${selected.profile}; expected=${selected.expected}; actual=${version.product}\n`,
    );
    const target = await command<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    });
    sessionId = (
      await command<{ sessionId: string }>('Target.attachToTarget', {
        targetId: target.targetId,
        flatten: true,
      })
    ).sessionId;
    await command('Page.enable');
    await command('Runtime.enable');
    await command('Network.enable');
    const visibility = browserVisibilityDiagnostics(command);
    listeners.add(visibility.record);
    await visibility.enable();
    const evaluate = async <T>(expression: string): Promise<T> => {
      const answer = await command<{
        result: { value: T };
        exceptionDetails?: object;
      }>('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      assert.ok(
        !answer.exceptionDetails,
        'Browser evaluation failed (details intentionally omit credentials)',
      );
      return answer.result.value;
    };
    const until = async (
      expression: string,
      label: string,
      deadline = Date.now() + 15000,
    ) => {
      let matched = false;
      while (!matched) {
        matched = await beforeVisibilityDeadline(
          () => evaluate<boolean>(expression),
          deadline,
          `Browser condition timed out: ${label}`,
        ).catch((error: unknown) => {
          if (Date.now() >= deadline) diagnostics.flush('condition-timeout');
          throw error;
        });
        if (Date.now() >= deadline) diagnostics.flush('condition-timeout');
        assert.ok(
          Date.now() < deadline,
          `Browser condition timed out: ${label}`,
        );
        if (!matched) await delay(25);
      }
    };
    const click = async (id: string) => {
      const point = await evaluate<{ x: number; y: number }>(
        `(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e||e.disabled)throw Error('Disabled control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await command('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        button: 'left',
        clickCount: 1,
        ...point,
      });
      await command('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        button: 'left',
        clickCount: 1,
        ...point,
      });
    };
    return {
      command,
      evaluate,
      until,
      click,
      close,
      on: (listener: (packet: Packet) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      navigate: async (url: string) => {
        let loaded!: () => void;
        const finished = new Promise<void>((resolve) => {
          loaded = resolve;
        });
        const listener = (packet: Packet) => {
          if (
            packet.method === 'Page.loadEventFired' &&
            packet.sessionId === sessionId
          )
            loaded();
        };
        listeners.add(listener);
        let timer: NodeJS.Timeout | undefined;
        try {
          await command('Page.navigate', { url });
          await Promise.race([
            finished,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Operator navigation timed out')),
                15000,
              );
            }),
          ]);
          await until(
            "document.readyState==='complete' && !!document.getElementById('load')",
            'served operator shell loaded',
          );
        } finally {
          clearTimeout(timer);
          listeners.delete(listener);
        }
      },
      background: async () => {
        const deadline = Date.now() + 15000;
        const bounded: Command = (method, params, session) =>
          beforeVisibilityDeadline(
            () => command(method, params, session),
            deadline,
            'Real tab background visibility deadline exceeded',
          );
        // Activation alone does not bind createTarget to this window in
        // headless Chrome. Open from the primary page itself instead.
        await bounded(
          'Target.activateTarget',
          { targetId: target.targetId },
          '',
        );
        assert.equal(
          await beforeVisibilityDeadline(
            () => evaluate<boolean>('document.hidden'),
            deadline,
            'Real tab background visibility deadline exceeded',
          ),
          false,
          'Primary page must be genuinely visible before opening its sibling',
        );
        // A normal window.open can foreground the sibling before it returns.
        // That real tab transition, not a synthetic event, hides the primary.
        const other = await openPrimarySiblingTab(
          command,
          listeners,
          { targetId: target.targetId, sessionId },
          deadline,
          visibility,
        );
        let otherClosed = false;
        const closeOther = async () => {
          if (otherClosed) return;
          await command('Target.closeTarget', { targetId: other.targetId }, '');
          otherClosed = true;
        };
        const targets = [
          { role: 'primary' as const, targetId: target.targetId, sessionId },
          { role: 'other' as const, targetId: other.targetId },
        ];
        try {
          await visibility.around('background', targets, async () => {
            const primaryWindow = await bounded<{ windowId?: unknown }>(
              'Browser.getWindowForTarget',
              { targetId: target.targetId },
              '',
            );
            const otherWindow = await bounded<{ windowId?: unknown }>(
              'Browser.getWindowForTarget',
              { targetId: other.targetId },
              '',
            );
            assertSameBrowserWindow(
              primaryWindow.windowId,
              otherWindow.windowId,
            );
            visibility.mark('background-activate-start');
            await bounded(
              'Target.activateTarget',
              { targetId: other.targetId },
              '',
            );
            visibility.mark('background-activate-complete');
            await until(
              'document.hidden',
              'real tab background visibility',
              deadline,
            );
          });
        } catch (error) {
          // Never close a target we did not create, or replace the real failure.
          await closeOther().catch(() => {});
          throw error;
        }
        return async () => {
          try {
            await visibility.around('foreground', targets, async () => {
              visibility.mark('foreground-activate-start');
              await command(
                'Target.activateTarget',
                { targetId: target.targetId },
                '',
              );
              visibility.mark('foreground-activate-complete');
              await closeOther();
              await until('!document.hidden', 'real tab foreground visibility');
            });
          } catch (error) {
            await closeOther().catch(() => {});
            throw error;
          }
        };
      },
    };
  } catch (error) {
    await delay(100);
    process.stderr.write(
      `[official-browser-startup] ${selected.profile}: ${startupStderr}\n`,
    );
    await close();
    throw error;
  }
}
