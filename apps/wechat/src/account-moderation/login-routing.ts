import type { IdentityRuntime } from '../auth/runtime';
import type { Cancellation } from '../platform/contracts';
import type { WxApi } from '../platform/wechat';
import { HttpModerationGateway } from './gateway';
/** Failed/unknown status never discards credentials or invents a guest context. */
export async function routeSuspendedLogin(
  runtime: IdentityRuntime,
  wx: WxApi,
  cancellation: Cancellation,
  current: () => boolean,
): Promise<void> {
  const owner = runtime.sessions.snapshot();
  if (!owner.credentials || !runtime.api || !wx.navigateTo) return;
  try {
    const status = await new HttpModerationGateway(runtime.api).status(
      cancellation,
    );
    runtime.sessions.assertCurrent(owner);
    if (
      cancellation.isCancelled ||
      !current() ||
      status.effective !== 'access_suspension'
    )
      return;
    wx.navigateTo({
      url: '/pages/account-status/account-status',
      success() {},
      fail() {},
    });
  } catch {
    /* Keep the session and visible account-status entry available for retry. */
  }
}
