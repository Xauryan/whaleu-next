import assert from 'node:assert/strict';
import type { WxApi, WxIntersectionObserver } from '../src/platform/wechat';
export function nativeObservation() {
  const observers: {
    selector: string;
    disconnected: boolean;
    emit(ratio: number): void;
  }[] = [];
  const ticks: (() => void)[] = [];
  const wx: Pick<WxApi, 'createIntersectionObserver' | 'nextTick'> = {
    nextTick(callback) {
      ticks.push(callback);
    },
    createIntersectionObserver(_page, options) {
      assert.deepEqual(options, { thresholds: [0, 0.5], initialRatio: 0 });
      let callback:
        ((result: { intersectionRatio: number }) => void) | undefined;
      const record = {
        selector: '',
        disconnected: false,
        emit(ratio: number) {
          callback?.({ intersectionRatio: ratio });
        },
      };
      observers.push(record);
      const observer: WxIntersectionObserver = {
        relativeToViewport() {
          return observer;
        },
        observe(selector, cb) {
          record.selector = selector;
          callback = cb;
        },
        disconnect() {
          record.disconnected = true;
        },
      };
      return observer;
    },
  };
  return {
    wx,
    observers,
    tick() {
      for (const fn of ticks.splice(0)) fn();
    },
  };
}
