/** Real Chromium/CDP transport. No browser, DOM, fetch or application mocks.
 * CI must install the exact official runtime below; absence/version drift FAILS
 * this gate (never a skipped successful journey). Installation is not done here.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
export async function officialBrowser() {
  const selected = await runtime();
  let helper: string | undefined;
  if (process.env['CI'] || process.env['WHALEU_OFFICIAL_SANDBOX_HELPER']) {
    const verifier =
      require('../../../../scripts/official-browser-sandbox.mjs') as {
        verifyOfficialSandboxHelper(): Promise<string>;
      };
    helper = await verifier.verifyOfficialSandboxHelper();
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
  child.on('exit', () => {
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
    fail(new Error('Browser closed'));
    if (!stopped) {
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(timeout);
    }
    await rm(directory, { recursive: true, force: true });
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
    const until = async (expression: string, label: string) => {
      const deadline = Date.now() + 15000;
      while (!(await evaluate<boolean>(expression))) {
        assert.ok(
          Date.now() < deadline,
          `Browser condition timed out: ${label}`,
        );
        await delay(25);
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
        const other = await command<{ targetId: string }>(
          'Target.createTarget',
          { url: 'about:blank' },
          '',
        );
        await command(
          'Target.activateTarget',
          { targetId: other.targetId },
          '',
        );
        await until('document.hidden', 'real tab background visibility');
        return async () => {
          await command(
            'Target.activateTarget',
            { targetId: target.targetId },
            '',
          );
          await command('Target.closeTarget', { targetId: other.targetId }, '');
          await until('!document.hidden', 'real tab foreground visibility');
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
