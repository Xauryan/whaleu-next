import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  fixtureSessionCallback,
  listeningFixtureOrigin,
} from './support/browser-test-fixtures.js';

test('browser bridge session callback compiles and returns the synthetic identity object', () => {
  for (const bearer of [
    'synthetic-test-token',
    'synthetic-"\\\n令牌-);throw new Error("injection")',
  ]) {
    const identity = {
      accountId: '00000000-0000-4000-8000-000000000001',
      bearer,
    };
    const callback = new Script(
      `(${fixtureSessionCallback(identity)})`,
    ).runInNewContext() as () => typeof identity;
    assert.deepEqual(JSON.parse(JSON.stringify(callback())), identity);
    const bridge = new Script(
      `({session:${fixtureSessionCallback(identity)},subscribe:()=>()=>{}})`,
    ).runInNewContext() as {
      session: () => typeof identity;
      subscribe: () => () => void;
    };
    assert.deepEqual(JSON.parse(JSON.stringify(bridge.session())), identity);
    assert.equal(typeof bridge.subscribe(), 'function');
  }
  const extra = {
    accountId: 'synthetic',
    bearer: 'test',
    unrelated: 'DO_NOT_SERIALIZE',
  };
  assert.ok(!fixtureSessionCallback(extra).includes(extra.unrelated));
  assert.throws(
    () =>
      new Script('({session:()=>{"accountId":"synthetic","bearer":"test"}})'),
    SyntaxError,
  );
});

test('browser origin reuses the existing fixture listener without a second listen', () => {
  let reads = 0;
  const server = {
    listening: true,
    address: () => {
      reads++;
      return { address: '127.0.0.1', family: 'IPv4', port: 43217 };
    },
    listen: () => assert.fail('must not relisten'),
  };
  assert.equal(listeningFixtureOrigin(server), 'http://127.0.0.1:43217');
  assert.equal(reads, 1);
});

test('browser origin rejects unavailable, non-TCP, foreign and unassigned listeners', () => {
  assert.throws(
    () => listeningFixtureOrigin({ listening: false, address: () => null }),
    /already be listening/,
  );
  for (const address of [
    null,
    'socket-path',
    { address: '0.0.0.0', family: 'IPv4', port: 43217 },
    { address: '192.0.2.1', family: 'IPv4', port: 43217 },
    { address: '127.0.0.1', family: 'IPv4', port: 0 },
    { address: '127.0.0.1', family: 'IPv4', port: 65536 },
  ]) {
    assert.throws(() =>
      listeningFixtureOrigin({
        listening: true,
        address: () => address as AddressInfo | string | null,
      }),
    );
  }
});

test(
  'actual fixture HTTP listener is reused and closed listeners are rejected',
  { timeout: 5000 },
  async () => {
    const server = createServer((_, response) => {
      response.end('synthetic-fixture-ready');
    });
    const ready = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    try {
      await ready;
      const address = server.address();
      const origin = listeningFixtureOrigin(server);
      assert.equal(listeningFixtureOrigin(server), origin);
      assert.deepEqual(server.address(), address);
      const body = await new Promise<string>((resolve, reject) => {
        const request = get(
          `${origin}/fixture`,
          { agent: false },
          (response) => {
            assert.equal(response.statusCode, 200);
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              text += chunk;
            });
            response.on('end', () => resolve(text));
            response.on('error', reject);
          },
        );
        request.on('error', reject);
        request.setTimeout(1000, () =>
          request.destroy(new Error('Fixture HTTP probe timed out')),
        );
      });
      assert.equal(body, 'synthetic-fixture-ready');
    } finally {
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    }
    assert.throws(() => listeningFixtureOrigin(server), /already be listening/);
  },
);
