import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WechatLogin,
  WechatStorage,
  WechatTransport,
  type WxApi,
} from '../src/platform/wechat';
import { Cancellation, type HttpRequest } from '../src/platform/contracts';
import { FakeClock } from './helpers';

const request: HttpRequest = {
  url: 'https://example.invalid/test',
  method: 'GET',
  headers: {},
  timeoutMs: 100,
};

test('wx transport normalizes header case and settles once despite duplicate callbacks', async () => {
  const clock = new FakeClock();
  const transport = new WechatTransport(
    {
      request(options) {
        options.success({
          statusCode: 200,
          header: { 'X-Request-Id': 'synthetic', Ignored: 22 },
          data: { value: 1 },
        });
        options.fail({ errMsg: 'second callback' });
        return { abort() {} };
      },
    },
    clock,
  );
  const result = await transport.send(request);
  assert.deepEqual(result, {
    status: 200,
    body: { value: 1 },
    headers: { 'x-request-id': 'synthetic' },
  });
  assert.equal(clock.timers, 0);
});
test('wx transport bounds a missing native callback and aborts the native task', async () => {
  const clock = new FakeClock();
  let aborted = 0;
  const transport = new WechatTransport(
    {
      request() {
        return {
          abort() {
            aborted += 1;
          },
        };
      },
    },
    clock,
  );
  const promise = transport.send(request);
  const rejected = assert.rejects(promise, { kind: 'timeout' });
  clock.advance(100);
  await rejected;
  assert.equal(aborted, 1);
  assert.equal(clock.timers, 0);
});
test('native late success after timeout cannot change the settled result', async () => {
  const clock = new FakeClock();
  let options!: Parameters<WxApi['request']>[0];
  const transport = new WechatTransport(
    {
      request(value) {
        options = value;
        return { abort() {} };
      },
    },
    clock,
  );
  const promise = transport.send(request);
  const rejected = assert.rejects(promise, { kind: 'timeout' });
  clock.advance(100);
  options.success({ statusCode: 200, data: {} });
  await rejected;
});
test('synchronous native bridge exception is sanitized and timer is cleared', async () => {
  const clock = new FakeClock();
  const transport = new WechatTransport(
    {
      request() {
        throw new Error('payload: sensitive synthetic sentinel');
      },
    },
    clock,
  );
  await assert.rejects(transport.send(request), (error) => {
    assert.equal((error as { kind: string }).kind, 'network');
    assert.equal(String(error).includes('sentinel'), false);
    return true;
  });
  assert.equal(clock.timers, 0);
});
test('in-flight cancellation aborts exactly once and clears its timer', async () => {
  const clock = new FakeClock();
  const cancellation = new Cancellation();
  let aborts = 0;
  const transport = new WechatTransport(
    {
      request() {
        return {
          abort() {
            aborts += 1;
          },
        };
      },
    },
    clock,
  );
  const promise = transport.send({ ...request, cancellation });
  const rejected = assert.rejects(promise, { kind: 'cancelled' });
  cancellation.cancel();
  cancellation.cancel();
  await rejected;
  assert.equal(aborts, 1);
  assert.equal(clock.timers, 0);
});
test('pre-cancelled request never enters wx.request', async () => {
  const cancellation = new Cancellation();
  cancellation.cancel();
  let calls = 0;
  const transport = new WechatTransport(
    {
      request() {
        calls += 1;
        return { abort() {} };
      },
    },
    new FakeClock(),
  );
  await assert.rejects(transport.send({ ...request, cancellation }), {
    kind: 'cancelled',
  });
  assert.equal(calls, 0);
});
test('native timeout and cancellation failures get stable typed categories', async () => {
  for (const [native, kind] of [
    ['request:fail timeout', 'timeout'],
    ['request:fail abort', 'cancelled'],
    ['request:fail secret-url', 'network'],
  ]) {
    const transport = new WechatTransport(
      {
        request(options) {
          options.fail({ errMsg: native });
          return { abort() {} };
        },
      },
      new FakeClock(),
    );
    await assert.rejects(transport.send(request), { kind });
  }
});
test('invalid timeout is rejected before native request', async () => {
  let calls = 0;
  const transport = new WechatTransport(
    {
      request() {
        calls += 1;
        return { abort() {} };
      },
    },
    new FakeClock(),
  );
  for (const timeoutMs of [0, -1, Infinity, NaN, 120_001])
    await assert.rejects(transport.send({ ...request, timeoutMs }), {
      kind: 'configuration',
    });
  assert.equal(calls, 0);
});
test('native login validates code and clears deadline', async () => {
  const clock = new FakeClock();
  const login = new WechatLogin(
    {
      login(options) {
        options.success({ code: 'synthetic-code' });
      },
    },
    clock,
  );
  assert.equal(await login.login(), 'synthetic-code');
  assert.equal(clock.timers, 0);
  const invalid = new WechatLogin(
    {
      login(options) {
        options.success({});
      },
    },
    clock,
  );
  await assert.rejects(invalid.login(), { kind: 'protocol' });
  assert.equal(clock.timers, 0);
});
test('native login missing callback is bounded; late callback is ignored', async () => {
  const clock = new FakeClock();
  let options!: Parameters<WxApi['login']>[0];
  const login = new WechatLogin(
    {
      login(value) {
        options = value;
      },
    },
    clock,
    100,
  );
  const pending = login.login();
  const rejected = assert.rejects(pending, { kind: 'timeout' });
  clock.advance(100);
  options.success({ code: 'late-synthetic' });
  await rejected;
});
test('storage adapter delegates only the requested namespaced key', () => {
  const calls: unknown[] = [];
  const storage = new WechatStorage({
    getStorageSync(key) {
      calls.push(['get', key]);
      return { value: 1 };
    },
    setStorageSync(key, value) {
      calls.push(['set', key, value]);
    },
    removeStorageSync(key) {
      calls.push(['remove', key]);
    },
  });
  assert.deepEqual(storage.get('synthetic-key'), { value: 1 });
  storage.set('synthetic-key', {});
  storage.remove('synthetic-key');
  assert.deepEqual(calls, [
    ['get', 'synthetic-key'],
    ['set', 'synthetic-key', {}],
    ['remove', 'synthetic-key'],
  ]);
});
