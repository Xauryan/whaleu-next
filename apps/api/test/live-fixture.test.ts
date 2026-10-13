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
