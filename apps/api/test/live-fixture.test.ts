import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extendLiveFixture } from './support/live-fixture.js';

test('fixture layers retain live app/server accessors and source identity', () => {
  const original = { id: 'old' };
  let current = original;
  let reads = 0;
  const source = {
    get app() {
      reads++;
      return current;
    },
    get http() {
      return current.id;
    },
    restart() {
      current = { id: 'new' };
    },
  };
  const first = extendLiveFixture(source, { owner: 'one' });
  const second = extendLiveFixture(first, { owner: 'two' });
  assert.equal(reads, 0, 'composition must not evaluate getters');
  assert.equal(second.app, original);
  source.restart();
  assert.notEqual(second.app, original);
  assert.equal(second.app, source.app);
  assert.equal(second.http, 'new');
  assert.equal(first.owner, 'one');
  assert.equal(second.owner, 'two');
});

test('layered request helpers resolve the current server and fail closed between apps', () => {
  const original = { getHttpServer: () => 'historical server' };
  let current: typeof original | undefined = original;
  const source = {
    get app() {
      assert.ok(current, 'Fixture application is closed or restarting');
      return current;
    },
    get historicalPrefix() {
      return current === original ? 145 : undefined;
    },
  };
  const school = extendLiveFixture(source, {
    request: () => source.app.getHttpServer(),
  });
  const institutional = extendLiveFixture(school, {
    authorize: () => school.app.getHttpServer(),
  });
  for (const layer of [school, institutional]) {
    for (const key of ['app', 'historicalPrefix'])
      assert.equal(
        Object.getOwnPropertyDescriptor(layer, key)?.get,
        Object.getOwnPropertyDescriptor(source, key)?.get,
      );
  }
  assert.equal(institutional.request(), 'historical server');
  assert.equal(institutional.authorize(), 'historical server');
  current = undefined;
  assert.throws(() => institutional.app, /closed or restarting/);
  assert.throws(institutional.request, /closed or restarting/);
  assert.throws(institutional.authorize, /closed or restarting/);
  current = { getHttpServer: () => 'current server' };
  assert.equal(institutional.app, current);
  assert.equal(institutional.historicalPrefix, undefined);
  assert.equal(institutional.request(), 'current server');
  assert.equal(institutional.authorize(), 'current server');
});
