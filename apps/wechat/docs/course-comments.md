# Native course text comments

This is a new Next surface, separate from the immutable three-axis C1 score.
A fresh course detail links to a dedicated comments page. The course catalog
also links to receipt recovery without requiring a currently visible course.

- Public comments contain exactly `id`, `body`, `likes`, and `createdAt`.
  There are no author, avatar, anonymous persona, viewer, own-comment, or
  own-like fields. The native list does not infer relationships or expose
  self-like restrictions. Likes are one-way and once per account/comment.
- Likes/time sorting uses server deterministic cursors and bounded replacement
  pages. Catalog, course and comment revisions cannot be mixed. Unknown source,
  comment population, or legacy-like history is never an empty or zero state.
- Text is previewed and separately confirmed, then persisted exactly, including
  leading/trailing whitespace, CRLF and Unicode. New Next publication requires
  nonblank text of at most 8000 UTF-8 bytes and 8000 JavaScript code units.
  Multiple separately confirmed, distinct comments are allowed.
- The account/API-origin journal stores the original operation, course/comment,
  request UUID, revisions and exact body before dispatch and verifies readback.
  Response loss, restart, Back, hide, root App hide, session/epoch change, sort
  changes and unavailable reads cannot replace the request. Every retry first
  queries the original receipt and resends only after a typed 404 absence.
- Cancellation first establishes receipt absence and asks for a separate user
  confirmation. The server serializes the cancellation tombstone with the
  original command. Only a matching original or durable cancellation receipt
  releases the journal. Stopping a wait is never server cancellation.
- Receipt resolution is independent from current source/phone/Safety authority.
  Receipt metadata does not restore visibility; current comments are always
  fetched independently. Review-unavailable, auth, source, history, or transport
  failures remain recoverable. Serialized terminal rejection releases only the
  exact matching operation, account and resource.

Focused tests cover strict projection/receipt validation, byte boundaries,
original-payload persistence, duplicate clicks, receipt-first recovery,
serialized cancellation, account/epoch/origin isolation, late callbacks,
missing/unavailable distinctions, cursor revisions and repository WXML.
The API integration journey uses emitted App/Page handlers and real gateways
with loopback AppModule/PostgreSQL. Only native platform callbacks/networking
and explicitly labeled accepted test fixtures are simulated. DevTools/device,
live review providers, production source acceptance and full legacy parity
remain unverified.
