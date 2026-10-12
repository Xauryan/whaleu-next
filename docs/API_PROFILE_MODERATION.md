# Scoped nickname moderation

This development slice resets an account's public nickname from an exact named
Community post, root comment or reply. It does not implement avatar moderation or
complete legacy profile-moderation parity.

## Scope and authority

The target itself must be named and currently readable through the ordinary
Community owners. A child's post or root may be anonymous. Full live ancestry,
current original Review and Media, Safety relationships, owner-hide state,
current category and descendant continuation remain mandatory. Self targets and
administrator targets are permitted, matching the pinned legacy handler.

Only native publication in an active regional space whose original publication
scope has the same original region and `sync: none` is supported. Current
`school_admin` for that original region or global `super_admin` qualifies;
`developer` alone, selected browse campus and subject affiliation do not. There
is no account/profile-ID lookup or reset endpoint and no new grant/source issuer.
Trading, poll and formation targets retain their existing exact definition gates;
they do not inherit category-reclassification's text-only/category exclusions.

A reset changes the account-level nickname, so fresh dynamic named displays in
other regions also show the new name. This does not grant management authority in
those regions. Existing anonymous personas and public profile ID are unchanged.
Historical snapshots keep their existing owner contract. Ordinary reads that
observed an earlier name keep their pre-existing consistency semantics. Only the
new exact management projection adds a mandatory current Profile proof.

## HTTP contract

All routes are under `/v1/community/profile-moderation`, authenticated and no-store.
Strict schemas reject unknown fields, repeated query values and non-UUID targets.

- `GET /management?kind=post|comment|reply&id=<uuid>` returns exactly `target`,
  `displayName`, shared Profile `revision`, and `canReset: true`, after all gates.
- `POST /commands` accepts `clientRequestId` (UUIDv4), `target: {kind,id}`,
  `expectedProfileRevision` (0..2147483646), and `action: reset_nickname`.
- `GET /requests/:requestId` returns only `recorded` with the original receipt,
  or `not_recorded`. The latter is not permission to allocate a replacement key.
- `POST /commands/cancel` takes that same original frozen command. Cancellation
  can establish a terminal record even when the target does not exist.

An applied receipt contains original intent metadata, revision exactly +1,
`eventId` and `recordedAt`. Rejections are `PROFILE_MODERATION_STALE` or
`PROFILE_MODERATION_CANCELLED`. No subject account/profile ID, old nickname, new
nickname, avatar, phone or verification identity is included in receipts.

Replay compares the exact actor-bound canonical request hash. Original-actor
replay, recovery and cancellation require only current account/session/presented
token; they never re-read target content, grant, phone, Safety or Review. A new
stale command still requires current exact authority and target eligibility.

## Atomicity and current facts

The owner composes the narrow Community target facade with Profile's original
shared CAS in an application module, without a Profile/Community import cycle.
Lock order is presented identity, actor/request advisory fence, existing Safety
and owner epochs, post/root/reply, selected grant, Profile avatar-actor advisory
fence and Profile row, then private system-notice owner. Existing bounded
read-committed proof budgets and epoch admission are preserved.

Only the nickname changes. The output is server-generated `违规昵称` plus six
random ASCII letters/digits and is persisted once. Nickname, bio, preferences,
campus and avatar edits all contend on the same Profile revision. Before inserting
an applied command the Profile must already exist; missing targets cannot use the
repository's normal self-profile creation path.

Migration 0128 adds immutable commands, events and actual Profile transition
causes. An AFTER UPDATE trigger records the real OLD/NEW hashes, with only
nickname/revision/updated_at allowed to change. Deferred constraints require one
exact transition, event, request receipt and unread owner notice in the same
transaction. Nullable command metadata deliberately has no grant/subject foreign
keys: PostgreSQL would open those tables even for NULL during first cancellation.
Positive command guards prove both exact rows, and applied event/transition foreign
keys retain them. Repeated or zero-row writes, absent causes, wrong subject/revision,
late/ABA input changes and changes to other Profile or avatar state fail closed.
Original facts are retained, not replaced with a later snapshot. Management and
fresh commands observe phone/content inputs before target resolution, and retain
the selected grant fingerprint from the same definitive authority SELECT. Both
observations are enrolled unchanged after canonical source locks. The final proof
compares both and rechecks current eligibility in separate bounded statements. Final NOWAIT
owner fences and exact deadlines reject revoked/expired/queued authority. Raw
post-constraint DML re-enqueues the same closure check through existing epochs.

The new command has no publication Review purpose: it does not change original
content bytes. Existing accepted Review proves the target, while the independent
moderation event records the administrator's decision to generate fixed text.

## Private notifications and native lifecycle

A separate `profile_nickname_reset` notice contains only `noticeId`, `kind`,
`createdAt`, `readAt`, and the fixed resulting `nickname`. It does not depend on the
source remaining readable, and it cannot impersonate a jury decision. Existing
system-notice pages aggregate both kinds under the original owner lock, rate and
unread semantics. A globally unique immutable ID registry enforces cross-table
UUID identity, including deliberate collisions. V2 cursors include kind; existing
owner-bound V1 jury cursors remain valid. Mark-read resolves the unique owned kind
before updating the corresponding table and keeps the first timestamp.

Named detail/thread entries open a dedicated management page. Confirmation states
that the account-wide public nickname, including other regions, is reset and the
owner is notified, while anonymous personas stay unchanged. The native controller
persists and reads back the frozen command before dispatch, isolates journal state
by account and API origin, recovers on cold start, keeps unknown outcomes, and
uses only original-key retry/cancel. Close/back, double taps, login replacement,
origin replacement and late callbacks cannot manufacture a new command or undo an
unknown outcome. Completion refreshes ordinary readers; it never patches caches
using a private subject ID. Existing own Profile revision-conflict handling keeps
unsaved drafts and requires explicit refresh rather than blind overwrite.

## Remaining boundaries

Legacy also supported explicitly related/synchronized regions and university-city
scope. Those are not implemented here. The old `status_code` native relogin check
is not server-side token revocation and is not added by this slice. Avatar reset,
the real default-avatar catalog/licensing, production accepted identity/source
facts, historical imports/crosswalks, provider delivery and physical-device
acceptance remain independent work. Synthetic/local checks do not claim any of
those acceptances. Final verification results are recorded against the frozen
implementation separately; a passing unit subset is not end-to-end acceptance.
