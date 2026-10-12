# Bounded scoped post pins and per-pin read state

This is a local development slice. It does not certify full Next, production
history import, related-campus or aggregate feeds, real providers, or physical
WeChat acceptance. Migration 0118 is additive; migrations 0001–0115 are unchanged.
PM3 independently owns 0116/0117 and Media15; no Media code is changed here.

## Fixed source and deliberate Next boundaries

Grounding: WhaleUCampus/WhaleU at
`57cf169c11123acf249909a1a7215b8cb1ec1f8e`,
[Message.php](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/controller/Message.php)
3721–4239 (commands/authority/conflict), 970–1200 (projection), and 3043–3051
(deletion). The source validator accepts integer hours 1–168, default 24, and
levels 1/2, default 2. Levels are priority metadata, not additional slots.

One operating-region slot spans all categories, including trading. Canonical
university-city and feedback each have one independent global slot. Accepted
pin-topic bindings are explicit; arbitrary global spaces, names, browse-campus
selection, institutions and related topology do not create slots. Exact original
space/region only is supported. Source related-campus distribution and aggregate
selection remain open rather than being guessed from institution membership.

Authority is a dedicated fixed-region/global grant facade. School moderation of
some global content through generic Community canManage does not authorize any
global pin. Current developer/super_admin global grants are the established Next
extension beyond the legacy super-admin wording. School grants only apply to the
pin's canonical region. No role or accepted source is seeded or issued here.

A different live post occupies the slot until explicit unpin, expiry or deletion.
A hidden or Review-withdrawn post still reserves it but is never displayed. A new
command pinning the same post closes the old pin and creates a new UUID and new
unread identity. Replaying the same actor/request and exact materialized command
returns its immutable original receipt; it never extends or recreates a pin.

## Source/history and database boundaries

Scopes require independent accepted-empty historical coverage, a source reference
and current validity. A missing or unavailable import assertion is exposed as
unavailable, never an empty slot. Native pin identities carry native provenance;
only these identities can have known absent read markers. Nonempty or unreconciled
legacy pins/read history cannot be imported or silently treated as native unread.
No production binding issuer, renewal/reconciliation workflow or legacy importer
is included. An expired accepted mapping stays unavailable; this slice does not
silently extend its validity or replace its original provenance.

Pins, read markers, closures, commands and accepted mappings are immutable.
Closures/read rows bind an exact same-transaction command. A head points at the
new atomic pin; raw cross-pin markers, stale lineage and historical command reuse
are rejected. Deletion closes pin rows without taking a slot lock. Ordinary
commands serialize request → shared Safety gate → slot → post, avoiding a
post → slot deletion cycle and acquiring Safety before content locks.

Current canonical session, scope, Review, Safety, named blocks and selected grant
are checked. Pre-read Community/Campus/Safety owner epochs and selected authority
facts are retained, then intended post-write pin state is captured separately.
Required nonblocking proofs run after all deferred constraints; PostgreSQL checks
exact scope/grant/pin deadlines last. No expiry correctness depends on a worker.
Conservative bounded final fences may return unavailable under unrelated writers;
this is not a production throughput acceptance claim.

Exact-pin unpin uses the original immutable scope and current true authority. It
can close a hidden or Review-withdrawn pin without returning content or restoring
pin/read permission. A feed management entry exposes only the current exact pin
and post identities, expiry, level and closure capability to a currently authorized
scope manager. It can release a hidden occupied slot using the same unpin command
and journal, without a hidden detail page, title, body, author, read state or new-pin
capability. This is explicit Next management hardening, not a claim of legacy
hidden-content listing parity. Old pin IDs cannot close a renewal. Read commands require
the currently visible exact active pin; the first actor × pin read time never
changes. Guest projection has a distinct guest state and never creates a marker.
Pin read is not a comment pin, exposure event or announcement acknowledgement.

## HTTP and native behavior

- GET `/v1/community/post-pins?spaceId=...&category=...&tradingSubtype=...`
- GET `/v1/community/post-pin-slot?spaceId=...` (authority-only minimal closure)
- GET `/v1/community/posts/:postId/pin`
- POST `/v1/community/post-pin-commands`
- GET `/v1/me/community/post-pin-requests/:requestId`
- POST `/v1/me/community/post-pin-requests/:requestId/cancel`

Commands are strict discriminated bodies. Pin contains clientRequestId, operation,
postId, durationHours and level. Read/unpin instead contain the exact pinId.
Cancellation sends the complete unchanged original command. Committed terminal
outcomes use HTTP 200 with an immutable applied/rejected receipt, including the
`POST_PIN_CONFLICT` rejection; this is the Next receipt protocol rather than the
legacy controller's HTTP 409 conflict response. Current authorization/visibility
failures still use the corresponding error status and do not mint a receipt.
Receipts contain only original request, operation, post and pin/time or bounded
rejection code; historical recovery does not restore current access and remains
available after content loss.

The independent projection preserves existing PostView/feed response and cursor
bytes. The native feed requests the selected region/topic/category/trade filter's
pin on first-page load/refresh and displays at most one separately. An ordinary
card is suppressed only after the exact visible pin card render commits. Failed,
unavailable, locally dismissed, expired or hidden projections do not remove
ordinary content. Thus local dismissal restores the ordinary card if the existing
feed returned it, an explicit Next difference from the source backend's removal
of pinned rows. No pin modifies chronological pagination or hot-feed exposure.

Native detail offers 1/6/12/24-hour presets plus bounded hours/level selection.
After a current detail native render commits, an explicit exact-pin command
marks it read. Read pins collapse in the feed, can expand, and can be dismissed
only on this device. Unread dismissal requires its own confirmation and never
acknowledges. Local dismissal is account-or-guest × origin × pin; renewals get a
new identity. The current Next feedback list also uses this separate projection as an
explicit additive UX choice. The legacy feedback list did not consume its pinned
response, so this does not claim legacy feedback-list native rendering parity.

Every native mutation is journaled before dispatch. A lost response keeps the
original key through restart, receipt-first recovery, same-key retry, or durable
cancellation. Receipt absence alone is not permission to discard an operation.
Pending restoration is independent of post visibility, so hidden/deleted content
does not block recovery. Invalid storage/receipts block sending/clearing. Hide,
unload, root hide, account replacement and origin separation invalidate private
UI and delayed callbacks. None of this enables a real account, provider or grant.

## Verification scope

Focused source tests cover strict input/hash behavior, immutable renewal/read
identity, real concurrent slot winners, global-vs-regional authority, hidden and
Review-withdrawn reservation/closure, deletion, cancellation, raw causal guards,
selected-owner deferred-source changes and final PostgreSQL expiry waits.
Native tests use the actual emitted App/Page/WXML and HTTP gateways through an
ordinary AppModule and disposable PostgreSQL. Only catalog/identity/Review facts
and WeChat platform callbacks are synthetic. They cover read/collapse, local
unread dismissal, authority-only hidden-slot closure with lost-response recovery,
cold recovery, storage failure, same-key retry/cancel, late
responses, hide/show and account replacement. See the final acceptance record for
executed commands and results; source existence is not a test-pass claim.

## Executed local acceptance, 2026-10-12

On the detached `422582673c22dc018f1a09729ea4c7c292e179cf` baseline,
Node 24.19.0 and disposable PostgreSQL 18.6:

- `taskset -c 0,1 npm run check` passed lint, API/native types, stats/search
  checks, all OpenAPI artifact checks, 1,886 API unit tests, 2,713 native unit
  tests and API/native builds including emitted smoke.
- The final serial PostgreSQL batch passed 128/128 tests, zero skips, with normal
  shutdown. It ran `scoped-post-pins`, `scoped-post-pin-proofs`,
  `scoped-post-pins-native-roundtrip`, `community`, `community-runtime-policy`,
  `community-feedback`, `discussion`, `trading`, `view-component-http`,
  `announcement-read`, and `messaging-text` integration files.
- The pin journey includes the actual feed management WXML closing a hidden slot,
  a lost successful unpin response, page re-entry and recovery of the original
  receipt. It also verifies that the separate card only suppresses an ordinary
  row after rendering, and that local dismissal restores that ordinary row.
- All 115 existing SQL migrations are byte-identical to the baseline. No Media
  owner implementation, existing cursor codec or announcement marker is changed.

The PG command uses `NODE_ENV=test`, `WHALEU_TEST_MAINTENANCE=controlled`, the
repository's `run-controlled-test-postgres.sh`, and
`timeout 600 node --import tsx --test --test-concurrency=1` inside that wrapper.
Each integration file installs its own synthetic facts and removes its application
schemas. The cluster disables autovacuum through the existing controlled-test
admission protocol. Deadline tests use explicit short-lived synthetic facts and
real PostgreSQL waits, not a claim of 168-hour wall-clock or production throughput
acceptance.

An earlier unconstrained full check had one Media descriptor child terminate by
SIGKILL; the bounded full rerun passed without changing Media code. Earlier
focused failures exposed a duration SQL cast mismatch, native recovery lifecycle
races and self-contention between concurrent projection/management proofs; these
were corrected before the final batch. The native reads are now sequential while
both server proofs remain mandatory.

The explicit simulated-E2E runner retains every prior entry and adds the three
pin suites. This slice ran those suites plus the shared batch above; it did not
rerun the entire remaining simulated-E2E runner or every PostgreSQL integration
file. PM3's independent source, later W3 work, hosted CI, physical devices and real
providers require their own composed-source acceptance.
