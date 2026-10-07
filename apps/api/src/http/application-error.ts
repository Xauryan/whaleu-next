import { HttpException } from '@nestjs/common';

// Shared business conditions stay distinct from transport failures. Defining these
// codes is not an implementation of authentication, verification, or moderation.
const conditions = {
  AUTH_NOT_CONFIGURED: {
    status: 503,
    message: 'Authentication is not configured',
  },
  LOGIN_REJECTED: { status: 401, message: 'Login could not be verified' },
  IDENTITY_PROVIDER_UNAVAILABLE: {
    status: 503,
    message: 'Identity provider is unavailable',
  },
  ACCOUNT_BLOCKED: { status: 403, message: 'Account access is blocked' },
  REFRESH_TOKEN_EXPIRED: { status: 401, message: 'Refresh token expired' },
  REFRESH_TOKEN_REUSED: {
    status: 401,
    message: 'Refresh token was already used; sign in again',
  },
  RATE_LIMITED: { status: 429, message: 'Too many requests' },
  AUTHENTICATION_REQUIRED: { status: 401, message: 'Authentication required' },
  ACCESS_TOKEN_EXPIRED: { status: 401, message: 'Access token expired' },
  SESSION_REVOKED: { status: 401, message: 'Session is no longer valid' },
  PHONE_VERIFICATION_REQUIRED: {
    status: 403,
    message: 'Phone verification required',
  },
  CONTENT_REVIEW_REJECTED: {
    status: 422,
    message: 'Content did not pass review',
  },
} as const;

export type ApplicationErrorCode = keyof typeof conditions;

export class ApplicationError extends HttpException {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode) {
    const condition = conditions[code];
    super(condition.message, condition.status);
    this.code = code;
  }
}
