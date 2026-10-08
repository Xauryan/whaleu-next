# Local search Safety coverage head reuse acceptance

Stage 3, verified 2026-10-08 against base
`d3fa5bb4efe141e1c630eb002acc989da0f47814` plus this increment. This is local
acceptance only; no hosted publication, deployment, dependency, model or provider
is included. [Machine-readable evidence](search-safety-head-reuse.json) contains
full source/artifact manifests, final gate totals and actual structural SQL plans.

## Frozen final gates

All 937 tracked/untracked non-Markdown source/test/config/asset files outside
docs retained fingerprint `a6a230b5b81e47977bde3a0d7dc580ae17b4f8158f0636b50c2181bd1b1ebbb8`.
All five OpenAPI artifacts retained
`cde136d5b7a3447a861d8ec15158f7dab7dbfc5057fa290874ea50cd496c95d2`. Documentation is outside the source freeze.

- Complete `npm run check`: exit 0, including lint, strict types, statistics,
  OpenAPI drift, all unit tests, builds and emitted native smokes
- Complete `npm run format:check`: exit 0
- Unit totals: 5 statistics + 685 API + 914 native = 1,604 passed
- Complete `npm run test:integration`: 1,151 passed in 834.950764778 seconds
- Combined: 2,755 passed; zero failures, skips, cancellations or pending tests
- PostgreSQL 18.6 (`180006`), isolated disposable cluster, launch-only
  `max_connections=100`; zero non-system schemas before and after
- Integration/runner exit 0; server stopped (`pg_ctl status` exit 3)
- Exact source/OpenAPI comparison and `git diff --check`: exit 0

Focused successes are not counted twice. Independent source/test review found no
blocking issue before the freeze. No source edit occurred during the final gate.

## Narrow retained facts

The existing explicit search-only `SearchReadContext` now retains positive
owner-validated, SHARE-locked Safety coverage projections by account ID in a
private owner namespace. Only a frozen primitive numeric/null `validUntil` is
retained. Neither mutable owner rows nor Dates escape into the retained value.

Every invocation still queries the current database clock, including misses,
nested loads and concurrent calls. A miss reads the original locked head, takes
its clock and runs the existing `validateBlockCoverage`; a hit takes a fresh
clock, checks the context epoch and runs that same validator over the positive
projection. Original mandatory deadline registration follows every success.
Unknown, missing, malformed and initially expired heads are not retained.

The originally considered relationship-decision cache was deliberately excluded.
Raw block/unblock writes can change observations within READ COMMITTED even while
head rows remain SHARE-locked. Every original purpose-sensitive relationship
EXISTS query and `requireAllowedSafetyRelationship` call remains unchanged.
No denial, restriction, action, relationship or cross-request cache was added.

List projections require only viewer coverage. Direct parent and public-profile
directions require both distinct accounts in sorted order. Post list, parent
direct and each independently named child list check preserve their purposes.
Guest, self and anonymous exceptions remain scoped to the checked author.

The structural window, metadata-only sentinel, canonical reconstruction,
sequential candidate consumption, matching, session/phone requirements, minimum
deadlines, final block-table fence, batched relationship validation and cursor
rollback are unchanged. Non-search callers omit the context and keep scalar
owner reads. The context's existing epoch and close lifecycle prevents reuse
after commit, rollback, restoration or closure.

## Measured Stage 3 savings

These paired measurements come from the frozen complete aggregate. The test-only
scalar Safety adapter drops only the context argument to `directions`; canonical
reuse, metadata batching and all real policy/finalization work stay enabled.
The same successor is primed before measured requests. Query counts cover
successful observed statements after BEGIN, including finalization and COMMIT;
BEGIN itself is excluded equally in both lanes.

| Synthetic request                                | Scalar Safety SQL | Reused-head SQL | Saved SQL | Scalar ms | Context ms |
| ------------------------------------------------ | ----------------: | --------------: | --------: | --------: | ---------: |
| all child sources                                |             1,910 |           1,464 |       446 |    544.87 |     390.65 |
| root source                                      |             1,717 |           1,335 |       382 |    360.57 |     322.27 |
| reply source                                     |             2,112 |           1,602 |       510 |    488.94 |     374.57 |
| within-topic                                     |             1,902 |           1,456 |       446 |    413.68 |     359.23 |
| fragmented 128 consumed reply chains, 16 authors |             3,763 |           3,268 |       495 |    903.23 |    1136.79 |

The shared-parent fixture contains two posts, 1,300 roots and 1,300 replies.
Each request consumes 128 structural candidates. It reads two distinct Safety
heads once each, replacing 384–512 scalar head reads. The fragmented fixture
consumes 128 reply chains with 16 named authors, reads 17 Safety heads once each,
and replaces 512 scalar head reads. It is not a one-author-per-node benchmark.

After removing only Safety-head SQL, the paired lanes assert exactly equal SQL
statement strings and order, including fresh clocks, relationship EXISTS,
session/cursor work and final proof. The separate scalar-owner diagnostics remove
both canonical and Safety reuse; their combined delta is labeled accordingly.
Structural plans, visited rows and buffers are retained in the JSON evidence.
The fragmented context was slower in this full-run timing sample (1,136.79 ms
versus 903.23 ms) despite fewer SQL statements; these timings do not establish
a latency improvement.
These are local synthetic results, not production latency guarantees. Full
literal corpus traversal and source catalog enumeration still scale with size.

## Regression evidence and pre-freeze correction

Twelve new units cover scalar decision/error and purpose equivalence, fresh
clock/query counts, invalid-head retry, immutable expiry, restriction/action
non-reuse, guest/self/anonymous boundaries, nested/concurrent loads, restore/close
during awaited clocks, reused pooled clients and final expiry/raw-block rollback.
The independently repeated focused non-PostgreSQL set passed 77/77.

Real PostgreSQL tests prove the head SHARE lock blocks an actual UPDATE until
commit and a new transaction sees revocation. Raw allow → block → unblock remains
fresh within one transaction. Cached expiry at a later consumed node, after
successor insertion and after an observed real cursor-quota lock wait remains
fatal. A raw block inserted after repeated reuse and cursor creation is caught by
the unchanged final fence/proof and rolls back storage.

Scalar and contextual pages preserve component definitions, snippets, logical
cursor positions and exact errors. Reverse-only blocks keep post list hits while
denying child parent chains. Independently named descendants remain checked under
anonymous ancestors. Distinct off-page named-parent unknown/expired Safety heads,
bodies, bindings and final relationship facts are trapped; a full earlier page
succeeds, and consuming the unavailable node produces the same scalar error.

The first new PostgreSQL run passed 7/9 tests: one new assertion and its enclosing
suite failed because a reply by the anonymous parent's own author is canonically
anonymous. The fixture was corrected to use a distinct named child with separate
incoming/outgoing relationships. No production semantics or strict expected
result was changed. The corrected focused aggregate passed 31/31 in 53.105406584
seconds.

The first frozen root check then exposed one existing strict mock-call assertion
that expected four repository arguments rather than the added optional context
argument. API tests passed 684/685, native 914/914 and statistics 5/5; no PostgreSQL
aggregate started, and the source/artifact manifests remained unchanged. With
explicit approval, the expected call gained only a fifth `undefined`, preserving
all original actor/purpose/client values and complete call-count assertions.
After 97/97 focused regressions and an independent 20/20 named-visibility rerun,
the freeze was refreshed and the entire aggregate passed. Production behavior was not changed.

## Hosted verification

Verified SSH-signed commit `2ae0113fae5913280b86aae70668c011fc0575dd` passed
[GitHub Actions run 37822191364](https://github.com/Xauryan/whaleu-next/actions/runs/37822191364),
job 113465779953. Actual logs confirm 5 statistics, 685 API, 914 native and 1,151
PostgreSQL tests: 2,755 passed with zero failures/skips/cancellations. PostgreSQL
took 868.438460016 seconds. Root check, formatting and container/network cleanup
passed. All 937 published source files and five OpenAPI artifacts match the freeze.
[Automatic statistics publication](https://github.com/Xauryan/whaleu-next/actions/runs/37822191271)
also succeeded; the served SVG displays the exact committed SHA.
