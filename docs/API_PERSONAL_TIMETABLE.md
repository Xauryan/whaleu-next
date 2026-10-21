# Private manual timetable v1

This is private, manually entered account data. It does not import academic data,
accept academic credentials, issue grades, schedule notifications or expose a
share/public endpoint. OpenAPI: [personal-timetable.json](openapi/personal-timetable.json).

## Owner and revision

Each authenticated account owns up to 32 live terms, each containing at most 200
live entries. Every query includes the authenticated owner, never an owner supplied
by a client. Composite owner foreign keys prevent crossing account boundaries.
One account lock serializes reads, writes, quotas and request cancellation. All
entry mutations advance their term's aggregate revision exactly once. A stale CAS
rejects durably; clients must show the conflict, reload, and explicitly create a new
request if the user chooses to reapply. No silent rebasing or overwritten edits.

Terms have a real civil Monday in years 1900–2199, 1–30 weeks and Asia/Shanghai.
Moving Monday shifts the whole series. Shortening a term rejects any existing
entry week beyond the new limit, without trimming. Entry intervals are half-open,
within one civil day, 0 <= start < end <= 1440. Weeks are nonempty, strictly sorted,
unique and explicit. Color is blue, teal, green, orange, red or purple. Names are
required (120 UTF-16 units), teacher/location optional (100), notes optional (500).
Names/teacher/location must already be trimmed; no control/format characters.
Notes preserve LF/tab but reject CR and other control/format characters.

## Exact recovery

Secure lowercase UUIDv4 request, term and entry IDs are generated before sending.
The original full versioned command is frozen before transmission. The command
hash is SHA256 of UTF-8 JSON.stringify with this exact field order:
version, requestId, operation, termId, expectedRevision, entryId (entry operations
only), payload. Payload term order: name, weekOneMonday, weekCount, timeZone.
Payload entry order: name, teacher, location, note, dayOfWeek, startMinute,
endMinute, weeks, color. Delete payload is the strict empty object.

Receipts contain only version, requestId, intentHash, operation, termId, entryId,
expectedRevision, resultingRevision, outcome and code. No private schedule text
is stored in command history. Exact request replay returns the original immutable
receipt. Different intent using the same key returns TIMETABLE_REQUEST_CONFLICT.
A recovery response of unknown proves neither failure nor cancellation. Retain the
original request. Cancellation takes that full original command and matching path
key: an unapplied key is sealed cancelled forever; an already settled key returns
its original receipt, even if applied. It never undoes committed work. Receipt
identity and hash must match before native discards recovery state.

New commands and private reads use private_self_service. An interaction mute is
not a private-data suspension. Historical receipt recovery/cancellation remain
restricted_self_service, but require the current valid presented session. Account,
session and token locks, exact SQL expiry and final policy proof apply through
transaction completion, including owner-lock waits. A failed receipt write or
expired final proof rolls back both mutation and receipt. All responses are private,
no-store. Invalid transport responses and uncertain sends must remain recoverable.

Deleting a term scrubs every child entry and term payload. Tombstones reserve IDs
within the account; existing receipts contain only minimal metadata. Recovery does
not disclose private payloads after deletion or suspension. No production migration
or academic provider activation is implied by this implementation.

## Validation

Focused units: personal-timetable.test.ts and personal-timetable-openapi.test.ts.
Real PostgreSQL/HTTP integration: integration/personal-timetable.test.ts, assigned
to the identity-messaging CI module. Integration must run on the established
controlled disposable PostgreSQL workflow; source presence is not execution proof.

The three native pages are `personal-timetable`, `personal-timetable-term` and
`personal-timetable-entry`. Campus exposes the actual private timetable route
independently of the public campus catalogue. Its pages enforce authentication.
They use the native Framework7 component port, not a web view. The page-local
runtime does not import the heavy application implementation at runtime.

Native commands are durably journalled per account and API origin before sending.
Hide, unload, account replacement and safety invalidation scrub rendered private
data; they do not delete an unresolved original request. Recovery is explicit.
An in-flight cancellation remains cancellation after restart, never an automatic
command retry. The UI supports term/entry editing, copying a course, explicit weeks,
conflict warnings, date-shift confirmation and typed term deletion.

`apps/wechat/test/personal-timetable-emitted-harness.mjs` drives actual emitted
Page and component handlers. `integration/personal-timetable-native-roundtrip.test.ts`
connects that harness to the real loopback HTTP API and disposable PostgreSQL,
then checks receipts, deletion scrubbing and cross-owner denial. The transport
injects response loss only for recovery testing; it does not fabricate success.
Local execution on 2026-10-20 used controlled disposable PostgreSQL 18.6.
The API CRUD/invariant scenario passed, and the emitted native HTTP journey passed
all 11 segments with zero skipped tests. These executions used a timetable-only
V33C-derived API snapshot plus the verified current native output, deliberately
excluding the independently changing discussion-order migration. Production API
and native outputs stayed byte-identical across the diagnostic retries. Two test
bridge defects were corrected: a trailing directory separator rejected by the
existing containment assertion, and a call to a nonexistent bridge hide method
instead of its lifecycle API. The original failed logs are retained.

This proves the recorded local timetable scenarios, not the entire application's
PostgreSQL suite, a future combined migration snapshot, or Tencent device behavior.
The component/platform callbacks are modeled; no academic provider is involved.
