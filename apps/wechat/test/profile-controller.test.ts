import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import {
  ProfileController,
  type ProfileView,
} from '../src/pages/profile/controller';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { FakeProfileGateway, ownProfile } from './profile-helpers';
function setup(loggedIn = true, configured = true) {
  const sessions = new SessionStore();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new FakeProfileGateway(),
    views: ProfileView[] = [];
  const controller = new ProfileController(
    sessions,
    configured ? gateway : undefined,
    (view) => views.push(view),
  );
  return {
    sessions,
    gateway,
    views,
    controller,
    view: () => views[views.length - 1]!,
  };
}
test('profile loads server defaults and saves fields separately without overwriting other unsaved edits', async () => {
  const s = setup();
  await s.controller.load();
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().preferences.length, 11);
  assert.equal(s.view().nickname, '');
  s.controller.setBio('新简介');
  s.controller.setPreference('showHotTopic', false);
  await s.controller.saveProfile();
  assert.equal(s.view().preferencesDirty, true);
  assert.equal(
    s.view().preferences.find((row) => row.key === 'showHotTopic')?.checked,
    false,
  );
  s.controller.setNickname('新昵称');
  await s.controller.savePreferences();
  assert.equal(s.view().profileDirty, true);
  assert.equal(s.view().nickname, '新昵称');
  assert.equal(s.view().preferencesDirty, false);
  assert.deepEqual(
    s.gateway.calls.filter((call) => call.method === 'updateProfile')[0]?.body,
    { expectedRevision: 0, bio: '新简介' },
  );
  assert.equal(
    (
      s.gateway.calls.find((call) => call.method === 'preferences')?.body as {
        expectedRevision: number;
      }
    ).expectedRevision,
    1,
  );
  await s.controller.saveProfile();
  assert.equal(s.gateway.current.revision, 3);
});
test('invalid nickname, bio length/newlines/surrogates never reach gateway and a blank unset nickname permits bio-only edits', async () => {
  const s = setup();
  await s.controller.load();
  for (const nickname of ['bad space', '🐳', 'a'.repeat(21)]) {
    s.controller.setNickname(nickname);
    await s.controller.saveProfile();
    assert.ok(s.view().validationError);
  }
  s.controller.cancelEdits();
  for (const bio of ['a'.repeat(101), 'a\n'.repeat(6) + 'b', '\ud800']) {
    s.controller.setBio(bio);
    await s.controller.saveProfile();
    assert.ok(s.view().validationError);
  }
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'updateProfile').length,
    0,
  );
  s.controller.setBio('  正常\r\n简介  ');
  await s.controller.saveProfile();
  assert.equal(s.gateway.current.bio, '正常\n简介');
  assert.equal(s.gateway.current.nickname, null);
});
test('preference mode changes are mutually exclusive, cancellation restores only server-confirmed values', async () => {
  const s = setup();
  await s.controller.load();
  s.controller.setPreference('defaultCommentAnonymousEnabled', true);
  s.controller.setPreference('defaultCommentNonAnonymousEnabled', true);
  assert.equal(
    s
      .view()
      .preferences.find((row) => row.key === 'defaultCommentAnonymousEnabled')
      ?.checked,
    false,
  );
  await s.controller.savePreferences();
  const patch = s.gateway.calls.find((call) => call.method === 'preferences')
    ?.body as { preferences: Record<string, boolean> };
  assert.equal(patch.preferences.defaultCommentAnonymousEnabled, false);
  assert.equal(patch.preferences.defaultCommentNonAnonymousEnabled, true);
  s.controller.setNickname('未保存');
  s.controller.setPreference('showHotTopic', false);
  s.controller.cancelEdits();
  assert.equal(s.view().nickname, '');
  assert.equal(s.view().profileDirty, false);
  assert.equal(s.view().preferencesDirty, false);
});
test('revision conflict retains drafts, refuses blind replay and stays locked after failed reload', async () => {
  const s = setup();
  await s.controller.load();
  s.controller.setNickname('我的草稿');
  s.gateway.updateProfileImpl = async () => {
    throw new ClientError('business', 'safe', {
      httpStatus: 409,
      serverCode: 'PROFILE_REVISION_CONFLICT',
    });
  };
  await s.controller.saveProfile();
  assert.equal(s.view().needsReload, true);
  assert.equal(s.view().nickname, '我的草稿');
  assert.match(s.view().error, /不会自动覆盖/);
  await s.controller.saveProfile();
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'updateProfile').length,
    1,
  );
  s.gateway.profileImpl = async () => {
    throw new ClientError('network', 'safe');
  };
  await s.controller.load();
  assert.equal(s.view().needsReload, true);
  s.controller.cancelEdits();
  assert.equal(s.view().needsReload, true);
  s.gateway.profileImpl = async () =>
    ownProfile({ nickname: '其他设备', revision: 2 });
  await s.controller.load();
  assert.equal(s.view().needsReload, false);
  assert.equal(s.view().nickname, '其他设备');
});
test('uncertain save is not retried, explicit reload establishes committed server state', async () => {
  const s = setup();
  await s.controller.load();
  s.controller.setBio('已提交');
  s.gateway.updateProfileImpl = async () => {
    s.gateway.current = ownProfile({ bio: '已提交', revision: 1 });
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.saveProfile();
  assert.equal(s.view().needsReload, true);
  assert.match(s.view().error, /保存结果尚未确认/);
  await s.controller.saveProfile();
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'updateProfile').length,
    1,
  );
  await s.controller.load();
  assert.equal(s.view().bio, '已提交');
  assert.equal(s.view().profileDirty, false);
});
test('save cancellation and duplicate taps never claim rollback or issue a second mutation', async () => {
  const s = setup();
  await s.controller.load();
  s.controller.setBio('等待');
  const late = deferred<ReturnType<typeof ownProfile>>();
  s.gateway.updateProfileImpl = () => late.promise;
  const pending = s.controller.saveProfile();
  await flush();
  await s.controller.saveProfile();
  s.controller.cancelOperation();
  await pending;
  assert.equal(s.view().needsReload, true);
  assert.match(s.view().error, /请求可能已保存/);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'updateProfile').length,
    1,
  );
  const count = s.views.length;
  late.resolve(ownProfile({ bio: '等待', revision: 1 }));
  await flush();
  assert.equal(s.views.length, count);
});
test('same-tick cancel or account switch prevents dispatch; account switch synchronously wipes drafts', async () => {
  const s = setup();
  let pending = s.controller.load();
  s.controller.cancelOperation();
  await pending;
  assert.equal(s.gateway.calls.length, 0);
  await s.controller.load();
  s.controller.setNickname('前账号隐私');
  pending = s.controller.saveProfile();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: '99999999-9999-4999-8999-999999999999',
  });
  assert.equal(s.view().nickname, '');
  assert.equal(s.view().preferences.length, 0);
  await pending;
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'updateProfile').length,
    0,
  );
  s.gateway.current = ownProfile({
    accountId: s.sessions.snapshot().credentials!.accountId,
  });
  await s.controller.load();
  assert.equal(s.view().loaded, true);
});
test('late read or save from a prior login cannot populate a new same-account session', async () => {
  const s = setup(),
    late = deferred<ReturnType<typeof ownProfile>>();
  s.gateway.profileImpl = () => late.promise;
  const pending = s.controller.load();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
  late.resolve(ownProfile({ nickname: '旧会话' }));
  await pending;
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().nickname, '');
  assert.match(s.view().status, /登录状态已改变/);
});
test('newer read wins; disposed hidden pages clear private data and cannot render a late response', async () => {
  const s = setup(),
    late = deferred<ReturnType<typeof ownProfile>>();
  s.gateway.profileImpl = () => late.promise;
  const first = s.controller.load();
  await flush();
  s.gateway.profileImpl = async () => ownProfile({ nickname: '新结果' });
  await s.controller.load();
  await first;
  assert.equal(s.view().nickname, '新结果');
  late.resolve(ownProfile({ nickname: '旧结果' }));
  await flush();
  assert.equal(s.view().nickname, '新结果');
  const saving = deferred<ReturnType<typeof ownProfile>>();
  s.gateway.updateProfileImpl = () => saving.promise;
  s.controller.setBio('隐私草稿');
  const pending = s.controller.saveProfile();
  await flush();
  s.controller.dispose();
  assert.equal(s.view().nickname, '');
  assert.equal(s.view().bio, '');
  const count = s.views.length;
  saving.resolve(ownProfile({ revision: 1 }));
  await pending;
  assert.equal(s.views.length, count);
});
test('wrong account or non-monotonic save revision fails closed; expiry requires safe read before next save', async () => {
  const s = setup();
  s.gateway.profileImpl = async () =>
    ownProfile({ accountId: '99999999-9999-4999-8999-999999999999' });
  await s.controller.load();
  assert.equal(s.view().loaded, false);
  assert.ok(s.view().error);
  s.gateway.profileImpl = async () => ownProfile();
  await s.controller.load();
  s.controller.setNickname('测试');
  s.gateway.updateProfileImpl = async () =>
    ownProfile({ revision: 0, nickname: '测试' });
  await s.controller.saveProfile();
  assert.equal(s.view().needsReload, true);
  await s.controller.load();
  s.controller.setNickname('测试');
  s.gateway.updateProfileImpl = async () => {
    throw new ClientError('auth-expired', 'safe', {
      serverCode: 'ACCESS_TOKEN_EXPIRED',
      httpStatus: 401,
    });
  };
  await s.controller.saveProfile();
  assert.equal(s.view().needsReload, true);
  assert.match(s.view().error, /重新加载以刷新会话/);
});
test('unconfigured and logged-out pages never read data or send provider requests', async () => {
  for (const s of [setup(false), setup(true, false)]) {
    await s.controller.load();
    assert.equal(s.gateway.calls.length, 0);
    assert.equal(s.view().loaded, false);
    assert.ok(s.view().error);
  }
});
test('terminal revoked/blocked responses erase private drafts and local session, while a stale old-token 401 cannot erase refreshed credentials', async () => {
  for (const [kind, code] of [
    ['auth-required', 'SESSION_REVOKED'],
    ['forbidden', 'ACCOUNT_BLOCKED'],
  ] as const) {
    const s = setup();
    await s.controller.load();
    s.controller.setNickname('私密草稿');
    s.gateway.updateProfileImpl = async () => {
      throw new ClientError(kind, 'safe', {
        serverCode: code,
        httpStatus: kind === 'forbidden' ? 403 : 401,
      });
    };
    await s.controller.saveProfile();
    assert.equal(s.sessions.snapshot().credentials, null);
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().nickname, '');
    assert.equal(s.view().hasSession, false);
  }
  const s = setup();
  await s.controller.load();
  s.controller.setNickname('旧凭证草稿');
  const late = deferred<ReturnType<typeof ownProfile>>();
  s.gateway.updateProfileImpl = () => late.promise;
  const pending = s.controller.saveProfile();
  await flush();
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
  late.reject(
    new ClientError('auth-required', 'safe', { serverCode: 'SESSION_REVOKED' }),
  );
  await pending;
  assert.equal(
    s.sessions.snapshot().credentials?.accessToken,
    wireCredentials('b').accessToken,
  );
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().nickname, '');
  assert.match(s.view().error, /重新加载验证当前会话/);
});
