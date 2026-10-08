# Community content search: current development scope

## Current contract

`GET /v1/community/search` searches posts, root comments and replies through one
engine. The greenfield v1 contract now returns lightweight `SearchHit` objects;
there is no parallel PostView compatibility route. See the
[generated static OpenAPI](openapi/community-search.json).

Choose exactly one `spaceId` or `scope=all|regional|global`. Existing category,
trading subtype, urgent/resolved trading and current source-catalog semantics
remain as documented below. Added filters are:

- `type=all|post|comment|reply`, default `all`
- `from` inclusive and `to` exclusive, UTC ISO timestamps with seconds and up to
  six fractional digits; the boundary applies to the hit's own publication or
  creation time. When both are supplied, `from` must precede `to`
- `postId`, to search only one discussion within the selected scope
- `limit` 1–10, default 10, and an opaque continuation `cursor`

`q` trims outer whitespace, normalizes query CRLF to LF, accepts 1–200 Unicode
code points and rejects malformed Unicode or unsupported controls. `0`, `%`, `_`
and backslash are valid literal searches. Matching uses pinned Unicode 17.0
whole-string lowercase substring comparison. It is not Chinese segmentation,
pinyin, accent-insensitive matching, Unicode normalization, full case folding,
semantic search or relevance ranking. Only newest ordering is offered.

The response is exactly `{items, effectiveTypes, nextCursor, continuation}`.
Each hit contains its `kind`, `contentId`, `postId`, nullable `rootCommentId` and
`replyId`, actual `space` and `category`, nullable `tradingSubtype` and
`tradingUrgency`, exact six-fractional-digit `createdAt`, current public author or
thread persona, up to 80 original code points of `postSummary`, a `snippet`, and
a typed navigation `target`. Named author experience display remains the existing
public owner projection; avatars are null. There are no full post objects, media,
counts, private contacts, replied-to author details, raw scores or invented totals.

Snippets contain at most 240 original code points in plain-text
`segments[{text,matched}]`, plus `truncatedBefore` and `truncatedAfter`. Matching
runs on the whole lowercased body so contextual Greek sigma remains correct;
folded offsets map back to complete original code points so expanding İ and
astral characters are not corrupted. Source text is never normalized or rendered
as HTML. An unusually expanding query can require clipping a highlighted source
span to the same honest snippet bound. The full original body is fetched only by
the destination's current authorized read.

## Privacy, bounded navigation and final proof

Three metadata sources merge by exact timestamp descending, fixed kind order
post/comment/reply, then UUID descending. Each request examines at most 128
structural candidates plus one metadata-only sentinel. Per-source and union
queries never inspect or match body text. A denied body's text cannot change the
traversal window, successor coordinate or end decision. Sparse pages return
`scan_pending`, rather than claiming that the whole corpus has no match.

All referenced parent posts are locked in UUID order, followed by roots and
replies in UUID order, including cursor guards and the sentinel. The service
rereads structural coordinates under those locks before body use. Posts use
current `list_projection`; child hits require authenticated parent `direct_post`,
then independent root and reply `list_projection` proofs. Anonymous parents do
not exempt named descendants. Deleted or inaccessible parents/roots suppress
children. A reply's target is never loaded, searched or projected by search.
Unknown approval, scope or Safety facts fail closed as unavailable, not empty.

The same read-committed transaction retains canonical content approval locks,
mandatory relationship final proof, current session and phone deadlines, and
cursor quota ownership through commit. Failure after constructing a snippet or
creating a cursor rolls back the response and successor. Search calls only the
public author/persona projection, not full post/comment/reply serializers or
thread-wide discussion counts.

Guests using `all` receive `effectiveTypes=['post']` and a native login prompt for
child search. Explicit guest `comment` or `reply` searches require authentication
before metadata/body traversal. First previews retain current phone rules;
continuation requires a current session and verified phone evidence. Invalid
supplied credentials never become guest access.

Continuation is `more`, `scan_pending`, `end`, `login_required` or
`phone_verification_required`. Opaque private cursor versions 3 (explicit) and 4
(federated) bind query, all filters, order/matcher versions, account/session and
membership fingerprint. Their exact-time/kind/ID coordinates contain no bodies or
large retained source inventories. Changed or inaccessible last-visible ancestry
requires restart; cursors confer no authority.

## Native behavior and remaining limits

Cards distinguish post/comment/reply matches, display true source and own time,
and render highlighted source with text nodes. Posts open the existing detail
page; comments/replies open the existing discussion page with
`postId/rootCommentId/replyId`. Clicks fetch fresh context. A removed or
inaccessible target shows the destination's unavailable state, never cached
search text.

Draft and submitted query remain separate. Previous and Next fetch fresh pages;
session, account, scope, safety and lifecycle changes invalidate displayed text
and stale requests. Types, dates and one-discussion scope reset traversal.

This remains bounded literal scanning, not indexed full-text or semantic search.
A full traversal is O(corpus), rare terms may require multiple requests, and the
128 authorization budget does not bound physical index entries or SQL count.
Migration 0035 adds chronological root/reply and reply-topic structural indexes;
existing post/root-topic indexes remain. These indexes contain no body/vector.
Search no longer projects all descendants, but the detail/context owners' existing
independent 1024 limits are unchanged. No related-campus distribution, history,
hot suggestions, model/provider, background reindex, historical import or
production deployment is added. Actual-device rendering remains a separate gate.

## Historical post-only checkpoints

The prior explicit-post and federated-post increments used `PostView` and private
cursor v1/v2. Their acceptance measurements remain historical evidence, not a
claim about the new lightweight child-aware contract:
[explicit post acceptance](acceptance/community-search.md) and
[federated post acceptance](acceptance/federated-search.md).

## Federated all/regional/global search increment

The endpoint now accepts a strict union: existing `spaceId` requests, or
`scope=all|regional|global`. Never supply both. Aggregate `all` searches eligible
regional content and global discussion; `regional` accepts optional current
category/trading subtype filters; `global` searches global discussion only.
Category/subtype parameters on `all` or `global` are invalid. This keeps ordinary
regional discussion distinct from the legacy university-city/global category.
Aggregate all/regional includes urgent and resolved trading. Explicit-space
no-category search retains its previous urgent exclusion.

Membership is the complete currently eligible active-space catalog, privately
composed with the Campus owner's region activity. Missing required facts fail
unavailable; known inactive members are excluded. No public inventory, topology,
identity affiliation or representative-space authority is invented. Every card
uses its true source space. Phone continuation has its own narrow canonical proof.

Aggregate cursors bind a fixed-size hash of the full semantic member set.
Adding/removing/reactivating/remapping an eligible member restarts pagination
before scanning, independent of keyword matches. Cosmetic names and ordinary
post/like/comment changes do not change membership. The current child-aware
contract uses explicit v3 and federated v4 cursors; prior v1/v2 positions are not
reused. Member lists are not permanently retained in cursors.

The native page and an unconditional feed entry support aggregate search without
a campus selection. Optional browsing-campus lookup only populates named explicit
choices; failure cannot disable valid aggregate searches. Choosing a category from
All visibly selects regional scope. Query, cancellation, lifecycle and strict
lightweight SearchHit checks remain in place. Neither related synchronization nor
history/hot suggestions is implemented by this increment.

### Catalog writer protocol

Migration 0028 adds a common exclusive safety-policy gate to community-space
catalog statements and orders the existing operating-region gate before the count
epoch trigger. Readers take the shared gate first and retain it through commit,
covering initially absent members as well as existing rows. Multi-statement
catalog writers must acquire that exclusive gate before any earlier source-row or
count-epoch lock. Statement triggers cannot repair an inversion already created by
prior statements. TRUNCATE and DDL maintenance require outer-gate-first operational
coordination because relation locks can precede BEFORE triggers. This is not a
claim that arbitrary maintenance writers are safe.

### Historical post-only measured limits

Full catalog resolution is O(number of spaces) per request. The 128-candidate
budget does not bound physical index entries or all SQL queries. On a local
synthetic fixture with 12,000 posts, five populated spaces and 518 active catalog
members, common selectors used the new chronological index, while rare category
and subtype filters inspected substantially more rows. Endpoint work was roughly
561–737 ms and 2,084–2,217 SQL statements in the final aggregate run, substantially
more than candidate SQL alone. These are local measurements, not production
latency guarantees. See [federated acceptance](acceptance/federated-search.md).

Related-campus delivery still requires accepted immutable per-post opt-in and a
complete current topology/distribution owner. Current accepted scopes only allow
`sync=none`; reading all posts in related regions would incorrectly invent opted-in
distribution. Unsupported legacy categories and historical import remain open.
