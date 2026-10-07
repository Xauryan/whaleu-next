export type ErrorKind =
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'http'
  | 'protocol'
  | 'business'
  | 'auth-required'
  | 'auth-expired'
  | 'phone-verification-required'
  | 'content-audit-rejected'
  | 'forbidden'
  | 'stale-session'
  | 'storage'
  | 'configuration';

export interface ErrorDetails {
  readonly httpStatus?: number;
  readonly serverCode?: string;
  readonly requestId?: string;
}

/** Deliberately excludes request payloads, raw platform errors, credentials and server messages. */
export class ClientError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly details: ErrorDetails = {},
  ) {
    super(message);
    this.name = 'ClientError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function clientError(
  error: unknown,
  fallback: ErrorKind = 'network',
): ClientError {
  return error instanceof ClientError
    ? error
    : new ClientError(fallback, 'The operation could not be completed');
}
