# Own community liked history

This bounded development slice covers community posts, root comments and replies.
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
  visibleLikedCount: number;
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
the target and its contribution to the count. Missing/unknown/expired required
review or named-block coverage returns `COMMUNITY_UNAVAILABLE` (503), never a
success with a fabricated zero total. Required deadlines are rechecked at commit.
An empty history needs only the active session; it has no named subject whose
relationship coverage must be consulted. Existing canonical content read policy
is preserved; this endpoint introduces no new account-lifecycle inference for
anonymous authors.

One bounded current policy-filtered set supplies both `visibleLikedCount` and
page items. This checkpoint imposes a whole-history ceiling of 1,024 candidate memberships.
At 1,025 memberships every page and count request fails with
`COMMUNITY_UNAVAILABLE`, even if most memberships would later be filtered. A small
requested page size does not bypass the ceiling. There is no history age cutoff.
Scalable arbitrary-size history and current-policy counts remain an explicit
release/parity gate. This bounded implementation does not claim that older or
excess records do not exist. No unfiltered counters or removed-target
body-bearing tombstones are returned. Canonical preview dependency failure also
fails the request without a partial result.

## Ordering, continuation and concurrent changes

Dated memberships come first, ordered by `(likedAt DESC, likeId DESC)`. All
undated memberships follow, ordered by `likeId DESC`. Kind is a final stable tie
breaker across the three independent storage tables. Undated records are retained
and pageable, including across the dated/undated boundary.

The strict opaque cursor binds the owner, session, list kind and exact limit.
Its anchor contains only the last returned visible current membership's kind,
record ID and nullable date. Raw account/session IDs, private author IDs and
invisible candidate references are never embedded. Cursors are continuation
coordinates, not authorization grants: current authentication and policy are
rechecked on every request. Malformed/cross-owner/cross-session/cross-kind or
cross-limit cursors return 400. A removed, re-liked, hidden or otherwise ineligible
current anchor returns `DISCOVERY_RESTART_REQUIRED` (409); reload the first page.

This is live keyset pagination, not a cross-request database snapshot. Current
newer likes may precede an existing cursor; refresh to see those entries. Current
unlikes disappear and count changes are expected. The native client replaces each
page and retains only navigation cursors, without accumulating previous page bodies.
Lifecycle and safety changes invalidate viewer-bound history and navigation. Refreshing an access token within the same session preserves the
scope; another session for the same account does not.

Candidates are discovered without membership row locks. The transaction acquires
all distinct parent-post locks in sorted order, then root locks, then exact-reply
locks, before re-reading current membership records. Normal like/unlike writers
hold the parent exclusively, so a committed unlike/re-like cannot return its old
record ID. A second bounded candidate read detects newly added targets while the
locks were being acquired; such an unstable set fails with 503 rather than
silently undercounting. A later change after the locked/read authorization point
is outside the returned projection's point-in-time guarantee. Session/policy
locks and expiry checks remain active until commit.

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
  chain, counts/pages, current membership races, deadlines, overflow and constraints
- `apps/api/test/integration/public-profile-native-roundtrip.test.ts`: the native
  discovery gateway in the broader public-profile roundtrip acceptance suite

Run the final repository aggregate checks and all disposable PostgreSQL integration
suites after concurrent work is integrated. Unit tests alone do not establish
provider/device or production-migration readiness.
