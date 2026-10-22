# Real request HTTP coordination:0182 source replay

Current replay base tree:61669dbb2e0adbb1e12ce4597b2e964be19515c4.
The full application floor is0182; truncated0181 artifacts must fail readiness.
The source below is recovered from qualified core-v3/HTTP-v6 with v7/v9 test-only
cleanup. Their old20/9/10 and natural15-minute6/6 results remain historical, not
a pass on this replay. Statements below marked written/unvalidated refer to
that preserved entry design; new exact-stack qualification is recorded separately.

The AppModule connects service/controller to the request coordinator. The default
RealRequestAdmission is explicitly unavailable; it is not owner coverage. No
production acceptance, fresh-provider lost-capability recovery or erasure is
claimed. A test-only local admission override is never imported in production.
The replay retains current readiness, isolation, microsecond/final-proof and
historical-source fences. Scoped units do not substitute for fresh PostgreSQL,
full types, full ordinary API units or a new natural-expiry observation.

## Execution and configuration

REAL_ACCOUNT_DELETION_NEW_REQUESTS defaults to disabled. qualified_owner only
requests execution: it additionally requires preparation entry and the externally
provisioned digest keyring, and still cannot pass the unavailable production
owner. No credential is created or installed by this code or documentation.

Acceptance first checks the exact private stored receipt before demanding a
bearer, current eligibility or another provider exchange. A genuinely new request
uses the original current bearer in a first managed transaction, creates an exact
30-second attempt, and requires admission preflight. If unavailable, that attempt
rolls back before any provider code is dispatched. The existing server WeChat
adapter exchanges outside the database transaction. The second transaction uses
provider -> account -> original session/token ordering, exact admission cause and
the dedicated epoch+1 session proof. Preparation, attempt, original token, absolute
session and admission deadlines remain PostgreSQL text through final DB instant.

Status and cancellation for existing requests do not check the new-acceptance
flag or require ordinary bearer credentials. Even disabling preparation entry
does not invalidate existing request recovery when the required limiter and
request schema/privileges remain configured. Prepared-only status still follows
the preparation entry switch. Default deployments without a limiter key fail
before DB access. Existing known request status needs request-owner rights;
prepare-only status discovers absence using only requests.id before its original
preparation path. No list or account identity is returned.

Cancellation delegates exact command/revision/hash receipt-first semantics and
SQL cooling deadline to the real authority. It never reduces the epoch or mints
access/refresh tokens. This does not solve loss of the client's recovery secret:
fresh provider recovery, exact grant rotation and lost-response replay remain
mandatory before any production admission owner may be enabled.

## Required central validation

The new fresh-PG HTTP fixture runs actual AppModule, DatabaseService, limiter,
IdentityRepository, service, coordinator and WeChat adapter. Only the transport is
local and the admission owner is an explicitly labelled test-only independently
qualified native-shape owner. The fixture first proves installed production
admission refuses configured new acceptance without provider consumption; then
exercises HTTP accept, old bearer/refresh rejection, receipt replay without
ordinary bearer, status/cancel with new entry disabled, and exact cancellation
replay. It is not production whole-owner coverage, a minimal-role HTTP deployment
qualification or completed account erasure. These tests require new execution on the exact replay.

The64-history WIP limit, bounded linked-evidence retention/compaction owner,
actual A erasure with B's existing history intact, opaque ownership admission,
per-owner writer fences and enforceable retired-reader cutover remain blocking
production prerequisites. No manual Boolean, signature or unknown SQL trigger
body is accepted as their proof.

## Exact private capability ordering

The v1 entry source exposed request existence through different status codes for
unknown versus known/wrong-secret targets. v2 authenticates a prepared capability
and its exact four-field intent before mode/bearer checks on an accept receipt
miss. Prepared status similarly authenticates its scope before the entry switch.
Unknown and incorrect-capability targets return the same404 scope failure in all
three supported mode combinations. A genuine preparation may then receive503 for
disabled execution or401 for a missing bearer. Existing accepted receipts stay
capability-only and are available before flags, ordinary bearer or provider use.
Schema qualification failures remain failures, never a missing-row fallback.

The actual AppModule test matrix compares status/code/message, not random HTTP
request IDs, across unknown, prepared wrong-secret, accepted wrong-secret and
legitimate capabilities. The matrix requires fresh centralized execution. The core v3 strict-intent
projection and both regression files are carried explicitly, with no inherited
validation result. v1 remains preserved as the known-defect review input.

## Preparation-only role and final immutable capability proof

The entry authenticates the immutable preparation capability with the existing
preparation schema/function/table privileges before request discovery. This first
proof retains the account lock and exact immutable intent/recovery hashes through
the same managed transaction; it intentionally does not reject an accepted
request merely because its preparation TTL expired. Only a missing request uses
the current preparation/precise expiry proof. A known accepted request uses the
separate full request catalog/receipt proof after capability authentication.

The existing preparation-only role is not silently granted request_catalog() or
admission namespace access. Its genuine prepared HTTP status remains supported.
Unknown and wrong capabilities fail404 before any request-owner privilege is
needed. A genuine accepted capability on a deliberately preparation-only runtime
role fails503 for missing request-owner deployment privileges, not a fabricated
success or hidden missing-row response. Production acceptance must never be
activated with that preparation-only role. The actual AppModule fixture uses a
fresh isolated NOLOGIN role via PostgreSQL connection startup role, verifies
current_user and absence of elevated/request-owner/admission rights, and covers
real HTTP prepare/status plus exact withdrawal cases. No production grant or
credential is created. These tests require new execution on the exact replay.

Natural15-minute preparation expiry followed by accepted HTTP recovery is not
covered by the current PostgreSQL test. An explicitly read-only unit mock models
expired/current=false preparation and tests immutable capability authentication
plus accepted receipt lookup. A proposed administrator timestamp-mutation draft
was removed without execution; no trigger/clock bypass is used for this entry
regression. A future natural-time observation must wait outside all transactions
and release heavy test resources, then perform fresh reads under the unchanged
query/proof budgets.
