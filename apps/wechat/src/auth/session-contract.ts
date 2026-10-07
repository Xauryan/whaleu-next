import { ClientError, isRecord } from '../api/errors';

export interface SessionInfo {
  readonly accountId: string;
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly refreshExpiresAt: number;
}
export interface Credentials extends SessionInfo {
  readonly accessToken: string;
  readonly refreshToken: string;
}
const identifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim() === value &&
  /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const token = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim() === value &&
  /^[a-zA-Z0-9._~-]{1,16384}$/.test(value);

/** Whitelisted fields only: never adopt arbitrary account/profile data from auth responses. */
export function validateSessionInfo(value: unknown): SessionInfo {
  if (
    !isRecord(value) ||
    !identifier(value.accountId) ||
    !identifier(value.sessionId) ||
    !timestamp(value.expiresAt) ||
    !timestamp(value.refreshExpiresAt)
  )
    throw new ClientError('protocol', 'Invalid session metadata');
  return Object.freeze({
    accountId: value.accountId,
    sessionId: value.sessionId,
    expiresAt: value.expiresAt,
    refreshExpiresAt: value.refreshExpiresAt,
  });
}
export function validateCredentials(value: unknown): Credentials {
  const info = validateSessionInfo(value);
  if (
    !isRecord(value) ||
    !token(value.accessToken) ||
    !token(value.refreshToken) ||
    value.accessToken === value.refreshToken
  )
    throw new ClientError('protocol', 'Invalid session credentials');
  return Object.freeze({
    ...info,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
  });
}

const uuid = (value: string): boolean =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    value,
  );
/** Concrete identity API contract. Generic session machinery stays adapter-independent. */
export function decodeSessionInfo(value: unknown): SessionInfo {
  const info = validateSessionInfo(value);
  if (
    !uuid(info.accountId) ||
    !uuid(info.sessionId) ||
    info.expiresAt > info.refreshExpiresAt ||
    info.refreshExpiresAt > 8_640_000_000_000_000
  )
    throw new ClientError('protocol', 'Invalid identity session response');
  return info;
}
export function decodeCredentials(value: unknown): Credentials {
  decodeSessionInfo(value);
  const credentials = validateCredentials(value);
  if (
    !/^wu_a_[A-Za-z0-9_-]{43}$/.test(credentials.accessToken) ||
    !/^wu_r_[A-Za-z0-9_-]{43}$/.test(credentials.refreshToken)
  )
    throw new ClientError('protocol', 'Invalid identity credentials response');
  return credentials;
}
