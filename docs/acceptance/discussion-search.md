# Local discussion-search acceptance

Verified 2026-10-08 against base `ab2171a76f77bd8fa3f0514a14089275f91b68f9`
plus this increment. Hosted verification is separate. No production deployment,
historical import or physical-device acceptance is implied.

## Frozen gates

All 926 source/test/config/asset files retained manifest fingerprint
`23aae64e059616b71112e70f61baf80bf30fa994fa6dcc2005df5895efd2e67b` before and
after the final aggregate. All five generated OpenAPI JSON artifacts retained
independent manifest fingerprint
`cde136d5b7a3447a861d8ec15158f7dab7dbfc5057fa290874ea50cd496c95d2`.
[Machine-readable evidence](discussion-search.json) records the exact manifest
algorithm, every file/artifact hash, terminal statuses and log hashes. Markdown
and other documentation are excluded from the source freeze.

- `npm run check`: exit 0, including lint, types, five offline statistics tests,
  OpenAPI drift, 655 API tests, 914 native tests, builds and emitted native smokes
- `npm run format:check`: exit 0
- Complete `npm run test:integration`: 1,130 PostgreSQL tests passed in
  816.826219929 seconds; integration and runner exits both 0
- Total: 2,704 passed = 5 statistics + 655 API + 914 native + 1,130 PostgreSQL
- Zero failures, skips, cancellations or pending tests in the final aggregate
- PostgreSQL 18.6 (`180006`), isolated local cluster, launch-only
  `max_connections=100`; no non-system test schemas before or after the run
- Server stopped after verification; `pg_ctl status` returned the expected
  stopped status 3

The offline statistics tests are included in these totals. The separately tested
cloc integration is not counted again here.

## Implemented scope

The existing `GET /v1/community/search` now returns lightweight post, root-comment
and reply hits through one engine. No second compatibility engine or new route was
added. Existing explicit and all/regional/global scopes, category/subtype rules,
true source communities, urgent exclusion for explicit unfiltered search and
resolved-trading eligibility remain covered.

Added filters are `type=all|post|comment|reply`, inclusive `from`, exclusive `to`,
and optional `postId`. Dates apply to each hit's own time. Ordering is newest by
exact microsecond timestamp, fixed post/comment/reply order, then descending UUID.
This is pinned Unicode lowercase literal substring matching, including Chinese
short text, zero, punctuation, emoji and contextual lowercase behavior. It is not
semantic search or relevance ranking.

Cards expose a current public author or thread persona, true source/category and
own time, an original post summary up to 80 code points, original-text snippet
segments up to 240 code points, and a typed destination. They do not serialize
whole posts, media, discussion counts, private contacts, replied-to author details,
scores or totals. Snippet mapping preserves original text, expanding lowercase,
contextual sigma and complete astral characters. Native text nodes provide
highlighting without HTML.

## Privacy and navigation evidence

Three structural metadata sources merge into a query-independent 128-candidate
window plus one metadata-only sentinel. Hidden body changes do not influence
matching budgets, continuation coordinates or end decisions. Sparse results
remain `scan_pending` instead of claiming a complete empty result.

Guests searching all receive `effectiveTypes=['post']`; explicit child searches
require authentication before metadata or body traversal. Supplied invalid
credentials never become guest access. Current session and phone requirements
remain mandatory for continuation.

Posts retain `list_projection` semantics. Child hits require the existing parent
`direct_post` policy, then independent root and reply `list_projection` checks.
Anonymous parents do not bypass named-child proof. Deleted, hidden, held, revoked,
blocked and unknown-evidence parent chains are covered. Search never loads a
reply target's body or name. Unknown evidence remains unavailable, not an empty
page.

Metadata locks preserve the complete post/root/reply hierarchy before body use.
Current source and approval owners, mandatory final relationship proof, final
session/phone deadlines and cursor insertion share one read-committed transaction.
Tests cover actual waits, raw block insertion, review revocation and rollback
following successor creation. Opaque v3/v4 cursors bind query, all filters,
matcher/order versions, account/session and current federated membership.

Real native gateways execute through normal Nest HTTP and PostgreSQL for child
matches, exact typed destinations and fresh context. Native state tests and emitted
smokes cover type/date/topic filters, plain server snippets, fresh Previous/Next,
sparse continuation, scope/session/safety changes, stale responses and hide/reopen.
A now-inaccessible destination does not fall back to a cached snippet. Existing
detail/context limits are unchanged.

Independent review passed for the tested scope. Its date-boundary finding was
fixed by rejecting ISO year zero before PostgreSQL casts. Guard ancestry and
Unicode snippet mapping were reviewed without weakening visibility requirements.

## Initial failure and corrected regression

The first complete PostgreSQL run reported 1,128 passes and two failures in
825.588664152 seconds. Both reported failures came from one stale assertion and
its enclosing suite. That assertion expected a reply decoder to reject
`rootCommentId === reply.id`, although roots and replies use separate UUID
namespaces.

The correction was confined to the existing integration test. It now explicitly
accepts equal cross-kind UUIDs with an internally consistent comment target and
rejects a reply that targets itself as a reply. The same-kind target includes a
valid author shape, so the rejection tests the intended invariant. Wrong-ancestry
preview/context checks and private-field rejection cases remain unchanged.
No application code changed between the first and final aggregate.

The corrected discussion and discussion-search PostgreSQL suites then passed all
25 focused tests, with zero skips and complete cleanup. The source freeze was
refreshed, and the entire aggregate above was rerun successfully. This was a
correction to an obsolete cross-table inequality assertion, not a relaxation of a
security invariant.

## Measured cost remains unresolved

The final synthetic child fixture contains two parent posts, 1,300 roots and 1,300
replies. Each measurement returned 129 structural metadata rows before the
128-item authorization window:

- All child sources: 1,908.84 ms end-to-end, 8,166 SQL statements
- Root source: 1,408.99 ms, 5,798 SQL statements
- Reply source: 2,411.10 ms, 10,536 SQL statements
- Within one topic: 1,898.72 ms, 8,165 SQL statements

Candidate SQL itself took approximately 0.356–3.284 ms. The earlier focused fixture
also measured roughly 1.55–2.43 seconds and 5.8k–10.5k statements per request.
Removing full-thread projections has not removed the cost of per-item canonical
ancestry and approval checks. The 128-candidate limit does not bound physical
index work, total SQL statements or complete-corpus traversal.

The topic fixture used the existing root-topic and new reply-topic indexes;
small global child fixtures could choose sequential scans and sorting. No forced
plan, constant-work claim or production latency guarantee is made. Safe,
purpose-aware batch eligibility must be designed and verified as a separate
increment before indexed or semantic relevance. Production search performance is
not considered solved.

## Release boundary

Migration 0035 adds structural chronological and reply-topic indexes only. No
model, tokenizer, embedding service, external model provider, external model data
transmission or new dependency was introduced. No production deployment,
historical backfill, related-campus distribution, search history or hot
suggestions were added. The separate detail/context owners' existing 1,024 limits
are not removed. Physical WeChat rendering and production-scale behavior remain
unverified.
