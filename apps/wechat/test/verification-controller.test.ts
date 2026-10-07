import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import {
  initialVerificationView,
  VerificationController,
} from '../src/pages/verification/controller';
import type { VerificationSummary } from '../src/verification/contract';
import { createVerificationRuntime } from '../src/verification/runtime';
import { deferred, flush, MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import { FakeVerificationGateway, summary } from './verification-helpers';

function setup(signedIn = true) {
  const storage = new MemoryStorage(),
    sessions = new SessionStore(storage);
  if (signedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new FakeVerificationGateway(),
    lifecycle = new PrivateViewLifecycle();
  let view = initialVerificationView();
  const controller = new VerificationController(
    sessions,
    gateway,
    (next) => {
      view = next;
    },
    lifecycle,
  );
  return {
    storage,
    sessions,
    gateway,
    lifecycle,
    controller,
    view: () => view,
  };
}
test('missing session/configuration has no status assertions, network requests, or false permission success', async () => {
  const s = setup(false);
  await s.controller.load();
  assert.equal(s.gateway.calls.length, 0);
  assert.equal(s.view().loaded, false);
  assert.deepEqual(s.view().rows, []);
  assert.match(s.view().error, /请先登录/);
  let view = initialVerificationView();
  const unconfigured = new VerificationController(
    s.sessions,
    undefined,
    (next) => {
      view = next;
    },
    s.lifecycle,
  );
  await unconfigured.load();
  assert.equal(view.loaded, false);
  assert.match(view.error, /尚未配置/);
  assert.equal(
    createVerificationRuntime({ sessions: s.sessions }).gateway,
    undefined,
  );
});
test('affiliation-only verification is valid, phone remains independent and unknown is distinct from unverified', async () => {
  const s = setup();
  s.gateway.implementation = async () =>
    summary({
      affiliation: { status: 'verified' },
      studentNumber: { status: 'unverified' },
      phone: { status: 'unavailable' },
      application: { status: 'pending' },
    });
  await s.controller.load();
  assert.equal(s.view().loaded, true);
  assert.deepEqual(
    s.view().rows.map((item) => item.value),
    ['已验证', '未验证', '状态未知或暂不可用', '等待审核'],
  );
  assert.match(
    s.view().rows[1]!.detail,
    /学生归属已验证，但未建立有效的学号验证/,
  );
  assert.match(s.view().rows[2]!.detail, /不等于未验证.*分别验证/);
  assert.match(s.view().rows[3]!.detail, /不代表已经通过/);
  s.gateway.implementation = async () =>
    summary({
      affiliation: { status: 'revoked' },
      studentNumber: { status: 'expired' },
      phone: { status: 'verified' },
      application: { status: 'rejected' },
    });
  await s.controller.load();
  assert.deepEqual(
    s.view().rows.map((item) => item.value),
    ['已撤销', '已过期', '已验证', '申请未通过'],
  );
});
test('read-only summary retains neither private values nor verification state in device storage', async () => {
  const s = setup(),
    before = JSON.stringify([...s.storage.data]);
  s.gateway.implementation = async () =>
    summary({
      affiliation: { status: 'verified' },
      studentNumber: { status: 'verified' },
      phone: { status: 'verified' },
    });
  await s.controller.load();
  const data = JSON.stringify(s.view());
  for (const secret of [
    'accessToken',
    'refreshToken',
    wireCredentials().accountId,
    'legalName',
    'evidenceUrl',
    'phoneNumber',
  ])
    assert.equal(data.includes(secret), false);
  assert.equal(JSON.stringify([...s.storage.data]), before);
  s.controller.dispose();
  assert.equal(JSON.stringify([...s.storage.data]), before);
});
test('unknown/extra data from an alternate gateway fails closed without rendering its values', async () => {
  const s = setup();
  s.gateway.implementation = async () =>
    ({
      ...summary(),
      phone: { status: 'verified', value: '+12025550123' },
    }) as VerificationSummary;
  await s.controller.load();
  assert.equal(s.view().loaded, false);
  assert.deepEqual(s.view().rows, []);
  assert.equal(JSON.stringify(s.view()).includes('+12025550123'), false);
  assert.ok(s.view().error);
});
test('refresh clears previous snapshot synchronously and repeated taps do not duplicate an active request', async () => {
  const s = setup();
  await s.controller.load();
  const late = deferred<VerificationSummary>();
  s.gateway.implementation = () => late.promise;
  const pending = s.controller.load();
  assert.equal(s.view().loaded, false);
  assert.deepEqual(s.view().rows, []);
  await s.controller.load();
  await flush();
  assert.equal(s.gateway.calls.length, 2);
  late.resolve(summary());
  await pending;
  assert.equal(s.view().loaded, true);
});
for (const action of [
  'cancel',
  'dispose',
  'app-hide',
  'logout',
  'same-account-login',
  'account-switch',
] as const) {
  test(`${action} before dispatch prevents summary request and clears status`, async () => {
    const s = setup();
    const pending = s.controller.load();
    if (action === 'cancel') s.controller.cancel();
    if (action === 'dispose') s.controller.dispose();
    if (action === 'app-hide') s.lifecycle.clear();
    if (action === 'logout') s.sessions.logout();
    if (action === 'same-account-login' || action === 'account-switch')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId:
          action === 'account-switch'
            ? '99999999-9999-4999-8999-999999999999'
            : wireCredentials().accountId,
      });
    await pending;
    assert.equal(s.gateway.calls.length, 0);
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().loading, false);
    assert.deepEqual(s.view().rows, []);
  });
  test(`${action} cancels an in-flight read and suppresses late account status`, async () => {
    const s = setup(),
      late = deferred<VerificationSummary>();
    s.gateway.implementation = () => late.promise;
    const pending = s.controller.load();
    await flush();
    if (action === 'cancel') s.controller.cancel();
    if (action === 'dispose') s.controller.dispose();
    if (action === 'app-hide') s.lifecycle.clear();
    if (action === 'logout') s.sessions.logout();
    if (action === 'same-account-login' || action === 'account-switch')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId:
          action === 'account-switch'
            ? '99999999-9999-4999-8999-999999999999'
            : wireCredentials().accountId,
      });
    assert.equal(s.gateway.calls[0]?.isCancelled, true);
    assert.deepEqual(s.view().rows, []);
    late.resolve(summary({ affiliation: { status: 'verified' } }));
    await pending;
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().loading, false);
    assert.deepEqual(s.view().rows, []);
  });
}
test('hiding a loaded page clears immediately, suppresses background reload and a new foreground controller reads fresh', async () => {
  const s = setup();
  await s.controller.load();
  s.lifecycle.clear();
  assert.equal(s.view().loaded, false);
  assert.deepEqual(s.view().rows, []);
  await s.controller.load();
  assert.equal(s.gateway.calls.length, 1);
  s.controller.dispose();
  let view = initialVerificationView();
  const reopened = new VerificationController(
    s.sessions,
    s.gateway,
    (next) => {
      view = next;
    },
    s.lifecycle,
  );
  s.gateway.implementation = async () =>
    summary({ application: { status: 'pending' } });
  await reopened.load();
  assert.equal(view.rows[3]?.value, '等待审核');
  assert.equal(s.gateway.calls.length, 2);
});
test('session token rotation during an own-account read is allowed without assuming a new account', async () => {
  const s = setup(),
    late = deferred<VerificationSummary>();
  s.gateway.implementation = () => late.promise;
  const pending = s.controller.load();
  await flush();
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
  late.resolve(summary());
  await pending;
  assert.equal(s.view().loaded, true);
});
test('late old-token rejection does not erase a refreshed login', async () => {
  const s = setup(),
    late = deferred<VerificationSummary>();
  s.gateway.implementation = () => late.promise;
  const pending = s.controller.load();
  await flush();
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
  late.reject(new ClientError('auth-required', 'private diagnostic'));
  await pending;
  assert.equal(
    s.sessions.snapshot().credentials?.accessToken,
    wireCredentials('b').accessToken,
  );
  assert.equal(s.view().loaded, false);
  assert.match(s.view().error, /登录凭证已更新/);
  assert.equal(JSON.stringify(s.view()).includes('private diagnostic'), false);
});
test('revoked or blocked current session is cleared; ordinary permission denial is not a verification result', async () => {
  for (const blocked of [false, true]) {
    const s = setup();
    s.gateway.implementation = async () => {
      throw blocked
        ? new ClientError('forbidden', 'private diagnostic', {
            httpStatus: 403,
            serverCode: 'ACCOUNT_BLOCKED',
          })
        : new ClientError('auth-required', 'private diagnostic');
    };
    await s.controller.load();
    assert.equal(s.sessions.snapshot().credentials, null);
    assert.equal(s.view().hasSession, false);
    assert.deepEqual(s.view().rows, []);
  }
  const s = setup();
  s.gateway.implementation = async () => {
    throw new ClientError('forbidden', 'private diagnostic', {
      httpStatus: 403,
      serverCode: 'FORBIDDEN',
    });
  };
  await s.controller.load();
  assert.ok(s.sessions.snapshot().credentials);
  assert.equal(s.view().loaded, false);
  assert.deepEqual(s.view().rows, []);
  assert.match(s.view().error, /没有此操作权限/);
});
test('storage failure clearing rejected login leaves no summary and warns about local credential cleanup', async () => {
  const s = setup();
  s.storage.failRemove = true;
  s.gateway.implementation = async () => {
    throw new ClientError('auth-required', 'private diagnostic');
  };
  await s.controller.load();
  assert.equal(s.sessions.snapshot().credentials, null);
  assert.deepEqual(s.view().rows, []);
  assert.match(s.view().error, /存储.*清理/);
});
test('network failure, timeout and cancellation never manufacture unverified or retain the previous snapshot', async () => {
  for (const kind of ['network', 'timeout', 'cancelled'] as const) {
    const s = setup();
    await s.controller.load();
    s.gateway.implementation = async () => {
      throw new ClientError(kind, 'private diagnostic');
    };
    await s.controller.load();
    assert.equal(s.view().loaded, false);
    assert.deepEqual(s.view().rows, []);
    assert.match(s.view().status, /未能确认/);
  }
});

test('cancel then retry cannot be overwritten by the earlier late result', async () => {
  const s = setup(),
    late = deferred<VerificationSummary>();
  s.gateway.implementation = () => late.promise;
  const first = s.controller.load();
  await flush();
  s.controller.cancel();
  s.gateway.implementation = async () =>
    summary({ phone: { status: 'revoked' } });
  await s.controller.load();
  assert.equal(s.view().rows[2]?.value, '已撤销');
  late.resolve(summary({ phone: { status: 'verified' } }));
  await first;
  assert.equal(s.view().rows[2]?.value, '已撤销');
  assert.equal(s.gateway.calls.length, 2);
});
test('new-account result remains intact after an old-account late result settles', async () => {
  const s = setup(),
    late = deferred<VerificationSummary>();
  s.gateway.implementation = () => late.promise;
  const first = s.controller.load();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: '99999999-9999-4999-8999-999999999999',
  });
  s.gateway.implementation = async () =>
    summary({
      affiliation: { status: 'unverified' },
      phone: { status: 'verified' },
    });
  await s.controller.load();
  late.resolve(
    summary({
      affiliation: { status: 'verified' },
      phone: { status: 'unverified' },
    }),
  );
  await first;
  assert.deepEqual(
    s
      .view()
      .rows.slice(0, 3)
      .map((row) => row.value),
    ['未验证', '状态未知或暂不可用', '已验证'],
  );
});
test('a loaded snapshot clears synchronously on logout even if storage removal fails', async () => {
  const s = setup();
  await s.controller.load();
  assert.equal(s.view().loaded, true);
  s.storage.failRemove = true;
  assert.throws(() => s.sessions.logout(), { kind: 'storage' });
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().hasSession, false);
  assert.deepEqual(s.view().rows, []);
});

test('no current pending application does not claim there is no application history or imply verified status', async () => {
  const s = setup();
  s.gateway.implementation = async () =>
    summary({ application: { status: 'none' } });
  await s.controller.load();
  assert.equal(s.view().rows[3]?.value, '暂无待处理申请');
  assert.match(s.view().rows[3]!.detail, /不据此判断历史申请或认证结果/);
  assert.equal(s.view().rows[0]?.value, '状态未知或暂不可用');
});
