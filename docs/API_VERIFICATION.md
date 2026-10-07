# Verification V1: local canonical read-through

Status: implemented local ledger and read-only native summary, not live student or
phone verification. No production records have been imported or attested. An
unmapped real account remains `unavailable`. Full application, private evidence,
review, notification, phone-provider and institutional-provider flows remain later
work; this slice does not satisfy full verification feature parity.

The current product decision is to preserve existing source facts as-is. Legacy
number fields can be empty or contain email, and these cases do not invalidate an
existing school affiliation. Number backfill and potential future institutional
SSO integrations are explicitly deferred. There is no new number requirement,
provider activation, attestation endpoint or role grant in this implementation.

## Own-account contract

`GET /v1/me/verification` authenticates the current session. There is no account-ID
path or request-body selector. It returns `Cache-Control: no-store` and
`Vary: Authorization`:

```json
{
  "affiliation": { "status": "verified" },
  "studentNumber": { "status": "unavailable" },
  "phone": { "status": "unavailable" },
  "application": { "status": "none" }
}
```

The three independent fact statuses are `verified`, `unverified`, `unavailable`,
`expired`, and `revoked`. Application status is `none`, `pending`, `rejected`, or
`unavailable`; `none` means an authoritative absence of a current pending
application, not absence of historical applications. Unknown or conflicting
application coverage always displays `unavailable`. V1 can read these states from
a reconciled canonical snapshot; it does not accept submissions or decisions.

This response contains no number value, phone value, account or institution ID,
legal name, email, evidence, reason, provenance, provider payload or storage
locator. Missing/blocked/revoked sessions use the existing authentication errors.
A storage dependency failure produces a safe error, not a fabricated verification
state. Native clients must clear stale state across session/account epochs and
must not persist this summary as verification authority.

## Module and source boundary

`VerificationModule` owns all `whaleu_verification` SQL. Its exported
`LocalStudentIdentitySource` is the narrow transaction-aware facade consumed by
`identity-privacy`; consumers never query its tables. Authentication, role checks,
content-owner resolution, content visibility and successful disclosure auditing
remain in the existing identity-privacy workflow.

Only the existing developer-authorized content identity endpoint can return the
exact private student-number text. Its output shape is unchanged:

- `verified` carries one bounded provenance-qualified number, preserving leading
  zeroes, letters and spelling
- Explicit covered absence, revocation or expiry maps to `unverified` and null
- Unknown provenance/expiry, missing coverage, source-account/issuer mismatches,
  conflicting candidates, unsafe values and unreconciled accounts map to
  `unavailable` and null

Email-shaped values and document/email affiliation proofs cannot establish a
student number. A verified affiliation with missing or unverified number remains
a verified affiliation. A deliberate conflict between two otherwise-current
academic issuers remains unavailable for reconciliation; the reader never selects
the newest candidate to hide conflict. Public UID, profile edits, chosen campus,
school business identifiers, administrator roles and a generic historic student
flag are never student-number proof. Phone ownership is independent of both
academic facts. No new private fields extend community, anonymous persona,
profile, audit-value, notification or error DTOs.

## Canonical records and history

Additive migration `0007_verification_ledger.sql` creates empty tables only:

- `assertions`: independent affiliation, student-number and phone fact envelopes;
  coverage and provenance states, account/source-account binding, issuer/source-
  issuer binding, method/policy reference, verified time and explicit expiry
  semantics. Phone records reserve only an opaque protected-binding reference;
  real protected phone storage and provider completion are not implemented
- `snapshots`: immutable account/revision snapshots pointing separately to each
  assertion and a coverage-qualified application state. Composite foreign keys
  prevent selecting another account's assertions
- `account_heads`: one mutable, versioned current-snapshot pointer per account;
  initialized empty, it advances exactly one revision with a durable event
- `events`: immutable account/operation receipt and transition audit, containing
  no number/phone value. Snapshots, assertions and events reject updates/deletes;
  replacement and revocation append records rather than rewrite history
- `import_batches` and `raw_records`: restricted, append-only generic staging
  envelopes with schema/batch/record digests and exact source bytes. They are
  never consulted by the authority reader

Expiry has three explicit representations: an actual date, unknown, or a
policy-backed exemption. There is no invented forever-valid default and no
scheduled job is necessary to observe expiry. A reviewed legacy method that
really had no expiry rule can retain that established non-expiring policy through
an explicit provenance/policy reference; the migration must not impose a new
expiry merely because the target supports dates. Missing dates or authority are
reconciliation questions, not evidence the person is no longer affiliated.

No production importer is implemented. Complete MySQL schema-only export,
source-field/provenance review, authority mapping, reconciliation and separately
authorized data operations are still required. The generic dry-run report type
has only IDs, counts and issue codes, never identity values; no schema or field
mapping has been guessed. Source emails, both historic number candidates,
conflicting schools, original phone spelling, unknown timestamps and historical
application/review states must be preserved independently in private staging.

## Locking, expiry and revocation

All canonical writers must lock the account head `FOR UPDATE` before reading its
snapshot or inserting a transition. Readers take the same head `FOR SHARE`, then
load immutable pointers and read `clock_timestamp()` in a separate statement after
all lock waits. They do not evaluate expiry with a timestamp captured before a
row-lock wait. An absent head is unavailable; no read creates a row or seeds data.

Existing session/account locks, role/scope locks and content visibility locks are
acquired before the verification head. Writers must preserve this order when
future authorized workflows are added. Never call a provider while holding these
locks. No multiauthority write workflow is introduced in V1.

A read that acquires the head first holds it through successful audit and commit;
a revocation waits. A revocation that obtains the head first publishes its new
snapshot before a blocked reader can resume. The next authorized read sees its
revoked state. Head revision and event constraints prevent silent rewinds or
changes without a durable receipt.

A developer batch reads each profile and canonical source only once, retaining
its transaction-locked snapshot and explicit validity bound. After all target
waits, one common database clock projects any newly expired number as absent
before selecting audit fields. The actual presented access token/absolute
session deadline and the held developer grant deadline are retained through
narrow internal facades. Bound metadata never extends HTTP identity, summary or
capability DTOs; verified adapters missing a finite bound or explicit
policy-backed non-expiring state fail closed.

After audit insertion and deferred-constraint flushing, the service reads one
final database clock and makes only pure session/grant/number deadline checks.
No profile, missing head, source, permission or other row is reopened after this
clock; the only subsequent database operation is COMMIT. This prevents late-created
rows or audit/constraint waits from moving expiry behind the last decision. If a
deadline has passed, the entire transaction and provisional disclosure audit roll
back; no identity or misleading successful-read fields are returned.

The disclosure decision linearizes at that final clock and is returned only
after successful commit. Normal time passing during the final commit/network
delivery does not make an authorized snapshot a future authorization token.
Commit failure never returns the payload. Subsequent reads repeat all checks.

The internal `revokeAssertion(transaction, command)` primitive is deliberately
not a registered HTTP provider or exported authorization facade. A future workflow
must validate current scoped permission in that transaction before calling it.
It copies the specified assertion as revoked, appends a snapshot and event, and
advances the head atomically. The same account/operation and identical intent
returns its receipt; changed intent or stale revision conflicts. It does not
revoke other facts, modify roles, change a selected campus, or erase history.
Review/approval/application mutations are deferred pending real evidence,
reviewer-authority and policy prerequisites.

## Verification and release limits

Synthetic-only PostgreSQL fixtures exercise the real default source through the
actual developer API and own summary. Tests include leading-zero preservation,
affiliation-only state, unmapped coverage, unknown expiry/provenance,
account/issuer conflicts, unsafe/email candidates, independent phone state,
immutable history, cross-account rejection, expiry behind an unchanged head lock,
expiry of an earlier batch item, audit-write waits, late-created profile/head locks,
exact-once/stale revocation,
both revocation/read lock orders, event/audit rollback and public/summary privacy.
All integration suites include the new owned schema in refusal/cleanup guards.

Fixtures live only under `apps/api/test`; there is no seed, runtime bypass,
environment allowlist, provider call or bootstrap grant. Local synthetic success
is not evidence of live verification coverage. Actual source-data migration,
private-media transfer, provider activation, real reviewer grants and device QA
are separate approval/release gates.
