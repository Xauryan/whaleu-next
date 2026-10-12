import { HttpException } from '@nestjs/common';

// Shared business conditions stay distinct from transport failures. Defining these
// codes is not an implementation of authentication, verification, or moderation.
const conditions = {
  POST_PIN_UNAVAILABLE: {
    status: 503,
    message: 'Accepted post pin scope or history is unavailable',
  },
  POST_PIN_CONFLICT: {
    status: 409,
    message: 'This scope already has a live pinned post',
  },
  POST_PIN_STALE: {
    status: 409,
    message: 'The exact post pin is no longer current',
  },
  POST_PIN_CANCELLED: {
    status: 409,
    message: 'Original post pin command was cancelled',
  },

  WINDOW_DISCUSSION_HISTORY_UNAVAILABLE: {
    status: 503,
    message: 'Window discussion history is unavailable',
  },
  WINDOW_DISCUSSION_BUDGET_UNAVAILABLE: {
    status: 503,
    message: 'Window discussion complete visibility budget exceeded',
  },
  WINDOW_DISCUSSION_NOT_FOUND: {
    status: 404,
    message: 'Window discussion is not available',
  },
  WINDOW_DISCUSSION_NOTICE_NOT_FOUND: {
    status: 404,
    message: 'Window discussion notice was not found',
  },
  DISH_HISTORY_UNAVAILABLE: {
    status: 503,
    message: 'Dish recommendation history is unavailable',
  },
  DISH_BUDGET_UNAVAILABLE: {
    status: 503,
    message:
      'Exact dish recommendation population exceeds the supported budget',
  },
  FLOOR_HISTORY_UNAVAILABLE: {
    status: 503,
    message: 'Floor score history or current proof is unavailable',
  },
  FLOOR_NOT_FOUND: {
    status: 404,
    message: 'Floor or active canteen is unavailable',
  },
  FLOOR_REVISION_CONFLICT: {
    status: 409,
    message: 'Floor catalog changed; reload before confirming',
  },
  FLOOR_ALREADY_RATED: {
    status: 409,
    message: 'An active floor score already exists',
  },
  FLOOR_SCORE_CANCELLED: {
    status: 409,
    message: 'Original floor score command was cancelled',
  },
  WINDOW_CATALOG_UNAVAILABLE: {
    status: 503,
    message: 'Accepted window catalog is unavailable',
  },
  WINDOW_HISTORY_UNAVAILABLE: {
    status: 503,
    message: 'Window score history or current proof is unavailable',
  },
  WINDOW_NOT_FOUND: {
    status: 404,
    message: 'Window or active parent is unavailable',
  },
  WINDOW_REVISION_CONFLICT: {
    status: 409,
    message: 'Window catalog changed; reload before confirming',
  },
  WINDOW_SCORE_REVISION_CONFLICT: {
    status: 409,
    message: 'Own window score changed; reload before confirming',
  },
  WINDOW_SCORE_CANCELLED: {
    status: 409,
    message: 'Original window score command was cancelled',
  },
  COURSE_COMMENT_HISTORY_UNAVAILABLE: {
    status: 503,
    message: 'Course comment or like history is unavailable',
  },
  COURSE_COMMENT_NOT_FOUND: {
    status: 404,
    message: 'Course comment is unavailable',
  },
  COURSE_COMMENT_BASE_REQUIRED: {
    status: 403,
    message:
      'Current verified-base eligibility is required to publish a course comment',
  },
  COURSE_COMMENT_ALREADY_LIKED: {
    status: 409,
    message: 'The original course comment like cannot be changed',
  },
  COURSE_COMMENT_CANCELLED: {
    status: 409,
    message: 'The original course comment command was cancelled',
  },
  COURSE_CATALOG_UNAVAILABLE: {
    status: 503,
    message: 'Accepted course catalog is unavailable',
  },
  COURSE_NOT_FOUND: { status: 404, message: 'Course is unavailable' },
  COURSE_HISTORY_UNAVAILABLE: {
    status: 503,
    message: 'Course rating history coverage is unavailable',
  },
  COURSE_ALREADY_RATED: {
    status: 409,
    message: 'The original course rating cannot be changed',
  },
  COURSE_REVISION_CONFLICT: {
    status: 409,
    message: 'Course catalog changed; reload before confirming',
  },
  STUDENT_VERIFICATION_CANCELLED: {
    status: 409,
    message: 'The original student verification command was cancelled',
  },
  STUDENT_VERIFICATION_CONFLICT: {
    status: 409,
    message:
      'Student verification request or revision changed; recover the original request',
  },
  STUDENT_VERIFICATION_NOT_FOUND: {
    status: 404,
    message: 'Student verification application is unavailable',
  },
  STUDENT_VERIFICATION_ALREADY_VERIFIED: {
    status: 409,
    message:
      'Current affiliation or an approved application requires school administrator assistance',
  },
  STUDENT_VERIFICATION_EXPIRED: {
    status: 409,
    message: 'Evidence expired; create a new application with new evidence',
  },
  STUDENT_VERIFICATION_SELF_REVIEW: {
    status: 403,
    message: 'An applicant cannot review their own application',
  },

  ACTIVITY_PUBLICATION_CONFLICT: {
    status: 409,
    message:
      'Activity request or revision changed; recover the original request',
  },
  ACTIVITY_PUBLICATION_CANCELLED: {
    status: 409,
    message: 'Activity publication was cancelled',
  },
  ACTIVITY_COVER_REQUIRED: {
    status: 422,
    message: 'An accepted activity cover is required',
  },
  SCHOOL_CONFIGURATION_CANCELLED: {
    status: 409,
    message: 'The school service command was cancelled',
  },
  SCHOOL_CONFIGURATION_UNAVAILABLE: {
    status: 503,
    message: 'School service configuration is unavailable',
  },
  SCHOOL_CONFIGURATION_REVISION_CONFLICT: {
    status: 409,
    message: 'School service changed; reload before saving',
  },
  SCHOOL_CONFIGURATION_REQUEST_CONFLICT: {
    status: 409,
    message: 'The request key belongs to another school service command',
  },
  DM_COMMAND_CANCELLED: {
    status: 409,
    message: 'The original private message command was cancelled',
  },
  DM_NOT_FOUND: { status: 404, message: 'Private conversation is unavailable' },
  DM_UNAVAILABLE: { status: 503, message: 'Private messages are unavailable' },
  DM_ENTRY_UNAVAILABLE: {
    status: 403,
    message: 'This private message entry is unavailable',
  },
  DM_SEND_UNAVAILABLE: { status: 403, message: 'Sending is unavailable' },
  DM_FIRST_CONTACT_LIMIT: {
    status: 409,
    message: 'Wait for a reply before sending another message',
  },
  DM_RATE_LIMITED: {
    status: 429,
    message: 'Private message rate limit reached; retry later',
  },
  DM_RECALL_EXPIRED: { status: 409, message: 'The recall window has ended' },
  DM_CURSOR_STALE: {
    status: 409,
    message: 'Conversation list changed; restart paging',
  },
  DM_OBSERVATION_UNAVAILABLE: {
    status: 409,
    message: 'Refresh the conversation before marking it read',
  },

  RATING_SCOPED_CONTEXT_CHANGED: {
    status: 409,
    message: 'Rating scoped context changed.',
  },
  RATING_DELETION_CONTEXT_CHANGED: {
    status: 409,
    message: 'Deletion context changed; refresh and confirm again',
  },
  RATING_DELETION_AUTHORITY_UNAVAILABLE: {
    status: 503,
    message: 'Rating deletion authority is unavailable',
  },
  RATING_CATEGORY_CONTEXT_CHANGED: {
    status: 409,
    message: 'Category management context changed; reload before publishing',
  },
  RATING_CATEGORY_CANCELLED: {
    status: 409,
    message: 'Category creation was cancelled',
  },
  RATING_EDIT_CONTEXT_CHANGED: {
    status: 409,
    message: 'The original target editing context has changed.',
  },
  RATING_EDIT_CANCELLED: {
    status: 409,
    message: 'The original target editing request was cancelled.',
  },
  RATING_CREATION_CONTEXT_CHANGED: {
    status: 409,
    message: 'Rating creation context changed; request is closed',
  },
  RATING_TARGET_DELETION_CANCELLED: {
    status: 409,
    message: 'Rating target deletion cancelled',
  },
  RATING_CREATION_CANCELLED: {
    status: 409,
    message: 'Rating creation request cancelled',
  },
  RATING_UNAVAILABLE: { status: 503, message: 'Ratings are unavailable' },
  RATING_NOT_FOUND: { status: 404, message: 'Rating content not found' },
  RATING_CATEGORY_SOURCE_UNRESOLVED: {
    status: 409,
    message:
      'Category sources disagree on identity, shared definition or business state; reconcile them before changing scope',
  },
  RATING_SCOPE_UNAVAILABLE: {
    status: 403,
    message: 'Rating scope unavailable',
  },
  RATING_SCORE_UNAVAILABLE: {
    status: 503,
    message: 'Score history is unavailable',
  },
  RATING_REVISION_CONFLICT: {
    status: 409,
    message: 'Rating changed; reload before saving',
  },

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
  ANNOUNCEMENT_COMMAND_CANCELLED: {
    status: 409,
    message: 'Announcement command was cancelled',
  },
  ANNOUNCEMENT_CONTENT_REQUIRED: {
    status: 400,
    message: 'Announcement version and body are required',
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
  ORGANIZATION_UNAVAILABLE: {
    status: 503,
    message: 'Organization authority is unavailable',
  },
  ORGANIZATION_NOT_FOUND: {
    status: 404,
    message: 'Organization is unavailable',
  },
  ORGANIZATION_REVISION_CONFLICT: {
    status: 409,
    message: 'Organization changed; reload before continuing',
  },
  ORGANIZATION_REQUEST_CONFLICT: {
    status: 409,
    message: 'Organization command conflicts',
  },
  ORGANIZATION_CANCELLED: {
    status: 409,
    message: 'Organization command was cancelled',
  },
  ORGANIZATION_STATE_CONFLICT: {
    status: 409,
    message: 'Organization transition is not permitted',
  },
  ORGANIZATION_MEDIA_REQUIRED: {
    status: 422,
    message: 'Required organization images are missing',
  },
  ORGANIZATION_MEMBER_NOT_FOUND: {
    status: 404,
    message: 'Verified organization-region member is unavailable',
  },
  ORGANIZATION_OWNER_PROTECTED: {
    status: 409,
    message: 'Transfer ownership instead of removing the owner',
  },
  ORGANIZATION_MEMBER_LIMIT: {
    status: 409,
    message: 'Organization manager limit reached',
  },
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
  SEMANTIC_SEARCH_DISABLED: {
    status: 503,
    message: 'Semantic search is disabled',
  },
  SCHOOL_POSTING_POLICY_UNAVAILABLE: {
    status: 503,
    message: 'School posting policy is unavailable',
  },
  SCHOOL_POSTING_POLICY_REVISION_CONFLICT: {
    status: 409,
    message: 'School posting policy changed; reload before saving',
  },
  SCHOOL_POSTING_POLICY_REQUEST_CONFLICT: {
    status: 409,
    message: 'School posting policy command conflicts',
  },
  SCHOOL_POSTING_POLICY_CANCELLED: {
    status: 409,
    message: 'School posting policy command was cancelled',
  },
  SCHOOL_POSTING_POLICY_SOURCE_UNRESOLVED: {
    status: 409,
    message:
      'Resolve the existing policy provenance and related-campus synchronization before changing this policy',
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
  MEDIA_REQUEST_CONFLICT: { status: 409, message: 'Media request conflicts' },
  MEDIA_REQUEST_CANCELLED: {
    status: 409,
    message: 'Media request has been cancelled',
  },
  MEDIA_RATE_LIMITED: {
    status: 429,
    message: 'Media operation budget exceeded',
  },
  MEDIA_UPLOAD_IN_FLIGHT: { status: 409, message: 'Media upload is in flight' },
  MEDIA_RECONCILE_NEEDED: {
    status: 409,
    message: 'Media upload requires reconciliation',
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

/** Only the shared Media request-key quota supplies its observed retry window. */
export class MediaRequestRateLimited extends ApplicationError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('MEDIA_RATE_LIMITED');
    if (
      !Number.isSafeInteger(retryAfterSeconds) ||
      retryAfterSeconds < 1 ||
      retryAfterSeconds > 86400
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    this.retryAfterSeconds = retryAfterSeconds;
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
