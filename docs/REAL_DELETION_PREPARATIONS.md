# Real account deletion preparations: immutable0181 foundation

This document records the0181 foundation. The current binary additionally includes
[0182 request coordination](REAL_DELETION_REQUEST_ENTRY.md), requires the full
chain through0182, and keeps production acceptance and erasure unavailable.
Statements below about0180 remaining write-closed describe the0181-only stage.

This is not completed account deletion. Real prepare/status are connected to the
production AppModule and PostgreSQL, disabled by default. Acceptance/cancel routes
are explicitly unavailable, do not dispatch provider codes and cannot change
account lifecycle/session epochs.0180 remains write-closed. No synthetic request,
fixture enrollment, permissive Boolean or environment activation is substituted.

## Configuration and privacy

`REAL_ACCOUNT_DELETION_ENTRY=disabled` is the unchanged default. `prepare_only`
requires the existing configured WeChat app, provider secret and auth rate-limit
key. Existing login/refresh/logout semantics do not depend on this entry being
enabled. This document supplies no real credential and authorizes no production
configuration or grant operation.

POST `/v1/account-deletion/prepare` uses a current ordinary bearer and a strict
versioned intent. The client creates a distinct32-byte CSPRNG recovery secret,
canonical unpadded base64url with `wu_dr_` prefix, before sending. Only its
purpose/account/intent/base-and-next-generation-bound hash is stored. Session IDs,
account FKs and fixed app scope are private preparation metadata, never response
fields. No raw secret, provider code, OpenID/UnionID or session_key is retained.
New secret names and request bodies are redacted. Status is POST with the secret
in its body, never a URL. It reads only one exact preparation, never an account
history/list and never creates ordinary access/refresh credentials.

Same intent/secret replays exactly with no expiry extension. Same intent with a
new secret/generation conflicts; cross-account or invalid capabilities share the
same unavailable response. Preparation does not reserve generation or change
lifecycle/epoch. At most4 live preparations per account; cleanup removes at most4
expired rows for that same account per new prepare. Risk limiting uses the
existing HMAC-protected global300/minute and per-address20/minute operation
buckets with existing bounded stale-bucket cleanup. No raw IP enters new tables.

Preparation acceptance eligibility is15 minutes, a new internal protocol-v1
lifetime. Planned reauth attempts30 seconds are separately versioned and not a
provider-issued expiry claim. Both need database-time boundary tests; no JavaScript
Date decides authorization. Existing source/legacy policy has7-day cooling and
completed_at+30-day registration blocking. This slice enables neither clock.

## Least-privilege preparation runtime contract

No migration creates roles or grants persistent access. A deployment operator
must separately evaluate role changes. The controlled local PG test uses a
NOLOGIN/NOSUPERUSER/NOCREATEROLE/NOINHERIT fixture role, exact grants, then revokes
those exact grants and drops only that fixture role. No real production role is
modified. The API need not use that exact role; existing ordinary API roles are
not rejected just because they possess historical privileges.

Required existing Identity access for this entry:

- USAGE on whaleu_identity and whaleu_real_deletion.
- Existing0172 limiter trigger dependency: USAGE on whaleu_account_deletion and
  SELECT(account_id) on its fixture_accounts table, not all deletion tables. The
  rate_buckets BEFORE trigger invokes writer_fence(), whose initial query joins
  accounts.id to fixture_accounts.account_id. Accounts SELECT already exists.
  Rate bucket fields are64-character hex, a timestamp and an integer, not account
  UUID payloads; no owner_cause/request branch is reached by valid limiter rows.
  PostgreSQL invokes the already-installed trigger without a separate runtime
  EXECUTE grant on its trigger function. This is a pre-existing limiter dependency,
  not new0181 deletion authority or synthetic enrollment. No SECURITY DEFINER,
  fixture-table write, broad schema read or MAINTAIN grant is added.
- SELECT on accounts, sessions, access_tokens, provider_identities and rate_buckets
  in whaleu_identity, plus whaleu_real_deletion.preparations.
- Named UPDATE(id) on accounts and sessions, UPDATE(token_hash) on access_tokens,
  solely to retain PostgreSQL row-lock authority. No broad table UPDATE/MAINTAIN.
- Existing limiter INSERT/DELETE and named UPDATE(hits) on rate_buckets.
- INSERT/DELETE on preparations; its trigger only permits bounded authenticated
  creation and expired preparation deletion. UPDATE and TRUNCATE are unavailable.
- EXECUTE on whaleu_real_deletion.preparation_catalog(). Runtime reads the closed
  protocol literal from pg_catalog; it does not need to execute the marker or
  trigger functions. Normal read access to PostgreSQL system catalogs/builtins is
  also required, as with existing identity schema qualification.

These are permission requirements, not executable production GRANT instructions.
The role fixture exercises actual controller+limiter+service SQL in separately
managed transactions and tests each omitted permission. Owner-only passing is
not accepted as deployment evidence. The integration suite also boots the actual
AppModule with a real PostgreSQL DatabaseService, limiter and deletion service,
without DI substitutions, and exercises HTTP middleware/validation/serialization
and current bearer authorization. External provider transport is a failing test
tripwire, not a fictional provider implementation.

## Exact schema and transaction proof

Migration0181 requires the recorded0180 predecessor and an absent real namespace.
The finite catalog includes only the preparation relation and its constraints,
columns, triggers, own indexes and actual referenced unique index OIDs. FK
`conindid` points at accounts' index, not the preparation table: it is included
with bounded deduplication, pre-deparse expression/options size checks and a real
index-drift test. Unknown real-namespace relation/function presence changes the
seal. Functions and the marker literal are qualified before invocation.

The catalog has128-fact,32KiB-item,256KiB-total bounds, with bounded raw sources
before aggregation. The official shared migration lock remains held throughout
the managed transaction; exact schema and preparation facts are rechecked after
deferred constraints within the existing100ms/500ms proof budgets. Preparation
and status do not require MAINTAIN or table-lock privileges. SQL compares actual
clock_timestamp against expiry; expires_at::text is also registered as an exact
transaction deadline and compared in SQL at the final instant AFTER all owner
proofs and settings restoration. Presentation Dates cannot authorize anything.
Prepare discovers a target then takes account FOR UPDATE before ordinary
Identity account/session/token proofs, avoiding SHARE-to-UPDATE upgrade. Status
authenticates the private hash before taking its account SHARE lock. No authority
or locks survive a failed managed transaction.

## Non-activated acceptance and required next successor

The pure transition helpers are unit-testable decisions, not durable authority.
No HTTP handler accepts their Boolean inputs or treats test facts as proof. An
actual acceptance successor must land all of:

- Exact real request/account/next generation/creator-TX accepted cause and receipt,
  immutable authority discriminator preserving0172 synthetic semantics, and the
  only allowed0180 epoch+1 branch with updated exact runtime signature.
- A dedicated acceptance before/after proof covering every normal current
  Identity condition and final catalog proof. Ordinary active liveProof is not
  weakened or reused across intentional revocation.
- Real fresh-provider-only cooling discovery and purpose-only recovery rotation.
  A lost secret must not strand a supposedly supported account. Replacement
  secrets are client-held before dispatch; exact rotation receipt recovery occurs
  before re-exchange. No automatic registration/session mint or epoch reduction.
- A verifiable maintenance cutover retiring old readers/credentials, not a
  persisted flag, application_name, process count or promise of secure storage.
- Real per-account runnable owner erasure/retention plans and writer fencing,
  including Home0177/0178 copies, epochs, opaque attribution and all new tables.
  UserA completion must preserve unrelated userB history. Global-empty databases
  are bootstrap tests, not an ordinary usable cohort.

IMPORTANT:0181's expired-preparation DELETE rule applies only while no accepted
request exists. A successor reusing these rows MUST change this rule together
with acceptance to preserve accepted recovery/receipts through cooling and the
terminal retention policy. The15-minute preparation TTL must never clear an
accepted7-day cancellation capability. Schema qualification must change exactly;
there is no runtime fallback accepting the old seal.

Completion requires exact terminal owner evidence and private provider digest
capture bound before mapping removal, then completed_at and all registration
ban rows atomically. Neither preparing nor accepting starts the30-day ban.

## Historical0181 replay onto the0180 integration

This preparation-only replay is based on tree
`62546a2f94ca41033b30d3beb87cfe9a95538586`, not the original da278 stack.
That0181 binary requires the complete shipped chain through 0181, even when
prepare/status are disabled. It retains the current readiness owner, epoch
runtime, source/manual-review integration, Home behavior and current CI inventory.
Original v3 tests are historical evidence only. No new-stack type, unit, PG,
CLI, OpenAPI or deployment pass is established by copying these source files.

The four route declarations preserve original0181 protocol compatibility: prepare
and status are the only implemented operations; accept and cancel are closed
stubs with no success response, provider dispatch, request acceptance, epoch
advance or cancellation authority. No0182 or0185 migration is included.
