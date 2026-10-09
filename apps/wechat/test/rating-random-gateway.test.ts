import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpRatingRandomGateway } from '../src/ratings/random-gateway';
import type { RatingRandomQuery } from '../src/ratings/random-contract';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import { categoryId, otherId, regionId } from './ratings-helpers';
import { randomResult } from './rating-random-helpers';

function setup(loggedIn = true) {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpRatingRandomGateway(
    new ApiClient('https://ratings.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
  );
  return { sessions, transport, gateway };
}
test('random uses its separate authenticated GET with exact numeric filters and no cursor, list or identity lookup', async () => {
  const s = setup();
  for (const query of [
    { categoryId },
    { categoryId, campusId: otherId, minimumAverage: 4.1 },
  ]) {
    s.transport.reply(randomResult(query));
    await s.gateway.draw(query, new Cancellation());
  }
  assert.equal(s.transport.requests.length, 2);
  for (const request of s.transport.requests) {
    assert.equal(request.method, 'GET');
    assert.equal(new URL(request.url).pathname, '/v1/ratings/random-target');
    assert.equal(request.body, undefined);
    assert.equal(
      request.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
  }
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[0]!.url).searchParams),
    { categoryId },
  );
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[1]!.url).searchParams),
    { categoryId, campusId: otherId, minimumAverage: '4.1' },
  );
});
test('random rejects auth absence and malformed request before dispatch', async () => {
  const s = setup(false);
  await assert.rejects(s.gateway.draw({ categoryId }, new Cancellation()), {
    kind: 'auth-required',
  });
  for (const query of [
    { categoryId, regionId },
    { categoryId, minimumAverage: '4' },
    { categoryId, campusId: null },
    { categoryId: `${categoryId}?campusId=${otherId}` },
  ])
    await assert.rejects(
      s.gateway.draw(query as RatingRandomQuery, new Cancellation()),
    );
  assert.equal(s.transport.requests.length, 0);
});
test('real transport binds returned context to immutable request snapshot and rejects strict response extras', async () => {
  const s = setup(),
    query = { categoryId, campusId: otherId, minimumAverage: 4 };
  for (const response of [
    randomResult(),
    randomResult({ ...query, categoryId: regionId }),
    randomResult({ ...query, campusId: regionId }),
    randomResult({ ...query, minimumAverage: 3.9 }),
    { ...randomResult(query), nextCursor: null },
  ]) {
    s.transport.reply(response);
    await assert.rejects(s.gateway.draw(query, new Cancellation()), {
      kind: 'protocol',
    });
  }
  s.transport.reply(randomResult(query));
  const running = s.gateway.draw(query, new Cancellation());
  query.campusId = regionId;
  assert.equal((await running).context.campusId, otherId);
});
