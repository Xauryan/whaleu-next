import { HttpException } from '@nestjs/common';

// Shared business conditions stay distinct from transport failures. Defining these
// codes is not an implementation of authentication, verification, or moderation.
const conditions = {
  SAFETY_UNAVAILABLE: {
    status: 503,
    message: 'Safety controls are unavailable',
  },
  SAFETY_ACTION_RESTRICTED: {
    status: 403,
    message: 'Safety action is restricted',
  },
  BLOCK_TARGET_NOT_ALLOWED: {
    status: 403,
    message: 'This target cannot be blocked',
  },
  BLOCK_NOT_FOUND: { status: 404, message: 'Block not found' },
  BLOCK_REVISION_CONFLICT: {
    status: 409,
    message: 'Block changed; refresh before continuing',
  },
  POST_BLOCKED_BY_YOU: {
    status: 404,
    message: 'You blocked this named author',
  },
  AUTHORIZATION_REQUIRED: {
    status: 403,
    message: 'Required role is not granted',
  },
  AUTHORIZATION_UNAVAILABLE: {
    status: 503,
    message: 'Authorization is unavailable',
  },
  VERIFICATION_UNAVAILABLE: {
    status: 503,
    message: 'Verification is unavailable',
  },
  IDENTITY_VIEW_UNAVAILABLE: {
    status: 503,
    message: 'Identity view is unavailable',
  },
  IDENTITY_AUDIT_UNAVAILABLE: {
    status: 503,
    message: 'Identity audit is unavailable',
  },
  COMMUNITY_UNAVAILABLE: { status: 503, message: 'Community is unavailable' },
  COMMUNITY_SCOPE_UNAVAILABLE: {
    status: 409,
    message: 'Community scope is unavailable',
  },
  STUDENT_VERIFICATION_REQUIRED: {
    status: 403,
    message: 'Student verification required',
  },
  IDENTITY_CAMPUS_REQUIRED: {
    status: 403,
    message: 'Identity campus required',
  },
  COMMUNITY_ACTION_RESTRICTED: {
    status: 403,
    message: 'Community action is restricted',
  },
  AUTHOR_MODE_NOT_ALLOWED: {
    status: 403,
    message: 'Author mode is not allowed',
  },
  COMMENTS_DISABLED: { status: 403, message: 'Comments are disabled' },
  CONTENT_REJECTED: { status: 422, message: 'Content did not pass review' },
  CONTENT_REVIEW_UNAVAILABLE: {
    status: 503,
    message: 'Content review is unavailable',
  },
  MEDIA_NOT_READY: { status: 409, message: 'Media is not ready' },
  MEDIA_UNAVAILABLE: { status: 503, message: 'Media is unavailable' },
  FORMATION_NOT_FOUND: { status: 404, message: 'Formation not found' },
  FORMATION_FULL: { status: 409, message: 'Formation is full' },
  FORMATION_ALREADY_JOINED: {
    status: 409,
    message: 'Membership already exists',
  },
  FORMATION_UNAVAILABLE: { status: 409, message: 'Formation is unavailable' },
  FORMATION_MEMBERSHIP_REQUIRED: {
    status: 403,
    message: 'Membership is required',
  },
  FORMATION_MEMBERSHIP_NOT_FOUND: {
    status: 404,
    message: 'Membership not found',
  },
  POLL_NOT_FOUND: { status: 404, message: 'Poll not found' },
  POLL_EXPIRED: { status: 409, message: 'Poll has expired' },
  POLL_ALREADY_VOTED: { status: 409, message: 'A ballot is already recorded' },
  POLL_OPTIONS_INVALID: { status: 422, message: 'Poll options are invalid' },
  BALLOT_NOT_FOUND: { status: 404, message: 'Ballot not found' },
  REPLY_NOT_FOUND: { status: 404, message: 'Reply not found' },
  COMMENT_PIN_CONFLICT: {
    status: 409,
    message: 'Unpin the current comment first',
  },
  DISCUSSION_RESTART_REQUIRED: {
    status: 409,
    message: 'Discussion changed; refresh to continue',
  },
  NOTICE_NOT_FOUND: { status: 404, message: 'Update not found' },
  POST_NOT_FOUND: { status: 404, message: 'Post not found' },
  COMMENT_NOT_FOUND: { status: 404, message: 'Comment not found' },
  POST_DELETED: { status: 410, message: 'Post deleted' },
  REQUEST_CONFLICT: { status: 409, message: 'Publication request conflicts' },
  REQUEST_NOT_FOUND: { status: 404, message: 'Publication request not found' },

  CAMPUS_NOT_FOUND: { status: 404, message: 'Campus not found' },
  CAMPUS_UNAVAILABLE: {
    status: 409,
    message: 'Campus is not available for selection',
  },
  PROFILE_REVISION_CONFLICT: {
    status: 409,
    message: 'Profile changed; reload before saving',
  },
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
