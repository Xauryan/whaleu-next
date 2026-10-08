# Activities: member read and successful-entry visit

This is a partial activity rewrite: member list/detail, accepted first-entry selection,
immutable visit receipts and the existing Profile activity-reminder preference.
There is no production issuer, importer, media fetcher, publishing/admin API,
notification sender, attendee/enrollment model or badge restoration.

## Routes and authority

Every route requires a current opaque bearer session. All success/error responses
are `Cache-Control: no-store` and `Vary: Authorization`. Inputs are strict: unknown
or repeated query keys, GET bodies, supplied owner IDs and client visit times fail.
The shared request-attempt owner enforces 120 activity requests/minute per
validated account across sessions and routes.

- `GET /v1/activities/context`: `{regionId, visitHistory}`. The region is the
  canonical current identity home, never the browsing-campus choice. Visit history
  is `never_visited`, `visited` or `unavailable`; it does not certify catalog times.
- `GET /v1/regions/:regionId/activities`: `window=entry|all` (default entry),
  `limit=1..50` (default 20), optional opaque cursor. Returns current
  `{context:{regionId,catalogRevision},selection,items,continuation,nextCursor,pageCursor}`.
- `GET /v1/regions/:regionId/activities/:activityId`: independently authorized
  current detail. No opener/list body, cache or previous list visit grants access.
- `PUT /v1/me/activity-visits/:requestId`: body
  `{regionId,expectedCatalogRevision}`. Returns exactly
  `{requestId,regionId,catalogRevision,visitedAt}`.

New reads and new visit commands compose the existing session, phone, account
restriction, student affiliation and identity-campus/topology owners under the
shared policy gate. Each source must be current, accepted and in scope. Ordinary
admin/developer roles provide no exception. Detail first establishes the actual
live home, then reports all foreign route IDs as `ACTIVITY_NOT_FOUND`.
Missing/inactive/unpublished activity IDs share that error; a missing accepted
catalog remains `ACTIVITY_UNAVAILABLE`, not a fabricated empty catalog.

There is no named publisher, manager or participant projection. The organizer
label is reviewed content, not a current membership or publish-role assertion.
The activity-specific Safety facade checks canonical account restrictions; no
unproven manager-wide block rule or named-person join is introduced. Future named
projections require their own Safety owner review and final relationship proof.

## Exact content and unavailable facts

Summaries contain stable activity UUID and content revision UUID, title, organizer
label, reward and online state, source-created time, cover and organizer-avatar
slots. Detail adds the exact multiline plain text, independent free-text activity
time/location, gallery and organizer QR. Text is never interpreted as HTML.

Reward, online/offline and created time are explicitly known or unavailable.
Unknown times are never assigned now/epoch; timestamp strings retain PostgreSQL
microsecond precision. Free-text time/location are not interpreted as a schedule,
GPS position, route or calendar action. Unknown cover/avatar/QR are `unavailable`;
proven absence is `absent`. Gallery is either `known_empty` with `[]`, or
`unavailable` with null. No available-media claim, raw URL/key or media operation
exists in this slice. Private source fields remain unprojected.

## Selection and opaque navigation

Accepted visited global history selects all active accepted activities. Accepted
never-visited history selects activities created strictly after one DB-clock
anchor minus 72 hours, if any exist. Otherwise it selects the latest ten historical
activities and explicitly labels that bounded recommendation. A complete empty
catalog with accepted history is legitimately empty. Missing/conflicting history
or unknown creation times make entry selection unavailable; explicit `window=all`
remains independently usable. A failure never falls back to a smaller list.

The 72-hour UTC rule is a deliberate new-target rule; legacy timezone/DST is not
asserted. Active items are not filtered by end date, and there is no past tab.

Accepted display ordinals encode source-created descending order, with original
numeric source activity ID descending as the deterministic equal-created-time
rule. UUID generation is not a sort key. Trusted population reconciliation must
preserve this mapping and its ordering evidence; unknown source instants require
accepted source order rather than fabricated times. Synthetic acceptance fixtures
use explicit decimal ordinals as their original numeric source-ID tie coordinates.
Ordinals stay exact decimal strings, including values above JavaScript's safe
integer range. SQL pages descending by ordinal and limit+1. All mode has no hidden
population cap; the explicit historical recommendation has a ten-item budget.

The shared bounded opaque cursor owner stores only navigation coordinates:
selection, recent boundary, remaining historical budget and last ordinal. Scope
binds account/session, identity selection, topology, region, current catalog/order,
requested window and page size. Mutable visit history is deliberately excluded.
`pageCursor` replays the current page, including the first page; `nextCursor` moves
forward. Each replay reauthorizes and queries current accepted content, so Previous
after a successful visit keeps the original recent/historical selection without
caching bodies. Identical coordinates may reuse the same token. Changed authority,
catalog/order, expired or mismatched tokens require `DISCOVERY_RESTART_REQUIRED`.

## Visit receipts and reminder preference

GET and detail never record visits. Native list sends the explicit visit only
after strict decoding and the active page's successful render-completion callback.
Denied, unavailable, malformed, canceled or hidden loads cannot initiate it.
An authorized complete empty selection can record entry. This receipt records
entry into the activity center; it is not per-item read proof or an unread ledger.

A new request revalidates current member authority and exact current catalog.
Owner advisory serialization plus append-only receipts make duplicate concurrent
requests replay-safe. A matching existing owner receipt is historical metadata:
a currently valid owner session may replay its original minimal receipt even after
catalog, phone or campus changes. Replay never rereads old content or represents
new access permission. A reused request UUID with different region/catalog fails
`ACTIVITY_VISIT_CONFLICT`. A new request with an old catalog fails
`ACTIVITY_REVISION_CHANGED`. New receipt times use the database clock and advance
monotonically relative to earlier local receipts. Imported source timestamps are
preserved separately and are never replaced with an invented timestamp.

Visit history is global per account, matching the source meaning. Region/catalog
in receipts are audit context, not separate region unread markers. Missing owner
coverage is unavailable; startup does not mark existing users as new. Accepted
source coverage is immutable and separately headed; successful local receipt
history is append-only. No mutable receipt is used as a shortcut.

Activity reminder UI reuses `GET /v1/me/profile` and
`PATCH /v1/me/preferences` with `expectedRevision` and `activitySubscribed`.
Revision conflict reloads the current preference for review. No duplicate
subscription table, per-activity subscription, WeChat permission request or
notification delivery promise is introduced. Existing disabled activity badges
remain disabled.

## Canonical storage and transaction finalization

Migration 0036 creates only empty storage. Identity/source mapping, exact content
revision and catalog publication are separate. A catalog seal proves complete
expected child count, unique ordinal, accepted sealed content, exact approved
revision and same-region binding. Unknown/pending/rejected/conflicting approval
cannot be exposed. Accepted revisions/children and owner receipts are immutable.
Authority-writing SQL triggers acquire the common exclusive policy gate before
row locks. Only accepted head replacement changes publication; there is no public
issuance endpoint or activity cast into post/comment/reply review envelopes.

Managed transactions use explicit READ COMMITTED. Head pointer `FOR SHARE` is read
first; its referenced revision is fetched in a fresh statement after any wait.
Every ordinary owner lock and session recheck precedes cursor quota acquisition.
No later domain lock is acquired. Final transaction deadlines run after deferred
constraints and cursor waits, so expiry aborts both private response and writes.

## Verification and remaining scope

Focused tests cover normal AppModule HTTP with canonical synthetic owner facts,
real PostgreSQL waits/rollback, native strict gateway/controller roundtrips,
source unknown/empty separation, immutable seals/receipts, exact microsecond
boundary, large-ordinal ties, >50-row all traversal, frozen Previous, concurrent
replay/conflicts, and preference reuse. Compiled page smoke is not a device test.
The generated [OpenAPI document](openapi/activities.json) comes from official
controller/schema metadata without a server, database or provider call.

Still open: managed organizer/current role authority; real creation/review and
media ownership/upload/QR disclosure; external article behavior; own lifecycle
history and edit/cancel/delete; scoped administration; dormant newness/counts;
notification delivery; any claimed per-activity subscription/enrollment; actual
schema/data reconciliation, trusted issuer/import/cutover; physical devices and
other platforms. No real source population, provider delivery or production
operation is certified by these tests.
