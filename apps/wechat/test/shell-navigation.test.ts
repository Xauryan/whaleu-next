import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeRoute,
  destinations,
  ShellNavigator,
} from '../src/shell/navigation';
import type { WxApi } from '../src/platform/wechat';

test('compose requires a canonical destination and never accepts injected routes', () => {
  assert.equal(composeRoute(''), '/pages/compose-entry/compose-entry');
  assert.equal(
    composeRoute('bad&id=secret'),
    '/pages/compose-entry/compose-entry',
  );
  assert.equal(
    composeRoute('10000000-0000-4000-8000-000000000001'),
    '/pages/community-compose/community-compose?spaceId=10000000-0000-4000-8000-000000000001&category=discussion',
  );
});
test('root destinations replace stack; compose preserves caller; repeated taps are single-flight', () => {
  const calls: {
    kind: string;
    options: Parameters<NonNullable<WxApi['navigateTo']>>[0];
  }[] = [];
  const navigation = new ShellNavigator({
    reLaunch: (options) => calls.push({ kind: 'root', options }),
    navigateTo: (options) => calls.push({ kind: 'child', options }),
  });
  let failures = 0;
  const failed = () => failures++;
  navigation.open('home', 'home', '', failed);
  navigation.open('unknown', 'home', '', failed);
  assert.equal(calls.length, 0);
  navigation.open('campus', 'home', '', failed);
  navigation.open('me', 'home', '', failed);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options.url, destinations.campus);
  calls[0]?.options.success();
  navigation.open('compose', 'campus', '', failed);
  assert.equal(calls[1]?.kind, 'child');
  calls[1]?.options.fail({ errMsg: 'sensitive native error must not escape' });
  assert.equal(failures, 1);
  navigation.open('messages', 'campus', '', failed);
  assert.equal(calls[2]?.options.url, destinations.messages);
});
test('unavailable native navigation fails visibly without throwing', () => {
  let failures = 0;
  new ShellNavigator({}).open('me', 'home', '', () => failures++);
  assert.equal(failures, 1);
});

test('Home from Hot remains navigable even when Home section is highlighted', () => {
  let url = '';
  new ShellNavigator({
    reLaunch: (options) => {
      url = options.url;
    },
  }).open('home', 'hot', '', () =>
    assert.fail('navigation should be available'),
  );
  assert.equal(url, destinations.home);
});

test('synchronous native errors release the latch; detached callbacks cannot update UI', () => {
  let failures = 0;
  const throwing = new ShellNavigator({
    reLaunch: () => {
      throw new Error('native failure');
    },
  });
  throwing.open('me', 'home', '', () => failures++);
  throwing.open('campus', 'home', '', () => failures++);
  assert.equal(failures, 2);
  let callback: (() => void) | undefined;
  const detached = new ShellNavigator({
    reLaunch: (options) => {
      callback = () => options.fail({});
    },
  });
  detached.open('me', 'home', '', () => failures++);
  detached.dispose();
  callback?.();
  detached.open('campus', 'home', '', () => failures++);
  assert.equal(failures, 2);
});
