import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import {
  buildOwnProfileShare,
  initialProfileScanView,
  parseProfileScanRoute,
  ProfileScanner,
  type ProfileScannerNative,
} from '../src/pages/me/profile-actions';
import { publicProfile, profileId } from './discovery-helpers';
import { otherId, postId } from './community-helpers';
import { wireCredentials } from './identity-helpers';

const profilePath = `/pages/public-profile/public-profile?profileId=${profileId}`;
const postPath = `/pages/community-detail/community-detail?postId=${postId}`;
const setup = (loggedIn = true) => {
  const sessions = new SessionStore();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const modals: Parameters<
    NonNullable<ProfileScannerNative['showModal']>
  >[0][] = [];
  const scans: Parameters<NonNullable<ProfileScannerNative['scanCode']>>[0][] =
    [];
  const navigation: Parameters<
    NonNullable<ProfileScannerNative['navigateTo']>
  >[0][] = [];
  let view = initialProfileScanView();
  const native: ProfileScannerNative = {
    showModal: (options) => {
      modals.push(options);
    },
    scanCode: (options) => {
      scans.push(options);
    },
    navigateTo: (options) => {
      navigation.push(options);
    },
  };
  const scanner = new ProfileScanner(native, sessions, (next) => {
    view = next;
  });
  const confirm = (index: number) =>
    modals[index]!.success({ confirm: true, cancel: false });
  return {
    sessions,
    modals,
    scans,
    navigation,
    native,
    scanner,
    confirm,
    view: () => view,
  };
};

test('scan parser allows only exact public selectors; URLs, paths and query smuggling fail closed', () => {
  assert.deepEqual(parseProfileScanRoute(profilePath), {
    kind: 'profile',
    path: profilePath,
  });
  assert.deepEqual(parseProfileScanRoute(postPath), {
    kind: 'post',
    path: postPath,
  });
  const rejected: unknown[] = [
    null,
    undefined,
    {},
    [],
    12,
    '',
    profileId,
    `https://whaleu.com${profilePath}`,
    `https://evil.test/${profilePath}`,
    `//evil.test${profilePath}`,
    `javascript:${profilePath}`,
    `weixin://${profilePath}`,
    profilePath.slice(1),
    ` ${profilePath}`,
    `${profilePath} `,
    `${profilePath}\n`,
    `${profilePath}#redirect`,
    `${profilePath}&`,
    `${profilePath}?`,
    `${profilePath}&profileId=${otherId}`,
    `${profilePath}&profileId=${profileId}`,
    `${profilePath}&redirect=https://evil.test`,
    `${profilePath}&token=secret`,
    `${postPath}&rootCommentId=${profileId}`,
    `${postPath}&action=delete`,
    `${postPath}&admin=true`,
    `${postPath}&accountId=${profileId}`,
    `${profilePath}&next=${postPath}`,
    `${profilePath};action=delete`,
    profilePath.replace('profileId=', 'profileId%3d'),
    profilePath.replace('profileId=', 'profile%49d='),
    profilePath.replace('profileId=', 'profileId=%2f'),
    profilePath.replace('/pages/', '/pages/../pages/'),
    profilePath.replace('/pages/', '/pages//'),
    profilePath.replace(profileId, '11111111-1111-0111-8111-111111111111'),
    profilePath.replace(profileId, '11111111-1111-4111-7111-111111111111'),
    profilePath.replace(profileId, profileId.toUpperCase()),
    `/pages/me/me?profileId=${profileId}`,
    `/pages/login/login?profileId=${profileId}`,
    `/pages/community-mine/community-mine?postId=${postId}`,
    `/pages/admin/admin?profileId=${profileId}`,
    JSON.stringify({ path: profilePath }),
    profilePath.replace('?', '\\?'),
    `${profilePath}\u0000`,
    `${profilePath}%26token=secret`,
  ];
  // The fixture can contain only digits, so force an upper-case UUID segment.
  rejected.push(
    profilePath.replace(profileId, 'ABCDEFAB-1234-4123-8123-123456789abc'),
  );
  for (const value of rejected.filter((value) => value !== profilePath))
    assert.equal(parseProfileScanRoute(value), null, String(value));
});

test('scanner requires explanatory camera consent and confirms a generic route before native navigation', () => {
  const s = setup();
  s.scanner.scan();
  s.scanner.scan();
  assert.equal(s.modals.length, 1);
  assert.equal(s.scans.length, 0);
  assert.match(s.modals[0]!.content, /相机/);
  s.confirm(0);
  s.confirm(0);
  assert.equal(s.scans.length, 1);
  assert.deepEqual(
    [s.scans[0]!.onlyFromCamera, s.scans[0]!.scanType],
    [true, ['qrCode']],
  );
  s.scans[0]!.success({
    result: profilePath,
    path: '/pages/admin/admin?token=secret',
  });
  s.scans[0]!.success({ result: postPath });
  assert.equal(s.modals.length, 2);
  assert.equal(s.navigation.length, 0);
  assert.equal(JSON.stringify(s.modals).includes(profileId), false);
  s.confirm(1);
  s.confirm(1);
  assert.equal(s.navigation.length, 1);
  assert.equal(s.navigation[0]!.url, profilePath);
  s.navigation[0]!.success();
  assert.deepEqual(s.view(), initialProfileScanView());
  s.scanner.dispose();
});

test('scanner cancellation is quiet, malformed/native-path-only scans never navigate or expose raw text', () => {
  for (const step of [
    'preflight',
    'camera',
    'destination',
    'bad-result',
    'native-path',
  ] as const) {
    const s = setup();
    s.scanner.scan();
    if (step === 'preflight')
      s.modals[0]!.success({ confirm: false, cancel: true });
    else {
      s.confirm(0);
      if (step === 'camera')
        s.scans[0]!.fail({ errMsg: 'scanCode:fail cancel secret' });
      else if (step === 'bad-result')
        s.scans[0]!.success({ result: 'secret https://evil.test' });
      else if (step === 'native-path')
        s.scans[0]!.success({ path: profilePath });
      else {
        s.scans[0]!.success({ result: postPath });
        s.modals[1]!.success({ confirm: false, cancel: true });
      }
    }
    assert.equal(s.navigation.length, 0);
    assert.equal(s.view().busy, false);
    assert.equal(JSON.stringify(s.view()).includes('secret'), false);
    if (step === 'bad-result' || step === 'native-path')
      assert.match(s.view().error, /不支持/);
    else assert.equal(s.view().error, '');
    s.scanner.dispose();
  }
});

test('scanner denied camera permission stops without auth/settings changes or automatic retries', () => {
  const s = setup();
  s.scanner.scan();
  s.confirm(0);
  s.scans[0]!.fail({ errMsg: 'scanCode:fail auth deny secret' });
  assert.match(s.view().error, /相机权限/);
  assert.equal(s.view().error.includes('secret'), false);
  assert.equal(s.scans.length, 1);
  assert.equal(s.modals.length, 1);
  s.scanner.onHide();
  s.scanner.onShow();
  assert.equal(s.scans.length, 1);
  s.scanner.dispose();
});

test('native scan may hide/show the page and retains only safe result until visible confirmation', () => {
  for (const returnsBeforeShow of [true, false]) {
    const s = setup();
    s.scanner.scan();
    s.confirm(0);
    s.scanner.onHide();
    if (returnsBeforeShow) s.scans[0]!.success({ result: postPath });
    assert.equal(s.modals.length, 1);
    assert.equal(s.navigation.length, 0);
    s.scanner.onShow();
    if (!returnsBeforeShow) s.scans[0]!.success({ result: postPath });
    assert.equal(s.modals.length, 2);
    s.confirm(1);
    assert.equal(s.navigation[0]!.url, postPath);
    s.scanner.dispose();
  }
});

test('session switch, same-account relogin, logout and unload revoke all outstanding callbacks', () => {
  for (const phase of [
    'preflight',
    'scanning',
    'pending',
    'confirming',
    'navigating',
  ] as const) {
    for (const boundary of ['switch', 'relogin', 'logout', 'unload'] as const) {
      const s = setup();
      s.scanner.scan();
      if (phase !== 'preflight') s.confirm(0);
      if (phase === 'pending') s.scanner.onHide();
      if (['pending', 'confirming', 'navigating'].includes(phase))
        s.scans[0]!.success({ result: profilePath });
      if (phase === 'navigating') s.confirm(1);
      if (boundary === 'unload') s.scanner.dispose();
      else if (boundary === 'logout') s.sessions.logout();
      else
        s.sessions.completeLogin(s.sessions.beginLogin(), {
          ...wireCredentials('b'),
          ...(boundary === 'switch' ? { accountId: otherId } : {}),
        });
      const modalCount = s.modals.length;
      const navigationCount = s.navigation.length;
      s.scanner.onShow();
      for (const modal of [...s.modals])
        modal.success({ confirm: true, cancel: false });
      for (const scan of [...s.scans]) {
        scan.success({ result: postPath });
        scan.fail({ errMsg: 'scanCode:fail secret' });
      }
      for (const navigation of [...s.navigation])
        navigation.fail({ errMsg: 'secret' });
      assert.equal(s.modals.length, modalCount, `${phase}/${boundary}`);
      assert.equal(
        s.navigation.length,
        navigationCount,
        `${phase}/${boundary}`,
      );
      assert.equal(s.scanner.snapshot().error, '');
      s.scanner.dispose();
    }
  }
});

test('non-scanner hide revokes preflight and route-confirmation callbacks; refresh preserves scanner owner', () => {
  for (const phase of ['preflight', 'confirming'] as const) {
    const s = setup();
    s.scanner.scan();
    if (phase === 'confirming') {
      s.confirm(0);
      s.scans[0]!.success({ result: profilePath });
    }
    s.scanner.onHide();
    s.scanner.onShow();
    s.confirm(phase === 'preflight' ? 0 : 1);
    assert.equal(s.navigation.length, 0);
    assert.equal(s.scans.length, phase === 'preflight' ? 0 : 1);
    s.scanner.dispose();
  }
  const s = setup();
  s.scanner.scan();
  s.confirm(0);
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
  s.scans[0]!.success({ result: profilePath });
  s.confirm(1);
  assert.equal(s.navigation.length, 1);
  s.scanner.dispose();
});

test('missing native capability/logged-out actors fail safely; native exceptions clear busy state', () => {
  const signedOut = setup(false);
  signedOut.scanner.scan();
  assert.match(signedOut.view().error, /登录/);
  assert.equal(signedOut.modals.length, 0);
  signedOut.scanner.dispose();
  for (const missing of ['scanCode', 'showModal', 'navigateTo'] as const) {
    const s = setup();
    delete s.native[missing];
    s.scanner.scan();
    assert.match(s.view().error, /不支持/);
    assert.equal(s.view().busy, false);
    s.scanner.dispose();
  }
  for (const broken of ['showModal', 'scanCode', 'navigateTo'] as const) {
    const s = setup();
    s.native[broken] = () => {
      throw new Error('private native failure');
    };
    s.scanner.scan();
    if (broken !== 'showModal') s.confirm(0);
    if (broken === 'navigateTo') {
      s.scans[0]!.success({ result: profilePath });
      s.confirm(1);
    }
    assert.equal(s.view().busy, false);
    assert.ok(s.view().error);
    assert.doesNotMatch(s.view().error, /private/);
    s.scanner.dispose();
  }
});

test('public profile share has exact schema, packaged generic image, and no private or anonymous projections', () => {
  const s = setup();
  const owner = s.sessions.snapshot();
  const profile = publicProfile({ isOwn: true });
  const expected = {
    title: 'WhaleU 个人主页',
    path: profilePath,
    imageUrl: '/assets/share/profile.png',
  };
  const fallback = {
    title: 'WhaleU 校园社区',
    path: '/pages/community-feed/community-feed',
    imageUrl: '/assets/share/profile.png',
  };
  assert.deepEqual(buildOwnProfileShare(profile, s.sessions, owner), expected);
  for (const invalid of [
    undefined,
    null,
    { profileId },
    publicProfile(),
    { status: 'unavailable', profileId },
    { kind: 'anonymous', profileId },
    { ...profile, accountId: wireCredentials().accountId },
    { ...profile, token: 'secret' },
    { ...profile, profileId: `${profileId}&token=secret` },
    { ...profile, avatar: 'private-image' },
  ])
    assert.deepEqual(
      buildOwnProfileShare(invalid, s.sessions, owner),
      fallback,
    );
  assert.deepEqual(buildOwnProfileShare(profile, undefined, owner), fallback);
  assert.deepEqual(buildOwnProfileShare(profile, s.sessions, null), fallback);
  s.sessions.rotate(owner, wireCredentials('b'));
  assert.deepEqual(buildOwnProfileShare(profile, s.sessions, owner), expected);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('c'));
  assert.deepEqual(buildOwnProfileShare(profile, s.sessions, owner), fallback);
  s.sessions.logout();
  assert.deepEqual(
    buildOwnProfileShare(profile, s.sessions, s.sessions.snapshot()),
    fallback,
  );
  s.scanner.dispose();
});
