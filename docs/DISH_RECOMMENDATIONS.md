# W2 bounded window dish recommendations

This local development slice adds reversible exact-name endorsements under the
existing Ratings/windows owner. It is separate from W1's mutable signed -10..10
scores, C1's immutable first-score tuples, C2's one-way comment likes and generic
1..5 ratings. No score, comment, image, reward, notice or public-profile side
effect is produced. Full Next, production catalog/history reconciliation,
provider activation and physical WeChat acceptance remain open.

## Grounding and deliberate Next decisions

The fixed source is WhaleUCampus/WhaleU
`57cf169c11123acf249909a1a7215b8cb1ec1f8e`,
[Window.php](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/controller/Window.php)
lines 669–823. It groups active rows by dish name, orders count descending then
name ascending, and returns only the actor's own `isRecommended`. Explicit add
reactivates an inactive actor/window/name row; adding an active row rejects.
Explicit remove deactivates without deleting; removing absent/inactive rejects.
There is no numeric-rating conversion or legacy Review call. Legacy specialist
native activation was not established at the fixed source.

The source's `mb_strlen` limit is ten, but its runtime encoding and actual
historical database collation are unavailable. Next deliberately specifies one
to ten well-formed Unicode code points, including astral emoji, rather than UTF-16
code units or graphemes. Blank-only strings and C0/C1 controls are rejected;
ordinary `0` is accepted. These are explicit hardening of legacy truthiness and
validation. Accepted names retain exact bytes, including valid surrounding
spaces, case, composed/decomposed accents and full-width characters. No trim,
casefold, NFC/NFKC, aliases or semantic deduplication is performed.

Native identity is the lowercase hex encoding of the complete UTF-8 name bytes.
SQL uses bytea equality and ordering; JS hex-string comparison has the same byte
order. The stable rule is visible endorsement count descending, then exact UTF-8
name bytes ascending. This is a new deterministic identity/order contract, not a
claim about legacy collation. An imported legacy row cannot be joined to native
ownership or a spelling variant without separately reconciled identities.

Fresh public reads and recommendations use current Identity session, verified
phone, Safety and accepted active window/floor/canteen/canonical Campus evidence.
No student number, affiliation, course-comment publication base, selected browsing
campus or administrator role is required. Consistent parent activity is Next
hardening beyond legacy list/mutation omissions.

## Independent history, visible counts and privacy

Migration 0115 adds immutable membership events, stable actor/window/name heads,
original command receipts and separate accepted history assertions for dish
population and actor membership. Catalog acceptance and W1 score history never
prove dish history. Only independently accepted-empty historical baselines plus
native events are supported here. Nonempty production history, actual legacy
collation, account/source crosswalks and import reconciliation remain unavailable.
There is no runtime importer, issuer or production seed.

Known native active/inactive membership survives unavailable wider history.
Absence is `not_recommended` only under current independent membership history;
otherwise it is `unavailable`. A source replacement or relabel preserves stable
window identities, every membership lineage and historical receipts. Counts are
visible endorsements, never proven distinct people or unique diners across dishes.

Review owns a new `window.dish.recommend.v1` purpose binding actor, original
request, stable window, catalog/window revisions, exact name and exact native
identity. Each fresh add/reactivation needs a new exact current decision. No live
Review provider or blanket allow is supplied; tests alone issue synthetic facts.
A contribution is visible only with current Review allow and current known Safety
allow. Explicit Review revocation or known Safety denial excludes that contribution
with negative proof; a healthy same-name contribution can remain. Unknown Review
or Safety that cannot be excluded by an independent known denial fails the list
closed. Its contribution never silently becomes zero. A private active membership
can still be known after losing public visibility and remains retractable.

The public list exposes name, native identity, exact visible count, and only this
actor's membership boolean/revision. No recommending actor IDs, author lists,
avatars, profiles or affiliation fields are emitted. Original receipts omit dish
text and expose only the actor-owned exact native identity and typed outcome.

The exact public scan supports at most 1,000 current active candidate memberships
per window, including denied candidates. 1,001 returns `DISH_BUDGET_UNAVAILABLE`;
counts and populations are never truncated. Page size is 1–50. Cursors bind
actor/session, full access and accepted topology, both independent histories,
membership epoch, Review epoch, Safety epoch and page size. Exact PostgreSQL
microsecond future boundaries cover the entire candidate ranking, including
off-page Review/Safety expiry, rather than only returned rows.

## Commands, closure and recovery

- GET `/v1/ratings/windows/:id/dishes`: exact visible page
- GET `/:id/dishes/my-membership?dishName=...`: actor-session-only own state
- POST `/:id/dishes/recommend` or `/:id/dishes/retract`
- GET `/v1/ratings/windows/dish-requests/:requestId`: original receipt
- POST `/dish-requests/:requestId/cancel`: same-key durable cancellation

Commands freeze original client request, exact name, source revisions and nullable
expected membership revision. `window.dish.recommend.v1` and
`window.dish.retract.v1` are distinct intents. An actor/request lock and an
actor/window/exact-byte-name lock cover first-add absence and existing lineages.
CAS is checked before active/inactive state. Fresh repeated active add or inactive
remove returns a durable explicit rejection. Competing new keys from the same
expected revision have one changing winner. Retraction leaves an inactive head;
re-add advances the same lineage without resetting revision or double counting.

Same key/same exact intent returns the immutable original outcome. Changed intent
conflicts. Old add replay after removal cannot reactivate, and old removal replay
after re-add cannot remove the new head. Cancellation is an original-command
fence, not a membership retraction. The original result wins if already committed;
a winning cancellation prevents a delayed original write.

Owner-only retraction, receipt lookup/replay and cancellation require a current
actor session but intentionally survive source, phone, Safety, Review and wider
history withdrawal. This reduction path grants no fresh-add authority. Existing
own membership returns historical source revisions for the frozen closure intent;
they are not current-publication authority. Retraction does not consume a new
positive Review. A missing own row still requires known membership history before
a durable absent-state rejection. Session loss never authorizes another actor to
recover or close the old actor's request.

Native W1 detail links to a new registered dish page. Input preserves exact names,
and own-membership lookup remains available when the public list fails. The page
persists and reads back account/origin-scoped original pending intent before
transport. Unknown outcomes block contradictory replacement. Restart uses
receipt-first recovery; cancellation intent persists before its transport.
Settled receipts are historical outcomes followed by a fresh own/public read.
Hide/back/unload, account/origin change and stale callbacks clear private state.

## Transaction proof boundary and acceptance gates

SQL statement and deferred guards enforce exact typed intent, Review/name/identity
parity, actor ownership, changing predecessor, atomic event/head/receipt, canonical
UTC millisecond timestamps and immutable history. Epochs and owner-table NOWAIT
fences protect managed final proof. The shared transaction wrapper flushes all
deferred waits, validates current owner facts and then checks exact PostgreSQL
deadlines. Arbitrary raw SQL callers can flush constraints early and wait again;
these guards do not claim to be an absolute COMMIT wall-clock hook.

Local tests use explicitly synthetic facts through ordinary AppModule/HTTP and
controlled disposable PostgreSQL 18.6. Emitted App/Page/WXML acceptance uses
production gateways with synthetic platform callbacks. This is not physical
WeChat/DevTools, live issuer/provider, hosted CI, nonempty production import or
production release acceptance. Window comments/replies/images, canteen/floor
scores, administration, rewards and notices remain separate later gates.
