# Independent canteen-floor scalar scores

This bounded Next slice adds accepted raw-floor selection, private own active
scalar scores, floor-only summaries and original-request recovery. Migration
0120 seeds no source, import, account, privilege or provider. Production floor
history remains unavailable until independently reconciled and accepted.

## Source grounding and explicit hardening

Source: [Canteen.php at 57cf169c](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/controller/Canteen.php#L415-L481).
The handler accepts a rating between 1 and 5 without an integer cast, half-step
rule or established storage precision. Duplicate lookup checks exact
canteen/user/raw-floor plus active status. It is one active score, not lifetime
participation; no user update/delete/clear or rating-retirement handler is evidenced.

Next uses a strict finite JSON number in [1,5]. Its explicit new numeric codec is
ECMAScript binary64 with the shortest JSON round-trip decimal, stored unchanged
in PostgreSQL numeric. SQL rejects decimals that do not round-trip through that
codec and normalizes numeric trailing zeros for command hashing. This preserves
1.25, 4.75, Math.PI and representable adjacent fractions without inventing an
integer, half-step or historical precision claim. Legacy DDL/precision is unknown.

Current session, verified phone, Safety and accepted active canteen/floor/canonical
campus mapping are required for fresh reads/writes. Student number, affiliation,
course verified-base, matching-school, browsing-campus and admin are not required.
This fail-closed admission, active topology validation, serialized one-winner
concurrency, immutable typed receipts and durable cancellation are Next hardening.

## Identity, history and active population

W1 stable source canteen identities and parent-specific raw floor keys are reused.
No 1…N floor assumption or child Window existence is required. Sealed accepted
catalog revision plus canteen revision binds the floor snapshot; catalog replacement
never resets history, ownership or population. Floor score tables, epoch and
history assertions are independent of Window scores, dishes and discussion.

An immutable publication ledger has no lifetime actor/floor uniqueness constraint.
A separate unique actor/floor active head selects current participation. Native
publication can only create a head when none exists; no edit, deletion, retirement
or inactive-record import is offered. Existing active score rejects every new key,
including an equal score. Future inactive legacy reconciliation remains a separate
gate and must not be simulated by fabricating a retirement operation here.

Only independently accepted-empty historical baselines plus native publications
are supported. Accepted topology and Window history never prove floor history.
Unknown, future or expired floor history gives unavailable aggregate coverage and
unavailable own absence. An existing exact own active record remains known.
Historical receipts are actor-private and require a current session, independent
of later source withdrawal or phone/Safety loss; they do not establish current state.

Floor summary counts active score records and computes round(avg(score),1) in
PostgreSQL numeric. Proven empty is ratingCount 0 with mean null, distinct from
unavailable. Counts are records, never unique people/diners. No Window signed
−10..10 score, generic rating, dish endorsement or comment/reply enters that
population. Whole-canteen cached means and mixed parent list summaries are deferred.

## HTTP, SQL proof and native recovery

Routes under /v1/ratings/canteen-floors:

- GET /catalog: accepted active canteens and raw floors, bounded by W1 seal
- GET /:id, /:id/my-score, /:id/summary: current proven projection
- POST /:id/first-score: clientRequestId, expectedCatalogRevision,
  expectedCanteenRevision, score
- GET /requests/:id: original actor-owned floor.score.first.v1 receipt
- POST /requests/:id/cancel: original floorId and unchanged command

Same key/intent returns its immutable applied or rejected receipt; changed intent
conflicts. Cancellation commits a fence before delayed transport, or returns the
publication if it already won. It never deletes a published score. Missing receipts
and unavailable source/history never fabricate terminal failure or permit a new key.

SQL strict statement/deferred guards bind original intent, binary64 scalar,
transaction identity, source/history, exact UTC millisecond time, publication,
active head and receipt. Managed transactions flush all deferred waits before
bounded NOWAIT final owner fences and exact PostgreSQL deadlines. Raw SQL guards
linearize when they execute, not at arbitrary later COMMIT after early constraint
flushing. This is not an absolute COMMIT-clock guarantee.

New registered native selector/detail pages are reachable from Ratings. Decimal
input, explicit confirmation and current own-state blockers precede publication.
Account/origin/key/target/revisions/score are frozen, persisted and read back before
transport. Pending uncertainty blocks replacement. Receipt-first restart and
persisted cancellation phase preserve intent. Hide/back, app hide, login/account
changes and late callbacks clear private presentation. Historical recovery is
followed by a separate fresh current read.

## Acceptance and remaining gates

Synthetic emitted App/Page/WXML calls the production gateway through real HTTP to
ordinary Nest AppModule and disposable PostgreSQL. Only native platform callbacks
and source acceptance facts are simulated. Dedicated tests cover decimals,
concurrent first publication/cancellation, original receipt recovery, raw causal
counterexamples, exact history transitions, source withdrawal/remapping, every
current eligibility deadline after deferred waits, zero-window floors and Window
aggregate isolation. This is not physical WeChat/device, live-provider, hosted CI
or production acceptance. Exact aggregate performance at representative production
population and load remains unaccepted.

Optional comment/images on the legacy floor-rating row are explicitly deferred;
there is no evidence for inventing separate floor discussion/reply/like features.
Historical storage precision/default status/constraints, inactive/deleted semantics,
duplicate records, actor/campus/raw-floor crosswalks, orphan/removed floors,
nonempty history, exact Review/Media binding and legacy native route activation
remain unverified. Existing generic Ratings and W1/W2/W3 remain separate domains.
