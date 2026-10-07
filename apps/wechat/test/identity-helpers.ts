import type { Credentials, SessionInfo } from '../src/auth/session-contract';
export const accountId = '12345678-1234-4123-8123-123456789abc';
export const sessionId = '22345678-1234-4123-8123-123456789abc';
export function wireCredentials(suffix = 'a'): Credentials {
  return {
    accountId,
    sessionId,
    accessToken: `wu_a_${suffix.repeat(43)}`,
    refreshToken: `wu_r_${suffix.repeat(43)}`,
    expiresAt: 1_900_000_000_000,
    refreshExpiresAt: 1_900_600_000_000,
  };
}
export function wireSession(
  credentials: Credentials = wireCredentials(),
): SessionInfo {
  return {
    accountId: credentials.accountId,
    sessionId: credentials.sessionId,
    expiresAt: credentials.expiresAt,
    refreshExpiresAt: credentials.refreshExpiresAt,
  };
}
