# Feature parity tracker

The rewrite target is full feature parity, with NestJS, PostgreSQL 18 and platform-native clients. This is a source-grounded implementation checklist, not a claim that the new application is ready. This is a greenfield implementation: preserve all business capabilities and production data, while redesigning module boundaries, schema and API contracts. Legacy API compatibility and simultaneous old/new production operation are out of scope. Old route declarations are evidence of business behavior, not an API design to copy.

**Status meanings:** NOT IMPLEMENTED means the capability is not delivered; PARTIAL means a tested subset exists with explicit remaining work. Check a row only after the whole capability and its relevant native-client flows are verified. A framework scaffold, placeholder screen or endpoint stub is not an implemented feature. Features shown in older source but not proven active remain in scope for clarification rather than silently being discarded.

## Accounts, schools and personal settings

- [ ] PARTIAL — Login/session: WeChat login, account creation/profile loading, access/refresh lifecycle, retry recovery, account switching, sign-out and session-scoped client state. The new server login/refresh/session/logout flow and native login controller have passed synthetic and PostgreSQL tests; real provider/device acceptance and complete profile loading remain outstanding
- [ ] PARTIAL — Identity verification: student application, application detail/status, image submission and review; email verification; institutional sign-in; phone verification/binding; verification guidance
- [ ] PARTIAL — School identity: school search and district selection; selected school versus verified institution; identity campus; related campuses; global university-city context; permission-sensitive switching
- [ ] PARTIAL — Public/personal profile: nickname, biography, avatar/default avatar, profile banner, school/UID display, titles, public profile, posts and trading listings, profile-post privacy
- [ ] PARTIAL — Preferences: system/manual theme, anonymous posting/comment defaults, anonymous-private-message preference, notification controls, guide/button settings, remembered publish contact/location choices
- [ ] NOT IMPLEMENTED — Experience: daily sign-in, experience records, daily limits/tasks, levels, title/color display, level-up notification, rankings and administrator title maintenance

## Campus feed and publishing

- [ ] PARTIAL — Feed discovery: campus/global feeds, category filtering, hot list, search, pagination, refresh, post details, user posts, my publications and my subscriptions
- [ ] PARTIAL — Post composition: text, multiple images, category, campus/location, draft save/restore/clear, remembered fields, preview, upload progress/error handling and safe repeated submission
- [ ] PARTIAL — Post modes: ordinary and anonymous identity, anonymous-DM option, trading category/price modes, contact fields, polls and options, group-formation details and join/contact retrieval
- [ ] PARTIAL — Linked content: board/category/group links and labels; publishing capabilities; related-campus synchronization; restricted/unverified publishing channels
- [ ] PARTIAL — Reading: original text fidelity, readable formatting, contact parsing, images, post metadata, view/exposure counts, pinned/unread state, deep-sea category distinctions and share/navigation links
- [ ] PARTIAL — Interactions: likes and liked-items lists, post subscriptions, vote submission/results, comments/replies, anonymous comment identities, comment pin/unpin, comment-disable policy and author deletion
- [ ] PARTIAL — Publish reliability: saved request identity and frozen payload; response-loss recovery; replay without duplicate content, reward or notification; account-isolated pending drafts/attempts

## Community, errands and reviews

- [ ] NOT IMPLEMENTED — Groups/official accounts: category list/search, details, application and approval, image/QR presentation, editing, owners/managers, administrator add/remove/transfer and my groups
- [ ] NOT IMPLEMENTED — Activities: list/detail, organizer/group selection, create with images/time/location, my activities, subscriptions, last-view/new-activity indicators and school permission rules
- [ ] NOT IMPLEMENTED — Errands: publish/list/detail, region and contact fields, my published/accepted orders, accept/cancel/delete/complete, legal state transitions, publisher/accepter private information and administrator restrictions
- [ ] NOT IMPLEMENTED — Ratings: categories/tree/subcategories, targets and random selection, score submission/statistics, own score, comments/replies, likes, subscriptions and authorized deletions
- [ ] NOT IMPLEMENTED — Rating administration: category/target create/edit/delete, per-school visibility/permissions/order/overrides, batch subcategory maintenance, system categories, image and description assistance
- [ ] NOT IMPLEMENTED — Existing specialist review capabilities: courses and course comments/ratings, majors/departments and comments, canteens/floors/windows, food recommendations, additional review objects/categories

## Communication and moderation

- [ ] NOT IMPLEMENTED — Private messages: conversation create/list, real/anonymous contexts, history pagination, text/image sending, unread counts, read markers, recall, deletion, blocking and anti-harassment limits
- [ ] PARTIAL — Notifications: grouped counts and lists, mark read, badges, comment/reply/like/activity/review events, application/group-review details, live updates and session-safe refresh
- [ ] PARTIAL — Notification preferences/delivery: post-specific settings, mute/subscription status, mini-program subscriptions, official-account templates, reminders/guides, queued delivery and duplicate prevention
- [ ] PARTIAL — User safety: block/unblock/list/check, reporting posts/comments/replies, report status/count/voting, restricted interactions and consistent anonymous identity protection
- [ ] NOT IMPLEMENTED — Moderation: post status/category/visibility, pins/read markers, content/image review, profile moderation, bans/unbans, feature restrictions and moderation history
- [ ] PARTIAL — School/super administration: scoped user lookup, identity changes, admin appointment/scope, roles and expiry, school changes, UID management, user/post rankings and data overview
- [ ] NOT IMPLEMENTED — School configuration: community/official-account/admin contact settings, review channels, unverified-post settings, push configuration and authorized test delivery
- [ ] NOT IMPLEMENTED — Announcements/feedback: announcement list/new checks/popups, school targeting, create/edit/delete, reading layout, feedback submission/viewing and responsible-admin notifications

## Campus tools and service operations

- [ ] NOT IMPLEMENTED — Academic tools: institutional login linkage, semester navigation, grades/credits/GPA, cache/refresh behavior and recoverable authentication failures
- [ ] NOT IMPLEMENTED — Campus utilities: map/location permissions and fallback, marker exploration, shuttle timetable images, research-tool information/link sharing, external learning-tool handoff and in-app web views
- [ ] NOT IMPLEMENTED — Lost-card flows: card/image submission, pickup/contact details and notification preferences; existing completion/availability requires product verification
- [ ] NOT IMPLEMENTED — Legacy placeholder/link audit: resource upload/download, subject-information entry, book-information integration and old navigation aliases; establish intended behavior without inventing a completed legacy feature
- [ ] NOT IMPLEMENTED — Media: public uploads, avatars, authenticated/private images, preview/transformation/compression, consistent URLs and retained access restrictions
- [ ] NOT IMPLEMENTED — Official-account operations: callbacks/follow state, account mappings, materials, article/draft generation, previews, publication and per-school scheduled pushes
- [ ] PARTIAL — Background operations: notifications, view/exposure persistence, hot-score recalculation, scheduled work, cache refresh/invalidation, report generation and authorized operational diagnostics
- [ ] NOT IMPLEMENTED — Assisted content capabilities: description generation, moderation assistance, reading-format generation and related queued work; provider implementation and cost policy must be explicitly approved before enabling external model calls

## Release gates across every feature

- [ ] PARTIAL — Explicit API contracts: new versioned endpoints, validated request/response types, consistent error codes, pagination, optional/null fields, uploads and generated native-client contracts
- [ ] PARTIAL — Authorization matrix: unauthenticated, phone-unverified, student-unverified, verified, banned/restricted, school administrator, super administrator and developer; cross-school and ownership denial cases
- [ ] NOT IMPLEMENTED — Data preservation: existing IDs, relationships, histories, school/anonymous identities, soft-deletion state, content/media references, ordering, timestamps and monetary values
- [ ] PARTIAL — Concurrency/recovery: publication replay, one errand accepter, message limits/unread counts, queue delivery, exposure flush recovery, interrupted client requests and account switching
- [ ] NOT IMPLEMENTED — Native-client parity: each supported platform implements its full feature checklist, with permission/cancellation/error/retry behavior and compatible deep-link/navigation destinations
- [ ] NOT IMPLEMENTED — Migration/cutover: authorized schema inventory, restore rehearsal, reconciliation, writer/queue coordination, new-client smoke tests and tested post-cutover data recovery

## Evidence and scope limits

This initial checklist was derived from the legacy mini-program page/subpackage manifest, frontend modules and the full controller declaration inventory, plus the existing standalone regression suite. It intentionally contains no production identifiers, credentials, private deployment URLs or customer data.

All capabilities still need acceptance cases tied to real implementation commits. External-service availability and apparently incomplete legacy entries require confirmation; they are not grounds for silently reducing the feature set. An errand reward amount does not by itself establish an online payment feature.

## Verified implementation checkpoints

- Foundation and identity snapshot `806a2b00429e12ef4eacc3ab1574746393937edb`: 60 API tests, 96 native-client tests, and 22 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37628632248). This is not full product parity or a production rollout.
- Campus/profile snapshot `417b1847b14895e46519925709ee96e471897330`: 66 API tests, 130 native-client tests and 43 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37636428025), including native gateway → Nest HTTP → PostgreSQL contracts. The commit signature is verified.
- Community/developer/school-code snapshot `cc3ef8bb3904b7b7b369b0f3110418a9a60cd775`: 88 API tests, 182 native-client tests and 93 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37642626842), including community/privacy native gateway → Nest HTTP → PostgreSQL contracts and school-code migration tooling. The commit signature is verified.
- Verification-preservation snapshot `6ed0d7e1e306bc9b7a104a2c4d880552afa61b4f`: 93 API tests, 217 native-client tests and 110 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37646773204), including actual native verification-summary contracts and final-clock privacy checks. The commit signature is verified.
- Poll snapshot `3c10b6c42d963b1595c31b9ab9959bf0b4e2f36b`: 98 API tests, 250 native-client tests and 137 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37649513781), including native poll publication, ballot recovery and privacy contracts. The commit signature is verified.
- Discussion snapshot `27d2c7cb7a29f80e2bcb2080fffdc8e84a832d2e`: 102 API tests, 291 native-client tests and 159 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37654039425), including native reply, reaction, pin and audited identity contracts. The commit signature is verified.
- Trading snapshot `699c4f34cf145f5e7b1b0a02131cee50f2747c42`: 106 API tests, 337 native-client tests and 183 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37658218303), including exact prices, private contact access and durable status recovery. The commit signature is verified.
- Formation snapshot `f68c32f35093f97a411cd3070cefc829288c2fa2`: 111 API tests, 377 native-client tests and 216 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37670924060), including concurrent joins, private contact access and audited roster identity. The commit signature is verified.
- Saved snapshot `88d8a785daf8161e80a295f291a900e7e50f04af`: 115 API tests, 444 native-client tests and 244 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37673805090), including exact Saved visibility, preference independence and durable recovery. The commit signature is verified.
- Local Updates snapshot `43faae3927ee1c81a42a9b00fa94bc79b866425b`: 125 API tests, 482 native-client tests and 261 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37682737147), including persisted notices, owner read state and durable automatic processing. The commit signature is verified.
- PostgreSQL data import, real provider configuration, native device verification and the remaining business modules are not completed by these checkpoints.

Campus/profile checkpoint: the target campus directory, physical-campus preference, own nickname/bio and 11 stored preferences are implemented and tested. Explicit operating-region mapping and regional/global space selection are now implemented in the community development slice. Real verification, operational authority configuration, avatar/media, public-profile enforcement and downstream preference consumers remain incomplete. A physical-campus selection grants no authority.

## Additional user requirements

- School business identifiers use reviewed five-digit institution codes, including
  Peking University `10001` and Beihang University `10006`. Preserve ten-digit
  official identifiers, provenance and legacy crosswalks. Physical campuses and
  community operating regions remain distinct entities. Unresolved mappings must
  remain explicit and must not be guessed from school names.
- Role precedence is developer, super administrator, then school administrator.
  Only the explicit developer capability permits the foreground identity overlay
  for anonymous authors and student numbers for named or anonymous authors.
  Ordinary content responses retain anonymity. Every privileged disclosure must
  be server-authorized and audited; real accounts receive no automatic grants.
  Actual student numbers require an authoritative verification source; unavailable
  information must not be fabricated. Inclusion of legal names is not assumed.

Community/authorization development checkpoint: chronological regional/global feed,
post detail, text post/root-comment composition, thread-local anonymous identities,
desired-state post likes, own soft deletion and durable account-isolated publication
receipts have backend and native-client tests. The developer-only identity overlay
has separate authorization, append-only access auditing and transient client state.
Normal runtime verification, safety, moderation, visibility and media adapters are
still fail-closed/unavailable. Student-number data has no authoritative production
source yet. No real account has received a role grant. Trading, subscriptions, related-region distribution, hot/search and the other listed business
capabilities remain required. See [community scope and gates](API_COMMUNITY.md).

Legacy verification preservation decision: retain overloaded historical identity
fields and their provenance without forced student-number backfill. Missing or
ambiguous student numbers must not downgrade an otherwise established school
affiliation. Future verification methods and number completion are deferred;
extension interfaces do not activate a new provider or require reverification.

Verification V1 development checkpoint: an immutable local assertion/history
ledger, provenance-aware developer student-number read-through and native
own-account status summary are implemented. Affiliation, number, phone and
application coverage remain independent. Unmapped accounts remain unavailable;
no production import, forced backfill, new authentication provider, application
submission/review, attestation or private-evidence flow is delivered by this slice.
See [verification V1 scope](API_VERIFICATION.md).

Community C2A development checkpoint: structured single/multiple-choice polls,
immutable account-owned ballots, separate voter/selection counts, historical
expiry, durable ballot receipts and native composition/voting/recovery are
implemented. Poll text participates in publication approval and idempotency.
Voting does not invent a student-verification requirement. Real gateway → HTTP →
PostgreSQL tests cover the contract; runtime policy adapters remain fail-closed
where unavailable. Full trading administration, subscriptions and the other
community backlog are still required. See [community API](API_COMMUNITY.md).

Community C2B development checkpoint: flat reply threads and safe target
projections, root/reply reactions, post-author-only root pins, ordered previews,
snapshot-bound continuation, deep-link context, identity-mode defaults and safe
+1 composition are implemented with durable recovery. Developer identity views
include replies through the separate audited boundary. Regional unverified
comment eligibility is independent of the new-post category allowlist. Counts
separate visible roots, replies and combined discussion. History, moderation,
feed-post administration, subscriptions, notifications/rewards consumers, media,
full trading administration and group directories remain required; no outbox record is treated as
successful external delivery or a paid reward.

Community C2C development checkpoint: named trading listings include thirteen
subtypes, exact decimal prices, chosen contact disclosures, location, ordinary
versus urgent distribution, explicit/own listing filters and independently
recoverable sold/open state. Historical raw price/subtype/location/contact text
has a separate read projection; new writes remain strictly validated. Contacts
are fetched only through current authenticated parent visibility. Client-only
remembered fields do not complete server-backed cross-device publishing
preferences. Public-profile listing privacy, scoped-manager actions, external
push delivery, media and full source-data migration remain required. No checkout,
escrow, payment or delivery service is invented by this listing slice.

Community C2D development checkpoint: post-based group formation includes creator
seats, capacity-one full state, immutable concurrent joins, durable membership
recovery and public persona-safe rosters. Entered contacts require explicit
members-only sharing consent and a separate current-access read/copy path.
Developer roster identity views use the existing audited API and do not grant
contact access to nonmembers. Historical display/provenance, phone-only joining
without an invented student gate, and account/hide/expiry clearing are tested.
This does not implement group directories, official accounts, invented leave/kick/
close operations, production import, real providers or physical-device acceptance.

Saved/update-preference increment 1 checkpoint: current-policy Saved browsing,
recoverable save/unsave, preserved urgent listings, immutable membership epochs,
independent per-post saved/external update intent and explicit own-state cleanup
are implemented. Native state and audited developer overlays are account/origin
scoped and transient. Re-save preserves mute choices; no-op saves do not reset
membership time. Reward/ranking obligations are durable but not settled. No
in-app notice, external delivery, provider consent, quota or device permission
is created merely by saving or enabling a preference. Actual community in-app
updates are covered by the separate increment below.

Community in-app Updates increment 2 checkpoint: local root/reply obligations can
materialize actual owner-scoped notices with exact unread/read state and fresh
authorized target navigation. Saved epochs, event-time and later mute fences,
recipient deduplication, suppression/retry separation and current visibility are
enforced. An optional default-off dispatcher persists automatic eligibility,
pending work and retries across restart; manual/imported backlog is not adopted.
Native capability copy distinguishes disabled/manual/automatic configuration
from specific generated records. External delivery, other notification domains,
experience settlement, imports and physical-device acceptance remain incomplete.
See [local Updates API](API_UPDATES.md).

Named-blocking S1A checkpoint: directional named-content block/unblock, own opaque
relationship list/status and durable account-owned recovery are implemented.
One-way discovery/child filtering and bilateral direct post/comment interaction
rules are explicit. Anonymous subjects never resolve hidden owners for blocking.
Phone-only eligibility, source-independent owner cleanup, immutable receipts and
final transaction deadlines are independently enforced. Native state invalidation
covers stale content, Saved, Updates, contact projections and audited overlays.
Authorized named-profile direction flags, anonymous conversation blocking,
reports/juries, restriction issuance and full moderation remain required. Runtime
base visibility and publication authority remain unavailable where their owned
sources are not yet implemented. See [named-blocking API](API_SAFETY.md).
