# Explicit-space community search: development scope

This partial increment has passed local automated acceptance. It is not full
search parity or a production release. See [acceptance evidence](acceptance/community-search.md).

## Intended contract

`GET /v1/community/search` searches post text within one explicit active community
space. Inputs are `spaceId`, `q`, optional `category` and `tradingSubtype`,
`limit` (1–10, default 10), and an opaque continuation `cursor`. Trading subtype
requires the trading category. Global spaces support omitted category or
`discussion` in this first slice.

The query normalizes CRLF to LF and trims outer whitespace, accepts 1–200 Unicode
code points, and rejects malformed Unicode and unsupported controls. `0` is a
valid query. Matching is literal substring comparison after server-side,
locale-independent Unicode lowercase conversion. `%`, `_` and backslash are
literal characters. This is not accent-insensitive, pinyin, linguistic full-text,
Unicode normalization or full case-fold matching. Stored and returned post text
is unchanged. The server's Unicode-data version is part of cursor scope.

The response is exactly `{items, nextCursor, continuation}`. Items use the existing
`PostView` contract; no search total, match count, snippet or relevance score is
invented. Continuation is `more`, `scan_pending`, `end`, `login_required` or
`phone_verification_required`.

## Privacy and navigation

Candidate traversal is independent of the search phrase. A request examines a
bounded structural window in descending exact timestamp/ID order, checks current
list visibility before matching text, and serializes only allowed matching posts.
Hidden text must not influence continuation coordinates or end detection.
Opaque cursors contain no client-readable post bodies and grant no authority;
replays recheck current session and visibility. Nested named content still passes
the existing mandatory final privacy proof.

Guests and phone-unverified accounts receive an initial preview. Continuation
requires the existing phone/session authority; an invalid supplied token is an
error, not a guest fallback. Missing policy evidence remains unavailable, not an
empty result. The initial preview may be sparse even when matching visible posts
exist later in the corpus.

The native page keeps draft input separate from the submitted search. Next and
Previous fetch fresh pages rather than redisplaying cached content. Scope,
account, session, safety and lifecycle changes invalidate stale results. Empty
`scan_pending` pages offer explicit further search; they do not claim that no
matches exist. This slice has no persistent query history, hot suggestions or
background scan loop.

## Remaining parity and scale work

A bounded scan per request is still O(corpus) over a complete search. Rare terms
can require many requests. This does not establish indexed search performance or
production-scale throughput. Existing selected-post serializer/count limits
remain in effect.

Legacy cross-school aggregation, related-campus synchronization, other historical
categories, local search history and hot suggestions remain required future work.
Current `PostView` requires a publication date and bounded text. Historical import
must resolve unsupported records honestly; this feature does not invent dates,
truncate originals or claim the historical population is enrolled.

View-report expiry and author received-total deletion policy are separate pending
product decisions and are not changed by search.

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

Aggregate v2 cursors bind a fixed-size hash of the full semantic member set.
Adding/removing/reactivating/remapping an eligible member restarts pagination
before scanning, independent of keyword matches. Cosmetic names and ordinary
post/like/comment changes do not change membership. Existing explicit v1 cursors
retain their contract. Member lists are not permanently retained in cursors.

The native page and an unconditional feed entry support aggregate search without
a campus selection. Optional browsing-campus lookup only populates named explicit
choices; failure cannot disable valid aggregate searches. Choosing a category from
All visibly selects regional scope. Query, cancellation, lifecycle and strict
PostView checks remain in place. Neither related synchronization nor history/hot
suggestions is implemented by this increment.

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

### Measured limits

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
