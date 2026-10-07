import { z } from 'zod';

export const loginRequestSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export const refreshRequestSchema = z.strictObject({
  refreshToken: z.string().regex(/^wu_r_[A-Za-z0-9_-]{43}$/),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

/** Credentials are private to the native client; all timestamps are epoch milliseconds. */
export interface SessionCredentials {
  readonly accountId: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly refreshExpiresAt: number;
}
export interface SessionView {
  readonly accountId: string;
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly refreshExpiresAt: number;
}
export interface ProviderIdentity {
  readonly provider: 'wechat';
  readonly appId: string;
  readonly subject: string;
  readonly unionSubject?: string;
}
export interface IdentityProvider {
  exchange(code: string): Promise<ProviderIdentity>;
}
export const IDENTITY_PROVIDER = Symbol('IDENTITY_PROVIDER');
