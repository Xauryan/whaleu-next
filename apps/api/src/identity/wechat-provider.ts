import { ApplicationError } from '../http/application-error.js';
import type { RuntimeConfig } from '../config/config.js';
import type { IdentityProvider, ProviderIdentity } from './contracts.js';
import { loginRequestSchema } from './contracts.js';
import { z } from 'zod';

const identityValue = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const exchangeResponse = z.object({
  errcode: z.number().int().optional(),
  openid: identityValue.optional(),
  unionid: identityValue.optional(),
  session_key: z
    .string()
    .regex(/^[A-Za-z0-9+/]{22}==$/)
    .optional(),
});

/** Fixed HTTPS origin, TLS verification provided by Node, no redirects and no retries.
 * Never return/store/log the provider's session_key, response body, code or URL.
 */
export class WechatIdentityProvider implements IdentityProvider {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly transport: typeof fetch = fetch,
  ) {}

  async exchange(code: string): Promise<ProviderIdentity> {
    if (!loginRequestSchema.safeParse({ code }).success)
      throw new ApplicationError('LOGIN_REJECTED');
    const { WECHAT_APP_ID: appId, WECHAT_APP_SECRET: secret } = this.config;
    if (!appId || !secret) throw new ApplicationError('AUTH_NOT_CONFIGURED');
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search = new URLSearchParams({
      appid: appId,
      secret,
      js_code: code,
      grant_type: 'authorization_code',
    }).toString();
    try {
      const response = await this.transport(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { accept: 'application/json' },
      });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new ApplicationError('IDENTITY_PROVIDER_UNAVAILABLE');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 8192)
            throw new ApplicationError('IDENTITY_PROVIDER_UNAVAILABLE');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const parsed = exchangeResponse.safeParse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      if (!parsed.success)
        throw new ApplicationError('IDENTITY_PROVIDER_UNAVAILABLE');
      const body = parsed.data;
      if (body.errcode !== undefined && body.errcode !== 0) {
        if ([40029, 40163, 40226].includes(body.errcode))
          throw new ApplicationError('LOGIN_REJECTED');
        throw new ApplicationError('IDENTITY_PROVIDER_UNAVAILABLE');
      }
      if (!body.openid || !body.session_key)
        throw new ApplicationError('IDENTITY_PROVIDER_UNAVAILABLE');
      return {
        provider: 'wechat',
        appId,
        subject: body.openid,
        ...(body.unionid ? { unionSubject: body.unionid } : {}),
      };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      // Fetch errors may contain the credential-bearing URL; discard them entirely.
      throw new ApplicationError('IDENTITY_PROVIDER_UNAVAILABLE');
    }
  }
}
