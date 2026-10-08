# Errands E1 acceptance status

This increment is text-only and PARTIAL. See [API contract](../API_ERRANDS.md) and
[feature parity](../FEATURE_PARITY.md). No production issuer, real-provider call,
real privilege grant, production data, dependency addition or deployment was used.

## Frozen complete local gate

Validated 2026-10-08 against base commit
`ad438a304a452da90aee7de1c7ca26616533eec1` plus this E1 increment.
The source freeze included 1,039 tracked and untracked source/config/test files;
documentation was excluded, and all seven generated OpenAPI artifacts were frozen
separately. Canonical source-manifest SHA-256:
`921848a2644a7e234b6f7ed0ca9d189c7661a351aa7625f976d6c5097ff44acd`.
Seven-artifact manifest SHA-256:
`61e267a758afe42fb307953e21b48ca2f3ddf1614699af358ab9b379d9c29305`.

- Complete `npm run check`: exit 0, 19:49:56–19:51:07 UTC, including lint, strict
  types, all seven OpenAPI drift checks, unit tests, builds and emitted native smokes
- Complete `npm run format:check`: exit 0, 19:51:07–19:51:21 UTC
- Unit totals: 5 root statistics + 711 API + 1,063 native = 1,779 passed
- Required real-cloc integration: 1/1 passed separately using the existing
  checksum-verified cloc 2.10; no download, install or dependency audit
- Complete serialized `npm run test:integration`: 1,222 passed, 19:55:07–20:09:55 UTC,
  duration 887.494657961 seconds
- Main combined denominator: 3,001 passed; zero failures, skips, cancellations
  or pending tests. The separate real-cloc integration is not added again.
- PostgreSQL 18.6 (`180006`), isolated disposable loopback database; actual
  launch-only `max_connections=100`, zero application schemas before and after
- Final integration and runner exit 0; PID file absent and server stopped, verified
  in the same runner execution namespace
- Frozen source, all seven OpenAPI files and persistent PostgreSQL configuration
  unchanged before/after the final PostgreSQL gate; whitespace checks pass

Focused development runs below are not double-counted in the aggregate. Hosted verification and deployment are separate.
The independent E1 source/privacy review had no outstanding material findings.

### Test orchestration corrections

The first orchestration passed complete check and format, then stopped because the
private wrapper omitted the required `CLOC_PATH` test precondition. Its failed
status is retained; it is not called a successful wrapper. Supplying the existing
checksum-verified executable made the required real-cloc integration pass 1/1.
Those earlier successful components remained valid because frozen bytes did not
change.

An initial PostgreSQL aggregate used the persistent 50-connection default. It was
interrupted before a product failure to restore the established 100-connection
concurrency-suite precondition. The exclusive locked runner recovered the isolated
cluster, inspected and removed only the interrupted run's disposable fixture
schemas, proved zero schemas, then shut down normally. No active runner lock was
bypassed or PID file manually removed. The final complete PostgreSQL suite started
from a verified empty database with a launch-only 100-connection override; the
persistent configuration stayed unchanged. No test or implementation source was
edited during these gate attempts.

## Focused development evidence

- Fresh API strict schemas preserve 1–500 exact decimal strings up to 100 digits
  without cent rounding; Unicode/source form bounds and contact distinctions
- Canonical errand review is separate from post scope/category semantics; shared
  approval metadata validation remains compatible with post/comment/reply tests
- Normal AppModule and disposable PostgreSQL 18.6 exercise source/target region
  separation, related/foreign own-only discovery, cross-region single-winner
  acceptance, immutable participant scope and campus-change relationship survival
- Completion/cancellation retain private participant text while removing opposite
  contacts; publisher soft-delete preserves lifecycle and historical completion
- Feature publish/accept/all, whole-account and phone gates are distinct; reviewed
  temporary base and current role grants cannot fabricate publication affiliation
- Eight simultaneous claimers produce one winner, one accept transition/notice and
  one preference update; competing lifecycle commands do not overwrite outcomes
- Same-key retry and changed-intent conflict; unknown/unavailable review leaves no
  terminal request; notification insertion failure rolls back state/history/receipt
- Real independent-connection waits prove temporary/grant and phone expiry after
  order locks/quota waits; deferred review-consumption expiry rolls back publication
- Rejected-command savepoint rollback restores provisional managed deadlines
- Numeric reward keysets retain precision/ties in both directions; opaque cursor
  scopes bind owner/session/endpoint/query/campus/topology and contain no private
  text, contact values or public text bodies
- SQL rejects private deletion, edited scope/definition, illegal lifecycle edges,
  missing/pending/false receipts, phantom transitions and causal notice mismatches
- Actual native errand and notice gateways cross normal HTTP/PG for publication,
  dropped-success recovery, detail privacy, own/contact histories, notices, read,
  completion and deletion. This is executable transport acceptance, not a device test.
- Swagger generation is official, deterministic and offline; every route has exact
  strict outputs, auth and private cache headers, with sanitized error contracts

The final focused normal-AppModule PostgreSQL run passed 23/23 before the complete
frozen gate. These cases are also included in the 1,222-test integration aggregate.
The 18 new API/review/OpenAPI tests and 133 added native tests are included in the
complete unit totals above. The actual native-gateway roundtrip is transport
acceptance, not physical-device acceptance.

Pre-freeze fixes addressed causal transition/order/receipt proof in both directions,
private snapshot deletion protection, notice deduplication and causal obligations,
reviewed region-column equality, bounded pending/foreign-own keyset indexes,
chronology and output coherence, safe malformed decimal rejection, and real
`ERRAND_NOT_FOUND` notice navigation privacy clearing. An initial SQL CASE parse
error and a test expectation for the shared BAD_REQUEST error were corrected;
focused checks were rerun afterward. No authority bypass or allow-all override
was used to obtain a passing result.

## Open parity and release gates

Administrative listing/search/exact totals/delete and sanctions/release/history;
private/public media ownership/review/delivery and re-review; group/help/QR
preferences, short links and per-destination two-stage promotion; external issuer,
provider and scheduler readiness; source schema/precision/timezone/data mapping and
restore rehearsal; native-device acceptance across independent accounts/regions.
No payment, refund, commission settlement or runner-rating claim is added.
