# Product surface coverage

Status: 2026-10-20. This is a redesign inventory, not a claim of feature parity, deployment readiness, or native-device acceptance.

Home, Messages and Me visual layout were accepted by the user; this does not approve backend activation or release. Core and menu previews are review candidates only. Active batches retain existing permission, cancellation, recovery and read-receipt behavior. The first 17-page checkpoint passed its technical gate; the private-chat overlay read-observer regression was corrected before sealing. Later frozen checkpoints are under integration verification; active workers are excluded from each sealed snapshot. Tests do not constitute design acceptance.

## Accepted layout, preserved

- `community-feed`
- `inbox`
- `me`

## Core redesign implemented; awaiting visual acceptance

- `campus-hub`
- `compose-entry`
- `community-compose`
- `community-detail`
- `community-thread`
- `profile`
- `settings`
- `account-menu`

## Implemented, review candidate: ratings/course

- `rating-catalog`
- `rating-detail`
- `rating-thread`
- `rating-create`
- `rating-scoped`
- `rating-random`
- `course-ratings`
- `course-rating-detail`
- `course-comments`

## Implemented, review candidate: private conversations

- `private-message-list`
- `private-message-detail`
- `private-message-recovery`

## Implemented, review candidate: campus tools

- `campus-tools`
- `campus-tools-map`
- `campus-tools-shuttle`
- `campus-tools-research`
- `campus-tools-webview`

## Implemented, review candidate: dining/major discussion

- `canteen-floor-score-detail`
- `canteen-floor-scores`
- `window-ratings`
- `window-rating-detail`
- `window-dishes`
- `window-discussion`
- `window-discussion-thread`
- `major-directory`
- `major-detail`
- `major-discussion`
- `major-discussion-thread`

## Implemented, review candidate: errands

- `errand-compose`
- `errand-detail`
- `errand-list`
- `errand-mine`
- `errand-notices`

## Implemented, review candidate: activities

- `activity-list`
- `activity-detail`
- `activity-native`
- `activity-native-detail`
- `activity-publish`

## Implemented, review candidate: discovery and collections

- `community-hot`
- `community-search`
- `community-saved`
- `community-liked`
- `community-mine`
- `directory-hub`
- `directory-list`
- `directory-detail`

## Implemented, review candidate: account and verification

- `login`
- `phone-binding`
- `identity-campus`
- `verification`
- `student-verification`
- `student-verification-notices`
- `institutional-verification`
- `campus`

## Implemented, review candidate: campus information

- `organizations`
- `organization-editor`
- `announcements`
- `announcement-detail`
- `school-services`

## Implemented, review candidate: support and account safety

- `feedback`
- `feedback-contacts`
- `report-progress`
- `account-status`
- `safety-appeal`
- `status`

## Implemented, review candidate: personal secondary and notification timelines

- `public-profile`
- `community-blocks`
- `community-updates`
- `browsing-history`
- `rating-updates`
- `window-discussion-notices`
- `major-discussion-notices`
- `social-notices`
- `system-notices`
- `notice-thread`
- `experience`
- `experience-ranking`
- `wallet`

## Implemented, review candidate: moderation and verification management

- `admin-discussion-removal`
- `admin-post-removal`
- `profile-avatar-moderation`
- `profile-moderation`
- `safety-appeal-management`
- `safety-punishment-management`
- `student-verification-review`
- `feedback-notices`

## Implemented, review candidate: rating management and recovery

- `rating-category-create`
- `rating-category-editor`
- `rating-category-manage`
- `rating-deletion`
- `rating-discussion-media`
- `rating-recovery`
- `target-owner-delete`
- `target-owner-edit`
- `window-discussion-recovery`
- `major-discussion-recovery`

## Implemented, review candidate: governance and service management

- `errand-restrictions`

Administrative capability remains guarded; recovery actions are retained. All 117 routes now have a presentation implementation candidate. The final complete-source aggregate gate is separate from the earlier v20 checkpoint.

- `announcement-edit`
- `announcement-manage`
- `errand-admin`
- `official-account-operations`
- `school-admin-management`
- `school-configuration`
- `school-identity-management`
- `school-posting-policy`
- `school-uid-lookup`

Total registered source page folders inventoried: 117.

## Release gates still open

- Real PostgreSQL integration suites have not run in this environment.
- Trusted production media and university providers remain disabled/unconfigured.
- Native WeChat compilation, device layout, keyboard/safe-area, accessibility and upload-package size acceptance remain unverified.
- The v20 frozen checkpoint raw main-package size is 2,054,679 bytes, leaving 42,473 bytes below 2 MiB after verified stateless icon isolation. This excludes subsequent personal/notification and management batches; final integration must recheck it.
- Signed publication is blocked by unavailable signing material; no unsigned publication is authorized.
- Legacy parity backlog is tracked separately in APPLE_MINI_PROGRAM_REDESIGN.md.
