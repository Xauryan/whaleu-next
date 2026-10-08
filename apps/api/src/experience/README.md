# Local owner experience

This bounded development slice owns the rule catalog, immutable settlements,
owner history, sign-in, daily opportunity counters, levels, durable title
ownership, title/color selection and acknowledgement-only unlock notices.

## Evidence and ordering

Only a new identity account created in the same transaction establishes a known
zero baseline and known empty sign-in history. It owns `default_jingxiaoyu` and
`level_1`; neither is initially equipped. Existing/unproven accounts remain
`baseline_unknown`. Reads create nothing. Proven undated owner records and title
ownership remain readable, and owned titles/base colors remain selectable.

Community alone captures fresh source transitions. Each source group atomically
enrolls its complete deduplicated beneficiary set and work. A commit-serialized
reservation gate precedes sorted queue guards; workers never acquire that gate
or a mutable community/content lock after taking one owner guard. Workers settle
one beneficiary per transaction in that owner's enrollment order. An unknown
recipient remains pending without blocking a known actor. Saved reward
obligations are acknowledged only with their matching settlement. Unrelated
Saved consumers and notification receipts are untouched.

The application day is the database clock in Asia/Shanghai after the owner lock.
Source occurrence is separate. Terminal capped results never gain a new chance
on replay; actual re-like/re-save transitions may earn within the shared caps.
Own deletion retains its nominal penalty even when balance-floor clipping makes
the applied delta smaller, and separately refunds today's eligible opportunity.

## Owner-only interfaces

`/v1/me/experience` exposes truthful baseline/coverage, nullable unknown balance
and streak, progress, informational tasks and own pending count. Records use
owner-scoped immutable keyset cursors and generic action metadata: no source body,
counterparty, content preview or navigation link. Public profile display remains
outside this slice. Catalog IDs never grant authority.

Sign-in and full appearance selection use exact request-ID/intent receipts.
Sign-in refuses unavailable baselines or preceding own pending work without a
terminal receipt. Appearance conflicts/ineligibility return HTTP 200 terminal
rejection receipts. Request-ID reuse with a different intent is HTTP 409.
Previously equipped high colors survive downgrade; a newly selected high color
requires the current known qualifying level. Title ownership is never revoked by
experience loss. Clearing either appearance dimension is independent.

## Local processing and limits

Processing defaults to `manual_only`. `experience:process` defaults to dry-run;
apply requires explicit bounded unit/group IDs. CLI configuration disables all
unrelated background processors. Apply, retry and automatic discovery enforce
nonproduction, a dedicated local database and the actual loopback connection.
Explicit `automatic` configuration processes only durable fresh-enrolled work,
with bounded per-unit retries and stop/restart recovery. Dry-run changes no row.
There is no public credit, processing, baseline adoption or repair endpoint.

Historical reconciliation/import, public profile badges/received totals,
rankings, redemption, special-grant/admin maintenance and noncommunity rewards
remain separate work. Real providers and physical-device acceptance have not
been established. The SQL conservation checks deliberately reconcile immutable
history; representative large-history throughput remains a release gate. This
slice is not production-ready.
