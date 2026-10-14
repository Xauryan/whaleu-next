/** Lock-pinned Chromium CDP driver using the shared verified sandbox profile. No package install, browser download, DOM
 * emulation, provider network, or hidden retry. Qualification is executable
 * metadata only; this file does not claim independently verified provenance.
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export const RATING_PROMOTION_BROWSER_PROFILE = 'playwright-core-1.58.2';
type Json = Record<string, unknown>;

export interface PromotionBrowser {
  command(method: string, params?: Json): Promise<Json>;
  event(method: string, timeout?: number): Promise<Json>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  waitFor(expression: string, timeout?: number): Promise<void>;
  click(selector: string): Promise<void>;
  select(selector: string, value: string): Promise<void>;
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
}

export async function startPromotionBrowser(): Promise<PromotionBrowser> {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('playwright-core/package.json'));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '1.58.2');
  const manifest = JSON.parse(
    await readFile(join(root, 'browsers.json'), 'utf8'),
  ) as { browsers: { name: string; browserVersion?: string }[] };
  const expected = manifest.browsers.find(
    (browser) => browser.name === 'chromium',
  )?.browserVersion;
  assert.ok(expected);
  const binary = (
    require('playwright-core') as { chromium: { executablePath(): string } }
  ).chromium.executablePath();
  const version = await promisify(execFile)(binary, ['--version'], {
    timeout: 3000,
  });
  assert.ok(
    version.stdout.includes(expected),
    'Pinned Chromium version mismatch; no substitution',
  );
  const verifier =
    require('../../../../scripts/official-browser-sandbox.mjs') as {
      verifyOfficialBrowserSandbox(): Promise<string | undefined>;
    };
  const helper = await verifier.verifyOfficialBrowserSandbox();
  const directory = await mkdtemp(join(tmpdir(), 'rating-promotion-browser-'));
  const child = spawn(
    binary,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--metrics-recording-only',
      '--window-size=1280,1000',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${directory}`,
      'about:blank',
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        ...(helper ? { CHROME_DEVEL_SANDBOX: helper } : {}),
      },
    },
  );
  let exited = false;
  const exit = new Promise<void>((resolve) =>
    child.once('exit', () => {
      exited = true;
      resolve();
    }),
  );
  let socket: WebSocket | null = null;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    socket?.close();
    if (!exited) child.kill('SIGTERM');
    if (!exited) await Promise.race([exit, delay(2000)]);
    if (!exited) child.kill('SIGKILL');
    if (!exited) await Promise.race([exit, delay(2000)]);
    await rm(directory, { recursive: true, force: true });
  }
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(
        () =>
          finish(
            new Error('Pinned Chromium did not expose CDP within 10 seconds.'),
          ),
        10000,
      );
      const failed = () =>
        finish(
          new Error(
            'Pinned Chromium could not start; no sandbox or browser fallback was applied.',
          ),
        );
      const finish = (result: string | Error) => {
        clearTimeout(timer);
        child.stderr?.off('data', received);
        child.off('error', failed);
        child.off('exit', failed);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const received = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16000);
        const match =
          /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/.exec(
            output,
          );
        if (match?.[1]) finish(match[1]);
      };
      child.stderr?.on('data', received);
      child.once('error', failed);
      child.once('exit', failed);
    });
    const browserUrl = new URL(endpoint);
    const targets = (await fetch(`http://${browserUrl.host}/json/list`, {
      signal: AbortSignal.timeout(3000),
    }).then((result) => result.json())) as {
      type: string;
      webSocketDebuggerUrl?: string;
    }[];
    const target = targets.find((item) => item.type === 'page');
    if (!target?.webSocketDebuggerUrl)
      throw new Error('Pinned Chromium did not create its blank page.');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('CDP connection timed out.')),
        5000,
      );
      socket!.addEventListener(
        'open',
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket!.addEventListener(
        'error',
        () => {
          clearTimeout(timeout);
          reject(new Error('CDP connection failed.'));
        },
        { once: true },
      );
    });
    let sequence = 0;
    const pending = new Map<
      number,
      {
        resolve: (value: Json) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const listeners = new Map<string, Set<(value: Json) => void>>();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: Json;
        error?: Json;
        method?: string;
        params?: Json;
      };
      if (message.id !== undefined) {
        const waiting = pending.get(message.id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        pending.delete(message.id);
        if (message.error) waiting.reject(new Error('CDP command failed.'));
        else waiting.resolve(message.result ?? {});
      } else if (message.method) {
        for (const receive of [...(listeners.get(message.method) ?? [])])
          receive(message.params ?? {});
      }
    });
    socket.addEventListener('close', () => {
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error('CDP connection closed.'));
      }
      pending.clear();
    });
    const command = (method: string, params: Json = {}) =>
      new Promise<Json>((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out.`));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        socket!.send(JSON.stringify({ id, method, params }));
      });
    const event = (method: string, timeout = 10000) =>
      new Promise<Json>((resolve, reject) => {
        let set = listeners.get(method);
        if (!set) {
          set = new Set();
          listeners.set(method, set);
        }
        const receive = (value: Json) => {
          clearTimeout(timer);
          set!.delete(receive);
          resolve(value);
        };
        const timer = setTimeout(() => {
          set!.delete(receive);
          reject(new Error(`CDP event ${method} timed out.`));
        }, timeout);
        set.add(receive);
      });
    async function evaluate<T = unknown>(expression: string): Promise<T> {
      const result = await command('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result['exceptionDetails'])
        throw new Error('Browser evaluation failed.');
      return (result['result'] as { value: T }).value;
    }
    async function waitFor(expression: string, timeout = 10000) {
      const deadline = performance.now() + timeout;
      do {
        if (await evaluate<boolean>(expression)) return;
        await delay(25);
      } while (performance.now() < deadline);
      throw new Error('Operator browser condition timed out.');
    }
    await command('Page.enable');
    await command('Runtime.enable');
    await command('Network.enable');
    return {
      command,
      event,
      evaluate,
      waitFor,
      click: async (selector) => {
        const point = await evaluate<{ x: number; y: number } | null>(
          `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node || node.disabled || node.hidden) return null; node.scrollIntoView({block:'center'}); const box = node.getBoundingClientRect(); return box.width && box.height ? {x:box.x+box.width/2,y:box.y+box.height/2}:null; })()`,
        );
        if (!point)
          throw new Error('Operator control is absent, hidden or disabled.');
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
      },
      select: async (selector, value) => {
        const changed = await evaluate<boolean>(
          `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node || node.disabled || !Array.from(node.options).some(option => option.value === ${JSON.stringify(value)})) return false; node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`,
        );
        if (!changed) throw new Error('Operator selection is unavailable.');
      },
      navigate: async (url) => {
        const loaded = event('Page.loadEventFired');
        const result = await command('Page.navigate', { url });
        if (result['errorText']) throw new Error('Operator navigation failed.');
        await loaded;
      },
      reload: async () => {
        const loaded = event('Page.loadEventFired');
        await command('Page.reload', { ignoreCache: true });
        await loaded;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Controlled fixture host only. Test credentials remain in this closure and
 * are attached by native fetch; never placed in operator input or storage. */
export function promotionBrowserBridgeScript(input: {
  actorId: string;
  token: string;
  storageFailure?: 'write' | 'readback';
}): string {
  return `(() => {
    const actorId = ${JSON.stringify(input.actorId)};
    const token = ${JSON.stringify(input.token)};
    const listeners = new Set();
    Object.defineProperty(window, 'whaleuRatingGroupPromotionBridge', {value: Object.freeze({
      version: 'rating-group-promotion-v1', origin: location.origin,
      getIdentity: async () => ({actorId, origin: location.origin}),
      request: (path, init) => fetch(path, {...init, headers: {'Content-Type':'application/json','Authorization':'Bearer '+token}}),
      subscribe: callback => {listeners.add(callback); return () => listeners.delete(callback);}
    })});
    Object.defineProperty(window, 'invalidateRatingPromotionFixtureHost', {value: () => {for (const callback of listeners) callback();}});
    ${input.storageFailure === 'write' ? "Storage.prototype.setItem = function () {throw new DOMException('Fixture storage quota', 'QuotaExceededError');};" : ''}
    ${input.storageFailure === 'readback' ? 'const get = Storage.prototype.getItem; const set = Storage.prototype.setItem; let written = false; Storage.prototype.setItem = function (key, value) {set.call(this,key,value); written=true;}; Storage.prototype.getItem = function (key) {return written ? null : get.call(this,key);};' : ''}
  })();`;
}
