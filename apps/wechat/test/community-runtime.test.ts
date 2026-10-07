import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import { createCommunityRuntime } from '../src/community/runtime';
import type { WxApi } from '../src/platform/wechat';
import { FakeClock, flush } from './helpers';
const localWx = (): WxApi => ({
  request: () => {
    throw new Error('Network forbidden');
  },
  login: () => {
    throw new Error('Provider forbidden');
  },
  getStorageSync: () => {
    throw new Error('Startup storage forbidden');
  },
  setStorageSync: () => {
    throw new Error('Storage forbidden');
  },
  removeStorageSync: () => {
    throw new Error('Storage forbidden');
  },
});
test('community startup is local and secure UUID generation fails closed without native support', async () => {
  const clock = new FakeClock(),
    runtime = createCommunityRuntime(
      { sessions: new SessionStore() },
      localWx(),
      'synthetic',
      clock,
    );
  assert.equal(runtime.gateway, undefined);
  await assert.rejects(runtime.newRequestId(), { kind: 'configuration' });
  assert.equal(clock.timers, 0);
});
test('native request UUID is v4 from exact random bytes, bounded when callback is missing', async () => {
  const wx = localWx(),
    clock = new FakeClock();
  wx.getRandomValues = (options) =>
    options.success({ randomValues: new Uint8Array(16).fill(255).buffer });
  const runtime = createCommunityRuntime(
    { sessions: new SessionStore() },
    wx,
    'synthetic',
    clock,
  );
  assert.equal(
    await runtime.newRequestId(),
    'ffffffff-ffff-4fff-bfff-ffffffffffff',
  );
  assert.equal(clock.timers, 0);
  wx.getRandomValues = () => undefined;
  const pending = runtime.newRequestId();
  await flush();
  clock.advance(5000);
  await assert.rejects(pending, { kind: 'timeout' });
  assert.equal(clock.timers, 0);
  wx.getRandomValues = (options) =>
    options.success({ randomValues: new ArrayBuffer(4) });
  await assert.rejects(runtime.newRequestId(), { kind: 'protocol' });
});
