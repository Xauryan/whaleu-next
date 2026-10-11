import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionStore } from '../src/auth/session';
import {
  PhoneBindingController,
  decodePhoneReceipt,
  type PhoneGateway,
  type PhoneReceipt,
  type PhoneView,
} from '../src/verification/phone-binding';
import { deferred, MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
const id = '12345678-1234-4123-8123-123456789aaa';
const next = '12345678-1234-4123-8123-123456789bbb';
function fixture() {
  const storage = new MemoryStorage();
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const privateViews = new PrivateViewLifecycle();
  const calls: string[] = [];
  let state: PhoneReceipt['state'] = 'reserved';
  let current = id;
  let view!: PhoneView;
  const gateway: PhoneGateway = {
    reserve: async (key, replaces) => {
      calls.push(`reserve:${key}:${replaces}`);
      current = key;
      state = 'reserved';
      return { requestId: key, state };
    },
    read: async (key) => {
      calls.push(`read:${key}`);
      return { requestId: key, state };
    },
    authorize: async (key, code) => {
      calls.push(`authorize:${key}:${code}`);
      state = 'unknown';
      return { requestId: key, state };
    },
    close: async (key) => {
      calls.push(`close:${key}`);
      state = 'closed';
      return { requestId: key, state };
    },
  };
  let count = 0;
  const make = () =>
    new PhoneBindingController(
      sessions,
      gateway,
      storage,
      'https://api.example.test',
      async () => (count++ ? next : id),
      (v) => {
        view = v;
      },
      privateViews,
    );
  return {
    storage,
    sessions,
    privateViews,
    gateway,
    calls,
    make,
    view: () => view,
    state: (s: PhoneReceipt['state']) => {
      state = s;
    },
    current: () => current,
  };
}
test('explicit consent prepares durable original key; denied authorization sends no code; unknown is read-only recovery', async () => {
  const f = fixture(),
    controller = f.make();
  await controller.restore();
  assert.equal(f.calls.length, 0);
  await controller.prepare();
  assert.equal(f.view().phase, 'reserved');
  await controller.authorize({ errMsg: 'getPhoneNumber:fail user deny' });
  assert.equal(f.calls.filter((s) => s.startsWith('authorize')).length, 0);
  await controller.authorize({
    errMsg: 'getPhoneNumber:ok',
    code: 'single-use-private-code',
  });
  assert.equal(f.view().phase, 'unknown');
  await controller.authorize({
    errMsg: 'getPhoneNumber:ok',
    code: 'must-not-replay',
  });
  await controller.recover();
  assert.equal(f.calls.filter((s) => s.startsWith('authorize')).length, 1);
  assert.ok(
    !JSON.stringify([...f.storage.data.values()]).includes(
      'single-use-private-code',
    ),
  );
  controller.dispose();
  const restored = f.make();
  await restored.restore();
  assert.equal(f.view().requestId, id);
  assert.equal(f.view().phase, 'unknown');
  await restored.prepare();
  assert.equal(f.view().requestId, next);
  assert.ok(f.calls.includes(`reserve:${next}:${id}`));
  restored.dispose();
});
test('storage failure prevents reserve and provider code dispatch', async () => {
  const f = fixture(),
    controller = f.make();
  f.storage.failWrite = true;
  await controller.prepare();
  await controller.authorize({
    errMsg: 'getPhoneNumber:ok',
    code: 'not-dispatched',
  });
  assert.equal(f.calls.length, 0);
  controller.dispose();
});
test('late callbacks after logout cannot display success or issue new provider operations', async () => {
  const f = fixture(),
    controller = f.make();
  await controller.prepare();
  const pending = deferred<PhoneReceipt>();
  f.gateway.authorize = () => pending.promise;
  const running = controller.authorize({
    errMsg: 'getPhoneNumber:ok',
    code: 'code',
  });
  f.sessions.logout();
  pending.resolve({ requestId: id, state: 'verified' });
  await running;
  assert.equal(f.view().hasSession, false);
  assert.notEqual(f.view().phase, 'verified');
  await controller.authorize({ errMsg: 'getPhoneNumber:ok', code: 'other' });
});
test('strict status-only decoding refuses phone values and mismatched receipt origin', async () => {
  assert.throws(() =>
    decodePhoneReceipt({
      requestId: id,
      state: 'verified',
      phoneNumber: '13123456789',
    }),
  );
  assert.throws(() =>
    decodePhoneReceipt({ requestId: id, state: 'arbitrary' }),
  );
  const f = fixture(),
    controller = f.make();
  f.gateway.reserve = async () => ({ requestId: next, state: 'verified' });
  await controller.prepare();
  assert.equal(f.view().phase, 'recovering');
  controller.dispose();
});

test('root app-hide lifecycle scrubs phone status without deleting original recovery obligation', async () => {
  const f = fixture(),
    controller = f.make();
  await controller.prepare();
  assert.equal(f.view().requestId, id);
  const calls = f.calls.length;
  f.privateViews.clear();
  assert.equal(f.view().requestId, '');
  assert.equal(f.view().phase, 'idle');
  assert.equal(f.view().hasSession, false);
  await controller.authorize({
    errMsg: 'getPhoneNumber:ok',
    code: 'late-hidden-code',
  });
  assert.equal(f.calls.length, calls);
  const reopened = f.make();
  await reopened.restore();
  assert.equal(f.view().requestId, id);
  assert.equal(f.view().phase, 'reserved');
  reopened.dispose();
});
