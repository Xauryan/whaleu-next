# Local browsing history

Only a successfully rendered post detail with a positive native viewport
intersection is recorded. Feed exposure, speculative navigation, history summary
lookup, failed reads and synthetic demonstrations do not write history. The
existing analytics observer remains independent, with its original readiness,
retry and delivery behavior.

The device store contains at most 200 post IDs and last-view timestamps, scoped
by API origin and an opaque account/session digest. This digest is an isolation
key, not encryption. No post text, author/persona identity, media, credentials or
account identifiers are stored here. Records older than 30 days are removed on
access. The native platform storage is not claimed to be encrypted.

Account/session replacement and logout erase the store. If removal fails, an
empty overwrite is attempted; if both fail, access is blocked and manual clearing
reports failure rather than claiming deletion. A different restored login session
cannot adopt the old binding. Session token refresh preserves the current list.
Account deletion must continue invalidating its session through the existing
identity lifecycle; no independent account-deletion transport is introduced.

The private page resolves each displayed row through the existing authorized
post read. Explicit deleted/blocked/not-found targets are hidden; network/auth
failures clear the whole displayed page. Bodies exist only in the active page,
which clears on hide, account change and safety invalidation. The list is local,
not a cross-device or server history. Opening a row performs an ordinary fresh
detail read, and a later visible detail visit updates its last-view time.

Tests: browsing-history.test.ts and view-observer.test.ts. Native physical-device
viewport/storage and visual acceptance remain separate from these simulations.
