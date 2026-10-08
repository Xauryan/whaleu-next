# Public profiles and own discovery

This development increment adds named author pages and privacy-consistent public
post/trading discovery. It is part of the greenfield rewrite, not a provider
activation, production import or claim of complete profile/experience parity.
Public identifiers, current policy and canonical community serializers replace
unsafe raw account/content projections.

## Routes and exact public states

- `GET /v1/profiles/:profileId`: optional authentication; current basics and independently available counts
- `GET /v1/profiles/:profileId/posts?limit=20&cursor=...`
- `GET /v1/profiles/:profileId/trading?limit=20&cursor=...&tradingSubtype=qiugou`
- `GET /v1/me/public-profile-ref`: active authentication; exactly `{profileId}`

Every profile selector is the existing public profile UUID. Account UUIDs,
student numbers, provider subjects, anonymous personas and private developer
facts are not alternate selectors. The own reference is null when no profile row
exists. Reads never create a profile or ID. Existing profile/preference/campus
writes and named publication retain their existing initialization behavior;
there is no new public-profile opt-in or enable step. The public ID remains stable
across display and campus updates.

Queries and GET bodies reject unexpected fields, repeated parameters and private
owner selectors. Public reads accept either no token (guest) or a valid active
session; a malformed, expired, revoked or blocked-account token never downgrades
to guest. Both guests and active phone-unverified accounts can continue profile
pages. This intentionally normalizes inconsistent source middleware behavior;
the ordinary feed's continuation gate is not inherited. No student, affiliation,
selected identity campus or browsing campus is required for these reads.

All responses are `Cache-Control: no-store`, varying on Authorization. Standard
safe error envelopes apply. A missing dependency fails unavailable; it does not
become an empty success.

Available basics have exactly:

```json
{
  "status": "available",
  "profileId": "11111111-1111-4111-8111-111111111111",
  "isOwn": false,
  "displayName": "Example",
  "bio": "",
  "avatar": null,
  "affiliation": null,
  "publicUid": null,
  "experienceDisplay": {
    "title": { "status": "known", "value": null },
    "color": { "status": "known", "value": null },
    "level": { "status": "known", "value": 1 }
  },
  "totalInteractions": null,
  "totalInteractionsStatus": "unavailable",
  "postsHidden": false,
  "postCount": 0,
  "postCountStatus": "known",
  "tradeCount": 0,
  "tradeCountStatus": "known"
}
```

The example identifier and known-new-account display are synthetic. Public
experience has independent title/color/level evidence: a proven selected undated
title can be known while level is unavailable; a retained high color is not level
proof. Known null selection differs from unavailable evidence. No grant date,
balance, source history, owner ID or appearance receipt/revision is public. See
[the public experience projection](API_EXPERIENCE.md#public-experience-projection).

Avatar, affiliation and public UID remain explicitly unavailable. A selected
browsing campus, student number or displayed level cannot supply those facts.
Legacy public UID is school-scoped, distinct from both private student identity
and the globally routed public profile UUID.
`totalInteractions` retains the intended received “获赞与码住” display slot. Source
updates include unlike/unsave reductions, but live and rebuilt accounting disagree
on deleted contributions and some anonymous/child cases. Its accounting owner and
reconciliation remain unfinished. It is null, not zero, never a lifetime-ever
counter or a total derived from currently visible profile lists.

Other basic/list states are minimal and exact:

- `{status:'unavailable',profileId}` for missing/inactive targets or incoming-only
  blocks. No actor, direction flag, nickname, count or hidden preference is exposed
- `{status:'blocked_by_you',profileId,relationship:{relationshipId,blocked:true,revision}}`
  for the viewer's current outgoing block. The opaque owner relationship enables
  existing revision-checked unblock; no underlying target account ID is returned

An available list is exactly
`{status:'available',profileId,items:PostView[],total,totalStatus,continuation,nextCursor}`. Its items are
ordinary canonical post projections, including safe poll/formation/trade metadata.
Chosen trading contacts, contact fallbacks and privileged identity overlays are
absent. A privacy-hidden list is exactly
`{status:'hidden',profileId,items:[],total:0,totalStatus:'known',continuation:'end',nextCursor:null}`. Empty available and
hidden/unavailable states are different.

## Privacy and block policy

`hideProfilePosts` suppresses both public lists and both counts for guests and
other accounts, preserving basic nickname/bio. It does not hide ordinary feed or
direct-post access. Self bypasses this preference but still sees only the public
named eligible set; own recovery history remains separate.

Either block direction suppresses the named public profile and lists. Outgoing
owners receive only their safe relationship reference; incoming denial is generic.
Ordinary feed projections remain outgoing-block-only, and ordinary direct named
posts/contacts remain bilateral. Anonymous subjects never consult the underlying
named account relationship and cannot navigate to a named profile, even for self.

The existing `PUT /v1/me/safety/blocks` accepts
`{clientRequestId,source:{kind:'profile',id:profileId},blocked:true}`. It resolves
current public source availability through the profile and identity owners and
uses the dedicated safety profile policy. Self, inactive, missing and currently
inaccessible profile sources reject with `BLOCK_TARGET_NOT_ALLOWED`. Existing
phone-only eligibility, request idempotency, immutable receipts, revisions,
unknown-result recovery and source-independent owner cleanup remain unchanged.
A profile source does not expand report or privileged identity target domains.

## Eligible sets and pagination

The deliberate reconciliation of inconsistent source count/list predicates is:

- Posts: named, currently approved, nondeleted, active scope, non-trading user
  categories. The current category model has no system category
- Trading: the same conditions plus trading category and currently open resolution;
  both normal and urgent listings are included
- A subtype query exactly matches the existing canonical trading subtype enum;
  absent means all, and `qiugou` means wanted. Historical unknown subtypes remain
  explicit canonical legacy-text projections in the unfiltered list
- Resolved trading remains in own history and direct detail with contacts denied.
  Resolution neither deletes content nor changes urgency or chosen stored contacts
- No synthetic resolved state is added to non-trading posts

The community owner scans at most 128 candidate positions per call, querying and
locking at most 129 candidates plus a prior visible guard in deterministic post-ID
order. An index-backed `(published_at DESC,id DESC)` keyset makes every forward
scan advance without a source-history date or reachable-page cutoff. A second
bounded read after locking rejects an unstable newly introduced target rather
than projecting an unlocked row. Only requested visible items are serialized.
Nested canonical serializers retain their independent bounded checks.

Counts are separate from list availability. `postCount`/`tradeCount` and list
`total` are `number|null`, paired respectively with `postCountStatus`,
`tradeCountStatus` and `totalStatus` (`known|unavailable`). Known is an exact current
policy-filtered value. Null is never zero, a partial sum or an unfiltered estimate.
Basic and list counts use complete indexed streaming with 256-candidate canonical
owner batches. List totals apply the exact requested trading subtype and can be
known on continuation pages without controlling page navigation. Every candidate
passes current canonical visibility before listing resolution/subtype filtering.
There is no 1,024-row ceiling on the streaming path.

The normal optional attempt has a 2,000 ms monotonic work budget, at most two
concurrent scans/final recounts per application instance, with at least one
configured pool connection reserved for mandatory work. A one-connection pool
skips optional counting. Each source statement is limited to the lesser of
100 ms and the remaining attempt budget; a 4 MiB reconstructed wire-payload limit applies per batch. Source reads are nonlocking;
retained proof metadata is fixed in size. All statements use explicit READ
COMMITTED. Source-owner mutation epochs and nonblocking final fences establish
that the exhausted traversal describes one current set after all mandatory
reads, serialization and deferred constraints. The final database clock then
checks required policy deadlines and each count's independent optional horizons.

The budget is per count, not an HTTP timeout. Basic profiles can spend up to
4 seconds in their two scans; lists have one 2-second scan. With the separate
600 ms finalization allowance per count and 500 ms mandatory relationship proof,
configured phase allowances total 5.7 seconds for basics and 3.1 seconds for lists,
plus mandatory work, scheduling and recovery. Existing shared policy/row locks
remain held until commit. The separate 15-second benchmark is not the default.

An initial complete scan of at most 1,024 candidates also has a bounded final
fallback for unrelated committed epoch churn. It tries source-owner SHARE table
fences without waiting, then reconstructs the complete current small set again
in 256-row batches, within a separate 500 ms total final budget. It retains the
integer only if the current recount agrees and exhausts within the small bound.
This final-only fallback temporarily delays new source writers; active conflicting
writers make the optional count unavailable immediately. It takes no scalar
per-item locks and cannot bypass unknown review or safety facts. New horizons
from that recount are checked at the same final database clock.

Count-only uncertainty, resource cancellation or failed proof makes only its count
unavailable. Mandatory profile privacy, active target, session and bilateral-safety
checks still fail closed. Each optional attempt and final proof has a savepoint;
failed recovery, an unexpected database error or mandatory expiry fails the whole
request. Page candidate scans/cursors remain independent, so even an unavailable
large count cannot cut off reachable history.

The first proof has a deliberately conservative operating envelope: unrelated
source mutations can invalidate a large count. Larger server concurrency and
mutation-load availability require the documented acceptance measurements and
further optimization; this implementation is not a universal low-latency counting
guarantee. Optimistic large proofs require the actual postmaster-stable sum of
connection, prepared-transaction, background-worker and WAL-sender capacities
below 128; larger configurations keep ordinary writes and the independently
fenced small fallback. See the [proof audit](EXACT_DISCOVERY_COUNT_PROOFS.md)
and [exact-count operating evidence](acceptance/exact-discovery-counts.md).

`continuation` explicitly separates `more` (visible page limit reached with
remaining candidates), `scan_pending` (scan budget reached before the page filled,
possibly with no visible items), and `end` (candidate exhaustion established).
Both nonterminal states carry `nextCursor`; only end uses null. A filtered batch
is never a confirmed empty history. Clients offer a deliberate Continue action
for scan_pending rather than polling indefinitely. More does not promise that the
next candidate will be visible.

`limit` is a strict decimal string from 1 to 50, default 20. Wire cursors are
canonical base64url references containing 32 random bytes only. Additive migration
0020 stores private immutable versioned seek/guard coordinates server-side,
binding target, kind, subtype, page size, viewer and authenticated session through
a scope hash. No body, contacts, authorization grant or skipped anchor enters the
token. The prior visible item is rechecked even across hidden-only scan hops;
its deletion, changed timestamp or lost eligibility returns
`409 DISCOVERY_RESTART_REQUIRED`. A fresh first page can reach remaining history.
Private skipped anchors are position only and are never required to stay visible.
Private profile coordinates preserve PostgreSQL microseconds, so source timestamps
sharing a displayed millisecond remain separately reachable.
Malformed/cross-context references return 400; missing, expired or corrupt stored
coordinates require generic 409 restart. Refresh within the same session keeps
scope; another session or guest/auth transition does not.

Each input coordinate is immutable. Replaying it freshly scans the current source
from that position, never a saved body or advanced pointer. An unchanged output
coordinate deduplicates to the same live reference; live changes may produce a
different authorized page and successor. References expire after 24 hours without
renewal. Per-account 256 and shared-guest 1,024 reference caps evict older navigation
references, requiring a safe restart for old Previous links, without imposing any
maximum forward traversal length. Bounded cleanup deletes only expired derived
cursor records; no scheduled job is activated. Content and memberships are never
removed by cursor expiry or quota eviction.

This is live pagination, not a frozen multi-request snapshot. Newly inserted rows
before an anchor appear on refresh; deletions, moderation, privacy or blocks are
rechecked on every request. Native next/previous navigation stores cursor history
only and replaces the displayed page with freshly authorized items. It preserves
server order, rejects duplicate rows, invalidates stale generations and never
turns unavailable into empty.
Basic/count and list requests are separate live snapshots; when a list changes
to hidden/unavailable, the client also clears previously visible basic counts.

## Ownership and transaction boundaries

Profile owns public-ID mapping, display fields and preference state. Identity
owns target activity and session validity. Safety owns real profile relationship
policy and block-source decisions. Community owns authored candidates, content
status, trading metadata and exact serialization. An application-level discovery
module composes their narrow facades; it does not query domain tables or create
a ProfileModule/CommunityModule cycle. Anonymous display never calls the named
profile projection.

Reads acquire the safety policy gate, authenticate if present, lock the current
profile privacy row, check/lock the target's active account, then evaluate bilateral
coverage and community candidates. The profile share lock remains held through
count/page projection, serializing concurrent preference changes. Selected-page parent/space/review/safety facts remain canonically locked;
optional count facts use their separate owner epoch/fence proof through commit. Presented-token expiry is revalidated after long projection waits. No
cached profile base can bypass current target activity or privacy.

Discovery reads also register required named relationship facts separately from
optional count proofs. After deferred work, the safety owner takes a nonblocking
raw-block stability fence and rechecks only the consulted pair predicates. A raw
block race can therefore fail the request rather than leak basics/items with null
counts. This read-use-case opt-in does not change block/unblock mutations.
Additional audited emitting routes and intentional exclusions are listed in
[named read finalization](NAMED_READ_FINALIZATION_GAP.md).

## Own history and retained scope

Existing `GET /v1/me/community/posts` remains a minimal authenticated recovery list
including own hidden/deleted statuses and anonymous ownership. It is not fetched
through public author enumeration. Existing own trading and Saved behaviors stay
separate; public-profile hiding does not destroy any of these histories.

The self-only [liked-history contract](API_LIKED_HISTORY.md) is described separately. Public profiles do not enumerate another user's
likes. Avatar/background media, public affiliation and school-scoped UID issuance/
reviewed migration, redemption, global title administration and
received-interaction accounting, messaging/group/organization links and complete
provider/device/migration acceptance remain required separate parity work.

## Verification boundary

Disposable canonical AppModule tests cover current eligible counts/pages,
privacy/block directions, strict selectors/cursors, current target availability,
unknown/expired coverage, privacy/lifecycle lock ordering, post-wait expiry and
bounded progress, optional-count expiry and opaque-cursor retention. Native gateway roundtrips, lifecycle/controller tests and build
smokes supplement these. They are not real-device, production-provider, migration
reconciliation or public deployment acceptance.
