# Own community liked history

This bounded-per-request development slice covers community posts, root comments and replies.
It does not claim other-domain liked history, production migration, provider
acceptance or device acceptance.

## Read contract

`GET /v1/me/community/liked?limit=20&cursor=...` requires a valid active session.
There is no phone, student-affiliation, identity-campus or publication-permission
gate. Missing/invalid/expired/revoked authentication never falls back to another
owner. Ownership comes only from the session. Query/body account IDs, profile IDs,
legacy IDs, extra keys and subtype/kind filters are rejected. Limit is an exact
base-10 string from `1` through `50`, default `20`; coercible alternative formats
such as `01`, `1e1`, arrays or whitespace are rejected.

All results are `Cache-Control: no-store`, `Vary: Authorization`.

```ts
interface LikedPage {
  items: {
    kind: 'post' | 'comment' | 'reply';
    targetId: string;
    postId: string;
    rootCommentId: string | null;
    likedAt: string | null; // canonical ISO milliseconds, or unknown historical date
    likeId: string; // opaque identity of the current membership record
    preview: {
      text: string;
      images: MediaView[];
      author: AuthorView;
      createdAt: string; // the exact content target's creation time
      isSelf: boolean;
    };
  }[];
  visibleLikedCount: number | null;
  visibleLikedCountStatus: 'known' | 'unavailable';
  continuation: 'more' | 'scan_pending' | 'end';
  nextCursor: string | null;
}
```

For posts, `targetId=postId` and `rootCommentId=null`. For root comments,
`rootCommentId=targetId`. Replies carry their actual root ID. `AuthorView` and
`MediaView` are the existing canonical community views, not raw database rows.
The exact liked target determines author mode independently of the post, root,
or another reply it addresses. Anonymous previews have no named public-profile
link. Ownership is only the server-calculated `isSelf` boolean. No private account
IDs, identity/provider facts, approval provenance or trading contacts appear.

## Current visibility and counts

The parent post, root (if any) and exact reply (if any) must each remain eligible
under canonical current community visibility. Every named node uses bilateral
`direct_post` block policy. This deliberately differs from outgoing-only ordinary
feed projection. An anonymous node does not resolve its underlying account to
check named block relationships. A named parent/root can still deny a descendant.

Hidden/deleted content, inactive scopes and authoritative review denial suppress
the target and its contribution to the count. Missing/unknown/expired review or named-block coverage for required page facts
returns `COMMUNITY_UNAVAILABLE` (503), never a success with a fabricated zero
total. Uncertainty confined to the optional complete count makes only that count
unavailable. Required deadlines are rechecked at commit.
An empty history needs only the active session; it has no named subject whose
relationship coverage must be consulted. Existing canonical content read policy
is preserved; this endpoint introduces no new account-lifecycle inference for
anonymous authors.

Each request scans at most 128 current membership positions, with one lookahead
candidate. There is no whole-history size failure, source-history age cutoff or
maximum reachable page. The current required content/ancestor/review policy still
fails closed; an unavailable dependency is never silently skipped. Policy for an
unscanned older target does not block an already authorized earlier page.

`visibleLikedCount` uses the same separately proven streaming count machinery as
[public discovery](API_PUBLIC_PROFILES.md). Every current post/comment/reply
membership contributes independently, including undated records, and its actual
parent/root/exact-reply chain must pass canonical direct visibility. Counts use
256-membership owner batches, with at most 768 reconstructed nodes per batch,
not a scalar reader loop or a whole-history retained set. Repeated ancestors and
named relationships are deduplicated only within a batch. Current membership
identity and nullable date are checked without inventing historical timestamps.

The count can be exact/known even when the requested page stops at its visible
limit, when a page contains only hidden candidates, or on a continuation page.
Count-only uncertainty outside the required page, budget exhaustion or a failed
final mutation proof produces null/unavailable without erasing the independently
authorized page. The mandatory session and selected page policy still fail
closed. Count values never determine next/previous/end navigation.

`continuation:'more'` means a visible page limit was filled with candidates left;
`scan_pending` means the bounded scan ended before filling the page and may return
no visible items. Both carry a next cursor. Only proven candidate exhaustion yields
`end` with null cursor. A hidden-only batch is not an empty-history conclusion.
Canonical preview dependency failure fails the request without a partial result.

## Ordering, continuation and concurrent changes

Dated memberships come first, ordered by `(likedAt DESC, likeId DESC)`. All
undated memberships follow, ordered by `likeId DESC`. Kind is a final stable tie
breaker across the three independent storage tables. Undated records are retained
and pageable, including across the dated/undated boundary.

A canonical base64url cursor contains only 32 random bytes. Migration 0020's
private immutable record binds owner, session, list kind and exact limit through
a scope hash, with the current private seek and prior visible guard stored only
server-side. No private account/session values, skipped targets or payloads are
embedded in the token. Current authentication and policy are rechecked on every
request. Malformed or cross-owner/session/kind/limit references return 400;
missing, expired or corrupt records require generic 409 restart. A removed,
re-liked, hidden or otherwise ineligible prior visible guard also returns
`DISCOVERY_RESTART_REQUIRED`, including after empty scan hops. Refresh can reach
remaining history. A skipped private seek need not remain eligible.

The immutable input position is replayed with fresh reads; no old page body or
mutable advanced pointer can reopen access or skip an undisclosed range after a
lost response. Identical current output coordinates reuse a live opaque reference.
Each reference expires after 24 hours without renewal; the per-account 256-record
cap evicts older navigation references while permitting unlimited forward steps.
Expired/evicted Previous links restart safely. Bounded cleanup removes only derived
coordinates, never likes or content. No cleanup job is activated.

This is live keyset pagination, not a cross-request database snapshot. Current
newer likes may precede an existing cursor; refresh to see those entries. Current
unlikes disappear and count changes are expected. The native client replaces each
page and retains only navigation cursors, without accumulating previous page bodies.
Lifecycle and safety changes invalidate viewer-bound history and navigation. Refreshing an access token within the same session preserves the
scope; another session for the same account does not.

Candidates are discovered without membership row locks. Each of the three
membership tables uses separately limited indexed dated/undated keyset branches,
then a bounded merge, so later pages do not rescan the full dated prefix. The
transaction acquires all distinct parent-post locks in sorted order, then roots,
then exact replies, including the carried visible guard. A second bounded scan
from the same seek rejects newly introduced targets not in the locked set. Exact
current memberships are re-read afterward; a committed unlike/re-like cannot
return an old membership ID. A later insertion before the seek is visible on
refresh; changes after the locked/read authorization point are outside the live
projection snapshot. Session/policy/cursor expiry is checked after all deferred
waits before commit.

## Forward migration 0019

The existing three like tables had neither event timestamps nor IDs. The additive
migration assigns each existing membership an opaque `like_id` storage identity,
while leaving `liked_at` null. These generated IDs make no claim about historical
event order or time. Timestamp defaults are installed only after the undated
columns exist, so applying the migration does not fabricate historical dates.

New memberships receive a fresh opaque ID and a millisecond UTC timestamp.
Duplicate desired-like writes preserve the current record, including an old
undated record. Unlike deletes it; a later re-like creates a new ID and known
time. Existing composite primary keys prevent duplicate owner/target membership;
per-table UUID uniqueness, finite/millisecond time constraints, nonnull time on
new insertion and immutable membership metadata guard the storage contract.

This migration is not a production import or historical reconciliation. A future
reviewed import of external dates needs separate provenance/timezone handling and
a separately authorized migration path. Never overwrite null history with guessed
content creation times, migration time, client time or a fabricated event time.

## Verification scope

- `apps/api/test/liked-history.test.ts`: strict limits/body shape, cursor attacks,
  opaque identity binding, known/null ordering and ties
- `apps/api/test/integration/liked-history.test.ts`: ordinary AppModule and real
  disposable PostgreSQL, actual pre-0019 memberships through the forward migration,
  canonical review/identity/safety records, mixed author modes, full named block
  chain, counts/pages, current membership races, deadlines, bounded progress and constraints
- `apps/api/test/integration/public-profile-native-roundtrip.test.ts`: the native
  discovery gateway in the broader public-profile roundtrip acceptance suite

Run the final repository aggregate checks and all disposable PostgreSQL integration
suites after concurrent work is integrated. Unit tests alone do not establish
provider/device or production-migration readiness.
