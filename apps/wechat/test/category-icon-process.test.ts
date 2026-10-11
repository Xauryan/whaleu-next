import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { categoryIconProcessFixture } from './support/category-icon-process-fixtures';
import { iconReceipt } from './category-icon-helpers';
import type { RatingCategoryIconReceipt } from '../src/ratings/category-icon-contract';
test('distinct native processes recover SIGKILL journal13 boundaries receipt-first through synthetic authenticated HTTP fixture bridge', async () => {
  const fixture = categoryIconProcessFixture(),
    directory = await mkdtemp(join(tmpdir(), 'category-icon-process-'));
  let stage = '',
    receipt: RatingCategoryIconReceipt | null = null,
    cancelled = false;
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(
        request.headers.authorization,
        'Bearer synthetic-category-process-access',
      );
      const route = request.url!;
      calls.push(`${request.method} ${route}`);
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      const body = raw ? JSON.parse(raw) : {};
      let value: unknown;
      if (
        route ===
        `/v5/ratings/requests/${fixture.intent.payload.clientRequestId}`
      ) {
        if (!receipt) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: {
                code: 'REQUEST_NOT_FOUND',
                message: 'Synthetic unknown',
                requestId: fixture.intent.payload.clientRequestId,
              },
            }),
          );
          return;
        }
        value = receipt;
      } else if (route === '/v5/ratings/category-management/cancel-by-hash') {
        assert.equal(body.intentHash, iconReceipt(fixture.intent).intentHash);
        receipt ??= iconReceipt(fixture.intent, 'closed');
        value = receipt;
      } else if (
        route === '/v5/ratings/category-management/upload-scopes/recover' ||
        route === '/v5/ratings/category-management/upload-scopes/cancel'
      ) {
        assert.equal(
          body.clientRequestId,
          fixture.pending.scopeInput.clientRequestId,
        );
        assert.equal(body.requestHash, fixture.scopeRequestHash);
        if (route.endsWith('/cancel')) cancelled = true;
        const common = {
          protocol: 'ratings-category-icon-media-v1',
          requestId: fixture.pending.scopeInput.clientRequestId,
          serverNow: fixture.common.serverNow,
        };
        value = {
          state: cancelled ? 'cancelled' : 'known',
          scope: fixture.scope,
          recovery:
            receipt?.outcome === 'applied'
              ? {
                  ...common,
                  state: 'recorded',
                  requestHash: fixture.common.requestHash,
                  status: fixture.bound,
                }
              : cancelled
                ? {
                    ...common,
                    state: 'cancelled_before_prepare',
                    requestHash: fixture.common.requestHash,
                    reason: 'cancelled',
                  }
                : stage === 'scope-response-lost'
                  ? { ...common, state: 'not_recorded', requestHash: null }
                  : {
                      ...common,
                      state: 'recorded',
                      requestHash: fixture.common.requestHash,
                      status: fixture.ready.status,
                    },
        };
      } else throw Error(`Unexpected effect ${route}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}`;
  const run = async (mode: 'write' | 'recover', path: string) => {
    const child = fork(
      join(__dirname, 'support/native-category-icon-process.mjs'),
      [],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    child.stderr?.resume();
    try {
      const result = await new Promise<{ event: string; message?: string }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error('Child checkpoint timeout')),
            15000,
          );
          child.once('error', reject);
          child.once('message', (value) => {
            clearTimeout(timer);
            resolve(value as { event: string; message?: string });
          });
          child.send({ mode, stage, path, server: endpoint });
        },
      );
      assert.equal(
        result.event,
        mode === 'write' ? 'durable' : 'recovered',
        result.message,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = new Promise<void>((resolve) =>
          child.once('exit', () => resolve()),
        );
        child.kill('SIGKILL');
        await exit;
      }
    }
  };
  try {
    for (stage of [
      'uploads-frozen',
      'scope-response-lost',
      'ready',
      'command-frozen',
      'applied-response-lost',
      'opaque-switch',
    ]) {
      receipt = stage === 'applied-response-lost' ? fixture.receipt : null;
      cancelled = false;
      const path = join(directory, stage + '.json');
      await run('write', path);
      calls.length = 0;
      await run('recover', path);
      assert.equal(
        calls[0],
        `GET /v5/ratings/requests/${fixture.intent.payload.clientRequestId}`,
      );
      assert.equal(
        calls.some((call) =>
          /\/contexts|\/prepare|\/commit|\/grant|\/uploads\//.test(call),
        ),
        false,
      );
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
