/** Reserve the real WeChat status/capsule strip; never copy screenshot status bars. */
export interface SafeTopNative {
  getWindowInfo?(): { statusBarHeight?: number };
  getSystemInfoSync?(): { statusBarHeight?: number };
  getMenuButtonBoundingClientRect?(): {
    top: number;
    bottom: number;
    height: number;
  };
}
export function safeTopHeight(native: SafeTopNative): number | null {
  let status: number | undefined;
  let bottom: number | undefined;
  try {
    status = native.getWindowInfo?.().statusBarHeight;
  } catch {
    /* older host */
  }
  if (status === undefined) {
    try {
      status = native.getSystemInfoSync?.().statusBarHeight;
    } catch {
      /* CSS fallback */
    }
  }
  try {
    const rect = native.getMenuButtonBoundingClientRect?.();
    if (
      rect &&
      Number.isFinite(rect.top) &&
      Number.isFinite(rect.bottom) &&
      rect.top >= 0 &&
      rect.bottom > rect.top &&
      rect.bottom <= 240 &&
      rect.height > 0
    )
      bottom = rect.bottom + 8;
  } catch {
    /* CSS fallback */
  }
  const validStatus =
    typeof status === 'number' &&
    Number.isFinite(status) &&
    status >= 0 &&
    status <= 160;
  if (!validStatus && bottom === undefined) return null;
  return Math.max(validStatus ? status! + 44 : 0, bottom ?? 0);
}
