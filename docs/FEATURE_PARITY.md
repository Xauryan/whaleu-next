# Feature parity tracker

The rewrite target is full feature parity, with NestJS, PostgreSQL 18 and platform-native clients. This is a source-grounded implementation checklist, not a claim that the new application is ready. This is a greenfield implementation: preserve all business capabilities and production data, while redesigning module boundaries, schema and API contracts. Legacy API compatibility and simultaneous old/new production operation are out of scope. Old route declarations are evidence of business behavior, not an API design to copy.

**Status meanings:** NOT IMPLEMENTED means the capability is not delivered; PARTIAL means a tested subset exists with explicit remaining work. Check a row only after the whole capability and its relevant native-client flows are verified. A framework scaffold, placeholder screen or endpoint stub is not an implemented feature. Features shown in older source but not proven active remain in scope for clarification rather than silently being discarded.

## Accounts, schools and personal settings

- [ ] PARTIAL — Login/session: WeChat login, account creation/profile loading, access/refresh lifecycle, retry recovery, account switching, sign-out and session-scoped client state. The new server login/refresh/session/logout flow and native login controller have passed synthetic and PostgreSQL tests; real provider/device acceptance and complete profile loading remain outstanding
- [ ] PARTIAL — Identity verification: student application, application detail/status, image submission and review; email verification; institutional sign-in; phone verification/binding; verification guidance
- [ ] PARTIAL — School identity: school search and district selection; selected school versus verified institution; identity campus; related campuses; global university-city context; permission-sensitive switching
- [ ] PARTIAL — Public/personal profile: nickname, biography, avatar/default avatar, profile banner, school/UID display, titles, public profile, posts and trading listings, profile-post privacy
- [ ] PARTIAL — Preferences: system/manual theme, anonymous posting/comment defaults, anonymous-private-message preference, notification controls, guide/button settings, remembered publish contact/location choices
- [ ] PARTIAL — Experience: local owner ledger, daily sign-in, records, daily limits/tasks, levels, owned title/color selection and durable unlock notices are implemented with fresh source enrollment. Named public projections and bounded known-participant ranking are implemented. Limited-title catalog and inactive redemption infrastructure have passed local acceptance; bounded default/level-title maintenance has passed local acceptance. Actual role-title appointment, real campaign activation, complete historical population/import and production-scale processing remain open

## Campus feed and publishing

- [ ] PARTIAL — Feed discovery: campus/global feeds, category filtering, hot list, search, pagination, refresh, post details, user posts, my publications and my subscriptions
- [ ] PARTIAL — Post composition: text, multiple images, category, campus/location, draft save/restore/clear, remembered fields, preview, upload progress/error handling and safe repeated submission
- [ ] PARTIAL — Post modes: ordinary and anonymous identity, anonymous-DM option, trading category/price modes, contact fields, polls and options, group-formation details and join/contact retrieval
- [ ] PARTIAL — Linked content: board/category/group links and labels; publishing capabilities; related-campus synchronization; restricted/unverified publishing channels
- [ ] PARTIAL — Reading: original text fidelity, readable formatting, contact parsing, images, post metadata, view/exposure counts, pinned/unread state, deep-sea category distinctions and share/navigation links
- [ ] PARTIAL — Interactions: likes and liked-items lists, post subscriptions, vote submission/results, comments/replies, anonymous comment identities, comment pin/unpin, comment-disable policy and author deletion
- [ ] PARTIAL — Publish reliability: saved request identity and frozen payload; response-loss recovery; replay without duplicate content, reward or notification; account-isolated pending drafts/attempts

## Community, errands and reviews

- [ ] PARTIAL — Groups/official accounts: category list/search, details, application and approval, image/QR presentation, editing, owners/managers, administrator add/remove/transfer and my groups
- [ ] PARTIAL — Activities: current member-scoped list/detail, source-backed entry selection, successful-entry visit receipt and existing Profile reminder preference UI are implemented. Organizer/group authority, creation, media/QR, own activity history/lifecycle, scoped administration, dormant newness/badges, provider delivery, schema/data preservation and trusted import/cutover, physical devices and other platforms remain open
- [ ] PARTIAL — [Text-only errands](API_ERRANDS.md): exact-reviewed publish/discovery/detail, immutable source/target scope, own published/accepted histories, one-winner accept and publisher cancel/complete/soft-delete, participant privacy, remembered accepter contacts, minimal receipts and durable local accepted/completed notices. Separate feature restrictions are consumed. E2A adds exact-target/global read-only historical search, public participant references, opaque navigation and proven exact-or-unavailable totals. E2B adds exact-target deletion/accepter restrictions, global issue/release/recorded history, atomic local notices and native same-key recovery; complete validation is tracked separately. E3–E5 media, group/QR/help delivery, authoritative import and native-device/provider acceptance also remain open.
- [ ] PARTIAL — Ratings R1/R2A/R2B/R2C local development slices: trusted bounded category/target navigation, independent integer 1–5 scores/CAS changes, own score, independent known-or-unavailable statistics, exact-reviewed named/target-scoped-persona text roots, own deletion and durable minimal receipts. R2A adds flat text replies, typed parent chains, same-target personas, bounded paging/position, owner deletion and lifecycle-safe recovery, atomic fresh effects, real shared-pool Experience settlement and direct local notices/read state. R2B adds desired-state root/reply likes, exact current counts, per-transition shared Experience, lifetime local like notices and time/likes root ordering; its final gate is tracked separately. R2C adds independent target subscriptions, actor-only shared Experience, durable root/reply subscriber fan-out, separate local subscription updates and sequential catalog-card state batches; its final gate is tracked separately. Random selection, media, management, authoritative history, real review issuance and devices/providers remain open. See [R1 contract](API_RATINGS.md) [R2A contract](API_RATINGS_DISCUSSION.md) [R2B contract](API_RATINGS_LIKES.md) and [R2C contract](API_RATINGS_SUBSCRIPTIONS.md).
- [ ] PARTIAL — Rating content deletion R3A passed local integrated acceptance: original-campus scoped administrator deletion and hidden-parent owner cleanup, separate minimal contexts/receipts and native recovery. Full local checks and PostgreSQL regressions passed; hosted/production/device acceptance remains pending, and no production roles or original-school sources are seeded. See [R3A contract](API_RATINGS_ADMIN.md) and [acceptance status](acceptance/ratings-r3a.md).
- [ ] PARTIAL — R3R complete-pool random selection adds explicit native-campus institution scope, recursive streamed candidate admission, owner-native mutation proofs and exact optional minimum-score filtering. Local 1001/2048 pools are covered; resource-budget overflow is unavailable, and legacy equivalence plus production/load/device acceptance remain open. See [contract](API_RATINGS_RANDOM.md) and [acceptance](acceptance/ratings-r3r.md).
- [ ] NOT IMPLEMENTED — Rating administration: category/target create/edit/delete, per-school visibility/permissions/order/overrides, batch subcategory maintenance, system categories, image and description assistance
- [ ] NOT IMPLEMENTED — Existing specialist review capabilities: multidimensional course ratings, major/department directory and comments, canteen-floor ratings, separate window ratings/comments and dish recommendations. Their distinct scales and histories are not converted into generic 1–5 targets

## Communication and moderation

- [ ] NOT IMPLEMENTED — Private messages: conversation create/list, real/anonymous contexts, history pagination, text/image sending, unread counts, read markers, recall, deletion, blocking and anti-harassment limits
- [ ] PARTIAL — Notifications: grouped counts and lists, mark read, badges, comment/reply/like/activity/review events, application/group-review details, live updates and session-safe refresh
- [ ] PARTIAL — Notification preferences/delivery: post-specific settings, mute/subscription status, mini-program subscriptions, official-account templates, reminders/guides, queued delivery and duplicate prevention
- [ ] PARTIAL — User safety: block/unblock/list/check, reporting posts/comments/replies, report status/count/voting, restricted interactions and consistent anonymous identity protection
- [ ] PARTIAL — Moderation: post status/category/visibility, pins/read markers, content/image review, profile moderation, bans/unbans, feature restrictions and moderation history
- [ ] PARTIAL — School/super administration: scoped user lookup, identity changes, admin appointment/scope, roles and expiry, school changes, UID management, user/post rankings and data overview
- [ ] NOT IMPLEMENTED — School configuration: community/official-account/admin contact settings, review channels, unverified-post settings, push configuration and authorized test delivery
- [ ] PARTIAL — Announcements: public list/detail/newness/latest-popup reads and authenticated per-ID popup acknowledgement with native pages; targeting authority is explicit. Publication/admin/media/history import remain open
- [ ] NOT IMPLEMENTED — Feedback: submission, viewing and responsible-admin notifications

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
- Named-block snapshot `b3fb9c283f69bc776b4e71fd11e2d8a43769df6d`: 165 API tests, 515 native-client tests and 291 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37688226424), including directional policy, immutable recovery, anonymous isolation and native state invalidation. The commit signature is verified.
- Reports/jury snapshot `0f8e1d07bb4cedcd55a99b7188b77a0c1e8bc067`: 183 API tests, 575 native-client tests and 325 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37693021034), including deterministic removal, durable settlement and owner-only system notices. The commit signature is verified.
- Canonical runtime-policy and test-guard snapshot `a3f815e34a74f91e146890dde25539a38198692b`: 209 API tests, 582 native-client tests and 365 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37697445029), including normal-AppModule canonical authority and exact content-review binding. This supersedes the failed container-loopback guard run for its parent `3116ef22`; the corrected guard still requires a loopback client connection and peer, a dedicated test database and the pinned PostgreSQL version. The commit signature is verified.
- Identity-campus selection snapshot `b987a71c2b249c5bffb756712fc69526e34d930f`: 219 API tests, 618 native-client tests and 410 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37699401447), including complete canonical candidate enumeration, immutable recovery, post-wait authority races and native draft preservation. The commit signature is verified.
- Resolved-trading contact snapshot `5d49618f6b6ce13b5ee28f47e3a4865ff6817ca8`: 219 API tests, 631 native-client tests and 420 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37700745123), including resolved-owner suppression, reopen storage preservation, current-policy lock races and stale native disclosure barriers. The commit signature is verified.
- Public-profile and liked-history snapshot `319fd3a96b8f4cd76721f8a4300fda8b6d23e917`: 226 API tests, 670 native-client tests and 456 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37702906848), including profile privacy, exact-target liked anonymity, historic null dates and native routing/lifecycle. The commit signature is verified. The documented 1,024-candidate capacity gate remains unfinished at this snapshot.
- Scalable discovery-page snapshot `23002cbbcfbeb482b8758cf2ba67a81de8eb20d1`: 234 API tests, 684 native-client tests and 478 reported real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37705245053), including long and undated histories, hidden-only scan continuation, exact microsecond cursor positions and fresh native page replacement. The commit signature is verified. Large-history exact counts remain an explicit unfinished gate at this snapshot.
- Exact-count development snapshot `8f22600dc1e75b76fded79dbe1dd4da6b5c72b10` was signed and published after 1,511 local tests passed. Its [CI run](https://github.com/Xauryan/whaleu-next/actions/runs/37713167590) passed 297 API and 685 native tests but only 520/529 PostgreSQL tests: mixed-liked positive assertions exceeded the 1,500 ms optional scan budget on the hosted runner. This snapshot is **not CI-green**; its local performance evidence does not establish the same budget on slower machines.
- Named-read/discussion and count-budget repair snapshot `ca7dbd8eef35af041995e331b83508b1a5d7bc9e`: 308 API tests, 702 native-client tests and 583 real PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37715113656), with zero failures/skips. The commit signature is verified. This supersedes the failed 1,500 ms hosted-count budget in `8f22600` with a finite 2,000 ms per-count budget while preserving all exactness checks. Named finalization, v3 page replacement and audit recovery passed; documented scale, concurrency, provider/device and production gaps remain open.
- Local experience snapshot `8f4eee24bff7fb35608b9bb56e50685fad8800d6`: 356 API tests, 763 native-client tests and 623 PostgreSQL integration tests passed in [CI](https://github.com/Xauryan/whaleu-next/actions/runs/37720411199), zero failures/skips; signature verified. Fresh reward provenance, independent settlement, owned appearance and recoverable post-like intents are a partial local slice. A separate [10,000-unit warm-history observation](acceptance/experience-history-capacity.md) passed bounded development latency checks without establishing production or default dispatcher throughput.
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
At this initial checkpoint, runtime verification, safety, moderation, visibility
and media adapters were unavailable; later increments below add owned sources
while preserving fail-closed behavior for missing canonical facts. Student-number data has no authoritative production
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
are fetched only through current authenticated parent visibility for open listings;
resolved listings suppress all chosen contact fields even for the owner, retain
storage, and restore read eligibility only after a current-policy reopen. Native
unknown-resolution and stale-response barriers are covered alongside canonical
PostgreSQL lock races. Client-only
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

Local reporting/jury checkpoint: typed post/root/reply report intake, immutable
own receipts, current visible-target progress, frozen scoped report weighting and
post-jury voting are implemented. Five effective reports open one jury; six votes
close early, otherwise durable default-off local work applies the 24-hour rule.
Discussion's tenth report removes the target and preserves its first-report
provider-disabled review obligation. Community-owned removal, pin release, audit
and jury-removal author system notices commit atomically. System notices remain
owner-only and readable after deletion. Native report/vote recovery, independent
progress and system-notice read state are tested. Historical report coverage,
related/global school-admin scope, external review, post-pin administration,
ban/restriction issuance, appeals and production/device acceptance remain
incomplete. See [reporting and jury scope](REPORTING_JURY.md).

Canonical runtime policy checkpoint: normal application providers now compose
phone, affiliation, current identity-campus/topology/configuration, grants and
safety facts without policy-test overrides. Verified related-region anonymous
posts and cross-region anonymous comments have distinct source-grounded rules;
management and new-post comment-control are separate. Exact versioned approval
records bind actor, operation, effective content, assets, scope and ancestry to
accepted resources; ordinary visibility reconstructs and validates those bindings.
Unknown history is not backfilled. Publication capability remains unavailable
without a review issuance workflow, even when preapproved exact local intents
can publish. Identity selection controls, configuration/review administration,
media, real verification/providers, historical reconciliation and physical-device
acceptance remain outstanding. See [runtime policy scope](COMMUNITY_RUNTIME_POLICY.md).

Identity-campus selection checkpoint: authenticated owners can inspect independently
validated selection/options and explicitly select or renew a physical identity
campus using canonical affiliation, phone, safety and complete topology facts.
The new normal-AppModule API and native selector preserve browsing preferences,
verification records, existing content scopes and management authority. Immutable
receipts recover uncertain outcomes without replaying old state; changed inputs
require fresh explicit confirmation, including for the same campus. Unknown
history remains distinct from known missing choice. Publication drafts keep their
original targets and require a separate send action after selection. This does not
issue verification, topology, review approvals or real grants, activate providers,
reconcile production history, or implement physical-device acceptance. See
[identity-campus API and boundaries](API_IDENTITY_CAMPUS.md).

Public-profile/discovery development checkpoint: named public profiles, separate
public post/trading lists, own liked-history projections, named-only author
navigation and profile-sourced recoverable blocking are implemented against the
canonical local owners. `hideProfilePosts` affects both other-viewer lists and
counts without concealing basic profile fields; bilateral profile visibility is
separate from outgoing-only ordinary feed filtering. Read-only self-reference
never initializes a profile. Missing authoritative affiliation, public school UID,
level/title and received-interaction metrics remain explicitly unavailable. Known
historic likes retain null dates and opaque storage-record identities, rather
than invented event times. Native next/previous reads replace pages and revalidate
current policy instead of reusing old card bodies. **Capacity at this checkpoint (superseded for paging below):**
more than 1,024 current candidates in a public list or own liked-history set makes
that query unavailable, including affected profile counts. Scalable all-history
paging and exact counts are still required before full discovery/history parity;
this is not a source-imposed date or record-retention cutoff. Media, authoritative
optional displays, provider/device acceptance and production import also remain
open. See [public profiles](API_PUBLIC_PROFILES.md) and
[own liked history](API_LIKED_HISTORY.md).

Scalable discovery-page checkpoint: the previous whole-history query failure is
removed from public profile pages and own liked-history traversal. Bounded scans
and durable opaque position references can continue through hidden-only batches
and across older or undated records without a source-age cutoff. Native screens
distinguish scan continuation, known end and unavailable counts, and re-read prior
pages rather than restoring cached bodies. Exact database microsecond positions
prevent same-millisecond post skips; public timestamps remain unchanged. Small
basic counts retain their previous bounded exact-count window, while count-only
uncertainty or expiry can clear that field without weakening mandatory identity,
privacy or safety checks. Exact totals for larger histories remain a separate
release gate; an unavailable count is not zero or a claim that the history ended.
No background cleanup job, provider or production migration was activated.

Exact discovery-count development checkpoint: canonical nonlocking owner batches
and final READ COMMITTED mutation proofs now replace the 1,024-row count ceiling.
The same independently optional path supplies basic post/trade counts, exact
subtype list totals and current visible liked memberships. Positive canonical
4,097-post and mixed-liked results pass under the normal count budget;
25,000-post/like results require a separately labeled benchmark budget. Operational
availability remains incomplete: unrelated writer churn invalidates large counts,
concurrent finalizers can conflict, and the supported PostgreSQL capacity envelope
is bounded. Small complete sets retain an independently fenced fallback under
unrelated committed churn; active writers or maintenance locks can still make
that optional count unavailable. There are no rollups, background jobs, production imports or fabricated
review/verification facts. `totalInteractions` remains a separate unavailable
legacy received-interaction metric. See the [operating evidence](acceptance/exact-discovery-counts.md)
for measured limits; positive fixtures are not a claim of universal count availability.

Named-read finalization and discussion v3 checkpoint: the remaining inventoried
body/contact/identity read owners now explicitly use READ COMMITTED and a final
mandatory block-relationship proof, including Saved status and audited identity
POSTs. Directional child/member policies and intentional own-block/receipt
exceptions remain distinct. Abandoned whole identity payloads preserve durable
attempt metadata; actual disclosure failures roll back disclosure audits.
Discussion v3 selects roots before rendering their replies, preserving ordering
and pins without inspecting off-page reply bodies for cursor stability. Native
Previous/Next navigation refetches current pages and context instead of restoring
cached previews, while preserving compose targets and drafts. This does not remove
the independent root/reply/PostView scale limits, certify mutation/raw-writer
consistency, revoke previously committed responses, or complete provider/device
and production acceptance. The same development increment adjusts the optional
count scan budget to 2,000 ms per count after the recorded hosted-CI shortfall;
it does not weaken exactness or enlarge final safety-proof budgets. See
[named-read boundaries](NAMED_READ_FINALIZATION_GAP.md) and
[count operating evidence](acceptance/exact-discovery-counts.md).

Local experience Stage1 checkpoint: genuine new-account provenance establishes
known zero while existing unproven balances/streaks remain explicitly unknown.
Fresh community transitions atomically enroll immutable complete beneficiary work;
each owner settles independently and exactly once, so an unknown recipient does
not block a known actor. Sign-in uses the post-lock Shanghai day, and source-mapped
quotas, deletion penalties/refunds, re-like/re-save behavior and retained ownership
remain explicit. New durable post-like intents survive lost responses and
intervening unlike actions without replaying an old state. Native owner history,
separate sign-in/appearance recovery, truthful coverage and unlock acknowledgement
are verified through real HTTP/native/PostgreSQL tests. Existing whole-row guards
remain unchanged; the final provenance hook and exact SQL timestamp handling
preserve trading deletion and finer source times. Automatic processing is local
opt-in only; the CLI isolates unrelated dispatchers. Production-scale ledger
throughput, production processing, public experience fields/received totals,
rankings, redemption, global maintenance, device/provider acceptance and history
reconciliation remain separate gates. See [experience contract](API_EXPERIENCE.md)
and [local acceptance](acceptance/experience-stage1.md).

Public experience display and dispatcher checkpoint: named community surfaces and
available public profiles now expose independently known title, color and level
through one narrow read-only projection. Anonymous/unavailable shapes remain
unchanged, and native shared templates preserve unknown versus known-none values.
Final named-disclosure policy proofs still apply; cosmetic display confers no
identity or role authority. Local full gates pass 1,821 tests. The dispatcher now
uses one bounded attempt budget across successive owner frontiers without
revisiting failed units or overtaking blocked predecessors; this is round-bounded
fairness, not a global starvation-free guarantee. Public experience fields are
therefore implemented locally, superseding that part of the Stage1 gap list above.
Received totals, rankings, limited/special titles, historical coverage and
production/device acceptance remain open. See
[acceptance evidence](acceptance/experience-public-display.md).

Bounded experience ranking checkpoint: the backend now supports guest or strictly
authenticated known-participant ordering, with a stable bigint snapshot and safe
public level/title/color only. Existing profiles, active accounts and bilateral
named-profile policy are enforced before disclosure and through finalization.
The result always labels historical population completeness as incomplete and
explicitly reports work/time truncation. No exact public score, ordinal/own rank,
native leaderboard UI or historical zero is invented. Migration 0023 adds the
ordered index only. Local aggregate gates pass 1,849 tests; see
[ranking acceptance](acceptance/experience-ranking.md). This supersedes the generic
ranking-backend gap above; complete-population ranking remains unavailable.

Limited-title/redemption checkpoint: SQL/API/native/public projections now share
17 reviewed nonsecret catalog entries, with grouped inventory and a strict limited
title selection/display path. Owner redemption infrastructure has exact-byte keyed
intent binding, immutable atomic decision/entitlement/receipt proofs and a
nonsecret native recovery handle. Full local gates pass 1,887 tests. Production
provider/budget remain unavailable; only explicitly guarded synthetic fixtures
exercise grants. No real code, default key, activation switch, account grant or
campaign restoration is included. Existing unknown balances, undated ownership
and unsaved appearance drafts remain intact. See
[acceptance evidence](acceptance/title-redemption.md). Real provisioning/abuse
protection/activation and historical import remain separate gates.

Authorized title-maintenance checkpoint: explicit developer/superadministrator
commands now repair missing default or currently earned level titles through
one-owner transactions and immutable resumable receipts. Live authority and
session deadlines protect normal results and actor-scoped recovery errors after
all waits. Unknown history is skipped; original undated ownership, higher titles
and selections remain untouched. Local aggregate gates pass 1,956 tests. No
operator role, real-account grant, automatic job or role_admin cosmetic was issued.
This completes the bounded backend repair capability, not historical import,
large-scale throughput or actual administrator appointment. See
[acceptance evidence](acceptance/title-maintenance.md).

Post subscription-component checkpoint: future native publications now establish
same-transaction zero provenance, while all preexisting posts remain unknown.
Actual Saved transitions feed an internal causal membership/count projection with
atomic receipt/effect/save_ranking acknowledgement. Manual explicit-selection CLI
and genuinely read-only dry-run are verified; other obligation owners and public
DTOs are unchanged. Local aggregate gates pass 2,004 tests. This is one internal
hotness input, not a complete score, hot feed, search or exposure feature. Historical
reconciliation, production throughput and the separate received-total policy remain
open. See [component contract](POST_SUBSCRIPTION_COMPONENT.md) and
[acceptance evidence](acceptance/post-subscription-component.md).

Post-like component checkpoint: independent future-native-post baselines and
actual INSERT/DELETE sources now retain like epochs through unlike/re-like, with
causal membership and atomic receipt/effects. Existing subscription-known posts
stay like-unknown; no reward, author-total or public hot-feed contract is changed.
Parent NOWAIT capture, invisible-parent protection, TRUNCATE rejection and manual
read-only CLI behavior are verified. Local aggregate gates pass 2,076 tests. This
is another internal score input, not full hotness, view tracking or production
history reconciliation. See [component contract](POST_LIKE_COMPONENT.md) and
[acceptance evidence](acceptance/post-like-component.md).

## Explicit-space search increment

Backend and native WeChat search now cover one selected active regional/global
space, literal Unicode lowercase substring matching, privacy-first bounded
structural traversal and opaque continuation. Fresh page navigation, scope and
account invalidation, and no persistent query history are tested. This is PARTIAL:
cross-school/related-campus modes, remaining historical categories, history, hot
suggestions, complete import and physical-device acceptance remain open. See
[scope](COMMUNITY_SEARCH.md) and [local acceptance](acceptance/community-search.md).

Federated search extends the tested subset to all eligible communities, all
regional communities with current category filters, or all global communities.
Urgent/resolved aggregate trading, complete catalog membership and restart-on-scope
change are covered. Related opt-in distribution, unsupported historical category
population, import, search history/hot suggestions and real-device acceptance
remain open. See [federated acceptance](acceptance/federated-search.md).

Bounded view-reporting increment: fresh native posts acquire independent view
coverage; authenticated feed/detail reporting has atomic replay, a fixed detail
cooldown and immutable 24-hour epoch expiry. Native viewport observation and
account-scoped bounded queues are implemented. Official Nest scheduling/request
throttling and vetted native hashing are reused. Historical views, public count
projection, hot-score/ranking, search exposures, production/device acceptance and
full parity remain open. See [view scope](VIEW_REPORTING.md) and
[local acceptance](acceptance/view-reporting.md).

Internal comment/reply hotness inputs now have independent fresh coverage,
transactional capture, causal manual settlement and retained actor cardinality.
Deleted-root descendants follow source accounting internally while existing read
visibility is unchanged. This does not complete hot score/feed or decide author
received-interaction deletion policy. See [component scope](POST_COMMENT_COMPONENT.md)
and [local acceptance](acceptance/comment-component.md).

Internal selected-post score composition now checks all independent component
baselines and caught-up capture, then evaluates verified source-formula metadata
with an explicitly versioned PostgreSQL numeric profile. It is disabled-by-default,
local/manual, nonmutating and has no public ranking or score field. Formula bit
parity, public ordering privacy, population/freshness/ties and hot-feed UI remain
open. See [internal score scope](INTERNAL_HOT_SCORE.md).

Member-scoped directory category/list/name-search/detail and three native pages now
have local acceptance. Shared official taxonomy remains separate from regional
entries; current verified home identity gates every read. Media, applications,
review/admin exceptions, managers, visit recording, history/import and other
platforms remain open. See [directory scope](API_ORGANIZATION_DIRECTORY.md) and
[acceptance](acceptance/organization-directory.md).

Unified public hot-feed development now includes explicit-space native-covered
ranking, exact-current score certificates, bounded owner settlement/refresh,
opaque live pagination and a real native page with existing exposure reporting.
Current visibility still filters posts/nested content independently from unified
heat. Default processing remains disabled. Related distribution, historical
coverage, auxiliary home/search hot widgets, production load/activation and device
acceptance remain open. See [scope](unified-public-hot-feed.md) and
[local acceptance](acceptance/unified-hot-feed.md).

Activities now have a locally accepted first vertical slice: current member-scoped
list/detail, source-backed entry selection, successful-entry visit receipt and
existing Profile reminder preference UI. Creation, organizers, media/QR, own
history/lifecycle, administration, dormant badges/newness, provider delivery,
source preservation and trusted import/cutover, physical devices and other
platforms remain open. See [scope](API_ACTIVITIES.md) and
[local acceptance](acceptance/activities.md). The whole activity feature remains
PARTIAL; no production-ready or full-parity claim is made.

### Rating management M1 development increment

Native generic target creation now has prepared exact Review identity, immutable
catalog derivation/CAS, same-transaction independent fresh-zero source, and v5
native same-key recovery. Ordinary qualified users require no administrator
create grant. Original campus remains explicitly unknown when unproven. See
[API](API_RATINGS_MANAGEMENT.md), [design](design/ratings-management-m1.md), and
[acceptance limits](acceptance/ratings-management-m1.md). This does not complete
creator metadata edit/delete, category management or school overrides, real
issuer/provider wiring, native device acceptance, or production import.
