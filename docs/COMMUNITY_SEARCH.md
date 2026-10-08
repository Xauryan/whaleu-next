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
