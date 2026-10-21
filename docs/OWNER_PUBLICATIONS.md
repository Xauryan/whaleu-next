# Private owner publication history

`GET /v1/me/community/publications` requires a current bearer session. Query
parameters `kind=topic|reply` and `identity=named|anonymous` are required;
`limit` is an optional canonical decimal from 1 through 50 (default 20), and
`cursor` is an opaque continuation token. Topic selects the caller's posts.
Reply selects the caller's root comments and nested replies in one bounded
newest-first keyset stream.

The response contains `items`, `continuation` (`more`, `scan_pending`, `end`) and
`nextCursor`. Each item has its actual kind (`post`, `comment`, `reply`), target
ID, post ID, root-comment ID when applicable, creation time, and the canonical
text/media/author preview with `isSelf: true`. These are publications, not likes.
There are no derived lifetime totals, like IDs, account IDs or public anonymous
ownership links. API enums remain stable; native presentation calls anonymous
identity 分身.

The session supplies the owner. Caller-supplied owner identifiers are rejected.
Cursors bind account, session, kind, identity, page size and current category
scope. The query locks parents before roots and exact replies; ownership and
mode are read again after those locks. Current school, distribution, category,
content review, visibility, account and block checks are the same as canonical
content projection. A reply whose parent/root is inaccessible is omitted.
A stale visible continuation anchor requires restarting the list. Logout and
scope/filter changes must revoke native cached pages. Responses are no-store.

Migration 0164 withdraws legacy unsupported gender values to null and private
without inferring a replacement. Migration 0165 adds bounded author/mode seek
indexes for each publication table. The gender decoder also safely redacts old
values during rolling deployment. Saturated legacy detail revisions remain
uneditable under existing CAS bounds; sanitization still withdraws the field.

Focused service/query/cursor/route tests run locally. The disposable PostgreSQL
suite `apps/api/test/integration/owner-publications.test.ts` exercises authenticated
identity partitions, root/nested replies, cursor scope, incoming blocks and
parent deletion. PostgreSQL is unavailable in this workspace, so that suite,
real locking races and migrations remain unexecuted here.
