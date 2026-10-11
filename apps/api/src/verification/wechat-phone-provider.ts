import { z } from 'zod';
import type { RuntimeConfig } from '../config/config.js';
import { ApplicationError } from '../http/application-error.js';

export const WECHAT_PHONE_PROVIDER = Symbol('WECHAT_PHONE_PROVIDER');
export const phoneCodeSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\x21-\x7e]+$/);
export interface PhoneAuthorizationProof {
  readonly appId: string;
  readonly authorizedAt: number;
}
export interface PhoneProvider {
  exchange(code: string): Promise<PhoneAuthorizationProof>;
}
const tokenSchema = z.object({
  access_token: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[\x21-\x7e]+$/),
  expires_in: z.number().int().min(61).max(7200),
  errcode: z.literal(0).optional(),
});
const responseSchema = z.object({
  errcode: z.literal(0),
  phone_info: z.object({
    phoneNumber: z.string().regex(/^\+?[0-9]{5,18}$/),
    purePhoneNumber: z.string().regex(/^[0-9]{5,15}$/),
    countryCode: z.union([
      z.string().regex(/^[0-9]{1,4}$/),
      z.number().int().min(1).max(9999),
    ]),
    watermark: z.object({
      timestamp: z.number().int().positive(),
      appid: z.string().min(1),
    }),
  }),
});

/** Protocol reference: wechatpy a695b89891e0473113c946a3a44d948fcf217404,
 * client/api/wxa.py, client/base.py and fixtures/wxa_business_getuserphonenumber.json.
 * Independent TypeScript implementation: no retry of single-use authorization,
 * no redirect, no alternate destination, no code/token/phone/error-body logging.
 * Only the authorization fact leaves this adapter; phone values are discarded. */
export class WechatPhoneProvider implements PhoneProvider {
  private cached: { token: string; until: number } | undefined;
  private fetching: Promise<string> | undefined;
  constructor(
    private readonly config: RuntimeConfig,
    private readonly transport: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}
  private async json(url: URL, init: RequestInit): Promise<unknown> {
    const response = await this.transport(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 8192) throw new ApplicationError('VERIFICATION_UNAVAILABLE');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  private token(): Promise<string> {
    if (this.cached && this.cached.until > this.now())
      return Promise.resolve(this.cached.token);
    if (this.fetching) return this.fetching;
    this.fetching = (async () => {
      const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
      url.search = new URLSearchParams({
        grant_type: 'client_credential',
        appid: this.config.WECHAT_APP_ID!,
        secret: this.config.WECHAT_APP_SECRET!,
      }).toString();
      const issuedAt = this.now();
      const result = tokenSchema.parse(await this.json(url, { method: 'GET' }));
      this.cached = {
        token: result.access_token,
        until: issuedAt + (result.expires_in - 60) * 1000,
      };
      return result.access_token;
    })().finally(() => {
      this.fetching = undefined;
    });
    return this.fetching;
  }
  async exchange(code: string): Promise<PhoneAuthorizationProof> {
    if (
      this.config.WECHAT_PHONE_BINDING !== 'enabled' ||
      !this.config.WECHAT_APP_ID ||
      !this.config.WECHAT_APP_SECRET
    )
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    if (!phoneCodeSchema.safeParse(code).success)
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    try {
      const token = await this.token();
      const url = new URL(
        'https://api.weixin.qq.com/wxa/business/getuserphonenumber',
      );
      url.search = new URLSearchParams({ access_token: token }).toString();
      const result = responseSchema.parse(
        await this.json(url, {
          method: 'POST',
          body: JSON.stringify({ code }),
        }),
      );
      const phone = result.phone_info;
      const normalized = phone.phoneNumber.replace(/^\+/, '');
      if (
        normalized !== phone.purePhoneNumber &&
        normalized !== `${phone.countryCode}${phone.purePhoneNumber}`
      )
        throw new ApplicationError('VERIFICATION_UNAVAILABLE');
      const watermark = phone.watermark;
      const authorizedAt = watermark.timestamp * 1000;
      if (
        watermark.appid !== this.config.WECHAT_APP_ID ||
        authorizedAt > this.now() + 30_000 ||
        authorizedAt < this.now() - 300_000
      )
        throw new ApplicationError('VERIFICATION_UNAVAILABLE');
      return { appId: watermark.appid, authorizedAt };
    } catch {
      // Includes token rejection/expiry: invalidate cache but never replay the code.
      this.cached = undefined;
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    }
  }
}
