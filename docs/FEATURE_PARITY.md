# Feature parity tracker

The rewrite target is full feature parity, with NestJS, PostgreSQL 18 and platform-native clients. This is a source-grounded implementation checklist, not a claim that the new application is ready. This is a greenfield implementation: preserve all business capabilities and production data, while redesigning module boundaries, schema and API contracts. Legacy API compatibility and simultaneous old/new production operation are out of scope. Old route declarations are evidence of business behavior, not an API design to copy.

**Status for every capability below: NOT IMPLEMENTED.** Update a row only after code, tests and relevant client flow are verified. A framework scaffold, placeholder screen or endpoint stub is not an implemented feature. Features shown in older source but not proven active remain in scope for clarification rather than silently being discarded.

## Accounts, schools and personal settings

- [ ] NOT IMPLEMENTED — Login/session: WeChat login, account creation/profile loading, access/refresh lifecycle, retry recovery, account switching, sign-out and session-scoped client state
- [ ] NOT IMPLEMENTED — Identity verification: student application, application detail/status, image submission and review; email verification; institutional sign-in; phone verification/binding; verification guidance
- [ ] NOT IMPLEMENTED — School identity: school search and district selection; selected school versus verified institution; identity campus; related campuses; global university-city context; permission-sensitive switching
- [ ] NOT IMPLEMENTED — Public/personal profile: nickname, biography, avatar/default avatar, profile banner, school/UID display, titles, public profile, posts and trading listings, profile-post privacy
- [ ] NOT IMPLEMENTED — Preferences: system/manual theme, anonymous posting/comment defaults, anonymous-private-message preference, notification controls, guide/button settings, remembered publish contact/location choices
- [ ] NOT IMPLEMENTED — Experience: daily sign-in, experience records, daily limits/tasks, levels, title/color display, level-up notification, rankings and administrator title maintenance

## Campus feed and publishing

- [ ] NOT IMPLEMENTED — Feed discovery: campus/global feeds, category filtering, hot list, search, pagination, refresh, post details, user posts, my publications and my subscriptions
- [ ] NOT IMPLEMENTED — Post composition: text, multiple images, category, campus/location, draft save/restore/clear, remembered fields, preview, upload progress/error handling and safe repeated submission
- [ ] NOT IMPLEMENTED — Post modes: ordinary and anonymous identity, anonymous-DM option, trading category/price modes, contact fields, polls and options, group-formation details and join/contact retrieval
- [ ] NOT IMPLEMENTED — Linked content: board/category/group links and labels; publishing capabilities; related-campus synchronization; restricted/unverified publishing channels
- [ ] NOT IMPLEMENTED — Reading: original text fidelity, readable formatting, contact parsing, images, post metadata, view/exposure counts, pinned/unread state, deep-sea category distinctions and share/navigation links
- [ ] NOT IMPLEMENTED — Interactions: likes and liked-items lists, post subscriptions, vote submission/results, comments/replies, anonymous comment identities, comment pin/unpin, comment-disable policy and author deletion
- [ ] NOT IMPLEMENTED — Publish reliability: saved request identity and frozen payload; response-loss recovery; replay without duplicate content, reward or notification; account-isolated pending drafts/attempts

## Community, errands and reviews

- [ ] NOT IMPLEMENTED — Groups/official accounts: category list/search, details, application and approval, image/QR presentation, editing, owners/managers, administrator add/remove/transfer and my groups
- [ ] NOT IMPLEMENTED — Activities: list/detail, organizer/group selection, create with images/time/location, my activities, subscriptions, last-view/new-activity indicators and school permission rules
- [ ] NOT IMPLEMENTED — Errands: publish/list/detail, region and contact fields, my published/accepted orders, accept/cancel/delete/complete, legal state transitions, publisher/accepter private information and administrator restrictions
- [ ] NOT IMPLEMENTED — Ratings: categories/tree/subcategories, targets and random selection, score submission/statistics, own score, comments/replies, likes, subscriptions and authorized deletions
- [ ] NOT IMPLEMENTED — Rating administration: category/target create/edit/delete, per-school visibility/permissions/order/overrides, batch subcategory maintenance, system categories, image and description assistance
- [ ] NOT IMPLEMENTED — Existing specialist review capabilities: courses and course comments/ratings, majors/departments and comments, canteens/floors/windows, food recommendations, additional review objects/categories

## Communication and moderation

- [ ] NOT IMPLEMENTED — Private messages: conversation create/list, real/anonymous contexts, history pagination, text/image sending, unread counts, read markers, recall, deletion, blocking and anti-harassment limits
- [ ] NOT IMPLEMENTED — Notifications: grouped counts and lists, mark read, badges, comment/reply/like/activity/review events, application/group-review details, live updates and session-safe refresh
- [ ] NOT IMPLEMENTED — Notification preferences/delivery: post-specific settings, mute/subscription status, mini-program subscriptions, official-account templates, reminders/guides, queued delivery and duplicate prevention
- [ ] NOT IMPLEMENTED — User safety: block/unblock/list/check, reporting posts/comments/replies, report status/count/voting, restricted interactions and consistent anonymous identity protection
- [ ] NOT IMPLEMENTED — Moderation: post status/category/visibility, pins/read markers, content/image review, profile moderation, bans/unbans, feature restrictions and moderation history
- [ ] NOT IMPLEMENTED — School/super administration: scoped user lookup, identity changes, admin appointment/scope, roles and expiry, school changes, UID management, user/post rankings and data overview
- [ ] NOT IMPLEMENTED — School configuration: community/official-account/admin contact settings, review channels, unverified-post settings, push configuration and authorized test delivery
- [ ] NOT IMPLEMENTED — Announcements/feedback: announcement list/new checks/popups, school targeting, create/edit/delete, reading layout, feedback submission/viewing and responsible-admin notifications

## Campus tools and service operations

- [ ] NOT IMPLEMENTED — Academic tools: institutional login linkage, semester navigation, grades/credits/GPA, cache/refresh behavior and recoverable authentication failures
- [ ] NOT IMPLEMENTED — Campus utilities: map/location permissions and fallback, marker exploration, shuttle timetable images, research-tool information/link sharing, external learning-tool handoff and in-app web views
- [ ] NOT IMPLEMENTED — Lost-card flows: card/image submission, pickup/contact details and notification preferences; existing completion/availability requires product verification
- [ ] NOT IMPLEMENTED — Legacy placeholder/link audit: resource upload/download, subject-information entry, book-information integration and old navigation aliases; establish intended behavior without inventing a completed legacy feature
- [ ] NOT IMPLEMENTED — Media: public uploads, avatars, authenticated/private images, preview/transformation/compression, consistent URLs and retained access restrictions
- [ ] NOT IMPLEMENTED — Official-account operations: callbacks/follow state, account mappings, materials, article/draft generation, previews, publication and per-school scheduled pushes
- [ ] NOT IMPLEMENTED — Background operations: notifications, view/exposure persistence, hot-score recalculation, scheduled work, cache refresh/invalidation, report generation and authorized operational diagnostics
- [ ] NOT IMPLEMENTED — Assisted content capabilities: description generation, moderation assistance, reading-format generation and related queued work; provider implementation and cost policy must be explicitly approved before enabling external model calls

## Release gates across every feature

- [ ] NOT IMPLEMENTED — Explicit API contracts: new versioned endpoints, validated request/response types, consistent error codes, pagination, optional/null fields, uploads and generated native-client contracts
- [ ] NOT IMPLEMENTED — Authorization matrix: unauthenticated, phone-unverified, student-unverified, verified, banned/restricted, school administrator and super administrator; cross-school and ownership denial cases
- [ ] NOT IMPLEMENTED — Data preservation: existing IDs, relationships, histories, school/anonymous identities, soft-deletion state, content/media references, ordering, timestamps and monetary values
- [ ] NOT IMPLEMENTED — Concurrency/recovery: publication replay, one errand accepter, message limits/unread counts, queue delivery, exposure flush recovery, interrupted client requests and account switching
- [ ] NOT IMPLEMENTED — Native-client parity: each supported platform implements its full feature checklist, with permission/cancellation/error/retry behavior and compatible deep-link/navigation destinations
- [ ] NOT IMPLEMENTED — Migration/cutover: authorized schema inventory, restore rehearsal, reconciliation, writer/queue coordination, new-client smoke tests and tested post-cutover data recovery

## Evidence and scope limits

This initial checklist was derived from the legacy mini-program page/subpackage manifest, frontend modules and the full controller declaration inventory, plus the existing standalone regression suite. It intentionally contains no production identifiers, credentials, private deployment URLs or customer data.

All capabilities still need acceptance cases tied to real implementation commits. External-service availability and apparently incomplete legacy entries require confirmation; they are not grounds for silently reducing the feature set. An errand reward amount does not by itself establish an online payment feature.
