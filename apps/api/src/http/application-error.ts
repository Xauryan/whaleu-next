import { HttpException } from '@nestjs/common';

// Shared business conditions stay distinct from transport failures. Defining these
// codes is not an implementation of authentication, verification, or moderation.
const conditions = {
  ERRAND_USE_OWNER_COMMAND: {
    status: 409,
    message: 'Use the publisher command for your own errand',
  },
  ERRAND_RESTRICTION_TARGET_PROTECTED: {
    status: 403,
    message: 'This target cannot receive an errand restriction',
  },
  ERRAND_RESTRICTION_TARGET_NOT_FOUND: {
    status: 404,
    message: 'Restriction target is unavailable',
  },
  ERRAND_RESTRICTION_NOT_FOUND: {
    status: 404,
    message: 'Restriction is unavailable',
  },
  ERRAND_RESTRICTION_NOT_ACTIVE: {
    status: 409,
    message: 'Restriction is no longer active',
  },
  ERRAND_UNAVAILABLE: { status: 503, message: 'Errands are unavailable' },
  ERRAND_MEDIA_UNAVAILABLE: {
    status: 503,
    message: 'Errand media is not supported in this text-only slice',
  },
  ERRAND_NOT_FOUND: { status: 404, message: 'Errand is unavailable' },
  ERRAND_REVISION_CONFLICT: {
    status: 409,
    message: 'Errand changed; refresh before continuing',
  },
  ERRAND_STATE_CONFLICT: {
    status: 409,
    message: 'Errand transition is not permitted',
  },
  ERRAND_ACTION_RESTRICTED: {
    status: 403,
    message: 'Errand action is restricted',
  },
  ERRAND_SELF_ACCEPT: {
    status: 403,
    message: 'Publishers cannot accept their own errand',
  },

  ACTIVITY_UNAVAILABLE: { status: 503, message: 'Activities are unavailable' },
  ACTIVITY_ENTRY_SELECTION_UNAVAILABLE: {
    status: 503,
    message: 'Activity entry selection is unavailable; choose all activities',
  },
  ACTIVITY_SCOPE_UNAVAILABLE: {
    status: 403,
    message: 'Activity scope is unavailable',
  },
  ACTIVITY_NOT_FOUND: { status: 404, message: 'Activity is unavailable' },
  ACTIVITY_REVISION_CHANGED: {
    status: 409,
    message: 'Activity catalog changed; refresh before recording a visit',
  },
  ACTIVITY_VISIT_CONFLICT: {
    status: 409,
    message: 'Activity visit request conflicts',
  },
  ANNOUNCEMENTS_UNAVAILABLE: {
    status: 503,
    message: 'Announcements are unavailable',
  },
  ANNOUNCEMENT_NOT_FOUND: {
    status: 404,
    message: 'Announcement is unavailable',
  },
  ANNOUNCEMENT_REVISION_CHANGED: {
    status: 409,
    message: 'Announcement changed; refresh before acknowledging',
  },
  HOT_FEED_UNAVAILABLE: { status: 503, message: 'Hot feed is unavailable' },
  DIRECTORY_UNAVAILABLE: { status: 503, message: 'Directory is unavailable' },
  DIRECTORY_NOT_FOUND: {
    status: 404,
    message: 'Directory entry is unavailable',
  },
  DIRECTORY_SCOPE_UNAVAILABLE: {
    status: 403,
    message: 'Directory scope is unavailable',
  },
  VIEW_REPORTING_EPOCH_CLOSED: {
    status: 410,
    message: 'View reporting epoch is closed',
  },
  VIEW_REPORT_CONFLICT: { status: 409, message: 'View report conflicts' },
  VIEW_REPORTING_UNAVAILABLE: {
    status: 503,
    message: 'View reporting is unavailable',
  },
  EXPERIENCE_MAINTENANCE_REQUEST_CONFLICT: {
    status: 409,
    message: 'Title maintenance request conflicts',
  },
  EXPERIENCE_MAINTENANCE_CONTINUATION_CONFLICT: {
    status: 409,
    message: 'Title maintenance continuation is already consumed',
  },
  EXPERIENCE_MAINTENANCE_REQUEST_NOT_FOUND: {
    status: 404,
    message: 'Title maintenance request not found',
  },
  EXPERIENCE_MAINTENANCE_UNAVAILABLE: {
    status: 503,
    message: 'Title maintenance is unavailable',
  },
  EXPERIENCE_REDEMPTION_UNAVAILABLE: {
    status: 503,
    message: 'Title redemption is unavailable',
  },
  EXPERIENCE_REDEMPTION_RATE_LIMITED: {
    status: 429,
    message: 'Too many title redemption attempts',
  },
  EXPERIENCE_RANKING_UNAVAILABLE: {
    status: 503,
    message: 'Experience ranking is unavailable',
  },
  EXPERIENCE_BASELINE_UNAVAILABLE: {
    status: 409,
    message: 'Experience baseline is unavailable',
  },
  EXPERIENCE_PENDING: {
    status: 409,
    message: 'Earlier experience work is pending',
  },
  EXPERIENCE_REQUEST_CONFLICT: {
    status: 409,
    message: 'Experience request conflicts',
  },
  EXPERIENCE_REQUEST_NOT_FOUND: {
    status: 404,
    message: 'Experience request not found',
  },
  EXPERIENCE_APPEARANCE_CONFLICT: {
    status: 409,
    message: 'Appearance changed; refresh before selecting',
  },
  EXPERIENCE_TITLE_INELIGIBLE: {
    status: 409,
    message: 'Title selection is not permitted',
  },
  EXPERIENCE_COLOR_INELIGIBLE: {
    status: 409,
    message: 'Color selection is not permitted',
  },
  EXPERIENCE_UNLOCK_NOT_FOUND: {
    status: 404,
    message: 'Experience unlock notice not found',
  },
  DISCOVERY_RESTART_REQUIRED: {
    status: 409,
    message: 'Discovery changed; refresh to continue',
  },
  IDENTITY_CAMPUS_REQUEST_NOT_FOUND: {
    status: 404,
    message: 'Identity campus request not found',
  },
  IDENTITY_CAMPUS_REQUEST_CONFLICT: {
    status: 409,
    message: 'Identity campus request conflicts',
  },
  IDENTITY_CAMPUS_REVISION_CONFLICT: {
    status: 409,
    message: 'Identity campus inputs changed; refresh and confirm again',
  },
  IDENTITY_CAMPUS_NOT_ELIGIBLE: {
    status: 409,
    message: 'Campus is not eligible for identity selection',
  },
  IDENTITY_CAMPUS_UNAVAILABLE: {
    status: 503,
    message: 'Identity campus selection is unavailable',
  },
  REPORT_TARGET_UNAVAILABLE: {
    status: 404,
    message: 'Report target is unavailable',
  },
  REPORT_SELF_NOT_ALLOWED: {
    status: 403,
    message: 'Own content cannot be reported',
  },
  REPORT_ALREADY_REPORTED: {
    status: 409,
    message: 'A report is already recorded',
  },
  REPORTING_CLOSED: { status: 409, message: 'Reporting is closed' },
  REPORT_SCOPE_UNAVAILABLE: {
    status: 503,
    message: 'Report scope is unavailable',
  },
  AFFILIATION_VERIFICATION_REQUIRED: {
    status: 403,
    message: 'Affiliation verification required',
  },
  JURY_NOT_FOUND: { status: 404, message: 'Jury not found' },
  JURY_INELIGIBLE: { status: 403, message: 'Jury voting is not permitted' },
  JURY_ALREADY_VOTED: {
    status: 409,
    message: 'A jury ballot is already recorded',
  },
  JURY_CLOSED: { status: 409, message: 'Jury voting is closed' },
  SYSTEM_NOTICES_UNAVAILABLE: {
    status: 503,
    message: 'System notices are unavailable',
  },
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

/** Readonly business descriptions for transport metadata without a second inventory. */
export function applicationErrorCondition(code: ApplicationErrorCode) {
  return conditions[code];
}

export class ApplicationError extends HttpException {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode) {
    const condition = conditions[code];
    super(condition.message, condition.status);
    this.code = code;
  }
}

/** Only the authorized maintenance owner may supply this recovery reference. */
export class TitleMaintenanceContinuationConflict extends ApplicationError {
  readonly successorRequestId: string;

  constructor(successorRequestId: string) {
    super('EXPERIENCE_MAINTENANCE_CONTINUATION_CONFLICT');
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        successorRequestId,
      )
    )
      throw new ApplicationError('EXPERIENCE_MAINTENANCE_UNAVAILABLE');
    this.successorRequestId = successorRequestId;
  }
}
