import {
  ClientError,
  isRecord,
  type ErrorDetails,
  type ErrorKind,
} from './errors';
import type { HttpResponse } from '../platform/contracts';

export type Decoder<T> = (value: unknown) => T;

/** New API errors use non-2xx HTTP status and { error: { code, message, requestId } }. */
export function responseError(response: HttpResponse): ClientError | null {
  if (
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599
  ) {
    return new ClientError('protocol', 'The HTTP response status is invalid');
  }
  const body = isRecord(response.body) ? response.body : {};
  if (response.status >= 200 && response.status < 300) {
    return body.error === undefined
      ? null
      : new ClientError(
          'protocol',
          'An error envelope must have an unsuccessful HTTP status',
        );
  }
  const error = isRecord(body.error) ? body.error : {};
  const serverCode =
    typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      ? error.code
      : undefined;
  // Only accept a bounded correlation identifier; never expose arbitrary server text.
  const requestId =
    typeof error.requestId === 'string' &&
    /^[a-f0-9-]{36}$/i.test(error.requestId)
      ? error.requestId
      : undefined;
  const details: ErrorDetails = {
    httpStatus: response.status,
    ...(serverCode ? { serverCode } : {}),
    ...(requestId ? { requestId } : {}),
  };
  const expectedStatus: Readonly<Record<string, number>> = {
    AUTHENTICATION_REQUIRED: 401,
    ACCESS_TOKEN_EXPIRED: 401,
    SESSION_REVOKED: 401,
    REFRESH_TOKEN_EXPIRED: 401,
    REFRESH_TOKEN_REUSED: 401,
    LOGIN_REJECTED: 401,
    ACCOUNT_BLOCKED: 403,
    AUTH_NOT_CONFIGURED: 503,
    IDENTITY_PROVIDER_UNAVAILABLE: 503,
    RATE_LIMITED: 429,
    PHONE_VERIFICATION_REQUIRED: 403,
    CONTENT_REVIEW_REJECTED: 422,
    BAD_REQUEST: 400,
    PROFILE_REVISION_CONFLICT: 409,
    CAMPUS_UNAVAILABLE: 409,
    CAMPUS_NOT_FOUND: 404,
    AUTHORIZATION_REQUIRED: 403,
    AUTHORIZATION_UNAVAILABLE: 503,
    IDENTITY_VIEW_UNAVAILABLE: 503,
    IDENTITY_AUDIT_UNAVAILABLE: 503,
    COMMUNITY_UNAVAILABLE: 503,
    COMMUNITY_SCOPE_UNAVAILABLE: 409,
    STUDENT_VERIFICATION_REQUIRED: 403,
    IDENTITY_CAMPUS_REQUIRED: 403,
    COMMUNITY_ACTION_RESTRICTED: 403,
    AUTHOR_MODE_NOT_ALLOWED: 403,
    COMMENTS_DISABLED: 403,
    CONTENT_REJECTED: 422,
    CONTENT_REVIEW_UNAVAILABLE: 503,
    MEDIA_NOT_READY: 409,
    MEDIA_UNAVAILABLE: 503,
    POST_NOT_FOUND: 404,
    COMMENT_NOT_FOUND: 404,
    POST_DELETED: 410,
    REQUEST_CONFLICT: 409,
    REQUEST_NOT_FOUND: 404,
    POLL_NOT_FOUND: 404,
    POLL_EXPIRED: 409,
    POLL_ALREADY_VOTED: 409,
    POLL_OPTIONS_INVALID: 422,
    BALLOT_NOT_FOUND: 404,
  };
  if (
    serverCode &&
    expectedStatus[serverCode] !== undefined &&
    expectedStatus[serverCode] !== response.status
  ) {
    return new ClientError(
      'protocol',
      'The error code and HTTP status do not match',
      details,
    );
  }
  let kind: ErrorKind = 'http';
  if (response.status === 401)
    kind =
      serverCode === 'ACCESS_TOKEN_EXPIRED' ? 'auth-expired' : 'auth-required';
  else if (response.status === 403)
    kind =
      serverCode === 'PHONE_VERIFICATION_REQUIRED'
        ? 'phone-verification-required'
        : 'forbidden';
  else if (response.status === 422 && serverCode === 'CONTENT_REVIEW_REJECTED')
    kind = 'content-audit-rejected';
  else if (
    response.status === 400 ||
    response.status === 409 ||
    response.status === 422
  )
    kind = 'business';
  return new ClientError(kind, 'The server rejected the request', details);
}

/** Success DTOs have endpoint-specific runtime validators; no legacy business-code interpretation. */
export function decodeResponse<T>(
  response: HttpResponse,
  decode: Decoder<T>,
): T {
  const error = responseError(response);
  if (error) throw error;
  try {
    return decode(response.body);
  } catch (failure) {
    if (failure instanceof ClientError) throw failure;
    throw new ClientError('protocol', 'The response data is invalid');
  }
}
