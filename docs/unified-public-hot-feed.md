# Unified public hot feed

This slice adds `GET /v1/community/hot` and a native current-page hot screen. It
is disabled by default. No production activation is implied by installation.
The generated HTTP contract is [community-hot.json](openapi/community-hot.json).

## Population and ranking

- One explicit existing `spaceId`; regional supported post categories or global
  discussion. This is not the legacy related-campus/local/city topology.
- Only posts with all four independent, verified native publication baselines
  can rank. Missing or historical coverage is unknown, never zero. A complete
  known-zero native post becomes eligible after successful materialization.
- Formula v6 uses the pinned `pg18-numeric40-round4-v1` profile, exact decimal
  strings, PostgreSQL `numeric(24,4)` ordering, and UUID descending ties. Source
  interactions remain cumulative; there is no time decay or range-specific
  interaction cutoff. This does not claim PHP floating-point bit equivalence.
- The score is unified. An otherwise hidden actor's contribution can affect
  ordering; current list visibility and viewer-visible nested counts remain
  independently enforced. Raw inputs, certificates and numerical ranks are not
  public.
- Deleted, unapproved, urgent-trading and resolved-trading posts are excluded.
  No unrepresented water-post or general completion flag is inferred.

Ranges are rolling elapsed publication age: day 24 hours/cap 50, week 7 days/cap
200, month 30 days, half_year 180 days, year 365 days, history all ages (the last
four cap 1000). Age lower bounds are inclusive and future publications excluded.
History means all ages in the independently covered native population.

## Current certificates and live navigation

Materialization locks the post and subscription, like, comment, then view
states. It reuses the complete retained-source/receipt proof and atomically
replaces the internal certificate. Public reads repeat that proof under shared
state locks and compare the exact complete vector, identity and formula/profile.
An accepted view or unresolved source makes a previously current certificate
ineligible. Neither a recent timestamp nor matching processed/source maxima
alone proves currency. Public reads never settle, enroll, refresh or compute.

Reads inspect at most 128 structural candidates plus one metadata-only lookahead.
Current visibility, canonical review, session and phone deadlines, and the final
relationship proof still apply. Existing serialization rejects more than 1024
candidate roots or visible replies rather than substituting raw heat counters.

Opaque random cursor tokens refer only to private navigation metadata. They bind
space, range, limit, policy, formula/profile and the current account/session. The
last visible guard checks current scope/age/visibility but deliberately ignores
score changes. Moving scores can cause repeats or omissions across pages. Caps
count delivered slots, not distinct identities; refresh resets traversal. A
filtered bounded batch may return `scan_pending`. Guest first pages do not issue
continuation cursors; continued reads need a current session and verified phone.

## Processing controls

`HOT_FEED_PROCESSING=disabled|manual_only|automatic` defaults to `disabled`.
Automatic mode requires all three settings below to be explicitly `automatic`:

- `SUBSCRIPTION_COMPONENT_PROCESSING`
- `LIKE_COMPONENT_PROCESSING`
- `COMMENT_COMPONENT_PROCESSING`

Incoherent automatic configuration fails at startup. Only the explicit HTTP
runtime mounts the official hot runner, and only in automatic mode. It uses a
5-second interval, at most 20 attempted posts, 50 component transactions and 20
refreshes per cycle. Its 4-second admission window checks between operations;
each in-flight transaction retains a 5-second hard database timeout, 1.5-second
statement timeout and 0.5-second lock timeout. These are safety bounds, not
production throughput claims.

Each component processes at most one earliest unresolved source per post per
round in its own transaction. Parent locks precede component/source effect locks.
The selector never claims scheduler rows first. The final scheduling-only update
acquires no domain locks, so a stuck parent can still receive backoff. Saturated
frontiers leave unattempted rows untouched for earlier priority next cycle.
Shutdown stops admission and drains in-flight work before the pool closes.

`manual_only` allows current-certificate reads for local development acceptance,
without timers or continuously maintained ranking. For a bounded selected local
round, use:

```sh
npm run hot-feed:process -- --post-id=<uuid> [--post-id=<uuid> ...]
```

The command preserves URL, actual loopback connection and disposable database
guards. It requires hot-feed and component modes to permit manual processing;
its inherited automatic settings are converted to manual-only while every
background dispatcher is disabled. Repeating the same selection uses persisted
fairness order. It may enroll only existing, fully validated independent native
baselines; it cannot reconstruct history. Other manual commands disable this
runner too. The older local internal-score CLI remains separate and unchanged.

## Deferred and verification limits

Historical import/reconciliation, related-campus distribution, legacy local/city
equivalence, a home ticker/search hot suggestions, legacy swiper/scroll state,
20-card native pages, and inline interaction controls are not included. No public
response cache, per-viewer ranking snapshot, new actor ledger, dependency,
experience award or received-total adjustment is added. Production query-plan/
load measurement, hosted exact-commit checks, activation and real WeChat device
acceptance are separate work.

## Trust and operator limits

Certificate arithmetic and accepted view aggregates retain their trusted database/
application-owner boundary. Current-vector locking prevents torn reads but does
not prove every privileged direct SQL counter increment originated in a retained
view receipt. No permanent browsing ledger is added to claim that stronger proof.
Manual selected-post bootstrap fails fast on a parent-lock or database error before
later selections; automatic scheduling has separate retry isolation and fairness.
