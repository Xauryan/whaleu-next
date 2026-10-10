# Profile avatar native slice

This is an independent `profile-media-v1` client, not an extension of Community
v1–v4 wire codecs, hashes or pending journals. The normal App supplies no Profile
media gateway or native transfer. Synthetic catalog, upload and controlled byte
adapters are available only through explicit test dependency injection.

## Native state and recovery

- The original Profile page edits catalog/custom/clear selection. Clear is a new
  explicit fallback operation, not evidence of an original WhaleU control.
- All editing uses the existing SessionStore actor and epoch. Refresh within the
  same epoch is permitted. Login/logout/account change revokes visible sources,
  picker authority, upload grants, polls and temporary-file handles immediately.
- Only metadata is persisted under a new origin+actor journal namespace. It
  includes the exact prepare or selection command, request key/hash and minimal
  phase/IDs. Never store image bytes, file paths, tokens, grants or user prose.
- The original actor can recover the same unknown command after signing in again.
  Another actor neither enumerates nor reads, cancels, resumes or settles it.
  A command receipt is recovered before any current avatar read. A receipt is
  history only; displaying an avatar always requires an independent current GET.
- A CAS conflict retains the unknown command. Explicit cancellation uses a durable
  same-key/hash command fence: a prior commit returns its receipt; otherwise a
  cancelled result proves this command can no longer commit. Only those authoritative
  outcomes settle the journal. A retained custom edit is then separately cancelled.
  A fresh load and deliberate new edit are required; the client never increments
  expectedRevision or silently rebases. Local Cancel/Hide/Logout does
  not prove server cancellation, successful mutation or writer quiescence.
- An authoritative cancelled-before-prepare fence has no invented edit/intent ID.
  A late cancel of a committed edit returns historical binding state and never
  deletes the currently selected avatar.

## Read window and privacy

The Profile page, public-profile basics and the named-author controls in feed,
post detail and comment/reply thread use one application-wide avatar window.
Named row controls are explicitly user-triggered, with same-profile in-flight
coalescing. There is no per-row prefetch, 50-reader fanout or background queue.
Changing the selected viewer clears the previous source synchronously. Page
hide/unload, parent reload or policy invalidation does the same. Scrolling closes
a selected row avatar. An unavailable avatar never hides otherwise readable text.

Anonymous authors, including one's own persona, never issue Profile avatar
requests. They do not acquire catalog associations, profile IDs or bindings.
Ratings, DM/contact cards, notifications and embedded avatar DTO upgrades remain
outside this slice. Legacy public/named avatar DTO fields are unchanged; these
controls use the named profileId and the separate current endpoint.

Guests have a separate process-local principal generation, not a fake account or
SessionTicket. Login, logout and account changes invalidate guest and session
reads. Optional-session current/byte endpoints never retry a rejected token as a
guest. The nonpersonal static catalog endpoint sends no Authorization header.

Controlled downloads accept only the fixed first-party Profile appearance route,
current dimensions, JPEG/PNG, complete content length, no-store and nosniff, with
no Range/redirect response. Displayed sources are temporary registry capabilities
with a 30-second UI lease; expiry removes src and releases the local file. Viewing
again starts current authorization again. No wx.previewImage, saveFile, persistent
image index or global face_url is used. OS unlink/cache removal remains best effort.

Explicit native test composition takes the same MediaLocalFiles registry as
Community adapters: 2 native I/O slots, 4 leases/reservations/tombstones, 10 MiB total
and 5 MiB per source. A guest lease has no session identity. Pending native tasks
retain their I/O credits through complete; aborted tasks cannot multiply capacity.

## System picker boundary and incomplete acceptance

The normal custom-avatar action directly reuses the existing Community
AuthenticatedMediaUpload chooseMedia driver for local selection and inspection.
Each invocation has its own callback closure and SessionStore epoch. Native
chooseMedia is called with count=1, mediaType=['image'], sizeType=['original'];
its fail/complete callbacks let normal picker cancellation release its reservation
and permit another selection. The Profile transport independently handles its own
strict grants, upload receipt and HTTP paths; Community wire protocols are not
used to submit a Profile avatar.

A reservation is made before native picker UI allocation, but opening that UI does
not acquire one of the two network/file-transfer I/O credits. Stopping local
waiting alone does not prove the native picker ended: its reservation is retained
until complete or an actual output can be cleaned. Old callbacks are epoch-bound
and discarded, never reassigned to a new invocation/account. Ordinary native
Cancel followed by complete is recoverable without restarting the app. A broken
native bridge that never supplies complete is an abnormal unavailable condition,
not an accepted normal cancellation path.

The returned final temporary bytes are inspected and SHA-256 checked, then checked
again against the immutable grant before upload. The server remains authoritative
for full decoding, sealing and sanitization. Upload 100% is not save completion.

The dedicated open-type=chooseAvatar event UI is not enabled in this slice. Its
per-event identity/cancellation semantics, official crop behavior, base-library
compatibility and physical-device acceptance remain separate open gates. The
shared chooseMedia path does not claim to implement dedicated avatar cropping.
First-party redirect/header behavior, registered domains and physical-device/OS
cache behavior are likewise not accepted by synthetic tests.

The real 91-item asset package, its bytes/licensing and any profile-background
functionality remain incomplete. No synthetic art is represented as original
WhaleU asset parity.

## Validation status

Contract, journal, gateway, editor lifecycle, guest reader, native driver and page
wiring checks passed in the 50-test focused native run. Native typechecks and the
emitted build/smokes also passed. The combined 23-test real PG/native-process/
worker-process matrix passed on the signed comment foundation. Full frozen-tree
regression acceptance remains pending; none of these synthetic platform adapters
establishes physical-device, provider or dedicated chooseAvatar/cropping behavior.

## Own basics activation and comment merge

The own Profile page creates/loads avatar controllers only after its existing
ProfileController has completed a successful basics read for the current account
and SessionStore epoch. Loading, saving, failed or cancelled refresh, auth loss,
and hide/unload remove both current and temporary sources and dispose subscriptions.
The actor-isolated pending journal is not cleared. A completed old-actor response
cannot activate a new-actor reader; page generation also fences hidden-page work.
Saving basics or receiving an avatar receipt re-establishes the relevant basics
permission before dependent media is displayed again.

The c7 → 53cb9bc comment baseline repair was merged into detail onShow,
parent-view render/reconcile, onPageScroll, hide/unload, image/author handlers and
WXML/WXSS templates. It preserves the ordinary post single-image reader and
automatic multi-image window, and shared-registry comment/reply group switching.
The post return-button visibility condition is preserved; its label uses the image
count rather than the condition's boolean value.

Avatar admission is non-preemptive: detail/thread avatar handlers do not call
Community gallery clear or close, and do not alter the global registry. A close
would itself trigger fresh thumbnail authorization and I/O, so it is not used as
an overlay-only operation. Switching avatar targets revokes only the prior avatar.
The shared 2-I/O / 4-lease / 10 MiB budget remains authoritative; insufficient
capacity leaves the avatar unavailable with a prompt to close expanded media,
while retaining the Community view and its sources. Closing an avatar never
resurrects a saved source. Session changes still revoke both owners independently.
The non-preemptive admission regressions passed in the focused native run; final
combined-tree regression acceptance remains pending.
