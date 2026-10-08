# Local search canonical owner reuse acceptance

Stage 2, verified 2026-10-08 against base
`c423032d741f472a5343b2cf99a8e2028741ca59` plus this increment. Hosted verification
is separate; no production deployment, new dependency, model or provider is
included. Safety coverage and relationship decisions remain uncached.
[Machine-readable evidence](search-canonical-reuse.json) contains the complete
source and generated-artifact manifests, terminal totals and actual SQL plans.

## Frozen final gates

All 934 non-Markdown source/test/config/asset files retained fingerprint
`a787e39b5638c5672b7665b875084af1e30ea5cde8c6601799ceb23c59f3ac60` throughout
one complete final aggregate. All five generated OpenAPI artifacts retained
`cde136d5b7a3447a861d8ec15158f7dab7dbfc5057fa290874ea50cd496c95d2`.
Documentation is excluded from the source freeze.

- `npm run check`: exit 0, including lint, types, OpenAPI drift, builds and
  emitted native smokes
- `npm run format:check`: exit 0, including the prior batching hosted-status
  documentation update
- Unit totals: 5 statistics + 673 API + 914 native = 1,592 passed
- Complete `npm run test:integration`: 1,142 passed in 822.492248053 seconds
- Combined: 2,734 passed, zero failures, skips, cancellations or pending tests
- PostgreSQL 18.6 (`180006`), isolated disposable local cluster, launch-only
  `max_connections=100`; zero non-system schemas before and after
- Integration/runner exits 0; server stopped with `pg_ctl status` exit 3;
  source/OpenAPI comparison and `git diff --check` exit 0

Focused runs are not counted twice. Independent source/test review found no
remaining blocker before the final freeze. Hosted verification is separate.

## Narrow implementation and boundaries

`SearchReadContext` is created inside the existing managed READ COMMITTED search
callback, after mandatory Safety proof enablement. It is passed explicitly to
canonical owner reads, sealed synchronously after the final cursor/result work,
and closed in `finally`. Nothing is cached globally by pooled client identity.
An opaque transaction nonce changes on start and checkpoint restoration and is
removed on cleanup. A retained context therefore rejects another transaction,
another client, restoration, closure and an invalidation during an awaited load.

Private owner namespaces retain successful locked post/root/reply, source-space,
trading and active-region reads, completed canonical base proofs, and positive
SHARE-locked approval-account anchors. The same demanded source row feeds search
hydration and exact canonical reconstruction. Binding → account anchor →
approval-head ownership order remains intact on first demand; an already-held
anchor is reused. A completed proof retains its checked binding identity/mode
and version without another binding query or redundant ancestor reconstruction.

The existing pure approval, binding, definition, node and scope validators remain
authoritative. Content kind/ID/version keys are distinct, including equal UUIDs
across tables. Every subject use still checks its author mode and named account;
source-row reuse does not skip a supplied scope comparison. Unknown and denied
canonical outcomes are never retained as completed proofs.

The context is a search-only lane. Mutation APIs and savepoint-recovery paths do
not acquire it. `DatabaseService` is unchanged; the deadline module only supplies
an opaque lifetime nonce. Catalog resolution is unchanged; this increment does
not promote caller-provided catalog rows or optional count snapshots to proof.

Only sequentially consumed candidates, their required ancestors and the existing
visible guard load bodies or activate proofs. The query-independent structural
window, metadata-only sentinel, sorted post → root → reply locks, stable reread,
matching order and cursor scope remain unchanged. No replied-to target body or
author is read. Post `list_projection`, parent `direct_post` and independent child
`list_projection` Safety checks all still run with their original purpose.

Cached proof reuse never removes registered deadline minima or required final
relationship facts. The final raw-block-table fence, relationship reread,
session/phone checks and cursor rollback remain mandatory. A final epoch seal
also rejects checkpoint restoration occurring after the last cache read.

## Measured SQL reduction

The following paired measurements came from the frozen full aggregate. The
scalar canonical baseline uses identical metadata batching and actual owner
policies, with only the explicit canonical context disabled by a test helper.
The successor is primed so insertion versus reuse does not distort the pair.

| Synthetic request                     | Scalar SQL | Context SQL | Saved SQL | Scalar ms | Context ms |
| ------------------------------------- | ---------: | ----------: | --------: | --------: | ---------: |
| Mixed children, 2,600-child fixture   |      8,035 |       1,910 |     6,125 |  2,002.25 |     453.40 |
| Roots, same fixture                   |      5,666 |       1,717 |     3,949 |  1,289.86 |     417.26 |
| Replies, same fixture                 |     10,403 |       2,112 |     8,291 |  2,334.14 |     520.66 |
| Within one topic, same fixture        |      8,035 |       1,902 |     6,133 |  1,679.25 |     479.87 |
| 128 distinct reply chains, 16 authors |     10,401 |       3,763 |     6,638 |  2,624.00 |   1,017.08 |

The shared-parent fixture has two posts, 1,300 roots and 1,300 replies. Depending
on the request, its 128 consumed candidates require 129–132 distinct canonical
nodes. Each node has exactly one binding/head/body read; the shared approval
account has one anchor read. The fragmented fixture has 129 post/root/reply
chains and consumes 128 of them: 384 canonical nodes and 16 approval accounts,
with one binding per node and one anchor per account. Its final chain is a
metadata-only sentinel. This is not a one-author-per-node benchmark.

Actual structural SQL plans and buffers are retained in the JSON evidence.
Structural candidate execution was 0.333–2.919 ms in these four full-aggregate
shared-parent samples. Endpoint wall times include all owner, Safety, cursor and
finalization work. Earlier independent focused runs reproduced identical SQL
counts with different wall times.

These are local synthetic results, not a production latency or throughput
promise. Full literal traversal still scales with corpus size; sparse index work
and catalog enumeration are not made constant-time. No Safety caching, count
snapshot collector, media fanout, production migration or deployment is added.

## Regression coverage and pre-gate corrections

Fourteen focused unit tests cover the managed lifetime, reused pooled clients
after commit/rollback, restore/close/during-load rejection, nested/concurrent
namespace retention, exact subject/version/kind checks, changed supplied scopes,
one reconstruction/image read per demanded node, and independent Safety checks.
Closing the context is verified to preserve mandatory deadlines and final facts.

Real PostgreSQL comparisons cover plain, trading, poll and formation definitions;
named, anonymous, self and guest paths; IDs, original snippets, complete pages,
logical cursor coordinates, continuation and exact error code/message. Request
IDs are intentionally request-specific. Unconsumed unknown/expired rows and the
sentinel have body and approval traps. Cached ancestor expiry, late checkpoint
restoration and raw block insertion after cursor creation all abort and roll back
the successor. Fresh transactions observe review revocation and source deletion.
The full existing lock-race, anonymous/named ancestry, session/phone and raw-block
finalization suites pass unchanged.

Before the freeze, review identified and corrected three helper/lifecycle issues:
use a separate frozen nonce rather than expose the deadline map; retain nested
owner entries after awaited loads; and seal the epoch after the last application
work. No final-gate source change was made.

Early verification also exposed test-only issues: an API test invocation needed
the API working directory; a new test used `Promise.withResolvers` outside the
configured library and was changed to a local deferred helper; new differential
assertions incorrectly compared request IDs and counted session-account reads as
approval anchors. The first focused PostgreSQL run had two failing subtests and
their enclosing suites (16/20 passed); a second already-loaded run still had the
anchor assertion failure (19/21 passed). After correction, 21/21 focused tests and
the expanded 7/7 canonical suite passed. The final frozen aggregate passed on its
first attempt, without relaxed assertions or runtime/compiler changes.

## Hosted verification

Verified SSH-signed commit `d3fa5bb4efe141e1c630eb002acc989da0f47814` passed
[GitHub Actions run 37814745606](https://github.com/Xauryan/whaleu-next/actions/runs/37814745606),
job 113440374105. Actual logs confirm 5 statistics, 673 API, 914 native and 1,142
PostgreSQL tests: 2,734 passed, zero failures/skips. PostgreSQL took
1,055.102462458 seconds. All check, formatting and container cleanup steps passed.
The 934 published source files and five OpenAPI artifacts match the tested freeze.
[Automatic statistics publication](https://github.com/Xauryan/whaleu-next/actions/runs/37814745622)
also passed, with the exact committed SHA in the served SVG.
