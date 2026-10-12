# W1 specialist window ratings

Bounded local slice: accepted canteen/floor/window metadata, window directory and
detail, mutable integer scores from -10 through 10, private own-score CAS and
original-request recovery. This does not complete the Next rewrite. Production
catalog/history import, canonical crosswalk acceptance, issuers and physical
WeChat acceptance are unavailable. No production data or provider is used.

## Grounded source and intentional changes

The source baseline is WhaleUCampus/WhaleU commit
`57cf169c11123acf249909a1a7215b8cb1ec1f8e`:
[Window.php](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/controller/Window.php)
and [Canteen.php](https://github.com/WhaleUCampus/WhaleU/blob/57cf169c11123acf249909a1a7215b8cb1ec1f8e/treehole/app/controller/Canteen.php).
The controller supports active parent/window listing, exact canteen filters,
strictly positive minimum rating, signed mutable scores and numeric one-decimal
means. Floors are raw source identities, not assumed integers from 1 to N. The
legacy registered native specialist journey is not established; the Next pages
implement the controller business capability as newly registered native routes.

Fresh Next reads and writes require a current Identity session, verified phone
and current Safety. There is no course-comment verified-base, student-number,
affiliation, matching-school, browsing-campus or administrator requirement.
Strict actual finite integers close legacy `intval` coercion. Consistent current
active parent/floor/window topology closes legacy detail/score parent omissions.
CAS, immutable events/receipts, durable cancellation and stable ID tie ordering
are explicit Next hardening, not claimed existing source behavior.

## Source and independent history

Migration 0114 adds dedicated storage under the existing Ratings owner, separate
from generic 1–5 targets and C1 three-axis first-lifetime tuples. Stable accepted
source namespace/canteen/window keys and parent-specific raw floor keys survive
snapshot replacement. An explicit independently accepted campus mapping reference
binds a canteen to canonical Campus; neither a school guess nor account preference
is authority. Metadata snapshots are assembled before a serialized acceptance
seal. Accepted canteen/floor metadata is bounded to 100 canteens and 100 floors
per canteen; directory windows use bounded pages.

An accepted catalog never declares old score history empty. An independent
history assertion is required to show a known aggregate or accept a fresh score.
Only separately accepted-empty legacy baselines plus native events are supported;
real nonempty history requires a later reconciled import. Tests alone issue
explicit synthetic fixtures. Unknown/expired history returns unavailable even
when local events exist. An existing private own head remains known; absence
means not submitted only under known history. Replacement catalogs never reset
ownership or population.

## API and ordering

- GET `/v1/ratings/windows/catalog`: accepted active canteens and raw floor labels
- GET `/v1/ratings/windows`: `canteenIds` (up to 20 UUIDs), `floorId`, `minRating`,
  `limit` (1–50), opaque `cursor`
- GET `/:id`, `/:id/my-score`, `/:id/summary`
- POST `/:id/score`: `clientRequestId`, `expectedCatalogRevision`,
  `expectedWindowRevision`, nullable `expectedOwnScoreRevision`, integer `score`
- GET `/requests/:requestId`: historical actor-owned original receipt
- POST `/requests/:requestId/cancel`: original `{windowId, command}`

`minRating` applies only above zero. Zero and negative values never exclude
negative ratings. Known nonempty means sort descending, then ratingCount
descending, then stable window ID ascending. Known-empty rows follow scored rows;
unknown rows follow known-empty. This explicit unknown placement never fabricates
zero. Aggregation uses `round(avg(score)::numeric,1)` over current heads; -0.25
rounds to -0.3. A real zero remains distinct from null empty means and unavailable
history. ratingCount is a count of current accepted score heads, never a claim of
reconciled legacy people/diners. There is no mixed floor/canteen/comment aggregate.

Cursors bind actor/session, access facts, accepted topology and canonical mapping,
full mutation epoch, filters and limit. Earliest future history transitions across
the whole candidate population are bound as PostgreSQL timestamp text, retaining
microseconds. Off-page score/history changes and expiry force restart rather than
silently reorder or duplicate continuation items.

## Mutation, recovery and precise proof boundary

`window.score.set.v1` serializes actor/request and actor/window, including the
absent-head case. Nullable own revision is compared before score equality. Two
new keys with the same expected revision have one changing winner and a durable
causal conflict. Exact same score/current revision yields a typed noop. Stale
same-score requests cannot bypass CAS. Changing events are immutable and maintain
one current actor/window head without increasing the population on replacement.

Original typed receipts are immutable. Same key/same intent and owner-only receipt
lookup survive catalog withdrawal and later phone/Safety loss under a current
session. Old success replay never rewinds a newer head. Cancellation commits a
same-key fence before a delayed write and returns the original receipt if it
already won. Unknown fresh source/history never fabricates a terminal conflict.

Raw SQL statement/deferred guards bind strict UUID/intent shape, exact integer,
current source/history/Identity/phone/Safety, actual predecessor transition,
transaction identity, head/event/receipt and canonical UTC millisecond receipt
timestamps. Complete final NOWAIT owner-table fences plus registered exact SQL
deadlines protect managed API transactions after all waits. SQL guards linearize
at their execution: they are not an arbitrary raw transaction COMMIT-clock hook
when a caller explicitly flushes deferred constraints and then does more work.
This limitation is stated rather than claiming absolute clock atomicity.

## Native and remaining gates

New list/detail pages are reachable from Ratings. Native editing exposes all 21
integers, including an explicit zero choice, and requires confirmation. Before
transport it freezes account, origin, original key, target, revisions and score,
persists them and reads them back. Pending uncertainty blocks replacement; restart
uses receipt-first recovery. Cancellation intent persists before cancellation
transport. Hide/back, login/account/origin changes and late callbacks clear private
state. An old applied/noop receipt is historical outcome, followed by a fresh
current detail read. It does not become the current displayed score by itself.

W2 dish endorsements are now a separate bounded [contract](DISH_RECOMMENDATIONS.md).
W3 named text roots/replies, reversible likes and local notices now have a separate
[bounded contract](WINDOW_DISCUSSION.md). Canteen/floor score writes, Window
images/image-only discussion, accepted creator-notice mapping,
admin/catalog workflows, rewards and mixed-population aggregates remain
explicit separate gates. There is no production activation endpoint or fabricated
seed. Local emitted App/Page/WXML → production gateway → loopback AppModule →
PostgreSQL acceptance is distinct from physical devices, hosted CI and migration.
