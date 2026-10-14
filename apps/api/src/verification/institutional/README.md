# Bounded institutional verification

This owner implements the active institutional-verification software journey. It
uses a test-composed synthetic institution and native handoff for acceptance. The
shipping server provider and shipping native port are unavailable. No environment
switch activates fixture trust; no real institutional protocol, credential flow,
OAuth redirect, CAS ticket, password field, grades access, or production grant is
claimed.

## HTTP and recovery

The five authenticated routes are under `/v1/me/institutional-sso`: capability,
prepare, original-request read, complete (`authorize` or `recover`), and close.
All responses/errors are no-store and vary on Authorization. New work uses
`private_self_service`; current-owner status and close use restricted self-service.
Invalid or revoked sessions are never a restricted authentication bypass.

- The command hash binds actor, random original key, campus, accepted capability,
  consent and purpose. A permanent key/fence/receipt cannot become new authority.
- Per-account then per-key serialization plus active-state uniqueness prevents two
  devices from opening independent unresolved requests.
- A claim commits before the only provider call. Opaque response bytes are bounded
  and never become stored command identity. Authorization transport never retries.
- A trusted adapter returns a runtime-private one-use capability. A client object,
  `verified` field, TypeScript cast or test environment flag cannot mint that proof.
- Accepted proof is durably admitted before final local issuance. A process dying
  before admission is unknown; local recovery never exchanges the response again.
- Close can fence an absent key and wins while the verifier is outside the database.
  Completion that committed first remains historical success; close does not revoke.
- GET may observe expiry before a terminal receipt is stored. Native recovery calls
  original-key `complete/recover` to settle it before removing the journal. Missing
  or uncertain observations never unlock another key.

The bounded JSON parser is the existing HTTP parser: decoded strict objects have
one interpretation, including raw duplicate keys. There is no claim of duplicate
raw-key detection. The HTTP envelope is capped at 64 KiB and the opaque response at
4096 UTF-8 bytes. Wrong content types, unknown fields and raw claims are rejected.

## Existing owners and trust boundaries

Migration 0145 adds protected request/result/subject/completion provenance inside
Verification. It does not create a second fact ledger. Accepted first linking
requires a covered safe account, compatible affiliation and no unexplained prior
number/subject identity. Existing valid facts keep their exact pointers, methods,
private values and expiry. Revoked, expired, foreign-issuer, differing-number and
unknown histories are unavailable for self-service replacement. No renewal policy
is selected in this slice; expiry cannot authorize reverification.

Affiliation and number are independent. Phone and document-application state are
copied from the latest exact snapshot. A compound institutional event produces
zero, one or two assertions without a document decision. Subject ownership is
stable issuer namespace plus exact subject and is not released by cancellation or
expiry. Public replies contain only statuses, changed fact kinds and UID outcome;
private school numbers and provider subjects never appear in them.

Every head transition maintains trigger-owned monotone affiliation/number
continuity. The prepare-time witness is checked at claim, admission and finalization;
A→B→A cannot pass through pointer equality. Phone/application-only changes do not
advance it. Trigger presence, enablement and source-body identity are checked.

The original School Identity first-V0/full historical admission vector remains a
separate final-transaction proof. The protected completion selects exactly 2/3/4
one-row source statements: optional affiliation, optional number, snapshot, head.
Existing document/correction recipes remain exactly three. Deferred constraints,
nonblocking owner fences and final exact PostgreSQL text deadlines retain their
existing order. A failed local closure rolls back issuance while durable admission
remains recoverable.

SchoolUidLedger owns the distinct `institutional_sso` cause and result. It can issue,
retain, or defer only for the existing proven unknown-inventory/history reasons.
Later authorized `complete_uid` recognizes the accepted still-current SSO source.
There is no raw counter mutation, synthetic document approval or public role grant.

Exact current-predecessor revoke/expire descendants copy both SSO fact kinds without
new provider admission, completion or UID production. Old SSO bytes are not rewritten
or given invented provenance. Historical session UUIDs are audit values, not retention
foreign keys; Identity's terminal cleanup remains independent.

## Deadlines and native lifetime

Synthetic policy: request 300s, response use at most 60s capped by request, claim at
most 60s capped by request, provider call 5s without retry, fact lifetime 600s from
issuer authentication, finalization at most 120s from admission capped by request
and every relied-on fact expiry. Upper boundaries are exclusive. Current presented
access token and claimed session remain additional exact gates. Recovery extends no
original boundary.

The native journal is persisted and read back before prepare, before handoff and
before HTTP submission. A started/uncertain phase cannot repeat a handoff even if
the server remains prepared. Hide/unload/session/context changes invalidate late
callbacks. The journal contains safe command identity only. Application-held
response references are dropped; JavaScript/runtime copies do not provide a
verifiable byte-zeroization guarantee.

## Acceptance and activation

`institutional-sso*.test.ts` covers real HTTP/PostgreSQL and emitted native journeys,
causal forgery, continuity gaps, expiry, retention and existing UID compatibility.
Native focused tests and emitted WXML smoke separately exercise interruption phases,
non-replay, storage failure and current-summary refresh. The real 300s expiry case
uses a 360s test-only timeout without shortening production clocks or policy.

Real activation still requires an authoritative supported relying-party protocol,
issuer/subject/student eligibility/number policy, expiry/revocation/reconciliation
semantics, reviewed native handoff/return binding, permitted MFA/CAPTCHA/consent,
retention and operating authorization, and non-production provider/device evidence.
A synthetic pass does not supply any of these approvals or facts.
