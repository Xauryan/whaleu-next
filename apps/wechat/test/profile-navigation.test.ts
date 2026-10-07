import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AuthorNavigator,
  authorProfilePath,
} from '../src/profile/author-navigation';
import { anonymous, otherId } from './community-helpers';
import { discoverySetup, namedAuthor, profileId } from './discovery-helpers';
import { wireCredentials } from './identity-helpers';
import type { WxApi } from '../src/platform/wechat';
test('author routing uses only exact named projection and rejects anonymous self/private overlay/dataset smuggling', () => {
  assert.equal(
    authorProfilePath(namedAuthor()),
    `/pages/public-profile/public-profile?profileId=${profileId}`,
  );
  for (const value of [
    undefined,
    null,
    anonymous(),
    { ...anonymous(), profileId },
    { ...namedAuthor(), accountId: otherId },
    { ...namedAuthor(), profileId: 'private-provider-id' },
    { profileId, displayName: 'overlay', accountId: otherId },
  ])
    assert.equal(authorProfilePath(value as never), null);
});
test('navigation repeated taps/lifecycle/failure never multiply dispatch or render a late callback', () => {
  const calls: Parameters<NonNullable<WxApi['navigateTo']>>[0][] = [];
  let failed = 0;
  const nav = new AuthorNavigator(
    { navigateTo: (options) => calls.push(options) },
    () => failed++,
  );
  nav.open(anonymous());
  assert.equal(calls.length, 0);
  nav.open(namedAuthor());
  nav.open(namedAuthor());
  assert.equal(calls.length, 1);
  calls[0]!.fail({ errMsg: 'private' });
  assert.equal(failed, 1);
  nav.open(namedAuthor());
  assert.equal(calls.length, 2);
  nav.dispose();
  calls[1]!.fail({});
  nav.open(namedAuthor());
  assert.equal(failed, 1);
  assert.equal(calls.length, 2);
});

test('late navigation failure after account, login epoch or root-hide change cannot alter the replacement view', () => {
  for (const boundary of ['account', 'same-login', 'app-hide'] as const) {
    const s = discoverySetup();
    let failure:
      Parameters<NonNullable<WxApi['navigateTo']>>[0]['fail'] | undefined;
    let errors = 0;
    const nav = new AuthorNavigator(
      {
        navigateTo: (options) => {
          failure = options.fail;
        },
      },
      () => errors++,
      s.runtime,
    );
    nav.open(namedAuthor());
    if (boundary === 'app-hide') s.runtime.privateViews!.clear();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        ...(boundary === 'account' ? { accountId: otherId } : {}),
      });
    failure!({ errMsg: 'private' });
    assert.equal(errors, 0);
    nav.dispose();
  }
});
