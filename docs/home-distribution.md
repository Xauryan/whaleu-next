# Home distribution boundaries

This implementation consumes the immutable V7 Home publication disposition. It
does not make the post private and does not change content visibility.

## Historical publication facts, not live access authority

`home_post_dispositions` binds the approved Home evidence, decision digest and
publication transaction to the canonical post. The read owner validates that
binding with `home_post_disposition_valid(post_id)`. It obtains the original
account from the stored post, never from a rendered author, anonymous persona,
request query parameter or client exemption.

The accepted admission definition is selected by the exact admission ID,
revision and digest in the immutable evidence. Its historical `surfaces` policy
remains effective after that admission expires or the operator changes the
current admission head. Expiration must never widen an existing audience.

Requested intent, effective category/space and Home restriction are separate
publication facts. Current Review, Safety, owner visibility, current category,
scope, relationship and media authorization continue to be checked by their
existing owners. The distribution gate cannot grant access on its own.

## Surface semantics

For a bound `short_text` or `reference_only` result:

- Home and the Home pin list are original-author-only, including anonymous posts.
- Hot always excludes the **current** water category, even for the author. For
  the explicit admitted `exclude_water` mode, a later authorized move out of
  water still requires the original author and all ordinary hot eligibility.
  The admitted `disabled` mode excludes a restricted post from hot entirely.
  This opt-out is new operator policy, not a claim about legacy behavior.
- Following has explicitly admitted new semantics. `excluded` excludes the
  restricted post. `named_only_author_filter` requires a named post and the
  actual original author as viewer. Existing follow/profile rules still apply;
  the Home gate neither creates a self-follow nor bypasses a missing edge.
- Official article selection, inspection and projection reject restricted
  posts. Related-campus distribution rejects them even for the author.

An ordinary `result: null` adds no restriction. Historical posts without a Home
disposition retain their existing behavior. A missing or invalid disposition on
a V7 post is unavailable, never historical unrestricted fallback. Hot's current
water exclusion applies independently of the disposition result.

Direct detail, public profiles, search, saved posts and references do not consume
the Home author-only gate. Remote related-campus inclusion is still independently
governed by the related-sync owner. Pin slot occupancy, management and direct pin
detail are unchanged: hiding a pin from a list does not free its slot.

No original account identity or Home evidence is added to public response DTOs.

## Query and lifecycle boundaries

Candidate SQL excludes restricted audience rows before the existing feed/hot/pin
or Official selection limits. It uses exact indexed post/disposition/admission
identities and remains a structural optimization, not an access proof. Hot adds
one exact category-head lookup rather than expanding the full classification
union over the score population.

Surviving rows are checked again from canonical facts, including hot cached
candidates and the previous visible continuation guard. Reads are batched at
256 post IDs, with at most 2,048 initial canonical fact reads in one managed
transaction, cumulative across batches and optional rollback. Repeated cached
checks do not consume work; reads after rollback do. Final V7 rechecks have their
own unchanged 500 ms owner / 100 ms query limits. A reused client starts a new
budget only with a new managed transaction lifetime.
There is no query per row after a candidate window is prepared. Cached evidence
is tied to the managed transaction read epoch and invalidates on optional
rollback or reused `PoolClient`. A bounded final owner proof uses nonblocking
fences and rechecks retained V7 facts before return/commit. Historical rows with
no disposition do not add a Home final table lock or repeated proof read:
migration 0061 freezes their publication version, and the 0178 metadata guard
only permits insertion in the original creation transaction with exact V7
completion. Historical absence cannot later become a Home disposition.

The existing 32-row Home scan, 1,024-row Home ceiling, 128+1 hot window, and
Official selection limits remain unchanged.

## Actual consumers and verification limits

The implemented native consumers are `FeedService`, `HotRepository` and
`HotFeedService`, `PostPinsService.list`, `CommunityDistributionService`,
`OfficialSourceSelector`, `CommunityOfficialSource`, and
`CommunityOfficialPublicProjection`.

There is no native pull/group-post external push endpoint or provider in this
baseline. No placeholder provider or claimed delivery integration is added.
Future such consumers must consume the same immutable suppression owner.

Focused tests exercise actual consumer methods and inspect their emitted SQL,
with deterministic query fixtures. They cover anonymous ownership, paging,
Following modes, hot water/moved/disabled behavior, cached continuation guards,
occupied hidden pins, Official projection rejection, bounded batching, epoch
rollback, stale final facts, and nonblocking fence failures.

The independent `test/integration/home-distribution-read.test.ts` also passed
10/10 on fresh disposable PostgreSQL 18.6 on 2026-10-22. Its real HTTP Review and
publication flow creates 8 V6 and 28 V7 posts, then runs actual Feed, Following,
Hot, pin, Official and related-sync owners with their mandatory final checks.
It also verifies global-to-regional intent/origin preservation and unmapped
origin rejection, final busy-fence failure, and actual SQL rejection of legacy
version conversion, late Home metadata insertion and V7 downgrade. These are
the tested premises for omitting only the legacy Home final fence; existing
content/Review owners still execute.

In that small fixture, the 32-row candidate EXPLAIN execution was 2.505 ms.
The separate mixed 36-row Home read plus final proof used 10 queries and took
61.24 ms; its 28-row V7 final read took 28.98 ms under unchanged 100/500 ms limits.
These are observed fixture timings, not production latency guarantees. The
EXPLAIN proof sample was a six-row historical page, not a V7 stress benchmark.
The test changes the current admission head, but does not wait for historical
admission expiry. Water move-out remains a unit-level future-eligibility case,
not proof that the current reclassification operator admits water. Official
selection SQL is covered by focused consumer tests; real PG coverage exercises
inspection and both projection boundaries, not an external push provider.
