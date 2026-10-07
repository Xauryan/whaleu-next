# Local reports, post juries and system notices

This increment implements a provider-independent local moderation outcome, not a live moderation deployment. Ordinary community access still uses its existing fail-closed visibility source. Test adapters and synthetic grants are never registered by the application. No provider, production import, grant bootstrap, appeal, ban or external delivery is enabled.

## Rules and owned boundaries

- Reports accept only a durable UUID and a typed post/root-comment/reply target. All three kinds reject the true owner, including anonymous authors. This intentionally closes the legacy post-backend self-report inconsistency; own deletion remains a separate operation.
- Mutations require a current active account/session, phone proof, affiliation proof, and complete safety policy coverage. The verification-owned narrow read locks one snapshot head and reads only phone and affiliation assertions. It never reads student numbers or uses profile/browse campus, publication-category authorization, or a fresh institution sign-in.
- Progress requires current ordinary target and ancestor visibility, with no phone or affiliation prerequisite. Eligibility and weighting are advisory capabilities; their failures do not suppress readable counts. Account and visibility deadlines remain authoritative through the final transaction check. Removed or inaccessible targets return `REPORT_TARGET_UNAVAILABLE`; own minimal receipts survive.
- New native publication establishes immutable reporting-origin coverage in its own transaction, bound to the accepted owned publication receipt. Older or imported targets are never adopted automatically; missing origin returns `SAFETY_UNAVAILABLE`, not zero historical reports or an asserted absent jury.
- Community owns ancestry, visibility, canonical content digest and moderation removal. Post locks are acquired for UPDATE from the outset of mutations, followed by root and reply. True ownership is internal solely for self/juror exclusion and the notice destination. Anonymous visibility subjects never contain it.
- Reports, report request receipts, cases, jury ballots and obligations are separate from ordinary poll ballots and named-block receipts. Reports and ballots are immutable, and actor/case or actor/jury uniqueness prevents duplicate counting.

### Post reports and juries

Five effective report units create exactly one post jury. Ordinary members count one. A live same-region school administrator or a live global super-admin/developer grant counts five. The selected grant, scope evidence and effective weight are frozen privately at acceptance; later expiry or revocation does not rewrite history. A role string, identity-view flag, current profile campus or client field is never weight authority.

Original global author-region and related-region scope are not yet owned by the target model. A potentially qualifying school-admin grant outside a proven exact regional match returns `REPORT_SCOPE_UNAVAILABLE`, including regional mismatches whose related-region exclusion is unknown. Ordinary members still count one, and genuine global grants count five. This is an explicit remaining scope parity boundary.

The actual count and effective weight are separate. The reachable post count is 0–5, with weight equal to the count or count plus four, at most nine. Once a jury exists, further reporting is permanently closed, even after keep. Jurors cannot be the true author or any reporter. Each juror casts one immutable keep/remove choice. Six on either side closes synchronously; total ballots cannot exceed eleven. Otherwise, at the database-created 24-hour deadline, remove wins only with a strict majority. Zero or a tie keeps. A pending due jury is shown as `settlement_pending`; reads and client timers never settle it.

### Discussion reports

The first accepted root/reply report creates one durable `provider_disabled` review obligation with attempts zero and a bound content digest. The tenth distinct report soft-removes the target synchronously, regardless of that disabled provider. Root removal releases the existing root pin and makes descendants inaccessible through ancestry. No provider is called and no clean review verdict is fabricated.

A content-version mismatch prevents stale removal, keeps the obligation unresolved and leaves post-jury work retryable. Reconciliation of edited/imported content is separate work. There is no invented post-pin model; current post removal releases existing root pins on that post. Future post pins must join the community-owned removal contract before activation.

### Atomic removal and notices

Community removal, applicable pin release, uniquely keyed invalidation event, safety decision, final jury/case state and the local author system notice commit together. Failure in any part rolls back all of them. Independent owner deletion wins at the same post lock; the jury becomes superseded, with no new jury-removal notice. No path resurrects content or bans/restricts the author, changes grants, or invokes owner-delete rewards/refunds.

Only jury-caused post removal creates a notice. The notification leaf stores the actual owner-only notice in the settlement transaction, uniquely keyed by decision and recipient. It contains safe removal tallies and dates, with no target link, content preview, anonymous identity, reporter or juror IDs. It remains readable after target deletion under any still-active session, independently of phone/affiliation status. Read state is first-write idempotent, and unread counts are calculated from retained rows. Local notice materialization is not external delivery.

## Transport

All routes require authentication, exact request keys, and return the normal API envelope with `Cache-Control: no-store` and `Vary: Authorization`. Repeated or unknown query parameters are rejected. UUIDs are normalized to lowercase; dates are UTC ISO strings with three fractional digits.

| Method     | Path                                       | Input                                                  |
| ---------- | ------------------------------------------ | ------------------------------------------------------ |
| POST (200) | `/v1/me/safety/reports`                    | `{clientRequestId,target:{kind,id}}`                   |
| POST (200) | `/v1/me/safety/jury-votes`                 | `{clientRequestId,postId,juryId,vote}`                 |
| GET        | `/v1/me/safety/report-progress/:kind/:id`  | No query keys                                          |
| GET        | `/v1/me/safety/report-requests/:requestId` | No query keys                                          |
| GET        | `/v1/me/system-notices`                    | Optional owner-bound cursor and limit 1–50, default 20 |
| GET        | `/v1/me/system-notices/unread-count`       | No query keys                                          |
| PUT        | `/v1/me/system-notices/:id/read`           | Empty object body, no query keys                       |

Report/vote mutation and recovery return the same minimal receipt:

- Accepted: `{requestId,operation:'report'|'vote',outcome:'accepted',receiptId}`
- Rejected: `{requestId,operation:'report'|'vote',outcome:'rejected',code}`

There are no live counts, previews, target identity or implied removal in a receipt. Same account/key/normalized intent replays its immutable receipt without eligibility or settlement reruns; a changed intent conflicts. A new key for an existing report or ballot returns a stable duplicate rejection.

Progress is a strict kind-discriminated projection defined in `apps/api/src/safety/reporting/contracts.ts`, with count, caller `hasReported`, `isSelf` and advisory report capability. Post progress adds effective weight and an absent or pending/settlement-pending/kept jury with counts, deadline, the caller's own choice and vote capability. Discussion progress adds absent or provider-disabled review. No roster exists. Native contracts validate reachable aggregate states as well as exact keys.

New terminal codes are `REPORT_TARGET_UNAVAILABLE`, `REPORT_SELF_NOT_ALLOWED`, `REPORT_ALREADY_REPORTED`, `REPORTING_CLOSED`, `AFFILIATION_VERIFICATION_REQUIRED`, `JURY_NOT_FOUND`, `JURY_INELIGIBLE`, `JURY_ALREADY_VOTED`, and `JURY_CLOSED`. Existing phone/restriction codes are retained. `REPORT_SCOPE_UNAVAILABLE`, verification/authorization/safety unavailability and infrastructure failures are retryable HTTP failures, never fabricated successful receipts. System notices use existing `NOTICE_NOT_FOUND` and new `SYSTEM_NOTICES_UNAVAILABLE`. Raw database errors are never returned.

## Ordering, clocks and bounded work

The shared safety-policy gate is acquired before identity and content locks; reporting never upgrades it to exclusive. Actor identity, request identity, narrow policy/verification and real grant reads precede post/root/reply locks. Cases/juries follow their post. Work discovery holds no work-row lock while waiting for a post. This also serializes absent-case creation safely.

Every bound actually relied upon by an accepted mutation is registered with the existing transaction-deadline registry: active session, phone, affiliation, safety/visibility and selected grant, plus the original deadline for every accepted jury ballot. Deferred constraints are flushed and `clock_timestamp()` is checked immediately before commit. A ballot waiting across the deadline rolls back its prospective ballot, receipt, removal and notice. Optional capability and terminal-rejection savepoints restore only rolled-back optional bounds; active-session/current-visibility requirements are preserved.

Operational defaults are new target policy, not legacy quotas:

| Setting                             | Default | Bound                                          |
| ----------------------------------- | ------- | ---------------------------------------------- |
| `SAFETY_REPORTS_PER_MINUTE`         | 30      | 1–1000 fresh report attempts                   |
| `SAFETY_VOTES_PER_MINUTE`           | 30      | 1–1000 fresh vote attempts                     |
| `SAFETY_REPORT_READS_PER_MINUTE`    | 120     | 1–10000 progress/recovery/replay reads         |
| `SAFETY_TARGET_REQUESTS_PER_MINUTE` | 120     | 16–10000 distinct submitting actors per target |
| System-notice reads                 | 120     | Per owner per minute                           |

Target admission precedes content contention and is retained with terminal request outcomes. Each actor consumes at most one target slot per minute, so fresh-key duplicates cannot exhaust other actors' slots. The minimum target capacity permits five legitimate reports and eleven voters. Committed replays use read quota, not another fresh mutation slot. Buckets reuse fixed actor/action or actor/target rows, rather than accumulating time-window history. Rate failures carry `Retry-After: 60`.

### Local settlement worker

`SAFETY_JURY_PROCESSING=disabled|manual_only|automatic` defaults to **disabled**. Native jury/work creation commits even while disabled. Explicitly enabled automatic mode can later process those authenticated native due records, including overdue records; it never adopts unknown imported cases or enables external review.

The bounded automatic loop has one in-flight cycle per instance, a default 5-second interval (`SAFETY_JURY_INTERVAL_MS`, maximum 60 seconds), batch 20 (`SAFETY_JURY_BATCH_SIZE`, maximum 50), stop/start generation guards and graceful shutdown. Concurrent instances settle once using the same owner lock. Retry metadata is durable, with a safe error code, a next-attempt time and bounded exponential delay from 5 to 60 seconds. There is no arbitrary retry limit discarding accepted work. A changed version stays unresolved with `content_version_changed`.

The local command is dry-run by default and requires explicit selected jury IDs to apply:

```sh
npm run juries:process -w @whaleu/api -- dry-run --jury-id=<uuid>
SAFETY_JURY_PROCESSING=manual_only npm run juries:process -w @whaleu/api -- apply --jury-id=<uuid>
```

The command refuses production, non-loopback hosts and database names other than `whaleu_dev`/`whaleu_test`. It prints only aggregate results. There is no public administrative processing endpoint.

## Verification and release boundaries

`test/reporting.test.ts`, `test/system-notices.test.ts`, `test/integration/reporting.test.ts` and `test/integration/reporting-client-contract.test.ts` exercise strict transport, proof independence, source thresholds, real grants, replay/duplicates, anonymous privacy, deterministic removal, notice ownership, automatic deadline restart, retry, SQL integrity and final-clock rollback. Integration suites require isolated PostgreSQL 18 and refuse pre-existing application/fixture schemas before claiming cleanup ownership. The shared schema helper already covers both owning schemas; this forward migration adds no new schema.

The native flow uses separate reporting and jury durable intents, confirms exact targets/juries, keeps content independent of progress availability, clears stale content/media on confirmed target loss, and retains minimal receipt recovery. System notices are a distinct category without deleted-content navigation.

Passing synthetic tests establishes these local boundaries, not production access, complete historical coverage, active external review, related/global scoped-authority parity, post-pin administration or external notification delivery. Live visibility policy sources, audited import/cutover and real role/provider activation remain separately authorized work.
