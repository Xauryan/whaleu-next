import assert from 'node:assert/strict';
import { ChildProcess, execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setImmediate as nextTurn,
  setTimeout as delay,
} from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  browserDiagnostics,
  browserProcessClosed,
  closeBrowserResources,
  removeBrowserProfile,
} from './support/browser-test-diagnostics.js';

test('browser diagnostics omit token-bearing URLs, payloads, console arguments and exception text', () => {
  const lines: string[] = [];
  const diagnostics = browserDiagnostics((line) => lines.push(line));
  const secret = 'PRIVATE_BEARER_BODY';
  diagnostics.record({
    method: 'Network.responseReceived',
    params: {
      response: {
        status: 403,
        url: secret,
        headers: { Authorization: secret },
      },
    },
  });
  diagnostics.record({
    method: 'Network.loadingFailed',
    params: { errorText: secret, url: secret },
  });
  diagnostics.record({
    method: 'Runtime.consoleAPICalled',
    params: { type: 'error', args: [{ value: secret }] },
  });
  diagnostics.record({
    method: 'Runtime.exceptionThrown',
    params: { exceptionDetails: { text: secret } },
  });
  diagnostics.record({
    method: 'Network.loadingFailed',
    params: { errorText: 'net::ERR_CONNECTION_CLOSED', canceled: true },
  });
  diagnostics.flush('cleanup');
  assert.ok(!lines.join('').includes(secret));
  assert.match(lines[0]!, /403/);
  assert.match(lines[0]!, /net::ERR_CONNECTION_CLOSED/);
  for (let i = 0; i < 100; i++)
    diagnostics.record({ method: 'Runtime.exceptionThrown' });
  diagnostics.flush('condition-timeout');
  assert.equal(
    JSON.parse(lines[1]!.slice('[browser-diagnostic] '.length)).events.length,
    32,
  );
});

test('owned browser resources close in order and successful cleanup remains successful', async () => {
  const calls: string[] = [];
  const lines: string[] = [];
  await closeBrowserResources(
    [
      [
        'browser',
        async () => {
          calls.push('browser');
        },
      ],
      [
        'fixture',
        async () => {
          calls.push('fixture');
        },
      ],
    ],
    { write: (line) => lines.push(line), timeoutMs: 50 },
  );
  assert.deepEqual(calls, ['browser', 'fixture']);
  assert.equal(lines.filter((line) => line.endsWith(': done')).length, 2);
});

test('an earlier close failure never skips later cleanup and all original errors are preserved', async () => {
  const first = new Error('browser profile cleanup failed');
  const second = new Error('fixture pool cleanup failed');
  const calls: string[] = [];
  await assert.rejects(
    closeBrowserResources(
      [
        [
          'browser',
          async () => {
            calls.push('browser');
            throw first;
          },
        ],
        [
          'fixture',
          async () => {
            calls.push('fixture');
            throw second;
          },
        ],
      ],
      { write: () => {}, timeoutMs: 50 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [first, second]);
      assert.equal(error.cause, first);
      return true;
    },
  );
  assert.deepEqual(calls, ['browser', 'fixture']);
});

test('a hung owned close fails within its bound and still attempts remaining cleanup', async () => {
  let fixtureClosed = false;
  await assert.rejects(
    closeBrowserResources(
      [
        ['browser', () => new Promise(() => {})],
        [
          'fixture',
          async () => {
            fixtureClosed = true;
          },
        ],
      ],
      { write: () => {}, timeoutMs: 10 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(
        (error.errors[0] as Error).message,
        /cleanup timeout: browser/,
      );
      return true;
    },
  );
  assert.equal(fixtureClosed, true);
});

test('the child close listener is registered synchronously and only resolves on close', async () => {
  const child = new ChildProcess();
  const closed = browserProcessClosed(child);
  assert.equal(child.listenerCount('close'), 1);
  let finished = false;
  void closed.then(() => {
    finished = true;
  });
  child.emit('exit', 0, null);
  await Promise.resolve();
  assert.equal(finished, false);
  child.emit('close', 0, null);
  await closed;
  assert.equal(finished, true);
  assert.equal(child.listenerCount('close'), 0);
});

test('profile removal waits for child close, not merely exit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-close-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'owned-profile'), 'fixture');
  const child = new ChildProcess();
  const closed = browserProcessClosed(child);
  const removal = removeBrowserProfile(directory, closed);
  child.emit('exit', 0, null);
  assert.equal(
    await Promise.race([removal.then(() => 'removed'), delay(50, 'waiting')]),
    'waiting',
  );
  await access(join(directory, 'owned-profile'));
  child.emit('close', 0, null);
  await removal;
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('a close captured before cleanup starts still permits profile removal', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-closed-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = new ChildProcess();
  const closed = browserProcessClosed(child);
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  await removeBrowserProfile(directory, closed);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

/** Each fault runs in a fresh Node process so the patched low-level rmdir is
 * captured by Node's real recursive rm, without changing fs for other tests.
 * Only this process's exact mkdtemp-owned profile receives injected errors. */
async function profileRemovalFault(
  code: 'ENOTEMPTY' | 'EACCES' | undefined,
  failures: number,
  expectedCalls: number,
  expectFailure: boolean,
  throughResources = false,
) {
  const helper = new URL(
    './support/browser-test-diagnostics.ts',
    import.meta.url,
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
        import { tmpdir } from 'node:os';
        import { join } from 'node:path';
        const root = await mkdtemp(join(tmpdir(), 'browser-rm-fault-test-'));
        const directory = await mkdtemp(join(root, 'owned-profile-'));
        const sibling = join(root, 'sibling');
        const target = join(root, 'symlink-target');
        await mkdir(target);
        await writeFile(sibling, 'keep sibling');
        await writeFile(join(target, 'keep'), 'keep target');
        const code = ${JSON.stringify(code ?? null)};
        // Fault cases use an empty directory: ENOTEMPTY must reach rm's retry
        // policy rather than merely its initial child-enumeration fallback.
        if (!code) {
          await writeFile(join(directory, 'owned'), 'remove me');
          await symlink(target, join(directory, 'link'), 'dir');
        }
        const original = fs.rmdir;
        const failure = Object.assign(new Error('injected profile removal failure'), { code });
        let calls = 0;
        let inject = true;
        fs.rmdir = (path, callback) => {
          if (String(path) === directory) {
            calls++;
            if (inject && code && calls <= ${failures}) {
              queueMicrotask(() => callback(failure));
              return;
            }
          }
          original(path, callback);
        };
        try {
          const { removeBrowserProfile, closeBrowserResources } = await import(${JSON.stringify(helper.href)});
          let caught;
          let fixtureClosed = false;
          const cleanup = () => removeBrowserProfile(directory, Promise.resolve());
          try {
            if (${throughResources}) {
              await closeBrowserResources([
                ['browser', cleanup],
                ['fixture', async () => { fixtureClosed = true; }],
              ], { write: () => {} });
            } else await cleanup();
          } catch (error) { caught = error; }
          if (${expectFailure}) {
            if (${throughResources}) {
              assert.ok(caught instanceof AggregateError);
              assert.deepEqual(caught.errors, [failure]);
              assert.equal(caught.cause, failure);
              assert.equal(fixtureClosed, true);
            } else assert.equal(caught, failure);
            await access(directory);
          } else {
            assert.equal(caught, undefined);
            await assert.rejects(access(directory), { code: 'ENOENT' });
          }
          assert.equal(calls, ${expectedCalls});
          assert.equal(await readFile(sibling, 'utf8'), 'keep sibling');
          assert.equal(await readFile(join(target, 'keep'), 'utf8'), 'keep target');
          console.log('real Node recursive rm assertions passed');
        } finally {
          inject = false;
          fs.rmdir = original;
          await rm(root, { recursive: true, force: true });
        }
      `,
    ],
    { timeout: 5000 },
  );
  assert.match(stdout, /real Node recursive rm assertions passed/);
}

test('real recursive rm retries transient ENOTEMPTY before removing the owned profile', async () => {
  await profileRemovalFault('ENOTEMPTY', 2, 3, false);
});

test('real recursive rm stops after three retries and preserves persistent ENOTEMPTY', async () => {
  await profileRemovalFault('ENOTEMPTY', 100, 8, true);
});

test('real recursive rm does not retry non-retryable EACCES', async () => {
  await profileRemovalFault('EACCES', 100, 1, true);
});

test('real recursive rm removes only the owned profile and preserves sibling and symlink target', async () => {
  await profileRemovalFault(undefined, 0, 2, false);
});

test('persistent profile removal retains its original error and still closes the fixture', async () => {
  await profileRemovalFault('ENOTEMPTY', 100, 8, true, true);
});

test('the default per-resource cleanup deadline remains fifteen seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fixtureClosed = false;
  let settled = false;
  const result = closeBrowserResources(
    [
      ['browser', () => new Promise(() => {})],
      [
        'fixture',
        async () => {
          fixtureClosed = true;
        },
      ],
    ],
    { write: () => {} },
  ).catch((error: unknown) => {
    settled = true;
    return error;
  });
  t.mock.timers.tick(14999);
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(fixtureClosed, false);
  t.mock.timers.tick(1);
  const error = await result;
  assert.ok(error instanceof AggregateError);
  assert.match((error.errors[0] as Error).message, /cleanup timeout: browser/);
  assert.equal(fixtureClosed, true);
});
