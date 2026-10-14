import { Cancellation } from '../platform/contracts';

export interface ToolPosition {
  latitude: number;
  longitude: number;
}
export type ToolLocationResult =
  | { state: 'ready'; coordinateSystem: 'gcj02'; position: ToolPosition }
  | { state: 'denied' | 'cancelled' | 'unavailable' };
export interface ToolLocationPort {
  readonly enabled: boolean;
  locate(cancel: Cancellation): Promise<ToolLocationResult>;
}
export const disabledToolLocation: ToolLocationPort = {
  enabled: false,
  locate: async () => ({ state: 'unavailable' }),
};
/** A future admitted device adapter may inject this boundary. No production
 * getLocation call, permission declaration, or synthetic grant is installed. */
export interface ToolNativeLocation {
  getLocation(options: {
    type: 'gcj02';
    success(value: ToolPosition): void;
    fail(value: { errMsg?: string }): void;
  }): void;
}
export function nativeToolLocation(
  native: ToolNativeLocation,
): ToolLocationPort {
  return {
    enabled: true,
    locate(cancel) {
      return new Promise((resolve) => {
        let settled = false;
        let stop = () => undefined as void;
        const finish = (value: ToolLocationResult) => {
          if (settled) return;
          settled = true;
          stop();
          resolve(value);
        };
        stop = cancel.subscribe(() => finish({ state: 'cancelled' }));
        if (cancel.isCancelled) {
          stop();
          return;
        }
        try {
          native.getLocation({
            type: 'gcj02',
            success: (value) =>
              finish(
                validPosition(value)
                  ? {
                      state: 'ready',
                      coordinateSystem: 'gcj02',
                      position: {
                        latitude: value.latitude,
                        longitude: value.longitude,
                      },
                    }
                  : { state: 'unavailable' },
              ),
            fail: (value) =>
              finish({
                state: /cancel/i.test(value.errMsg ?? '')
                  ? 'cancelled'
                  : /deny|denied|auth/i.test(value.errMsg ?? '')
                    ? 'denied'
                    : 'unavailable',
              }),
          });
        } catch {
          finish({ state: 'unavailable' });
        }
      });
    },
  };
}
export function validPosition(value: ToolPosition): boolean {
  return (
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180
  );
}
