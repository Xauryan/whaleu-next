# Ratings management M1: native generic target creation

Development slice on the reviewed e9f889c baseline. Integrated migration
0055 follows the immutable R3R 0054 migration. No
production issuer, review decision, user role, source import or provider is seeded.

## Independent authority boundaries

- Session, active account, phone, Safety and current region authorization reuse
  existing rating owners. Ordinary users do not require an administrator role or
  per-account create grant.
- An immutable deployment native-source policy and monotonic current head enable
  the supported `general` category kind for one display scope. Empty, expired,
  disabled, conflicting or unproven policy is unavailable. Specialist course,
  faculty, canteen and multidimensional ratings are outside this slice.
- Canonical Review must independently approve the exact prepared v1 envelope.
  There is no reviewer endpoint or synthetic approval switch in the runtime.
- Original campus is independent of display region and user permission. Optional
  exact account/request/intent origin evidence may identify a canonical campus or
  explicitly schoolless origin. Without evidence the created origin is `unknown`,
  with missing/unknown provenance, never guessed from current profile or a null
  display scope. Only a deployment policy explicitly requiring known origin
  makes its absence blocking. Fixed-school administrative deletion fails closed
  for unknown origin through the existing origin owner.

## Preparation and transaction

Preparation reserves the shared account/request command namespace, records the
canonical intent hash, session, stable target/revision, old catalog/revision,
policy/origin evidence and random 256-bit context. PostgreSQL validates the
canonical intent hash and its envelope bindings. Preparation creates no target,
score baseline, approval or receipt. The ten-minute context is bounded by session
and source validity. Exact preparation replay is stable, including after commit;
a different active session can recover historical receipt but cannot consume an
uncommitted session-bound preparation.

Commit acquires the exclusive Safety gate first, before session, request or
source locks. It resolves an existing exact receipt before fresh eligibility.
New work rechecks the prepared context, deployment policy, category and every
ancestor, head CAS, current access and exact Review. Review binds the old catalog;
category identity/revision is copied unchanged into the new snapshot.

Set-oriented INSERT SELECT copies all categories and memberships into a new
unsealed catalog, preserving every existing ordinal. Categories are inserted in
ancestry order. A new membership gets the next ordinal. No live sealed catalog
is modified. The DB clock is used at microsecond precision; a head which cannot
advance strictly is rejected rather than manufacturing a future instant.

One transaction inserts the genuinely new source, target, trigger-generated
creation event, independent fresh-zero baseline, zero summary, origin, Review
binding, derived catalog, head CAS, typed transition and minimal success receipt.
Deferred checks bind these facts in both directions for managed sources and
validate complete snapshot set equality. Immutable receipts and transitions
cannot be rewritten. Failure rolls everything back, including Review binding.
An applied receipt is never fabricated for failure. Before publication starts,
a proven obsolete preparation or explicit content rejection closes the exact
request with a minimal rejected receipt and an immutable closure cause. An
explicit own-account cancel command may also close an unprepared or unavailable
request. Cancel/create use the same exclusive gate; existing applied receipts
always win, and a closed key can never later publish.

The writer's final proof validates the after head, exact before catalog, policy,
optional original-campus source, current target revision and post-mutation
navigation epoch. It does not register the old reader current-head proof and
then invalidate itself. Existing owner proofs still revalidate session, scope,
phone, Safety and Review after all deferred waits.

## Bounds and recovery

A transaction uses a 5-second statement budget; catalog copies are limited to
10,000 category rows and 100,000 existing memberships. Full equality checks are
SQL set operations in deferred constraints, not final unbounded JavaScript
scans. Above-budget catalogs fail closed without partial publication. This is a
bounded development implementation, not representative-load acceptance.

The native v5 journal freezes the complete intent before prepare. Retrying a
lost prepare response recovers the same allocation; retrying a lost commit first
recovers its own receipt or uses the identical prepared command. All rating
pages share the same pending slot. v1–v4 decoders and payloads remain intact.
Only a validated terminal receipt releases the journal; GET 404 and local
timeouts do not. An explicit two-step cancellation flow asks the server to close
the original intent and retains the journal if that response is lost.
Receipt recovery proves historical completion and does not reveal refreshed
content or silently navigate using stale catalog metadata.

## Deferred

Creation metadata edit/delete, original-campus issuer tooling, real Review
issuance, canonical migration/import, category editing and school overrides,
representative catalog load, hosted CI, native device rendering and production
acceptance remain independent work. This slice does not resolve historical
cumulative-like accounting or create global administration powers.
