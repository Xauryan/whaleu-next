# Local post subscription component

This internal development slice consumes only the `save_ranking` obligations
created by saved-post transitions. It maintains one input needed by future post
hotness. It does not implement a complete score, hot feed, search, exposure
tracking, user experience ranking or received-interaction totals. No new public
count or native page is added.

## Fresh provenance and unknown history

A successful fresh native publication enrolls its post in the same transaction,
after its created receipt and native publication origin exist. Database proof binds
that enrollment to the exact newly created post, owner and publication request.
The opening subscription count is zero because no saved epoch can precede that
creation transaction. Rejected publication, a rolled-back hook and immutable
publication replay cannot create duplicate enrollment.

Every preexisting post remains unknown, including older native publications.
Reads and workers cannot adopt it, reconstruct its history from current relations,
or infer zero from absent rows. Existing pending obligations remain pending; no historical status is reset. There is no import,
backfill, administrator repair or historical cutover path in this slice.

Known baseline and processing freshness are separate. Component state describes
its processed causal prefix; later pending transitions can make it behind current
relations. It is not a live complete hot score merely because a baseline exists.

## Source, effect and acknowledgement

Actual saved-epoch creation and one-way ending enroll positive and negative
transitions for known posts. The epoch's original creation stamp cannot prove a
later unsave; negative source provenance belongs to the actual ending transaction.
Deferred checks require the exact existing `save_ranking` obligation and its
matching source event. Malformed or incomplete pairs cannot commit.

Each application transaction handles one selected obligation for one post. It
locks the parent before component state, membership and obligation, preserving the
saved-post writer order. Numeric causal sequence, not timestamps or UUID sorting,
determines the next applicable source. A selected later transition stays blocked
until its predecessor completes. A bad or unknown post does not stop independently
selected work for another post.

The applied per-actor membership must match the exact epoch. Save adds one;
unsave subtracts one only from its active applied epoch. Counts are never clamped
to disguise an out-of-order negative. Save, unsave and re-save replay as 1, 0, 1,
even if the positive source epoch has already ended by processing time. Self-save
contributes to this post component independently of experience reward exclusions.

Immutable receipts, exact state/membership effects and obligation completion
commit atomically. Lost responses and repeated workers cannot apply an effect
twice. A failed transaction leaves the obligation pending. Only `save_ranking`
may complete through this consumer; `author_interactions`, rewards, experience and
other component obligations retain their separate owners and state.

Hidden or deleted posts still retain causal component maintenance. That does not
make them publicly readable or eligible for any future feed. Source accounting
and public visibility remain separate.

## Explicit local CLI

`SUBSCRIPTION_COMPONENT_PROCESSING` accepts `manual_only` (default) or `disabled`.
There is no automatic mode, dispatcher or startup backlog processing. This setting
does not turn source history into a verified baseline.

The root `subscriptions:process` script forwards to the API CLI. Dry-run is the
default; apply must be explicit. Supply repeated `--obligation-id=<uuid>` arguments,
with at most 50 unique IDs. Apply without a selection is rejected. There is no
`--all`, production option or import flag.

The command requires a local disposable development/test database and checks the
actual connection before selected work. Production mode and remote destinations
are rejected. Starting the CLI disables unrelated update, jury and experience
processors, including inherited automatic settings. It never runs migrations.

Dry-run starts each inspection transaction read-only before any SQL that could
write. It creates no claims, statuses, receipts, source sequences or effects and
uses no mutation-oriented locks. Its result is advisory and is revalidated during
apply. An empty dry-run does not imply that the entire backlog was inspected.

The sanitized summary distinguishes applied, already completed, unknown baseline,
blocked predecessor, unavailable source, missing, pending and failed selections.
Inspect these counts; completion of the bounded command does not mean every
selected obligation was applied. No post bodies, author identifiers, credentials
or connection strings are printed.

## Operational boundary

This is a future-native-post, manual, local component implementation. Historical
coverage and production processing remain unavailable. Full hotness requires
separately proved view, like and comment inputs, effective formula configuration,
freshness policy and safe read composition. No missing input is silently set to
zero to present a partial ranking as a completed hot feed. The user's separate
received-interaction deletion-policy decision is unaffected.

Causal-head queries currently search retained sources for the earliest missing
receipt. Work can grow with processed history despite the 50-selection command
bound. No production throughput or fixed physical-query-work bound is claimed.
