import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeReadingCapability } from '../src/community/reading-readiness-contract';
import { decodeTextSourceCapability } from '../src/community/text-source-contract';
import { ReadingReadinessGateway } from '../src/community/reading-readiness-gateway';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { Cancellation, type HttpRequest } from '../src/platform/contracts';
const spaceId = '12345678-1234-4123-8123-123456789abc';
const v1 = {
  version: 1,
  authorMode: 'named',
  availability: 'available',
  operations: ['publish_post'],
  formats: ['plain', 'markdown'],
  readingFormatting: ['auto', 'off'],
  media: 'unavailable',
  markdownReferences: 'unavailable',
  formatter: 'not_configured',
};
const v2 = (schema = 'installed', requestedMode = 'disabled') => ({
  ...v1,
  version: 2,
  formatter: {
    version: 'plain-cjk-slices-v2',
    schema,
    worker: { requestedMode, readiness: 'not_observed' },
  },
});
for (const schema of ['installed', 'missing', 'unavailable'])
  for (const mode of ['disabled', 'manual_only', 'automatic'])
    test(`strict readiness ${schema}/${mode} never fabricates worker liveness`, () => {
      const value = decodeReadingCapability(v2(schema, mode));
      assert.equal(value.formatter.schema, schema);
      assert.equal(value.formatter.worker.requestedMode, mode);
      assert.equal(value.formatter.worker.readiness, 'not_observed');
      assert.equal(value.availability, 'available');
      assert.equal(Object.isFrozen(value.formatter.worker), true);
    });
test('v1 decoder remains exact; unknown readiness fields/modes and inconsistent source authority reject', () => {
  assert.equal(decodeTextSourceCapability(v1).formatter, 'not_configured');
  assert.throws(() => decodeTextSourceCapability(v2()));
  for (const raw of [
    v1,
    v2('ready'),
    v2('installed', 'running'),
    { ...v2(), extra: true },
    { ...v2(), availability: 'unavailable' },
    { ...v2(), formatter: { ...v2().formatter, permit: true } },
    {
      ...v2(),
      formatter: {
        ...v2().formatter,
        worker: { requestedMode: 'automatic', readiness: 'running' },
      },
    },
  ])
    assert.throws(() => decodeReadingCapability(raw));
});
function fixture() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), {
    accountId: spaceId,
    sessionId: '22345678-1234-4123-8123-123456789abc',
    accessToken: 'wu_a_' + 'a'.repeat(43),
    refreshToken: 'wu_r_' + 'a'.repeat(43),
    expiresAt: 1900000000000,
    refreshExpiresAt: 1900600000000,
  });
  const requests: HttpRequest[] = [];
  let respond!: (body: unknown) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const api = new ApiClient(
    'https://reading.invalid',
    {
      send: async (input) => {
        requests.push(input);
        return new Promise((resolve) => {
          respond = (body) => resolve({ status: 200, headers: {}, body });
          markStarted();
        });
      },
    },
    sessions,
    {
      refresh: async () => {
        throw new Error('Unexpected refresh');
      },
    },
  );
  return {
    sessions,
    requests,
    started,
    gateway: new ReadingReadinessGateway(api),
    respond: (body: unknown) => respond(body),
  };
}
test('feature gateway uses explicit v2 route and shared authenticated client/cancellation', async () => {
  const f = fixture(),
    cancel = new Cancellation();
  const response = f.gateway.readingCapabilities(
    spaceId,
    'discussion',
    'anonymous',
    cancel,
  );
  await f.started;
  assert.equal(f.requests.length, 1);
  const request = f.requests[0]!;
  const url = new URL(request.url);
  assert.equal(url.pathname, '/v2/community/text-source-capabilities');
  assert.equal(url.searchParams.get('spaceId'), spaceId);
  assert.equal(url.searchParams.get('authorMode'), 'anonymous');
  assert.match(request.headers['Authorization']!, /^Bearer wu_a_/);
  f.respond({ ...v2(), authorMode: 'anonymous' });
  assert.equal((await response).authorMode, 'anonymous');
});
test('scope mismatch fails decoding rather than retrying a legacy capability endpoint', async () => {
  const f = fixture();
  const response = f.gateway.readingCapabilities(
    spaceId,
    'discussion',
    'anonymous',
    new Cancellation(),
  );
  await f.started;
  f.respond(v2());
  await assert.rejects(
    response,
    (e: unknown) => e instanceof ClientError && e.kind === 'protocol',
  );
  assert.equal(f.requests.length, 1);
});
test('account switch rejects a late readiness response on the same original session chain', async () => {
  const f = fixture();
  const response = f.gateway.readingCapabilities(
    spaceId,
    'discussion',
    'named',
    new Cancellation(),
  );
  await f.started;
  f.sessions.logout();
  f.respond(v2());
  await assert.rejects(
    response,
    (e: unknown) => e instanceof ClientError && e.kind === 'stale-session',
  );
});
test('cancellation rejects late readiness and never reroutes authorization', async () => {
  const f = fixture(),
    cancel = new Cancellation();
  const response = f.gateway.readingCapabilities(
    spaceId,
    'discussion',
    'named',
    cancel,
  );
  await f.started;
  cancel.cancel();
  f.respond(v2());
  await assert.rejects(
    response,
    (e: unknown) => e instanceof ClientError && e.kind === 'cancelled',
  );
  assert.equal(f.requests.length, 1);
});
