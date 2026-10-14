import assert from 'node:assert/strict';
import type { Server } from 'node:net';

/** Reuse the fixture-owned listener. Browser setup must not listen a second time
 * or navigate to a guessed port or a non-loopback host. */
export function listeningFixtureOrigin(
  server: Pick<Server, 'listening' | 'address'>,
) {
  assert.equal(
    server.listening,
    true,
    'Browser fixture must already be listening',
  );
  const address = server.address();
  assert.ok(
    address && typeof address === 'object',
    'Browser fixture requires a TCP listener',
  );
  assert.equal(
    address.address,
    '127.0.0.1',
    'Browser fixture must bind IPv4 loopback',
  );
  assert.ok(
    Number.isInteger(address.port) && address.port > 0 && address.port <= 65535,
    'Browser fixture requires its actual assigned port',
  );
  return `http://${address.address}:${address.port}`;
}

/** Only the synthetic harness consumes this callback. Parentheses make the
 * serialized object an expression rather than an arrow-function statement block.
 * The callback and its credentials are never logged or persisted. */
export function fixtureSessionCallback(identity: {
  accountId: string;
  bearer: string;
}) {
  return `() => (${JSON.stringify({ accountId: identity.accountId, bearer: identity.bearer })})`;
}
