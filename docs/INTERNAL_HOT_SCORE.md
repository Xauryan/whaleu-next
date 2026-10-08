# Internal selected-post hot-score computation

This development slice composes existing view/like/subscription/comment owners
into a consistent internal snapshot and evaluates a named numeric profile. It is
disabled by default and has no HTTP route, public field, native UI, ranking,
materialized score, cache, scheduler or new database schema.

## Formula and numeric identity

The pinned checked-in source formula version is 6. This is repository metadata,
not verified deployed activation or effective production configuration.

- E = min(eligible comments, unique eligible accounts × 3)
- Support = max(min(1, sqrt(views / 200)), min(1, sqrt(post likes / 10)))
- Score = round4(7.6 × views^0.4 + 24 × ln(1 + post likes) +
  support × (10 × ln(1 + E) + 2 × ln(1 + subscriptions)))

The comment cap is aggregate, not a sum of per-user caps. Post-author contributions
are excluded from eligible/unique inputs; named/anonymous modes retain one real
account identity internally. Live replies under deleted roots retain internal
contributions. Self-like/save/accepted-view inputs count. There is no time decay;
comments and saves alone contribute nothing when both support inputs are zero.

The rewrite profile is `pg18-numeric40-round4-v1`: exact integer strings, numeric
casts before integer additions/cap multiplication/division, PostgreSQL natural
ln/power/sqrt with explicit working scale, and one final numeric half-away-from-
zero round to four decimals. Output is a fixed-scale decimal string, never a JS
Number. The formula and SQL expression have separate fingerprints.

This avoids unsafe bigint-to-Number conversion but is not proven bit-identical to
PHP floating-point transcendental evaluation. Decimal transcendental operations
also approximate real values. No arbitrary epsilon or approximate ranking tie
rule is introduced. The internal profile does not approve a public sorting policy.

## Coverage, freshness and snapshot

Every component needs its independent fresh baseline with matching post/author/
native-publication evidence. Unknown is not zero. Like, subscription and comment
capture must be fully settled to their own source heads with valid receipts;
independent head numbers are never compared as one universal sequence. Views are
synchronous accepted aggregates, excluding not-yet-reported or lost observations.

Compute locks the selected parent first, then subscription, like, comment and view
state rows in that order, and captures one final statement snapshot under READ
COMMITTED. It checks baseline identities, exact terminal state/receipt bindings,
source history, unresolved work and subscription obligation pairing. Missing
coverage or backlog yields no score. Computation never settles backlog, changes
obligations, enrolls history or writes a receipt.

View-state locking closes a direct-increment snapshot race that parent-only
locking would miss. It does not independently prove arbitrary direct SQL view
increments came from accepted reporting receipts: the view owner intentionally
has no permanent per-post event ledger. Input integrity retains that trusted-owner
boundary. Any result can become stale after locks are released.

## Execution and limits

Use `HOT_SCORE_COMPUTATION=manual_only` and
`npm run hot-score:compute -- compute --post-id=UUID` for explicit locked local
computation. The default is advisory dry-run. Compute accepts 1–50 distinct
selected posts, checks local URL/socket/actual dedicated database, and disables
all unrelated processors including view-retention scheduling. No production,
all-post, import, repair or auto-processing option is added.

Dry-run starts a READ ONLY transaction without mutation-oriented locks and cannot
claim the stronger locked snapshot. Compute takes locks in an ordinary
read-write transaction but makes no data, sequence, source or receipt writes.
Output is a sanitized category summary; no body, actor membership, token or public
link is exposed.

Retained source/receipt history inspection can grow with history. Selection bounds
are not physical SQL-work or throughput guarantees. Existing component constraints
also limit which extreme synthetic count combinations can actually be stored;
evaluator-range tests do not fabricate representable database states.

Public ranking still needs an explicit policy for hidden/blocked contributions,
historical population and freshness, deterministic ties, pagination, cache and
final visibility. An omitted score field does not eliminate observable ordering
leaks. This slice makes no author received-like/save policy decision. See
[acceptance](acceptance/internal-hot-score.md).

## Later public composition

A separate [unified hot-feed owner](unified-public-hot-feed.md) now composes these
primitives under the unified-score/current-visibility policy, with its own current
certificates and live-pagination contract. This original local computation command
remains disabled-by-default, local-only and nonmaterializing; it is not mounted as
a public service or used to bypass its own guards.
