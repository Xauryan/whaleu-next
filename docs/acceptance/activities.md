# Local activities first-slice acceptance

Verified 2026-10-08 against base `2ae0113fae5913280b86aae70668c011fc0575dd`
plus this increment. Activity parity remains **PARTIAL**. This local
acceptance covers member list/detail, source-backed entry selection, a
successful-entry visit receipt and the existing Profile activity-reminder
preference UI. Hosted publication and deployment are separate.

## Frozen final gates

All 977 tracked/untracked non-Markdown source, test, config and asset files
outside docs retained fingerprint
`5db18bb58cc32fcf8609c20611f7e3e355a9c8a91eb0687bd68cdff62a2bc1bb`.
All six generated OpenAPI artifacts retained
`6f5c3db23725d08bbe4317c137c784c621a1cb945f862860877e82788d2c9695`.
[Machine-readable evidence](activities.json) contains sorted repository-relative
per-file manifests, exact gate timings, test totals and log SHA-256 digests.
Documentation is outside the source freeze.

- Complete `npm run check`: exit 0, including lint, strict types, statistics,
  all six OpenAPI drift checks, unit tests, builds and emitted native smokes
- Complete `npm run format:check`: exit 0
- Unit totals: 5 statistics + 693 API + 930 native = 1,628 passed
- Complete serialized `npm run test:integration`: 1,199 passed in
  873.767087865 seconds
- Combined: 2,827 passed; zero failures, skips, cancellations or pending tests
- PostgreSQL 18.6 (`180006`), isolated disposable cluster, launch-only
  `max_connections=100`; zero application schemas before and after
- Integration and runner exit 0; server stopped (`pg_ctl status` exit 3)
- Source/OpenAPI manifests and persistent PostgreSQL configuration unchanged;
  `git diff --check` passed

The server and tests ran in the same execution namespace under the cluster's
exclusive test-run lock, with `TEST_DATABASE_URL` exported from the runner's
local test connection. No implementation edit occurred after the freeze.
Focused passes are not counted again in these totals.

## Accepted partial behavior

Normal AppModule HTTP requests require the current opaque owner session, phone,
Safety restriction coverage, student affiliation and canonical identity-home
region/topology. Browsing-campus selection and administrator roles do not grant
activity access. Foreign, missing, inactive and unpublished detail IDs use a
generic not-found result after establishing actual member authority. Missing
accepted catalog/history and unknown source facts stay unavailable; complete
accepted empty remains a distinct legitimate result.

Migration 0036 creates empty canonical storage only. Accepted content and catalog
publication are immutable, sealed and revision-bound. Strict projections retain
original multiline text, free-text activity time/location, explicit knownness,
exact PostgreSQL microsecond timestamps and absent/unavailable media distinctions.
There is no raw source/media field, available-image or participant projection.

Accepted global visited history selects all. Accepted never-visited history
selects activities strictly newer than one frozen database-clock boundary minus
72 hours, or an explicitly labeled latest-ten historical recommendation. This
UTC rule is a deliberate target rule, not proof of legacy timezone/DST. Explicit
all is independently available and traverses more than 50 records without a
hidden population cap. Exact decimal ordinals preserve accepted created-time
and original numeric source-ID tie ordering. Opaque `pageCursor` and `nextCursor`
freeze navigation selection, including Previous to page one after a visit, while
every page and detail reloads currently authorized accepted content.

GET and detail never write visits. Native list acknowledgment starts only after
strict decoding and the active page's successful render callback; an authorized
complete empty view can count as entry. Immutable owner receipts support exact
same-intent replay, concurrent deduplication, stale-revision/conflicting-intent
rejection and response-loss recovery. A historical minimal receipt grants no
fresh content permission and does not establish per-item read/unread proof.

The native preference uses existing Profile `activitySubscribed` and
`expectedRevision`, with conflict reload and failure/uncertainty handling. No
parallel subscription table, enrollment model, provider permission request or
notification-delivery promise was introduced. Activity badges remain disabled.

## Executed acceptance and pre-freeze corrections

The corrected focused PostgreSQL aggregate passed 48/48. Actual gateway/controller
roundtrips cross ordinary Nest HTTP and PostgreSQL. Real waits cover current
catalog head replacement, cursor quota, owner serialization and deferred
constraints; final deadlines reject stale content, cursor writes and failed visit
receipts. Direct mutation of sealed publication/history is rejected. Microsecond
72-hour boundary, large-ordinal ties, complete-empty versus unknown, uncapped all
traversal, concurrent replay/conflict and Profile preference reuse are tested.

Eight focused API and sixteen native activity tests were included in the final
aggregates. Emitted real page/template smoke additionally covers direct detail,
fresh Back/Previous, unavailable media, successful render-only acknowledgment,
repeat navigation, hidden/root-background and stale callbacks, Safety/campus
scope invalidation, same-account relogin, account switching and exact recovery.
This synthetic native evidence does not establish physical-device acceptance.

Earlier focused tests were not all green on first attempt. The initial read run
passed 5/7 because an assertion and its enclosing test expected
`IDENTITY_CAMPUS_REQUIRED` where the canonical owner correctly returned
`IDENTITY_CAMPUS_UNAVAILABLE`. A later authority-focused run passed 38/40 because
its expected new-home context omitted `visitHistory: unavailable`. Both strict
expectations were corrected before the successful 48/48 run; fail-closed behavior
and strict context equality were retained.

Pre-freeze review also corrected page-one replay after visit, WXML facts binding
and generic foreign-detail not-found behavior, and added actual head-replacement
and exact microsecond/tie-order tests. The complete frozen aggregate then passed
on its first attempt; no tests or source were weakened or edited during that gate.

## Remaining parity and release boundary

Still open: managed organizer/current role authority; creation and canonical
activity review; media ownership/upload/QR and external articles; own lifecycle
history and edit/cancel/delete; scoped administration; dormant newness/counts;
notification/provider delivery; any claimed per-activity subscription/enrollment;
actual schema/data reconciliation and preservation, trusted issuer/import,
accepted source population, cutover/restore; physical devices and other platforms.

No source data population, real historical import, provider delivery, production
access or operation is certified here. No commit, push, hosted activity CI or
production deployment was performed by this local gate. The complete activities
feature is not finished. See [API scope](../API_ACTIVITIES.md) and
[feature parity](../FEATURE_PARITY.md).
