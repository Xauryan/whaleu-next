import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserDiagnostics,
  closeBrowserResources,
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
