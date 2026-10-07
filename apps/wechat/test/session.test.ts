import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import { MemoryStorage, credentials, signedIn } from './helpers';

test('login and logout invalidate old requests, including same-account relogin', () => {
  const sessions = signedIn();
  const old = sessions.snapshot();
  sessions.completeLogin(sessions.beginLogin(), credentials());
  assert.throws(() => sessions.assertCurrent(old), { kind: 'stale-session' });
  assert.equal(sessions.snapshot().credentials?.accountId, '12');
});
test('older login completion cannot replace a newer attempt', () => {
  const sessions = new SessionStore();
  const old = sessions.beginLogin();
  const latest = sessions.beginLogin();
  assert.throws(() => sessions.completeLogin(old, credentials('11')), {
    kind: 'stale-session',
  });
  sessions.completeLogin(latest, credentials('22'));
  assert.equal(sessions.snapshot().credentials?.accountId, '22');
});
test('refresh keeps epoch and advances revision, ignores superseded token pair', () => {
  const sessions = signedIn();
  const original = sessions.snapshot();
  const refreshed = sessions.rotate(original, credentials('12', 'b'));
  assert.equal(refreshed.epoch, original.epoch);
  assert.equal(refreshed.revision, original.revision + 1);
  sessions.rotate(original, credentials('12', 'late'));
  assert.equal(
    sessions.snapshot().credentials?.accessToken,
    'synthetic-access-b',
  );
});
test('refresh rejects a different account', () => {
  const sessions = signedIn();
  assert.throws(() => sessions.rotate(sessions.snapshot(), credentials('99')), {
    kind: 'protocol',
  });
});
test('stored credentials are one versioned atomic record and restore is validated', () => {
  const storage = new MemoryStorage();
  const first = new SessionStore(storage);
  first.completeLogin(first.beginLogin(), credentials());
  assert.equal(storage.data.size, 1);
  const second = new SessionStore(storage);
  second.restore();
  assert.deepEqual(second.snapshot().credentials, credentials());
  assert.equal(Object.isFrozen(second.snapshot().credentials), true);
});
test('corrupt persisted data never creates a partial signed-in state', () => {
  const storage = new MemoryStorage();
  storage.data.set('whaleu.session.v1', {
    version: 1,
    credentials: { accountId: '12', accessToken: 'synthetic' },
  });
  const sessions = new SessionStore(storage);
  assert.throws(() => sessions.restore(), { kind: 'storage' });
  assert.equal(sessions.snapshot().credentials, null);
  assert.equal(storage.data.size, 0);
});
test('storage write failure invalidates memory and does not retain old credentials', () => {
  const storage = new MemoryStorage();
  const sessions = new SessionStore(storage);
  sessions.completeLogin(sessions.beginLogin(), credentials());
  storage.failWrite = true;
  assert.throws(
    () => sessions.rotate(sessions.snapshot(), credentials('12', 'b')),
    { kind: 'storage' },
  );
  assert.equal(sessions.snapshot().credentials, null);
  assert.equal(storage.data.size, 0);
});
test('logout clears memory even if removal fails and reports storage failure', () => {
  const storage = new MemoryStorage();
  const sessions = new SessionStore(storage);
  sessions.completeLogin(sessions.beginLogin(), credentials());
  storage.failRemove = true;
  assert.throws(() => sessions.logout(), { kind: 'storage' });
  assert.equal(sessions.snapshot().credentials, null);
});
