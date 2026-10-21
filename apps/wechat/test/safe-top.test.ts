import assert from 'node:assert/strict';
import test from 'node:test';
import { safeTopHeight } from '../src/components/safe-top/geometry';
test('safe top reserves real status and capsule geometry instead of device screenshot pixels', () => {
  assert.equal(
    safeTopHeight({
      getWindowInfo: () => ({ statusBarHeight: 47 }),
      getMenuButtonBoundingClientRect: () => ({
        top: 51,
        bottom: 83,
        height: 32,
      }),
    }),
    91,
  );
  assert.equal(
    safeTopHeight({
      getWindowInfo: () => ({ statusBarHeight: 24 }),
      getMenuButtonBoundingClientRect: () => ({
        top: 30,
        bottom: 62,
        height: 32,
      }),
    }),
    70,
  );
});
test('safe top tolerates old hosts and invalid capsule metrics without guessing an Android status bar', () => {
  assert.equal(
    safeTopHeight({ getSystemInfoSync: () => ({ statusBarHeight: 20 }) }),
    64,
  );
  assert.equal(
    safeTopHeight({
      getWindowInfo: () => ({ statusBarHeight: NaN }),
      getMenuButtonBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }),
    }),
    null,
  );
  assert.equal(
    safeTopHeight({
      getWindowInfo: () => {
        throw new Error('old');
      },
      getSystemInfoSync: () => ({ statusBarHeight: 0 }),
    }),
    44,
  );
  assert.equal(safeTopHeight({}), null);
  assert.equal(
    safeTopHeight({
      getMenuButtonBoundingClientRect: () => ({
        top: 4,
        bottom: 36,
        height: 32,
      }),
    }),
    44,
  );
});
