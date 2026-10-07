# Public profiles and own discovery

This development increment adds named author pages and privacy-consistent public
post/trading discovery. It is part of the greenfield rewrite, not a provider
activation, production import or claim of complete profile/experience parity.
Public identifiers, current policy and canonical community serializers replace
unsafe raw account/content projections.

## Routes and exact public states

- `GET /v1/profiles/:profileId`: optional authentication; current basics and counts
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
  "title": null,
  "level": null,
  "totalInteractions": null,
  "displayAvailability": "unavailable",
  "postsHidden": false,
  "postCount": 0,
  "tradeCount": 0
}
```

The example identifier is synthetic. `displayAvailability` describes the optional
avatar/affiliation/public UID/title/level/received-interaction fields only. These
fields remain explicitly unavailable until their suitable owners provide a
reviewed public projection. A selected browsing campus, student number or default
level cannot supply them. Legacy public UID is school-scoped, distinct from both
private student identity and the globally routed public profile UUID.
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
`{status:'available',profileId,items:PostView[],total,nextCursor}`. Its items are
ordinary canonical post projections, including safe poll/formation/trade metadata.
Chosen trading contacts, contact fallbacks and privileged identity overlays are
absent. A privacy-hidden list is exactly
`{status:'hidden',profileId,items:[],total:0,nextCursor:null}`. Empty available and
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

The community owner computes a complete current eligible set, then obtains both
count and page from that same set. It enumerates at most 1,025 named candidates
per list kind, locks/rechecks at most 1,024 in deterministic post-ID order, and
fails `503 COMMUNITY_UNAVAILABLE` on overflow. Basic counts evaluate each kind
with the same bound. There is no age cutoff, unfiltered total or false end when
coverage is unknown. This is a whole-history development capacity limit: above
the bound all available pages/counts for that kind fail, not just one slow page.
Scalable public/liked history and current-policy counts are an explicit open
release/parity gate; this checkpoint does not preserve arbitrary-size discovery
yet. Existing own minimal recovery remains separately pageable. Only selected
page items are serialized; nested canonical
serializers retain their independent bounded checks.

`limit` is a strict decimal query string from 1 to 50, default 20. Order is
published time descending, then public content UUID descending. The strict
canonical-base64url cursor binds kind, target profile, subtype, page size, viewer
and authenticated session through an opaque hash. It includes only the last
visible post's ID and time, never a private account/session value or skipped-row
anchor. The current eligible set must still contain the exact anchor and time;
a deleted/hidden/ineligible anchor returns `409 DISCOVERY_RESTART_REQUIRED`.
Clients clear and restart rather than preserve a stale page. Cross-profile, kind,
subtype, size, viewer/session or malformed cursors reject with `400 BAD_REQUEST`.

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
count/page projection, serializing concurrent preference changes. Parent/space/
review/safety facts and transaction deadlines remain locked/rechecked through
commit. Presented-token expiry is revalidated after long projection waits. No
cached profile base can bypass current target activity or privacy.

## Own history and retained scope

Existing `GET /v1/me/community/posts` remains a minimal authenticated recovery list
including own hidden/deleted statuses and anonymous ownership. It is not fetched
through public author enumeration. Existing own trading and Saved behaviors stay
separate; public-profile hiding does not destroy any of these histories.

The self-only [liked-history contract](API_LIKED_HISTORY.md) is described separately. Public profiles do not enumerate another user's
likes. Avatar/background media, public affiliation and school-scoped UID issuance/
reviewed migration, selected owned titles/colors, experience/unlocks/redemption,
received-interaction accounting, messaging/group/organization links and complete
provider/device/migration acceptance remain required separate parity work.

## Verification boundary

Disposable canonical AppModule tests cover current eligible counts/pages,
privacy/block directions, strict selectors/cursors, current target availability,
unknown/expired coverage, privacy/lifecycle lock ordering, post-wait expiry and
honest overflow. Native gateway roundtrips, lifecycle/controller tests and build
smokes supplement these. They are not real-device, production-provider, migration
reconciliation or public deployment acceptance.
